// GET /api/cron  — the "still not opened" sweep.
// Called automatically by the Vercel cron in vercel.json, or manually with ?k=SHARED_SECRET.
import { runSweep } from "../lib/tracker.js";

export default async function handler(req, res) {
  const auth = req.headers["authorization"] || "";
  const ua = req.headers["user-agent"] || "";

  const viaCronSecret =
    !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const viaVercelCron = !process.env.CRON_SECRET && ua.includes("vercel-cron");
  const viaManualKey = !!req.query.k && req.query.k === process.env.SHARED_SECRET;

  if (!viaCronSecret && !viaVercelCron && !viaManualKey)
    return res.status(403).json({ error: "forbidden" });

  const result = await runSweep();
  res.status(200).json({ ok: true, ...result });
}
