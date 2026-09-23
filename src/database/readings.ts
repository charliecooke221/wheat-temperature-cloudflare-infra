import type { SampleUpload } from "../api/sample";

export interface InsertSampleResult {
  inserted: boolean;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return message.includes("UNIQUE constraint failed");
}

async function sampleExists(db: D1Database, sampleId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM readings WHERE sample_id = ? LIMIT 1")
    .bind(sampleId)
    .first<{ present: number }>();
  return row !== null;
}

export async function insertSample(db: D1Database, sample: SampleUpload): Promise<InsertSampleResult> {
  if (await sampleExists(db, sample.sampleId)) {
    return { inserted: false };
  }

  const receivedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const statements = sample.readings.map((reading) =>
    db
      .prepare(
        `INSERT INTO readings (
          sample_id, probe_id, sampled_at, received_at, source, time_quality,
          raw_temperature_c, temperature_c, status, battery_v, external_power,
          firmware_version, upload_sequence, hub_id, channel, rom_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sample.sampleId,
        reading.probeId,
        sample.sampledAt,
        receivedAt,
        sample.source,
        sample.timeQuality,
        reading.rawTemperatureC,
        reading.temperatureC,
        reading.status,
        sample.batteryV,
        sample.externalPower ? 1 : 0,
        sample.firmwareVersion,
        sample.uploadSequence,
        sample.hubId,
        reading.channel,
        reading.romId,
      ),
  );

  try {
    await db.batch(statements);
    return { inserted: true };
  } catch (error) {
    if (isUniqueConstraintError(error) && (await sampleExists(db, sample.sampleId))) {
      return { inserted: false };
    }
    throw error;
  }
}
