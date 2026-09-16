// GET /api/cron  — the "still not opened" sweep.
// Called automatically by the Vercel cron in vercel.json, or manually with ?k=SHARED_SECRET.
import { runSweep, safeEqual, securityHeaders } from "../lib/tracker.js";

export default async function handler(req, res) {
  securityHeaders(res);
  const auth = req.headers["authorization"] || "";

  // No User-Agent-based fallback: a client can put anything it wants in that
  // header, so trusting "looks like it says vercel-cron" is not a real check.
  // CRON_SECRET is confirmed configured for this deployment - fail closed if
  // that ever stops being true, rather than silently accepting a spoofable UA.
  const viaCronSecret = safeEqual(auth, `Bearer ${process.env.CRON_SECRET || ""}`);
  const viaManualKey = safeEqual(String(req.query.k || ""), process.env.SHARED_SECRET || "");

  if (!viaCronSecret && !viaManualKey) {
    console.warn("[cron] rejected: invalid auth", { ip: req.headers["x-forwarded-for"] });
    return res.status(403).json({ error: "forbidden" });
  }

  const result = await runSweep();
  res.status(200).json({ ok: true, ...result });
}
