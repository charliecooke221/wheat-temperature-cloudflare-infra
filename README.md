# wheat-temperature-cloudflare-infra

Cloudflare Worker + D1 API for the wheat-temperature hub.

This matches the firmware upload in
`firmware/wheat-temperature-monitoring-hub`.

## What is already done

You can run everything below **on your machine** without a Cloudflare login.
The first time you want a live `workers.dev` URL for the hub, you will need to
do the short Cloudflare steps at the bottom.

```text
ESP32 hub  --HTTPS JSON-->  Worker  -->  D1 (readings + settings)
```

Current routes:

| Method | Path | Auth |
| ------ | ---- | ---- |
| `GET` | `/api/v1/health` | none |
| `GET` | `/api/v1/summary` | none |
| `GET` | `/api/v1/readings` | none |
| `POST` | `/api/v1/samples` | hub bearer token |
| `POST` | `/api/v1/auth/login` | shared admin password |
| `GET` / `PUT` | `/api/v1/admin/config` | admin bearer token |
| `POST` | `/api/v1/admin/alert-test` | admin bearer token |
| `GET` | `/api/v1/push/public-key` | none |
| `POST` | `/api/v1/push/subscribe` | none (browser push services only) |
| `POST` | `/api/v1/push/unsubscribe` | none (needs the device's own endpoint) |
| `POST` | `/api/v1/push/status` | none (needs the device's own endpoint) |
| `GET` | `/api/v1/admin/push-subscriptions` | admin bearer token |
| `DELETE` | `/api/v1/admin/push-subscriptions/:id` | admin bearer token |
| `OPTIONS` | any of the above | CORS preflight |

`GET /summary` is the home-page payload: public probe layout, latest **scheduled**
reading per probe, 24-hour grain min/max, air as its own card, last sample time,
and a stale flag (no scheduled sample in 120 minutes). It never returns alert
settings or recipients.

`GET /readings` query parameters:

| Param | Default | Notes |
| ----- | ------- | ----- |
| `group` | `day` | `raw`, `hour`, `day`, `week`, `month` |
| `start` / `end` | lookback for that group | ISO date or UTC timestamp |
| `probes` | all | comma-separated probe IDs |
| `includeManual` | `false` | set `true` to include button samples |

Grain-wide `avgC` / `maxC` on each point exclude the air probe. Responses send
`Cache-Control` so browsers can reuse them for 30 seconds (5 minutes if the
requested `end` is already more than an hour in the past).

## One-time local setup

You already have Node.js. In this folder:

```powershell
cd infra\wheat-temperature-cloudflare-infra
npm install
copy .dev.vars.example .dev.vars
```

Edit `.dev.vars` and replace the placeholder with a long random token. This
file is gitignored. Generate one in PowerShell with:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
```

Apply the database schema to the **local** D1 file (not the cloud):

```powershell
npm run db:migrate:local
```

## Local test

```powershell
npm test
```

Then start the local Worker:

```powershell
npm run dev
```

Wrangler prints something like `Ready on http://127.0.0.1:8787`. In a second
terminal:

```powershell
curl http://127.0.0.1:8787/api/v1/health
```

Upload a sample (paste the same token you put in `.dev.vars`):

```powershell
curl -X POST http://127.0.0.1:8787/api/v1/samples `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer YOUR_LOCAL_HUB_TOKEN" `
  --data-binary "@sample-upload.example.json"
```

A first upload should return HTTP 201. Sending the same body again should
return HTTP 200 with `"duplicate": true`. The hub firmware treats 200, 201 and
204 as success, so retries will drain the offline queue.

## What you need to do in Cloudflare (first live deploy)

Nothing here is paid. Workers Free and D1 Free are enough.

### 1. Accept Workers in the dashboard (once)

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Sign in to the account you already have.
3. Go to **Workers & Pages**.
4. If Cloudflare asks you to enable Workers / choose a `workers.dev`
   subdomain, accept the free option and pick a short subdomain (for example
   `charliecooke`). That becomes:

   `https://wheat-temperature-api.<your-subdomain>.workers.dev`

### 2. Log Wrangler into that account

In this folder, run:

```powershell
npx wrangler login
```

A browser window opens. Click **Allow**. Wrangler stores the login on your
machine; it does not put secrets in the repo.

Check it worked:

```powershell
npx wrangler whoami
```

### 3. Create the real D1 database

```powershell
npx wrangler d1 create wheat-temperature
```

Wrangler prints a `database_id`. Open `wrangler.jsonc` and replace the
placeholder `00000000-0000-0000-0000-000000000001` with that id.

If Wrangler offers to add the binding itself, you can say yes — then just
confirm `binding` is still `DB` and `migrations_dir` is still `migrations`.

Apply the schema to the **remote** database:

```powershell
npm run db:migrate:remote
```

### 4. Store the production hub token

Use a **different** token from the local `.dev.vars` one. Keep it somewhere
safe; you will also paste it into the hub's `config_local.h`.

```powershell
npx wrangler secret put HUB_UPLOAD_TOKEN
```

Paste the token when prompted. It never goes into git.

### 5. Deploy

```powershell
npm run deploy
```

Wrangler prints the live URL. Health check:

```powershell
curl https://wheat-temperature-api.<your-subdomain>.workers.dev/api/v1/health
```

### 6. Point the hub at it

In `firmware/wheat-temperature-monitoring-hub/sketch/config_local.h`:

```c
#define API_BASE_URL "https://wheat-temperature-api.<your-subdomain>.workers.dev"
#define HUB_UPLOAD_TOKEN "the-same-production-token"
```

The firmware appends `/api/v1/samples` itself.

## Admin, alerts and push

### How it behaves

- **Login.** `POST /auth/login` checks `SHA-256(ADMIN_PASSWORD_SALT + password)`
  against `ADMIN_PASSWORD_HASH` and returns an HMAC-signed token valid for one hour.
  Each failed attempt waits 750 ms. Five failures from one IP within 15 minutes block
  that IP until the 15 minutes are up (HTTP 429). The hub token is not accepted on
  admin routes.
- **Config.** `PUT /admin/config` validates everything again on the server. All ten
  probes must be present, and nine grain probes need unique 3x3 cells. `air-01`
  stays the air probe. The threshold must be -10 to 60 °C and the cooldown 1-168
  hours. Recipients must be valid and unique, and there must be at least one before
  alerts can be enabled.
- **Alerts.** Only a *new* scheduled sample can alert. Manual samples, air, failed
  probes and duplicate uploads never do. An alert fires when the hottest valid grain
  reading is at or above the threshold and the cooldown since `last_alert_at` has
  passed. The cooldown is claimed with one conditional `UPDATE`, so two uploads
  arriving together cannot both email. The email lists every probe from that sample,
  including disconnected or missing probes, and marks the one that triggered it.
  Alerts run in `waitUntil`, so a slow or failing email provider never fails the hub
  upload.
- **Retry.** If Brevo rejects the email, the alert stays pending in `settings`. The
  15-minute cron trigger resends it up to 8 times (about two hours). The retry does
  not create a new alert or restart the cooldown.
- **Test alert.** `POST /admin/alert-test` sends a `[TEST]` email and push using the
  latest scheduled sample. It does not touch the cooldown.
- **Web Push.** Anyone can turn on notifications from the dashboard, with no login.
  Each alert and test alert also goes to every saved browser subscription
  (RFC 8291/8292, via `@block65/webcrypto-web-push`). Because signing up is public:
  - only endpoints on real browser push services are accepted (Google FCM, Mozilla,
    Apple, Windows), so nobody can make the Worker POST to an arbitrary URL;
  - a device removes itself by sending its own endpoint URL, which only that browser
    knows, so nobody can list or remove other people's devices;
  - there are at most 10 devices (`MAX_SUBSCRIPTIONS`); further sign-ups are refused
    with "the notification list is full" until an admin removes one;
  - an admin can see and remove devices on the Admin screen.

  A new device gets a confirmation notification straight away. Push is best effort
  and not retried. A subscription the push service reports as gone (404/410) is
  deleted. If a browser renews its subscription, the service worker registers the
  new one itself.

Delivery results are in the Worker logs (`alert_triggered`, `alert_email_sent`,
`alert_email_failed`, `alert_push_result`, and so on).

### Local secrets

`.dev.vars.example` lists every secret. Generate them with:

```powershell
node scripts/admin-secrets.mjs "a long admin password"   # salt, hash, token key
node scripts/vapid-keys.mjs                               # push key pair
```

Leave `BREVO_API_KEY` empty locally unless you want real emails. The admin screen
then warns that email is not configured.

### One-time production setup

1. **Brevo.** Create a free account at [brevo.com](https://www.brevo.com/). Under
   **Senders, Domains & Dedicated IPs → Senders**, add and verify the address that
   alerts should come from. Under **SMTP & API → API keys**, create an API key.
2. **Apply the new migration** to the real database:

   ```powershell
   npm run db:migrate:remote
   ```

3. **Store the secrets.** Use values generated as above. Use a *different* admin
   password and VAPID pair from your local ones:

   ```powershell
   npx wrangler secret put ADMIN_PASSWORD_SALT
   npx wrangler secret put ADMIN_PASSWORD_HASH
   npx wrangler secret put ADMIN_TOKEN_KEY
   npx wrangler secret put BREVO_API_KEY
   npx wrangler secret put ALERT_SENDER_EMAIL     # the verified Brevo sender
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put VAPID_SUBJECT          # mailto:you@example.com
   ```

4. **Deploy** with `npm run deploy`. This also registers the 15-minute cron trigger.
5. On the dashboard's **Admin** screen, add recipients, press **Send test alert**,
   and check every inbox, including spam/junk folders. Mark the first message as
   "not spam". Then set the threshold and enable alerts.

`DASHBOARD_URL` and `ALERT_SENDER_NAME` are plain vars in `wrangler.jsonc`.

### Rotating secrets

| To rotate | Do this | Effect |
| --------- | ------- | ------ |
| Admin password | Run `node scripts/admin-secrets.mjs "new password"`, then `wrangler secret put` the new `ADMIN_PASSWORD_SALT`, `ADMIN_PASSWORD_HASH` **and** `ADMIN_TOKEN_KEY` | New `ADMIN_TOKEN_KEY` signs out every open admin session immediately |
| Admin sessions only | `wrangler secret put ADMIN_TOKEN_KEY` with a new random value | Everyone must sign in again |
| Hub upload token | `wrangler secret put HUB_UPLOAD_TOKEN`, then update `HUB_UPLOAD_TOKEN` in the hub's `config_local.h` and reflash | The hub queues readings offline until it has the new token, so none are lost |
| Brevo API key | Create a new key in Brevo, `wrangler secret put BREVO_API_KEY`, then delete the old key in Brevo | Send a test alert to confirm |
| VAPID keys | `node scripts/vapid-keys.mjs`, then put both keys | Every existing push subscription stops working. Turn notifications on again on each device and remove the old entries |

Secret changes take effect on the running Worker without a redeploy. Do not put any
of these in `wrangler.jsonc`.

## Layout

```text
src/
  index.ts          Worker entry (fetch + cron retry)
  api/              routes, sample and admin-config validation
  alerts/           threshold alerts, Brevo email, Web Push
  auth/             hub token, admin login + signed tokens
  database/         D1 queries
  http/             JSON, CORS, errors
migrations/
  0001_initial.sql  settings + readings
  0002_...          reading-time indexes
  0003_...          login limits, alert retry state, push subscriptions
scripts/            admin-secret and VAPID key generators
test/               samples, read API, admin, alerts and push
```
