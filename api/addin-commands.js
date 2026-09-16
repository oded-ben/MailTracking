// GET /outlook-addin/commands.js (rewritten from vercel.json)
// Serves the Office Add-in's OnMessageSend handler as JavaScript, generated
// per-request so the key it embeds never sits in the git repo.
//
// This file is fetched by real Outlook clients over the open internet -
// unlike the VBA macro (lives only on your PC) or the Gmail extension
// (secret stored in chrome.storage.sync, entered via its popup), whatever
// this responds with is effectively public: anyone can view-source it.
// That's why it uses ADDIN_KEY, a separate, deliberately low-privilege key
// from SHARED_SECRET - if it leaks, the only thing it can do is create junk
// /register entries. It cannot read the dashboard, export data, or
// snooze/unsnooze anything; those still require SHARED_SECRET, which is
// never embedded in anything publicly servable.
import { securityHeaders } from "../lib/tracker.js";

export default function handler(req, res) {
  securityHeaders(res);
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${req.headers.host}`;
  const key = process.env.ADDIN_KEY || "";

  const js = `
// MailTracking Office Add-in — OnMessageSend handler (generated per-request).
// See api/addin-commands.js in the repo for the source of truth and why this
// file's content is generated rather than static.
var BASE = ${JSON.stringify(base)};
var KEY = ${JSON.stringify(key)};

function onMessageSendHandler(event) {
  try {
    var item = Office.context.mailbox.item;

    item.subject.getAsync(function (subjectResult) {
      var subject =
        (subjectResult.status === Office.AsyncResultStatus.Succeeded && subjectResult.value) ||
        "(no subject)";

      item.to.getAsync(function (toResult) {
        var toList =
          (toResult.status === Office.AsyncResultStatus.Succeeded && toResult.value) || [];

        item.cc.getAsync(function (ccResult) {
          var ccList =
            (ccResult.status === Office.AsyncResultStatus.Succeeded && ccResult.value) || [];

          // Bcc intentionally excluded - same rule as the VBA macro and the
          // Gmail extension: Bcc's whole point is recipients don't see each
          // other, so it shouldn't sit in a log column either.
          var recips = toList
            .concat(ccList)
            .map(function (r) {
              return (r.displayName || "") + " <" + r.emailAddress + ">";
            })
            .join("; ");

          var account =
            (Office.context.mailbox.userProfile && Office.context.mailbox.userProfile.emailAddress) ||
            "(default account)";

          var id = "addin-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

          registerAndInject(item, id, subject, recips, account, event);
        });
      });
    });
  } catch (e) {
    event.completed({ allowEvent: true });
  }
}

function registerAndInject(item, id, subject, recips, account, event) {
  var done = false;
  function finish() {
    if (done) return;
    done = true;
    event.completed({ allowEvent: true });
  }
  // Safety net: whatever happens above, never hang the user's send.
  var safety = setTimeout(finish, 4000);

  try {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", BASE + "/register", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("X-Track-Key", KEY);
    xhr.timeout = 3000;
    xhr.onloadend = function () {
      injectPixel(item, id, function () {
        clearTimeout(safety);
        finish();
      });
    };
    xhr.onerror = function () {
      clearTimeout(safety);
      finish();
    };
    xhr.send(
      JSON.stringify({ id: id, subject: subject, to: recips, account: account })
    );
  } catch (e) {
    clearTimeout(safety);
    finish();
  }
}

function injectPixel(item, id, done) {
  try {
    item.body.getAsync(Office.CoercionType.Html, function (result) {
      try {
        if (result.status !== Office.AsyncResultStatus.Succeeded) {
          done();
          return;
        }
        var html = result.value || "";
        var px =
          '<img src="' +
          BASE +
          "/o/" +
          encodeURIComponent(id) +
          '.gif" alt=" " width="1" height="1" ' +
          'style="display:none !important;opacity:0;width:1px;height:1px;overflow:hidden;" />';
        var newHtml = /<\\/body>/i.test(html) ? html.replace(/<\\/body>/i, px + "</body>") : html + px;
        item.body.setAsync(newHtml, { coercionType: Office.CoercionType.Html }, function () {
          done();
        });
      } catch (e) {
        done();
      }
    });
  } catch (e) {
    done();
  }
}

// Required: maps the manifest's LaunchEvent FunctionName to this handler.
// Without this call, a failed/slow add-in load can block sending entirely.
Office.actions.associate("onMessageSendHandler", onMessageSendHandler);
`;

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.status(200).send(js);
}
