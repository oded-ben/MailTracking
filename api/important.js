// POST /api/important  — dashboard star button: mark (or unmark) a message as
// Important, which adds extra "still not opened" reminders at 3 and 7 days.
// Body: { id, important }. Same auth as /api/snooze.
import { setFlag, safeEqual, securityHeaders, hasValidSession } from "../lib/tracker.js";

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const viaKey = safeEqual(req.headers["x-track-key"] || "", process.env.SHARED_SECRET || "");
  if (!viaKey && !hasValidSession(req)) {
    console.warn("[important] rejected: no valid session or key", { ip: req.headers["x-forwarded-for"] });
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

  const m = await setFlag(b.id.slice(0, 200), "important", !!b.important);
  if (!m) return res.status(404).json({ error: "not found" });

  res.status(200).json({ ok: true, important: m.important });
}
