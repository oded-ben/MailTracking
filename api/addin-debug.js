// POST /api/addin-debug  — the Office Add-in's hidden runtime self-reports
// diagnostic checkpoints here, since it has no visible console we can read.
// GET  /api/addin-debug?k=SHARED_SECRET  — read back what's been reported.
import { redis, safeEqual, securityHeaders } from "../lib/tracker.js";

const KEY_NAME = "addin:debug:log";
const MAX_ENTRIES = 100;

export default async function handler(req, res) {
  securityHeaders(res);
  const r = redis();

  if (req.method === "GET") {
    if (!safeEqual(String(req.query.k || ""), process.env.SHARED_SECRET || "")) {
      return res.status(403).json({ error: "forbidden" });
    }
    const entries = (await r.lrange(KEY_NAME, 0, MAX_ENTRIES - 1)) || [];
    return res.status(200).json({ ok: true, entries });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = req.headers["x-track-key"] || "";
  if (!safeEqual(key, process.env.ADDIN_KEY || "") && !safeEqual(key, process.env.SHARED_SECRET || "")) {
    return res.status(403).json({ error: "forbidden" });
  }

  let b = req.body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      b = {};
    }
  }
  await r.rpush(KEY_NAME, {
    at: Date.now(),
    checkpoint: String((b && b.checkpoint) || "").slice(0, 100),
    detail: String((b && b.detail) || "").slice(0, 2000),
  });
  await r.ltrim(KEY_NAME, -MAX_ENTRIES, -1);
  res.status(200).json({ ok: true });
}
