import { HttpError } from "../http/errors";
import { PROBE_IDS, type ProbeId } from "./sample";

export type ReadingsGroup = "raw" | "hour" | "day" | "week" | "month";

export interface ReadingsQuery {
  start: string;
  end: string;
  group: ReadingsGroup;
  includeManual: boolean;
  probes: ProbeId[];
}

const GROUP_SET = new Set<string>(["raw", "hour", "day", "week", "month"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/;

const DEFAULT_LOOKBACK: Record<ReadingsGroup, { amount: number; unit: string }> = {
  raw: { amount: 24, unit: "hours" },
  hour: { amount: 48, unit: "hours" },
  day: { amount: 30, unit: "days" },
  week: { amount: 12, unit: "weeks" },
  month: { amount: 12, unit: "months" },
};

function parseIso(value: string, field: string): string {
  if (!ISO_RE.test(value) || Number.isNaN(Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value))) {
    throw new HttpError(400, "invalid_query", `${field} must be an ISO-8601 date or UTC timestamp`);
  }
  if (value.length === 10) return `${value}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(value)) return value.replace("Z", ":00Z");
  return value;
}

function defaultRange(group: ReadingsGroup): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  const lookback = DEFAULT_LOOKBACK[group];
  switch (lookback.unit) {
    case "hours":
      start.setUTCHours(start.getUTCHours() - lookback.amount);
      break;
    case "days":
      start.setUTCDate(start.getUTCDate() - lookback.amount);
      break;
    case "weeks":
      start.setUTCDate(start.getUTCDate() - lookback.amount * 7);
      break;
    default:
      start.setUTCMonth(start.getUTCMonth() - lookback.amount);
      break;
  }
  return { start: start.toISOString().replace(/\.\d{3}Z$/, "Z"), end: end.toISOString().replace(/\.\d{3}Z$/, "Z") };
}

export function parseReadingsQuery(url: URL): ReadingsQuery {
  const groupRaw = url.searchParams.get("group") ?? "day";
  if (!GROUP_SET.has(groupRaw)) {
    throw new HttpError(400, "invalid_query", "group must be raw, hour, day, week or month");
  }
  const group = groupRaw as ReadingsGroup;

  const includeManual =
    url.searchParams.get("includeManual") === "true" || url.searchParams.get("includeManual") === "1";

  const defaults = defaultRange(group);
  const start = url.searchParams.has("start") ? parseIso(url.searchParams.get("start") ?? "", "start") : defaults.start;
  const end = url.searchParams.has("end") ? parseIso(url.searchParams.get("end") ?? "", "end") : defaults.end;
  if (Date.parse(start) > Date.parse(end)) {
    throw new HttpError(400, "invalid_query", "start must be before end");
  }

  const probeParam = url.searchParams.get("probes");
  let probes: ProbeId[] = [...PROBE_IDS];
  if (probeParam) {
    const allowed = new Set<string>(PROBE_IDS);
    const requested = probeParam
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (requested.length === 0 || requested.some((id) => !allowed.has(id))) {
      throw new HttpError(400, "invalid_query", "probes contains an unknown probeId");
    }
    probes = requested as ProbeId[];
  }

  return { start, end, group, includeManual, probes };
}
