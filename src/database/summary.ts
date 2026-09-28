import { loadPublicLayout, type ProbeLayoutItem } from "./layout";
import { READING_TIME_SQL } from "./time";

export const STALE_AFTER_MINUTES = 120;

export interface ProbeLatest {
  temperatureC: number | null;
  rawTemperatureC: number | null;
  status: string;
  sampledAt: string | null;
  receivedAt: string;
  sampleId: string;
  source: string;
  timeQuality: string;
}

export interface SummaryProbe {
  probeId: string;
  label: string;
  kind: "grain" | "air";
  row?: number;
  col?: number;
  latest: ProbeLatest | null;
  min24hC: number | null;
  max24hC: number | null;
}

export interface SummaryResult {
  timezone: string;
  stale: boolean;
  staleAfterMinutes: number;
  lastSampleAt: string | null;
  lastScheduledAt: string | null;
  layout: { probes: ProbeLayoutItem[] };
  probes: SummaryProbe[];
  air: SummaryProbe | null;
}

interface LatestRow {
  probe_id: string;
  temperature_c: number | null;
  raw_temperature_c: number | null;
  status: string;
  sampled_at: string | null;
  received_at: string;
  sample_id: string;
  source: string;
  time_quality: string;
}

interface RangeRow {
  probe_id: string;
  min_c: number | null;
  max_c: number | null;
}

export async function loadSummary(db: D1Database): Promise<SummaryResult> {
  const layout = await loadPublicLayout(db);

  // Latest reading per probe from any source, so a manual button press shows up straight away.
  // One LIMIT 1 lookup per probe walks idx_readings_probe_time and reads a single row; a
  // window function over the whole table would read every reading on each request.
  const latestStatement = db.prepare(
    `SELECT probe_id, temperature_c, raw_temperature_c, status, sampled_at,
            received_at, sample_id, source, time_quality
     FROM readings
     WHERE probe_id = ?
     ORDER BY ${READING_TIME_SQL} DESC, received_at DESC
     LIMIT 1`,
  );
  const latestResults = layout.probes.length
    ? await db.batch<LatestRow>(layout.probes.map((item) => latestStatement.bind(item.probeId)))
    : [];
  const latestRows = latestResults.flatMap((result) => result.results);

  // Staleness tracks the hourly schedule only; a manual reading must not hide a stalled hub schedule.
  const scheduledRow = await db
    .prepare(`SELECT MAX(${READING_TIME_SQL}) AS last_at FROM readings WHERE source = 'scheduled'`)
    .first<{ last_at: string | null }>();
  const lastScheduledAt = scheduledRow?.last_at ? `${scheduledRow.last_at.replace(" ", "T")}Z` : null;

  const rangeRows = await db
    .prepare(
      `SELECT probe_id, MIN(temperature_c) AS min_c, MAX(temperature_c) AS max_c
       FROM readings
       WHERE source = 'scheduled'
         AND status = 'ok'
         AND temperature_c IS NOT NULL
         AND ${READING_TIME_SQL} >= datetime('now', '-24 hours')
       GROUP BY probe_id`,
    )
    .all<RangeRow>();

  const latestByProbe = new Map(latestRows.map((row) => [row.probe_id, row]));
  const rangeByProbe = new Map(rangeRows.results.map((row) => [row.probe_id, row]));

  const probes: SummaryProbe[] = layout.probes.map((item) => {
    const latest = latestByProbe.get(item.probeId);
    const range = rangeByProbe.get(item.probeId);
    return {
      probeId: item.probeId,
      label: item.label,
      kind: item.kind,
      ...(item.row !== undefined ? { row: item.row } : {}),
      ...(item.col !== undefined ? { col: item.col } : {}),
      latest: latest
        ? {
            temperatureC: latest.temperature_c,
            rawTemperatureC: latest.raw_temperature_c,
            status: latest.status,
            sampledAt: latest.sampled_at,
            receivedAt: latest.received_at,
            sampleId: latest.sample_id,
            source: latest.source,
            timeQuality: latest.time_quality,
          }
        : null,
      min24hC: range?.min_c ?? null,
      max24hC: range?.max_c ?? null,
    };
  });

  let lastSampleAt: string | null = null;
  for (const probe of probes) {
    const stamp = probe.latest?.sampledAt ?? probe.latest?.receivedAt ?? null;
    if (stamp && (!lastSampleAt || stamp > lastSampleAt)) lastSampleAt = stamp;
  }
  const stale =
    lastScheduledAt === null ||
    Date.now() - Date.parse(lastScheduledAt) > STALE_AFTER_MINUTES * 60 * 1000;

  return {
    timezone: layout.timezone,
    stale,
    staleAfterMinutes: STALE_AFTER_MINUTES,
    lastSampleAt,
    lastScheduledAt,
    layout: { probes: layout.probes },
    probes,
    air: probes.find((probe) => probe.kind === "air") ?? null,
  };
}
