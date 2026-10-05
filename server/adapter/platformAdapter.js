// M2 平台适配器基类：4 方法契约（scanProfile / scanMessages / navigate / send）。
//
// 设计原则（对齐 docs/plan/04-roadmap.md M2 验收）：
//  1. 每个新平台只需实现 4 个方法 + 提供 locatorConfig，引擎/架构零改动。
//  2. 定位规则数据化：DOM 选择器存在 locatorConfig（JSON）中，命中失败发 onLocatorMiss 告警事件。
//  3. 复用 server/devtools.js 的 DevToolsClient，不重造 CDP 通道。
//  4. 只做「页面→结构化数据」和「指令→页面操作」，不写业务逻辑（画像/评分/话术是 engine/acquisition 的事）。
//
// 定位字符串语法（数据化的核心；规则本身来自 locatorConfig，不写死在适配器里）：
//   "css"         → 纯 CSS 选择器
//   "text|css"    → 在 css 范围内找 innerText===text 的元素；css 未命中时做全页文本探测
//   "css||text"   → 优先 css，css 失败时全页精确文本找首个含该文本的可交互元素

const IDENTITY_FIELDS = [
  'nickname', 'birthday', 'age', 'height', 'build', 'bloodType', 'type',
  'region', 'relationshipStatus', 'hometown', 'occupation', 'income',
  'zodiac', 'smoking', 'drinking', 'children', 'eyeColor', 'freeTime',
  'preferredAge', 'preferredStyle', 'cups', 'slices', 'datePlans',
  'meetingGoal', 'interests'
];

const ACCOUNT_STAT_FIELDS = [
  'points', 'resource', 'photos', 'recruiting', 'messageUnread'
];

function buildProbeJs(selectors) {
  const list = JSON.stringify(Array.isArray(selectors) ? selectors : []);
  const lines = [
    '(function () {',
    '  var raws = ' + list + ';',
    '  var out = []; var seen = {};',
    '  for (var i = 0; i < raws.length; i += 1) {',
    '    var sel = String(raws[i] || "");',
    '    if (!sel || sel.indexOf("|") === 0) continue;',
    '    var css = sel; var text = "";',
    '    if (sel.indexOf("||") !== -1) { css = sel.slice(0, sel.indexOf("||")); text = sel.slice(sel.indexOf("||") + 2); }',
    '    else { var bar = sel.indexOf("|"); if (bar > 0) { text = sel.slice(0, bar); css = sel.slice(bar + 1); } }',
    '    var key = css + "@" + text; if (seen[key]) continue; seen[key] = true;',
    '    var count = 0; var href = ""; var el = null;',
    '    try { var nodes = document.querySelectorAll(css); count = nodes.length; if (count > 0) { el = nodes[0]; } href = el ? (el.getAttribute("href") || "") : ""; } catch (e) { count = 0; }',
    '    var textHit = false;',
    '    if (text) {',
    '      for (var j = 0; j < count; j += 1) {',
    '        var t = (nodes[j].innerText || nodes[j].textContent || "").replace(/[\\s]/g, "").trim();',
    '        if (t === text) { textHit = true; break; }',
    '      }',
    '      if (!textHit) {',
    '        var walker = document.createTreeWalker(document.body, 4, null, false);',
    '        var node = walker.nextNode();',
    '        while (node && !textHit) {',
    '          if (node.nodeType === 3) {',
    '            var parent = node.parentElement;',
    '            if (parent && !parent.closest("script, style, noscript")) {',
    '              var tv = (node.nodeValue || "").replace(/[\\s]/g, "").trim();',
    '              if (tv === text) textHit = true;',
    '            }',
    '          }',
    '          node = walker.nextNode();',
    '        }',
    '      }',
    '    }',
    '    out.push({ css: css, text: text, cssHits: count, textHit: textHit, sample: el ? (el.innerText || el.textContent || "").slice(0, 80) : "", href: href, ok: count > 0 && (!text || textHit) });',
    '  }',
    '  return out;',
    '})()'
  ];
  return lines.join('\n');
}

