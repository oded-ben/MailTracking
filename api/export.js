// GET /api/export  — every tracked message as a CSV download. Requires the
// same dashboard sign-in session as /dashboard (see /login).
import { redis, cfg, fmt, hasValidSession, securityHeaders } from "../lib/tracker.js";

// subject/account/to all originate from /register, which anyone holding
// ADDIN_KEY can call. Excel/Sheets treats a field starting with =, +, -, @,
// tab, or CR as a formula when the CSV is opened (CSV/formula injection,
// OWASP-documented) - a crafted subject like `=HYPERLINK(...)` would execute
// as a formula for whoever opens the export. Prefixing with a single quote
// is the standard mitigation: spreadsheet apps then treat it as literal text.
function csvField(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function handler(req, res) {
  securityHeaders(res, { noStore: true });
  if (!hasValidSession(req)) {
    res.setHeader("Location", "/login");
    return res.status(302).end();
  }
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
