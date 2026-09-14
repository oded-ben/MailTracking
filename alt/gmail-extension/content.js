// MailTracking for Gmail — content script.
// Watches for a Send click (or Ctrl/Cmd+Enter) in any Gmail compose window,
// drops an invisible pixel into the message body, and reports the send to the
// same backend the Outlook macro uses. Never blocks or delays the actual send —
// if anything here fails, Gmail just sends the mail untracked.

(function () {
  // Temporary — leave this on while we confirm it's working, flip to false once
  // it's reliably showing up on the dashboard. Logs are prefixed [MailTracking].
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[MailTracking]", ...a);

  let CONFIG = null;
  chrome.storage.sync.get(["mtConfig"], (res) => {
    CONFIG = res.mtConfig || null;
    log("config loaded:", CONFIG);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.mtConfig) {
      CONFIG = changes.mtConfig.newValue;
      log("config updated:", CONFIG);
    }
  });

  log("content script injected on", location.href);

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

  // Walk up from wherever the send happened until we find an ancestor whose
  // subtree contains BOTH the subject box and the editable body — i.e. the
  // compose window itself. Doesn't depend on Gmail's obfuscated container
  // classes at all, only on the two selectors below (subjectbox / Am.Al.editable)
  // which have been stable across Gmail for years.
  function findComposeRoot(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    for (let i = 0; i < 15 && el; i++) {
      if (
        el.querySelector &&
        el.querySelector("input[name='subjectbox']") &&
        el.querySelector("div.Am.Al.editable")
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
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
    if (!CONFIG || !CONFIG.base || !CONFIG.key) {
      log("NOT configured yet — open the extension popup and save Backend URL + Shared key");
      return;
    }
    const subject = fieldValue(root, "input[name='subjectbox']") || "(no subject)";
    const to = ["to", "cc", "bcc"]
      .map((n) => fieldValue(root, `textarea[name='${n}']`))
      .filter(Boolean)
      .join("; ");
    const account = getAccountEmail();
    const id = uid();

    const injected = injectPixel(root, id, CONFIG.base);
    log("pixel injected:", injected, "| subject:", subject, "| to:", to, "| account:", account, "| id:", id);

    chrome.runtime.sendMessage(
      { type: "mt-register", base: CONFIG.base, key: CONFIG.key, id, subject, to, account },
      (resp) => log("register response:", resp, chrome.runtime.lastError || "")
    );
  }

  // Send button — capture phase, so the pixel lands before Gmail reads the body.
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest(
        "div[role='button'][data-tooltip^='Send'], div[role='button'][aria-label^='Send'], .T-I.J-J5-Ji.aoO"
      );
      if (!btn) return;
      log("Send button clicked:", btn);
      const root = findComposeRoot(btn);
      log("compose root:", root);
      if (root) handleSend(root);
      else log("could not find a compose root for this click — nothing tracked");
    },
    true
  );

  // Ctrl/Cmd+Enter keyboard send.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
      log("Ctrl/Cmd+Enter detected");
      const root = findComposeRoot(e.target);
      log("compose root:", root);
      if (root) handleSend(root);
      else log("could not find a compose root for this keypress — nothing tracked");
    },
    true
  );
})();
