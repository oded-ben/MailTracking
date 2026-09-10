// GET /dashboard?k=SHARED_SECRET  — plain table of every tracked email + status.
import { redis, cfg, fmt } from "../lib/tracker.js";

export default async function handler(req, res) {
  if (req.query.k !== process.env.SHARED_SECRET)
    return res.status(403).send("forbidden");
  const c = cfg();

  const r = redis();
  const ids = await r.zrange("msgs", 0, -1, { rev: true });
  const rows = [];
  for (const id of ids.slice(0, 300)) {
    const m = await r.get(`msg:${id}`);
    if (m) rows.push(m);
  }

  const esc = (s) =>
    String(s).replace(/[&<>]/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[x]));

  const body = rows
    .map((m) => {
      const human = (m.opens || []).filter((o) => !o.bot);
      const status = human.length
        ? `opened ${human.length}x &mdash; first ${fmt(m.firstOpenAt, c.TZ)}`
        : (m.opens || []).length
        ? `only scanner hits (${m.opens.length})`
        : "not opened";
      return `<tr><td>${fmt(m.createdAt, c.TZ)}</td><td>${esc(m.subject)}</td><td>${esc(
        m.to
      )}</td><td>${status}</td></tr>`;
    })
    .join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(
    `<!doctype html><meta charset=utf-8>` +
      `<meta name=viewport content="width=device-width,initial-scale=1"><title>Email tracker</title>` +
      `<style>body{font:14px/1.4 system-ui,sans-serif;margin:1.5rem;color:#111}` +
      `table{border-collapse:collapse;width:100%}` +
      `td,th{border:1px solid #ccc;padding:6px 10px;text-align:left;vertical-align:top}` +
      `th{background:#f4f4f4}</style>` +
      `<h2>Tracked emails (${rows.length})</h2>` +
      `<table><tr><th>Sent</th><th>Subject</th><th>To</th><th>Status</th></tr>${body}</table>`
  );
}
