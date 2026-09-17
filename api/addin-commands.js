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

// TEMPORARY diagnostics: this runtime is a hidden background context with no
// console we can read, so it self-reports checkpoints to our own backend
// instead - GET /api/addin-debug?k=SHARED_SECRET to read them back. Remove
// once we've confirmed where (if anywhere) the handler is actually failing.
function ping(checkpoint, detail) {
  try {
    var x = new XMLHttpRequest();
    x.open('POST', BASE + '/api/addin-debug', true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.setRequestHeader('X-Track-Key', KEY);
    x.send(JSON.stringify({ checkpoint: checkpoint, detail: String(detail || '') }));
  } catch (e) {
    /* nothing more we can do if even this fails */
  }
}

// Fires the instant this script is parsed and executed by whatever runtime
// loaded it - the single most important checkpoint, since it's never been
// confirmed that this even happens for New Outlook's hidden runtime.
(function () {
  var info = '';
  try {
    var d = Office && Office.context && Office.context.diagnostics;
    info = d ? (d.host + ' ' + d.platform + ' ' + d.version) : 'no Office.context yet';
  } catch (e) {
    info = 'error reading diagnostics: ' + e.message;
  }
  ping('script-loaded', info);
})();

// Each Office.js getAsync/XHR call is a network round-trip to Exchange. The
// original version chained six of them one after another (subject -> to ->
// cc -> register -> body-get -> body-set), which was slow enough in practice
// to trip Outlook's own "this add-in is taking longer than expected" dialog
// - confirmed live. Fetching the independent pieces (subject/to/cc/body) in
// parallel, then doing the two independent writes (register + body-set) in
// parallel, cuts that to two round-trips' worth of latency instead of six.
function onMessageSendHandler(event) {
  ping('handler-invoked');
  var item = Office.context.mailbox.item;
  var done = false;
  function finish(why) {
    if (done) return;
    done = true;
    ping('finishing', why);
    event.completed({ allowEvent: true });
  }
  // Safety net, tightened from the original 4s specifically because that was
  // too close to (or past) Outlook's own patience threshold to matter.
  var safety = setTimeout(function () {
    finish('safety-timeout');
  }, 2500);

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
      ping('fetches-complete', 'subject len ' + subject.length + ', to ' + toList.length + ', cc ' + ccList.length + ', body len ' + bodyHtml.length);
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
        function joined(who) {
          ping('joined:' + who);
          toJoin--;
          if (toJoin <= 0) {
            clearTimeout(safety);
            finish('normal-completion');
          }
        }

        try {
          var xhr = new XMLHttpRequest();
          xhr.open("POST", BASE + "/register", true);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.setRequestHeader("X-Track-Key", KEY);
          xhr.timeout = 2000;
          xhr.onloadend = function () { joined('register-loadend-' + xhr.status); };
          xhr.onerror = function () { joined('register-error'); };
          xhr.ontimeout = function () { joined('register-timeout'); };
          xhr.send(JSON.stringify({ id: id, subject: subject, to: recips, account: account }));
        } catch (e) {
          joined('register-exception:' + e.message);
        }

        try {
          item.body.setAsync(newHtml, { coercionType: Office.CoercionType.Html }, function () {
            joined('body-set');
          });
        } catch (e) {
          joined('body-set-exception:' + e.message);
        }
      } catch (e) {
        ping('proceed-exception', e.message);
        clearTimeout(safety);
        finish('proceed-exception');
      }
    }
  } catch (e) {
    ping('outer-exception', e.message);
    clearTimeout(safety);
    finish('outer-exception');
  }
}

// Required: maps the manifest's LaunchEvent FunctionName to this handler.
// Without this call, a failed/slow add-in load can block sending entirely.
ping('before-associate', typeof Office !== 'undefined' && Office.actions ? 'Office.actions exists' : 'Office.actions MISSING');
try {
  Office.actions.associate("onMessageSendHandler", onMessageSendHandler);
  ping('after-associate-success');
} catch (e) {
  ping('associate-exception', e.message);
}
`;

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.status(200).send(js);
}
