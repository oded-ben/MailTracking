// POST /api/snooze  — dashboard button: stop (or resume) the "not opened"
// nudge for one message. Body: { id, snoozed }.
import { setSnoozed } from "../lib/tracker.js";

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

  const m = await setSnoozed(b.id, !!b.snoozed);
  if (!m) return res.status(404).json({ error: "not found" });

  res.status(200).json({ ok: true, snoozed: m.snoozed });
}
