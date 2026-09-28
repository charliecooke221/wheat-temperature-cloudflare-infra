import { loadSummary } from "../database/summary";
import { jsonResponse, publicCacheHeaders } from "../http/json";

export async function handleSummary(env: Env): Promise<Response> {
  const summary = await loadSummary(env.DB);
  return jsonResponse(200, { ok: true, ...summary }, publicCacheHeaders(30));
}
