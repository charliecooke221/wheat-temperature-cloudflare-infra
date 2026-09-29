import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { signToken } from "../src/auth/tokens";
import { ADMIN_PASSWORD, adminHeaders } from "./helpers";
import { call, resetState } from "./worker";

beforeEach(resetState);

async function login(password = ADMIN_PASSWORD, ip?: string) {
  return call(
    "/api/v1/auth/login",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) },
    ip,
  );
}

async function adminToken(): Promise<string> {
  const response = await login();
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

interface ConfigProbe {
  probeId: string;
  label: string;
  kind: "grain" | "air";
  row?: number;
  col?: number;
}

interface ConfigBody {
  ok: boolean;
  config: {
    alertThresholdC: number;
    alertCooldownHours: number;
    alertsEnabled: boolean;
    emailRecipients: string[];
    lastAlertAt: string | null;
    probes: ConfigProbe[];
  };
  push: { vapidPublicKey: string | null };
}

async function getConfig(token: string): Promise<ConfigBody> {
  const response = await call("/api/v1/admin/config", { headers: adminHeaders(token) });
  expect(response.status).toBe(200);
  return (await response.json()) as ConfigBody;
}

function validUpdate(probes: ConfigProbe[]) {
  return {
    alertThresholdC: 22.5,
    alertCooldownHours: 12,
    alertsEnabled: true,
    emailRecipients: ["farmer@example.test", "helper@example.test"],
    probes,
  };
}

async function putConfig(token: string, body: unknown) {
  return call("/api/v1/admin/config", { method: "PUT", headers: adminHeaders(token), body: JSON.stringify(body) });
}

describe("POST /api/v1/auth/login", () => {
  it("rejects a wrong password and issues a one-hour token for the right one", async () => {
    expect((await login("wrong password")).status).toBe(401);

    const response = await login();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { token: string; expiresAt: string };
    expect(body.token).toMatch(/^[\w-]+\.[\w-]+$/);
    const lifetime = Date.parse(body.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(59 * 60 * 1000);
    expect(lifetime).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("locks an IP out after repeated failures without affecting other IPs", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login("nope", "198.51.100.7")).status).toBe(401);
    }
    const locked = await login(ADMIN_PASSWORD, "198.51.100.7");
    expect(locked.status).toBe(429);

    expect((await login(ADMIN_PASSWORD, "198.51.100.8")).status).toBe(200);
  });

  it("clears the failure count after a successful login", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) await login("nope");
    expect((await login()).status).toBe(200);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("rejects a missing password", async () => {
    const response = await call("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });
});

describe("admin token checks", () => {
  it("rejects missing, forged and expired tokens", async () => {
    expect((await call("/api/v1/admin/config")).status).toBe(401);

    const forged = await signToken({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 600 }, "wrong-key");
    expect((await call("/api/v1/admin/config", { headers: adminHeaders(forged) })).status).toBe(401);

    const expired = await signToken({ sub: "admin", exp: Math.floor(Date.now() / 1000) - 1 }, "test-admin-token-key");
    expect((await call("/api/v1/admin/config", { headers: adminHeaders(expired) })).status).toBe(401);

    const token = await adminToken();
    const tampered = `${token.slice(0, -2)}xx`;
    expect((await call("/api/v1/admin/config", { headers: adminHeaders(tampered) })).status).toBe(401);
  });

  it("does not let an expired token change settings", async () => {
    const expired = await signToken({ sub: "admin", exp: Math.floor(Date.now() / 1000) - 1 }, "test-admin-token-key");
    const token = await adminToken();
    const { config } = await getConfig(token);
    const response = await putConfig(expired, validUpdate(config.probes));
    expect(response.status).toBe(401);
    expect((await getConfig(token)).config.alertsEnabled).toBe(false);
  });

  it("does not accept the hub upload token", async () => {
    const response = await call("/api/v1/admin/config", { headers: adminHeaders("test-hub-token") });
    expect(response.status).toBe(401);
  });
});

describe("GET/PUT /api/v1/admin/config", () => {
  it("returns the editable settings and the push public key", async () => {
    const body = await getConfig(await adminToken());
    expect(body.config.alertThresholdC).toBe(25);
    expect(body.config.alertCooldownHours).toBe(24);
    expect(body.config.alertsEnabled).toBe(false);
    expect(body.config.emailRecipients).toEqual([]);
    expect(body.config.lastAlertAt).toBeNull();
    expect(body.config.probes).toHaveLength(10);
    expect(body.push.vapidPublicKey).toMatch(/^B[\w-]{86}$/);
  });

  it("saves layout, labels, alerts and recipients, and the public summary follows", async () => {
    const token = await adminToken();
    const { config } = await getConfig(token);
    // Swap grain-01 and grain-09 and relabel both.
    const probes = config.probes.map((probe) => {
      if (probe.probeId === "grain-01") return { ...probe, label: "Door left", row: 2, col: 2 };
      if (probe.probeId === "grain-09") return { ...probe, label: "Back right", row: 0, col: 0 };
      return probe;
    });

    const response = await putConfig(token, validUpdate(probes));
    expect(response.status).toBe(200);
    const saved = (await response.json()) as ConfigBody;
    expect(saved.config.alertThresholdC).toBe(22.5);
    expect(saved.config.alertCooldownHours).toBe(12);
    expect(saved.config.alertsEnabled).toBe(true);
    expect(saved.config.emailRecipients).toEqual(["farmer@example.test", "helper@example.test"]);

    const summary = (await (await call("/api/v1/summary")).json()) as {
      probes: Array<{ probeId: string; label: string; row?: number; col?: number }>;
    };
    const moved = summary.probes.find((probe) => probe.probeId === "grain-01");
    expect(moved).toMatchObject({ label: "Door left", row: 2, col: 2 });
    expect(JSON.stringify(summary)).not.toContain("farmer@example.test");
  });

  it("rejects invalid settings without saving them", async () => {
    const token = await adminToken();
    const { config } = await getConfig(token);
    const probes = config.probes;
    const withProbe = (id: string, patch: Partial<ConfigProbe>) =>
      probes.map((probe) => (probe.probeId === id ? { ...probe, ...patch } : probe));

    const cases: unknown[] = [
      { ...validUpdate(probes), alertThresholdC: 90 },
      { ...validUpdate(probes), alertCooldownHours: 0.5 },
      { ...validUpdate(probes), emailRecipients: ["not-an-email"] },
      { ...validUpdate(probes), emailRecipients: ["a@example.test", "A@example.test"] },
      { ...validUpdate(probes), emailRecipients: [] },
      validUpdate(withProbe("grain-02", { row: 0, col: 0 })),
      validUpdate(withProbe("grain-02", { row: 3 })),
      validUpdate(withProbe("air-01", { kind: "grain", row: 1, col: 1 })),
      validUpdate(withProbe("grain-03", { label: "   " })),
      validUpdate(probes.slice(1)),
      validUpdate([...probes.slice(1), { ...probes[1]! }]),
    ];
    for (const body of cases) {
      const response = await putConfig(token, body);
      expect(response.status, JSON.stringify(body).slice(0, 120)).toBe(400);
    }
    expect((await getConfig(token)).config.alertsEnabled).toBe(false);
  });
});

describe("CORS", () => {
  it("allows the Authorization header and admin methods for the dashboard origin", async () => {
    const response = await call("/api/v1/admin/config", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "PUT" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
