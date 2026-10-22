// Shared helpers for the MailTracking Vercel functions.
import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

// Constant-time string comparison for secrets (SHARED_SECRET, ADDIN_KEY,
// CRON_SECRET). A plain `===` short-circuits on the first mismatched byte,
// which is a textbook timing side-channel - impractical to exploit over the
// internet given normal network jitter, but the fix is free, so do it right.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Baseline security headers for every response. Endpoints that render
// user-influenced data (dashboard, export) also pass noStore to prevent any
// shared/proxy caching of a response reachable via a secret in the URL.
export function securityHeaders(res, { noStore = false } = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  if (noStore) res.setHeader("Cache-Control", "private, no-store, must-revalidate");
}

// --- Dashboard login session -----------------------------------------------
// Replaces the old ?k=SHARED_SECRET-in-the-URL pattern for /dashboard and
// /api/export. A real login (POST the password once) sets a signed, expiring
// cookie instead - nothing secret ever sits in a URL, browser history, or a
// screenshot again. Stateless on purpose: no session store, no new secret to
// manage - the token is just an expiry timestamp HMAC-signed with the
// SHARED_SECRET you already have, verified with the same safeEqual() used
// everywhere else.
const SESSION_COOKIE = "mt_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days - a personal tool, not a bank

function hmac(payload) {
  return crypto.createHmac("sha256", process.env.SHARED_SECRET || "").update(payload).digest("hex");
}

export function createSessionToken() {
  const payload = String(Date.now() + SESSION_TTL_MS);
  return Buffer.from(`${payload}.${hmac(payload)}`).toString("base64url");
}

export function verifySessionToken(token) {
  if (typeof token !== "string" || !token) return false;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const dot = decoded.lastIndexOf(".");
    if (dot === -1) return false;
    const payload = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);
    if (!safeEqual(sig, hmac(payload))) return false;
    const exp = Number(payload);
    return Number.isFinite(exp) && Date.now() < exp;
  } catch {
    return false;
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i === -1) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  });
  return out;
}

export function hasValidSession(req) {
  return verifySessionToken(parseCookies(req)[SESSION_COOKIE]);
}

export function sessionCookieHeader(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// Works with either the Vercel "KV" (Upstash) integration or a plain Upstash store.
// Lazy so a deploy without the store wired yet fails loudly only when used,
// not at import time (the pixel endpoint still returns an image).
let _redis;
export function redis() {
  if (!_redis) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error("Upstash Redis env vars are not set");
    _redis = new Redis({ url, token });
  }
  return _redis;
}

// How long each record is kept (RETENTION_DAYS, default 180). Follow-ups to
// investors etc. run for months, so the old 45 days dropped rows too early.
export const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS || 180));
export const TTL = 60 * 60 * 24 * RETENTION_DAYS;

// 1x1 transparent GIF
export const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

// Which tracker produced a message, judged from its id: the add-in and the
// Gmail extension prefix theirs; the VBA macro uses a timestamp-style id.
export const SOURCES = ["macro", "addin", "gmail"];
export function sourceOf(id) {
  const s = String(id || "");
  if (s.startsWith("addin-")) return "addin";
  if (s.startsWith("gmail-")) return "gmail";
  return "macro";
}

// Best-effort guess at WHO fetched the pixel, from the User-Agent alone (no IP
// is ever stored). `bot` hits are never counted as opens or alerted on;
// `unreliable` ones count but are flagged in the dashboard and alert text.
//   scanner  - security gateways, crawlers, scripts: not a human
//   gmail    - Google's image proxy: fetches when the mail is actually viewed
//   apple    - Apple Mail / Mail Privacy Protection: may be a prefetch, not a read
//   outlook  - Microsoft clients
//   browser  - ordinary web browser (webmail, or a person loading the URL)
export function classifyUA(ua) {
  const s = String(ua || "").slice(0, 300);
  if (!s.trim()) return { kind: "scanner", label: "no user-agent", bot: true };
  if (/GoogleImageProxy/i.test(s)) return { kind: "gmail", label: "Gmail", bot: false };
  if (
    /mimecast|proofpoint|barracuda|symantec|messagelabs|forcepoint|ironport|trend ?micro|sophos|fireeye|trustwave|zscaler|safelinks|defender|bot\b|crawl|spider|scan|headless|python-requests|python-urllib|curl\/|wget|go-http-client|libwww|java\/|axios|node-fetch|postman/i.test(
      s
    )
  )
    return { kind: "scanner", label: "security scanner / bot", bot: true };
  if (/YahooMailProxy|Yahoo/i.test(s)) return { kind: "browser", label: "Yahoo Mail", bot: false };
  if (/Microsoft Office|Outlook|ms-office/i.test(s)) return { kind: "outlook", label: "Outlook", bot: false };
  // WebKit without a "Safari/" or other browser token = an embedded mail view:
  // Apple Mail, which is also what Mail Privacy Protection prefetches look like.
  if (/AppleWebKit/i.test(s) && !/Safari\/|Chrome|CriOS|FxiOS|Firefox|Edg/i.test(s))
    return { kind: "apple", label: "Apple Mail (maybe prefetch)", bot: false, unreliable: true };
  if (/Chrome|Firefox|Safari|Edg/i.test(s)) return { kind: "browser", label: "browser / webmail", bot: false };
  return { kind: "other", label: "unknown client", bot: false };
}

