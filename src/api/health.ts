import { jsonResponse } from "../http/json";

export async function handleHealth(env: Env): Promise<Response> {
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (!row) {
      return jsonResponse(503, { ok: false, service: "wheat-temperature-api" });
    }
    return jsonResponse(200, { ok: true, service: "wheat-temperature-api" });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "health_db_failed", error: String(error) }));
    return jsonResponse(503, { ok: false, service: "wheat-temperature-api" });
  }
}
