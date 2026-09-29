import { HttpError } from "../http/errors";
import { parseProbeLayout, type ProbeLayoutItem } from "./layout";

export interface SiteSettings {
  alertThresholdC: number;
  alertCooldownHours: number;
  alertsEnabled: boolean;
  timezone: string;
  emailRecipients: string[];
  lastAlertAt: string | null;
  updatedAt: string;
  probes: ProbeLayoutItem[];
  pendingAlertSampleId: string | null;
  pendingAlertAttempts: number;
}

export interface SettingsUpdate {
  alertThresholdC: number;
  alertCooldownHours: number;
  alertsEnabled: boolean;
  emailRecipients: string[];
  probes: ProbeLayoutItem[];
}

interface SettingsRow {
  alert_threshold_c: number;
  alert_cooldown_hours: number;
  alerts_enabled: number;
  timezone: string;
  email_recipients: string;
  last_alert_at: string | null;
  probe_layout: string;
  updated_at: string;
  pending_alert_sample_id: string | null;
  pending_alert_attempts: number;
}

function parseRecipients(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function loadSettings(db: D1Database): Promise<SiteSettings> {
  const row = await db
    .prepare(
      `SELECT alert_threshold_c, alert_cooldown_hours, alerts_enabled, timezone, email_recipients,
              last_alert_at, probe_layout, updated_at, pending_alert_sample_id, pending_alert_attempts
       FROM settings WHERE id = 1`,
    )
    .first<SettingsRow>();
  if (!row) {
    throw new HttpError(500, "misconfigured", "Site settings are missing");
  }
  return {
    alertThresholdC: row.alert_threshold_c,
    alertCooldownHours: row.alert_cooldown_hours,
    alertsEnabled: row.alerts_enabled === 1,
    timezone: row.timezone,
    emailRecipients: parseRecipients(row.email_recipients),
    lastAlertAt: row.last_alert_at,
    updatedAt: row.updated_at,
    probes: parseProbeLayout(row.probe_layout),
    pendingAlertSampleId: row.pending_alert_sample_id,
    pendingAlertAttempts: row.pending_alert_attempts,
  };
}

export async function saveSettings(db: D1Database, update: SettingsUpdate): Promise<void> {
  await db
    .prepare(
      `UPDATE settings SET
         alert_threshold_c = ?,
         alert_cooldown_hours = ?,
         alerts_enabled = ?,
         email_recipients = ?,
         probe_layout = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = 1`,
    )
    .bind(
      update.alertThresholdC,
      update.alertCooldownHours,
      update.alertsEnabled ? 1 : 0,
      JSON.stringify(update.emailRecipients),
      JSON.stringify({ probes: update.probes }),
    )
    .run();
}

/**
 * Starts a new alert for `sampleId` unless the cooldown since `last_alert_at` is still running.
 * A single conditional UPDATE, so two uploads arriving together cannot both claim the alert.
 */
export async function claimAlert(db: D1Database, sampleId: string, now: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE settings SET
         last_alert_at = ?1,
         pending_alert_sample_id = ?2,
         pending_alert_attempts = 0
       WHERE id = 1
         AND (last_alert_at IS NULL
              OR datetime(last_alert_at) <= datetime(?1, '-' || alert_cooldown_hours || ' hours'))`,
    )
    .bind(now, sampleId)
    .run();
  return result.meta.changes === 1;
}

export async function clearPendingAlert(db: D1Database, sampleId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE settings SET pending_alert_sample_id = NULL, pending_alert_attempts = 0 WHERE id = 1 AND pending_alert_sample_id = ?",
    )
    .bind(sampleId)
    .run();
}

export async function recordPendingAlertFailure(db: D1Database, sampleId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE settings SET pending_alert_attempts = pending_alert_attempts + 1 WHERE id = 1 AND pending_alert_sample_id = ?",
    )
    .bind(sampleId)
    .run();
}
