// POST /register  — called by the Outlook macro on send. Header: X-Track-Key.
import { redis, TTL } from "../lib/tracker.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.headers["x-track-key"] || "") !== process.env.SHARED_SECRET)
    return res.status(403).json({ error: "forbidden" });

  let b = req.body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      b = null;
    }
  }
  if (!b || !b.id) return res.status(400).json({ error: "missing id" });

  const rec = {
    id: b.id,
    subject: b.subject || "(no subject)",
    to: b.to || "",
    createdAt: Date.now(),
    firstOpenAt: 0,
    opens: [],
    notifiedFirst: false,
    notifiedUnopened: false,
    notifiedBurst: false,
  };

  const r = redis();
  await r.set(`msg:${b.id}`, rec, { ex: TTL });
  await r.zadd("msgs", { score: rec.createdAt, member: b.id });

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["host"];
  res
    .status(200)
    .json({ ok: true, pixel: `${proto}://${host}/o/${encodeURIComponent(b.id)}.gif` });
}
