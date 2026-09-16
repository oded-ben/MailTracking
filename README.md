# MailTracking

A tiny self-hosted email open tracker for **Outlook Classic (Windows)**, with an
optional Chrome extension that covers **Gmail's web UI** too — both report to the
same backend and dashboard.

You get an email when:

- a tracked message is **opened for the first time** (with how long after sending),
- a message is **still not opened** after N hours (default 24),
- a message is **opened many times in a short window** (default: 3+ opens in 30 min).

No subscription. Runs on Vercel + Upstash + Resend free tiers.

> **Outlook Classic only — not "New Outlook."** Microsoft's modern
> WebView2-based "New Outlook for Windows" has no VBA support at all; the
> macro simply won't exist there (Alt+F11 does nothing) and tracking silently
> stops with no error if you get switched over. Check the "Try the new
> Outlook" toggle in the top-right of the Outlook window — if it's on, switch
> back to Classic ("Go back to the classic Outlook") for this to work. See
> [New Outlook compatibility](#new-outlook-compatibility-evaluation) below for
> what supporting it for real would take.

## How it works

1. An Outlook VBA macro (or the Gmail extension) runs on every send: it generates
   a unique ID, POSTs the subject + recipients + sending account to `/register`,
   and drops a 1x1 invisible image into the HTML body pointing at `/o/<id>.gif`.
2. When the recipient's mail client loads that image, the Vercel function logs the
   hit to Upstash Redis and emails you via Resend.
3. A Vercel cron calls `/api/cron` to nag about messages that were never opened
   (or, in digest mode, to send one daily summary — see below).

```
Outlook/Gmail ──register──▶ Vercel /register ──▶ Upstash Redis
      │                                             ▲
      └── pixel in email ──▶ Vercel /o/<id>.gif ────┘──▶ Resend ──▶ your inbox
```

## Project layout

```
api/pixel.js       GET  /o/<id>.gif   log open + alerts, return the pixel
api/register.js    POST /register     called by the Outlook macro / Gmail extension
api/dashboard.js   GET  /dashboard    searchable/sortable table, snooze, CSV export
api/snooze.js      POST /api/snooze   stop the "not opened" nudge for one message
api/export.js      GET  /api/export   every tracked message as a CSV download
api/cron.js        GET  /api/cron     "not opened" sweep / digest send (Vercel cron)
lib/tracker.js     shared: Redis client, config, Resend sender, sweep, digest
vercel.json        routes (/o, /register, /dashboard) + cron schedule
ThisOutlookSession.vba   the Outlook Classic macro
alt/cloudflare/       the same tool as a single Cloudflare Worker (not needed for Vercel)
alt/gmail-extension/  Chrome extension covering Gmail's web UI — see its own README
```

**Gmail:** if your Gmail account is added *inside* Outlook Classic, it's already
tracked — the macro doesn't care which account sends the mail. If you compose
directly at mail.google.com, install `alt/gmail-extension/` (unpacked, a couple
of minutes) — details in that folder's README.

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
   | `SHARED_SECRET` | long random string (also goes in the Outlook macro / Gmail extension) | yes |
   | `RESEND_API_KEY` | from step 1 | yes |
   | `NOTIFY_TO` | where alerts are sent | yes |
   | `CRON_SECRET` | long random string (Vercel sends it to `/api/cron`) | recommended |
   | `NOTIFY_FROM` | `Email Tracker <onboarding@resend.dev>` | no |
   | `TRACKER_TZ` | e.g. `Asia/Jerusalem` (default `UTC`; `TZ` is reserved on Vercel) | no |
   | `UNOPENED_HOURS` | default `24` | no |
   | `BURST_WINDOW_MIN` / `BURST_COUNT` | default `30` / `3` | no |
   | `IGNORE_FIRST_SECONDS` | default `15` | no |
   | `NOTIFY_EVERY_OPEN` | `1` = email on every re-open (noisy) | no |
   | `DIGEST_MODE` | `1` = one daily summary email instead of instant alerts (default `0`) | no |
   | `NOTIFY_SENDER_TOO` | `1` = also cc the sending account on instant alerts (default `0`) | no |

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

`vercel.json` runs the sweep once a day (`0 9 * * *`). **Vercel Hobby rejects the
entire deploy** if a cron is scheduled more than once/day — this isn't a soft
throttle, the build fails outright. Upgrade to Pro to run it hourly instead. Either
way you can hit `/api/cron?k=<SHARED_SECRET>` manually any time, and the
first-open / burst alerts are real-time regardless (they fire from the pixel, not
the cron) — only the "not opened" nudge (and digest sending) is affected by the
schedule.

## Tuning

Change any env var in Vercel → **Settings → Environment Variables**, then redeploy.

## Digest mode

By default every first-open, burst, and not-opened event emails you the moment it
happens. Set `DIGEST_MODE=1` to switch to **one email a day** instead, sent from
the same daily cron: a single message listing everything that opened since the
last digest plus anything newly crossing the not-opened threshold. Quiet days
(nothing to report) send nothing. Switching modes takes effect immediately — it
only changes how already-detected events get delivered, not detection itself.

## Notifying the sender's own address

By default every alert goes to the single `NOTIFY_TO` address, regardless of
which of your accounts (Outlook or Gmail) sent the tracked email. Set
`NOTIFY_SENDER_TOO=1` to also cc the *sending* account on instant alerts (not
digest mode) whenever that account looks like a real email address.

**Read this before enabling it:** Resend's free `onboarding@resend.dev` sender
can only deliver to the one address your Resend account was signed up with.
If your Outlook and Gmail accounts use different addresses, alerts to whichever
one *isn't* your Resend signup address will be silently dropped by Resend, not
by this code — `NOTIFY_TO` will still get every alert either way, so nothing is
lost, but the second address won't reliably receive anything until you verify a
real sending domain in Resend (removes the one-recipient restriction entirely).

## Dashboard: search, sort, snooze, export

`/dashboard?k=<SHARED_SECRET>` has:
- a **summary line** — tracked / opened / not opened / snoozed counts, at a glance,
- a **search box** that filters rows by subject/account/recipient/status as you type,
- **sortable columns** (click any header, click again to reverse),
- a **Snooze** button per row that permanently stops the "not opened" nudge for
  that one message — use it for cold outreach you don't expect a reply to, so it
  stops nagging you without lying about whether it was actually opened. Doesn't
  affect first-open/burst alerts, which still fire normally if it is opened later.
  Click **Un-snooze** to undo.
- an **Export CSV** link (`/api/export?k=<SHARED_SECRET>`) that downloads every
  tracked message as a CSV: sent time, subject, from, to, open count, first-open
  time, snoozed, status.
- the table **scrolls horizontally** on narrow screens instead of breaking layout.

## Alert email details

- Every alert subject gets a consistent **`[MailTracking] `** prefix (including
  digests), so it's a one-line filter/label rule in your inbox.
- **Bcc recipients are never logged.** Both the Outlook macro and the Gmail
  extension exclude Bcc addresses when building the recipient list that gets
  stored and shown — the whole point of Bcc is that recipients don't see each
  other, so it shouldn't end up sitting in a log column either. (One narrow
  exception: the Gmail extension's fallback recipient-detection path, used only
  when Gmail hasn't synced its hidden form fields yet, can't reliably isolate
  Bcc chips and may include them in that specific fallback case.)

