import type { ProbeLayoutItem } from "../database/layout";
import type { SiteSettings } from "../database/settings";

export interface AlertReading {
  probeId: string;
  label: string;
  kind: "grain" | "air";
  temperatureC: number | null;
  /** Reading status from the hub, or "missing" when the sample had no row for this probe. */
  status: string;
}

export interface AlertContent {
  test: boolean;
  sampleId: string | null;
  sampledAt: string | null;
  timeIsReceived: boolean;
  thresholdC: number;
  maxC: number | null;
  triggerProbeId: string | null;
  readings: AlertReading[];
}

export interface RenderedAlert {
  subject: string;
  html: string;
  text: string;
  pushTitle: string;
  pushBody: string;
}

interface SampleRow {
  probe_id: string;
  temperature_c: number | null;
  status: string;
  sampled_at: string | null;
  received_at: string;
}

export interface LoadedSample {
  sampleId: string;
  sampledAt: string | null;
  receivedAt: string;
  rows: Map<string, { temperatureC: number | null; status: string }>;
}

export async function loadSample(db: D1Database, sampleId: string): Promise<LoadedSample | null> {
  const { results } = await db
    .prepare("SELECT probe_id, temperature_c, status, sampled_at, received_at FROM readings WHERE sample_id = ?")
    .bind(sampleId)
    .all<SampleRow>();
  const first = results[0];
  if (!first) return null;
  return {
    sampleId,
    sampledAt: first.sampled_at,
    receivedAt: first.received_at,
    rows: new Map(results.map((row) => [row.probe_id, { temperatureC: row.temperature_c, status: row.status }])),
  };
}

// Grain in 3x3 reading order (top-left first), then air.
function orderedLayout(probes: ProbeLayoutItem[]): ProbeLayoutItem[] {
  const position = (probe: ProbeLayoutItem) =>
    probe.kind === "air" ? 100 : (probe.row ?? 9) * 3 + (probe.col ?? 9);
  return [...probes].sort((a, b) => position(a) - position(b));
}

export function hottestGrain(readings: AlertReading[]): AlertReading | null {
  let hottest: AlertReading | null = null;
  for (const reading of readings) {
    if (reading.kind !== "grain" || reading.status !== "ok" || reading.temperatureC === null) continue;
    if (!hottest || reading.temperatureC > (hottest.temperatureC ?? -Infinity)) hottest = reading;
  }
  return hottest;
}

export function buildAlertContent(settings: SiteSettings, sample: LoadedSample | null, test: boolean): AlertContent {
  const readings: AlertReading[] = orderedLayout(settings.probes).map((probe) => {
    const row = sample?.rows.get(probe.probeId);
    return {
      probeId: probe.probeId,
      label: probe.label,
      kind: probe.kind,
      temperatureC: row?.temperatureC ?? null,
      status: row?.status ?? "missing",
    };
  });
  const hottest = hottestGrain(readings);
  return {
    test,
    sampleId: sample?.sampleId ?? null,
    sampledAt: sample ? (sample.sampledAt ?? sample.receivedAt) : null,
    timeIsReceived: sample !== null && sample.sampledAt === null,
    thresholdC: settings.alertThresholdC,
    maxC: hottest?.temperatureC ?? null,
    triggerProbeId: hottest?.probeId ?? null,
    readings,
  };
}

function formatC(value: number | null): string {
  return value === null ? "--" : `${value.toFixed(1)} °C`;
}

function statusText(reading: AlertReading): string {
  switch (reading.status) {
    case "ok":
      return "OK";
    case "disconnected":
      return "Disconnected";
    case "missing":
      return "No reading";
    default:
      return "Error";
  }
}

