// Gmail relay for totem-autologin (https://github.com/HoussamOtarid/totem-autologin).
//
// totem-autologin POSTs {key, action, ...} here. The script only ever returns the code from a recent Whoop
// sign-in email, or sends a notification email to this account. Setup steps: README.md.

// Whoop's code email: from donotreply@whoop.com, "Secure sign-in",
// "Here's your code to continue signing in: 123456", valid 10 minutes.
const QUERY = 'from:donotreply@whoop.com newer_than:1h';

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ error: 'bad request' }); }
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || req.key !== key) return out({ error: 'forbidden' });

  if (req.action === 'code') return out({ code: latestCode(Number(req.since) || 0) });
  if (req.action === 'notify') {
    const me = Session.getEffectiveUser().getEmail();
    GmailApp.sendEmail(me, 'totem: ' + String(req.subject || '').slice(0, 100), String(req.msg || '').slice(0, 2000));
    return out({ ok: true });
  }
  return out({ error: 'unknown action' });
}

// Newest code from a matching email received after sinceMs (epoch ms), or null.
function latestCode(sinceMs) {
  let best = null;
  GmailApp.search(QUERY, 0, 10).forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      const at = m.getDate().getTime();
      if (at < sinceMs || (best && at <= best.at)) return;
      const text = m.getSubject() + '\n' + m.getPlainBody();
      // Prefer the number after "code to continue signing in:", then after any "code", then any 6-8 digits.
      const match = text.match(/signing in:?\s*(\d{6,8})\b/i) || text.match(/code[^0-9]{0,40}(\d{6,8})\b/i)
        || text.match(/\b(\d{6,8})\b/);
      if (match) best = { at: at, code: match[1] };
    });
  });
  return best ? best.code : null;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run from the editor: logs what the endpoint would return for the last hour.
function debugLatest() {
  Logger.log(latestCode(Date.now() - 3600 * 1000));
}
