import { HttpError } from "../http/errors";
import type { ReadingsQuery } from "../api/query";
import { groupExpr, READING_TIME_SQL } from "./time";

const MAX_ROWS = 8000;

interface RawRow {
  sample_id: string;
  probe_id: string;
  sampled_at: string | null;
  received_at: string;
  source: string;
  temperature_c: number | null;
  raw_temperature_c: number | null;
  status: string;
}

interface AggRow {
  bucket: string;
  probe_id: string;
  avg_c: number | null;
  min_c: number | null;
  max_c: number | null;
  count: number;
}

export interface GrainBucket {
  avgC: number | null;
  maxC: number | null;
}

export interface RawPoint {
  bucket: string;
  sampledAt: string | null;
  sampleId: string;
  source: string;
  probes: Record<string, { temperatureC: number | null; rawTemperatureC: number | null; status: string }>;
  grain: GrainBucket;
}

export interface AggPoint {
  bucket: string;
  probes: Record<string, { avgC: number | null; minC: number | null; maxC: number | null; count: number }>;
  grain: GrainBucket;
}

function isGrain(probeId: string): boolean {
  return probeId.startsWith("grain-");
}

function grainFromValues(values: Array<number | null | undefined>): GrainBucket {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return { avgC: null, maxC: null };
  const sum = nums.reduce((acc, value) => acc + value, 0);
  return { avgC: sum / nums.length, maxC: Math.max(...nums) };
}

function filters(query: ReadingsQuery): { sql: string; binds: unknown[] } {
  const binds: unknown[] = [query.start, query.end];
  let sql = ` WHERE ${READING_TIME_SQL} >= datetime(?) AND ${READING_TIME_SQL} <= datetime(?)`;
  if (!query.includeManual) {
    sql += " AND source = 'scheduled'";
  }
  const placeholders = query.probes.map(() => "?").join(", ");
  sql += ` AND probe_id IN (${placeholders})`;
  binds.push(...query.probes);
  return { sql, binds };
}

export async function loadReadings(
  db: D1Database,
  query: ReadingsQuery,
): Promise<{ points: RawPoint[] | AggPoint[] }> {
  const { sql, binds } = filters(query);

  if (query.group === "raw") {
    const result = await db
      .prepare(
        `SELECT sample_id, probe_id, sampled_at, received_at, source,
                temperature_c, raw_temperature_c, status
         FROM readings
         ${sql}
         ORDER BY ${READING_TIME_SQL} ASC, sample_id, probe_id
         LIMIT ${MAX_ROWS + 1}`,
      )
      .bind(...binds)
      .all<RawRow>();

    if (result.results.length > MAX_ROWS) {
      throw new HttpError(400, "range_too_large", "Too many raw points; narrow the time range");
    }

    const bySample = new Map<string, RawPoint>();
    for (const row of result.results) {
      let point = bySample.get(row.sample_id);
      if (!point) {
        point = {
          bucket: row.sampled_at ?? row.received_at,
          sampledAt: row.sampled_at,
          sampleId: row.sample_id,
          source: row.source,
          probes: {},
          grain: { avgC: null, maxC: null },
        };
        bySample.set(row.sample_id, point);
      }
      point.probes[row.probe_id] = {
        temperatureC: row.temperature_c,
        rawTemperatureC: row.raw_temperature_c,
        status: row.status,
      };
    }

    const points = [...bySample.values()];
    for (const point of points) {
      point.grain = grainFromValues(
        Object.entries(point.probes)
          .filter(([id, reading]) => isGrain(id) && reading.status === "ok")
          .map(([, reading]) => reading.temperatureC),
      );
    }
    return { points };
  }

  const bucketSql = groupExpr(query.group);
  const result = await db
    .prepare(
      `SELECT ${bucketSql} AS bucket, probe_id,
              AVG(temperature_c) AS avg_c,
              MIN(temperature_c) AS min_c,
              MAX(temperature_c) AS max_c,
              COUNT(*) AS count
       FROM readings
       ${sql}
         AND status = 'ok'
         AND temperature_c IS NOT NULL
       GROUP BY bucket, probe_id
       ORDER BY bucket, probe_id
       LIMIT ${MAX_ROWS + 1}`,
    )
    .bind(...binds)
    .all<AggRow>();

  if (result.results.length > MAX_ROWS) {
    throw new HttpError(400, "range_too_large", "Too many points; narrow the time range");
  }

  const byBucket = new Map<string, AggPoint>();
  for (const row of result.results) {
    let point = byBucket.get(row.bucket);
    if (!point) {
      point = { bucket: row.bucket, probes: {}, grain: { avgC: null, maxC: null } };
      byBucket.set(row.bucket, point);
    }
    point.probes[row.probe_id] = {
      avgC: row.avg_c,
      minC: row.min_c,
      maxC: row.max_c,
      count: row.count,
    };
  }

  const points = [...byBucket.values()];
  for (const point of points) {
    point.grain = grainFromValues(
      Object.entries(point.probes)
        .filter(([id]) => isGrain(id))
        .map(([, reading]) => reading.avgC),
    );
    const grainMaxes = Object.entries(point.probes)
      .filter(([id]) => isGrain(id))
      .map(([, reading]) => reading.maxC)
      .filter((value): value is number => typeof value === "number");
    if (grainMaxes.length > 0) point.grain.maxC = Math.max(...grainMaxes);
  }

  return { points };
}
