// GET /o/<id>.gif  — logs the open, fires alerts, always returns the pixel.
import { redis, GIF, TTL, cfg, sendMail, fmt } from "../lib/tracker.js";

export default async function handler(req, res) {
  const id = String(req.query.id || "").replace(/\.gif$/i, "");

  try {
    await track(id);
  } catch {
    /* never let tracking break the image */
  }

  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Content-Length", String(GIF.length));
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.status(200).send(GIF);
}

async function track(id) {
  if (!id) return;
  const c = cfg();
  const r = redis();
  const key = `msg:${id}`;
  const m = await r.get(key);
  if (!m) return; // unknown id (register failed or expired)

  const now = Date.now();
  const sinceSend = now - m.createdAt;

  // A hit within the first few seconds is almost always a security scanner or
  // image proxy pre-fetching the message, not a human.
  const isBot = sinceSend < c.IGNORE_FIRST_SECONDS * 1000;

  m.opens = m.opens || [];
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

  await r.set(key, m, { ex: TTL });
  for (const a of alerts) await sendMail(a.subject, a.text);
}
