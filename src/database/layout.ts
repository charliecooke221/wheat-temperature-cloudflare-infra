import { HttpError } from "../http/errors";

export interface ProbeLayoutItem {
  probeId: string;
  label: string;
  kind: "grain" | "air";
  row?: number;
  col?: number;
}

export interface PublicLayout {
  timezone: string;
  probes: ProbeLayoutItem[];
}

interface SettingsRow {
  timezone: string;
  probe_layout: string;
}

export async function loadPublicLayout(db: D1Database): Promise<PublicLayout> {
  const row = await db
    .prepare("SELECT timezone, probe_layout FROM settings WHERE id = 1")
    .first<SettingsRow>();
  if (!row) {
    throw new HttpError(500, "misconfigured", "Site settings are missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.probe_layout);
  } catch {
    throw new HttpError(500, "misconfigured", "Probe layout is not valid JSON");
  }

  const probes = Array.isArray((parsed as { probes?: unknown }).probes)
    ? ((parsed as { probes: unknown[] }).probes)
    : [];

  const items: ProbeLayoutItem[] = [];
  for (const probe of probes) {
    if (typeof probe !== "object" || probe === null) continue;
    const record = probe as Record<string, unknown>;
    if (typeof record.probeId !== "string" || typeof record.label !== "string") continue;
    if (record.kind !== "grain" && record.kind !== "air") continue;
    const item: ProbeLayoutItem = {
      probeId: record.probeId,
      label: record.label,
      kind: record.kind,
    };
    if (typeof record.row === "number") item.row = record.row;
    if (typeof record.col === "number") item.col = record.col;
    items.push(item);
  }

  return { timezone: row.timezone, probes: items };
}
