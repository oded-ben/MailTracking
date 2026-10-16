// GET /dashboard  — searchable/sortable table of every tracked email, with a
// per-row snooze button that stops the "not opened" nudge for messages you
// don't expect (or care about) a reply to. Requires signing in at /login -
// no secret sits in this URL, so it's safe to bookmark.
import { redis, cfg, fmt, hasValidSession, securityHeaders, sourceOf, SOURCES } from "../lib/tracker.js";

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
  for (const id of ids.slice(0, 300)) {
    const m = await r.get(`msg:${id}`);
    if (m) rows.push(m);
  }

  // Escapes all five HTML-significant characters, not just &<> - this value
  // is interpolated into both element content AND attribute values (e.g.
  // data-id="${esc(m.id)}"), and m.id/m.subject/m.to/m.account all originate
  // from /register, which anyone holding ADDIN_KEY can call. Without quote
  // escaping, a crafted id like `x" onmouseover="..." could break out of the
  // attribute and inject arbitrary HTML attributes into this page.
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[x])
    );

  let openedCount = 0;
  let snoozedCount = 0;

  // Health: when did each tracker (macro / add-in / Gmail) last register a send?
  // Uses the heartbeat keys written by /register, and also the rows themselves
  // so it is accurate immediately after deploy. A silent source is the signature
  // of a broken integration (e.g. the Gmail extension losing its context).
  const lastSeen = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  for (const m of rows) {
    const s = sourceOf(m.id);
    lastSeen[s] = Math.max(lastSeen[s], m.createdAt || 0);
  }
  await Promise.all(
    SOURCES.map(async (s) => {
      try {
        const v = Number(await r.get(`lastseen:${s}`));
        if (v > lastSeen[s]) lastSeen[s] = v;
      } catch {
        /* heartbeat is optional */
      }
    })
  );
  const SOURCE_LABEL = { macro: "Outlook macro", addin: "Outlook add-in", gmail: "Gmail extension" };
  const ago = (ts) => {
    if (!ts) return "never";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 60) return `${Math.max(mins, 1)} min ago`;
    if (mins < 60 * 48) return `${Math.round(mins / 60)} h ago`;
    return `${Math.round(mins / 1440)} days ago`;
  };
  const staleMs = c.STALE_DAYS * 86400000;
  const stale = SOURCES.filter((s) => Date.now() - lastSeen[s] > staleMs);
  const health =
    `<div class="health${stale.length ? " warn" : ""}">` +
    (stale.length
      ? `<strong>Heads up:</strong> no registrations from ${stale
          .map((s) => esc(SOURCE_LABEL[s]))
          .join(" or ")} in ${c.STALE_DAYS}+ days. If you have sent mail from ${
          stale.length > 1 ? "them" : "it"
        } since, tracking there may be broken.<br>`
      : "") +
    `Last send registered &mdash; ` +
    SOURCES.map((s) => `${SOURCE_LABEL[s]}: ${ago(lastSeen[s])}`).join(" &middot; ") +
    `</div>`;

  const CLIENT_LABEL = {
    gmail: "Gmail",
    apple: "Apple Mail, may be a prefetch",
    outlook: "Outlook",
    browser: "browser / webmail",
    other: "unknown client",
  };

  const body = rows
    .map((m) => {
      const human = (m.opens || []).filter((o) => !o.bot);
      const isSnoozed = !!m.snoozed && !human.length;
      if (human.length) openedCount++;
      if (isSnoozed) snoozedCount++;
      // Who made the first human hit (older rows have no client info).
      const firstKind = human[0] && human[0].k;
      const via = firstKind && CLIENT_LABEL[firstKind] ? ` <small>via ${CLIENT_LABEL[firstKind]}</small>` : "";
      const status = human.length
        ? `opened ${human.length}x &mdash; first ${fmt(m.firstOpenAt, c.TZ)}${via}`
        : (m.opens || []).length
        ? `only scanner hits (${m.opens.length})`
        : "not opened";
      return (
        `<tr data-id="${esc(m.id)}" data-sent="${m.createdAt}" ` +
        `data-status="${human.length ? "opened" : "not-opened"}" data-snoozed="${isSnoozed ? 1 : 0}" ` +
        `class="${isSnoozed ? "snoozed" : ""}">` +
        `<td>${fmt(m.createdAt, c.TZ)}</td>` +
        `<td>${esc(m.subject)}</td>` +
        `<td>${esc(m.account || "-")}</td>` +
        `<td>${esc(m.to)}</td>` +
        `<td>${status}${isSnoozed ? " (snoozed)" : ""}</td>` +
        `<td><button class="snooze" data-id="${esc(m.id)}" data-snoozed="${isSnoozed ? 1 : 0}">` +
        `${isSnoozed ? "Un-snooze" : "Snooze"}</button></td>` +
        `</tr>`
      );
    })
    .join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(
    `<!doctype html><meta charset=utf-8>` +
      `<meta name=viewport content="width=device-width,initial-scale=1"><title>Email tracker</title>` +
      `<link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48dGV4dCB5PSIwLjllbSIgZm9udC1zaXplPSI5MCI+8J+TpzwvdGV4dD48L3N2Zz4=">` +
      `<style>
        body{font:14px/1.4 system-ui,sans-serif;margin:1.5rem;color:#111}
        .controls{display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap;align-items:center}
        input[type=search]{padding:6px 10px;font:inherit;flex:1;min-width:220px;box-sizing:border-box}
        table{border-collapse:collapse;width:100%}
        td,th{border:1px solid #ccc;padding:6px 10px;text-align:left;vertical-align:top}
        th{background:#f4f4f4;cursor:pointer;user-select:none;white-space:nowrap}
        th.sort-asc::after{content:" \\25B2"}
        th.sort-desc::after{content:" \\25BC"}
        tr.snoozed{opacity:.55}
        button.snooze{font:inherit;padding:3px 10px;cursor:pointer}
        #empty{display:none;color:#666;padding:12px 0}
        .controls a{white-space:nowrap;color:#0645ad}
        .summary{color:#444;margin:0 0 10px}
        button.filt{font:inherit;color:inherit;background:none;border:none;padding:0;cursor:pointer;text-decoration:underline dotted}
        button.filt.active{font-weight:600;color:#0645ad;text-decoration:none}
        .health{background:#eef6ee;border:1px solid #b9d9b9;border-radius:6px;padding:8px 12px;margin:0 0 12px;color:#245c24}
        .health.warn{background:#fff4e0;border-color:#f0c36d;color:#7a4b00}
        small{color:#666}
        .table-wrap{overflow-x:auto}
        table{min-width:640px}
      </style>` +
      `<h2>Tracked emails (<span id="count">${rows.length}</span>)</h2>` +
      health +
      `<div class="summary">` +
      `<button class="filt active" data-filter="all">${rows.length} tracked</button> &middot; ` +
      `<button class="filt" data-filter="opened">${openedCount} opened</button> &middot; ` +
      `<button class="filt" data-filter="not-opened">${rows.length - openedCount} not opened</button> &middot; ` +
      `<button class="filt" data-filter="snoozed">${snoozedCount} snoozed</button>` +
      `</div>` +
      `<div class="controls"><input type="search" id="q" placeholder="Search subject / account / recipient / status…">` +
      `<a href="/api/export">Export CSV</a><a href="/logout">Log out</a></div>` +
      `<div class="table-wrap"><table id="tbl"><thead><tr>` +
      `<th data-k="sent">Sent</th><th data-k="text">Subject</th><th data-k="text">From</th>` +
      `<th data-k="text">To</th><th data-k="text">Status</th><th></th>` +
      `</tr></thead><tbody>${body}</tbody></table></div>` +
      `<div id="empty">No rows match your search.</div>` +
      `<script>${clientScript()}</script>`
  );
}

