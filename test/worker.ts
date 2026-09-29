import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index";

/**
 * Calls the Worker directly and waits for its waitUntil() work (alerts), so tests can
 * assert on emails and pushes sent after the response.
 */
export async function call(path: string, init?: RequestInit, ip = "203.0.113.10"): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("CF-Connecting-IP", ip);
  const request = new Request(`http://example.com${path}`, { ...init, headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function runScheduled(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "*/15 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

let defaultLayout: string | null = null;

/** Restores the settings row and clears admin, alert and push state between tests. */
export async function resetState(): Promise<void> {
  if (defaultLayout === null) {
    const row = await env.DB.prepare("SELECT probe_layout FROM settings WHERE id = 1").first<{ probe_layout: string }>();
    defaultLayout = row?.probe_layout ?? null;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM readings"),
    env.DB.prepare("DELETE FROM login_attempts"),
    env.DB.prepare("DELETE FROM push_subscriptions"),
    env.DB.prepare(
      `UPDATE settings SET alert_threshold_c = 25, alert_cooldown_hours = 24, alerts_enabled = 0,
         email_recipients = '[]', last_alert_at = NULL, pending_alert_sample_id = NULL,
         pending_alert_attempts = 0, probe_layout = ? WHERE id = 1`,
    ).bind(defaultLayout),
  ]);
}
