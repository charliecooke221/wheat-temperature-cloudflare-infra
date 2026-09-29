import { HttpError } from "../http/errors";
import { corsPreflight, withCors } from "../http/cors";
import { jsonError, jsonFromHttpError } from "../http/json";
import { handleAlertTest } from "./admin-alerts";
import { handleGetConfig, handlePutConfig } from "./admin-config";
import { handleLogin } from "./auth";
import { handleHealth } from "./health";
import {
  handleDeletePushSubscription,
  handleListPushSubscriptions,
  handlePushPublicKey,
  handlePushStatus,
  handlePushSubscribe,
  handlePushUnsubscribe,
} from "./push-subscriptions";
import { handleReadings } from "./readings";
import { handlePostSample } from "./samples";
import { handleSummary } from "./summary";

const PUSH_SUBSCRIPTION_PATH = /^\/api\/v1\/admin\/push-subscriptions\/([^/]+)$/;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (method === "GET" && pathname === "/api/v1/health") return handleHealth(env);
  if (method === "GET" && pathname === "/api/v1/summary") return handleSummary(env);
  if (method === "GET" && pathname === "/api/v1/readings") return handleReadings(request, env);
  if (method === "POST" && pathname === "/api/v1/samples") return handlePostSample(request, env, ctx);

  if (method === "GET" && pathname === "/api/v1/push/public-key") return handlePushPublicKey(env);
  if (method === "POST" && pathname === "/api/v1/push/subscribe") return handlePushSubscribe(request, env, ctx);
  if (method === "POST" && pathname === "/api/v1/push/unsubscribe") return handlePushUnsubscribe(request, env);
  if (method === "POST" && pathname === "/api/v1/push/status") return handlePushStatus(request, env);

  if (method === "POST" && pathname === "/api/v1/auth/login") return handleLogin(request, env);
  if (method === "GET" && pathname === "/api/v1/admin/config") return handleGetConfig(request, env);
  if (method === "PUT" && pathname === "/api/v1/admin/config") return handlePutConfig(request, env);
  if (method === "POST" && pathname === "/api/v1/admin/alert-test") return handleAlertTest(request, env);
  if (method === "GET" && pathname === "/api/v1/admin/push-subscriptions") {
    return handleListPushSubscriptions(request, env);
  }
  const pushMatch = PUSH_SUBSCRIPTION_PATH.exec(pathname);
  if (method === "DELETE" && pushMatch) {
    return handleDeletePushSubscription(request, env, decodeURIComponent(pushMatch[1] ?? ""));
  }

  return jsonError(404, "not_found", "Unknown route");
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") {
    return corsPreflight(request, env);
  }

  try {
    return withCors(request, env, await route(request, env, ctx));
  } catch (error) {
    if (error instanceof HttpError) {
      return withCors(request, env, jsonFromHttpError(error));
    }
    console.error(JSON.stringify({ level: "error", event: "unhandled", error: String(error) }));
    return withCors(request, env, jsonError(500, "internal", "Internal error"));
  }
}
