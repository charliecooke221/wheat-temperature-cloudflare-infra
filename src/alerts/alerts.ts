import type { SampleUpload } from "../api/sample";
import { countPushSubscriptions } from "../database/push-subscriptions";
import {
  claimAlert,
  clearPendingAlert,
  loadSettings,
  recordPendingAlertFailure,
  type SiteSettings,
} from "../database/settings";
import { READING_TIME_SQL } from "../database/time";
import { HttpError } from "../http/errors";
import { emailConfigured, sendAlertEmail } from "./email";
import { buildAlertContent, loadSample, renderAlert, type RenderedAlert } from "./message";
import { sendPushToAll, type PushResult } from "./push";

// With the 15-minute retry trigger this keeps trying for about two hours.
export const MAX_ALERT_EMAIL_ATTEMPTS = 8;

const DEFAULT_DASHBOARD_URL = "https://charliecooke221.github.io/wheat-temperature-frontend/";

function dashboardUrl(env: Env): string {
  return env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

async function renderForSample(env: Env, settings: SiteSettings, sampleId: string | null, test: boolean) {
  const sample = sampleId ? await loadSample(env.DB, sampleId) : null;
  const content = buildAlertContent(settings, sample, test);
  return renderAlert(content, settings.timezone, dashboardUrl(env));
}

function pushFor(env: Env, rendered: RenderedAlert, test: boolean) {
  return sendPushToAll(env, {
    title: rendered.pushTitle,
    body: rendered.pushBody,
    url: dashboardUrl(env),
    tag: test ? "wheat-alert-test" : "wheat-alert",
  });
}

async function sendPendingEmail(env: Env, settings: SiteSettings, sampleId: string, rendered: RenderedAlert) {
  try {
    await sendAlertEmail(env, settings.emailRecipients, rendered);
    await clearPendingAlert(env.DB, sampleId);
    log("info", "alert_email_sent", { sampleId, recipientCount: settings.emailRecipients.length });
  } catch (error) {
    await recordPendingAlertFailure(env.DB, sampleId);
    log("error", "alert_email_failed", { sampleId, error: String(error) });
  }
}

/**
 * Runs after a new sample is stored. Only scheduled samples can alert; air, manual and
 * failed readings are ignored. The cooldown claim happens before sending, so a failed
 * email is retried by the scheduled trigger rather than creating another alert.
 */
export async function evaluateSampleAlert(env: Env, sample: SampleUpload): Promise<void> {
  if (sample.source !== "scheduled") return;

  const settings = await loadSettings(env.DB);
  if (!settings.alertsEnabled) return;

  const grain = sample.readings.filter(
    (reading) => reading.probeId.startsWith("grain-") && reading.status === "ok" && reading.temperatureC !== null,
  );
  const maxC = grain.reduce<number | null>(
    (max, reading) => (max === null || (reading.temperatureC as number) > max ? reading.temperatureC : max),
    null,
  );
  if (maxC === null || maxC < settings.alertThresholdC) return;

  if (!(await claimAlert(env.DB, sample.sampleId, isoNow()))) {
    log("info", "alert_suppressed_cooldown", { sampleId: sample.sampleId, maxC, lastAlertAt: settings.lastAlertAt });
    return;
  }
  log("warn", "alert_triggered", { sampleId: sample.sampleId, maxC, thresholdC: settings.alertThresholdC });

  const rendered = await renderForSample(env, settings, sample.sampleId, false);
  const [push] = await Promise.all([
    pushFor(env, rendered, false),
    sendPendingEmail(env, settings, sample.sampleId, rendered),
  ]);
  log("info", "alert_push_result", { sampleId: sample.sampleId, ...push });
}

/** Called by the scheduled trigger: resends the email for an alert whose first send failed. */
export async function retryPendingAlert(env: Env): Promise<void> {
  const settings = await loadSettings(env.DB);
  const sampleId = settings.pendingAlertSampleId;
  if (!sampleId) return;

  if (!settings.alertsEnabled || settings.emailRecipients.length === 0) {
    await clearPendingAlert(env.DB, sampleId);
    log("info", "alert_retry_dropped", { sampleId, reason: "alerts disabled or no recipients" });
    return;
  }
  if (settings.pendingAlertAttempts >= MAX_ALERT_EMAIL_ATTEMPTS) {
    await clearPendingAlert(env.DB, sampleId);
    log("error", "alert_email_abandoned", { sampleId, attempts: settings.pendingAlertAttempts });
    return;
  }

  log("info", "alert_email_retry", { sampleId, attempt: settings.pendingAlertAttempts + 1 });
  const rendered = await renderForSample(env, settings, sampleId, false);
  await sendPendingEmail(env, settings, sampleId, rendered);
}

export interface TestAlertResult {
  emailed: number;
  push: PushResult;
}

/** Sends a clearly marked test using the latest scheduled sample. Does not touch the cooldown. */
export async function sendTestAlert(env: Env): Promise<TestAlertResult> {
  const settings = await loadSettings(env.DB);
  const recipients = settings.emailRecipients;
  const deviceCount = await countPushSubscriptions(env.DB);

  if (recipients.length === 0 && deviceCount === 0) {
    throw new HttpError(400, "no_recipients", "Add an email recipient or enable notifications on a device first.");
  }
  if (recipients.length > 0 && !emailConfigured(env)) {
    throw new HttpError(503, "email_not_configured", "Email sending is not configured on the Worker yet.");
  }

  const latest = await env.DB
    .prepare(`SELECT sample_id FROM readings WHERE source = 'scheduled' ORDER BY ${READING_TIME_SQL} DESC LIMIT 1`)
    .first<{ sample_id: string }>();
  const rendered = await renderForSample(env, settings, latest?.sample_id ?? null, true);

  if (recipients.length > 0) {
    try {
      await sendAlertEmail(env, recipients, rendered);
    } catch (error) {
      log("error", "test_alert_email_failed", { error: String(error) });
      throw new HttpError(502, "email_failed", "The email provider did not accept the test alert. Check the Worker logs.");
    }
  }
  const push = await pushFor(env, rendered, true);
  log("info", "test_alert_sent", { emailed: recipients.length, ...push });
  return { emailed: recipients.length, push };
}
