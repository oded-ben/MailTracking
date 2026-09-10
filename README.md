# email-tracker

A tiny self-hosted email open tracker for **Outlook Classic (Windows)**.

You get an email when:
- a tracked message is **opened for the first time** (with how long after sending),
- a message is **still not opened** after N hours (default 24),
- a message is **opened many times in a short window** (default: 3+ opens in 30 min).

No subscription. Runs on free tiers forever.

## How it works

1. An Outlook VBA macro runs on every send: it generates a unique ID, tells the
   Worker about the message (subject + recipients), and drops a 1x1 invisible
   image into the HTML body pointing at `.../o/<id>.gif`.
2. When the recipient's mail client loads that image, the Cloudflare Worker logs
   the hit and emails you via Resend.
3. An hourly cron in the Worker checks for messages that were never opened.

```
Outlook (macro)  ──register──▶  Cloudflare Worker  ──▶  Resend  ──▶  your inbox
      │                              ▲
      └── pixel in email ───────────┘  (recipient opens → image loads → hit logged)
```

---

## Setup (~15 min, one time)

### 1. Resend (sends the alert emails)

1. Sign up at <https://resend.com> **using the address you want alerts delivered to**
   (this is your `NOTIFY_TO`). On the free plan the built-in `onboarding@resend.dev`
   sender can only email your own account address — that's fine for self-alerts.
   To send alerts somewhere else, verify a domain later and change `NOTIFY_FROM`.
2. **API Keys → Create API Key**. Copy it.

### 2. Cloudflare Worker (logs opens)

Install the CLI once: `npm install -g wrangler` (needs Node.js).

```bash
cd email-tracker
wrangler login
wrangler kv namespace create TRACK
```

- Paste the printed namespace `id` into `wrangler.toml` (replace `PASTE_KV_NAMESPACE_ID_HERE`).
- Edit `wrangler.toml`: set `NOTIFY_TO` and `TZ`. Tune the thresholds if you want.

```bash
wrangler secret put SHARED_SECRET      # type any long random string, keep a copy
wrangler secret put RESEND_API_KEY     # paste the Resend key
wrangler deploy
```

Note the deployed URL, e.g. `https://email-tracker.yourname.workers.dev`.

Quick check:
- open `https://email-tracker.yourname.workers.dev/o/test.gif` → blank page (a pixel)
- open `https://email-tracker.yourname.workers.dev/dashboard?k=YOUR_SHARED_SECRET` → empty table

> No Node? Use the Cloudflare dashboard instead: **Workers & Pages → Create → paste
> `worker.js`**. Then in the Worker's **Settings**: add the KV binding named `TRACK`,
> add the `[vars]` from `wrangler.toml`, add `SHARED_SECRET` + `RESEND_API_KEY` as
> encrypted vars, and add a **Cron Trigger** `0 * * * *`.

### 3. Outlook macro (adds the pixel)

1. **File → Options → Trust Center → Trust Center Settings → Macro Settings** →
   choose *"Notifications for digitally signed macros"* (recommended) or, quick and
   dirty, *"Enable all macros"*.
2. Press **Alt+F11**. In the tree open **Project1 (VbaProject.OTM) → Microsoft Outlook
   Objects → ThisOutlookSession**. Paste the contents of `ThisOutlookSession.vba`.
3. Set `BASE` to your Worker URL (no trailing slash) and `KEY` to the same
   `SHARED_SECRET`.
4. *(Recommended)* Sign it so it survives restarts without lowering security:
   run `SelfCert.exe` from your Office folder
   (`C:\Program Files\Microsoft Office\root\OfficeXX\SelfCert.exe`), create a
   certificate, then in the VBA editor **Tools → Digital Signature → Choose** it.
5. **Ctrl+S**, close the editor, **restart Outlook**, and allow the macro if prompted.
6. Send yourself a test message from another account, open it, and watch for the
   alert + the `/dashboard` row.

**Opt-in mode:** set `TRACK_ALL = False` in the macro to only track messages you've
assigned the **"Track"** category before sending.

---

## Tuning (`wrangler.toml` vars, then `wrangler deploy`)

| var | meaning | default |
|---|---|---|
| `UNOPENED_HOURS` | "still not opened" alert threshold | 24 |
| `BURST_WINDOW_MIN` / `BURST_COUNT` | opens within X min to count as a burst | 30 / 3 |
| `IGNORE_FIRST_SECONDS` | hits sooner than this = scanner pre-fetch, ignored | 15 |
| `NOTIFY_EVERY_OPEN` | `"1"` = email on every re-open (noisy) | `"0"` |
| cron in `[triggers]` | how often the "not opened" check runs | hourly |

---

## What this cannot do (true of every pixel tracker, paid ones included)

- **Recipient blocks remote images** → the open is never recorded. Outlook and many
  clients block images by default until the user clicks "Download pictures".
- **Security gateways / image proxies** (Mimecast, Proofpoint, Gmail's image proxy)
  fetch the pixel themselves → a *false* open, often seconds after you send, and
  sometimes repeatedly. The Worker ignores hits in the first `IGNORE_FIRST_SECONDS`
  and only sends **one** burst alert, but it can't perfectly tell a scanner from a
  keen reader.
- **Gmail recipients**: Google caches the proxied pixel, so re-opens undercount. The
  "opened many times" signal is most reliable when the recipient is on Outlook or
  Apple Mail.
- **Plain-text emails** can't carry a pixel (the macro upgrades them to HTML).
- The recipient is **not told** they're being tracked — same as every commercial
  tracker. Consider your local rules / company policy.

## Free-tier headroom

Cloudflare Workers: 100k requests/day. Workers KV: 1k writes/day (1 write per open).
Resend: 100 emails/day, 3k/month. All far above one person's send volume.
