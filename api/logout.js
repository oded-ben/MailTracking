// GET /logout — clears the session cookie and sends you back to /login
import { securityHeaders, clearSessionCookieHeader } from "../lib/tracker.js";

export default function handler(req, res) {
  securityHeaders(res);
  res.setHeader("Set-Cookie", clearSessionCookieHeader());
  res.setHeader("Location", "/login");
  res.status(302).end();
}
