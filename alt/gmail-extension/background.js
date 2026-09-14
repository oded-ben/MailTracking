// Runs the actual /register call from the service worker, not the content
// script — avoids any interaction with Gmail's own page CSP.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "mt-register") return;

  fetch(`${msg.base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Track-Key": msg.key },
    body: JSON.stringify({
      id: msg.id,
      subject: msg.subject,
      to: msg.to,
      account: msg.account,
    }),
  })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true; // keep the message channel open for the async sendResponse
});
