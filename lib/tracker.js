// Shared helpers for the MailTracking Vercel functions.
import { Redis } from "@upstash/redis";

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
    TZ: process.env.TZ || "UTC",
  };
}

export async function sendMail(subject, text) {
  const c = cfg();
  if (!process.env.RESEND_API_KEY || !c.NOTIFY_TO) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: c.NOTIFY_FROM, to: [c.NOTIFY_TO], subject, text }),
    });
  } catch {
    /* best effort — never throw from a notifier */
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

// "still not opened after N hours" sweep. Safe to run repeatedly.
export async function runSweep() {
  const c = cfg();
  const now = Date.now();
  const cutoff = now - c.UNOPENED_HOURS * 3600000;

  const r = redis();
  const ids = await r.zrange("msgs", 0, cutoff, { byScore: true });
  let sent = 0;
  for (const id of ids) {
    const m = await r.get(`msg:${id}`);
    if (!m) {
      await r.zrem("msgs", id);
      continue;
    }
    if (!m.firstOpenAt && !m.notifiedUnopened) {
      m.notifiedUnopened = true;
      await r.set(`msg:${id}`, m, { ex: TTL });
      await sendMail(
        `Not opened (${c.UNOPENED_HOURS}h): ${m.subject}`,
        `"${m.subject}"\nto: ${m.to}\n\n` +
          `Sent ${fmt(m.createdAt, c.TZ)} — still no open after ${c.UNOPENED_HOURS} h.\n` +
          `(If the recipient blocks remote images you may never see an open.)`
      );
      sent++;
    }
  }
  // drop index entries older than the record TTL
  await r.zremrangebyscore("msgs", 0, now - TTL * 1000);
  return { candidates: ids.length, sent };
}