export function cfg() {
  return {
    NOTIFY_TO: process.env.NOTIFY_TO,
    NOTIFY_FROM: process.env.NOTIFY_FROM || "Email Tracker <onboarding@resend.dev>",
    UNOPENED_HOURS: Number(process.env.UNOPENED_HOURS || 24),
    BURST_WINDOW_MIN: Number(process.env.BURST_WINDOW_MIN || 30),
    BURST_COUNT: Number(process.env.BURST_COUNT || 3),
    IGNORE_FIRST_SECONDS: Number(process.env.IGNORE_FIRST_SECONDS || 15),
    STALE_DAYS: Number(process.env.STALE_DAYS || 7),
    NOTIFY_EVERY_OPEN: String(process.env.NOTIFY_EVERY_OPEN || "0") === "1",
    DIGEST_MODE: String(process.env.DIGEST_MODE || "0") === "1",
    NOTIFY_SENDER_TOO: String(process.env.NOTIFY_SENDER_TOO || "0") === "1",
    TZ: process.env.TRACKER_TZ || process.env.TZ || "UTC",
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(s) {
  return typeof s === "string" && EMAIL_RE.test(s.trim());
}

// extraTo: additional recipients to cc, e.g. the sending account's own address.
// Only actually used when NOTIFY_SENDER_TOO is on, and only entries that look
// like real email addresses (the "account" field can also be a display name,
// an Exchange DN, or the literal string "Gmail" when detection fails).
//
// Note: Resend's free onboarding sender (onboarding@resend.dev) can only
// deliver to the one address your Resend account was signed up with. Extra
// recipients that aren't that address - or a verified domain's recipients -
// will be silently dropped by Resend, not by this code. Verify a domain in
// Resend to actually reach a second address.
export async function sendMail(subject, text, extraTo = [], attachments = []) {
  const c = cfg();
  if (!process.env.RESEND_API_KEY || !c.NOTIFY_TO) return;
  const to = [c.NOTIFY_TO];
  if (c.NOTIFY_SENDER_TOO) {
    for (const addr of extraTo) {
      const a = typeof addr === "string" ? addr.trim() : "";
      if (isEmail(a) && !to.includes(a)) to.push(a);
    }
  }
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: c.NOTIFY_FROM,
        to,
        subject: `[MailTracking] ${subject}`,
        text,
        ...(attachments.length ? { attachments } : {}),
      }),
    });
  } catch {
    /* best effort — never throw from a notifier */
  }
}

// Common "subject / to / from account" block used at the top of every alert email.
export function header(m) {
  return `"${m.subject}"\nto: ${m.to}\nfrom: ${m.account || "(default account)"}\n\n`;
}

// In DIGEST_MODE, individual open/burst alerts are queued here instead of
// emailed immediately - the daily sweep drains the queue into one email.
export async function queueDigestEvent(subject, text) {
  try {
    await redis().rpush("digest:queue", { subject, text, at: Date.now() });
  } catch {
    /* best effort */
  }
}

// Single entry point every caller uses to notify: respects DIGEST_MODE so
// callers (the pixel handler) don't need to know which mode is active.
// extraTo (e.g. the sending account) is only honored in instant mode - a
// combined daily digest can span several different senders, so cc'ing each
// contributing account on the whole thing would leak their sends to each
// other; NOTIFY_SENDER_TOO is scoped to per-event alerts only.
export async function notify(subject, text, extraTo = []) {
  if (cfg().DIGEST_MODE) {
    await queueDigestEvent(subject, text);
  } else {
    await sendMail(subject, text, extraTo);
  }
}

