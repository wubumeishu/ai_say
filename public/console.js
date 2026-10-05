// =============================================================================
// Ai SAY M5 · 卡片式统一控制台 · console.js
// 依据：docs/plan/04-roadmap.md §2 ui 角色 + task-19
// 设计原则（ui 边界）：
//   - 只读 /api/console/* 统一后台 API，不写后端业务逻辑、不抓 DOM；
//   - 卡片 = 头像 + 账号人设标签 + 客户画像 + 对话流 + 推荐回复 + 一键引流；
//   - 账号/客户资料页独立呈现；统一规则面板；指标看板（延迟≤1min，30s 轮询）；
//   - DOM 告警 30s 内推送（locator-misses 轮询 + 顶栏 badge）；话术一键回滚（调 rules/rollback）。
// =============================================================================
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = (path, opts) => fetch(path, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Object.assign(new Error((data && data.msg) || ('HTTP ' + r.status)), { data });
  return data;
});
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

const POLL_MS = 30000; // 指标延迟≤1min：30s 轮询一次
const LOCATOR_MS = 30000; // DOM 告警 30s 内推送
const LIFECYCLE = { new: '新', active: '活跃', silent: '沉默', churned: '流失' };
const STATE = { view: 'customers', customer: null, accountsLoaded: false, likelyCursor: 0, lastLocatorCursor: 0, accountId: null, accounts: [], liveWindow: null, liveProfile: null, liveMessages: [], liveDeep: null };

function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'bad');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 2600);
}
function refreshTick() {
  const d = new Date();
  $('#refreshText').textContent = d.toLocaleTimeString() + ' · 30s 轮询';
  $('#refreshDot').classList.remove('idle');
  setTimeout(() => $('#refreshDot').classList.add('idle'), 1500);
}

// ---------------------------------------------------------------- 头像
function avatarFor(name, merged) {
  const el = document.createElement('div');
  el.className = 'avatar' + (merged ? ' merged' : '');
  el.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return el;
}
function tierBadge(tier) {
  const map = { hot: 'hot', warm: 'warm', cold: 'cold' };
  return '<span class="badge ' + (map[tier] || 'cold') + '">' + (tier || 'cold') + '</span>';
}
function lcBadge(lc) {
  return '<span class="badge lc">' + (LIFECYCLE[lc] || lc || '—') + '</span>';
}

// ---------------------------------------------------------------- 客户卡片网格
function customersUrl() {
  // M5 核心改造①（task-36）：客户卡片切到实时端点 /api/console/live（连活 17098 窗口抓出会页面），
  // 不再读 9/27 迁移 DB 的静态快照。窗口未开 / 连不上时 live 返回 ok:false，前端降级回 DB 快照 /api/console/customers。
  return '/api/console/live';
}
async function loadCustomers() {
  const host = $('#view-customers');
  host.innerHTML = '<div class="empty">加载客户卡片…（实时连出会窗口 17098）</div>';
  // M5 核心改造②：先打 /api/console/live/deep（17098 深度抓取：收件箱 2 页 + 资料页 12 字段 + 兴趣 icon 反查）
  let deep;
  try { deep = await api('/api/console/live/deep'); } catch (_) { deep = null; }
  if (deep && deep.ok && Array.isArray(deep.contacts) && deep.contacts.length) {
    STATE.liveDeep = deep;
    host.innerHTML = renderDeep(deep);
    refreshTick();
    return;
  }
  // 深度端点失败（窗口未开 / 连不上）→ 降级打 /api/console/live（task-36 实时）
  let payload;
  try { payload = await api(customersUrl()); }
  catch (e) { host.innerHTML = '<div class="empty">出会窗口未连接（' + esc(e.message) + '）</div>'; return; }
  if (payload && payload.ok && (Array.isArray(payload.contacts) && payload.contacts.length || Array.isArray(payload.messages) && payload.messages.length)) {
    STATE.liveWindow = payload.window || null;
    STATE.liveProfile = payload.profile || null;
    STATE.liveMessages = payload.messages || [];
    host.innerHTML = renderLive(payload);
    $$('.card.clickable', host).forEach((c) => c.addEventListener('click', () => openCustomer(c.dataset.id)));
    refreshTick();
    return;
  }
  // 实时端点也失败 → 降级回 DB 快照
  let data;
  try {
    const snap = await api(STATE.accountId ? '/api/console/customers?accountId=' + encodeURIComponent(STATE.accountId) : '/api/console/customers');
    data = snap.data || snap;
  } catch (e) { host.innerHTML = '<div class="empty">出会窗口未连接且 DB 快照不可用：' + esc(e.message) + '</div>'; return; }
  if (!data || !data.length) { host.innerHTML = '<div class="empty">出会窗口未连接且 DB 快照暂无客户（可先 /browser/open 打开 17098）</div>'; return; }
  host.innerHTML = '<div class="cards">' + data.map(cardHtml).join('') + '</div>';
  $$('.card.clickable', host).forEach((c) => c.addEventListener('click', () => openCustomer(c.dataset.id)));
  refreshTick();
}

