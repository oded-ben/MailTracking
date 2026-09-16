// POST /register  — called by the Outlook macro, the Gmail extension, or the
// Office Add-in on send. Header: X-Track-Key, either SHARED_SECRET (macro,
// extension - kept reasonably private) or ADDIN_KEY (the Office Add-in's
// commands.js is served publicly, so its key is deliberately low-privilege:
// leaking it only allows creating junk register entries, nothing else).
import { redis, TTL, safeEqual, securityHeaders } from "../lib/tracker.js";

// Truncate (never reject) so an oversized payload can't bloat storage, while
// a legitimately long subject/recipient list still gets through unharmed.
const cap = (s, n) => String(s ?? "").slice(0, n);

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
  await r.set(`msg:${rec.id}`, rec, { ex: TTL });
  await r.zadd("msgs", { score: rec.createdAt, member: rec.id });

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["host"];
  res
    .status(200)
    .json({ ok: true, pixel: `${proto}://${host}/o/${encodeURIComponent(rec.id)}.gif` });
}