function formatTime(iso: string | null, timezone: string): string {
  if (!iso) return "No reading available";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderAlert(content: AlertContent, timezone: string, dashboardUrl: string): RenderedAlert {
  const prefix = content.test ? "[TEST] " : "";
  const trigger = content.readings.find((reading) => reading.probeId === content.triggerProbeId) ?? null;
  const time = formatTime(content.sampledAt, timezone);
  const timeNote = content.timeIsReceived ? " (hub clock was not synced; time received)" : "";

  const subject =
    content.maxC === null
      ? `${prefix}Wheat temperature alert test: no grain readings available`
      : `${prefix}Wheat temperature alert: ${formatC(content.maxC)} (threshold ${formatC(content.thresholdC)})`;

  const intro = content.test
    ? "This is a test alert sent from the admin page. It uses the latest scheduled sample and does not affect the alert cooldown."
    : `A scheduled reading reached the alert threshold of ${formatC(content.thresholdC)}.`;
  const triggerLine = trigger
    ? `Hottest grain probe: ${trigger.label} at ${formatC(trigger.temperatureC)}.`
    : "No grain probe returned a valid reading.";

  const grain = content.readings.filter((reading) => reading.kind === "grain");
  const air = content.readings.filter((reading) => reading.kind === "air");

  const textLines = [
    intro,
    "",
    `Sample time: ${time}${timeNote}`,
    triggerLine,
    "",
    "Grain probes:",
    ...grain.map(
      (reading) =>
        `  ${reading.probeId === content.triggerProbeId ? "*" : " "} ${reading.label}: ${formatC(reading.temperatureC)} (${statusText(reading)})`,
    ),
    "",
    ...air.map((reading) => `Air (${reading.label}): ${formatC(reading.temperatureC)} (${statusText(reading)})`),
    "",
    `Dashboard: ${dashboardUrl}`,
  ];
  if (content.sampleId) textLines.push(`Sample ID: ${content.sampleId}`);

  const row = (reading: AlertReading) => {
    const isTrigger = reading.probeId === content.triggerProbeId;
    const bad = reading.status !== "ok";
    const style = isTrigger ? "background:#fde8e4;font-weight:600;" : "";
    return `<tr style="${style}">
      <td style="padding:6px 10px;border-bottom:1px solid #e5e0d4;">${escapeHtml(reading.label)}${isTrigger ? " &#9650;" : ""}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e0d4;text-align:right;">${escapeHtml(formatC(reading.temperatureC))}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e0d4;${bad ? "color:#b3261e;" : "color:#4a5a3a;"}">${statusText(reading)}</td>
    </tr>`;
  };

  const html = `<!doctype html>
<html><body style="margin:0;padding:16px;background:#f3efe4;font-family:Arial,Helvetica,sans-serif;color:#2b2a26;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:20px;">
    <h1 style="font-size:20px;margin:0 0 12px;">${escapeHtml(subject)}</h1>
    <p style="margin:0 0 12px;">${escapeHtml(intro)}</p>
    <p style="margin:0 0 4px;"><strong>Sample time:</strong> ${escapeHtml(time + timeNote)}</p>
    <p style="margin:0 0 16px;"><strong>${escapeHtml(triggerLine)}</strong></p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead><tr>
        <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #c9c1ad;">Grain probe</th>
        <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #c9c1ad;">Temperature</th>
        <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #c9c1ad;">Status</th>
      </tr></thead>
      <tbody>${grain.map(row).join("")}</tbody>
      <thead><tr>
        <th style="text-align:left;padding:14px 10px 6px;border-bottom:2px solid #c9c1ad;">Air</th>
        <th style="border-bottom:2px solid #c9c1ad;"></th><th style="border-bottom:2px solid #c9c1ad;"></th>
      </tr></thead>
      <tbody>${air.map(row).join("")}</tbody>
    </table>
    <p style="margin:20px 0 0;"><a href="${escapeHtml(dashboardUrl)}" style="color:#7a5a12;">Open the dashboard</a></p>
    ${content.sampleId ? `<p style="margin:8px 0 0;font-size:12px;color:#77705f;">Sample ID: ${escapeHtml(content.sampleId)}</p>` : ""}
  </div>
</body></html>`;

  const pushTitle = content.test ? "Test alert: wheat temperature" : "Wheat temperature alert";
  const pushBody = trigger
    ? `${trigger.label} is ${formatC(trigger.temperatureC)} (threshold ${formatC(content.thresholdC)}).`
    : "No grain readings are available.";

  return { subject, html, text: textLines.join("\n"), pushTitle, pushBody };
}