// M5 核心改造②：深度抓取渲染（17098 收件箱 2 页 + 资料页 12 字段 + 兴趣 icon 反查 + 头像）
function renderDeep(deep) {
  const nav = Array.isArray(deep.nav) ? deep.nav : [];
  const contacts = Array.isArray(deep.contacts) ? deep.contacts : [];
  const paginator = deep.paginator || null;

  let html = '<div class="card wide" style="margin-bottom:12px">';
  html += '<div class="card-head"><div class="who"><div class="name">出会窗口 17098 实时数据</div>';
  html += '<div class="nick">' + (deep.fetchedAt ? new Date(deep.fetchedAt).toLocaleString() : '') + ' · ' + contacts.length + ' 个客户</div></div></div>';
  html += '<div class="card-body"><div class="profile-grid">';
  html += '<span class="k">客户总数</span><span class="v">' + contacts.length + '</span>';
  html += '<span class="k">分页</span><span class="v">' + (paginator ? paginator.map(function(p) { return p.text + (p.isCurrent ? '（当前）' : ''); }).join(' / ') : '—') + '</span>';
  if (nav.length) {
    html += '<span class="k">底部导航</span><span class="v">' + nav.map(function(n) { return esc(n.label) + (n.badge ? '（' + esc(n.badge) + '）' : ''); }).join(' / ') + '</span>';
  }
  html += '</div></div></div>';

  html += '<div class="cards">';
  contacts.forEach(function(c, i) {
    var name = c.name || ('客户 ' + (i + 1));
    var parts = String(c.raw || '').split('|').map(function(s) { return s.trim(); }).filter(Boolean);
    var time = parts[0] || '';
    var ageRegion = parts[2] || '';
    var lastMsg = parts[3] || '';

    html += '<div class="card clickable" data-idx="' + i + '">';
    html += '<div class="card-head">';
    if (c.avatarUrl && !c.avatarIsDefault) {
      html += '<img src="' + esc(c.avatarUrl) + '" alt="' + esc(name) + '" style="width:40px;height:40px;border-radius:50%;object-fit:cover">';
    } else if (c.avatarUrl && c.avatarIsDefault) {
      html += '<img src="' + esc(c.avatarUrl) + '" alt="' + esc(name) + '" style="width:40px;height:40px;border-radius:50%;object-fit:cover;opacity:0.5" title="默认头像">';
    } else {
      html += '<div style="width:40px;height:40px;border-radius:50%;background:#ccc;display:flex;align-items:center;justify-content:center;font-size:18px">' + (name.charAt(0) || '?') + '</div>';
    }
    html += '<div class="who"><div class="name">' + esc(name) + '</div>';
    html += '<div class="nick">' + esc(ageRegion) + (time ? ' · ' + esc(time) : '') + '</div></div></div>';

    html += '<div class="card-body">';
    if (lastMsg) html += '<div style="font-size:12px;color:#888;margin-bottom:8px">' + esc(lastMsg) + '</div>';

    if (Array.isArray(c.interests) && c.interests.length) {
      html += '<div style="margin-bottom:8px">';
      c.interests.forEach(function(it) {
        var tag = it.label ? esc(it.label) : ('icon ' + esc(it.icon) + '（未映射）');
        var cls = it.unknown ? 'border:1px dashed #ccc' : '';
        html += '<span style="display:inline-block;padding:2px 6px;margin:2px;font-size:11px;background:#f0f0f0;border-radius:4px;' + cls + '">' + tag + '</span>';
      });
      html += '</div>';
    }

    if (Array.isArray(c.bbsPosts) && c.bbsPosts.length) {
      html += '<div style="margin-bottom:8px;font-size:11px;color:#888">';
      html += '<strong>招募帖子（' + c.bbsPosts.length + ' 条）</strong>';
      c.bbsPosts.forEach(function(p) {
        html += '<div style="margin-top:4px">' + esc(p.genre || '') + ' · ' + esc(p.time || '') + ' · ' + esc(p.region || '') + ' · 浏览 ' + esc(p.viewCount || '0') + ' 人</div>';
        html += '<div style="font-size:12px">' + esc(p.content || '') + '</div>';
      });
      html += '</div>';
    }

    if (c.profile && c.profile.raw) {
      var fields = parseProfileFields(c.profile.raw);
      if (Object.keys(fields).length) {
        html += '<div style="font-size:11px;margin-top:4px"><strong>基本资料</strong><div class="profile-grid">';
        Object.keys(fields).forEach(function(k) {
          html += '<span class="k">' + esc(k) + '</span><span class="v">' + esc(fields[k]) + '</span>';
        });
        html += '</div></div>';
      }
    }
    html += '</div></div>';
  });
  html += '</div>';
  return html;
}

function parseProfileFields(raw) {
  var lines = String(raw || '').split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
  var out = {};
  var knownKeys = ['出身地','交際ステータス','子供','職業','年収','血液型','星座','キャリア','身長','タイプ','目','タバコ','お酒','車'];
  for (var i = 0; i < lines.length - 1; i++) {
    if (knownKeys.indexOf(lines[i]) !== -1) {
      var key = lines[i];
      var val = lines[i + 1] || '';
      if (!out[key]) out[key] = val;
    }
  }
  return out;
}

// M5 核心改造①（task-36）：实时数据渲染（出会 inbox 客户行 + 聊天流 + 账号画像）
function renderLive(payload) {
  const win = payload.window || {};
  const profile = payload.profile || null;
  const persona = profile && profile.accountPersona ? profile.accountPersona : null;
  const customer = profile && profile.customerProfile ? profile.customerProfile : null;
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
  const header = '<div class="card wide" style="margin-bottom:12px">' +
    '<div class="card-head"><div class="who"><div class="name">出会窗口实时数据</div>' +
    '<div class="nick">' + esc(win.windowId || '—') + ' · ' + (payload.scannedAt ? new Date(payload.scannedAt).toLocaleTimeString() : '') + '</div></div></div>' +
    '<div class="card-body">' +
    '<div class="profile-grid">' +
    '<span class="k">页面</span><span class="v">' + esc(payload.targetUrl || '—') + '</span>' +
    '<span class="k">定位告警</span><span class="v">' + (payload.locatorMissCount || 0) + ' 次</span>' +
    '</div>' +
    (persona && Object.keys(persona.identity || {}).length
      ? '<div><strong style="font-size:11px;color:var(--muted)">账号画像</strong> ' +
        Object.entries(persona.identity).slice(0, 8).map(([k, v]) => '<span class="tag">' + esc(k) + ': ' + esc(v) + '</span>').join('') + '</div>'
      : '') +
    (customer && Object.keys(customer.identity || {}).length
      ? '<div><strong style="font-size:11px;color:var(--muted)">客户画像</strong> ' +
        Object.entries(customer.identity).slice(0, 8).map(([k, v]) => '<span class="tag">' + esc(k) + ': ' + esc(v) + '</span>').join('') + '</div>'
      : '') +
    '</div></div>';
  // 客户卡片（出会 inbox 行）
  const cards = contacts.length ? '<div class="cards">' + contacts.slice(0, 20).map((row) =>
    '<div class="card clickable" data-id="' + esc(String(row.nickname || row.avatar || '')) + '">' +
    '<div class="card-head"><div class="who"><div class="name">' + esc(row.nickname || '—') + '</div>' +
    '<div class="nick">' + [row.gender, row.age ? row.age + '岁' : '', row.location].filter(Boolean).join(' · ') + '</div></div></div>' +
    '<div class="card-body">' +
    '<span class="tag">' + esc(row.online || '—') + '</span> ' +
    (row.lastMessage ? '<div class="preview">' + esc(row.lastMessage.slice(0, 60)) + '</div>' : '') +
    '</div></div>'
  ).join('') + '</div>' : '';
  // 聊天流
  const msgBlock = msgs.length ? '<div class="card" style="margin-top:12px">' +
    '<div class="card-head"><div class="who"><div class="name">消息流（' + msgs.length + ' 条）</div></div></div>' +
    '<div class="card-body">' +
    msgs.slice(-30).map((m) =>
      '<div class="msg ' + (m.role === 'mine' ? 'mine' : 'peer') + '"><span class="msg-role">' + esc(m.role === 'mine' ? '我' : '对方') + '</span> ' +
      '<span class="msg-text">' + esc(m.original || m.text || '') + '</span>' +
      (m.translation ? '<span class="msg-trans">' + esc(m.translation) + '</span>' : '') +
      '</div>'
    ).join('') + '</div></div>' : '';
  return header + cards + msgBlock;
}
function cardHtml(c) {
  const p = c.profile || {};
  const persona = c.accountPersona;
  const conv = c.latestConversation;
  const interestTags = Array.isArray(p.interests) ? p.interests.slice(0, 4).map((i) => '<span class="tag">' + esc(i) + '</span>').join('') : '';
  const personaTags = persona
    ? '<div style="margin-top:2px">' + [persona.tone && '语气:' + persona.tone, persona.targetAudience && '面向:' + persona.targetAudience].filter(Boolean).map((s) => '<span class="tag">' + esc(s) + '</span>').join('') + '</div>'
    : '';
  const conf = typeof p.confidence === 'number' ? Math.round(p.confidence * 100) + '%' : '—';
  const leadBtn = c.mergedInto ? '' : '<button class="btn primary" data-lead="' + esc(c.contactId) + '">一键引流</button>';
  return '<div class="card clickable" data-id="' + esc(c.contactId) + '">' +
    '<div class="card-head">' + avatarFor(c.displayName || c.nickname, c.mergedInto) +
    '<div class="who"><div class="name">' + esc(c.displayName || c.nickname || '—') + '</div>' +
    '<div class="nick">' + (c.mergedInto ? '已归并 → ' + esc(c.mergedInto.slice(0, 12)) + '…' : '生命周期 ' + (LIFECYCLE[c.lifecycle] || c.lifecycle || '—')) + '</div></div>' +
    '<div style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:4px">' + tierBadge(p.intent) + lcBadge(c.lifecycle) + '</div>' +
    '</div>' +
    '<div class="card-body">' +
      (persona ? '<div><strong style="font-size:11px;color:var(--muted)">账号人设</strong>' + personaTags + '</div>' : '') +
      '<div class="profile-grid">' +
      '<span class="k">年龄</span><span class="v">' + esc(p.age || '—') + '</span>' +
      '<span class="k">地区</span><span class="v">' + esc(p.region || '—') + '</span>' +
      '<span class="k">职业</span><span class="v">' + esc(p.occupation || '—') + '</span>' +
      '<span class="k">语言</span><span class="v">' + esc(p.language || '—') + '</span>' +
      '<span class="k">意向</span><span class="v">' + (p.intent || '—') + ' ' + tierBadge(p.intent) + '</span>' +
      '<span class="k">画像置信度</span><span class="v">' + conf + '</span>' +
      '</div>' +
      (interestTags ? '<div>' + interestTags + '</div>' : '') +
      (p.historySummary ? '<div style="font-size:12px;color:var(--muted)">' + esc(p.historySummary).slice(0, 160) + '</div>' : '') +
      (conv ? '<div class="chat-prev"><div style="font-size:11px;color:var(--muted);margin-bottom:4px">最近对话流 · ' + esc(conv.channel || '') + '</div>' +
        '<div data-prev-for="' + esc(c.contactId) + '"></div></div>' : '') +
    '</div>' +
    '<div class="card-foot">' +
      '<button class="btn" data-open-detail="' + esc(c.contactId) + '">详情</button>' +
      leadBtn +
    '</div>' +
    '</div>';
}

