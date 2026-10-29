'use strict';
// =============================================================================
// Ai SAY · LINE 官方浏览器扩展 CDP 驱动器
//
// 目标：LINE 官方 Chrome 扩展（ID: ophjlpahpchlmihnnnihgmmeilfjmjjc）的
//       index.html 视图 —— 用户平时点扩展图标看到的 LINE 聊天界面。
//
// 原理：Chrome 带 --remote-debugging-port=9222 启动后，CDP /json/list 能枚举
//       所有 web contents（含 chrome-extension:// 页面）。找到 LINE 扩展页面
//       的 WebSocket，Runtime.evaluate 读 DOM（拉会话/消息），复用 ichigoDeepScrape.js
//       的连接 + 重试模式（零导航、页面内操作）。
//
// 铁律合规：
//   - 本文件只做「读」：拉会话列表、最近消息。
//   - 任何发送动作必须走 ichigoSendExpr.js 同款「建议 → 确认 → 执行」流程，
//     由用户明确确认后才触发（本文件暂不实现写入）。
//   - 不改动 LINE 扩展的登录态、不触发导航、不产生历史记录。
// =============================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

var LINE_EXT_ID = 'ophjlpahpchlmihnnnihgmmeilfjmjjc';
var LINE_EXT_PREFIX = 'chrome-extension://' + LINE_EXT_ID;
var EVAL_TIMEOUT_MS = 20000;
// CDP 端口候选（按顺序探测；Chrome 实际监听端口可能因端口被占而变）
var CDP_PORT_CANDIDATES = [9222, 9197, 9333];
var CDP_PORT = 9222; // 默认首选；adapter 运行时可被 deps.cdpPort 覆盖

// ---------- 工具（与 ichigoDeepScrape.js 同构） ----------

function isRetryable(err) {
  var m = String((err && err.message) || err || '');
  return /timeout|ECONNREFUSED|ECONNRESET|socket|closed|aborted|Invalid parameters|unresponsive|CDP/i.test(m);
}

