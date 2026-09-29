import { requireAdminToken } from "../auth/admin";
import type { ProbeLayoutItem } from "../database/layout";
import { loadSettings, saveSettings, type SettingsUpdate, type SiteSettings } from "../database/settings";
import { HttpError } from "../http/errors";
import { jsonResponse, readJsonBody } from "../http/json";
import { PROBE_IDS } from "./sample";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 20;
const MAX_LABEL_LENGTH = 40;
const MIN_THRESHOLD_C = -10;
const MAX_THRESHOLD_C = 60;
const MAX_COOLDOWN_HOURS = 168;

function invalid(message: string): HttpError {
  return new HttpError(400, "invalid_config", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Kind follows the hub channel (channel 10 is air), so it is fixed rather than editable.
function expectedKind(probeId: string): "grain" | "air" {
  return probeId.startsWith("air-") ? "air" : "grain";
}

function parseProbes(value: unknown): ProbeLayoutItem[] {
  if (!Array.isArray(value) || value.length !== PROBE_IDS.length) {
    throw invalid(`probes must list all ${PROBE_IDS.length} probes`);
  }

  const known = new Set<string>(PROBE_IDS);
  const seenIds = new Set<string>();
  const seenCells = new Set<string>();
  const probes = value.map((item, index): ProbeLayoutItem => {
    if (!isRecord(item)) throw invalid(`probes[${index}] must be an object`);
    const { probeId, label, kind, row, col } = item;
    if (typeof probeId !== "string" || !known.has(probeId)) throw invalid(`probes[${index}].probeId is unknown`);
    if (seenIds.has(probeId)) throw invalid(`${probeId} is listed twice`);
    seenIds.add(probeId);

    const fixedKind = expectedKind(probeId);
    if (kind !== fixedKind) throw invalid(`${probeId} must be kind ${fixedKind}`);

    const trimmed = typeof label === "string" ? label.trim() : "";
    if (!trimmed || trimmed.length > MAX_LABEL_LENGTH) {
      throw invalid(`${probeId} needs a label of 1-${MAX_LABEL_LENGTH} characters`);
    }

    if (fixedKind === "air") return { probeId, label: trimmed, kind: fixedKind };

    const validCell = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 2;
    if (!validCell(row) || !validCell(col)) throw invalid(`${probeId} must occupy one cell of the 3x3 grid`);
    const cell = `${row},${col}`;
    if (seenCells.has(cell)) throw invalid("Each grid position must be used once");
    seenCells.add(cell);
    return { probeId, label: trimmed, kind: fixedKind, row: row as number, col: col as number };
  });

  // Keep a stable channel order in storage whatever order the editor sent.
  const order = new Map<string, number>(PROBE_IDS.map((id, index) => [id, index]));
  return probes.sort((a, b) => (order.get(a.probeId) ?? 0) - (order.get(b.probeId) ?? 0));
}

function parseRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid("emailRecipients must be a list");
  const recipients = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  if (recipients.length !== value.length) throw invalid("Every recipient must be a valid email address");
  if (recipients.length > MAX_RECIPIENTS) throw invalid(`At most ${MAX_RECIPIENTS} recipients are allowed`);
  for (const address of recipients) {
    if (address.length > 254 || !EMAIL_RE.test(address)) throw invalid(`${address} is not a valid email address`);
  }
  const folded = recipients.map((address) => address.toLowerCase());
  if (new Set(folded).size !== folded.length) throw invalid("Recipient addresses must be unique");
  return recipients;
}

export function parseConfigUpdate(body: unknown): SettingsUpdate {
  if (!isRecord(body)) throw invalid("Body must be a JSON object");

  const { alertThresholdC, alertCooldownHours, alertsEnabled } = body;
  if (
    typeof alertThresholdC !== "number" ||
    !Number.isFinite(alertThresholdC) ||
    alertThresholdC < MIN_THRESHOLD_C ||
    alertThresholdC > MAX_THRESHOLD_C
  ) {
    throw invalid(`alertThresholdC must be between ${MIN_THRESHOLD_C} and ${MAX_THRESHOLD_C}`);
  }
  if (
    typeof alertCooldownHours !== "number" ||
    !Number.isInteger(alertCooldownHours) ||
    alertCooldownHours < 1 ||
    alertCooldownHours > MAX_COOLDOWN_HOURS
  ) {
    throw invalid(`alertCooldownHours must be a whole number from 1 to ${MAX_COOLDOWN_HOURS}`);
  }
  if (typeof alertsEnabled !== "boolean") throw invalid("alertsEnabled must be true or false");

  const emailRecipients = parseRecipients(body.emailRecipients);
  if (alertsEnabled && emailRecipients.length === 0) {
    throw invalid("Add at least one recipient before enabling alerts");
  }

  return {
    alertThresholdC: Math.round(alertThresholdC * 10) / 10,
    alertCooldownHours,
    alertsEnabled,
    emailRecipients,
    probes: parseProbes(body.probes),
  };
}

function configBody(settings: SiteSettings, env: Env) {
  return {
    ok: true,
    config: {
      alertThresholdC: settings.alertThresholdC,
      alertCooldownHours: settings.alertCooldownHours,
      alertsEnabled: settings.alertsEnabled,
      timezone: settings.timezone,
      emailRecipients: settings.emailRecipients,
      lastAlertAt: settings.lastAlertAt,
      updatedAt: settings.updatedAt,
      probes: settings.probes,
      pendingAlert: settings.pendingAlertSampleId !== null,
    },
    email: { configured: Boolean(env.BREVO_API_KEY && env.ALERT_SENDER_EMAIL) },
    push: { vapidPublicKey: env.VAPID_PUBLIC_KEY || null },
  };
}

export async function handleGetConfig(request: Request, env: Env): Promise<Response> {
  await requireAdminToken(request, env);
  const settings = await loadSettings(env.DB);
  return jsonResponse(200, configBody(settings, env), { "cache-control": "no-store" });
}

export async function handlePutConfig(request: Request, env: Env): Promise<Response> {
  await requireAdminToken(request, env);
  const update = parseConfigUpdate(await readJsonBody(request));
  await saveSettings(env.DB, update);
  console.log(
    JSON.stringify({
      level: "info",
      event: "admin_config_saved",
      alertsEnabled: update.alertsEnabled,
      alertThresholdC: update.alertThresholdC,
      recipientCount: update.emailRecipients.length,
    }),
  );
  const settings = await loadSettings(env.DB);
  return jsonResponse(200, configBody(settings, env), { "cache-control": "no-store" });
}
