# MailTracking for Gmail (Chrome extension)

Covers the case the Outlook macro can't: composing and sending directly in
Gmail's web UI (mail.google.com). Reports to the **same backend and dashboard**
as the Outlook side, so both show up in one place.

Not needed if your Gmail account is added *inside* Outlook Classic — that's
already tracked automatically, no extension required.

## Why an extension at all

Gmail's web compose has no scriptable "before send" hook the way Outlook has
`Application_ItemSend`. Every Gmail tracker (Mailtrack, MailTracker, Streak,
etc.) works the same way: a content script watches the compose window's DOM
and intercepts the Send button. This does the same thing, minimally.

## Install (unpacked — no Chrome Web Store needed)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. **Load unpacked** → select this folder (`alt/gmail-extension`)
4. Click the extension's icon in the toolbar → enter:
   - **Backend URL**: your Vercel domain, e.g. `https://mail-tracking-chi.vercel.app`
   - **Shared key**: the same `SHARED_SECRET` the Outlook macro uses
   → **Save**

That's it — no code edits, the config lives in the extension's own storage
(`chrome.storage.sync`), not in a file, so nothing secret is ever committed
to this repo.

5. Send a test email from Gmail's web UI, open it from another account, and
   check the dashboard.

## How it works

- A content script listens (capture phase) for a click on Gmail's Send button,
  or the Ctrl/Cmd+Enter shortcut.
- On send, it drops an invisible 1×1 pixel into the compose body pointing at
  `<backend>/o/<id>.gif`, and asks the background service worker to `POST` the
  subject/recipients/account to `<backend>/register` — same two endpoints the
  Outlook macro calls.
- It never blocks or delays sending. If anything here fails (Gmail changed its
  markup, network hiccup), the email just goes out untracked.

## Known limitations (on top of the general ones in the root README)

- **Relies on Gmail's internal, unversioned CSS classes/selectors**
  (`div.Am.Al.editable` for the body, `data-tooltip^='Send'` for the button).
  These have been stable for years and are what several open-source Gmail
  tools rely on, but Google can change them without notice — if tracking
  silently stops working, this is the first place to check (open DevTools on
  a Gmail compose window and see if those selectors still match).
- **Sending account detection is best-effort.** It reads the account chip's
  accessibility label; if Google changes that markup, the dashboard just shows
  "Gmail" instead of your specific address for those sends.
- **Confidential Mode** emails may block remote image loading on the
  recipient's side by design — expect those to show as never opened.
- Only tracks sends from **this Chrome profile, in this browser**. Doesn't
  cover Gmail's Android/iOS app or other browsers/profiles.
