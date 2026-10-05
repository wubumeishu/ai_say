// WhatsApp Web 平台适配器 — 骨架版。
// 说明：M2 补强。保留 extends PlatformAdapter + 4 方法契约，
//       加入基于 WhatsApp Web 公开 UI 结构的「骨架选择器」，
//       选择器全部走 locatorConfig（数据化），每条 rule 带 minHits/missThreshold，
//       基类 probeRule 自动触发 onLocatorMiss 告警。
//       所有 selector 标 // SKELETON: 需真实页面样本校准。

const { PlatformAdapter } = require('./platformAdapter');

// WhatsApp Web 骨架定位规则。
// SKELETON: 基于 WA Web 常见 DOM 结构（#msg 容器 + message-in/message-out 气泡）。
const DEFAULT_LOCATOR_CONFIG = {
  pages: {
    inbox:  { urlPattern: 'whatsapp\.web|web\.(me|com)/WhatsApp' },
    chat:   { urlPattern: 'whatsapp\.web/#.*conversation|web\.me/#c/' },
    profile:{ urlPattern: 'whatsapp\.web/#.*contact|web\.me/#c/' }
  },

  rules: {
    // SKELETON: 左侧会话列表项（WA Web 常见 .conversation-list-item 或 li[data-testid]）
    conversationList: {
      selectors: [
        '.conversation-list-item',
        'li[data-testid^="conversation"]',
        '.panel-item.conversation'
      ],
      minHits: 1,
      missThreshold: 0
    },

    // SKELETON: 聊天消息气泡（WA Web 固定命名 #msg .message-in / .message-out）
    chatBubble: {
      selectors: [
        '#msg .message-in',
        '#msg .message-out',
        '.message-in, .message-out',
        '.message-container'
      ],
      minHits: 1,
      missThreshold: 0
    },

    // SKELETON: 输入框（WA Web 固定 #msg .chat-box 内的 contenteditable div）
    chatInput: {
      selectors: [
        '#msg [contenteditable="true"].copyable-text',
        '.chat-box [contenteditable="true"]',
        '#msg .input-box [contenteditable="true"]'
      ],
      minHits: 1,
      missThreshold: 0
    },

    // SKELETON: 发送按钮（WA Web 固定 .chat-form .send 或 [data-icon="send"]）
    sendButton: {
      selectors: [
        '.chat-form [data-icon="send"], .chat-form .send',
        '#msg .send-message, button[data-automation-id="send-message"]'
      ],
      minHits: 1,
      missThreshold: 0
    }
  },

  actions: {
    openChat: {
      steps: [{ rule: '.conversation-list, [data-testid="panel-item"], .left-panel', strategy: 'click' }]
    }
  },

  send: {
    input: ['#msg [contenteditable="true"].copyable-text', '.chat-box [contenteditable="true"]'],
    button: ['#msg [data-icon="send"]', '.chat-form [data-icon="send"]', 'button[data-automation-id="send-message"]'],
    key: 'Enter'
  }
};

class WhatsAppAdapter extends PlatformAdapter {
  constructor(opts = {}) {
    const merged = Object.assign({ platform: 'whatsapp' }, opts);
    if (!merged.locatorConfig) {
      merged.locatorConfig = DEFAULT_LOCATOR_CONFIG;
    } else {
      merged.locatorConfig = Object.assign({}, DEFAULT_LOCATOR_CONFIG, merged.locatorConfig);
      if (merged.locatorConfig.rules) {
        merged.locatorConfig.rules = Object.assign({}, DEFAULT_LOCATOR_CONFIG.rules, merged.locatorConfig.rules);
      }
    }
    super(merged);
  }

  /**
   * 覆写 parseProfile：WA Web 没有独立资料页，从会话头部读取联系人信息。
   * SKELETON: 字段映射为最小结构。
   */
  parseProfile(probe, kind) {
    if (kind !== 'account') return null;
    const pf = (probe || []).find((p) => p.rule === 'profileFields');
    if (!pf || !Array.isArray(pf.results)) return null;
    const identity = {};
    for (const r of pf.results) {
      if (r.ok && r.sample) identity[r.css] = r.sample;
    }
    return { identity, account: {}, gaps: [], stats: [] };
  }

  /**
   * 覆写 scanMessagesJs：WA Web 聊天页消息扫描（骨架）。
   * SKELETON: 固定 #msg 容器 + .message-in/.message-out 气泡。
   */
  scanMessagesJs() {
    return [
      '(function () {',
      '  var peer = "";',
      '  var peerEl = document.querySelector(".chat-header [data-testid], .conversation-panel__header, .copyable-text.first-message");',
      '  if (peerEl) peer = (peerEl.innerText || "").replace(/\s+/g, " ").trim();',
      '  var items = [];',
      '  var msgNodes = document.querySelectorAll("#msg .message-in, #msg .message-out, .message-in, .message-out");',
      '  for (var i = 0; i < msgNodes.length; i += 1) {',
      '    var el = msgNodes[i];',
      '    var text = (el.innerText || "").replace(/\s+/g, " ").trim();',
      '    if (!text || text.length > 2000) continue;',
      '    var isMine = /message-out|out/i.test(el.className || "");',
      '    var timeEl = el.querySelector("[data-testid^=\"icon-\"], .meta, [class*=meta], span[class*=time]");',
      '    var timeText = timeEl ? timeEl.innerText : "";',
      '    items.push({ role: isMine ? "mine" : "peer", original: text, timeText: timeText, kind: "text", url: "" });',
      '  }',
      '  return { peer: peer, messages: items.slice(0, 200) };',
      '})()'
    ].join("\n");
  }
}

module.exports = { WhatsAppAdapter, DEFAULT_LOCATOR_CONFIG };