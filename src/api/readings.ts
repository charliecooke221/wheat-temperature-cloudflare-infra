import { loadReadings } from "../database/readings-query";
import { jsonResponse, publicCacheHeaders } from "../http/json";
import { parseReadingsQuery } from "./query";

export async function handleReadings(request: Request, env: Env): Promise<Response> {
  const query = parseReadingsQuery(new URL(request.url));
  const { points } = await loadReadings(env.DB, query);
  const endMs = Date.parse(query.end);
  const historical = Number.isFinite(endMs) && Date.now() - endMs > 60 * 60 * 1000;
  return jsonResponse(
    200,
    {
      ok: true,
      group: query.group,
      includeManual: query.includeManual,
      start: query.start,
      end: query.end,
      probes: query.probes,
      points,
    },
    publicCacheHeaders(historical ? 300 : 30),
  );
}