function clientScript() {
  // No key to embed anymore - the session cookie goes along automatically
  // with same-origin fetch() calls, so /api/snooze just works.
  return `
    const tbody = document.querySelector('#tbl tbody');
    const q = document.getElementById('q');
    const empty = document.getElementById('empty');
    let statusFilter = 'all';

    function matchesFilter(tr) {
      if (statusFilter === 'all') return true;
      if (statusFilter === 'snoozed') return tr.dataset.snoozed === '1';
      return tr.dataset.status === statusFilter;
    }

    function applyFilters() {
      const term = q.value.toLowerCase();
      let visible = 0;
      tbody.querySelectorAll('tr').forEach((tr) => {
        const show = matchesFilter(tr) && tr.textContent.toLowerCase().includes(term);
        tr.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      empty.style.display = visible === 0 ? '' : 'none';
    }

    q.addEventListener('input', applyFilters);

    document.querySelectorAll('button.filt').forEach((btn) => {
      btn.addEventListener('click', () => {
        statusFilter = btn.dataset.filter;
        document.querySelectorAll('button.filt').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        applyFilters();
      });
    });

    document.querySelectorAll('#tbl thead th[data-k]').forEach((th, idx) => {
      th.addEventListener('click', () => {
        const asc = !th.classList.contains('sort-asc');
        document.querySelectorAll('#tbl thead th').forEach((h) => h.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(asc ? 'sort-asc' : 'sort-desc');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((a, b) => {
          let av, bv;
          if (th.dataset.k === 'sent') {
            av = Number(a.dataset.sent); bv = Number(b.dataset.sent);
          } else {
            av = a.children[idx].textContent.trim().toLowerCase();
            bv = b.children[idx].textContent.trim().toLowerCase();
          }
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
          return 0;
        });
        rows.forEach((r) => tbody.appendChild(r));
      });
    });

    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button.snooze');
      if (!btn) return;
      btn.disabled = true;
      const id = btn.dataset.id;
      const nextSnoozed = btn.dataset.snoozed !== '1';
      try {
        const res = await fetch('/api/snooze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, snoozed: nextSnoozed }),
        });
        if (res.ok) location.reload();
        else { alert('Failed to update.'); btn.disabled = false; }
      } catch (err) { alert('Network error.'); btn.disabled = false; }
    });
  `;
}
