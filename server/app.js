const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { createStore } = require('./store');
const http = require('http');
const { BitBrowserClient } = require('./bitbrowser');
const { DevToolsClient } = require('./devtools');
const { MessageMonitor } = require('./messageMonitor');
const {
  COMMON_PHRASES,
  buildRecommendation,
  translateToChinese
} = require('./translator');
const { summarizeProfile, planPatch, buildProfileInspect } = require('./profileInspector');
const { SessionPool } = require('./sessionPool');
const devtoolsTargets = require('./devtoolsTargets');

// Module-level helpers (moved out of createApp so the session pool can reuse them)
const DEFAULT_API_BASE = 'http://127.0.0.1:54345';
const { loadAiSettings, saveAiSettings, publicSettings, aiTranslate, aiUnderstandPage, aiRecommendReply } = require('./aiService');
const {
  buildProfileScanJs,
  buildNavigateProfileJs,
  detectProfilePage,
  detectNextLevelPages,
  parseBottomNav
} = require('./profileScan');
const {
  buildMessagePageScanJs,
  summarizeMessagePage,
  translateMessages,
  detectPeerName
} = require('./messagePageScanner');

const CONFIG_PATH = path.join(__dirname, '..', 'settings.json');

const DEFAULT_PROFILE_ENTRY_PATTERNS = [
  'show_profile',
  'profile',
  'mypage',
  'my-page',
  'account',
  'userinfo',
  'user-info',
  'マイページ',
  'プロフィール',
  '我的',
  '资料',
  '账户',
  '账号',
  '个人'
];

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function looksLikeProfileUrl(url, patterns) {
  const text = String(url || '').toLowerCase();
  if (!text) return false;
  const list = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_PROFILE_ENTRY_PATTERNS;
  return list.some((p) => {
    const pp = String(p).toLowerCase();
    return pp && text.indexOf(pp) !== -1;
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Target discovery helpers moved to ./devtoolsTargets; these thin wrappers keep
// the module-local call sites (and any external tests that import them) working.
async function fetchDevtoolsTargetList(hostPort) {
  return devtoolsTargets.fetchDevtoolsTargetList(hostPort);
}
function isLocalHost(url) { return devtoolsTargets.isLocalHost(url); }
function isProfileDisplayUrl(url) { return devtoolsTargets.isProfileDisplayUrl(url); }
function pickProfileTarget(targets, patterns) {
  return devtoolsTargets.pickProfileTarget(targets, Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_PROFILE_ENTRY_PATTERNS);
}

async function fetchProfileScan(client) {
  const evalRes = await client.evaluate(buildProfileScanJs(), null).catch((e) => {
    console.error('[profile-scan] evaluate error:', e && e.message);
    return { value: null };
  });
  if (!evalRes || evalRes.value === undefined || evalRes.value === null) {
    console.error('[profile-scan] evaluate returned no value, raw:', JSON.stringify(evalRes).slice(0, 300));
  }
  return (evalRes && evalRes.value) || null;
}

function createApp(config = {}) {
  const apiBase = config.apiBase || process.env.BIT_BROWSER_API_URL || 'http://127.0.0.1:54345';
  const bit = new BitBrowserClient(apiBase);
  const store = createStore();
  const monitors = new Map();
  const pool = new SessionPool({ bit, apiBase, log: config.log || console });

  // Run fn on a pooled DevTools session for the given window, wrapping
  // connection-level failures as { ok: false, msg } instead of throwing.
  async function withPooledSession(browserId, fn) {
    try {
      return await pool.withSession(browserId, fn);
    } catch (err) {
      return { ok: false, msg: String((err && err.message) || err) };
    }
  }

  function startMonitor(browserId, wsUrl, opts = {}) {
    if (monitors.has(browserId)) monitors.get(browserId).stop();
    const client = new DevToolsClient(wsUrl);
    const monitor = new MessageMonitor({
      devtoolsClient: client,
      browserId,
      pollInterval: opts.pollInterval,
      onMessage: opts.onMessage
    });
    return client.connect()
      .then(() => {
        monitor.start();
        monitors.set(browserId, monitor);
        pool.adopt(browserId, client);
        return { ok: true, browserId };
      })
      .catch((err) => {
        monitor.stop();
        pool.release(browserId);
        return { ok: false, msg: err.message };
      });
  }

  async function inspectBrowserPage(body) {
    const browserId = body.id || body.browserId;
    if (!browserId) return { ok: false, msg: '缺少窗口 ID（id）' };
    return withPooledSession(browserId, async (client) => {
      const targets = await client.send('Target.getTargets');
      const targetInfos = (targets && targets.targetInfos) || [];
      const page =
        targetInfos.find((t) => t.type === 'page' && t.attached) ||
        targetInfos.find((t) => t.type === 'page') ||
        targetInfos[0] ||
        null;
      let targetId = page ? page.targetId : null;
      let text = '';
      if (targetId) {
        const script = '(function(){return (document.body && document.body.innerText) || (document.documentElement && document.documentElement.innerText) || "";})()';
        const evalRes = await client.evaluate(script, targetId).catch(() => ({ value: '' }));
        text = String(evalRes.value || '');
      }
      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
      const unique = [];
      for (const line of lines) {
        if (line && !unique.includes(line)) unique.push(line);
      }
      let buttons = '';
      if (targetId) {
        const btnRes = await client.evaluate('(function(){return Array.from(document.querySelectorAll("button,[role=button],a,.clickable")).slice(0,50).map(function(e){return (e.innerText||e.textContent||"").trim().slice(0,80)}).filter(Boolean).join("\\n");})()', targetId).catch(() => ({ value: '' }));
        buttons = String(btnRes.value || '');
      }
      return {
        ok: true,
        data: {
          title: page ? page.title : '',
          url: page ? page.url : '',
          targetId,
          lineCount: lines.length,
          lines: unique.slice(0, 500),
          buttons: String(buttons || '').split('\n').filter(Boolean).slice(0, 50),
          screenshots: []
        }
      };
    });
  }

  async function monitorMessage(body) {
    const data = await bit.openBrowser({ id: body.id, queue: true });
    const ws = data.ws || data.http;
    if (!ws) return { ok: false, msg: '比特浏览器未返回 DevTools 连接信息' };
    return startMonitor(body.id, ws, body).then((res) => ({
      ok: res.ok,
      data: { ws, http: data.http, coreVersion: data.coreVersion },
      msg: res.msg
    }));
  }

  async function handleMessage(raw) {
    const text = String((raw && raw.text) || '').trim();
    const translation = await translateToChinese(text, {
      timeoutMs: config.translateTimeoutMs
    });
    const recommendation = buildRecommendation({ text }, { customerName: raw && raw.customerName });
    return {
      original: text,
      translation: translation.text,
      translationSource: translation.source,
      translationError: translation.error,
      recommendation,
      commonPhrases: COMMON_PHRASES,
      ts: Date.now()
    };
  }

  async function waitForPageReady(client, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 10000);
  while (Date.now() < deadline) {
    var r = await client.evaluate("function(){return document.readyState;}", null).catch(function(){ return { value: "unknown" }; });
    var state = String(r && r.value || "");
    if (state === "complete") return;
    await sleep(500);
  }
}

async function listBrowsersForPlatformOverview(bitClient) {
    const pageSize = 100;
    const all = [];
    let page = 0;
    let totalNum = 0;
    for (;;) {
      const data = await bitClient.listBrowsers({ page, pageSize });
      const list = Array.isArray(data.list) ? data.list : (Array.isArray(data.data) ? data.data : []);
      all.push(...list);
      totalNum = data.totalNum || all.length;
      if (list.length < pageSize || all.length >= totalNum) break;
      page += 1;
      if (page > 200) break;
    }
    return { items: all, total: totalNum };
  }

async function readProfilePage(body) {
    const browserId = body.id || body.browserId;
    if (!browserId) return { ok: false, msg: '缺少窗口 ID（id）' };
    const autoNavigate = body.autoNavigate !== false;
    const patterns =
      Array.isArray(body.profileEntryPatterns) && body.profileEntryPatterns.length
        ? body.profileEntryPatterns
        : DEFAULT_PROFILE_ENTRY_PATTERNS;

    // Use the session pool: one long-lived CDP connection per window instead
    // of opening a new DevTools client on every request.
    return await withPooledSession(browserId, async (client, session) => {
      let targets;
      try {
        targets = await fetchDevtoolsTargetList(session.ws);
      } catch (err) {
        return { ok: false, msg: err.message };
      }

      const page = pickProfileTarget(targets, patterns);
      if (!page) {
        return {
          ok: false,
          msg: '未找到可读取的页面目标',
          targets: (Array.isArray(targets) ? targets : []).map((t) => ({ type: t.type, url: t.url, id: t.id }))
        };
      }

      // Keep the pool session's target in sync with the page we're reading.
      if (session && page.id) {
        try { await client.attachTarget(page.id, true); } catch {}
        session.targetId = page.id;
      }

      let scanRaw = await fetchProfileScan(client);

      const navigation = { attempted: false };
      if (autoNavigate && scanRaw) {
        const detection = detectProfilePage(scanRaw);
        const currentUrl = String((scanRaw.page && scanRaw.page.url) || page.url || '');
        const alreadyProfileUrl = looksLikeProfileUrl(currentUrl, patterns);
        if (!alreadyProfileUrl && !detection.isLikelyProfile) {
          navigation.attempted = true;
          const navJs = buildNavigateProfileJs(patterns);
          const navRes = await client.evaluate(navJs, null).catch(() => ({ value: null }));
          const navInfo = navRes && navRes.value;
          if (navInfo && navInfo.ok && navInfo.data) {
            navigation.via = navInfo.data.via;
            navigation.target = navInfo.data.target;
            navigation.text = navInfo.data.text;
            await waitForPageReady(client, 12000);
            const rescan = await fetchProfileScan(client);
            if (rescan) {
              scanRaw = rescan;
              navigation.succeeded = true;
            } else {
              navigation.succeeded = false;
            }
          } else {
            navigation.succeeded = false;
            navigation.reason = (navInfo && navInfo.msg) || 'no-candidate';
          }
        } else {
          navigation.reason = alreadyProfileUrl ? 'url-already-profile' : 'content-likely-profile';
        }
      }

      if (autoNavigate && scanRaw && !navigation.attempted) {
        var nextPages = detectNextLevelPages(scanRaw);
        var curPageUrl = String(scanRaw.page && scanRaw.page.url || "");
        var curIsDisplay = isProfileDisplayUrl(curPageUrl) || (curPageUrl.indexOf("snssetting") === -1 && curPageUrl.indexOf("show_edit") === -1 && curPageUrl.indexOf("config") === -1 && /blood|nickname|birthday|height|style|occupation|income|星座|ニックネーム|あなたの誕生日|身長|スタイル|職業|年収|血液型|交際/.test(JSON.stringify(scanRaw.lines || scanRaw.buttons || "")));

        if (curIsDisplay) {
          // Already on the display profile page - nothing to do
          navigation.reason = "already-on-display-page";
        } else {
          // Look for the show_profile link specifically
          var displayLink = nextPages.find(function (x) {
            return isProfileDisplayUrl(x.url);
          });
          // Fallback: any profile-like link that is NOT an edit/setting page
          var nonEditLink = nextPages.find(function (x) {
            var u = String(x.url || "").toLowerCase();
            if (!looksLikeProfileUrl(u, patterns)) return false;
            if (u.indexOf("edit") !== -1 || u.indexOf("setting") !== -1) return false;
            return true;
          });
          var target = displayLink || nonEditLink;

          if (target && target.url) {
            navigation.secondHop = { target: target.url, label: target.label };
            navigation.via = "second-hop";
            var deepScript = "window.location.href = " + JSON.stringify(target.url) + "; null";
            await client.evaluate(deepScript, null).catch(function() { return { value: null }; });
            await waitForPageReady(client, 10000);
            var deepScan = await fetchProfileScan(client);
            if (deepScan) {
              scanRaw = deepScan;
            }
          } else {
            // No suitable link found - try to navigate via the page's own buttons
            var navScript = "(function(){" +
              "var links=Array.from(document.querySelectorAll('a[href],button,[role=button]'));" +
              "for(var i=0;i<links.length;i++){" +
              "var href=links[i].getAttribute('href')||'';" +
              "if(href.indexOf('show_profile')!==-1||href.indexOf('my_profile')!==-1||href.indexOf('profile_detail')!==-1){window.location.href=href;return true;}" +
              "}" +
              "return false;" +
              "})()";
            await client.evaluate(navScript, null).catch(function() {});
            await waitForPageReady(client, 8000);
            var rescan = await fetchProfileScan(client);
            if (rescan) {
              scanRaw = rescan;
              navigation.via = "direct-show_profile";
            }
          }
        }
      }

      if (!scanRaw) {
        return { ok: false, msg: '未能读取该窗口的资料页内容', targetId: page.id, navigation };
      }

      const profile = summarizeProfile(scanRaw);
      profile.detection = detectProfilePage(scanRaw);
      profile.nextLevelPages = detectNextLevelPages(scanRaw);
      profile.navigation = navigation;
      const bottomNav = parseBottomNav(scanRaw);
      profile.bottomNav = bottomNav;
      return { ok: true, data: profile };
      });
  }

    async function captureWindowScreenshot(body) {
      const browserId = body.id || body.browserId;
      if (!browserId) return { ok: false, msg: '缺少窗口 ID（id）' };
      return await withPooledSession(browserId, async (client, session) => {
      let targets;
      try {
        targets = await fetchDevtoolsTargetList(session.ws);
      } catch (err) {
        return { ok: false, msg: err.message };
      }
      const pages = targets.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
      const remote = pages.filter((t) => !isLocalHost(t.url));
      const targetPool = remote.length ? remote : pages;
      const target = targetPool.find((t) => !isLocalHost(t.url)) || targetPool[0];
      if (!target) return { ok: false, msg: '未找到可截图的页面目标' };
      await client.send('Page.enable', target.id).catch(() => {});
      const b64 = await client.captureScreenshot(target.id, { format: 'png' });
      const pageMeta = await client.evaluate('(function(){return {url:location.href,title:document.title,readyState:document.readyState,lines:(document.body?document.body.innerText:"").split(String.fromCharCode(10)).filter(Boolean).slice(0,400)}})()', target.id).catch(() => ({ value: {} }));
      const meta = (pageMeta && pageMeta.value) || {};
      return { ok: true, data: {
        windowId: browserId,
        targetId: target.id,
        url: meta.url || target.url || '',
        title: meta.title || target.title || '',
        readyState: meta.readyState || '',
        lines: Array.isArray(meta.lines) ? meta.lines : [],
        screenshotBase64: b64,
        screenshotDataUrl: b64 ? 'data:image/png;base64,' + b64 : '',
        capturedAt: new Date().toISOString()
      } };
    });
  }

  async function readMessagePage(body) {
    const browserId = body.id || body.browserId;
    if (!browserId) return { ok: false, msg: '缺少窗口 ID（id）' };
    return await withPooledSession(browserId, async (client, session) => {
      let targets;
      try {
        targets = await fetchDevtoolsTargetList(session.ws);
      } catch (err) {
        return { ok: false, msg: err.message };
      }
      const pages = targets.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
      const remote = pages.filter((t) => !isLocalHost(t.url));
      const targetPool = remote.length ? remote : pages;
      const messageTarget =
        targetPool.find((t) => /message|msg|chat|conversation/i.test(String(t.url || ''))) ||
        targetPool.find((t) => /message|msg|chat|conversation/i.test(String(t.title || ''))) ||
        null;
      const target = messageTarget || targetPool[0];
      if (!target) return { ok: false, msg: '未找到可读取的页面目标' };

      const evalRes = await client.evaluate(buildMessagePageScanJs(), null);
      const shouldSaveMessages = true;
      const scanRaw = (evalRes && evalRes.value) || null;
      if (!scanRaw) return { ok: false, msg: '未能读取该窗口的消息页内容', targetId: target.id };
      const summary = summarizeMessagePage(scanRaw);
      summary.platform = platformForWindow(browserId);
      summary.windowId = browserId;
      summary.contactKey = contactKeyFromUrl(scanRaw.page && scanRaw.page.url) || (summary.peer && summary.peer.name) || "unknown";
      summary.contact = summary.peer && summary.peer.candidates ? { name: summary.peer.name, candidates: summary.peer.candidates } : {};
      summary.target = {
        id: target.id,
        url: target.url,
        title: target.title
      };
      if (summary.detection && summary.detection.isLikelyMessagePage === false) {
        summary.notes = summary.notes || [];
        summary.notes.push('当前页面可能不是标准消息页，已尽量提取可见内容。');
      }
      const messages = Array.isArray(summary.messages) ? summary.messages : [];
      const textsToTranslate = messages.map((m) => m.original || m.text || '').filter(Boolean);
      const translations = await translateMessages(
        messages,
        (text) => translateToChinese(text, { timeoutMs: config.translateTimeoutMs }).then((r) => r.text)
      );
      summary.messages = translations;
      if (shouldSaveMessages) {
        store.upsertConversation({
          platform: summary.platform,
          windowId: browserId,
          contactKey: summary.contactKey,
          contactName: summary.contactKey,
          contact: summary.contact,
          messages: summary.messages
        });
      }
      summary.translationSummary = {
        requested: textsToTranslate.length,
        translated: translations.filter((m) => m.translation && m.translation !== m.original).length,
        fallback: translations.filter((m) => !m.translation || m.translation === m.original).length
      };
      return { ok: true, data: summary };
    });
  }

  async function readProfileFields(body) {
    const result = await readProfilePage(body);
    if (!result.ok) return result;
    const data = result.data;
    return {
      ok: true,
      data: {
        page: data.page,
        fields: data.fields,
        unfilled: data.unfilled,
        filled: data.filled,
        controls: data.controls,
        nextLevelPages: data.nextLevelPages,
        detection: data.detection,
        navigation: data.navigation
      }
    };
  }

  async function inspectProfilePage(body) {
    const result = await readProfilePage(body);
    if (!result.ok) return result;
    const inspect = buildProfileInspect({
      source: result.data.source,
      page: result.data.page,
      lines: result.data.lines,
      buttons: result.data.buttons,
      controls: result.data.fields,
      sections: result.data.sections,
      nextActions: result.data.nextActions
    });
    inspect.navigation = result.data.navigation;
    inspect.detection = result.data.detection;
    return { ok: true, data: inspect };
  }

  async function planProfilePatch(body) {
    const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
    const result = await readProfilePage(body);
    if (!result.ok) return result;
    const plan = planPatch(result.data, patch);
    return {
      ok: true,
      data: {
        page: result.data.page,
        detection: result.data.detection,
        navigation: result.data.navigation,
        nextLevelPages: result.data.nextLevelPages,
        plan
      }
    };
  }

  
  function platformForWindow(windowId) {
    const groups = loadConfig().platformGroups || [];
    const group = groups.find((g) => (g.windows || []).some((id) => String(id) === String(windowId)));
    return group ? group.name : "未分组";
  }

  function contactKeyFromUrl(url) {
    const raw = String(url || "").trim();
    const m = raw.match(/show_profile\.html\?q=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    const host = raw.match(/sp\.[^.]+\.com/);
    return host ? host[0] : raw;
  }

  function routes(req, res, notFound) {
    const url = new URL('http://localhost' + req.url);
    const pathname = url.pathname;
    const method = req.method;
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', async () => {
      const parsed = body ? JSON.parse(body) : {};
      const json = (code, data) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      };
      try {
        if (method === 'GET' && pathname === '/') {
          const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        if (method === 'GET' && pathname === '/health') {
          const ok = await bit.health().then(() => true).catch(() => false);
          json(200, { ok, apiBase, monitors: monitors.size });
          return;
        }
        if (method === 'GET' && pathname === '/api/settings') {
          const saved = loadConfig();
          const settings = {
            apiBase: saved.apiBase || process.env.BIT_BROWSER_API_URL || 'http://127.0.0.1:54345',
            host: saved.host || '127.0.0.1',
            port: saved.port || 54345
          };
          json(200, { success: true, data: settings });
          return;
        }
        if (method === 'POST' && pathname === '/api/settings') {
          const next = saveConfig({
            apiBase: parsed.apiBase,
            host: parsed.host,
            port: parsed.port
          });
          json(200, {
            success: true,
            data: {
              apiBase: next.apiBase || process.env.BIT_BROWSER_API_URL || 'http://127.0.0.1:54345',
              host: next.host || '127.0.0.1',
              port: next.port || 54345,
              restartRequired: true
            }
          });
          return;
        }
        if (method === 'GET' && pathname === '/api/platform-groups') {
          const saved = loadConfig();
          json(200, { success: true, data: saved.platformGroups || [] });
          return;
        }
        if (method === 'POST' && pathname === '/api/platform-groups') {
          const current = loadConfig().platformGroups || [];
          const name = String((parsed.name || '').trim());
          if (!name) {
            json(400, { success: false, msg: '分组名称不能为空' });
            return;
          }
          if (current.some((g) => g.name === name)) {
            json(400, { success: false, msg: '该分组已存在' });
            return;
          }
          const group = { id: Date.now().toString(36), name, windows: [] };
          current.push(group);
          saveConfig({ platformGroups: current });
          json(200, { success: true, data: current });
          return;
        }
        if (method === 'POST' && pathname === '/api/platform-groups/move') {
          const current = loadConfig().platformGroups || [];
          const groupId = String(parsed.groupId || '');
          const windowIds = Array.isArray(parsed.windowIds) ? parsed.windowIds.map(String) : [];
          if (!current.some((g) => g.id === groupId)) {
            json(404, { success: false, msg: '分组不存在' });
            return;
          }
          const target = current.find((g) => g.id === groupId);
          for (const g of current) {
            if (g.id !== groupId) {
              g.windows = (g.windows || []).filter((id) => !windowIds.includes(id));
            }
          }
          const merged = Array.from(new Set((target.windows || []).concat(windowIds)));
          target.windows = merged;
          saveConfig({ platformGroups: current });
          json(200, { success: true, data: current });
          return;
        }
        if (method === 'POST' && pathname === '/api/browsers') {
          const pageSize = 100;
          const all = [];
          let page = 0;
          let totalNum = 0;
          for (;;) {
            const data = await bit.listBrowsers({ page, pageSize });
            const list = Array.isArray(data.list) ? data.list : (Array.isArray(data.data) ? data.data : []);
            all.push(...list);
            totalNum = data.totalNum || all.length;
            if (list.length < pageSize || all.length >= totalNum) break;
            page += 1;
            if (page > 200) break;
          }
          const items = all.map((b) => ({
            id: b.id,
            name: b.name,
            remark: b.remark,
            status: b.status,
            seq: b.seq,
            lastCountry: b.lastCountry,
            lastIp: b.lastIp
          }));
          json(200, { items, total: totalNum });
          return;
        }
        if (method === 'POST' && pathname === '/api/inspect-page') {
          const result = await inspectBrowserPage(parsed);
          json(result.ok ? 200 : 502, result);
          return;
        }
        if (method === 'POST' && pathname === '/api/accounts/save-profile') {
          const profile = parsed.profile || parsed;
          const windowId = parsed.windowId || parsed.id;
          const platform = parsed.platform || platformForWindow(windowId);
          const record = store.upsertAccountProfile({
            windowId,
            platform,
            accountLabel: parsed.accountLabel || profile.nickname || profile.name,
            nickname: profile.nickname || profile.name,
            pageUrl: profile.pageUrl || profile.url,
            mypageUrl: profile.mypageUrl,
            fields: profile.fields,
            sections: profile.sections,
            lines: profile.lines,
            nextLevelPages: profile.nextLevelPages,
            bottomNav: profile.bottomNav,
            detection: profile.detection,
            navigation: profile.navigation,
            raw: profile
          });
          json(200, { success: true, data: record });
          return;
        }
        if (method === 'GET' && pathname === '/api/platforms/accounts') {
          const groups = loadConfig().platformGroups || [];
          const browserBySeq = new Map();
          try {
            const browserList = await listBrowsersForPlatformOverview(bit);
            for (const b of browserList.items || []) browserBySeq.set(String(b.seq), b);
          } catch (err) {}
          const profiles = store.listAccountProfiles({});
          const convos = store.listConversations({});
          const contacts = store.listContacts({});
          const byPlatform = new Map();
          const groupsByName = new Map((groups || []).map((g) => [g.name, g]));
          const accounts = (groups || []).map((g) => ({
            platform: g.name,
            accounts: (g.windows || []).map((windowId) => {
              const browser = (browserBySeq.get(String(windowId)) && browserBySeq.get(String(windowId)).name) ? browserBySeq.get(String(windowId)).name : String(windowId);
              const profile = profiles.find((p) => p.windowId === String(windowId) && p.platform === g.name) || profiles.find((p) => p.windowId === String(windowId));
              const convoCount = convos.filter((c) => c.windowId === String(windowId) && c.platform === g.name).length;
              const contactCount = contacts.filter((c) => c.windowId === String(windowId) && c.platform === g.name).length;
              return {
                platform: g.name,
                windowId: String(windowId),
                browserName: browser,
                profileSaved: Boolean(profile),
                profileUpdatedAt: profile && profile.updatedAt,
                profileName: profile && (profile.accountLabel || profile.nickname),
                conversationCount: convoCount,
                contactCount
              };
            })
          }));
          for (const a of accounts) {
            byPlatform.set(a.platform, a.accounts);
          }
          json(200, { success: true, data: accounts });
          return;
        }
        if (method === 'GET' && pathname === '/api/accounts/profiles') {
          const url = new URL('http://localhost' + req.url);
          const windowId = url.searchParams.get('windowId');
          const platform = url.searchParams.get('platform');
          const data = store.listAccountProfiles({ windowId, platform });
          json(200, { success: true, data });
          return;
        }
        if (method === 'POST' && pathname === '/api/profile') {
          const result = await readProfilePage(parsed);
          json(result.ok ? 200 : 502, result);
          return;
        }
        if (method === 'POST' && pathname === '/api/profile/fields') {
          const result = await readProfileFields(parsed);
          json(result.ok ? 200 : 502, result);
          return;
        }
        if (method === 'POST' && pathname === '/api/profile/inspect') {
          const result = await inspectProfilePage(parsed);
          json(result.ok ? 200 : 502, result);
          return;
        }
        if (method === 'POST' && pathname === '/api/profile/patch') {
          const result = await planProfilePatch(parsed);
          json(result.ok ? 200 : 502, result);
          return;
        }
        if (method === 'POST' && pathname === '/api/message') {
          const data = await handleMessage(parsed);
          json(200, { success: true, data });
          return;
        }
        if (method === 'POST' && pathname === '/api/conversations/save') {
          const windowId = parsed.windowId || parsed.id;
          const platform = parsed.platform || platformForWindow(windowId);
          const record = store.upsertConversation({
            platform,
            windowId,
            contactKey: parsed.contactKey || parsed.contactName,
            contactName: parsed.contactName || parsed.contactKey,
            contact: parsed.contact,
            messages: parsed.messages
          });
          json(200, { success: true, data: record });
          return;
        }
        if (method === 'GET' && pathname === '/api/conversations') {
          const url = new URL('http://localhost' + req.url);
          const windowId = url.searchParams.get('windowId');
          const platform = url.searchParams.get('platform');
          const contactKey = url.searchParams.get('contactKey');
          const data = store.listConversations({ windowId, platform, contactKey });
          json(200, { success: true, data });
          return;
        }
        if (method === 'POST' && pathname === '/api/contacts/save') {
          const windowId = parsed.windowId || parsed.id;
          const platform = parsed.platform || platformForWindow(windowId);
          const record = store.upsertContact({
            platform,
            windowId,
            contactKey: parsed.contactKey || parsed.contactName,
            contactName: parsed.contactName || parsed.contactKey,
            contact: parsed.contact,
            profileUrl: parsed.profileUrl
          });
          json(200, { success: true, data: record });
          return;
        }
        if (method === 'GET' && pathname === '/api/contacts') {
          const url = new URL('http://localhost' + req.url);
          const windowId = url.searchParams.get('windowId');
          const platform = url.searchParams.get('platform');
          const data = store.listContacts({ windowId, platform });
          json(200, { success: true, data });
          return;
        }
        if (method === 'POST' && pathname === '/api/messages/inspect') {
          const result = await readMessagePage(parsed);
          if (result.ok && parsed.saveMessages !== false) {
            const platform = platformForWindow(parsed.id || parsed.browserId);
            const contactKey = (result.data && result.data.contactKey) || (result.data && result.data.peer && result.data.peer.name) || "unknown";
            store.upsertConversation({
              platform,
              windowId: String(parsed.id || parsed.browserId || ""),
              contactKey,
              contactName: contactKey,
              contact: result.data && result.data.contact ? result.data.contact : {},
              messages: result.data && Array.isArray(result.data.messages) ? result.data.messages : []
            });
            store.upsertContact({
              platform,
              windowId: String(parsed.id || parsed.browserId || ""),
              contactKey,
              contactName: contactKey,
              contact: result.data && result.data.contact ? result.data.contact : {},
              profileUrl: result.data && result.data.page ? result.data.page.url : ""
            });
          }
          json(result.ok ? 200 : 502, result);
          return;
        }
        // task-6（§3.3.4 修复 + 方案 A 兼容层）：/api/monitor 已标记 deprecated——
        // onMessage 无法经 HTTP body 序列化（函数引用丢失，空转根源已修：
        // MessageMonitor 分派改走进程内 registerSink）。本路由保留：窗口 open +
        // session adopt + /api/stop 仍可用；新消费者请用进程内 registerSink，
        // 不要依赖 /api/monitor 传回调。彻底废弃归 Phase 4 前端拆分（index.html）。
        if (method === 'POST' && pathname === '/api/monitor') {
          const result = await monitorMessage(parsed);
          if (result && result.ok) result.data = Object.assign({}, result.data, { deprecated: true, note: 'onMessage 无法经 HTTP 序列化；新消费者走 MessageMonitor.registerSink（§3.3.4 task-6）' });
          json(result.ok ? 200 : 502, result);
          return;
        }
        // ---- AI settings ----
        if (method === 'GET' && pathname === '/api/ai/settings') {
          json(200, { success: true, data: publicSettings(loadAiSettings()) });
          return;
        }
        if (method === 'POST' && pathname === '/api/ai/settings') {
          const next = saveAiSettings(parsed && Object.keys(parsed).length ? parsed : {});
          json(200, { success: true, data: publicSettings(next) });
          return;
        }
        // ---- AI capabilities ----
        if (method === 'POST' && pathname === '/api/ai/translate') {
          const text = String((parsed && parsed.text) || '');
          const r = await aiTranslate(text).catch((e) => ({ text: '', source: 'error', ok: false, error: e.message }));
          json(r.ok ? 200 : 502, { success: r.ok, data: r });
          return;
        }
        if (method === 'POST' && pathname === '/api/ai/page-insight') {
          // Accept a screenshot (data URL or base64) plus page text/url/title.
          let screenshotBase64 = String((parsed && (parsed.screenshotDataUrl || parsed.screenshotBase64 || parsed.screenshot)) || '').trim();
          if (!screenshotBase64 && parsed && parsed.id) {
            const cap = await captureWindowScreenshot({ id: parsed.id });
            if (cap.ok) screenshotBase64 = cap.data.screenshotBase64;
          }
          if (screenshotBase64 && screenshotBase64.indexOf('data:image') === 0) {
            screenshotBase64 = screenshotBase64.slice(screenshotBase64.indexOf(',') + 1);
          }
          const payload = {
            url: String((parsed && parsed.url) || ''),
            title: String((parsed && parsed.title) || ''),
            lines: Array.isArray(parsed && parsed.lines) ? parsed.lines : [],
            screenshotBase64
          };
          const r = await aiUnderstandPage(payload, { question: parsed && parsed.question }).catch((e) => ({ ok: false, configured: false, text: '', error: e.message }));
          json(200, { success: r.ok !== false || r.configured, data: r });
          return;
        }
        if (method === 'POST' && pathname === '/api/ai/reply') {
          const r = await aiRecommendReply({
            messages: Array.isArray(parsed && parsed.messages) ? parsed.messages : [],
            peerName: parsed && parsed.peerName,
            context: parsed && parsed.context,
            style: parsed && parsed.style
          }).catch((e) => ({ ok: false, source: 'error', reply: '', error: e.message }));
          json(200, { success: true, data: r });
          return;
        }
        // ---- Screenshot capture (DevTools, no Playwright dependency) ----
        if (method === 'POST' && pathname === '/api/screenshot') {
          const r = await captureWindowScreenshot(parsed || {});
          json(r.ok ? 200 : 502, r);
          return;
        }
                if (method === 'POST' && pathname === '/api/stop') {
          const m = monitors.get(parsed.id);
          if (m) m.stop();
          json(200, { success: true, stopped: !!m });
          return;
        }
        notFound();
      } catch (err) {
        json(500, { success: false, msg: err.message });
      }
    });
  }

  return (req, res, notFound) => routes(req, res, notFound);
}

module.exports = { createApp, loadConfig, saveConfig, DEFAULT_PROFILE_ENTRY_PATTERNS, looksLikeProfileUrl };