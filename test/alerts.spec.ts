import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { MAX_ALERT_EMAIL_ATTEMPTS } from "../src/alerts/alerts";
import { MAX_SUBSCRIPTIONS } from "../src/api/push-subscriptions";
import type { SampleReading } from "../src/api/sample";
import { ADMIN_PASSWORD, adminHeaders, fakePushSubscription, hubHeaders, validSample } from "./helpers";
import { call, resetState, runScheduled } from "./worker";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const PUSH_HOST = "https://fcm.googleapis.com/";

let fetchSpy: MockInstance<typeof fetch>;
let brevoStatus = 201;
let pushStatus = 201;

beforeEach(async () => {
  await resetState();
  brevoStatus = 201;
  pushStatus = 201;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === BREVO_URL) {
      return new Response(JSON.stringify({ messageIds: ["1"] }), { status: brevoStatus });
    }
    if (url.startsWith(PUSH_HOST)) return new Response(null, { status: pushStatus });
    throw new Error(`Unexpected fetch to ${url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function brevoCalls() {
  return fetchSpy.mock.calls.filter(([input]) => String(input) === BREVO_URL);
}

function pushCalls() {
  return fetchSpy.mock.calls.filter(([input]) => String(input).startsWith(PUSH_HOST));
}

function brevoBody(index = 0) {
  const init = brevoCalls()[index]?.[1];
  return JSON.parse(String(init?.body)) as {
    subject: string;
    htmlContent: string;
    textContent: string;
    sender: { email: string };
    messageVersions: Array<{ to: Array<{ email: string }> }>;
  };
}

async function enableAlerts(recipients = ["farmer@example.test", "helper@example.test"], thresholdC = 25) {
  await env.DB.prepare(
    "UPDATE settings SET alerts_enabled = 1, alert_threshold_c = ?, email_recipients = ? WHERE id = 1",
  )
    .bind(thresholdC, JSON.stringify(recipients))
    .run();
}

let sequence = 0;

function reading(channel: number, temperatureC: number | null, status: SampleReading["status"] = "ok"): SampleReading {
  return {
    channel,
    probeId: (channel === 10 ? "air-01" : `grain-0${channel}`) as SampleReading["probeId"],
    romId: null,
    rawTemperatureC: temperatureC,
    temperatureC,
    status,
  };
}

async function upload(readings: SampleReading[], source: "scheduled" | "manual" = "scheduled") {
  sequence += 1;
  const response = await call("/api/v1/samples", {
    method: "POST",
    headers: hubHeaders(),
    body: JSON.stringify(
      validSample({
        sampleId: `01ALERTSAMPLE${String(sequence).padStart(6, "0")}`,
        uploadSequence: sequence,
        source,
        sampledAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        readings,
      }),
    ),
  });
  expect(response.status).toBe(201);
}

async function settingsRow() {
  return env.DB.prepare(
    "SELECT last_alert_at, pending_alert_sample_id, pending_alert_attempts FROM settings WHERE id = 1",
  ).first<{ last_alert_at: string | null; pending_alert_sample_id: string | null; pending_alert_attempts: number }>();
}

async function adminToken(): Promise<string> {
  const response = await call("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  return ((await response.json()) as { token: string }).token;
}

const HOT_SAMPLE = [reading(1, 20), reading(2, 27.4), reading(3, null, "disconnected"), reading(10, 18)];

describe("threshold alerts", () => {
  it("emails every recipient once with all readings from the triggering sample", async () => {
    await enableAlerts();
    await upload(HOT_SAMPLE);

    expect(brevoCalls()).toHaveLength(1);
    const init = brevoCalls()[0]?.[1];
    expect(new Headers(init?.headers).get("api-key")).toBe("test-brevo-key");

    const body = brevoBody();
    expect(body.sender.email).toBe("alerts@example.test");
    expect(body.subject).toBe("Wheat temperature alert: 27.4 °C (threshold 25.0 °C)");
    // One message version per recipient, so recipients do not see each other.
    expect(body.messageVersions).toEqual([
      { to: [{ email: "farmer@example.test" }] },
      { to: [{ email: "helper@example.test" }] },
    ]);
    // Every probe appears, including failed and absent ones.
    for (let n = 1; n <= 9; n += 1) expect(body.textContent).toContain(`Grain ${n}:`);
    expect(body.textContent).toContain("* Grain 2: 27.4 °C (OK)");
    expect(body.textContent).toContain("Grain 3: -- (Disconnected)");
    expect(body.textContent).toContain("Grain 4: -- (No reading)");
    expect(body.textContent).toContain("Air (Air): 18.0 °C (OK)");
    expect(body.textContent).toContain("https://example.test/dashboard/");
    expect(body.textContent).toMatch(/Sample time: .*(BST|GMT)/);
    expect(body.htmlContent).toContain("Grain 9");

    const row = await settingsRow();
    expect(row?.last_alert_at).not.toBeNull();
    expect(row?.pending_alert_sample_id).toBeNull();
  });

  it("sends no more than one alert inside the cooldown", async () => {
    await enableAlerts();
    await upload(HOT_SAMPLE);
    await upload([reading(1, 30)]);
    await upload([reading(1, 31)]);
    expect(brevoCalls()).toHaveLength(1);
  });

  it("alerts again once the cooldown has passed", async () => {
    await enableAlerts();
    await upload(HOT_SAMPLE);
    await env.DB.prepare("UPDATE settings SET last_alert_at = ? WHERE id = 1")
      .bind(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString())
      .run();
    await upload([reading(1, 30)]);
    expect(brevoCalls()).toHaveLength(2);
  });

  it("ignores manual samples, air, failed probes and readings below the threshold", async () => {
    await enableAlerts();
    await upload([reading(1, 40)], "manual");
    await upload([reading(1, 20), reading(10, 40)]);
    await upload([reading(1, 24.9), reading(2, null, "error")]);
    expect(brevoCalls()).toHaveLength(0);
    expect((await settingsRow())?.last_alert_at).toBeNull();
  });

  it("does nothing while alerts are disabled", async () => {
    await upload(HOT_SAMPLE);
    expect(brevoCalls()).toHaveLength(0);
  });

  it("does not alert again when the hub retries an accepted sample", async () => {
    await enableAlerts();
    const sample = validSample({ sampleId: "01ALERTDUPLICATEABCDEFGH", readings: HOT_SAMPLE });
    const post = () =>
      call("/api/v1/samples", { method: "POST", headers: hubHeaders(), body: JSON.stringify(sample) });
    expect((await post()).status).toBe(201);
    await env.DB.prepare("UPDATE settings SET last_alert_at = NULL WHERE id = 1").run();
    expect((await post()).status).toBe(200);
    expect(brevoCalls()).toHaveLength(1);
  });
});

describe("failed alert email retry", () => {
  it("keeps the upload successful, then retries from the scheduled trigger without a new alert", async () => {
    await enableAlerts();
    brevoStatus = 500;
    await upload(HOT_SAMPLE);

    let row = await settingsRow();
    expect(row?.pending_alert_sample_id).not.toBeNull();
    expect(row?.pending_alert_attempts).toBe(1);
    const firstAlertAt = row?.last_alert_at;

    brevoStatus = 201;
    await runScheduled();
    row = await settingsRow();
    expect(row?.pending_alert_sample_id).toBeNull();
    expect(row?.last_alert_at).toBe(firstAlertAt);
    expect(brevoCalls()).toHaveLength(2);
    expect(brevoBody(1).textContent).toContain("* Grain 2: 27.4 °C (OK)");

    await runScheduled();
    expect(brevoCalls()).toHaveLength(2);
  });

  it("gives up after the maximum number of attempts", async () => {
    await enableAlerts();
    brevoStatus = 500;
    await upload(HOT_SAMPLE);
    for (let attempt = 1; attempt < MAX_ALERT_EMAIL_ATTEMPTS; attempt += 1) await runScheduled();
    expect((await settingsRow())?.pending_alert_attempts).toBe(MAX_ALERT_EMAIL_ATTEMPTS);

    await runScheduled();
    expect((await settingsRow())?.pending_alert_sample_id).toBeNull();
    expect(brevoCalls()).toHaveLength(MAX_ALERT_EMAIL_ATTEMPTS);
  });
});

describe("POST /api/v1/admin/alert-test", () => {
  it("requires an admin token", async () => {
    const response = await call("/api/v1/admin/alert-test", { method: "POST", headers: hubHeaders() });
    expect(response.status).toBe(401);
  });

  it("explains when there is nobody to send to", async () => {
    const response = await call("/api/v1/admin/alert-test", {
      method: "POST",
      headers: adminHeaders(await adminToken()),
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  it("sends a marked test using the latest scheduled sample without touching the cooldown", async () => {
    await upload([reading(1, 19.5), reading(10, 12)]);
    await env.DB.prepare("UPDATE settings SET email_recipients = ? WHERE id = 1")
      .bind(JSON.stringify(["farmer@example.test"]))
      .run();

    const response = await call("/api/v1/admin/alert-test", {
      method: "POST",
      headers: adminHeaders(await adminToken()),
      body: "{}",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe("Test alert sent to 1 email recipient.");

    expect(brevoCalls()).toHaveLength(1);
    expect(brevoBody().subject.startsWith("[TEST] ")).toBe(true);
    expect(brevoBody().textContent).toContain("* Grain 1: 19.5 °C (OK)");
    expect((await settingsRow())?.last_alert_at).toBeNull();
  });

  it("reports an email provider failure", async () => {
    await env.DB.prepare("UPDATE settings SET email_recipients = ? WHERE id = 1")
      .bind(JSON.stringify(["farmer@example.test"]))
      .run();
    brevoStatus = 401;
    const response = await call("/api/v1/admin/alert-test", {
      method: "POST",
      headers: adminHeaders(await adminToken()),
      body: "{}",
    });
    expect(response.status).toBe(502);
  });
});

describe("Web Push", () => {
  async function subscribe(endpoint?: string) {
    return call("/api/v1/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(await fakePushSubscription(endpoint)), label: "Test phone" }),
    });
  }

  async function postEndpoint(path: string, endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
    const response = await call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function devices(token: string) {
    const response = await call("/api/v1/admin/push-subscriptions", { headers: adminHeaders(token) });
    return ((await response.json()) as { subscriptions: Array<{ id: string; label: string; service: string }> })
      .subscriptions;
  }

  it("publishes the VAPID public key", async () => {
    const response = await call("/api/v1/push/public-key");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { vapidPublicKey: string }).vapidPublicKey).toMatch(/^B[\w-]{86}$/);
  });

  it("lets anyone subscribe without a login and sends a confirmation notification", async () => {
    const created = await subscribe();
    expect(created.status).toBe(201);
    expect(pushCalls()).toHaveLength(1);

    const again = await subscribe();
    expect(again.status).toBe(200);
    expect(pushCalls()).toHaveLength(1);

    const list = await devices(await adminToken());
    expect(list).toEqual([expect.objectContaining({ label: "Test phone", service: "fcm.googleapis.com" })]);
    expect(JSON.stringify(list)).not.toContain("abc123");
  });

  it("reports status and unsubscribes only by the device's own endpoint", async () => {
    await subscribe();
    expect((await postEndpoint("/api/v1/push/status")).body.subscribed).toBe(true);
    const other = await postEndpoint("/api/v1/push/unsubscribe", "https://fcm.googleapis.com/fcm/send/other");
    expect(other.body.removed).toBe(false);
    expect((await postEndpoint("/api/v1/push/unsubscribe")).body.removed).toBe(true);
    expect((await postEndpoint("/api/v1/push/status")).body.subscribed).toBe(false);
  });

  it("lets an admin list and remove devices, but not anonymously", async () => {
    await subscribe();
    expect((await call("/api/v1/admin/push-subscriptions")).status).toBe(401);

    const token = await adminToken();
    const [device] = await devices(token);
    const anonymous = await call(`/api/v1/admin/push-subscriptions/${device!.id}`, { method: "DELETE" });
    expect(anonymous.status).toBe(401);
    const deleted = await call(`/api/v1/admin/push-subscriptions/${device!.id}`, {
      method: "DELETE",
      headers: adminHeaders(token),
    });
    expect(deleted.status).toBe(200);
    expect(await devices(token)).toEqual([]);
  });

  it("rejects invalid subscriptions and endpoints that are not browser push services", async () => {
    const valid = await fakePushSubscription();
    const bad = [
      { ...valid, endpoint: "https://evil.example.test/collect" },
      { ...valid, endpoint: "https://fcm.googleapis.com.evil.example.test/x" },
      { ...valid, endpoint: "http://fcm.googleapis.com/fcm/send/insecure" },
      { ...valid, keys: { ...valid.keys, p256dh: "short" } },
      { ...valid, keys: { ...valid.keys, auth: valid.keys.p256dh } },
      { endpoint: valid.endpoint },
    ];
    for (const body of bad) {
      const response = await call("/api/v1/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await devices(await adminToken())).toEqual([]);
  });

  it("accepts Firefox, Apple and Windows push endpoints", async () => {
    for (const endpoint of [
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QABC",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect((await subscribe(endpoint)).status).toBe(201);
    }
  });

  it("caps the number of devices", async () => {
    await env.DB.batch(
      Array.from({ length: MAX_SUBSCRIPTIONS }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'k', 'a', '2026-01-01T00:00:00Z')",
        ).bind(crypto.randomUUID(), `https://fcm.googleapis.com/fcm/send/filler-${index}`),
      ),
    );
    expect((await subscribe()).status).toBe(409);
  });

  it("pushes an encrypted notification from the same alert event as the email", async () => {
    await subscribe();
    fetchSpy.mockClear();
    await enableAlerts();
    await upload(HOT_SAMPLE);

    expect(brevoCalls()).toHaveLength(1);
    expect(pushCalls()).toHaveLength(1);
    const init = pushCalls()[0]?.[1] as RequestInit & { headers: Record<string, string> };
    expect(init.method?.toUpperCase()).toBe("POST");
    expect(init.headers["content-encoding"]).toBe("aes128gcm");
    expect(init.headers.authorization).toMatch(/^vapid t=.+, k=B/);
    expect(init.headers.urgency).toBe("high");

    const row = await env.DB.prepare("SELECT last_success_at FROM push_subscriptions").first<{
      last_success_at: string | null;
    }>();
    expect(row?.last_success_at).not.toBeNull();
  });

  it("deletes subscriptions the push service reports as expired", async () => {
    await subscribe();
    pushStatus = 410;
    const response = await call("/api/v1/admin/alert-test", {
      method: "POST",
      headers: adminHeaders(await adminToken()),
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { message: string }).message).toContain("Removed 1 expired device subscription");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("sends a push-only test when there are devices but no email recipients", async () => {
    await subscribe();
    fetchSpy.mockClear();
    const response = await call("/api/v1/admin/alert-test", {
      method: "POST",
      headers: adminHeaders(await adminToken()),
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { message: string }).message).toBe("Test alert sent to 1 device.");
    expect(brevoCalls()).toHaveLength(0);
  });
});