export function fmt(ts, tz) {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString("en-GB", { timeZone: tz }) + " " + tz;
  } catch {
    return new Date(ts).toISOString();
  }
}

// "still not opened after N hours" sweep, plus (in DIGEST_MODE) draining the
// queued open/burst events into one daily email. Safe to run repeatedly.
// Extra "still not opened" reminders for messages starred as Important.
const FOLLOWUP_DAYS = [3, 7];

export async function runSweep() {
  const c = cfg();
  const now = Date.now();
  const cutoff = now - c.UNOPENED_HOURS * 3600000;

  const r = redis();
  // Only look at messages that crossed the "unopened" line recently. The cron
  // runs daily, so a look-back a little over the longest follow-up (7 days)
  // tolerates missed runs while keeping the sweep's cost flat now that
  // records live for months.
  const SWEEP_LOOKBACK_MS = 9 * 86400000;
  const ids = await r.zrange("msgs", cutoff - SWEEP_LOOKBACK_MS, cutoff, { byScore: true });
  const records = ids.length ? await r.mget(...ids.map((id) => `msg:${id}`)) : [];
  const newlyUnopened = [];
  const followups = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const m = records[i];
    if (!m) {
      await r.zrem("msgs", id);
      continue;
    }
    if (m.firstOpenAt || m.snoozed) continue;

    let dirty = false;
    if (!m.notifiedUnopened) {
      m.notifiedUnopened = true;
      dirty = true;
      newlyUnopened.push(m);
      if (!c.DIGEST_MODE) {
        await sendMail(
          `Not opened (${c.UNOPENED_HOURS}h): ${m.subject}`,
          header(m) +
            `Sent ${fmt(m.createdAt, c.TZ)} — still no open after ${c.UNOPENED_HOURS} h.\n` +
            `(If the recipient blocks remote images you may never see an open.)`,
          [m.account]
        );
      }
    }

    if (m.important) {
      const age = now - m.createdAt;
      const sent = m.followups || [];
      const due = FOLLOWUP_DAYS.filter((d) => age >= d * 86400000 && !sent.includes(d));
      if (due.length) {
        // One reminder per run, for the latest due step - a cron that was
        // skipped for days shouldn't fire the 3-day AND the 7-day nudge at once.
        const days = due[due.length - 1];
        m.followups = [...sent, ...due];
        dirty = true;
        followups.push({ m, days });
        if (!c.DIGEST_MODE) {
          await sendMail(
            `Still not opened (${days} days): ${m.subject}`,
            header(m) +
              `Sent ${fmt(m.createdAt, c.TZ)} — marked Important and still no open after ${days} days.\n` +
              `Might be time for a follow-up.`,
            [m.account]
          );
        }
      }
    }
    if (dirty) await r.set(`msg:${id}`, m, { ex: TTL });
  }
  // drop index entries older than the record TTL
  await r.zremrangebyscore("msgs", 0, now - TTL * 1000);

  if (!c.DIGEST_MODE) {
    return { candidates: ids.length, sent: newlyUnopened.length, followups: followups.length, digest: false };
  }

  const digestSent = await sendDigest(c, newlyUnopened, followups);
  return { candidates: ids.length, sent: digestSent ? 1 : 0, followups: followups.length, digest: true };
}