// ---------------------------------------------------------------- 客户详情（对话流 + 推荐回复 + 引流事件）
async function openCustomer(contactId) {
  STATE.customer = contactId;
  const side = $('#sidePanel');
  side.innerHTML = '<div class="empty">加载客户详情…</div>';
  let d;
  const url = '/api/console/customers/' + encodeURIComponent(contactId) +
    (STATE.accountId ? '?accountId=' + encodeURIComponent(STATE.accountId) : '');
  try { d = (await api(url)).data; }
  catch (e) { side.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  const c = d.contact || {};
  const p = d.profile || {};
  const rec = d.recommendedReply;
  const convs = d.conversations || [];
  const conv0 = convs[0];
  const msgs = d.messages || [];
  const leads = d.leadEvents || [];

  side.innerHTML =
    '<div><span class="back" data-back>← 返回客户列表</span></div>' +
    '<div class="panel" style="margin-bottom:12px"><div style="display:flex;gap:10px;align-items:center">' + avatarFor(c.displayName, c.mergedInto) +
      '<div><div style="font-weight:600">' + esc(c.displayName || c.nickname || '—') + '</div>' +
      '<div style="font-size:12px;color:var(--muted)">' + (LIFECYCLE[c.lifecycle] || c.lifecycle || '—') + ' · ' + tierBadge(p.intent) + '</div></div></div>' +
      '<div class="kv" style="margin-top:12px">' +
      '<span class="k">年龄</span><span>' + esc(p.age || '—') + '</span>' +
      '<span class="k">地区</span><span>' + esc(p.region || '—') + '</span>' +
      '<span class="k">职业</span><span>' + esc(p.occupation || '—') + '</span>' +
      '<span class="k">意向</span><span>' + esc(p.intent || '—') + '</span>' +
      '<span class="k">置信度</span><span>' + (typeof p.confidence === 'number' ? Math.round(p.confidence * 100) + '%' : '—') + '</span>' +
      '</div>' +
      (d.anchors && d.anchors.length ? '<div style="margin-top:12px"><h3>身份锚点</h3><div class="anchors">' +
        d.anchors.map((a) => '<div class="anchor"><strong>' + esc(a.kind) + '</strong> · ' + esc(a.value) + '（conf ' + (a.confidence == null ? '—' : Math.round(a.confidence * 100) + '%') + '）</div>').join('') + '</div></div>' : '') +
      '</div>' +

    '<div class="panel" style="margin-bottom:12px"><h3>对话流' + (conv0 ? ' · ' + esc(conv0.channel) : '') + '</h3>' +
      (msgs.length ? '<div class="chat-full">' + msgs.map((m) =>
        '<div class="msg ' + (m.role === 'me' ? 'me' : 'other') + '"><div class="head">' +
        '<span>' + (m.role === 'me' ? '我' : '客户') + '</span>' + (m.timeText ? '<span>' + esc(m.timeText) + '</span>' : '') + '</div>' +
        '<div class="body">' + esc(m.translation && m.translation !== m.original ? m.translation + (m.original ? ' <span style="color:var(--muted)">(原文 ' + esc(m.original) + ')</span>' : '') : m.original) + '</div></div>'
      ).join('') + '</div>' : '<div class="empty">暂无消息</div>') +
      '</div>' +

    // task-37：推荐回复默认折叠为「待确认」状态（话术只生成不自动发），老板点「确认发送」才调 /api/console/send-confirm
    '<div class="panel" style="margin-bottom:12px"><h3>推荐回复' + (rec ? ' <span class="status pending" style="font-weight:400">待确认 · ' + esc(rec.tier || 'warm') + ' · 变体 ' + esc(rec.variant || '—') + '</span>' : '') + '</h3>' +
      (rec && (rec.guide || (rec.replies && rec.replies.length))
        ? '<div class="rec-reply pending"><div class="label">引导话术 · <span class="pending-tag">待老板确认发送</span>' + (rec.personalized ? ' · LLM 个性化' : rec.fallback ? ' · 兜底模板' : '') + '</div>' +
          '<div class="text">' + esc(rec.guide || (rec.replies && rec.replies[0]) || '') + '</div>' +
          (rec.replies && rec.replies.length > 1 ? '<div class="more">（共 ' + rec.replies.length + ' 条候选，第 1 条待确认）</div>' : '') +
          '<div class="meta">' +
          (rec.gateOk === false ? '<span class="gate-bad">合规闸门 ✗ ' + esc(rec.gateReason || '') + '</span>' : '<span style="color:var(--ok)">合规闸门 ✓</span>') +
          (rec.templateVersion ? '<span>v=' + esc(String(rec.templateVersion).slice(0, 8)) + '</span>' : '') +
          '</div></div>'
        : '<div class="empty">未生成推荐回复' + (rec && rec.note ? ' · ' + esc(rec.note) : '') + '</div>') +
      '<div class="card-foot" style="border-top:none;padding-top:10px">' +
      '<button class="btn" data-detail-lead="' + esc(c.contactId) + '">生成/刷新引导话术</button> ' +
      '<button class="btn primary" data-send-confirm="' + esc(c.contactId) + '">确认发送</button>' +
      '</div>' +
      '</div>' +

    (leads && leads.length ? '<div class="panel"><h3>引流事件</h3><div class="lead-list">' +
      leads.slice(0, 10).map((l) => '<div class="lead-item">' + tierBadge(l.tier) + ' ' + esc(l.action) + ' · 分 ' + (l.score == null ? '—' : l.score) +
        (l.lineOffered ? ' · 已推LINE' : '') + (l.lineAdded ? ' · 已加LINE' : '') + ' · ' + (l.createdAt || '').slice(0, 10) + '</div>').join('') +
      '</div></div>' : '');

  $$('[data-back]', side).forEach((b) => b.addEventListener('click', () => loadCustomers()));
  $$('[data-detail-lead]', side).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await post('/api/console/lead/' + b.dataset.detailLead, {}); toast('已生成引导话术（待确认）'); setTimeout(openCustomer, 900); }
    catch (e) { b.disabled = false; toast('生成失败: ' + e.message, false); }
  }));
  // task-37：老板点「确认发送」→ 调 /api/console/send-confirm（经合规闸门 + 频控才真发）
  $$('[data-send-confirm]', side).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '确认中…';
    try {
      const r = await post('/api/console/send-confirm', { contactId: b.dataset.sendConfirm });
      if (r && r.data && r.data.sent) { toast('已确认发送'); }
      else { toast('未发送：' + ((r && r.data && r.data.note) || '无待确认话术'), false); }
      setTimeout(openCustomer, 900);
    } catch (e) { b.disabled = false; b.textContent = '确认发送'; toast('确认失败: ' + e.message, false); }
  }));
}

