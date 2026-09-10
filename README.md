# MailTracking

A tiny self-hosted email open tracker for **Outlook Classic (Windows)**.

You get an email when:

- a tracked message is **opened for the first time** (with how long after sending),
- a message is **still not opened** after N hours (default 24),
- a message is **opened many times in a short window** (default: 3+ opens in 30 min).

No subscription. Runs on Vercel + Upstash + Resend free tiers.

## How it works

1. An Outlook VBA macro runs on every send: it generates a unique ID, POSTs the
   subject + recipients to `/register`, and drops a 1x1 invisible image into the
   HTML body pointing at `/o/<id>.gif`.
2. When the recipient's mail client loads that image, the Vercel function logs the
   hit to Upstash Redis and emails you via Resend.
3. A Vercel cron calls `/api/cron` to nag about messages that were never opened.

```
Outlook (macro) ──register──▶ Vercel /register ──▶ Upstash Redis
      │                                              ▲
      └── pixel in email ──▶ Vercel /o/<id>.gif ─────┘──▶ Resend ──▶ your inbox
```

## Project layout

```
api/pixel.js       GET  /o/<id>.gif   log open + alerts, return the pixel
api/register.js    POST /register     called by the Outlook macro
api/dashboard.js   GET  /dashboard    table of every tracked email + status
api/cron.js        GET  /api/cron     "not opened" sweep (Vercel cron)
lib/tracker.js     shared: Redis client, config, Resend sender, sweep
vercel.json        routes (/o, /register, /dashboard) + cron schedule
ThisOutlookSession.vba   the Outlook Classic macro
alt/cloudflare/    the same tool as a single Cloudflare Worker (not needed for Vercel)
```

---

## Setup (~15 min, one time)

### 1. Resend (sends the alert emails)

1. Sign up at <https://resend.com> **using the address you want alerts delivered to**
   (this is your `NOTIFY_TO`). On the free plan the built-in `onboarding@resend.dev`
   sender can only email your own account address — fine for self-alerts. To send
   elsewhere, verify a domain later and set `NOTIFY_FROM`.
2. **API Keys → Create API Key**, copy it.

### 2. Deploy to Vercel

The repo is already on GitHub, so use the Git integration:

1. <https://vercel.com/new> → **Import** `oded-ben/MailTracking`.
2. Framework preset: **Other**. Leave build/output settings empty. Click **Deploy**
   (the first deploy will 500 until env vars + storage are set — that's expected).
3. **Storage** tab → **Create Database** → **Upstash Redis** (Marketplace) →
   connect it to this project. This auto-adds `KV_REST_API_URL` /
   `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `_TOKEN`) — the code accepts
   either.
4. **Settings → Environment Variables** — add:

   | name | value | required |
   |---|---|---|
   | `SHARED_SECRET` | long random string (also goes in the Outlook macro) | yes |
   | `RESEND_API_KEY` | from step 1 | yes |
   | `NOTIFY_TO` | where alerts are sent | yes |
   | `CRON_SECRET` | long random string (Vercel sends it to `/api/cron`) | recommended |
   | `NOTIFY_FROM` | `Email Tracker <onboarding@resend.dev>` | no |
   | `TZ` | e.g. `Asia/Jerusalem` (default `UTC`) | no |
   | `UNOPENED_HOURS` | default `24` | no |
   | `BURST_WINDOW_MIN` / `BURST_COUNT` | default `30` / `3` | no |
   | `IGNORE_FIRST_SECONDS` | default `15` | no |
   | `NOTIFY_EVERY_OPEN` | `1` = email on every re-open (noisy) | no |

5. **Deployments → Redeploy** so the new env vars take effect.
6. Note your domain, e.g. `https://mailtracking-xxxx.vercel.app`.

> CLI alternative: `npm i -g vercel`, then `vercel link`, `vercel env add ...`,
> `vercel --prod`. Still need the Upstash store from the dashboard.

### 3. Smoke-test

- `https://<domain>/o/test.gif` → a blank 1x1 image (200)
- `https://<domain>/dashboard?k=<SHARED_SECRET>` → empty table
- `https://<domain>/api/cron?k=<SHARED_SECRET>` → `{"ok":true,"candidates":0,"sent":0}`

### 4. Outlook macro (adds the pixel)

1. **File → Options → Trust Center → Trust Center Settings → Macro Settings** →
   *"Notifications for digitally signed macros"* (recommended) or *"Enable all macros"*.
2. **Alt+F11** → **Project1 (VbaProject.OTM) → Microsoft Outlook Objects →
   ThisOutlookSession** → paste `ThisOutlookSession.vba`.
3. Set `BASE` to your Vercel domain (no trailing slash) and `KEY` to `SHARED_SECRET`.
4. *(Recommended)* Sign it: run `SelfCert.exe` from your Office folder, then
   **Tools → Digital Signature → Choose** it.
5. **Ctrl+S**, close the editor, **restart Outlook**, allow the macro if prompted.
6. `TRACK_ALL = False` in the macro to only track messages you tag with the
   **"Track"** category before sending.

### 5. Send yourself a test

From another account, email your tracked mailbox, open it, and watch for the alert
plus a row on `/dashboard`.

---

## Cron frequency

`vercel.json` asks for hourly (`0 * * * *`). Vercel **Hobby runs cron ~once per
day** regardless — fine for a "not opened" nudge. **Pro** runs it hourly as
written. Either way you can hit `/api/cron?k=<SHARED_SECRET>` manually, and the
first-open / burst alerts are real-time (they fire from the pixel, not the cron).

## Tuning

Change any env var in Vercel → **Settings → Environment Variables**, then redeploy.

## What this cannot do (true of every pixel tracker, paid ones included)

- **Recipient blocks remote images** → the open is never recorded. Outlook blocks
  images by default until the user clicks "Download pictures".
- **Security gateways / image proxies** (Mimecast, Proofpoint, Gmail's proxy) fetch
  the pixel themselves → a *false* open, often seconds after you send. The function
  ignores hits inside `IGNORE_FIRST_SECONDS` and sends only **one** burst alert,
  but can't perfectly tell a scanner from a keen reader.
- **Gmail recipients**: Google caches the proxied pixel, so re-opens undercount.
  "Opened many times" is most reliable when the recipient is on Outlook/Apple Mail.
- **Plain-text emails** can't carry a pixel (the macro upgrades them to HTML).
- The recipient is **not told** they're tracked — same as every commercial tracker.
  Consider your local rules / company policy.

## Free-tier headroom

Vercel Hobby: 100 GB-hrs/mo of function time. Upstash free: 10k commands/day
(~a few Redis ops per open). Resend free: 100 emails/day, 3k/month. All far above
one person's send volume.
