// Facebook (Messenger) 平台适配器 — 骨架版。
// 说明：M2 补强。保留 extends PlatformAdapter + 4 方法契约，
//       加入基于 Facebook Messenger 公开 UI 结构的「骨架选择器」，
//       选择器全部走 locatorConfig（数据化），每条 rule 带 minHits/missThreshold，
//       基类 probeRule 自动触发 onLocatorMiss 告警（定位失败 100% 告警）。
//       所有 selector 标 // SKELETON: 需真实页面样本校准，接入前请用真实样本核对。

const { PlatformAdapter } = require('./platformAdapter');

// Facebook Messenger 骨架定位规则（可被外部 locatorConfig 覆盖/存库）。
// SKELETON: 以下选择器基于 FB Messenger 公开 UI 结构的常见命名，需真实样本校准。
const DEFAULT_LOCATOR_CONFIG = {
  pages: {
    inbox:   { urlPattern: '/m/|/people/.*messenger|facebook.com/messenger' },
    chat:    { urlPattern: '/messages/|facebook.com/messages/|messenger' },
    profile: { urlPattern: '/people/|facebook.com/profile|user.php' }
  },

  rules: {
    // SKELETON: Messenger 消息列表项（常见为 .messageListItem 或 li[data-sigil] 容器）
    messageList: {
      selectors: [
        '.messageListItem',
        '.li[data-sigil="message"]',
        '.messageListItemContainer'
      ],
      minHits: 1,
      missThreshold: 0
    },

    // SKELETON: 聊天消息气泡（FB 用 .messageContainer / .messageRow / mui3-container）
    chatBubble: {
      selectors: [
        '.messageContainer',
        '.messageRow',
        '[class*=messageRow] [class*=bubble]'
      ],
      minHits: 1,
      missThreshold: 0
    },

    // SKELETON: 聊天输入框（FB 常用 textarea[aria-label*=write] 或 .richTextComposer）
    chatInput: {
      selectors: [
        'textarea[aria-label*="write" i], textarea[placeholder*="essage" i], .richTextComposer textarea',
        '.messageInput textarea',
        '[contenteditable="true"][role="textbox"]'
      ],
      minHits: 1,
      missThreshold: 0
    },

    // SKELETON: 个人资料页字段（FB 资料页常见结构 .profileHeader / .contactContainer）
    profileFields: {
      selectors: [
        '.profileHeader, .contactContainer, .profileInfoContainer',
        '.introPhoto, .nameSection'
      ],
      minHits: 1,
      missThreshold: 0
    }
  },

  actions: {
    openChat: {
      steps: [{ rule: '.chatList, .conversationList, [role="list"][aria-label*="conversation"]', strategy: '.click()'}]
    }
  },

  send: {
    input: ['textarea[aria-label*="write" i]', '.richTextComposer textarea', '[contenteditable="true"][role="textbox"]'],
    button: ['button[aria-label*="Send" i]', '.messageSubmitButton'],
    key: 'Enter'
  }
};

class FacebookAdapter extends PlatformAdapter {
  constructor(opts = {}) {
    const merged = Object.assign({ platform: 'facebook' }, opts);
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
   * 覆写 parseProfile：把 profileFields 骨架探测结果映射为 AccountPersona。
   * SKELETON: 字段映射为最小结构，真实样本校准后补全字段。
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
   * 覆写 scanMessagesJs：FB 聊天页消息扫描脚本（骨架）。
   * SKELETON: 返回 { peer, messages }；选择器需真实样本校准。
   */
  scanMessagesJs() {
    return [
      '(function () {',
      '  var peer = "";',
      '  var peerEl = document.querySelector(".chatHeader, .conversationHeader, [aria-label*=contact i]");',
      '  if (peerEl) peer = (peerEl.innerText || "").replace(/\s+/g, " ").trim();',
      '  var items = [];',
      '  var msgNodes = document.querySelectorAll(".messageContainer, .messageRow, [class*=messageRow]");',
      '  for (var i = 0; i < msgNodes.length; i += 1) {',
      '    var el = msgNodes[i];',
      '    var text = (el.innerText || "").replace(/\s+/g, " ").trim();',
      '    if (!text || text.length > 2000) continue;',
      '    var isMine = /outbound|sent|right|自己|自分|own/i.test((el.className || "") + " " + el.getAttribute("data-sigil") + " ");',
      '    var timeEl = el.querySelector(".messageTimestamp, [class*=time], .msgTime");',
      '    var timeText = timeEl ? timeEl.innerText : "";',
      '    items.push({ role: isMine ? "mine" : "peer", original: text, timeText: timeText, kind: "text", url: "" });',
      '  }',
      '  return { peer: peer, messages: items.slice(0, 200) };',
      '})()'
    ].join("\n");
  }
}

module.exports = { FacebookAdapter, DEFAULT_LOCATOR_CONFIG };