function normalizeLocators(candidates) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const s = String(raw || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function buildNavigateRuleJs(selectors, mode) {
  const cands = JSON.stringify(normalizeLocators(selectors));
  const m = JSON.stringify(String(mode || 'href'));
  const lines = [
    '(function () {',
    '  var raws = ' + cands + ';',
    '  var mode = ' + m + ';',
    '  var found = null; var href = "";',
    '  for (var i = 0; found === null && i < raws.length; i += 1) {',
    '    var raw = String(raws[i] || "");',
    '    if (!raw || raw.indexOf("|") === 0) continue;',
    '    var css = raw; var text = "";',
    '    if (raw.indexOf("||") !== -1) { css = raw.slice(0, raw.indexOf("||")); text = raw.slice(raw.indexOf("||") + 2); }',
    '    else { var bar = raw.indexOf("|"); if (bar > 0) { text = raw.slice(0, bar); css = raw.slice(bar + 1); } }',
    '    var nodes = []; try { nodes = Array.prototype.slice.call(document.querySelectorAll(css)); } catch (e) { nodes = []; }',
    '    for (var j = 0; j < nodes.length; j += 1) {',
    '      var el = nodes[j];',
    '      var t = (el.innerText || el.textContent || "").replace(/[\\s]/g, "").trim();',
    '      if (text === "" || t === text) { found = el; break; }',
    '    }',
    '    if (found === null && text !== "") {',
    '      var walker = document.createTreeWalker(document.body, 4, null, false);',
    '      var node = walker.nextNode();',
    '      while (node) {',
    '        if (node.nodeType === 3) {',
    '          var parent = node.parentElement;',
    '          if (parent && !parent.closest("script, style, noscript")) {',
    '            var tv = (node.nodeValue || "").replace(/[\\s]/g, "").trim();',
    '            if (tv === text) { found = parent; break; }',
    '          }',
    '        }',
    '        node = walker.nextNode();',
    '      }',
    '    }',
    '    if (found !== null) break;',
    '  }',
    '  if (found === null) return { ok: false, reason: "no-match" };',
    '  var h = found.getAttribute("href") || "";',
    '  if (h) { if (mode === "href") { window.location.href = h; return { ok: true, via: "href", to: h }; } found.click(); return { ok: true, via: "click", to: h }; }',
    '  found.click();',
    '  return { ok: true, via: "click" };',
    '})()'
  ];
  return lines.join('\n');
}

function buildSendJs(inputSelectors, buttonSelectors, key, message) {
  const inputs = JSON.stringify(normalizeLocators(inputSelectors));
  const buttons = JSON.stringify(normalizeLocators(buttonSelectors));
  const k = JSON.stringify(String(key || 'Enter'));
  const msg = JSON.stringify(String(message));
  const lines = [
    '(function () {',
    '  var inputs = ' + inputs + ';',
    '  var buttons = ' + buttons + ';',
    '  var key = ' + k + '; var message = ' + msg + ';',
    '  function setValue(el, value) {',
    '    var proto = Object.getPrototypeOf(el);',
    '    var desc = Object.getOwnPropertyDescriptor(proto, "value");',
    '    if (desc && desc.set) { desc.set.call(el, value); } else { el.value = value; }',
    '    el.dispatchEvent(new Event("input", { bubbles: true }));',
    '    el.dispatchEvent(new Event("change", { bubbles: true }));',
    '  }',
    '  var els = [];',
    '  for (var i = 0; i < inputs.length; i += 1) {',
    '    try { els = els.concat(Array.prototype.slice.call(document.querySelectorAll(inputs[i]))); } catch (e) { }',
    '  }',
    '  if (!els.length) return { ok: false, reason: "input-not-found", tried: inputs };',
    '  var input = els[0];',
    '  input.focus();',
    '  setValue(input, message);',
    '  var sent = false;',
    '  for (var b = 0; b < buttons.length; b += 1) {',
    '    try {',
    '      var btn = document.querySelector(buttons[b]);',
    '      if (btn && !btn.disabled) { btn.click(); sent = true; break; }',
    '    } catch (e) { }',
    '  }',
    '  if (!sent) {',
    '    var code = key === "Enter" ? 13 : (key.length === 1 ? key.charCodeAt(0) : 0);',
    '    var ev = new KeyboardEvent("keydown", { key: key, code: key, keyCode: code, which: code, bubbles: true });',
    '    input.dispatchEvent(ev);',
    '  }',
    '  return { ok: true, via: sent ? "button" : "key", input: inputs[0], message: message.slice(0, 40) };',
    '})()'
  ];
  return lines.join('\n');
}

class PlatformAdapter {
  /**
   * @param {object} opts
   * @param {DevToolsClient} [opts.cdp] 已连接的 DevToolsClient（复用 server/devtools.js）
   * @param {string} [opts.targetId] DevTools target（页签）id
   * @param {object} [opts.locatorConfig] 定位规则数据（JSON，结构见 server/adapter/README.md）
   * @param {function} [opts.emit] 事件出口 emit(type, payload)；缺省用 console.warn
   */
  constructor(opts = {}) {
    this.platform = String(opts.platform || 'unknown');
    this.cdp = opts.cdp || null;
    this.targetId = opts.targetId || null;
    this.locatorConfig = opts.locatorConfig || {};
    this.emit = opts.emit || ((type, payload) => {
      console.warn('[adapter:' + this.platform + '] ' + type, payload || '');
    });
    if (!this.cdp) {
      throw new Error(this.platform + ' 适配器需要 DevToolsClient 实例（opts.cdp，见 server/devtools.js）');
    }
    // 告警事件计数，供 M5 健康面板拉取（「定位失败 100% 告警」的验收依据）
    this.locatorMissCount = 0;
    this.locatorStats = new Map(); // ruleId → { hits, total, lastHits, at }
  }

  // ---- CDP 基础设施（复用 DevToolsClient，不重造轮子） ----------------------
  async eval(expression) {
    const { value } = await this.cdp.evaluate(expression, this.targetId);
    return value;
  }

  /** 按 locatorConfig.pages 判断当前页面属于哪个 page key */
  async currentPageKey() {
    const pages = this.locatorConfig.pages || {};
    const url = String(await this.eval('location.href') || '');
    for (const key of Object.keys(pages)) {
      const pattern = String(((pages[key] || {}).urlPattern) || '');
      if (pattern && new RegExp(pattern).test(url)) return key;
    }
    return '';
  }

  /**
   * 定位探测（命中统计 + 告警）。
   * 规则字段：selectors（定位字符串清单）/ missThreshold（命中率下限，可选）/
   * minHits（至少命中数，可选，默认 1）/ appliesTo（适用 pageKey 清单，可选）。
   * 命中数 < minHits 或命中率低于阈值时：locatorMissCount += 1 并发 onLocatorMiss。
   */
  async probeRule(ruleId) {
    const rule = ((this.locatorConfig.rules || {})[ruleId]) || {};
    const raw = await this.eval(buildProbeJs(rule.selectors));
    const out = Array.isArray(raw) ? raw : [];
    const hits = out.filter((r) => r.ok).length;
    const total = out.length;
    this.locatorStats.set(ruleId, { hits, total, lastHits: hits, at: new Date().toISOString() });
    if (total > 0) {
      const threshold = Number.isFinite(rule.missThreshold) ? rule.missThreshold : 0;
      const minHits = Number.isFinite(rule.minHits) ? rule.minHits : 1;
      if (hits < minHits || (threshold > 0 && hits / total < threshold)) {
        this.locatorMissCount += 1;
        this.emit('onLocatorMiss', {
          platform: this.platform,
          ruleId,
          hits,
          total,
          threshold,
          minHits,
          url: String(await this.eval('location.href') || ''),
          probe: out
        });
      }
    }
    return out;
  }

  /** 按 rule + strategy（href 优先 / click 回退）执行一次导航（17098 已验证方式）。 */
  async navigateRule(ruleId, strategy) {
    const rule = ((this.locatorConfig.rules || {})[ruleId]) || {};
    const mode = strategy || 'href';
    const res = await this.eval(buildNavigateRuleJs(rule.selectors, mode));
    if (!res || !res.ok) {
      await this.probeRule(ruleId); // 未命中 → 记录统计并发 onLocatorMiss
      return { ok: false, reason: 'navigate-rule-miss', ruleId };
    }
    return {
      ok: true,
      ruleId,
      via: res.via,
      to: res.to || '',
      url: String(await this.eval('location.href') || ''),
      pageKey: await this.currentPageKey()
    };
  }

  // ---- 4 方法契约（默认实现，平台子类按需覆写） -----------------------------
  /**
   * scanProfile() → 结构化账号/客户资料页（AccountPersona / CustomerProfile 各一套字段槽，
   * 对齐 02 章 schema）。默认：对当前 pageKey 适用的规则做探测，返回空槽 + probe 原文；
   * 子类覆写 parseProfile(probe, kind) 把探测结果映射为字段值。
   */
  async scanProfile() {
    const pageKey = await this.currentPageKey();
    const rules = this.locatorConfig.rules || {};
    const ruleIds = Object.keys(rules).filter((id) => {
      const r = rules[id] || {};
      return Array.isArray(r.appliesTo) ? r.appliesTo.indexOf(pageKey) !== -1 : true;
    });
    const probe = [];
    const miss = [];
    for (const id of ruleIds) {
      const out = await this.probeRule(id);
      probe.push({ rule: id, results: out });
      out.forEach((r) => { if (!r.ok) miss.push({ rule: id, css: r.css, text: r.text }); });
    }
    return {
      ok: true,
      source: this.platform + '-profile-scan',
      pageKey,
      url: String(await this.eval('location.href') || ''),
      accountPersona: this.parseProfile(probe, 'account') || {
        identity: {},
        account: {},
        gaps: IDENTITY_FIELDS.slice(),
        stats: ACCOUNT_STAT_FIELDS.slice()
      },
      customerProfile: this.parseProfile(probe, 'customer') || {
        identity: {},
        signals: {},
        lastSeen: null
      },
      probe,
      miss: miss.length ? miss : null,
      scannedAt: new Date().toISOString()
    };
  }

  /** 子类覆写：把 probe 结果解析为字段值。基类默认 null（返回空槽，保证最小契约成立）。 */
  parseProfile(probe, kind) {
    return null;
  }

  /**
   * scanMessages(conversationId) → 结构化消息流（role/original/translation/time）。
   * 默认：inbox 行扫描（复用 queueScanner 的通用行结构）；
   * 聊天页消息流由子类覆写 scanMessagesJs() 提供页面脚本。translation 由 engine 填充，适配器不碰。
   */
  async scanMessages(conversationId) {
    const { buildQueuePageScanJs, summarizeQueuePage } = require('../queueScanner');
    const js = this.scanMessagesJs();
    const raw = js ? await this.eval(js) : await this.eval(buildQueuePageScanJs());
    const base = {
      ok: true,
      source: this.platform + '-message-scan',
      pageKey: await this.currentPageKey(),
      conversationId: String(conversationId || ''),
      messages: [],
      rows: [],
      pagination: raw && raw.pagination ? raw.pagination : {},
      scannedAt: new Date().toISOString()
    };
    if (!js && raw && Array.isArray(raw.rows)) {
      const sum = summarizeQueuePage(raw);
      base.rows = sum.rows;
      base.summarized = true;
      base.totalRows = sum.totalRows;
      base.filledRows = sum.filledRows;
      return base;
    }
    const items = Array.isArray(raw && raw.messages) ? raw.messages : [];
    base.messages = items.map((item, index) => {
      const it = item || {};
      return {
        index,
        role: String(it.role || 'unknown'),
        original: String(it.original != null ? it.original : (it.text || '')).trim(),
        translation: '', // 翻译由 engine/translator 负责，适配器不碰
        time: it.time || { text: String(it.timeText || ''), parsedIso: it.parsedIso || '' },
        kind: String(it.kind || 'text'),
        url: String(it.url || '')
      };
    });
    base.peer = raw && raw.peer ? raw.peer : null;
    return base;
  }

  /** 子类覆写：返回聊天页消息扫描脚本（返回 { page, peer, messages }）。基类返回 null。 */
  scanMessagesJs() {
    return null;
  }

  /**
   * navigate(urlOrAction) → 页面跳转/操作：
   *  - http(s) 或 / 开头 → 直接 location.href
   *  - 否则作为 actionId 查 locatorConfig.actions，按 steps 依次执行（href 优先，click 回退）
   */
  async navigate(urlOrAction) {
    const target = String(urlOrAction || '');
    if (!target) return { ok: false, reason: 'empty-target' };
    if (/^https?:\/\//.test(target) || target.charAt(0) === '/') {
      await this.eval('window.location.href = ' + JSON.stringify(target));
      return {
        ok: true,
        via: 'url',
        to: target,
        url: String(await this.eval('location.href') || ''),
        pageKey: await this.currentPageKey()
      };
    }
    const actions = this.locatorConfig.actions || {};
    const action = actions[target] || {};
    const steps = Array.isArray(action.steps) && action.steps.length
      ? action.steps
      : [{ rule: target, strategy: action.strategy || 'href' }];
    let lastErr = null;
    for (const s of steps) {
      const res = await this.navigateRule(String(s.rule || ''), String(s.strategy || 'href'));
      if (res.ok) {
        return { ok: true, via: res.via, to: res.to || target, url: res.url, pageKey: res.pageKey, action: target };
      }
      lastErr = res;
    }
    return { ok: false, reason: 'action-miss', action: target, detail: lastErr };
  }

  /**
   * send(text, {to}) → 发消息（指令→页面操作）。走 locatorConfig.send（input 选择器 +
   * Enter/按钮）。合规闸门（频控/敏感词）由 acquisition 在调用前执行；适配器不做业务判断，
   * 只回报结果供 LeadEvent 记录。opts.mock 或子类 sendMock() 为 true 时返回 mock 结果。
   */
  async send(text, opts = {}) {
    const message = String(text == null ? '' : text).trim();
    if (!message) return { ok: false, reason: 'empty-message' };
    if (opts.mock || this.sendMock()) {
      this.emit('onSend', { mock: true, to: opts.to || '', text: message });
      return { ok: true, mock: true, sentAt: new Date().toISOString(), via: 'mock' };
    }
    const conf = this.locatorConfig.send || {};
    const inputSelectors = normalizeLocators(conf.input || []);
    const buttonSelectors = normalizeLocators(conf.button || []);
    const key = String(conf.key || 'Enter');
    const res = await this.eval(buildSendJs(inputSelectors, buttonSelectors, key, message));
    if (!res || !res.ok) {
      this.emit('onSendMiss', { reason: res && res.reason, to: opts.to || '', input: inputSelectors });
      return { ok: false, reason: (res && res.reason) || 'send-failed', via: 'form' };
    }
    this.emit('onSend', { to: opts.to || '', text: message, via: res.via });
    return { ok: true, mock: false, via: res.via, sentAt: new Date().toISOString() };
  }

  /** 子类覆写：true 表示 send 返回 mock（如 LINE OA 占位）。基类 false。 */
  sendMock() {
    return false;
  }

  // 生命周期钩子（子类可覆写）
  async onOpen() {}
  async onClose() {}
}

// 注册表：新平台在此加一行 + 新建一个子类文件即可，引擎/架构零改动。
const registry = {
  ichigo194964: 'IchigoAdapter',
  ichigo: 'IchigoAdapter',
  ikukur: 'IchigoAdapter',
  line: 'LineAdapter',
  facebook: 'FacebookAdapter',
  whatsapp: 'WhatsAppAdapter'
};

function registerAdapter(platform, AdapterClass) {
  registry[String(platform || '').toLowerCase()] = String((AdapterClass && AdapterClass.name) || '');
}

/**
 * 创建平台适配器。
 * @param {string} platform 已注册平台 id（见 server/adapter/README.md 清单）
 * @param {object} [opts]  { cdp, targetId, locatorConfig, emit, platform }
 * @returns {PlatformAdapter}
 */
function createAdapter(platform, opts = {}) {
  const p = String(platform || '').trim().toLowerCase();
  const merged = Object.assign({}, opts, { platform: p });
  switch (p) {
    case 'ichigo194964':
    case 'ichigo':
    case 'ikukur':
      return new (require('./ichigo194964').IchigoAdapter)(merged);
    case 'line':
      return new (require('./line').LineAdapter)(merged);
    case 'facebook':
    case 'fb':
      return new (require('./facebook').FacebookAdapter)(merged);
    case 'whatsapp':
    case 'wa':
      return new (require('./whatsapp').WhatsAppAdapter)(merged);
    default:
      throw new Error('未注册的平台适配器: ' + platform + '（注册方式见 server/adapter/README.md）');
  }
}

module.exports = {
  PlatformAdapter,
  createAdapter,
  registerAdapter,
  registry,
  normalizeLocators,
  buildProbeJs,
  IDENTITY_FIELDS,
  ACCOUNT_STAT_FIELDS
};