## New Outlook compatibility evaluation

Status: **evaluated, not built.** Notes below for whenever it's worth doing.

**Why VBA doesn't work there:** New Outlook is a WebView2 wrapper around the
same web app that runs Outlook on the web (OWA) — a different architecture
from Classic, with no VBA project, no COM add-ins, and none of the classic
Object Model events `Application_ItemSend` relies on. Microsoft has been clear
this isn't coming back for New Outlook; it's not a gap that gets closed later.

**The one supported path in: Office Add-ins with the `OnMessageSend` event.**
Microsoft's modern add-in platform ("Smart Alerts" / event-based activation)
lets an add-in register a JS handler that runs when the user hits Send, before
the message goes out — the same job `Application_ItemSend` does, just through
a completely different framework (`Office.js`, the Outlook Mailbox API,
async/Promise-based instead of VBA's synchronous calls). It can read/modify
the subject, body, and recipients, then call `event.completed({allowEvent:
true})` to let the send proceed. In principle this is a real replacement for
the macro, built once for this new framework.

**What building it would actually take:**
- An Office Add-in manifest (XML or the newer unified JSON format) declaring
  the `OnMessageSend` launch event, plus a small JS file implementing the
  handler — a new artifact, not a tweak to the existing macro.
- Somewhere to host that manifest + JS. Vercel already serves this project's
  backend over HTTPS, so it could live right alongside it (e.g. `/addin/...`)
  with no new infrastructure.
- **Sideloading**, i.e. installing it for your mailbox: via OWA → Settings →
  General → **Manage add-ins** → **My add-ins** → **Add a custom add-in**.
  One real bonus here — this same add-in would then also cover **Outlook on
  the web and Outlook Mobile**, not just New Outlook desktop, since they all
  share this add-in platform. That's more coverage than the current
  Classic-only macro for the same build effort.

**The open question that gates all of this:** Office Add-ins require an
Exchange-backed mailbox — Exchange Online / Microsoft 365, or a personal
Outlook.com account. They do **not** work on a plain IMAP/POP account added
to Outlook. If `oded@humalign.ai` is hosted on Microsoft 365/Exchange, this is
viable. If it's actually added to Outlook as generic IMAP (e.g. a domain
running on Google Workspace or another provider, connected via IMAP/SMTP
rather than true Exchange), Office Add-ins won't load for it at all, and this
path is closed regardless of how much of it gets built. **Worth confirming
the account type before investing further.**

**Known risk, not just theoretical:** `OnMessageSend` handlers have
documented, reported quirks around async operations (network calls, body
edits) reliably completing before Outlook proceeds with the send. Expect a
real debugging cycle here — likely comparable to the Gmail extension's DOM/
selector iteration this session, just in the async-timing domain instead.

**Rough scope:** comparable to (or larger than) the Gmail extension build —
a new manifest, a new runtime environment, a new class of bugs to work
through. The upside is it reuses the existing `/register` and `/o/<id>.gif`
endpoints unchanged; only the "how the pixel gets in and how send gets
hooked" layer is new.

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
- **Multi-recipient sends are tracked in aggregate, not per-recipient** — with
  one shared pixel per email, "opened" means *someone* on the recipient list
  opened it, not which one. True per-recipient attribution would require
  splitting the message into individual sends, which this project deliberately
  doesn't do.
- The recipient is **not told** they're tracked — same as every commercial tracker.
  Consider your local rules / company policy.

## Free-tier headroom

Vercel Hobby: 100 GB-hrs/mo of function time. Upstash free: 10k commands/day
(~a few Redis ops per open). Resend free: 100 emails/day, 3k/month. All far above
one person's send volume.
