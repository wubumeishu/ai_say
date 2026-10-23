'use strict';
// =============================================================================
// Ai SAY · 出会窗口抓取器（P1 重构：零导航 + 页面内 fetch）
//
// 关键改造：不再用 location.href 逐页导航，而是在 sp.194964.com 页面上下文里
// 用 fetch(url, {credentials:'include'}) + DOMParser 取回 HTML 并解析。
//   - 窗口全程静止（不跳页、不产生历史记录）
//   - 18 个客户的 history/profile 从 40s 降到 ~2s
//   - 轮询只读收件箱一页，恒定开销
// =============================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

var EVAL_TIMEOUT_MS = 20000;

function loadIconMap(rootDir) {
  var p = path.join(rootDir, 'docs', 'aisay', 'affinity-icons.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).leisure || {}; }
  catch (_) { return {}; }
}

function safeDirName(name) {
  return String(name || '').replace(/[!\u3001\u3002\uff01\uff02\u2605\u2606:\/\*\?\<\>\|\n\r]/g, '').trim() || 'unknown';
}

function connectTargetWs(wsUrl) {
  return new Promise(function(resolve, reject) {
    var ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    var seq = { n: 0 };
    var pending = new Map();
    var settled = false;
    ws.on('open', function() {
      if (settled) return; settled = true;
      var client = {
        send: function(method, params) {
          seq.n += 1; var id = seq.n;
          return new Promise(function(res, rej) {
            var timer = setTimeout(function() { pending.delete(id); rej(new Error('CDP timeout ' + method)); }, EVAL_TIMEOUT_MS);
            pending.set(id, {
              resolve: function(v) { clearTimeout(timer); res(v); },
              reject: function(e) { clearTimeout(timer); rej(e); }
            });
            try { ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); }
            catch (e) { clearTimeout(timer); pending.delete(id); rej(e); }
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
    ws.on('error', function(e) { if (!settled) { settled = true; reject(new Error('ws error: ' + e.message)); } });
    ws.on('close', function() {
      pending.forEach(function(en) { en.reject(new Error('ws closed')); });
      pending.clear();
      if (!settled) { settled = true; reject(new Error('ws closed before open')); }
    });
  });
}

  // task-36 CDP 重试：BitBrowser 每次 /browser/open 换 DevTools 端口，通道偶发断/卡。
  // 对可重试错误（timeout/ECONNREFUSED/socket closed 等）重连后重试，业务错误不重试。
  function isRetryable(err) {
    var m = String((err && err.message) || err || '');
    return /timeout|ECONNREFUSED|ECONNRESET|socket|closed|aborted|Invalid parameters|unresponsive|CDP/i.test(m);
  }
  async function retryCdp(opName, fn, tries) {
    tries = tries || 2;
    var lastErr = null;
    for (var i = 0; i <= tries; i++) {
      try { return await fn(); } catch (e) {
        lastErr = e;
        if (i < tries && isRetryable(e)) {
          console.warn('[cdp-retry] ' + opName + ' 第 ' + (i + 1) + ' 次失败（' + String((e && e.message) || e) + '），重连重试…');
          await new Promise(function(r) { setTimeout(r, 1200); });
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
function getTargets(httpPort) {
  var host = '127.0.0.1';
  var port = httpPort;
  if (typeof httpPort === 'string' && httpPort.indexOf(':') !== -1) {
    var parts = httpPort.split(':');
    host = parts[0] || '127.0.0.1';
    port = parseInt(parts[1], 10);
  }
  port = Number(port);
  return new Promise(function(resolve, reject) {
    var req = http.get({ host: host, port: port, path: '/json/list' }, function(res) {
      var buf = '';
      res.on('data', function(d) { buf += d; });
      res.on('end', function() { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, function() { req.destroy(new Error('json/list timeout')); });
  });
}

function readExpr(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function createIchigoDeepScrape(deps) {
  deps = deps || {};
  var rootDir = deps.rootDir || path.join(__dirname, '..', '..');
  var iconMap = deps.iconMap || loadIconMap(rootDir);

  var mailboxExprSrc     = readExpr(path.join(__dirname, 'ichigoMailboxExpr.js'));
  var blockExprSrc       = readExpr(path.join(__dirname, 'ichigoBlockExpr.js')); // 模块1 · 拉黑联动真实窗口
  var historyExprSrc     = readExpr(path.join(__dirname, 'ichigoHistoryExpr.js'));
  var profileFetchSrc    = readExpr(path.join(__dirname, 'ichigoProfileFetchExpr.js'));
  // 兼容旧文件（若新文件缺失）
  var inboxExpr          = readExpr(path.join(__dirname, 'ichigoInboxExpr.js'));
  var profileExprLegacy  = readExpr(path.join(__dirname, 'ichigoProfileExpr.js'));
  var sendExprSrc        = readExpr(path.join(__dirname, 'ichigoSendExpr.js'));
  var networkExprSrc     = readExpr(path.join(__dirname, 'ichigoNetworkExpr.js'));
  var bbsQueryExprSrc   = readExpr(path.join(__dirname, 'ichigoBbsQueryExpr.js'));
  var bbsWriteExprSrc   = readExpr(path.join(__dirname, 'ichigoBbsWriteExpr.js'));

  // ---------- 工具 ----------
  function parseContactName(raw) {
    if (!raw) return null;
    var parts = String(raw).split('|').map(function(s) { return s.trim(); }).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (/^[♂♀]/.test(p) || /さん/.test(p)) return p.replace(/^[♂♀]\s*/, '').trim();
    }
    for (var j = 0; j < parts.length; j++) {
      var p2 = parts[j];
      if (/^[\d/]+/.test(p2)) continue;
      if (/^「|^“/.test(p2)) continue;
      if (/^[\d]+歳/.test(p2)) continue;
      if (/[ぁ-んァ-ヶ一-龯]/.test(p2)) return p2;
    }
    if (parts[1]) return parts[1].replace(/^[♂♀]\s*/, '').trim();
    return null;
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

  // 异步求值（页面内 fetch 用；awaitPromise）
  function cdpEvalAsync(client, expr) {
    return client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(function(res) {
      if (res && res.exceptionDetails) {
        var d = res.exceptionDetails;
        throw new Error('page exception: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
      }
      return res && res.result ? res.result.value : null;
    });
  }

  // 兴趣 icon → { icon, label, unknown }（必须在 fetchProfile 内富化，
  // 否则 profile.interestIcons 保持裸字符串，前端读 .label 得到 undefined）
  function enrichInterests(icons) {
    return (icons || []).map(function(ic) {
      var key = String(ic == null ? '' : ic);
      var lb = iconMap[key];
      return { icon: key, label: lb || null, unknown: !lb };
    });
  }

  
  // BBS 查询表达式注入（__BBS_OPTS__ = JSON opts）
  
  // BBS 改/增帖表达式注入（__BBS_WRITE_OPTS__ = JSON { title, body }）
  function fillBbsWriteOpts(exprSrc, url, writeOpts) {
    var injected = (url === null || url === undefined) ? 'null' : JSON.stringify(String(url));
    var o = (writeOpts === null || writeOpts === undefined) ? 'null' : JSON.stringify(writeOpts);
    return exprSrc.replace('__URL__', injected).replace('__BBS_WRITE_OPTS__', o);
  }
function fillBbsOpts(exprSrc, url, bbsOpts) {
    var injected = (url === null || url === undefined) ? 'null' : JSON.stringify(String(url));
    var optsInjected = (bbsOpts === null || bbsOpts === undefined) ? 'null' : JSON.stringify(bbsOpts);
    return exprSrc.replace('__URL__', injected).replace('__BBS_OPTS__', optsInjected);
  }

function fillUrl(exprSrc, url, isAccount, customerName, mode) {
    // url 为 null/undefined → 注入 JS null（表示"用当前页面"），不能变成字符串 "null"
    var injected = (url === null || url === undefined) ? 'null' : JSON.stringify(String(url));
    // customerName 支持字符串或数组（JSON.stringify 直接注入，数组保持为 JS 数组字面量）
    var nameInjected = (customerName === null || customerName === undefined) ? 'null' : JSON.stringify(customerName);
    // 2026-10-23 实测补：__MODE__ 占位符替换（ichigoBlockExpr.js 尾参；缺省 'execute'）
    var modeInjected = (mode === null || mode === undefined) ? JSON.stringify('execute') : JSON.stringify(String(mode));
    return exprSrc.replace('__URL__', injected)
      .replace('__CUSTOMER_NAME__', nameInjected)
      .replace('__ACCOUNT__', isAccount ? 'true' : 'false')
      .replace('__MODE__', modeInjected);
  }

  // ---------- 统一目标会话（自动清理 + 硬超时） ----------
  // fn(client) => Promise；无论成功失败都关闭 ws 和浏览器级 session
  function withTargetOnce(fn) {
    var session = null;
    return Promise.resolve()
      .then(function() { return deps.openCdpSession(); })
      .then(function(s) {
        session = s;
        if (!s || !s.http) throw Object.assign(new Error('no-cdp-port'), { reason: 'no-cdp-port' });
        return getTargets(s.http);
      })
      .then(function(targets) {
        var sp = (Array.isArray(targets) ? targets : []).find(function(t) {
          return t && t.type === 'page' && String(t.url || '').indexOf('sp.194964.com') !== -1;
        });
        if (!sp) throw Object.assign(new Error('no-sp-target'), { reason: 'no-sp-target' });
        // 先关浏览器级 session，再连 target ws（避免双会话冲突）
        try { session.close(); } catch (_) {}
        session = null;
        return connectTargetWs(sp.webSocketDebuggerUrl);
      })
      .then(function(wsClient) {
        var done = false;
        function finish() { if (done) return; done = true; try { wsClient.client.close(); } catch (_) {} }
        return Promise.resolve()
          .then(function() { return fn(wsClient.client); })
          .then(function(v) { finish(); return v; }, function(e) { finish(); throw e; });
      })
      .catch(function(e) {
        if (session) { try { session.close(); } catch (_) {} }
        throw e;
      });
  }

  // task-36：withTarget 对外入口加 CDP 重试（通道级错误重连重试，业务错误直抛）
  function withTarget(fn) {
    return retryCdp('withTarget', function() { return withTargetOnce(fn); });
  }

  // 并发池
  function pool(items, limit, worker) {
    var results = new Array(items.length);
    var idx = 0;
    function next() {
      if (idx >= items.length) return Promise.resolve();
      var i = idx++;
      return Promise.resolve(worker(items[i], i))
        .then(function(v) { results[i] = v; }, function(e) { results[i] = { __error: String(e && e.message || e) }; })
        .then(next);
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(next());
    return Promise.all(runners).then(function() { return results; });
  }

  // ---------- ① 收件箱快照（抓全部分页；轻量轮询用） ----------
  function mailboxOnly(opts) {
    opts = opts || {};
    var allPages = opts.allPages !== false;   // 默认抓全部页
    var maxPages = opts.maxPages || 5;
    return withTarget(function(client) {
      return cdpEval(client, 'location.href').then(function(currentUrl) {
        var u = String(currentUrl || '');
        var onInbox = u.indexOf('show_mailbox') !== -1;
        var firstExpr = fillUrl(mailboxExprSrc, null);
        if (onInbox) return cdpEvalAsync(client, firstExpr);
        var INBOX = 'https://sp.194964.com/mail/inbox/show_mailbox.html';
        return cdpEval(client, "location.href=" + JSON.stringify(INBOX) + ";")
          .then(function() { return new Promise(function(r) { setTimeout(r, 3500); }); })
          .then(function() { return cdpEvalAsync(client, firstExpr); });
      }).then(function(page1) {
        if (!page1 || !Array.isArray(page1.contacts)) return { ok: false, reason: 'mailbox-parse-empty' };
        var contacts = page1.contacts.slice();
        var seen = {};
        contacts.forEach(function(c) { if (c.contactId) seen[c.contactId] = true; });
        var pageUrls = (page1.pageUrls || []).slice(0, maxPages);
        if (!allPages || !pageUrls.length) {
          return { ok: true, pages: 1, contacts: contacts };
        }
        // 逐页页面内 fetch（零导航）
        var chain = Promise.resolve();
        var fetched = 1;
        pageUrls.forEach(function(pu) {
          chain = chain.then(function() {
            var e = fillUrl(mailboxExprSrc, pu.url);
            return cdpEvalAsync(client, e).then(function(pg) {
              if (pg && Array.isArray(pg.contacts)) {
                pg.contacts.forEach(function(c) { if (c.contactId && !seen[c.contactId]) { seen[c.contactId] = true; contacts.push(c); } });
                fetched++;
              }
            }).catch(function() { /* 单页失败不阻断 */ });
          });
        });
        return chain.then(function() { return { ok: true, pages: fetched, contacts: contacts }; });
      });
    }).then(function(res) {
      if (!res.ok) return res;
      var list = res.contacts || [];
      list.forEach(function(c) {
        if (!c.name && c.raw) c.name = parseContactName(c.raw);
        if (c.contactId == null && c.link) {
          var m = String(c.link).match(/[?&]q=([^&#]+)/);
          c.contactId = m ? decodeURIComponent(m[1]) : c.link;
        }
      });
      return { ok: true, fetchedAt: new Date().toISOString(), contacts: list, count: list.length, pages: res.pages };
    }).catch(function(e) {
      return { ok: false, reason: e.reason || 'mailbox-scan-failed', msg: String(e && e.message || e) };
    });
  }

  // ---------- ② 会话历史（页面内 fetch，零导航） ----------
  function fetchHistory(historyUrl) {
    if (!historyExprSrc) return Promise.resolve({ ok: false, reason: 'no-history-expr' });
    var expr = fillUrl(historyExprSrc, historyUrl);
    return withTarget(function(client) {
      return cdpEvalAsync(client, expr);
    }).catch(function(e) {
      return { ok: false, reason: 'history-fetch-failed', msg: String(e && e.message || e) };
    });
  }

  // ---------- ③ 资料卡（页面内 fetch，零导航，永久缓存） ----------
  function fetchProfile(profileUrl, opts) {
    if (!profileFetchSrc) return Promise.resolve({ ok: false, reason: 'no-profile-expr' });
    var expr = fillUrl(profileFetchSrc, profileUrl, !!(opts && opts.isAccount));
    return withTarget(function(client) {
      return cdpEvalAsync(client, expr);
    }).then(function(v) {
      if (v && v.ok !== false && Array.isArray(v.interestIcons)) {
        v.interestIcons = enrichInterests(v.interestIcons);
      }
      return v;
    }).catch(function(e) {
      return { ok: false, reason: 'profile-fetch-failed', msg: String(e && e.message || e) };
    });
  }

  // ---------- ③b 账号自己的资料卡（snsmypage/show_profile.html）----------
  var ACCOUNT_PROFILE_URL = 'https://sp.194964.com/sns/snsmypage/show_profile.html';
  function fetchAccountProfile(url) {
    return fetchProfile(url || ACCOUNT_PROFILE_URL, { isAccount: true });
  }

  // ---------- ④ 一次 CDP 会话内批量取多个 URL（复用连接，最快） ----------
  // jobs: [{ kind:'history'|'profile', url, key }]
  function fetchBatch(jobs, concurrency) {
    if (!jobs.length) return Promise.resolve({ ok: true, results: [] });
    return withTarget(function(client) {
      return pool(jobs, concurrency || 4, function(job) {
        var expr = job.kind === 'profile'
          ? fillUrl(profileFetchSrc, job.url)
          : fillUrl(historyExprSrc, job.url);
        return cdpEvalAsync(client, expr).then(function(v) {
          // profile 结果统一富化兴趣（否则 interestIcons 是裸字符串，前端读 .label 得 undefined）
          if (job.kind === 'profile' && v && v.ok !== false && Array.isArray(v.interestIcons)) {
            v.interestIcons = enrichInterests(v.interestIcons);
          }
          return { key: job.key, kind: job.kind, ok: !!(v && v.ok !== false), data: v };
        });
      });
    }).then(function(results) {
      return { ok: true, results: results };
    }).catch(function(e) {
      return { ok: false, reason: 'batch-failed', msg: String(e && e.message || e), results: [] };
    });
  }

  // ---------- ⑤ 兼容旧 deepScrape：收件箱 + 每客户 history/profile ----------
  async function deepScrape(opts) {
    opts = opts || {};
    var maxContacts = opts.maxContacts || deps.maxContacts || 3;
    var wantHistory = opts.withHistory !== false;
    var wantProfile = opts.withProfile !== false;
    var concurrency = opts.concurrency || 4;

    // 1) 收件箱
    var mail = await mailboxOnly();
    if (!mail.ok) return { ok: false, reason: mail.reason, msg: mail.msg };

    var contacts = (mail.contacts || []).slice();
    var targets = contacts.slice(0, maxContacts);

    // 2) 批量取 history + profile（一次连接）
    var jobs = [];
    targets.forEach(function(c, i) {
      if (wantHistory && c.historyUrl) jobs.push({ kind: 'history', url: c.historyUrl, key: c.contactId || ('idx' + i) });
      if (wantProfile) {
        // profile URL 需要从 history 页里取，这里先用 history 结果里的链接；
        // 若无 history，则跳过 profile（改由前端按需触发）
        c.__needProfile = true;
      }
    });

    var histRes = await fetchBatch(jobs.filter(function(j) { return j.kind === 'history'; }), concurrency);
    var histByKey = {};
    (histRes.results || []).forEach(function(r) {
      if (r && r.key && r.data && r.data.ok !== false) histByKey[r.key] = r.data;
    });

    // 挂上 messages + 收集 profileUrl
    var profJobs = [];
    targets.forEach(function(c, i) {
      var key = c.contactId || ('idx' + i);
      var h = histByKey[key];
      if (h) {
        c.messages = h.messages || [];
        c.messagesFetchedAt = new Date().toISOString();
        c.avatarIsDefault = !!h.avatarIsDefault;
        if (h.avatarUrl && !h.avatarIsDefault) { c.avatarUrl = h.avatarUrl; }
        c.profileUrl = h.profileUrl || c.profileUrl || '';
        if (wantProfile && c.profileUrl) profJobs.push({ kind: 'profile', url: c.profileUrl, key: key });
      } else {
        c.messages = [];
      }
    });

    // 批量抓 profile（页面内 fetch，零导航）
    if (profJobs.length) {
      var profRes = await fetchBatch(profJobs, concurrency);
      var profByKey = {};
      (profRes.results || []).forEach(function(r) {
        if (r && r.key && r.data && r.data.ok !== false) profByKey[r.key] = r.data;
      });
      targets.forEach(function(c, i) {
        var key = c.contactId || ('idx' + i);
        var pr = profByKey[key];
        if (pr) {
          c.profile = pr;
          c.profileFetchedAt = new Date().toISOString();
          // profile.interestIcons 已在 fetchProfile 内富化为对象
          c.interests = (pr.interestIcons || []).map(function(x) {
            return (typeof x === 'object' && x) ? x : { icon: String(x), label: iconMap[String(x)] || null, unknown: !iconMap[String(x)] };
          });
          if (pr.avatarUrl && !pr.avatarIsDefault) { c.avatarUrl = pr.avatarUrl; c.avatarIsDefault = false; }
        }
      });
    }

    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      contacts: contacts,
      total: contacts.length,
      enriched: targets.length,
      profiles: profJobs.length,
      from: 'in-page-fetch',
      paginator: mail.paginator || null
    };
  }

  // ---------- ⑥ 真实消息发送（填输入框 + 确认弹窗 + 提交） ----------
  // sendToContact(historyUrl, text, { doConfirm, waitMs }) → 在目标会话页真发一条消息。
  //   - 先 Page.navigate 到 historyUrl（确保在目标会话上，防止发错人）；
  //   - 执行 ichigoSendExpr（原生 setter 填充 textarea → 点 #sendButton → 等确认弹窗 → 点 #submitBtn）；
  //   - 返回 { ok, step, reason, via, sentAt }。调用方负责把窗口切回收件箱。
  function sendToContact(historyUrl, text, opts) {
    opts = opts || {};
    var message = String(text == null ? '' : text).trim();
    if (!message) return Promise.resolve({ ok: false, reason: 'empty-message' });
    if (!historyUrl) return Promise.resolve({ ok: false, reason: 'no-history-url' });
    if (!sendExprSrc) return Promise.resolve({ ok: false, reason: 'no-send-expr' });
    var doConfirm = opts.doConfirm !== false;   // 默认走确认流程
    var waitMs = Number(opts.waitMs) || 6000;
    var expr = sendExprSrc.replace('__MSG__', JSON.stringify(message))
      .replace('__DO_CONFIRM__', doConfirm ? 'true' : 'false')
      .replace('__WAIT_MS__', String(waitMs));
    return withTarget(function(client) {
      return Promise.resolve()
        // 1) 切到目标会话页（Page.navigate 比 location.href 更可靠）
        .then(function() { return client.send('Page.enable'); })
        .then(function() { return client.send('Page.navigate', { url: historyUrl }); })
        .then(function() { return new Promise(function(r) { setTimeout(r, 5000); }); })
        // 2) 校验当前页确实进入了 show_history
        .then(function() { return cdpEvalAsync(client, 'location.href'); })
        .then(function(href) {
          if (String(href || '').indexOf('show_history.html') === -1) {
            return { ok: false, reason: 'wrong-page', url: String(href) };
          }
          // 3) 执行发送表达式（填框 + 确认 + 提交）
          return cdpEvalAsync(client, expr).then(function(v) {
            if (!v || v.ok === false) return Object.assign({ ok: false, via: 'in-page-send' }, v);
            return Object.assign({ ok: true, sent: true, via: 'in-page-send', sentAt: new Date().toISOString() }, v);
          });
        });
    }).then(function(res) {
      if (res && res.ok === false) return res;
      return res;
    }).catch(function(e) {
      return { ok: false, reason: 'send-failed', msg: String(e && e.message || e) };
    });
  }
  // ---------- ⑦ 切回收件箱（发送后 / 需要静止窗口时使用） ----------
  // navigateInbox() → 把出会窗口 location 切到 show_mailbox.html，避免停留在会话页中断后续操作。
  // 模块1 · 拉黑/删除联动真实窗口：在收件箱（show_mailbox.html）页执行真实 5 步 DOM 链路
  //   Step1 点「編集」→ Step2 按客户名勾 N 个 checkbox → Step3 点「チェックを削除する」
  //   → Step4 检测 show_mail_delete.html 二次确认页 → Step5 点「削除する」确认删除
  // 2026-10-23 实测（总控）：
  //   * 同时勾 2 客户 → 平台合并成 1 个确认页（不是逐人 N 次）
  //   * 点「削除する」后平台不一定自动回 inbox（实测停在确认页），必须显式导航回收件箱
  //   * 客户名 customerName 支持字符串或数组（一次删多位）
  // 传参：customerName（客户显示名，字符串或数组）；opts.refreshMailbox=true 时删除成功后强制重抓收件箱
  // 返回 { ok, step, reason, note, matched, checkedCount, missed, partialMiss, confirmPage, needNavBack, mailboxNav, via }
  //   客户/按钮找不到 → ok:false（不抛错，端点转 queued）
  // ---------- 模块3 · BBS 帖子查询（只读，POST ajax 端点 + 解析卡片） ----------
  // queryBbsPosts(opts) → { ok, posts[], total, page, genre, board, via }
  // opts: { genre, page, count, prefId, hokkaidoFlag, board, ajaxUrl }
  // 在出会窗口（sp.194964.com）页面上下文执行；窗口未连上 → ok:false + cdp-unavailable
  function queryBbsPosts(opts) {
    opts = opts || {};
    if (!bbsQueryExprSrc) return Promise.resolve({ ok: false, reason: 'no-bbs-expr', msg: 'ichigoBbsQueryExpr.js 缺失' });
    return withTarget(function(client) {
      // 确保在 sp.194964.com 域（不强制导航到 show_bbs，fetch 同域即可；但在 menu 页也行）
      return cdpEval(client, 'location.hostname').then(function(host) {
        if (String(host || '').indexOf('194964.com') === -1) {
          // 导航到 show_bbs（拿 ajax 端点需要平台域，menu 页也行）
          return client.send('Page.navigate', { url: 'https://sp.194964.com/menu.html' })
            .then(function() { return new Promise(function(r) { setTimeout(r, 3000); }); });
        }
        return null;
      }).then(function() {
        var expr = fillBbsOpts(bbsQueryExprSrc, null, opts);
        return cdpEvalAsync(client, expr);
      }).then(function(v) {
        v = v || {};
        v.via = v.via || 'cdp-bbs-query';
        return v;
      }).catch(function(e) {
        return { ok: false, reason: 'cdp-error', msg: String((e && e.message) || e) };
      });
    }).catch(function(e) {
      return { ok: false, reason: 'cdp-unavailable', msg: String((e && e.message) || e) };
    });
  }
  // ---------- 模块3 阶段2 · BBS 改/增帖（强副作用，需总控确认后才调） ----------
  // bbsWritePost(targetBbsId, writeOpts) → 导航到该帖编辑页 → 跑 write 表达式 → 回列表页
  // writeOpts: { title?, body? }（只传要改的字段；不传的保持平台原值）
  // 返回 { ok, step, reason, note, submitted, resultUrl, via }
  function bbsWritePost(targetBbsId, writeOpts) {
    writeOpts = writeOpts || {};
    if (!bbsWriteExprSrc) return Promise.resolve({ ok: false, reason: 'no-bbs-write-expr', msg: 'ichigoBbsWriteExpr.js 缺失' });
    if (!targetBbsId) return Promise.resolve({ ok: false, reason: 'missing-targetBbsId', msg: '缺少 targetBbsId（帖子 ID）' });
    return withTarget(function(client) {
      return cdpEval(client, 'location.href').then(function(cur) {
        var u = String(cur || '');
        // 已在该帖编辑页 → 直接跑；否则导航
        if (u.indexOf('show_bbs_write_edit.html?targetBbsId=' + targetBbsId) === -1) {
          return client.send('Page.navigate', { url: 'https://sp.194964.com/bbs/show_bbs_write_edit.html?targetBbsId=' + encodeURIComponent(String(targetBbsId)) })
            .then(function() { return new Promise(function(r) { setTimeout(r, 4000); }); });
        }
        return new Promise(function(r) { setTimeout(r, 500); });
      }).then(function() {
        var expr = fillBbsWriteOpts(bbsWriteExprSrc, null, writeOpts);
        return cdpEvalAsync(client, expr);
      }).then(function(v) {
        v = v || {};
        v.via = v.via || 'cdp-bbs-write';
        // 提交后回招募历史列表页（窗口静止，便于后续操作）
        if (v.ok) {
          return client.send('Page.navigate', { url: 'https://sp.194964.com/bbs/show_bbs_write_list.html' })
            .then(function() { return new Promise(function(r) { setTimeout(r, 2000); }); })
            .then(function() { v.backToList = true; return v; });
        }
        return v;
      }).catch(function(e) {
        return { ok: false, reason: 'cdp-error', msg: String((e && e.message) || e) };
      });
    }).catch(function(e) {
      return { ok: false, reason: 'cdp-unavailable', msg: String((e && e.message) || e) };
    });
  }
  function blockContact(customerName, opts) {
    opts = opts || {};
    // 接受字符串或数组（向后兼容）
    var names = Array.isArray(customerName) ? customerName : [customerName];
    return withTarget(function(client) {
      // 先确保窗口在普通收件箱页（show_mailbox.html，非编辑模式）
      return cdpEval(client, 'location.href').then(function(cur) {
        var u = String(cur || '');
        // 2026-10-23 实测：窗口可能残留在 show_mail_delete.html（前次删除未走完）
        //   或编辑模式（?q=）/ 其他页 → 一律先回普通收件箱
        if (u.indexOf('show_mail_delete') !== -1 || u.indexOf('show_mailbox.html?q=') !== -1 || u.indexOf('show_mailbox') === -1) {
          return cdpEval(client, 'location.href=' + JSON.stringify('https://sp.194964.com/mail/inbox/show_mailbox.html') + ';')
            .then(function() { return new Promise(function(r) { setTimeout(r, 3000); }); });
        }
        return new Promise(function(r) { setTimeout(r, 500); });
      }).then(function() {
        // Step1 preflight：拿编辑模式 href（不导航，避免销毁 CDP 上下文）
        // stuck-confirm-page 自愈：窗口残留 show_mail_delete.html 时，nav 回 inbox 后重试 preflight 1 次
        var preExpr = fillUrl(blockExprSrc, null, false, null, 'preflight');
        return cdpEvalAsync(client, preExpr);
      }).then(function(pre) {
        pre = pre || {};
        if (pre.step === 'stuck-confirm-page') {
          return client.send('Page.navigate', { url: 'https://sp.194964.com/mail/inbox/show_mailbox.html' })
            .then(function() { return new Promise(function(r) { setTimeout(r, 3000); }); })
            .then(function() { return cdpEvalAsync(client, preExpr); });
        }
        return pre;
      }).then(function(pre) {
        pre = pre || {};
        if (!pre.ok) return { ok: false, step: pre.step || 'preflight', reason: pre.reason || 'preflight-failed', note: pre.note || '', via: 'cdp-block-expr-5step' };
        if (!pre.editHref) return { ok: false, step: 'preflight', reason: 'no-edit-href', note: 'preflight 成功但未返回 editHref', via: 'cdp-block-expr-5step' };
        // 导航到编辑模式（浏览器自带 session，token 新鲜）
        return client.send('Page.enable').then(function() {
          return client.send('Page.navigate', { url: pre.editHref });
        }).then(function() {
          return new Promise(function(r) { setTimeout(r, 4000); });
        });
      }).then(function() {
        // Step2~5 execute：勾 checkbox + 删除 + 确认页处理
        var expr = fillUrl(blockExprSrc, null, false, names, 'execute');
        return cdpEvalAsync(client, expr);
      }).then(function(v) {
        v = v || {};
        var result = {
          ok: !!v.ok, step: v.step || null, reason: v.reason || '',
          note: v.note || '',
          matched: v.matched || null,
          checkedCount: v.checkedCount != null ? v.checkedCount : (v.matched ? v.matched.length : null),
          missed: v.missed || [],
          partialMiss: !!v.partialMiss,
          confirmPage: !!v.confirmPage,
          stillOnConfirm: !!v.stillOnConfirm,
          needNavBack: !!v.needNavBack,
          stuckConfirmPage: v.step === 'stuck-confirm-page',
          via: 'cdp-block-expr-5step'
        };
        // 2026-10-23 实测：点「削除する」后平台不一定自动回 inbox（同时删 2 客户停在确认页），
        // 因此 needNavBack=true 或 refreshMailbox !== false 时，强制显式导航回收件箱
        var mustNavBack = result.needNavBack || (opts.refreshMailbox !== false && result.ok);
        if (mustNavBack) {
          return client.send('Page.navigate', { url: 'https://sp.194964.com/mail/inbox/show_mailbox.html' })
            .then(function() { return new Promise(function(r) { setTimeout(r, 3000); }); })
            .then(function() {
              result.mailboxNav = true;
              // 验证回收件箱后客户列表（可选，verify 默认开）
              if (opts.verify !== false && result.ok) {
                return cdpEvalAsync(client, "(function(){var conts=document.querySelectorAll('.contentsContribute');var names=[];conts.forEach(function(c){var p=c.querySelector('.namelstProf, p');if(p)names.push(String(p.textContent||'').trim().replace(/\\s+/g,' ').slice(0,30));});return JSON.stringify({count:conts.length,names:names});})()")
                  .then(function(verifyRaw) {
                    try {
                      var vr = JSON.parse(String(verifyRaw || '{}'));
                      result.remaining = vr.names || [];
                      result.remainingCount = vr.count || 0;
                    } catch (_) { result.verifyFailed = true; }
                    return result;
                  });
              }
              return result;
            });
        }
        return result;
      }).catch(function(e) {
        return { ok: false, reason: 'cdp-error', msg: String((e && e.message) || e) };
      });
    }).catch(function(e) {
      return { ok: false, reason: 'cdp-unavailable', msg: String((e && e.message) || e) };
    });
  }

  function navigateInbox() {
    var INBOX = 'https://sp.194964.com/mail/inbox/show_mailbox.html';
    return withTarget(function(client) {
      return client.send('Page.enable')
        .then(function() { return client.send('Page.navigate', { url: INBOX }); })
        .then(function() { return new Promise(function(r) { setTimeout(r, 3000); }); })
        .then(function() { return cdpEvalAsync(client, 'location.href'); })
        .then(function(href) {
          return { ok: String(href || '').indexOf('show_mailbox') !== -1, url: String(href) };
        });
    }).catch(function(e) {
      return { ok: false, reason: 'navigate-inbox-failed', msg: String(e && e.message || e) };
    });
  }
  // ---------- ⑧ 网络体检（只读：出口 IP / 平台连通 / 归因诊断） ----------
  // networkHealth() → 在出会窗口页面上下文做三项探测：
  //   exitIp（出口 IP：ipinfo 优先、ipify 兜底）+ platform（sp.194964.com 轻量连通）
  //   diagnosis：归因结论（正常 / 网络问题 / 平台问题 / CDP 卡住）
  // 约束：纯只读，不改窗口任何配置；任何一步失败都返回结构化结果，不抛错。
  function networkHealth() {
    if (!networkExprSrc) return Promise.resolve({ ok: false, reason: 'no-network-expr', diagnosis: '网络体检表达式缺失' });
    return withTarget(function (client) {
      return cdpEvalAsync(client, networkExprSrc).then(function (v) {
        v = v || {};
        if (v.exitIp && v.platform && v.platform.ok) v.diagnosis = '正常：出口 ' + (v.exitIp.ip || '?') + ' · 平台 ' + v.platform.ms + 'ms';
        else if (!v.exitIp && v.platform && v.platform.ok) v.diagnosis = 'IP 检测服务不可达（平台可达，可忽略）';
        else if (v.exitIp && !(v.platform && v.platform.ok)) v.diagnosis = '平台问题：出口 ' + (v.exitIp.ip || '?') + ' 正常但 sp.194964.com 不可达';
        else v.diagnosis = '网络问题：出口 IP 探测不到且平台不可达（代理断开 / 本地波动）';
        return { ok: true, health: v, fetchedAt: new Date().toISOString() };
      });
    }).catch(function (e) {
      return { ok: false, reason: 'cdp-unavailable', diagnosis: 'CDP 卡住：连不上出会窗口（BitBrowser 未开 / 窗口未开 / CDP 超时）', msg: String((e && e.message) || e) };
    });
  }
  return {
    mailboxOnly: mailboxOnly,
    fetchHistory: fetchHistory,
    sendToContact: sendToContact,
    blockContact: blockContact,
    queryBbsPosts: queryBbsPosts,
    bbsWritePost: bbsWritePost,
    navigateInbox: navigateInbox,
    networkHealth: networkHealth,
    fetchProfile: fetchProfile,
    fetchAccountProfile: fetchAccountProfile,
    ACCOUNT_PROFILE_URL: ACCOUNT_PROFILE_URL,
    fetchBatch: fetchBatch,
    deepScrape: deepScrape,
    parseContactName: parseContactName,
    enrichInterests: enrichInterests,
  };
}

module.exports = {
  createIchigoDeepScrape: createIchigoDeepScrape,
  safeDirName: safeDirName,
  connectTargetWs: connectTargetWs,
  getTargets: getTargets
};
