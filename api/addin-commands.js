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

// Each Office.js getAsync/XHR call is a network round-trip to Exchange. The
// original version chained six of them one after another (subject -> to ->
// cc -> register -> body-get -> body-set), which was slow enough in practice
// to trip Outlook's own "this add-in is taking longer than expected" dialog
// - confirmed live. Fetching the independent pieces (subject/to/cc/body) in
// parallel, then doing the two independent writes (register + body-set) in
// parallel, cuts that to two round-trips' worth of latency instead of six.
function onMessageSendHandler(event) {
  var item = Office.context.mailbox.item;
  var done = false;
  function finish() {
    if (done) return;
    done = true;
    event.completed({ allowEvent: true });
  }
  // Safety net, tightened from the original 4s specifically because that was
  // too close to (or past) Outlook's own patience threshold to matter.
  var safety = setTimeout(finish, 2500);

  try {
    var subject = "(no subject)";
    var toList = [];
    var ccList = [];
    var bodyHtml = "";
    var pending = 4;

    function fetched() {
      pending--;
      if (pending <= 0) proceed();
    }

    item.subject.getAsync(function (r) {
      if (r.status === Office.AsyncResultStatus.Succeeded && r.value) subject = r.value;
      fetched();
    });
    item.to.getAsync(function (r) {
      if (r.status === Office.AsyncResultStatus.Succeeded && r.value) toList = r.value;
      fetched();
    });
    item.cc.getAsync(function (r) {
      if (r.status === Office.AsyncResultStatus.Succeeded && r.value) ccList = r.value;
      fetched();
    });
    item.body.getAsync(Office.CoercionType.Html, function (r) {
      if (r.status === Office.AsyncResultStatus.Succeeded && r.value) bodyHtml = r.value;
      fetched();
    });

    function proceed() {
      try {
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

        var px =
          '<img src="' +
          BASE +
          "/o/" +
          encodeURIComponent(id) +
          '.gif" alt=" " width="1" height="1" ' +
          'style="display:none !important;opacity:0;width:1px;height:1px;overflow:hidden;" />';
        var newHtml = /<\\/body>/i.test(bodyHtml)
          ? bodyHtml.replace(/<\\/body>/i, px + "</body>")
          : bodyHtml + px;

        var toJoin = 2;
        function joined() {
          toJoin--;
          if (toJoin <= 0) {
            clearTimeout(safety);
            finish();
          }
        }

        try {
          var xhr = new XMLHttpRequest();
          xhr.open("POST", BASE + "/register", true);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.setRequestHeader("X-Track-Key", KEY);
          xhr.timeout = 2000;
          xhr.onloadend = joined;
          xhr.onerror = joined;
          xhr.ontimeout = joined;
          xhr.send(JSON.stringify({ id: id, subject: subject, to: recips, account: account }));
        } catch (e) {
          joined();
        }

        try {
          item.body.setAsync(newHtml, { coercionType: Office.CoercionType.Html }, joined);
        } catch (e) {
          joined();
        }
      } catch (e) {
        clearTimeout(safety);
        finish();
      }
    }
  } catch (e) {
    clearTimeout(safety);
    finish();
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
