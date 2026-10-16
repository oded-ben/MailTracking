// POST /api/delete  — dashboard button: permanently remove one tracked message.
// Body: { id }. Same auth as /api/snooze: the dashboard's session cookie, or
// the X-Track-Key header (SHARED_SECRET) for scripting.
import { deleteMessage, safeEqual, securityHeaders, hasValidSession } from "../lib/tracker.js";

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const viaKey = safeEqual(req.headers["x-track-key"] || "", process.env.SHARED_SECRET || "");
  if (!viaKey && !hasValidSession(req)) {
    console.warn("[delete] rejected: no valid session or key", { ip: req.headers["x-forwarded-for"] });
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

  const existed = await deleteMessage(b.id.slice(0, 200));
  if (!existed) return res.status(404).json({ error: "not found" });
  res.status(200).json({ ok: true });
}
