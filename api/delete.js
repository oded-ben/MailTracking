// POST /api/delete  — dashboard bulk delete: permanently remove tracked messages.
// Body: { ids: [...] } (or a single { id }). Same auth as /api/snooze: the
// dashboard's session cookie, or the X-Track-Key header (SHARED_SECRET).
import { deleteMessages, safeEqual, securityHeaders, hasValidSession } from "../lib/tracker.js";

const MAX_IDS = 500;

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
  const raw = Array.isArray(b && b.ids) ? b.ids : b && b.id ? [b.id] : [];
  const ids = [...new Set(raw.filter((x) => typeof x === "string" && x).map((x) => x.slice(0, 200)))];
  if (!ids.length) return res.status(400).json({ error: "missing id(s)" });
  if (ids.length > MAX_IDS) return res.status(400).json({ error: `max ${MAX_IDS} per request` });

  const deleted = await deleteMessages(ids);
  res.status(200).json({ ok: true, deleted });
}