async function retryCdp(opName, fn, tries) {
  tries = tries || 2;
  var lastErr = null;
  for (var i = 0; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < tries && isRetryable(e)) {
        console.warn('[line-cdp-retry] ' + opName + ' 第 ' + (i + 1) + ' 次失败（' + String((e && e.message) || e) + '），重连重试…');
        await new Promise(function(r) { setTimeout(r, 1200); });
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// 从 CDP HTTP 端点拉 /json/list（与 ichigoDeepScrape.js getTargets 同构）
function getTargets(port) {
  var host = '127.0.0.1';
  var p = port || CDP_PORT;
  if (typeof p === 'string' && p.indexOf(':') !== -1) {
    var parts = p.split(':');
    host = parts[0] || '127.0.0.1';
    p = parseInt(parts[1], 10);
  }
  p = Number(p);
  return new Promise(function(resolve, reject) {
    var req = http.get({ host: host, port: p, path: '/json/list' }, function(res) {
      var buf = '';
      res.on('data', function(d) { buf += d; });
      res.on('end', function() {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, function() { req.destroy(new Error('json/list timeout')); });
  });
}

// 在候选端口里找到第一个能响应 /json/list 且返回合法 JSON 的端口（CDP 实际监听口）
async function detectCdpPort(port) {
  var candidates = (port && port !== CDP_PORT) ? [Number(port), CDP_PORT].concat(CDP_PORT_CANDIDATES.filter(function(p){return p !== port;})) : CDP_PORT_CANDIDATES.slice();
  for (var i = 0; i < candidates.length; i++) {
    var p = candidates[i];
    try {
      var res = await getTargets(p);
      if (Array.isArray(res)) return p; // 命中 CDP
    } catch (_) { /* 该端口无 CDP，继续 */ }
  }
  return null;
}

// 在 /json/list 结果里找 LINE 扩展页面（type=page 且 url 匹配前缀）
function findLineTarget(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var url = String(t.url || t.title || '');
    if (url.indexOf(LINE_EXT_PREFIX) === 0 && t.type === 'page') {
      return t;
    }
  }
  for (var j = 0; j < targets.length; j++) {
    var u2 = String(targets[j].url || '');
    if (u2.indexOf(LINE_EXT_PREFIX) === 0) return targets[j];
  }
  return null;
}

// 建立 CDP WebSocket 客户端（与 ichigoDeepScrape.js connectTargetWs 同构）
function connectTargetWs(wsUrl) {
  return new Promise(function(resolve, reject) {
    var ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    var seq = { n: 0 };
    var pending = new Map();
    var settled = false;
    ws.on('open', function() {
      if (settled) return;
      settled = true;
      var client = {
        send: function(method, params) {
          seq.n += 1;
          var id = seq.n;
          return new Promise(function(res, rej) {
            var timer = setTimeout(function() {
              pending.delete(id);
              rej(new Error('CDP timeout ' + method));
            }, EVAL_TIMEOUT_MS);
            pending.set(id, {
              resolve: function(v) { clearTimeout(timer); res(v); },
              reject: function(e) { clearTimeout(timer); rej(e); }
            });
            try {
              ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
            } catch (e) {
              clearTimeout(timer);
              pending.delete(id);
              rej(e);
            }
          });
        },
        close: function() { try { ws.close(); } catch (_) {} }
      };
      resolve({ ws: ws, client: client });
    });
    ws.on('message', function(data) {
      var m;
      try { m = JSON.parse(String(data)); } catch (_) { return; }
      if (m.id && pending.has(m.id)) {
        var entry = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) entry.reject(new Error(m.error.message || 'CDP error'));
        else entry.resolve(m.result);
      }
    });
    ws.on('error', function(e) {
      if (!settled) { settled = true; reject(new Error('ws error: ' + e.message)); }
    });
    ws.on('close', function() {
      pending.forEach(function(en) { en.reject(new Error('ws closed')); });
      pending.clear();
      if (!settled) { settled = true; reject(new Error('ws closed before open')); }
    });
  });
}

// 普通求值（同步表达式）
function cdpEval(client, expr) {
  return client.send('Runtime.evaluate', { expression: expr, returnByValue: true }).then(function(res) {
    if (res && res.exceptionDetails) {
      var d = res.exceptionDetails;
      throw new Error('page exception: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
    }
    return res && res.result ? res.result.value : null;
  });
}

// =============================================================================
// 浏览器侧表达式（独立字符串，全用单引号，避免与外层嵌套引号冲突）
// =============================================================================

// 探针表达式：抓 DOM 结构摘要 + 候选选择器命中数
var PROBE_EXPR = '(function(){' +
  'var info = {' +
    'title: document.title || null,' +
    'url: location.href || null,' +
    'bodyTextLen: (document.body && document.body.innerText) ? document.body.innerText.length : 0,' +
    'candidateSelectors: {}' +
  '};' +
  'var candidates = {' +
    "['.chat-list .chat-item']: '会话列表项（推测）'," +
    "['[class*=conversation]']: 'class含conversation（模糊）'," +
    "['[class*=chat-list]']: 'class含chat-list（模糊）'," +
    "['[class*=message-list]']: 'class含message-list（模糊）'," +
    "['[data-testid]']: '有data-testid（通用）'," +
    "['iframe']: '内嵌iframe'," +
    "['.__message']: 'LINE Web消息容器（Web版经验）'," +
    "['[class*=balloon]']: '气泡（推测）'" +
  '};' +
  'Object.keys(candidates).forEach(function(sel){' +
    'try { info.candidateSelectors[sel] = document.querySelectorAll(sel).length; }' +
    'catch(_){ info.candidateSelectors[sel] = -1; }' +
  '});' +
  'info.bodyFirst500 = (document.body && document.body.innerText) ? document.body.innerText.slice(0,500) : null;' +
  'info.topLevel = Array.prototype.slice.call(document.body.children, 0, 12).map(function(el){' +
    'return { tag: el.tagName, id: el.id || null, cls: (el.className && String(el.className).slice(0,80)) || null };' +
  '});' +
  'return info;' +
  '})()';

// 会话列表表达式（selector 由调用方传入，动态拼）
function sessionsExpr(selector) {
  if (selector) {
    return '(function(){' +
      'var items = document.querySelectorAll(' + JSON.stringify(selector) + ');' +
      'var out = [];' +
      'Array.prototype.forEach.call(items, function(el, i){' +
        'if (i >= 50) return;' +
        'out.push({' +
          'idx: i,' +
          "text: (el.innerText || '').trim().slice(0, 200)," +
          "cls: (el.className && String(el.className).slice(0,80)) || null" +
        '});' +
      '});' +
      'return out;' +
      '})()';
  }
  // 回退模式：未指定选择器时返回 body 文本摘要
  return '(function(){' +
    'return {' +
      "note: '未指定稳定选择器，返回body文本摘要，请用probeDom确认selector后重试'," +
      "text: (document.body && document.body.innerText) ? document.body.innerText.slice(0,1500) : null" +
    '};' +
    '})()';
}

// =============================================================================
// 工厂
// =============================================================================

function createLineExtensionAdapter(deps) {
  deps = deps || {};
  var port = deps.cdpPort || CDP_PORT;
  var _connected = null;

  async function acquireClient() {
    if (_connected) {
      if (_connected.ws.readyState === WebSocket.OPEN) return _connected.client;
      try { _connected.close(); } catch (_) {}
      _connected = null;
    }
    var effectivePort = port;
    if (deps.autoDetect !== false) {
      var detected = await detectCdpPort(port);
      if (detected) effectivePort = detected;
    }
    var targets = await retryCdp('getTargets:' + effectivePort, function() { return getTargets(effectivePort); });
    var lineTarget = findLineTarget(targets);
    if (!lineTarget) {
      throw new Error('LINE 扩展页面未在 CDP targets 中找到（CDP 端口 ' + effectivePort + ' 可达，但未匹配 ' + LINE_EXT_PREFIX + '）。请确认：① 已点扩展图标打开 LINE 界面；② 该界面未关闭；③ 扩展 ID 为 ' + LINE_EXT_ID);
    }
    var wsUrl = lineTarget.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error('LINE 扩展 target 缺少 webSocketDebuggerUrl（' + lineTarget.url + '），CDP 需 attach 模式');
    }
    var conn = await retryCdp('connectWs', function() { return connectTargetWs(wsUrl); });
    _connected = conn;
    return conn.client;
  }

  function release() {
    if (_connected) {
      try { _connected.close(); } catch (_) {}
      _connected = null;
    }
  }

  async function health() {
    var effectivePort = port;
    if (deps.autoDetect !== false) {
      var detected = await detectCdpPort(port);
      if (detected) effectivePort = detected;
    }
    var targets;
    try { targets = await retryCdp('health.getTargets:' + effectivePort, function() { return getTargets(effectivePort); }); }
    catch (e) { targets = []; }
    var lineTarget = findLineTarget(targets);
    return {
      ok: !!lineTarget,
      cdpPort: effectivePort,
      cdpPortDetected: effectivePort !== port,
      targetFound: !!lineTarget,
      targetUrl: lineTarget ? lineTarget.url : null,
      targetTitle: lineTarget ? lineTarget.title : null,
      targetsCount: Array.isArray(targets) ? targets.length : 0,
      note: lineTarget ? 'LINE 扩展页面已找到，可读取' : (Array.isArray(targets) && targets.length === 0 ? 'CDP 端口（' + CDP_PORT_CANDIDATES.join('/') + '）均不可达，Chrome 可能未带 --remote-debugging-port 启动' : '未找到 LINE 扩展页面，需先点扩展图标打开界面')
    };
  }

  async function probeDom() {
    var client = await acquireClient();
    var r = await cdpEval(client, PROBE_EXPR);
    release();
    return r || { error: 'evaluate 返回空' };
  }

  async function readSessions(opts) {
    opts = opts || {};
    var selector = opts.selector || null;
    var client = await acquireClient();
    var r = await cdpEval(client, sessionsExpr(selector));
    release();
    return r || { error: 'evaluate 返回空' };
  }

  return {
    health: health,
    probeDom: probeDom,
    readSessions: readSessions,
    release: release,
    meta: {
      extId: LINE_EXT_ID,
      cdpPort: port,
      mode: 'read-only',
      note: 'LINE 官方扩展 CDP 驱动器；写入/发送走独立 adapter + 用户确认（铁律）'
    }
  };
}

// ---------- 直接运行入口（调试用） ----------
if (require.main === module) {
  var mode = process.argv[2] || 'probe';
  var adapter = createLineExtensionAdapter({});
  Promise.resolve()
    .then(function() {
      if (mode === 'health') return adapter.health().then(function(h) { console.log('HEALTH:', JSON.stringify(h, null, 2)); });
      else if (mode === 'sessions') return adapter.readSessions({}).then(function(s) { console.log('SESSIONS:', JSON.stringify(s, null, 2)); });
      else return adapter.probeDom().then(function(p) { console.log('PROBE:', JSON.stringify(p, null, 2)); });
    })
    .catch(function(e) {
      console.error('[line-adapter] 失败:', e && e.message ? e.message : e);
      process.exitCode = 1;
    });
}

module.exports = {
  createLineExtensionAdapter: createLineExtensionAdapter,
  LINE_EXT_ID: LINE_EXT_ID,
  CDP_PORT: CDP_PORT
};
