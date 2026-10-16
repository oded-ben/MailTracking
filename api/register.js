// POST /register  — called by the Outlook macro, the Gmail extension, or the
// Office Add-in on send. Header: X-Track-Key, either SHARED_SECRET (macro,
// extension - kept reasonably private) or ADDIN_KEY (the Office Add-in's
// commands.js is served publicly, so its key is deliberately low-privilege:
// leaking it only allows creating junk register entries, nothing else).
import crypto from "node:crypto";
import { redis, TTL, safeEqual, securityHeaders, sourceOf } from "../lib/tracker.js";

// Truncate (never reject) so an oversized payload can't bloat storage, while
// a legitimately long subject/recipient list still gets through unharmed.
const cap = (s, n) => String(s ?? "").slice(0, n);

// The same send gets registered more than once, within about a second:
// the admin-deployed Office Add-in also runs inside Classic Outlook (its
// script-only runtime), so every Classic send is tracked by BOTH the VBA
// macro and the add-in. Confirmed from the dashboard: each duplicate pair is
// one 2026...-style (macro) id plus one addin-... id. Treat registrations for
// the same subject and the same recipient addresses within a short window as
// one message. Small window on purpose - long enough to catch the pair, short
// enough not to merge two genuinely separate sends of the same subject.
const DEDUP_WINDOW_MS = 10000;

// The two trackers describe the SAME send differently, so don't compare raw
// strings: the macro reports account "(default account)" (it can't resolve
// one on a default Exchange account) while the add-in reports the real
// address, and recipient strings differ in trailing "; " and display-name
// formatting. Compare subject and the SET of recipient email addresses only.
const normText = (s) => String(s ?? "").trim().toLowerCase();
const recipientSet = (to) => {
  const emails = String(to ?? "").toLowerCase().match(/[^\s<>;,"']+@[^\s<>;,"']+/g) || [];
  return [...new Set(emails)].sort().join(",") || normText(to);
};
const isGenericAccount = (a) => {
  const v = normText(a);
  return v === "" || v === "(default account)" || v === "gmail";
};

// Atomic claim instead of "scan recent rows, then write": both trackers can
// register within the same instant, and a check-then-write would let both
// through. SET NX with a short expiry makes exactly one of them the winner;
// the other gets the winner's id back. Returns null if we're the first.
async function claimOrFindDuplicate(r, rec) {
  const fingerprint = crypto
    .createHash("sha1")
    .update(normText(rec.subject) + "|" + recipientSet(rec.to))
    .digest("hex");
  const claimKey = `dedup:${fingerprint}`;
  const won = await r.set(claimKey, rec.id, { nx: true, ex: Math.ceil(DEDUP_WINDOW_MS / 1000) });
  if (won) return null;
  const winnerId = await r.get(claimKey);
  if (!winnerId) return null; // claim expired between the two calls - treat as new
  // The winner may not have written its record yet (it claims first), so the
  // record can be missing; its id is still the right pixel to hand back.
  return { id: String(winnerId), record: await r.get(`msg:${winnerId}`) };
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

  // Per-source heartbeat for the dashboard's "has this tracker gone quiet?"
  // banner. Counts duplicates too: the point is "is this source still alive".
  // Best-effort - never let it block a registration.
  await r.set(`lastseen:${sourceOf(rec.id)}`, rec.createdAt).catch(() => {});

  const dup = await claimOrFindDuplicate(r, rec);
  if (dup) {
    // The macro registers "(default account)", the add-in the real address.
    // Whichever got there first survives, so let it pick up the real account.
    const existing = dup.record;
    if (existing && isGenericAccount(existing.account) && !isGenericAccount(rec.account)) {
      existing.account = rec.account;
      await r.set(`msg:${existing.id}`, existing, { ex: TTL });
    }
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
