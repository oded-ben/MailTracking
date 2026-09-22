// POST /register  — called by the Outlook macro, the Gmail extension, or the
// Office Add-in on send. Header: X-Track-Key, either SHARED_SECRET (macro,
// extension - kept reasonably private) or ADDIN_KEY (the Office Add-in's
// commands.js is served publicly, so its key is deliberately low-privilege:
// leaking it only allows creating junk register entries, nothing else).
import { redis, TTL, safeEqual, securityHeaders } from "../lib/tracker.js";

// Truncate (never reject) so an oversized payload can't bloat storage, while
// a legitimately long subject/recipient list still gets through unharmed.
const cap = (s, n) => String(s ?? "").slice(0, n);

// Outlook can fire ItemSend more than once for the same message - confirmed
// live even with a client-side guard tagging the message object, meaning
// Outlook isn't reusing the same object on the retry (that assumption was
// wrong). This catches it independent of whatever Outlook does internally:
// two registrations with identical subject/to/account within a few seconds
// are treated as one message, not two. Small window on purpose - long enough
// to catch a same-second retry, short enough not to merge two genuinely
// different sends that happen to share a subject and recipient.
const DEDUP_WINDOW_MS = 5000;

// Confirmed live: two firings of the same send produced recipient strings
// that differed only by a trailing "; " (Outlook's Recipients collection
// apparently isn't always in the exact same state/order between the two
// firings), which made an exact-string comparison miss the match entirely.
// Normalize before comparing so formatting noise like that can't defeat it.
const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[;,\s]+$/, "");

async function findRecentDuplicate(r, subject, to, account) {
  const now = Date.now();
  const ids = await r.zrange("msgs", now - DEDUP_WINDOW_MS, now, { byScore: true });
  const nSubject = norm(subject);
  const nTo = norm(to);
  const nAccount = norm(account);
  for (let i = ids.length - 1; i >= 0; i--) {
    const m = await r.get(`msg:${ids[i]}`);
    if (m && norm(m.subject) === nSubject && norm(m.to) === nTo && norm(m.account) === nAccount) return m;
  }
  return null;
}

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = req.headers["x-track-key"] || "";
  const valid =
    safeEqual(key, process.env.SHARED_SECRET || "") || safeEqual(key, process.env.ADDIN_KEY || "");
  if (!valid) {
    console.warn("[register] rejected: invalid X-Track-Key", { ip: req.headers["x-forwarded-for"] });
    return res.status(403).json({ error: "forbidden" });
  }

  let b = req.body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      b = null;
    }
  }
  if (!b || !b.id || typeof b.id !== "string") return res.status(400).json({ error: "missing id" });

  const rec = {
    id: cap(b.id, 200),
    subject: cap(b.subject, 500) || "(no subject)",
    to: cap(b.to, 2000),
    account: cap(b.account, 320),
    createdAt: Date.now(),
    firstOpenAt: 0,
    opens: [],
    notifiedFirst: false,
    notifiedUnopened: false,
    notifiedBurst: false,
  };

  const r = redis();
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["host"];

  const dup = await findRecentDuplicate(r, rec.subject, rec.to, rec.account);
  if (dup) {
    // Don't create a second entry - hand back the *existing* message's pixel
    // URL so whichever copy of the email actually goes out still carries a
    // pixel that resolves to the one tracked row, instead of an orphaned id
    // nothing will ever match.
    return res
      .status(200)
      .json({ ok: true, duplicate: true, pixel: `${proto}://${host}/o/${encodeURIComponent(dup.id)}.gif` });
  }

  await r.set(`msg:${rec.id}`, rec, { ex: TTL });
  await r.zadd("msgs", { score: rec.createdAt, member: rec.id });

  res
    .status(200)
    .json({ ok: true, pixel: `${proto}://${host}/o/${encodeURIComponent(rec.id)}.gif` });
}
