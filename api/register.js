// POST /register  — called by the Outlook macro, the Gmail extension, or the
// Office Add-in on send. Header: X-Track-Key, either SHARED_SECRET (macro,
// extension - kept reasonably private) or ADDIN_KEY (the Office Add-in's
// commands.js is served publicly, so its key is deliberately low-privilege:
// leaking it only allows creating junk register entries, nothing else).
import { redis, TTL } from "../lib/tracker.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = req.headers["x-track-key"] || "";
  const valid =
    (process.env.SHARED_SECRET && key === process.env.SHARED_SECRET) ||
    (process.env.ADDIN_KEY && key === process.env.ADDIN_KEY);
  if (!valid) return res.status(403).json({ error: "forbidden" });

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
    account: b.account || "",
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
