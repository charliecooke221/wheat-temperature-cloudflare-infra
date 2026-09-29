import { HttpError } from "../http/errors";
import { bearerToken, sha256Hex, signToken, timingSafeEqualString, verifyToken } from "./tokens";

export const ADMIN_TOKEN_TTL_SECONDS = 60 * 60;

// Per-IP lockout: this many failures inside the window blocks further attempts until it ends.
export const MAX_LOGIN_FAILURES = 5;
export const LOGIN_WINDOW_MINUTES = 15;
const DEFAULT_FAILURE_DELAY_MS = 750;

export interface AdminLogin {
  token: string;
  expiresAt: string;
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function requireAdminSecrets(env: Env): { hash: string; salt: string; key: string } {
  if (!env.ADMIN_PASSWORD_HASH || !env.ADMIN_PASSWORD_SALT || !env.ADMIN_TOKEN_KEY) {
    throw new HttpError(503, "misconfigured", "Admin login is not configured");
  }
  return { hash: env.ADMIN_PASSWORD_HASH.toLowerCase(), salt: env.ADMIN_PASSWORD_SALT, key: env.ADMIN_TOKEN_KEY };
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function isLockedOut(db: D1Database, ip: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT failures FROM login_attempts
       WHERE ip = ? AND datetime(window_started_at) > datetime('now', ?)`,
    )
    .bind(ip, `-${LOGIN_WINDOW_MINUTES} minutes`)
    .first<{ failures: number }>();
  return (row?.failures ?? 0) >= MAX_LOGIN_FAILURES;
}

async function recordFailure(db: D1Database, ip: string): Promise<void> {
  // A failure after the window has passed starts a fresh window instead of adding to the old count.
  await db
    .prepare(
      `INSERT INTO login_attempts (ip, failures, window_started_at)
       VALUES (?1, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (ip) DO UPDATE SET
         failures = CASE WHEN datetime(window_started_at) > datetime('now', ?2) THEN failures + 1 ELSE 1 END,
         window_started_at = CASE WHEN datetime(window_started_at) > datetime('now', ?2)
           THEN window_started_at ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now') END`,
    )
    .bind(ip, `-${LOGIN_WINDOW_MINUTES} minutes`)
    .run();
}

function failureDelayMs(env: Env): number {
  const configured = Number(env.LOGIN_FAILURE_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_FAILURE_DELAY_MS;
}

export async function loginWithPassword(request: Request, env: Env, password: string): Promise<AdminLogin> {
  const secrets = requireAdminSecrets(env);
  const ip = clientIp(request);

  if (await isLockedOut(env.DB, ip)) {
    throw new HttpError(429, "too_many_attempts", `Too many failed logins. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`);
  }

  const candidate = await sha256Hex(secrets.salt + password);
  if (!(await timingSafeEqualString(candidate, secrets.hash))) {
    await recordFailure(env.DB, ip);
    console.warn(JSON.stringify({ level: "warn", event: "admin_login_failed", ip }));
    await new Promise((resolve) => setTimeout(resolve, failureDelayMs(env)));
    throw new HttpError(401, "unauthorized", "Incorrect password");
  }

  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();

  const now = new Date();
  const expires = new Date(now.getTime() + ADMIN_TOKEN_TTL_SECONDS * 1000);
  const token = await signToken(
    { sub: "admin", iat: Math.floor(now.getTime() / 1000), exp: Math.floor(expires.getTime() / 1000) },
    secrets.key,
  );
  console.log(JSON.stringify({ level: "info", event: "admin_login", ip }));
  return { token, expiresAt: isoSeconds(expires) };
}

export async function requireAdminToken(request: Request, env: Env): Promise<void> {
  const { key } = requireAdminSecrets(env);
  const token = bearerToken(request.headers.get("Authorization"));
  const payload = token ? await verifyToken(token, key) : null;
  const exp = payload?.exp;
  if (!payload || payload.sub !== "admin" || typeof exp !== "number" || exp * 1000 <= Date.now()) {
    throw new HttpError(401, "unauthorized", "Admin session is missing or expired");
  }
}

export async function purgeOldLoginAttempts(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM login_attempts WHERE datetime(window_started_at) <= datetime('now', ?)")
    .bind(`-${LOGIN_WINDOW_MINUTES} minutes`)
    .run();
}
