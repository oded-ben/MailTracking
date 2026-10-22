// GET /api/export  — every tracked message as a CSV download. Requires the
// same dashboard sign-in session as /dashboard (see /login).
import { cfg, hasValidSession, securityHeaders, loadAllRows, buildCsv } from "../lib/tracker.js";

export default async function handler(req, res) {
  securityHeaders(res, { noStore: true });
  if (!hasValidSession(req)) {
    res.setHeader("Location", "/login");
    return res.status(302).end();
  }
  const c = cfg();

  const rows = await loadAllRows();

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="mailtracking-${stamp}.csv"`);
  res.status(200).send(buildCsv(rows, c.TZ));
}
