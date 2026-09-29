import { loginWithPassword } from "../auth/admin";
import { HttpError } from "../http/errors";
import { jsonResponse, readJsonBody } from "../http/json";

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const password =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).password : undefined;
  if (typeof password !== "string" || password.length === 0 || password.length > 256) {
    throw new HttpError(400, "invalid_request", "password is required");
  }
  const login = await loginWithPassword(request, env, password);
  return jsonResponse(200, { ok: true, ...login }, { "cache-control": "no-store" });
}
