-- Phase C3 / F5: admin login limits, alert retry state and Web Push subscriptions.

-- Failed admin logins per client IP. A row is cleared on successful login and
-- ignored once its window has passed.
CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_started_at TEXT NOT NULL
);

-- An alert whose email failed to send. The scheduled trigger retries it
-- without creating a new alert or resetting the cooldown.
ALTER TABLE settings ADD COLUMN pending_alert_sample_id TEXT;
ALTER TABLE settings ADD COLUMN pending_alert_attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT
);
