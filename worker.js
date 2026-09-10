// email-tracker — Cloudflare Worker
// -----------------------------------------------------------------------------
// Endpoints
//   GET  /o/<id>.gif          tracking pixel: logs the open, sends alerts
//   POST /register            called by the Outlook macro on send (needs X-Track-Key)
//   GET  /dashboard?k=SECRET  plain table of every tracked email + status
//   cron (hourly)             "not opened after N hours" sweep + cleanup
//
// Bindings (see wrangler.toml)
//   KV namespace : TRACK
//   Vars         : NOTIFY_TO, NOTIFY_FROM, UNOPENED_HOURS, BURST_WINDOW_MIN,
//                  BURST_COUNT, IGNORE_FIRST_SECONDS, NOTIFY_EVERY_OPEN, TZ
//   Secrets      : RESEND_API_KEY, SHARED_SECRET
// -----------------------------------------------------------------------------

// 1x1 transparent GIF
const GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="),
  (c) => c.charCodeAt(0)
);

const TTL = 60 * 60 * 24 * 45; // keep each record 45 days

function cfg(env) {
  return {
    NOTIFY_TO: env.NOTIFY_TO,
    NOTIFY_FROM: env.NOTIFY_FROM || "Email Tracker <onboarding@resend.dev>",
    UNOPENED_HOURS: Number(env.UNOPENED_HOURS || 24),
    BURST_WINDOW_MIN: Number(env.BURST_WINDOW_MIN || 30),
    BURST_COUNT: Number(env.BURST_COUNT || 3),
    IGNORE_FIRST_SECONDS: Number(env.IGNORE_FIRST_SECONDS || 15),
    NOTIFY_EVERY_OPEN: String(env.NOTIFY_EVERY_OPEN || "0") === "1",
    TZ: env.TZ || "UTC",
  };
}

async function sendMail(env, subject, text) {
  const c = cfg(env);
  if (!env.RESEND_API_KEY || !c.NOTIFY_TO) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: c.NOTIFY_FROM, to: [c.NOTIFY_TO], subject, text }),
    });
  } catch (e) {
    /* best effort */
  }
}

function fmt(ts, tz) {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString("en-GB", { timeZone: tz }) + " " + tz;
  } catch {
    return new Date(ts).toISOString();
  }
}