async function sendDigest(c, newlyUnopened, followups = []) {
  const r = redis();
  const raw = await r.lrange("digest:queue", 0, -1);
  await r.del("digest:queue");
  const events = raw
    .map((x) => (typeof x === "string" ? safeParse(x) : x))
    .filter(Boolean);

  if (events.length === 0 && newlyUnopened.length === 0 && followups.length === 0) return false; // quiet day, nothing to send

  let body = `MailTracking daily digest — ${fmt(Date.now(), c.TZ)}\n\n`;
  if (events.length) {
    body += `--- Opens (${events.length}) ---\n\n` + events.map((e) => e.text).join("\n\n") + "\n\n";
  }
  if (newlyUnopened.length) {
    body +=
      `--- Still not opened after ${c.UNOPENED_HOURS}h (${newlyUnopened.length}) ---\n\n` +
      newlyUnopened.map((m) => `"${m.subject}"  to: ${m.to}`).join("\n") +
      "\n";
  }
  if (followups.length) {
    body +=
      `\n--- Important, still not opened (${followups.length}) ---\n\n` +
      followups.map((f) => `"${f.m.subject}"  to: ${f.m.to}  (${f.days} days)`).join("\n") +
      "\n";
  }
  await sendMail(
    `MailTracking digest: ${events.length} opened, ${newlyUnopened.length} still unopened`,
    body
  );
  return true;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Mark (or unmark) a message so the "not opened" nudge stops firing for it -
// used by the dashboard's per-row snooze button.
export async function setSnoozed(id, snoozed) {
  return setFlag(id, "snoozed", snoozed);
}

// Set a boolean flag on a message ("snoozed" or "important"). Whitelisted so a
// request body can never write arbitrary fields onto a record.
export async function setFlag(id, name, value) {
  if (name !== "snoozed" && name !== "important") return null;
  const r = redis();
  const key = `msg:${id}`;
  const m = await r.get(key);
  if (!m) return null;
  m[name] = !!value;
  await r.set(key, m, { ex: TTL });
  return m;
}

// Every stored message, newest first (batched reads, 500 keys per call).
export async function loadAllRows() {
  const r = redis();
  const ids = await r.zrange("msgs", 0, -1, { rev: true });
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...(await r.mget(...chunk.map((id) => `msg:${id}`))).filter(Boolean));
  }
  return rows;
}

// subject/account/to all originate from /register, which anyone holding
// ADDIN_KEY can call. Excel/Sheets treats a field starting with =, +, -, @,
// tab, or CR as a formula when the CSV is opened (CSV/formula injection,
// OWASP-documented) - a crafted subject like `=HYPERLINK(...)` would execute
// as a formula for whoever opens the export. Prefixing with a single quote
// is the standard mitigation: spreadsheet apps then treat it as literal text.
function csvField(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(rows, tz) {
  const lines = [["Sent", "Subject", "From", "To", "OpenCount", "FirstOpen", "Snoozed", "Important", "Status"].join(",")];
  for (const m of rows) {
    const human = (m.opens || []).filter((o) => !o.bot);
    const status = human.length ? "opened" : (m.opens || []).length ? "scanner-only" : "not opened";
    lines.push(
      [
        csvField(fmt(m.createdAt, tz)),
        csvField(m.subject),
        csvField(m.account || ""),
        csvField(m.to),
        human.length,
        m.firstOpenAt ? csvField(fmt(m.firstOpenAt, tz)) : "",
        m.snoozed ? "yes" : "no",
        m.important ? "yes" : "no",
        status,
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

// Weekly safety copy of the whole table, emailed as a CSV attachment. Runs
// from the daily cron on Sundays (in TRACKER_TZ); `force` skips the weekday and
// once-a-week guard for manual runs.
export async function maybeSendBackup(force = false) {
  const c = cfg();
  if (!force) {
    let day = "";
    try {
      day = new Date().toLocaleDateString("en-US", { weekday: "short", timeZone: c.TZ });
    } catch {
      day = "";
    }
    if (day !== "Sun") return { backup: "skipped (not Sunday)" };
    // Guard against a manual run + the scheduled run on the same Sunday.
    const first = await redis().set("backup:sent", Date.now(), { nx: true, ex: 5 * 86400 });
    if (!first) return { backup: "skipped (already sent this week)" };
  }
  if (!process.env.RESEND_API_KEY || !c.NOTIFY_TO) return { backup: "skipped (email not configured)" };
  const rows = await loadAllRows();
  const stamp = new Date().toISOString().slice(0, 10);
  await sendMail(
    `Weekly backup (${rows.length} emails)`,
    `Attached: every tracked email currently stored (${rows.length}), as of ${fmt(Date.now(), c.TZ)}.\n` +
      `Records are kept ${RETENTION_DAYS} days; this is your safety copy.`,
    [],
    [{ filename: `mailtracking-${stamp}.csv`, content: Buffer.from(buildCsv(rows, c.TZ), "utf8").toString("base64") }]
  );
  return { backup: `sent (${rows.length} rows)` };
}

// Permanently remove messages (records + index entries). Used by the
// dashboard's bulk Delete; a pixel hit for a deleted id is simply ignored
// afterwards. Returns how many records actually existed.
export async function deleteMessages(ids) {
  if (!ids.length) return 0;
  const r = redis();
  const removed = await r.del(...ids.map((id) => `msg:${id}`));
  await r.zrem("msgs", ...ids);
  return removed;
}
