// GET /api/export?k=SHARED_SECRET  — every tracked message as a CSV download.
import { redis, cfg, fmt } from "../lib/tracker.js";

function csvField(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function handler(req, res) {
  if (String(req.query.k || "") !== process.env.SHARED_SECRET)
    return res.status(403).send("forbidden");
  const c = cfg();

  const r = redis();
  const ids = await r.zrange("msgs", 0, -1, { rev: true });
  const rows = [];
  for (const id of ids) {
    const m = await r.get(`msg:${id}`);
    if (m) rows.push(m);
  }

  const header = [
    "Sent",
    "Subject",
    "From",
    "To",
    "OpenCount",
    "FirstOpen",
    "Snoozed",
    "Status",
  ];
  const lines = [header.join(",")];

  for (const m of rows) {
    const human = (m.opens || []).filter((o) => !o.bot);
    const status = human.length ? "opened" : (m.opens || []).length ? "scanner-only" : "not opened";
    lines.push(
      [
        fmt(m.createdAt, c.TZ),
        csvField(m.subject),
        csvField(m.account || ""),
        csvField(m.to),
        human.length,
        m.firstOpenAt ? fmt(m.firstOpenAt, c.TZ) : "",
        m.snoozed ? "yes" : "no",
        status,
      ].join(",")
    );
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="mailtracking-${stamp}.csv"`);
  res.status(200).send(lines.join("\n") + "\n");
}
