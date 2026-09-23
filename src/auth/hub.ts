import { HttpError } from "../http/errors";

async function digest(value: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
}

async function timingSafeEqualString(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  return crypto.subtle.timingSafeEqual(leftDigest, rightDigest);
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function requireHubToken(request: Request, env: Env): Promise<void> {
  if (!env.HUB_UPLOAD_TOKEN) {
    throw new HttpError(500, "misconfigured", "Hub upload token is not configured");
  }

  const token = bearerToken(request.headers.get("Authorization"));
  if (!token || !(await timingSafeEqualString(token, env.HUB_UPLOAD_TOKEN))) {
    throw new HttpError(401, "unauthorized", "Invalid hub upload token");
  }
}
