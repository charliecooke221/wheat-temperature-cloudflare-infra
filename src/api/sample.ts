import { HttpError } from "../http/errors";

export const PROBE_IDS = [
  "grain-01",
  "grain-02",
  "grain-03",
  "grain-04",
  "grain-05",
  "grain-06",
  "grain-07",
  "grain-08",
  "grain-09",
  "air-01",
] as const;

export type ProbeId = (typeof PROBE_IDS)[number];
export type SampleSource = "scheduled" | "manual";
export type TimeQuality = "ntp" | "rtc" | "unsynced";
export type ReadingStatus = "ok" | "disconnected" | "error";

export interface SampleReading {
  channel: number;
  probeId: ProbeId;
  romId: string | null;
  rawTemperatureC: number | null;
  temperatureC: number | null;
  status: ReadingStatus;
}

export interface SampleUpload {
  schemaVersion: 1;
  sampleId: string;
  hubId: string;
  source: SampleSource;
  sampledAt: string | null;
  timeQuality: TimeQuality;
  batteryV: number | null;
  externalPower: boolean;
  firmwareVersion: string;
  uploadSequence: number;
  readings: SampleReading[];
}

const PROBE_ID_SET = new Set<string>(PROBE_IDS);
const SOURCE_SET = new Set<string>(["scheduled", "manual"]);
const TIME_QUALITY_SET = new Set<string>(["ntp", "rtc", "unsynced"]);
const STATUS_SET = new Set<string>(["ok", "disconnected", "error"]);

const SAMPLE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HUB_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ROM_ID_RE = /^[0-9A-Fa-f]{0,32}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const MIN_TEMP_C = -55;
const MAX_TEMP_C = 125;
const DISCONNECTED_SENTINEL = -127;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function expectedProbeId(channel: number): ProbeId {
  return channel === 10 ? "air-01" : (`grain-0${channel}` as ProbeId);
}

function requireString(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    throw new HttpError(400, "invalid_sample", `${field} is required`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLen: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLen) {
    throw new HttpError(400, "invalid_sample", `${field} is invalid`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!isFiniteNumber(value)) {
    throw new HttpError(400, "invalid_sample", `${field} must be a number`);
  }
  return value;
}

function parseTemperature(value: unknown, field: string, required: boolean): number | null {
  if (value === undefined || value === null) {
    if (required) {
      throw new HttpError(400, "invalid_sample", `${field} is required for ok readings`);
    }
    return null;
  }
  if (!isFiniteNumber(value)) {
    throw new HttpError(400, "invalid_sample", `${field} must be a number`);
  }
  if (value === DISCONNECTED_SENTINEL) {
    throw new HttpError(400, "invalid_sample", `${field} must not use the disconnected sentinel`);
  }
  if (value < MIN_TEMP_C || value > MAX_TEMP_C) {
    throw new HttpError(400, "invalid_sample", `${field} is outside the accepted range`);
  }
  return value;
}

function parseReading(value: unknown, index: number): SampleReading {
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_sample", `readings[${index}] must be an object`);
  }

  if (!isFiniteNumber(value.channel) || !Number.isInteger(value.channel) || value.channel < 1 || value.channel > 10) {
    throw new HttpError(400, "invalid_sample", `readings[${index}].channel must be 1-10`);
  }
  const channel = value.channel;

  const probeId = requireString(value.probeId, `readings[${index}].probeId`, 16);
  if (!PROBE_ID_SET.has(probeId)) {
    throw new HttpError(400, "invalid_sample", `readings[${index}].probeId is unknown`);
  }
  if (probeId !== expectedProbeId(channel)) {
    throw new HttpError(400, "invalid_sample", `readings[${index}] channel and probeId do not match`);
  }

  const romId = optionalString(value.romId, `readings[${index}].romId`, 32);
  if (romId !== null && !ROM_ID_RE.test(romId)) {
    throw new HttpError(400, "invalid_sample", `readings[${index}].romId is invalid`);
  }

  const status = requireString(value.status, `readings[${index}].status`, 16);
  if (!STATUS_SET.has(status)) {
    throw new HttpError(400, "invalid_sample", `readings[${index}].status is invalid`);
  }

  const ok = status === "ok";
  return {
    channel,
    probeId: probeId as ProbeId,
    romId,
    rawTemperatureC: parseTemperature(value.rawTemperatureC, `readings[${index}].rawTemperatureC`, ok),
    temperatureC: parseTemperature(value.temperatureC, `readings[${index}].temperatureC`, ok),
    status: status as ReadingStatus,
  };
}

