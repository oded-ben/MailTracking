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

export const TTL = 60 * 60 * 24 * 45; // keep each record ~45 days

// 1x1 transparent GIF
export const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

export function cfg() {
  return {
    NOTIFY_TO: process.env.NOTIFY_TO,
    NOTIFY_FROM: process.env.NOTIFY_FROM || "Email Tracker <onboarding@resend.dev>",
    UNOPENED_HOURS: Number(process.env.UNOPENED_HOURS || 24),
    BURST_WINDOW_MIN: Number(process.env.BURST_WINDOW_MIN || 30),
    BURST_COUNT: Number(process.env.BURST_COUNT || 3),
    IGNORE_FIRST_SECONDS: Number(process.env.IGNORE_FIRST_SECONDS || 15),
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
export async function sendMail(subject, text, extraTo = []) {
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
      body: JSON.stringify({ from: c.NOTIFY_FROM, to, subject: `[MailTracking] ${subject}`, text }),
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
export async function runSweep() {
  const c = cfg();
  const now = Date.now();
  const cutoff = now - c.UNOPENED_HOURS * 3600000;

  const r = redis();
  const ids = await r.zrange("msgs", 0, cutoff, { byScore: true });
  const newlyUnopened = [];
  for (const id of ids) {
    const m = await r.get(`msg:${id}`);
    if (!m) {
      await r.zrem("msgs", id);
      continue;
    }
    if (!m.firstOpenAt && !m.notifiedUnopened && !m.snoozed) {
      m.notifiedUnopened = true;
      await r.set(`msg:${id}`, m, { ex: TTL });
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
  }
  // drop index entries older than the record TTL
  await r.zremrangebyscore("msgs", 0, now - TTL * 1000);

  if (!c.DIGEST_MODE) {
    return { candidates: ids.length, sent: newlyUnopened.length, digest: false };
  }

  const digestSent = await sendDigest(c, newlyUnopened);
  return { candidates: ids.length, sent: digestSent ? 1 : 0, digest: true };
}

async function sendDigest(c, newlyUnopened) {
  const r = redis();
  const raw = await r.lrange("digest:queue", 0, -1);
  await r.del("digest:queue");
  const events = raw
    .map((x) => (typeof x === "string" ? safeParse(x) : x))
    .filter(Boolean);

  if (events.length === 0 && newlyUnopened.length === 0) return false; // quiet day, nothing to send

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
  const r = redis();
  const key = `msg:${id}`;
  const m = await r.get(key);
  if (!m) return null;
  m.snoozed = !!snoozed;
  await r.set(key, m, { ex: TTL });
  return m;
}
