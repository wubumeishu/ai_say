// =============================================================================
// happymail.co.jp（快乐）平台 Adapter · 对应测绘图 docs/plan/happy-platform-survey.md v4
// 复刻出会 IchigoAdapter 的 4 方法契约（platformAdapter.js 已定义 scanProfile/scanMessages/navigate/send）。
// 差异：出会=页面内 fetch 零导航；快乐=.php 服务端渲染（location.href 跳 .php）+ 13 业务 API POST（v5.2 坐实：读 8 + 帖 2 + 发 1 + 撤 2）。
// 状态：只注册不激活（默认 adapterPlatform 仍 ikuru，kairaku 待前端平台切换 UI 激活，归 Phase 4）。
// 红线：send 走基类默认（只读 DOM 不真发 §0.1）；happySendExpr.js 只测绘发送表单，真发实现待用户授权 + 合规闸门 §1.1。
// =============================================================================
'use strict';

const { PlatformAdapter } = require('./platformAdapter');
const fs = require('fs');
const path = require('path');

// 快乐平台抓取原语（12 个 happy*Expr.js，CDP eval 字符串；v5.2 扩 4 帖 + 1 撤）
function loadExpr(name) {
  try {
    return fs.readFileSync(path.join(__dirname, name), 'utf8');
  } catch (e) {
    console.error('[happyAdapter.loadExpr] 读取 ' + name + ' 失败:', e && e.message);
    return '';
  }
}

// 快乐平台默认定位配置（选择器来源：测绘图 §3/§10）
const HAPPY_LOCATOR_CONFIG = {
  platform: 'kairaku',
  baseUrl: 'happymail.co.jp',
  matchUrl: 'happymail.co.jp',       // CDP 匹配：url.indexOf('happymail.co.jp')
  // 收件箱（§10.1 message_list.php）
  inboxExpr: 'happyInboxExpr.js',
  // 会话历史（§7 message_detail.php?mailID={b64}）
  historyExpr: 'happyHistoryExpr.js',
  // 客户详情（§10.2 profile_detail.php?tid={memberID}）
  profileDetailExpr: 'happyProfileDetailExpr.js',
  // 客源 3 路（§10.1/§10.3/§10.4：profile_list / type_list / keijiban）
  sourceExprs: ['happyProfileSearchExpr.js', 'happyTypeExpr.js', 'happyBillboardExpr.js'],
  // 发送（§0.1 红线：只测绘 DOM 不真发；v5.2 成功判定坐实 send_message.php=200）
  sendExpr: 'happySendExpr.js',
  // 撤回（v5.2 坐实：.revokeTextMessage → remodal「送信取消」→ revokeTextMessage.php；只读标注）
  revokeExpr: 'happyRevokeExpr.js',
  // 客户招募帖（v5.2 新增情报维度：帖子列表 + 单帖正文/标签）
  billboardListExpr: 'happyBillboardListExpr.js',
  billboardDetailExpr: 'happyBillboardDetailExpr.js',
  // 业务 API 端点（v5.2 坐实 13 个，全部 POST /sp/app/api/html/ 下；token 分域）
  apiEndpoints: {
    read: [
      '/sp/app/api/html/list_message.php',            // 收件箱全量（count=100 一次拉全）
      '/sp/app/api/html/message_detail.php',          // 会话全量（offset+count 翻页）
      '/sp/app/api/html/list_profile_gallery.php',    // 检索客源
      '/sp/app/api/html/list_billboard.php',          // BBS 招募池
      '/sp/app/api/html/typelist.php',                // 点赞三路
      '/sp/app/api/html/list_profile_ashi.php',       // 足迹（主动看我的人）
      '/sp/app/api/html/get_profile_fixed_phrase.php',// 客户画像 40+ 字段
      '/sp/app/api/html/get_notification_banner_info.php' // 未读/通知
    ],
    billboard: [
      '/sp/app/api/html/get_profile_billboard.php',   // 客户帖子列表
      '/sp/app/api/html/get_billboard.php'            // 单帖正文 billboard_body + 标签 scene_name_list
    ],
    send: ['/sp/app/api/html/send_message.php'],
    revoke: ['/sp/app/api/html/getTextMessageRevokeStatus.php', '/sp/app/api/html/revokeTextMessage.php'],
    note: 'token 分域：read 用会话 UID；billboard/send/revoke 用独立 token（动态获取）。UA 伪装 HappyHills/Web/8.3.0'
  },

  rules: {
    profile: [
      // 客户详情全字段（§10.2 .ds_profile_select_list_item + 兴趣 + 头像判定）
      'ds_profile|.ds_profile_select_list_item',
      'interest|.ds_circle_text_list_item li',
      'avatar|.ds_profile_picture'
    ],
    messages: [
      // 会话历史消息块（§7）
      'msg-send|.message__block--send',
      'msg-receive|.message__block--receive',
      'msg-body|.message__block__body__text',
      'msg-time|.message__block__body__time',
      'msg-opened|.message__block__body__time__opened'
    ]
  }
};

