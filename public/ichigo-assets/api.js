// 第一刀 · api.js（fetch 封装，最小版；后续刀逐步扩充）
// 策略：先复制后分离——老内联 fetch 调用一字不动，本文件是并行 ES6 模块副本。
'use strict';

// 通用 GET JSON（带超时 + 降级，复刻前端现有 fetch.then(r=>r.json()) 语义）
export function getJson(url, timeoutMs) {
  var t = timeoutMs || 15000;
  return new Promise(function(resolve) {
    var done = false;
    var timer = setTimeout(function() {
      if (done) return;
      done = true;
      resolve({ ok: false, reason: 'timeout', ms: t });
    }, t);
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(j) { if (!done) { done = true; clearTimeout(timer); resolve(j); } })
      .catch(function(e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        console.warn('[api.getJson] 加载失败', url, e);
        resolve({ ok: false, reason: 'fetch-error', msg: String(e && e.message || e) });
      });
  });
}

// POST JSON（带超时 + 降级，复刻前端现有 POST 语义）
export function postJson(url, body, timeoutMs) {
  var t = timeoutMs || 25000;
  return new Promise(function(resolve) {
    var done = false;
    var timer = setTimeout(function() {
      if (done) return;
      done = true;
      resolve({ ok: false, reason: 'timeout', ms: t });
    }, t);
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function(r) { return r.json(); })
      .then(function(j) { if (!done) { done = true; clearTimeout(timer); resolve(j); } })
      .catch(function(e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        console.warn('[api.postJson] 请求失败', url, e);
        resolve({ ok: false, reason: 'fetch-error', msg: String(e && e.message || e) });
      });
  });
}