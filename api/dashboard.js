// GET /dashboard?k=SHARED_SECRET  — searchable/sortable table of every
// tracked email, with a per-row snooze button that stops the "not opened"
// nudge for messages you don't expect (or care about) a reply to.
import { redis, cfg, fmt } from "../lib/tracker.js";

export default async function handler(req, res) {
  const key = String(req.query.k || "");
  if (key !== process.env.SHARED_SECRET) return res.status(403).send("forbidden");
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
      const isSnoozed = !!m.snoozed && !human.length;
      const status = human.length
        ? `opened ${human.length}x &mdash; first ${fmt(m.firstOpenAt, c.TZ)}`
        : (m.opens || []).length
        ? `only scanner hits (${m.opens.length})`
        : "not opened";
      return (
        `<tr data-id="${esc(m.id)}" data-sent="${m.createdAt}" class="${isSnoozed ? "snoozed" : ""}">` +
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
      </style>` +
      `<h2>Tracked emails (<span id="count">${rows.length}</span>)</h2>` +
      `<div class="controls"><input type="search" id="q" placeholder="Search subject / account / recipient / status…">` +
      `<a href="/api/export?k=${encodeURIComponent(key)}">Export CSV</a></div>` +
      `<table id="tbl"><thead><tr>` +
      `<th data-k="sent">Sent</th><th data-k="text">Subject</th><th data-k="text">From</th>` +
      `<th data-k="text">To</th><th data-k="text">Status</th><th></th>` +
      `</tr></thead><tbody>${body}</tbody></table>` +
      `<div id="empty">No rows match your search.</div>` +
      `<script>${clientScript(key)}</script>`
  );
}

function clientScript(key) {
  // key is the same SHARED_SECRET already required to load this page at all -
  // embedding it back into the page's own script discloses nothing new.
  return `
    const K = ${JSON.stringify(key)};
    const tbody = document.querySelector('#tbl tbody');
    const q = document.getElementById('q');
    const empty = document.getElementById('empty');

    q.addEventListener('input', () => {
      const term = q.value.toLowerCase();
      let visible = 0;
      tbody.querySelectorAll('tr').forEach((tr) => {
        const show = tr.textContent.toLowerCase().includes(term);
        tr.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      empty.style.display = visible === 0 ? '' : 'none';
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
          headers: { 'Content-Type': 'application/json', 'X-Track-Key': K },
          body: JSON.stringify({ id, snoozed: nextSnoozed }),
        });
        if (res.ok) location.reload();
        else { alert('Failed to update.'); btn.disabled = false; }
      } catch (err) { alert('Network error.'); btn.disabled = false; }
    });
  `;
}
