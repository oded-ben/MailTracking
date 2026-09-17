// GET /login   — the sign-in page (redirects to /dashboard if already signed in)
// POST /login  — { password } -> sets the session cookie, or 401
import { safeEqual, securityHeaders, createSessionToken, sessionCookieHeader, hasValidSession } from "../lib/tracker.js";

export default async function handler(req, res) {
  securityHeaders(res, { noStore: true });

  if (req.method === "GET") {
    if (hasValidSession(req)) {
      res.setHeader("Location", "/dashboard");
      return res.status(302).end();
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(loginPage());
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET/POST only" });

  let b = req.body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      b = {};
    }
  }
  const password = String((b && b.password) || "");

  if (!safeEqual(password, process.env.SHARED_SECRET || "")) {
    console.warn("[login] rejected: wrong password", { ip: req.headers["x-forwarded-for"] });
    return res.status(401).json({ ok: false, error: "Wrong password." });
  }

  res.setHeader("Set-Cookie", sessionCookieHeader(createSessionToken()));
  res.status(200).json({ ok: true });
}

function loginPage() {
  return `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Sign in</title>
<link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48dGV4dCB5PSIwLjllbSIgZm9udC1zaXplPSI5MCI+8J+TpzwvdGV4dD48L3N2Zz4=">
<style>
  body{font:14px/1.4 system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#111}
  form{width:260px;padding:24px;border:1px solid #ddd;border-radius:8px}
  h1{font-size:16px;margin:0 0 16px}
  input{width:100%;box-sizing:border-box;padding:8px;font:inherit;margin-top:4px}
  button{width:100%;padding:8px;font:inherit;margin-top:14px;cursor:pointer}
  #err{color:#c00;font-size:12px;margin-top:8px;min-height:14px}
</style>
<form id="f">
  <h1>MailTracking</h1>
  <label for="p">Password</label>
  <input type="password" id="p" autofocus autocomplete="current-password" />
  <button type="submit">Sign in</button>
  <div id="err"></div>
</form>
<script>
  var f = document.getElementById('f');
  var p = document.getElementById('p');
  var err = document.getElementById('err');
  f.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.textContent = '';
    try {
      var res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: p.value }),
      });
      var data = await res.json();
      if (data.ok) location.href = '/dashboard';
      else { err.textContent = data.error || 'Sign-in failed.'; p.value = ''; p.focus(); }
    } catch (e) {
      err.textContent = 'Network error.';
    }
  });
</script>`;
}
