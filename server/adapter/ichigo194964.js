// 出会 / Pappy / イククル（sp.194964.com）平台适配器。
// 复用 docs/tools/ 已验证的选择器（17098 窗口）：
//   - 底部导航：A.bottom-nav-item-txt.nav-mypage（href 直接跳转，不用 .click()）
//   - 资料页入口：A.btn-changeprofile → show_profile.html
// 定位规则数据化：所有选择器来自 locatorConfig（JSON），本文件只声明默认值。

const { PlatformAdapter } = require('./platformAdapter');

// 17098 窗口已验证的默认定位规则（可被外部 locatorConfig 覆盖/存库）。
// 选择器语法："text|css" → 在 css 范围内精确文本匹配；"css||text" → css 失败再全页文本。
const DEFAULT_LOCATOR_CONFIG = {
  pages: {
    inbox:   { urlPattern: 'sp\.194964\.com/mail/inbox|sp\.194964\.com/mail/' },
    mypage:  { urlPattern: 'sp\.194964\.com/mypage\.html' },
    profile: { urlPattern: 'show_profile\.html|sp\.194964\.com/sns/snsmypage/' }
  },

  rules: {
    // 底部导航（17098 已验证：A.bottom-nav-item-txt 精确文本匹配）
    bottomNav: {
      selectors: [
        'メッセージ|a.bottom-nav-item-txt',
        '募集|a.bottom-nav-item-txt',
        'タイプ|a.bottom-nav-item-txt',
        'マイページ|a.bottom-nav-item-txt',
        'お相手探し|a.bottom-nav-item-txt'
      ],
      minHits: 3,
      missThreshold: 0.5
    },

    // 资料页字段（show_profile.html 已验证的字段分组，见 docs/tools/profile_17098_fields.md）
    profileFields: {
      selectors: [
        // 基本资料
        'ニックネーム|.profile-item, .field-item, [class*=field], [class*=item], [class*=profile]',
        'あなたの誕生日|.profile-item, .field-item, [class*=field], [class*=item]',
        '身長|.profile-item, .field-item, [class*=field], [class*=item]',
        'スタイル|.profile-item, .field-item, [class*=field], [class*=item]',
        '血液型|.profile-item, .field-item, [class*=field], [class*=item]',
        'あなたのタイプ|.profile-item, .field-item, [class*=field], [class*=item]',
        'よく遊ぶ地域|.profile-item, .field-item, [class*=field], [class*=item]',
        '交際ステータス|.profile-item, .field-item, [class*=field], [class*=item]',
        // 顶部资源
        '50pt|.top-resources, [class*=points], [class*=pt], header',
        '追加|.top-resources, [class*=resource], [class*=capacity]',
        '交換|.top-resources, [class*=exchange], [class*=resource]'
      ],
      minHits: 5,
      missThreshold: 0.4
    },

    // 聊天页输入框
    chatInput: {
      selectors: [
        'textarea.chat-input, textarea[class*=input], .chat-composer textarea, #chat-input, .input-area textarea'
      ],
      minHits: 1
    }
  },

  actions: {
    mypage: {
      steps: [{ rule: 'bottomNav', strategy: 'href' }]
    },
    profile: {
      steps: [
        { rule: 'profileFields', strategy: 'href' }
      ]
    }
  },

  send: {
    input: ['textarea.chat-input', 'textarea[class*=input]', '.chat-composer textarea', '#chat-input', '.input-area textarea'],
    button: ['button.send', '.send-btn', '[class*=send]', '.btn-send'],
    key: 'Enter'
  }
};

class IchigoAdapter extends PlatformAdapter {
  constructor(opts = {}) {
    // 合并默认定位配置（外部可覆盖部分字段）
    const merged = Object.assign({}, opts);
    if (!merged.locatorConfig) {
      merged.locatorConfig = DEFAULT_LOCATOR_CONFIG;
    } else {
      // 浅合并：外部 rules 覆盖默认 rules
      merged.locatorConfig = Object.assign({}, DEFAULT_LOCATOR_CONFIG, merged.locatorConfig);
      if (merged.locatorConfig.rules) {
        merged.locatorConfig.rules = Object.assign({}, DEFAULT_LOCATOR_CONFIG.rules, merged.locatorConfig.rules);
      }
    }
    super(merged);
  }

  /**
   * 覆写 parseProfile：把 profileFields 探测结果映射为 AccountPersona 字段。
   * 基类 scanProfile() 已把 probe 数据传入；这里做「页面→结构化数据」的字段映射。
   */
  parseProfile(probe, kind) {
    if (kind !== 'account') return null;
    // 从 probe 中找到 profileFields 规则的结果
    const pf = (probe || []).find((p) => p.rule === 'profileFields');
    if (!pf || !Array.isArray(pf.results)) return null;
    const identity = {};
    for (const r of pf.results) {
      if (!r.ok || !r.text) continue;
      // r.text 是字段名（如 'ニックネーム'），r.sample 是当前值（截断 80 字符）
      identity[r.text] = r.sample || '';
    }
    return {
      identity,
      account: {},
      gaps: [] // 子类可按需计算缺失字段
    };
  }

  /**
   * 覆写 scanMessagesJs：出会聊天页消息扫描脚本。
   * 返回 { peer, messages: [{ role, original, time, kind, url }] }。
   */
  scanMessagesJs() {
    return [
      '(function () {',
      '  function clean(v){ return String(v==null?"":v).replace(/\s+/g," ").trim(); }',
      '  var peer = "";',
      '  var peerEl = document.querySelector(".peer-name, .contact-name, .chat-header, .chat-peer-name, h1, h2");',
      '  if (peerEl) peer = clean(peerEl);',
      '  var items = [];',
      '  var msgNodes = document.querySelectorAll(".message, .msg, [class*=message], [class*=msg], .chat-item, .bubble");',
      '  for (var i = 0; i < msgNodes.length; i += 1) {',
      '    var el = msgNodes[i];',
      '    var text = clean(el.innerText || el.textContent || "");',
      '    if (!text || text.length > 2000) continue;',
      '    var isMine = /self|mine|me|right|send|own|自分|自分/.test((el.className || "").toLowerCase() + " " + el.getAttribute("data-role") + " " + el.getAttribute("data-side") + " ");',
      '    var timeText = "";',
      '    var timeEl = el.querySelector("[class*=time], [class*=date], .msg-time, .bubble-time");',
      '    if (timeEl) timeText = clean(timeEl);',
      '    items.push({ role: isMine ? "mine" : "peer", original: text, timeText: timeText, kind: "text", url: "" });',
      '  }',
      '  return { peer: peer, messages: items.slice(0, 200) };',
      '})()'
    ].join('\n');
  }
}

module.exports = { IchigoAdapter, DEFAULT_LOCATOR_CONFIG };
