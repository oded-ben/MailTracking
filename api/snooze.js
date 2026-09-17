// POST /api/snooze  — dashboard button: stop (or resume) the "not opened"
// nudge for one message. Body: { id, snoozed }. Accepts either the
// dashboard's own session cookie (normal case - the browser sends it
// automatically) or the X-Track-Key header (SHARED_SECRET), kept as a
// scripting escape hatch for calling this outside the dashboard.
import { setSnoozed, safeEqual, securityHeaders, hasValidSession } from "../lib/tracker.js";

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const viaKey = safeEqual(req.headers["x-track-key"] || "", process.env.SHARED_SECRET || "");
  if (!viaKey && !hasValidSession(req)) {
    console.warn("[snooze] rejected: no valid session or key", { ip: req.headers["x-forwarded-for"] });
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
  if (!b || !b.id) return res.status(400).json({ error: "missing id" });

  const m = await setSnoozed(b.id, !!b.snoozed);
  if (!m) return res.status(404).json({ error: "not found" });

  res.status(200).json({ ok: true, snoozed: m.snoozed });
}