// 侧栏「账号资料页」：从客户卡片详情可跳转（这里提供入口）
async function openAccountPage(accountId) {
  const side = $('#sidePanel');
  side.innerHTML = '<div class="empty">加载账号资料页…</div>';
  let d;
  try { d = (await api('/api/console/accounts/' + encodeURIComponent(accountId))).data; }
  catch (e) { side.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  const a = d.account || {};
  const personas = d.personas || [];
  const active = personas.find((p) => p.status === 'active') || personas[0] || null;
  side.innerHTML =
    '<div><span class="back" data-back="accounts">← 返回</span></div>' +
    '<div class="panel"><h3>账号资料页</h3>' +
    '<div class="kv"><span class="k">平台</span><span>' + esc(a.platform || '—') + '</span>' +
    '<span class="k">标签</span><span>' + esc(a.label || '—') + '</span>' +
    '<span class="k">状态</span><span>' + esc(a.status || '—') + '</span>' +
    '<span class="k">窗口数</span><span>' + (d.windows ? d.windows.length : 0) + '</span>' +
    '<span class="k">会话数</span><span>' + (d.conversationCount || 0) + '</span></div>' +
    (active ? '<div style="margin-top:12px"><h3>当前人设（AccountPersona）</h3>' +
      '<div class="kv"><span class="k">语气</span><span>' + esc(active.tone || '—') + '</span>' +
      '<span class="k">背景</span><span>' + esc(active.background || '—') + '</span>' +
      '<span class="k">面向</span><span>' + esc(active.targetAudience || '—') + '</span>' +
      '<span class="k">禁忌</span><span>' + (Array.isArray(active.taboos) ? active.taboos.map(esc).join('，') : '—') + '</span></div></div>' : '') +
    '</div>';
  $$('[data-back]', side).forEach((b) => b.addEventListener('click', () => loadCustomers()));
}

// ---------------------------------------------------------------- 多账号切换顶栏（M5 task-25）
async function loadAccounts() {
  const host = $('#accountChips');
  if (!host) return;
  let data;
  try { data = (await api('/api/console/accounts')).data; }
  catch (_) { host.innerHTML = '<button class="acc-chip active" data-account-id="">全部账号</button>'; return; }
  STATE.accounts = Array.isArray(data) ? data : [];
  renderAccountChips();
}
function renderAccountChips() {
  const host = $('#accountChips');
  if (!host) return;
  host.innerHTML =
    '<button class="acc-chip' + (STATE.accountId ? '' : ' active') + '" data-account-id="">全部账号</button>' +
    STATE.accounts.map((a) =>
      '<button class="acc-chip' + (STATE.accountId === a.accountId ? ' active' : '') + '" data-account-id="' + esc(a.accountId) + '">' +
      esc(a.platform || '—') + ' · ' + esc(a.label || a.accountId.slice(0, 8)) +
      '<span class="sub">' + (a.active ? '在线' : a.status || '') + (a.windowCount ? ' ' + a.windowCount + '窗' : '') + '</span>' +
      '</button>'
    ).join('');
  $$('.acc-chip', host).forEach((c) => c.addEventListener('click', () => setAccount(c.dataset.accountId || null)));
}
function setAccount(accountId) {
  STATE.accountId = accountId;
  renderAccountChips();
  // 切换账号后刷新当前视图（客户列表带 ?accountId=）
  if (STATE.view === 'customers') { loadCustomers(); setTimeout(preloadChatPreviews, 400); }
  else if (STATE.view === 'metrics') loadMetrics();
  else if (STATE.view === 'rules') loadRules();
  else if (STATE.view === 'likely') loadLikelySame();
  else if (STATE.view === 'locator') loadLocator();
  else if (STATE.view === 'private-domain') loadPrivateDomain();
}
function rollbackTalk() {
  const btn = $('#rollbackBtn');
  if (btn) { btn.disabled = true; }
  post('/api/console/rules/rollback', { contactId: STATE.customer || undefined })
    .then((r) => {
      const d = r.data || {};
      toast(d.rolledBack === false && !d.via
        ? '已全局回退话术版本（TalkAbStat reDecide 标记）'
        : '已回滚话术到上一版（' + (d.previousTemplateVersion ? 'v=' + String(d.previousTemplateVersion).slice(0, 8) + '' : '全局') + '）', true);
      setTimeout(() => { loadMetrics(); }, 900); // 30s 轮询兜底 + 立即刷新指标
    })
    .catch((e) => toast('回滚失败: ' + e.message, false))
    .finally(() => { if (btn) btn.disabled = false; });
}
function bindRollbackButton() {
  const b = $('#rollbackBtn');
  if (b && !b._bound) { b._bound = true; b.addEventListener('click', rollbackTalk); }
}

// ---------------------------------------------------------------- 指标看板
function metricsUrl() {
  return STATE.accountId ? '/api/console/metrics?accountId=' + encodeURIComponent(STATE.accountId) : '/api/console/metrics';
}
async function loadMetrics() {
  const host = $('#view-metrics');
  host.innerHTML = '<div class="empty">加载指标看板…</div>';
  let m;
  try { m = (await api(metricsUrl())).data; }
  catch (e) { host.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  const cls = (v, target, invert) => {
    const pass = invert ? v <= target : v >= target;
    return pass ? 'ok' : 'warn';
  };
  const metric = (label, value, sub, target, invert, key) =>
    '<div class="metric"><div class="label">' + label + '</div>' +
    '<div class="value ' + cls(value, target, invert) + '">' + value + (target != null ? '%' : '') + '</div>' +
    '<div class="sub">' + sub + '</div><div class="target">目标 ' + (target != null ? target + '%' : '—') + '</div>' +
    (key === 'lead' && m.daily && m.daily.length ? '<div class="spark">' + m.daily.slice(-14).map((d) =>
      '<div class="bar" style="height:' + Math.max(4, Math.round((d.positive || 0) * 20)) + 'px" title="' + esc(d.d) + ' 转化 ' + (d.positive || 0) + '"></div>'
    ).join('') + '</div>' : '') + '</div>';

  // ---- 漏斗条（6 段水平，task-28） ----
  function funnelHtml() {
    const f = Array.isArray(m.funnel) ? m.funnel : [];
    if (!f.length) return '';
    const max = Math.max(1, ...f.map((s) => s.count || 0));
    return '<div class="funnel-wrap">' +
      f.map((s, i) => {
        const w = max ? Math.max(8, Math.round((s.count / max) * 100)) : 8;
        const color = i === f.length - 1 ? 'var(--ok)' : 'var(--accent)';
        return '<div class="funnel-seg" title="' + esc(s.layer) + ' ' + (s.count || 0) + '">' +
          '<div class="funnel-seg__bar" style="width:' + w + '%;background:' + color + '"></div>' +
          '<div class="funnel-seg__label">' + esc(s.layer) + '</div>' +
          '<div class="funnel-seg__count">' + (s.count || 0) + '</div>' +
          '<div class="funnel-seg__rate">' + (i === 0 ? '100%' : (s.rate + '%')) + '</div>' +
          '</div>';
      }).join('') + '</div>';
  }

  // ---- byAccount 分组卡（点击联动切账号，task-28） ----
  function byAccountHtml() {
    const rows = Array.isArray(m.byAccount) ? m.byAccount : [];
    if (!rows.length) return '<div class="empty" style="padding:12px">暂无账号运营数据（M0 会话未生成）</div>';
    return '<div class="byaccount-grid">' + rows.map((a) =>
      '<div class="byaccount-card" data-byaccount="' + esc(a.accountId) + '">' +
      '<div class="byaccount-card__head"><span class="byaccount-card__platform">' + esc(a.platform || '—') + '</span>' +
      '<span class="byaccount-card__label">' + esc(a.label || a.accountId.slice(0, 8)) + '</span></div>' +
      '<div class="byaccount-card__stats">' +
      '<div class="stat"><span class="stat__n">' + (a.contactCount || 0) + '</span><span class="stat__k">客户</span></div>' +
      '<div class="stat"><span class="stat__n">' + (a.conversationCount || 0) + '</span><span class="stat__k">会话</span></div>' +
      '<div class="stat"><span class="stat__n hot" style="color:var(--hot)">' + (a.hotCount || 0) + '</span><span class="stat__k">hot</span></div>' +
      '</div><div class="byaccount-card__hint">点击切换账号过滤 →</div></div>'
    ).join('') + '</div>';
  }

  // ---- dataFreshness 表格（lastUpdated>60s 标黄，task-28） ----
  function freshnessHtml() {
    const rows = Array.isArray(m.dataFreshness) ? m.dataFreshness : [];
    if (!rows.length) return '';
    return '<table class="freshness-table"><thead><tr><th>核心表</th><th>行数</th><th>最后更新</th><th>新鲜度</th></tr></thead><tbody>' +
      rows.map((t) => {
        const ts = t.lastUpdated ? new Date(t.lastUpdated).toLocaleString() : '—';
        const stale = t.stale === true;
        const age = t.ageMs != null ? (Math.round(t.ageMs / 1000) + 's 前') : '—';
        return '<tr class="' + (stale ? 'stale' : 'fresh') + '">' +
          '<td>' + esc(t.table) + '</td><td>' + (t.count || 0) + '</td><td>' + ts + '</td>' +
          '<td class="' + (stale ? 'stale-text' : 'fresh-text') + '">' + (stale ? '⚠ ' + age + '（>60s 过期）' : '● ' + age) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  host.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
    '<h2 style="margin:0;font-size:16px">指标看板 <span style="color:var(--muted);font-size:12px">（延迟≤1min · 30s 自动刷新 · 统计 ' + esc(m.days) + ' 天）</span></h2>' +
    '<button class="btn" style="flex:0 0 auto" data-rollback>话术一键回滚（上一版）</button></div>' +
    '<div class="metrics">' +
    metric('自动处理覆盖率', m.autoHandling.rate, '已处理 ' + m.autoHandling.handled + ' / ' + m.autoHandling.total + ' 会话', m.autoHandling.target, false) +
    metric('引流触发成功率', m.leadAcquisition.triggerSuccessRate, '发出 ' + m.leadAcquisition.offered + ' / 决策 ' + m.leadAcquisition.triggered, m.leadAcquisition.triggerTarget, false) +
    metric('引流转化成功率', m.leadAcquisition.conversionSuccessRate, '正向 ' + m.leadAcquisition.positive + ' / 发出 ' + m.leadAcquisition.offered, m.leadAcquisition.conversionTarget, false, 'lead') +
    metric('LINE 转化率', m.lineConversion.rate, '绑定 ' + m.lineConversion.bound + ' 名 LINE 好友', m.lineConversion.target, false) +
    metric('去重误并率（上限）', '—', '已合并 ' + m.dedup.mergedTotal + ' · 回滚 ' + m.dedup.rolledBack + ' · 待确认 ' + m.dedup.likelySameQueued, m.dedup.falseMergeTarget, false) +
    '</div>' +
    (m.funnel && m.funnel.length ? '<div class="metric-block"><h3 style="margin:8px 0">引流漏斗（会话 → 评分 → hot → 引流 → 留LINE → 绑定）</h3>' + funnelHtml() + '</div>' : '') +
    '<div class="metric-block"><h3 style="margin:8px 0">跨账号运营视图（点击切换账号过滤）</h3>' + byAccountHtml() + '</div>' +
    (m.dataFreshness && m.dataFreshness.length ? '<div class="metric-block"><h3 style="margin:8px 0">数据新鲜度（>60s 标黄）</h3>' + freshnessHtml() + '</div>' : '');
  $$('[data-rollback]', host).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '回滚中…';
    try { const r = await post('/api/console/rules/rollback', {});
      toast('已回滚到上一版话术（' + (r.data && r.data.via ? r.data.via : 'ok') + '）');
      setTimeout(loadMetrics, 700);
    } catch (e) { toast('回滚失败: ' + e.message, false); b.disabled = false; b.textContent = '话术一键回滚（上一版）'; }
  }));
  // byAccount 卡片 → 联动切账号（task-28）
  $$('[data-byaccount]', host).forEach((c) => c.addEventListener('click', () => setAccount(c.dataset.byaccount)));
  refreshTick();
}

// ---------------------------------------------------------------- 统一规则面板
function rulesUrl() {
  const p = new URLSearchParams();
  if (STATE.accountId) p.set('accountId', STATE.accountId);
  const s = p.toString();
  return '/api/console/rules' + (s ? '?' + s : '');
}
async function loadRules() {
  const host = $('#view-rules');
  host.innerHTML = '<div class="empty">加载统一规则…</div>';
  let r;
  try { r = (await api(rulesUrl())).data; }
  catch (e) { host.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  const rules = r.rules || [];
  const accountLabel = STATE.accountId
    ? (' · 过滤账号 ' + ((STATE.accounts.find((a) => a.accountId === STATE.accountId) || {}).label || STATE.accountId))
    : '';
  host.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
    '<div>' +
    (r.effective && r.effective.denyByDefault ? '<div class="deny-banner" style="margin-bottom:6px">denyByDefault：存在 compliance 规则但未命中 allow ⇒ 默认拒绝发送</div>' : '') +
    '<div style="font-size:12px;color:var(--muted)">GovernanceRule · ' + rules.length + ' 条 active · 全局 ⊃ 平台 ⊃ 账号 叠加，priority 高者胜' + accountLabel + '</div>' +
    '</div>' +
    '<button class="btn btn-danger" style="flex:0 0 auto" data-rollback-rule>↶ 话术回滚（全局）</button>' +
    '</div>' +
    '<div class="rules">' +
    (rules.length ? rules.map((g) => {
      let spec = '';
      try { spec = g.rule ? JSON.stringify(JSON.parse(g.rule)) : ''; } catch (_) { spec = g.rule || ''; }
      return '<div class="rule-row"><span class="type">' + esc(g.ruleType || '—') + '</span>' +
        '<span class="scope">' + esc(g.scope || 'global') + (g.scopeKey ? '/' + esc(g.scopeKey) : '') + '</span>' +
        '<span class="spec" title="' + esc(spec) + '">' + esc(spec) + '</span>' +
        '<span class="prio">prio ' + (g.priority == null ? 0 : g.priority) + '</span></div>';
    }).join('') : '<div class="empty">暂无 active 规则</div>') +
    '</div>';
  $$('[data-rollback-rule]', host).forEach((b) => b.addEventListener('click', rollbackTalk));
  refreshTick();
}

// ---------------------------------------------------------------- DOM 告警卡片
async function loadLocator() {
  const host = $('#view-locator');
  host.innerHTML = '<div class="empty">加载 DOM 告警…</div>';
  let r;
  try { r = (await api('/api/console/locator-misses?sinceCursor=' + STATE.lastLocatorCursor + '&windowMs=' + LOCATOR_MS)).data; }
  catch (e) { host.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  STATE.lastLocatorCursor = r.nextCursor || 0;
  const events = r.events || [];
  $('#locAlert').classList.toggle('hidden', events.length === 0);
  $('#locAlertBadge').textContent = 'DOM 告警 ' + events.length;
  host.innerHTML =
    '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">M2 adapter · onLocatorMiss · 30s 内推送窗口 · 当前 ' + (events.length ? '新事件 ' + events.length + ' 条' : '无新告警') + '</div>' +
    (events.length ? '<div class="rules">' + events.map((e) =>
      '<div class="alert-card"><div class="t">' + esc(e.platform || '—') + ' · ' + esc(e.windowId || '—') + '</div>' +
      '<div class="body">' + esc(e.rule || e.detail || e.reason || '定位失败') + ' · ' + esc((e.ts || '').slice(0, 19).replace('T', ' ')) + '</div></div>'
    ).join('') + '</div>' : '<div class="empty">最近 30s 无定位失败事件</div>');
  refreshTick();
}

// ---------------------------------------------------------------- likelySame 归并队列
async function loadLikelySame() {
  const host = $('#view-likely');
  host.innerHTML = '<div class="empty">加载归并队列…</div>';
  let items;
  try { items = (await api('/api/console/likely-same')).data; }
  catch (e) { host.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  if (!items || !items.length) { host.innerHTML = '<div class="empty">暂无 likelySame 待确认（弱锚点未自动合并，需人工确认）</div>'; return; }
  host.innerHTML =
    '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">M2 dedup · scanLikelySame · 弱锚点（归一化姓名+年龄+地区）候选，不自动合并</div>' +
    '<div class="rules">' + items.map((q) =>
      '<div class="rule-row"><span class="type">' + (q.queueId || '').slice(0, 8) + '…</span>' +
      '<span class="scope">' + (q.contactA || '').slice(0, 8) + ' ↔ ' + (q.contactB || '').slice(0, 8) + '</span>' +
      '<span class="spec" title="' + esc(q.reason) + '">' + esc(q.reason || 'likelySame') + '</span>' +
      '<span class="prio">' + (q.createdAt || '').slice(0, 10) + '</span></div>'
    ).join('') + '</div>';
  refreshTick();
}

// ---------------------------------------------------------------- 对话流预览（卡片内）
async function preloadChatPreviews() {
  const ids = $$('.chat-prev [data-prev-for]');
  if (!ids.length) return;
  for (const el of ids) {
    const cid = el.dataset.prevFor;
    let c;
    const url = '/api/console/customers/' + encodeURIComponent(cid) +
      (STATE.accountId ? '?accountId=' + encodeURIComponent(STATE.accountId) : '');
    try { c = (await api(url)).data; }
    catch (_) { el.innerHTML = '<div style="color:var(--muted);font-size:11px">无对话流</div>'; continue; }
    const msgs = (c.messages || []).slice(-4);
    el.innerHTML = msgs.length ? msgs.map((m) =>
      '<div class="row ' + (m.role === 'me' ? 'me' : 'other') + '">' + (m.role === 'me' ? '我: ' : '') +
      esc((m.translation && m.translation !== m.original ? m.translation : m.original) || '') +
      (m.timeText ? '<span class="t">' + esc(m.timeText) + '</span>' : '') + '</div>'
    ).join('') : '<div style="color:var(--muted);font-size:11px">暂无消息</div>';
  }
}

// ---------------------------------------------------------------- 一级菜单 · 私域管理（LINE/其他平台占位）
async function loadPrivateDomain() {
  const host = $('#view-private-domain');
  host.innerHTML = '<div class="empty">加载私域管理…</div>';
  let data;
  try { data = (await api('/api/console/private-domain')).data; }
  catch (e) { host.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }

  const line = data.line || { status: 'pending', required: [] };
  const others = Array.isArray(data.others) ? data.others : [];
  const creds = Array.isArray(line.required) ? line.required : [];
  const statusLabel = { pending: '待接入', live: '已接入', disabled: '未启用' }[line.status] || line.status;
  const statusCls = line.status === 'live' ? 'status live' : 'status';

  // 插件式插槽：后续接 LINE 时只需替换 [data-line-platform="pending"] 卡片内的组件，不动菜单结构
  host.innerHTML =
    '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">一级菜单 · 私域管理（LINE 官方 OA + 其他平台私域占位，可扩展）</div>' +
    '<div class="pd-card" data-line-platform="' + esc(line.status === 'live' ? 'live' : 'pending') + '">' +
      '<div class="title"><span>LINE 官方 OA（私域基建）</span><span class="' + statusCls + '">' + esc(statusLabel) + '</span></div>' +
      '<div class="desc">等待接入真实 LINE 官方账号。接入方式：注入 3 项凭据到 server/acquisition/lineOa.createLineOa()，' +
      '注册 /line/webhook 路由（需公网/内网可达 endpoint，在 LINE 管理台登记）。' +
      '接入后此卡片自动切换为 LINE 私域看板（客户标签群 / 群发预算 / 静默唤醒 / 引流转化率）。</div>' +
      (creds.length ? '<div class="creds">' + creds.map((c) => {
        const locked = c !== 'webhookSecret' ? '' : ''; // 全部显示为待提供
        const note = ({
          channelAccessToken: 'LINE OA 的 Channel access token（群发消息/拉取用户/标签）',
          channelSecret: 'LINE Login 获取 phone join key 的 Channel secret',
          webhookSecret: 'LINE 管理台设置，X-Line-Signature HMAC-SHA256 校验用',
        }[c]) || '—';
        return '<div class="cred ' + locked + '"><div class="k">' + esc(c) + '</div><div class="v">' + esc(note) + ' <b style="color:var(--warn)">· 待老板提供</b></div></div>';
      }).join('') + '</div>' : '') +
      '<div class="ref">引用：<a href="/docs/plan/m4-handoff.md" target="_blank" rel="noopener">docs/plan/m4-handoff.md</a> · M4 交接单 · 3 项凭据说明 + 接入方式 + 验收标准</div>' +
    '</div>' +
    (others.length ? '<div class="pd-card"><div class="title"><span>其他平台私域（FB / WhatsApp）</span><span class="status">待接入</span></div>' +
      '<div class="desc">预留插件式插槽：FB / WhatsApp 官方 API 接入完成后，替换下方占位组件，不动菜单结构。</div>' +
      '<div class="others">' + others.map((o) =>
        '<span class="other-chip" data-other-platform="' + esc(o) + '"><span class="pill">' + esc(o) + '</span> 占位 · 待接入</span>'
      ).join('') + '</div></div>' : '');
  refreshTick();
}

// ---------------------------------------------------------------- 一级菜单 · 审计 / 封号演练（task-30）
async function loadAudit() {
  const host = $('#view-audit');
  host.innerHTML = '<div class="empty">加载合规审计…</div>';
  let r;
  try { r = (await api('/api/console/audit')).data; }
  catch (e) { host.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }

  const cs = r.complianceSummary || {};
  const bd = r.banDrillStatus || {};
  const recent = r.recentAudit || [];

  // 区块 1：合规红线集 + 拦截计数
  const rules = cs.activeComplianceRules || [];
  const byReason = cs.byReason || {};
  const reasonLabel = { compliance: '合规红线', rateLimit: '频控', blacklist: '黑名单' };
  const blockChips = Object.keys(byReason).length
    ? Object.keys(byReason).map((k) =>
        '<span class="audit-chip ' + (k === 'compliance' ? 'crit' : k === 'rateLimit' ? 'warn' : 'bad') + '">' +
        (reasonLabel[k] || k) + ' <b>' + byReason[k] + '</b></span>').join('')
    : '<span class="audit-chip ok">暂无拦截</span>';

  // 区块 2：封号演练状态卡（failRate>5% 标红 degraded）
  const drillCls = bd.degraded ? 'audit-card degraded' : 'audit-card';
  const drillBadge = bd.degraded
    ? '<span class="status degraded">degraded（failRate &gt; 5%）</span>'
    : (bd.drillPassed ? '<span class="status ok">演练通过</span>' : '<span class="status">待演练</span>');

  // 区块 3：最近审计时间线（20 条 LeadEvent）
  const actionLabel = { triggered: '触发引流', reminded: '提醒留LINE', archived: '归档' };
  const timeline = recent.length
    ? recent.map((e) => {
        const sig = Array.isArray(e.signals) ? e.signals : [];
        const gateHit = sig.find((s) => s && s.signal === 'talkEngine' && s.gateOk === false);
        const banMark = e.action === 'archived' && sig.some((s) => JSON.stringify(s).toLowerCase().match(/rollback|ban|停发/));
        const tag = banMark ? '停发演练' : (actionLabel[e.action] || e.action || '—');
        return '<div class="audit-tl-item' + (gateHit ? ' crit' : '') + '">' +
          '<span class="dot ' + ((e.tier || '').slice(0, 3) === 'hot' ? 'hot' : 'warm') + '"></span>' +
          '<span class="t">' + esc((e.createdAt || '').slice(5, 16).replace('T', ' ')) + '</span>' +
          '<span class="a">' + esc(tag) + '</span>' +
          '<span class="tier">' + esc(e.tier || '—') + '</span>' +
          '<span class="cid" title="' + esc(e.contactId) + '">' + esc(String(e.contactId || '').slice(0, 8)) + '…</span>' +
          (gateHit ? '<span class="gate" title="' + esc(gateHit.reason || '') + '">闸门拦截</span>' : '') +
          '</div>';
      }).join('')
    : '<div class="empty">暂无审计事件</div>';

  host.innerHTML =
    '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">M5 · 合规审计 + 封号演练 · 只读聚合 · 30s 轮询</div>' +
    '<div class="audit-grid">' +
      '<div class="audit-card">' +
        '<div class="title"><span>合规红线集（GovernanceRule）</span><span class="count">' + (cs.activeComplianceCount || 0) + ' 条 active</span></div>' +
        '<div class="desc">拦截 ' + (cs.blocked24h != null ? cs.blocked24h : 0) + ' 条（近 24h）</div>' +
        '<div class="chips">' + blockChips + '</div>' +
        '<div class="rules">' +
        (rules.length ? rules.map((g) => {
          let spec = '';
          try { spec = g.rule ? JSON.stringify(JSON.parse(g.rule)) : ''; } catch (_) { spec = g.rule || ''; }
          return '<div class="rule-row"><span class="type">' + esc(g.ruleType || '—') + '</span>' +
            '<span class="scope">' + esc(g.scope || 'global') + (g.scopeKey ? '/' + esc(g.scopeKey) : '') + '</span>' +
            '<span class="spec" title="' + esc(spec) + '">' + esc(spec).slice(0, 60) + '</span>' +
            '<span class="prio">prio ' + (g.priority == null ? 0 : g.priority) + '</span></div>';
        }).join('') : '<div class="empty">无 active 合规规则</div>') +
        '</div>' +
      '</div>' +
      '<div class="' + drillCls + '">' +
        '<div class="title"><span>封号演练状态（LINE OA failRate）</span>' + drillBadge + '</div>' +
        '<div class="desc">failRate ' + (bd.failRatePct != null ? bd.failRatePct : 0) + '%（阈值 ' + ((bd.threshold || 0.05) * 100) + '%）· 已发 ' + (bd.sendCount != null ? bd.sendCount : 0) + ' · 失败 ' + (bd.failCount != null ? bd.failCount : 0) + '</div>' +
        '<div class="desc">近 24h 停发/回滚标记 ' + (bd.banSignals24h != null ? bd.banSignals24h : 0) + ' 条 · lineOa ' + (bd.lineOaInjected ? '已注入' : '未注入（mock 降级）') + '</div>' +
      '</div>' +
      '<div class="audit-card" style="grid-column:1/-1">' +
        '<div class="title"><span>最近审计时间线（LeadEvent ×20）</span></div>' +
        '<div class="audit-timeline">' + timeline + '</div>' +
      '</div>' +
    '</div>';
  refreshTick();
}

// ---------------------------------------------------------------- 标签 / 漏斗视图（task-32）
let TAG_SEL = null; // 当前选中的 { layer, value }
async function loadTags() {
  const host = $('#view-tags');
  host.innerHTML = '<div class="empty">加载标签 / 漏斗…</div>';
  let dist;
  try { dist = (await api('/api/console/tags')).data; }
  catch (e) { host.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }

  const LAYER_LABELS = { source: '来源', intent: '意向', category: '品类', status: '状态', ops: '运营' };
  const chips = dist.map((layer) =>
    '<div class="tag-layer">' +
      '<div class="tag-layer__title">' + esc(LAYER_LABELS[layer.layer] || layer.layer) + '</div>' +
      '<div class="tag-chips">' +
        (layer.values.length
          ? layer.values.map((v) =>
              '<button class="tag-chip' + (TAG_SEL && TAG_SEL.layer === layer.layer && TAG_SEL.value === v.value ? ' active' : '') + '" data-tag="' + esc(layer.layer) + ':' + esc(v.value) + '" data-layer="' + esc(layer.layer) + '" data-value="' + esc(v.value) + '">' +
              esc(v.value) + '<span class="tag-chip__n">' + v.contactCount + '</span></button>'
            ).join('')
          : '<span class="tag-empty">（无值）</span>') +
      '</div>' +
    '</div>'
  ).join('');

  host.innerHTML =
    '<div class="tag-view__head"><h2 style="margin:0;font-size:16px">标签筛选 + 引流漏斗转化 <span style="color:var(--muted);font-size:12px">（点击 chip 按标签筛客户，显示该客户 funnel 当前层）</span></h2>' +
    (TAG_SEL ? '<button class="btn" style="flex:0 0 auto" data-tag-clear>清除筛选</button>' : '') +
    '</div>' +
    '<div class="tag-layers">' + chips + '</div>' +
    '<div class="tag-result" id="tagResult"><div class="empty">' +
    (TAG_SEL ? '显示标签 ' + esc(TAG_SEL.layer) + ':' + esc(TAG_SEL.value) + ' 的客户…' : '请选择一个标签值查看客户 + 漏斗进度') + '</div></div>';

  $$('[data-tag-clear]', host).forEach((b) => b.addEventListener('click', () => { TAG_SEL = null; loadTags(); }));
  $$('[data-tag]', host).forEach((c) => c.addEventListener('click', async () => {
    TAG_SEL = { layer: c.dataset.layer, value: c.dataset.value };
    await loadTagCustomers();
    // 重新高亮 chip
    $$('[data-tag]', host).forEach((x) => x.classList.toggle('active',
      x.dataset.layer === TAG_SEL.layer && x.dataset.value === TAG_SEL.value));
  }));
  refreshTick();
  if (TAG_SEL) loadTagCustomers();
}

async function loadTagCustomers() {
  const host = $('#view-tags');
  const box = host ? $('#tagResult', host) : $('#tagResult');
  if (!box) return;
  if (!TAG_SEL) { box.innerHTML = '<div class="empty">请选择一个标签值</div>'; return; }
  const url = '/api/console/customers?tag=' + encodeURIComponent(TAG_SEL.layer + ':' + TAG_SEL.value) +
    (STATE.accountId ? '&accountId=' + encodeURIComponent(STATE.accountId) : '');
  box.innerHTML = '<div class="empty">加载客户…</div>';
  let data;
  try { data = await api(url); }
  catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  const items = data.data || [];
  if (!items.length) { box.innerHTML = '<div class="empty">该标签下无客户（或账号过滤后为空）</div>'; return; }
  // 漏斗图例（6 层）
  const stageOrder = ['conversation', 'scored', 'hot', 'lead_offered', 'line_added', 'bound'];
  const stageLabels = { none: '无会话', conversation: '会话', scored: '已评分', hot: 'hot', lead_offered: '已引流', line_added: '已留LINE', bound: '已绑定' };
  const legend = '<div class="funnel-legend">' + stageOrder.map((s) =>
    '<span class="funnel-legend__item" data-stage="' + s + '"><i class="funnel-legend__dot"></i>' + stageLabels[s] + '</span>').join('') + '</div>';
  box.innerHTML = legend +
    '<div class="tag-cards">' + items.map((c) => {
      const f = c.funnelCurrentLayer || { stage: 'none', label: '无会话', progress: 0 };
      const barPct = Math.round((f.progress || 0) * 100);
      const stageCls = 'fstage-' + f.stage;
      return '<div class="tag-card">' +
        '<div class="tag-card__head">' + avatarFor(c.displayName || c.nickname, c.mergedInto) +
        '<div class="tag-card__who"><div class="name">' + esc(c.displayName || c.nickname || '—') + '</div>' +
        '<div class="sub">' + (LIFECYCLE[c.lifecycle] || c.lifecycle || '—') + ' · ' + (c.mergedInto ? '已归并' : '独立') + '</div></div></div>' +
        '<div class="funnel-progress" title="' + esc(f.label) + '">' +
        '<div class="funnel-progress__track"><div class="funnel-progress__fill ' + stageCls + '" style="width:' + barPct + '%"></div></div>' +
        '<div class="funnel-progress__meta"><span class="fstage-label">' + esc(f.label) + '</span><span class="fstage-pct">' + barPct + '%</span></div>' +
        '</div>' +
        '</div>';
    }).join('') + '</div>';
}

// ---------------------------------------------------------------- 视图切换
function setView(v) {
  STATE.view = v;
  $$('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  ['customers', 'metrics', 'rules', 'locator', 'likely', 'private-domain', 'audit', 'tags'].forEach((name) =>
    $('#view-' + name).classList.toggle('hidden', name !== v));
  if (v === 'metrics') loadMetrics();
  else if (v === 'rules') loadRules();
  else if (v === 'locator') loadLocator();
  else if (v === 'likely') loadLikelySame();
  else if (v === 'private-domain') loadPrivateDomain();
  else if (v === 'audit') loadAudit();
  else if (v === 'tags') loadTags();
  else { loadCustomers(); setTimeout(preloadChatPreviews, 400); }
}
$$('#tabs .tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

// ---------------------------------------------------------------- 轮询
function startPoll() {
  clearInterval(STATE._timer);
  STATE._timer = setInterval(() => {
    loadAccounts(); // 顶栏账号列表保持最新（30s 同步）
    if (STATE.view === 'customers') { loadCustomers(); setTimeout(preloadChatPreviews, 400); }
    else if (STATE.view === 'metrics') loadMetrics();
    else if (STATE.view === 'locator') loadLocator();
    else if (STATE.view === 'likely') loadLikelySame();
    else if (STATE.view === 'private-domain') loadPrivateDomain();
    else if (STATE.view === 'audit') loadAudit();
    else if (STATE.view === 'tags') loadTags();
  }, POLL_MS);
}

// ---------------------------------------------------------------- 初始化
function init() {
  loadAccounts();       // 多账号切换顶栏（M5 task-25）
  bindRollbackButton(); // 话术回滚按钮（顶栏 + rules view 共享 rollbackTalk）
  setView('customers');
  startPoll();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