export function parseSampleUpload(body: unknown): SampleUpload {
  if (!isRecord(body)) {
    throw new HttpError(400, "invalid_sample", "Body must be a JSON object");
  }

  if (body.schemaVersion !== 1) {
    throw new HttpError(400, "invalid_sample", "schemaVersion must be 1");
  }

  const sampleId = requireString(body.sampleId, "sampleId", 64);
  if (!SAMPLE_ID_RE.test(sampleId)) {
    throw new HttpError(400, "invalid_sample", "sampleId is invalid");
  }

  const hubId = requireString(body.hubId, "hubId", 64);
  if (!HUB_ID_RE.test(hubId)) {
    throw new HttpError(400, "invalid_sample", "hubId is invalid");
  }

  const source = requireString(body.source, "source", 16);
  if (!SOURCE_SET.has(source)) {
    throw new HttpError(400, "invalid_sample", "source must be scheduled or manual");
  }

  const timeQuality = requireString(body.timeQuality, "timeQuality", 16);
  if (!TIME_QUALITY_SET.has(timeQuality)) {
    throw new HttpError(400, "invalid_sample", "timeQuality is invalid");
  }

  let sampledAt: string | null = null;
  if (body.sampledAt !== undefined && body.sampledAt !== null) {
    sampledAt = requireString(body.sampledAt, "sampledAt", 40);
    if (!ISO_UTC_RE.test(sampledAt) || Number.isNaN(Date.parse(sampledAt))) {
      throw new HttpError(400, "invalid_sample", "sampledAt must be an ISO-8601 UTC timestamp");
    }
  } else if (timeQuality !== "unsynced") {
    throw new HttpError(400, "invalid_sample", "sampledAt is required unless timeQuality is unsynced");
  }

  const batteryV = optionalNumber(body.batteryV, "batteryV");
  if (batteryV !== null && (batteryV < 0 || batteryV > 6)) {
    throw new HttpError(400, "invalid_sample", "batteryV is outside the accepted range");
  }

  if (typeof body.externalPower !== "boolean") {
    throw new HttpError(400, "invalid_sample", "externalPower must be a boolean");
  }

  const firmwareVersion = requireString(body.firmwareVersion, "firmwareVersion", 32);
  if (!isFiniteNumber(body.uploadSequence) || !Number.isInteger(body.uploadSequence) || body.uploadSequence < 1) {
    throw new HttpError(400, "invalid_sample", "uploadSequence must be a positive integer");
  }

  if (!Array.isArray(body.readings) || body.readings.length < 1 || body.readings.length > 10) {
    throw new HttpError(400, "invalid_sample", "readings must contain 1-10 items");
  }

  const readings = body.readings.map((reading, index) => parseReading(reading, index));
  const seen = new Set<string>();
  for (const reading of readings) {
    if (seen.has(reading.probeId)) {
      throw new HttpError(400, "invalid_sample", "readings contain a duplicate probeId");
    }
    seen.add(reading.probeId);
  }

  return {
    schemaVersion: 1,
    sampleId,
    hubId,
    source: source as SampleSource,
    sampledAt,
    timeQuality: timeQuality as TimeQuality,
    batteryV,
    externalPower: body.externalPower,
    firmwareVersion,
    uploadSequence: body.uploadSequence,
    readings,
  };
}
