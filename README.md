# wheat-temperature-cloudflare-infra

Cloudflare Worker + D1 API for the wheat-temperature hub. Phase C1 covers
ingestion: the hub POSTs a sample, the Worker authenticates it, and D1 stores
one row per probe. Duplicate `sampleId` uploads return success without inserting
again.

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
| `POST` | `/api/v1/samples` | hub bearer token |
| `OPTIONS` | any of the above | CORS preflight |

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

## Secrets later (not needed for C1)

These wait until admin login / email alerts (phase C3):

- admin password hash, salt, token-signing key
- Brevo API key and verified sender address

Do not put any of those in `wrangler.jsonc`.

## Layout

```text
src/
  index.ts          Worker entry
  api/              routes + sample validation
  auth/             hub bearer token
  database/         D1 inserts
  http/             JSON, CORS, errors
migrations/
  0001_initial.sql  settings + readings
test/               valid / invalid / partial / duplicate cases
```
