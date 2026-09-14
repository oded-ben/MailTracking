// MailTracking for Gmail — content script.
// Watches for a Send click (or Ctrl/Cmd+Enter) in any Gmail compose window,
// drops an invisible pixel into the message body, and reports the send to the
// same backend the Outlook macro uses. Never blocks or delays the actual send —
// if anything here fails, Gmail just sends the mail untracked.

(function () {
  let CONFIG = null;
  chrome.storage.sync.get(["mtConfig"], (res) => {
    CONFIG = res.mtConfig || null;
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.mtConfig) CONFIG = changes.mtConfig.newValue;
  });

  function uid() {
    return "gmail-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // Best-effort — Gmail doesn't expose the active account email to content
  // scripts cleanly. Falls back to a generic label if it can't be found.
  function getAccountEmail() {
    const el = document.querySelector('a[aria-label*="Google Account"], a[aria-label*="Google-account"]');
    const label = el && el.getAttribute("aria-label");
    const m = label && label.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    return (m && m[0]) || "Gmail";
  }

  function findComposeRoot(node) {
    return node.closest(".aDh, .aoI, [role='dialog']");
  }

  function fieldValue(root, selector) {
    const el = root.querySelector(selector);
    if (!el) return "";
    return el.value != null ? el.value : el.textContent || "";
  }

  function injectPixel(root, id, base) {
    const body = root.querySelector("div.Am.Al.editable");
    if (!body) return false;
    const img = document.createElement("img");
    img.src = `${base}/o/${encodeURIComponent(id)}.gif`;
    img.width = 1;
    img.height = 1;
    img.alt = "";
    img.style.cssText = "display:none !important;opacity:0;width:1px;height:1px;overflow:hidden;";
    body.appendChild(img);
    return true;
  }

  function handleSend(root) {
    if (!CONFIG || !CONFIG.base || !CONFIG.key) return; // not configured yet
    const subject = fieldValue(root, "input[name='subjectbox']") || "(no subject)";
    const to = ["to", "cc", "bcc"]
      .map((n) => fieldValue(root, `textarea[name='${n}']`))
      .filter(Boolean)
      .join("; ");
    const account = getAccountEmail();
    const id = uid();

    injectPixel(root, id, CONFIG.base);

    chrome.runtime.sendMessage({
      type: "mt-register",
      base: CONFIG.base,
      key: CONFIG.key,
      id,
      subject,
      to,
      account,
    });
  }

  // Send button — capture phase, so the pixel lands before Gmail reads the body.
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest("div[role='button'][data-tooltip^='Send'], .T-I.J-J5-Ji.aoO");
      if (!btn) return;
      const root = findComposeRoot(btn);
      if (root) handleSend(root);
    },
    true
  );

  // Ctrl/Cmd+Enter keyboard send.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
      const root = findComposeRoot(e.target);
      if (root) handleSend(root);
    },
    true
  );
})();
