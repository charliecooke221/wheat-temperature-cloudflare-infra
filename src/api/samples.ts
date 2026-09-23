import { requireHubToken } from "../auth/hub";
import { insertSample } from "../database/readings";
import { readJsonBody, jsonResponse } from "../http/json";
import { parseSampleUpload } from "./sample";

export async function handlePostSample(request: Request, env: Env): Promise<Response> {
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

  return jsonResponse(result.inserted ? 201 : 200, {
    ok: true,
    duplicate: !result.inserted,
    sampleId: sample.sampleId,
  });
}
