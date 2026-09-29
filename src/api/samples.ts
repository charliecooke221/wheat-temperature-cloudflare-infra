import { evaluateSampleAlert } from "../alerts/alerts";
import { requireHubToken } from "../auth/hub";
import { insertSample } from "../database/readings";
import { readJsonBody, jsonResponse } from "../http/json";
import { parseSampleUpload } from "./sample";

export async function handlePostSample(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await requireHubToken(request, env);
  const sample = parseSampleUpload(await readJsonBody(request));
  const result = await insertSample(env.DB, sample);

  console.log(
    JSON.stringify({
      level: "info",
      event: result.inserted ? "sample_inserted" : "sample_duplicate",
      sampleId: sample.sampleId,
      source: sample.source,
      readingCount: sample.readings.length,
    }),
  );

  // Alerts run after the response so a slow email provider never delays or fails the hub upload.
  // A retried (duplicate) upload never alerts again.
  if (result.inserted) {
    ctx.waitUntil(
      evaluateSampleAlert(env, sample).catch((error: unknown) => {
        console.error(
          JSON.stringify({ level: "error", event: "alert_evaluation_failed", sampleId: sample.sampleId, error: String(error) }),
        );
      }),
    );
  }

  return jsonResponse(result.inserted ? 201 : 200, {
    ok: true,
    duplicate: !result.inserted,
    sampleId: sample.sampleId,
  });
}