function pixelResponse() {
  return new Response(GIF, {
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(GIF.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- open pixel ---------------------------------------------------------
    if (req.method === "GET" && p.startsWith("/o/") && p.endsWith(".gif")) {
      const id = decodeURIComponent(p.slice(3, -4));
      ctx.waitUntil(handleOpen(env, id));
      return pixelResponse();
    }

    // ---- register (from the Outlook macro) --------------------------------
    if (req.method === "POST" && p === "/register") {
      if ((req.headers.get("X-Track-Key") || "") !== env.SHARED_SECRET)
        return new Response("forbidden", { status: 403 });
      let b;
      try {
        b = await req.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!b.id) return new Response("missing id", { status: 400 });
      const rec = {
        id: b.id,
        subject: b.subject || "(no subject)",
        to: b.to || "",
        createdAt: Date.now(),
        firstOpenAt: 0,
        opens: [], // [{t, bot}]
        notifiedFirst: false,
        notifiedUnopened: false,
        notifiedBurst: false,
      };
      await env.TRACK.put("msg:" + b.id, JSON.stringify(rec), { expirationTtl: TTL });
      return json({ ok: true, pixel: `${url.origin}/o/${encodeURIComponent(b.id)}.gif` });
    }

    // ---- dashboard --------------------------------------------------------
    if (req.method === "GET" && p === "/dashboard") {
      if (url.searchParams.get("k") !== env.SHARED_SECRET)
        return new Response("forbidden", { status: 403 });
      return dashboard(env);
    }

    if (p === "/") return new Response("email-tracker ok");
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};

async function handleOpen(env, id) {
  const c = cfg(env);
  const key = "msg:" + id;
  const raw = await env.TRACK.get(key);
  if (!raw) return; // unknown id (register failed / expired) — nothing to attribute
  const m = JSON.parse(raw);
  const now = Date.now();
  const sinceSend = now - m.createdAt;

  // A hit within the first few seconds is almost always a security scanner or
  // image proxy pre-fetching the message, not a human.
  const isBot = sinceSend < c.IGNORE_FIRST_SECONDS * 1000;

  m.opens.push({ t: now, bot: isBot });
  if (m.opens.length > 300) m.opens = m.opens.slice(-300);
  const human = m.opens.filter((o) => !o.bot);

  const alerts = [];

  if (!isBot && !m.firstOpenAt) m.firstOpenAt = now;

  if (!isBot && !m.notifiedFirst && human.length >= 1) {
    m.notifiedFirst = true;
    alerts.push({
      subject: `Opened: ${m.subject}`,
      text:
        `"${m.subject}"\nto: ${m.to}\n\n` +
        `First opened ${fmt(now, c.TZ)}\n` +
        `= ${Math.round(sinceSend / 60000)} min after you sent it.`,
    });
  } else if (!isBot && m.notifiedFirst) {
    const win = c.BURST_WINDOW_MIN * 60000;
    const recent = human.filter((o) => now - o.t <= win).length;
    if (!m.notifiedBurst && recent >= c.BURST_COUNT) {
      m.notifiedBurst = true;
      alerts.push({
        subject: `Opened ${recent}x: ${m.subject}`,
        text:
          `"${m.subject}"\nto: ${m.to}\n\n` +
          `${recent} opens in the last ${c.BURST_WINDOW_MIN} min (total ${human.length}).\n` +
          `Could be active re-reading or forwarding — or a mail scanner in a loop.`,
      });
    }
    if (c.NOTIFY_EVERY_OPEN) {
      alerts.push({
        subject: `Re-opened (#${human.length}): ${m.subject}`,
        text: `"${m.subject}"\nto: ${m.to}\n\nOpened again ${fmt(now, c.TZ)}.`,
      });
    }
  }

  await env.TRACK.put(key, JSON.stringify(m), { expirationTtl: TTL });
  for (const a of alerts) await sendMail(env, a.subject, a.text);
}

async function sweep(env) {
  const c = cfg(env);
  const now = Date.now();
  let cursor;
  do {
    const list = await env.TRACK.list({ prefix: "msg:", cursor });
    cursor = list.list_complete ? undefined : list.cursor;
    for (const k of list.keys) {
      const raw = await env.TRACK.get(k.name);
      if (!raw) continue;
      const m = JSON.parse(raw);
      if (
        !m.firstOpenAt &&
        !m.notifiedUnopened &&
        now - m.createdAt > c.UNOPENED_HOURS * 3600000
      ) {
        m.notifiedUnopened = true;
        await env.TRACK.put(k.name, JSON.stringify(m), { expirationTtl: TTL });
        await sendMail(
          env,
          `Not opened (${c.UNOPENED_HOURS}h): ${m.subject}`,
          `"${m.subject}"\nto: ${m.to}\n\n` +
            `Sent ${fmt(m.createdAt, c.TZ)} — still no open after ${c.UNOPENED_HOURS} h.\n` +
            `(If the recipient blocks remote images you may never see an open.)`
        );
      }
    }
  } while (cursor);
}

async function dashboard(env) {
  const c = cfg(env);
  const rows = [];
  let cursor;
  do {
    const list = await env.TRACK.list({ prefix: "msg:", cursor });
    cursor = list.list_complete ? undefined : list.cursor;
    for (const k of list.keys) {
      const raw = await env.TRACK.get(k.name);
      if (raw) rows.push(JSON.parse(raw));
    }
  } while (cursor);
  rows.sort((a, b) => b.createdAt - a.createdAt);

  const esc = (s) =>
    String(s).replace(/[&<>]/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[x]));
  const body = rows
    .slice(0, 300)
    .map((m) => {
      const human = m.opens.filter((o) => !o.bot);
      const status = human.length
        ? `opened ${human.length}x &mdash; first ${fmt(m.firstOpenAt, c.TZ)}`
        : m.opens.length
        ? `only scanner hits (${m.opens.length})`
        : "not opened";
      return `<tr><td>${fmt(m.createdAt, c.TZ)}</td><td>${esc(m.subject)}</td><td>${esc(
        m.to
      )}</td><td>${status}</td></tr>`;
    })
    .join("");

  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
      `<title>Email tracker</title>` +
      `<style>body{font:14px/1.4 system-ui,sans-serif;margin:1.5rem;color:#111}` +
      `table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left;vertical-align:top}` +
      `th{background:#f4f4f4}</style>` +
      `<h2>Tracked emails (${rows.length})</h2>` +
      `<table><tr><th>Sent</th><th>Subject</th><th>To</th><th>Status</th></tr>${body}</table>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
