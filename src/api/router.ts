import { HttpError } from "../http/errors";
import { corsPreflight, withCors } from "../http/cors";
import { jsonError, jsonFromHttpError } from "../http/json";
import { handleHealth } from "./health";
import { handlePostSample } from "./samples";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return corsPreflight(request, env);
  }

  const url = new URL(request.url);

  try {
    let response: Response;
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      response = await handleHealth(env);
    } else if (request.method === "POST" && url.pathname === "/api/v1/samples") {
      response = await handlePostSample(request, env);
    } else {
      response = jsonError(404, "not_found", "Unknown route");
    }
    return withCors(request, env, response);
  } catch (error) {
    if (error instanceof HttpError) {
      return withCors(request, env, jsonFromHttpError(error));
    }
    console.error(JSON.stringify({ level: "error", event: "unhandled", error: String(error) }));
    return withCors(request, env, jsonError(500, "internal", "Internal error"));
  }
}