class HappyAdapter extends PlatformAdapter {
  constructor(opts = {}) {
    const merged = Object.assign({}, opts);
    if (!merged.locatorConfig) {
      merged.locatorConfig = HAPPY_LOCATOR_CONFIG;
    } else {
      merged.locatorConfig = Object.assign({}, HAPPY_LOCATOR_CONFIG, merged.locatorConfig);
      if (merged.locatorConfig.rules) {
        merged.locatorConfig.rules = Object.assign({}, HAPPY_LOCATOR_CONFIG.rules, merged.locatorConfig.rules);
      }
    }
    super(merged);
    // 装载 7 Expr 字符串（CDP eval 用；缺失给 '' 不崩）
    this._inboxExpr = loadExpr('happyInboxExpr.js');
    this._historyExpr = loadExpr('happyHistoryExpr.js');
    this._profileDetailExpr = loadExpr('happyProfileDetailExpr.js');
    this._profileSearchExpr = loadExpr('happyProfileSearchExpr.js');
    this._typeExpr = loadExpr('happyTypeExpr.js');
    this._billboardExpr = loadExpr('happyBillboardExpr.js');
    this._sendExpr = loadExpr('happySendExpr.js');
    this._revokeExpr = loadExpr('happyRevokeExpr.js');
    this._billboardListExpr = loadExpr('happyBillboardListExpr.js');
    this._billboardDetailExpr = loadExpr('happyBillboardDetailExpr.js');
  }

  /**
   * 覆写 parseProfile：快乐客户详情（§10.2）映射为 AccountPersona 字段。
   * 与出会差异：快乐人设=profile.php 页面数据（非本地表），客户详情=.ds_profile_select_list_item 全字段。
   * @returns {object} { identity, account, gaps } 或 null
   */
  parseProfile(probe, kind) {
    if (kind !== 'account') return null;
    const pf = (probe || []).find((p) => p.rule === 'profile');
    if (!pf || !Array.isArray(pf.results)) return null;
    const identity = {};
    for (const r of pf.results) {
      if (!r.ok || !r.sample) continue;
      identity[r.css] = r.sample;
    }
    return { identity, account: {}, gaps: [] };
  }

  /**
   * 覆写 scanMessagesJs：快乐会话历史扫描脚本（§7 message_detail.php）。
   * 返回 { mailID, messages: [{ role, original, time, readReceipt, kind, url }] }。
   * 消息块：.message__block--send（我）/ --receive（对方）+ 正文/时间/已读回执。
   */
  scanMessagesJs() {
    // 直接用 happyHistoryExpr.js 的表达式字符串（已含 .message__block 全选择器）
    var fallback = "(function(){ return { mailID:'', messages:[], count:0 }; })()";
    return this._historyExpr || fallback;
  }


  /**
   * 覆写 navigate：快乐 .php location.href 跳转（出会=零导航页面内 fetch）。
   * 收件箱/会话/详情走 location.href 导航（渲染模型差异，§0）。
   */
  navigateJs(target) {
    var t = String(target || 'inbox');
    var routes = {
      inbox: '/sp/app/html/message_list.php',
      sourceProfile: '/sp/app/html/profile_list.php',
      sourceType: '/sp/app/html/type_list.php',
      sourceBillboard: '/sp/app/html/keijiban.php',
      mypage: '/sp/app/html/mypage.php',
      profile: '/sp/app/html/profile.php'
    };
    var url = routes[t];
    if (!url) {
      return '(function(){ return { ok:false, reason:"unknown-target", target:' + JSON.stringify(t) + ' }; })()';
    }
    return '(function(){ location.href = ' + JSON.stringify(url) + '; return { ok:true, target:' + JSON.stringify(t) + ', url:' + JSON.stringify(url) + ' }; })()';
  }


  /**
   * 覆写 send：快乐发送 DOM（§0.1 红线——本 Adapter 只读不真发）。
   * 基类 send() 默认实现：把消息填入发送框不点提交（建议→确认→执行，AI 永不直接发）。
   * happySendExpr.js 只抽取发送表单结构 + 风控字段，供真发坐实（真发实现待用户授权 + 合规闸门 §1.1）。
   */
  sendJs() {
    // 红线：不点提交、不发 fetch/POST（基类默认 send 也只填不提交，此处显式返回只读探测）
    var fallback = "(function(){ return { ok:false, reason:'send-not-implemented', readOnly:true }; })()";
    return this._sendExpr || fallback;
  }


  // 暴露 Expr 字符串（CDP eval 时按需求取）
  getInboxExpr() { return this._inboxExpr; }
  getHistoryExpr() { return this._historyExpr; }
  getProfileDetailExpr() { return this._profileDetailExpr; }
  getSendExpr() { return this._sendExpr; }
  // v5.2 新增：撤回 / 客户帖子（列表 + 单帖详情）
  getRevokeExpr() { return this._revokeExpr; }
  getBillboardListExpr() { return this._billboardListExpr; }
  getBillboardDetailExpr() { return this._billboardDetailExpr; }
  // v5.2：13 业务 API 端点（读/帖/发/撤，token 分域）
  getApiEndpoints() { return this.locatorConfig.apiEndpoints || {}; }
}

module.exports = { HappyAdapter, HAPPY_LOCATOR_CONFIG };
