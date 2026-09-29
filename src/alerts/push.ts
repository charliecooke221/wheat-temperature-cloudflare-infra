import { buildPushPayload, type PushMessage } from "@block65/webcrypto-web-push";
import {
  deletePushSubscription,
  listPushSubscriptions,
  markPushSuccess,
  type StoredPushSubscription,
} from "../database/push-subscriptions";

// Keep an undelivered alert queued at the push service for a day, e.g. while a phone is off.
const PUSH_TTL_SECONDS = 24 * 60 * 60;

export interface PushNotification {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface PushResult {
  configured: boolean;
  sent: number;
  removed: number;
  failed: number;
}

export function pushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/**
 * Sends one notification to each given subscription. Push is best effort: failures are
 * logged, not retried, and subscriptions the push service reports as gone are deleted.
 */
export async function sendPushTo(
  env: Env,
  subscriptions: StoredPushSubscription[],
  notification: PushNotification,
): Promise<PushResult> {
  const result: PushResult = { configured: pushConfigured(env), sent: 0, removed: 0, failed: 0 };
  if (!result.configured) return result;

  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const message: PushMessage = {
    data: { ...notification },
    options: { ttl: PUSH_TTL_SECONDS, urgency: "high", topic: notification.tag },
  };

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        const payload = await buildPushPayload(
          message,
          {
            endpoint: subscription.endpoint,
            expirationTime: null,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          vapid,
        );
        const response = await fetch(subscription.endpoint, payload);
        if (response.ok) {
          result.sent += 1;
          await markPushSuccess(env.DB, subscription.id);
        } else if (response.status === 404 || response.status === 410) {
          result.removed += 1;
          await deletePushSubscription(env.DB, subscription.id);
          console.log(JSON.stringify({ level: "info", event: "push_subscription_expired", id: subscription.id }));
        } else {
          result.failed += 1;
          console.error(
            JSON.stringify({
              level: "error",
              event: "push_failed",
              id: subscription.id,
              status: response.status,
              detail: (await response.text()).slice(0, 300),
            }),
          );
        }
      } catch (error) {
        result.failed += 1;
        console.error(JSON.stringify({ level: "error", event: "push_failed", id: subscription.id, error: String(error) }));
      }
    }),
  );
  return result;
}

export async function sendPushToAll(env: Env, notification: PushNotification): Promise<PushResult> {
  if (!pushConfigured(env)) return { configured: false, sent: 0, removed: 0, failed: 0 };
  return sendPushTo(env, await listPushSubscriptions(env.DB), notification);
}
