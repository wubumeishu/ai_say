// Shared DevTools target discovery used by both app.js routes and the session pool.

const http = require('http');

async function fetchDevtoolsTargetList(hostPort) {
  const baseUrl = 'http://' + String(hostPort).replace(/^https?:\/\//, '');
  const endpoints = ['/json/list', '/json'];
  for (let i = 0; i < endpoints.length; i += 1) {
    const url = baseUrl + endpoints[i];
    try {
      const targets = await new Promise((resolve, reject) => {
        http.get(url, (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            res.resume();
            reject(new Error('DevTools target list request failed: HTTP ' + res.statusCode));
            return;
          }
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) resolve(parsed);
              else resolve(parsed && Array.isArray(parsed.data) ? parsed.data : []);
            } catch (err) {
              reject(new Error('Failed to parse DevTools target list: ' + err.message));
            }
          });
        }).on('error', reject);
      });
      if (Array.isArray(targets) && targets.length) return targets;
    } catch (err) {
      if (i === endpoints.length - 1) throw err;
    }
  }
  return [];
}

function isLocalHost(url) {
  var raw = String(url || "");
  if (raw.indexOf("console.bitbrowser.net") !== -1) return true;
  var m = raw.match(/^[a-z]+:\/\/([^\/\?#]+)/i);
  if (!m) return false;
  var host = m[1].toLowerCase().split(/[=:]/)[0];
  return host === "localhost" || host === "127.0.0.1";
}

function isProfileDisplayUrl(url) {
  const text = String(url || "").toLowerCase();
  const directDisplay = text.indexOf("show_profile") !== -1 || text.indexOf("my_profile") !== -1 || text.indexOf("profile_detail") !== -1 || text.indexOf("profile/show") !== -1;
  if (directDisplay) return true;
  const myPage = text.indexOf("mypage") !== -1 || text.indexOf("my-page") !== -1 || text.indexOf("mypage.html") !== -1;
  return myPage && text.indexOf("edit") === -1 && text.indexOf("setting") === -1 && text.indexOf("snssetting") === -1;
}

// pickProfileTarget(targets, patterns)
//   patterns: extra keyword list used to recognize profile-like URLs; empty = built-in list.
function pickProfileTarget(targets, patterns) {
  var list = Array.isArray(targets) ? targets : [];
  var pages = list.filter(function(t) { return t && t.type === "page" && t.webSocketDebuggerUrl; });
  if (!pages.length) return null;
  var remote = pages.filter(function(t) { return !isLocalHost(t.url); });
  var pool = remote.length ? remote : pages;
  var displayMatch = pool.find(function(t) { return isProfileDisplayUrl(t.url); });
  if (displayMatch) return displayMatch;
  if (Array.isArray(patterns) && patterns.length) {
    var profileMatch = pool.find(function(t) {
      var text = String(t.url || "").toLowerCase();
      return patterns.some(function(p) { return p && text.indexOf(String(p).toLowerCase()) !== -1; });
    });
    if (profileMatch) return profileMatch;
  }
  var nonConsole = pool.find(function(t) { return String(t.url || "").indexOf("console.bitbrowser.net") === -1; });
  if (nonConsole) return nonConsole;
  return pool[0];
}

module.exports = { fetchDevtoolsTargetList, isLocalHost, isProfileDisplayUrl, pickProfileTarget };
