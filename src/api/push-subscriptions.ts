import { pushConfigured, sendPushTo } from "../alerts/push";
import { requireAdminToken } from "../auth/admin";
import { base64UrlDecode } from "../auth/tokens";
import {
  countPushSubscriptions,
  deletePushSubscription,
  deletePushSubscriptionByEndpoint,
  findPushSubscriptionByEndpoint,
  listPushSubscriptions,
  upsertPushSubscription,
} from "../database/push-subscriptions";
import { HttpError } from "../http/errors";
import { jsonResponse, publicCacheHeaders, readJsonBody } from "../http/json";

// Kept small because anyone can sign up. It also stays well under the 50 outbound
// requests Workers Free allows per invocation, since every alert sends one per device.
export const MAX_SUBSCRIPTIONS = 10;
const MAX_ENDPOINT_LENGTH = 1024;

// Anyone can subscribe, so only real browser push services are accepted. Otherwise the
// Worker could be made to POST to arbitrary URLs on every alert.
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge on Android, Samsung Internet, Opera, Brave
  "android.googleapis.com",
  "push.services.mozilla.com", // Firefox
  "push.apple.com", // Safari and iPhone/iPad Home Screen apps
  "notify.windows.com", // Edge on Windows
];

function invalid(message: string): HttpError {
  return new HttpError(400, "invalid_subscription", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knownPushHost(host: string): boolean {
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function parseEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_ENDPOINT_LENGTH) throw invalid("endpoint is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("endpoint must be a URL");
  }
  if (url.protocol !== "https:") throw invalid("endpoint must use https");
  if (!knownPushHost(url.hostname)) throw invalid("endpoint is not a recognised browser push service");
  return value;
}

function parseKey(value: unknown, field: string, bytes: number): string {
  const decoded = typeof value === "string" ? base64UrlDecode(value.replace(/=+$/, "")) : null;
  if (!decoded || decoded.length !== bytes) throw invalid(`keys.${field} is invalid`);
  return (value as string).replace(/=+$/, "");
}

async function endpointFromBody(request: Request): Promise<string> {
  const body = await readJsonBody(request);
  if (!isRecord(body)) throw invalid("Body must be a JSON object");
  return parseEndpoint(body.endpoint);
}

export function handlePushPublicKey(env: Env): Response {
  return jsonResponse(
    200,
    { ok: true, vapidPublicKey: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : null },
    publicCacheHeaders(300),
  );
}

/** Public. Body is the browser's PushSubscription.toJSON(), optionally with a device `label`. */
export async function handlePushSubscribe(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!pushConfigured(env)) {
    throw new HttpError(503, "push_not_configured", "Notifications are not set up on the server yet.");
  }
  const body = await readJsonBody(request);
  if (!isRecord(body) || !isRecord(body.keys)) throw invalid("Body must be a push subscription");

  const endpoint = parseEndpoint(body.endpoint);
  const p256dh = parseKey(body.keys.p256dh, "p256dh", 65);
  const auth = parseKey(body.keys.auth, "auth", 16);
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : null;

  const existing = await findPushSubscriptionByEndpoint(env.DB, endpoint);
  if (!existing && (await countPushSubscriptions(env.DB)) >= MAX_SUBSCRIPTIONS) {
    throw new HttpError(409, "too_many_subscriptions", "The notification list is full. Ask the site owner to make room.");
  }

  const id = await upsertPushSubscription(env.DB, { endpoint, p256dh, auth, label });
  console.log(JSON.stringify({ level: "info", event: "push_subscription_saved", id, updated: existing !== null }));

  // A first notification straight away shows the person it works on their device. A
  // subscription the service worker renewed by itself (`renewed`) stays silent.
  if (!existing && body.renewed !== true) {
    ctx.waitUntil(
      findPushSubscriptionByEndpoint(env.DB, endpoint).then((saved) =>
        saved
          ? sendPushTo(env, [saved], {
              title: "Wheat temperature notifications on",
              body: "You will be notified here when the grain gets too warm.",
              url: env.DASHBOARD_URL,
              tag: "wheat-welcome",
            })
          : undefined,
      ),
    );
  }
  return jsonResponse(existing ? 200 : 201, { ok: true });
}

/**
 * Public. The endpoint URL is only known to the browser that owns it, so holding it is
 * enough to remove it, without exposing a way to list or delete other people's devices.
 */
export async function handlePushUnsubscribe(request: Request, env: Env): Promise<Response> {
  const removed = await deletePushSubscriptionByEndpoint(env.DB, await endpointFromBody(request));
  if (removed) console.log(JSON.stringify({ level: "info", event: "push_subscription_removed_by_device" }));
  return jsonResponse(200, { ok: true, removed });
}

/** Public. Lets a browser check that the server still has its subscription (an admin may have removed it). */
export async function handlePushStatus(request: Request, env: Env): Promise<Response> {
  const saved = await findPushSubscriptionByEndpoint(env.DB, await endpointFromBody(request));
  return jsonResponse(200, { ok: true, subscribed: saved !== null }, { "cache-control": "no-store" });
}

export async function handleListPushSubscriptions(request: Request, env: Env): Promise<Response> {
  await requireAdminToken(request, env);
  const subscriptions = await listPushSubscriptions(env.DB);
  return jsonResponse(
    200,
    {
      ok: true,
      maxSubscriptions: MAX_SUBSCRIPTIONS,
      subscriptions: subscriptions.map((item) => ({
        id: item.id,
        label: item.label,
        createdAt: item.createdAt,
        lastSuccessAt: item.lastSuccessAt,
        // The endpoint is a bearer-like capability URL, so only its host is shown.
        service: new URL(item.endpoint).host,
      })),
    },
    { "cache-control": "no-store" },
  );
}

export async function handleDeletePushSubscription(request: Request, env: Env, id: string): Promise<Response> {
  await requireAdminToken(request, env);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "not_found", "Unknown subscription");
  if (!(await deletePushSubscription(env.DB, id))) {
    throw new HttpError(404, "not_found", "Unknown subscription");
  }
  console.log(JSON.stringify({ level: "info", event: "push_subscription_deleted", id }));
  return jsonResponse(200, { ok: true });
}
