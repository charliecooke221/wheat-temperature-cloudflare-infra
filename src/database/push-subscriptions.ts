export interface StoredPushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
}

interface Row {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  created_at: string;
  last_success_at: string | null;
}

function fromRow(row: Row): StoredPushSubscription {
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    label: row.label,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
  };
}

export async function listPushSubscriptions(db: D1Database): Promise<StoredPushSubscription[]> {
  const { results } = await db
    .prepare("SELECT id, endpoint, p256dh, auth, label, created_at, last_success_at FROM push_subscriptions ORDER BY created_at")
    .all<Row>();
  return results.map(fromRow);
}

export async function countPushSubscriptions(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Inserts a subscription, or refreshes the keys of an existing one with the same endpoint. Returns its id. */
export async function upsertPushSubscription(
  db: D1Database,
  input: { endpoint: string; p256dh: string; auth: string; label: string | null },
): Promise<string> {
  const row = await db
    .prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label
       RETURNING id`,
    )
    .bind(crypto.randomUUID(), input.endpoint, input.p256dh, input.auth, input.label)
    .first<{ id: string }>();
  if (!row) throw new Error("Push subscription insert returned no id");
  return row.id;
}

export async function findPushSubscriptionByEndpoint(
  db: D1Database,
  endpoint: string,
): Promise<StoredPushSubscription | null> {
  const row = await db
    .prepare("SELECT id, endpoint, p256dh, auth, label, created_at, last_success_at FROM push_subscriptions WHERE endpoint = ?")
    .bind(endpoint)
    .first<Row>();
  return row ? fromRow(row) : null;
}

export async function deletePushSubscriptionByEndpoint(db: D1Database, endpoint: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  return result.meta.changes > 0;
}

export async function deletePushSubscription(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

export async function markPushSuccess(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE push_subscriptions SET last_success_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
    .bind(id)
    .run();
}
