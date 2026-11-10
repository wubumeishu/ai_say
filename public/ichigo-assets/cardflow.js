// 卡片流 · 整合进主控台(作为 view='cards' 的子页)
// 接真数据: /card-leads + SendQueue + assistant B v1.1; 强副作用走 /card/* 路由(铁律 0.2)
'use strict';

var currentIdx = 0;
var leads = [];
var leadsLoaded = false;
var queueItems = [];
var pendingBlock = null;
var pendingAdjust = null;

var ACCOUNT_SELF = { name: 'ともね', age: 38, city: '三重・津市', traits: '美人系·巨乳·B型' };

function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

export async function loadLeads() {
  if (String(location.search || '').indexOf('mock=1') !== -1) {
    leads = [MOCK_DEMO_CARD()];
    leadsLoaded = true;
    render();
    return;
  }
  try {
    var r = await fetch('/api/console/card-leads?inbox=1&maxLeads=60&maxLikes=20&maxChats=30');
    var d = await r.json();
    if (d.ok && Array.isArray(d.cards) && d.cards.length) {
      leads = d.cards.map(function(c, i) { return mapCard(c, i); });
    }
  } catch (e) { /* 网络失败 → 占位 */ }
  if (!leads.length) {
    leads = [{
      id: 'ERR', platform: 'ichigo', platformName: '出会', noRevoke: true, cat: '', source: '',
      customer: { name: '（拉取失败）', age: '', city: '', interests: [], selfIntro: 'CDP 窗口未开或线索池为空。请开 17098/18595 窗口后刷新。', avatarUrls: [] },
      accountSelf: ACCOUNT_SELF, chatHistory: [], lastMsg: '', lastMsgZh: '', lastTime: '', ai: null,
      state: 'PENDING', selectedTalk: null, tags: [], opLog: []
    }];
  }
  leadsLoaded = true;
  loadQueueSnapshot();
  render();
  // 需求5: 当前卡自动调真 AI(assistant B v1.1), 替换固定占位; 有 conversationId/资料卡才调
  autoGenerateCurrent();
}

// 自动给当前卡生成真 AI 话术(只在有 conversationId 或 customer 资料时; 避免空卡乱调)
export function autoGenerateCurrent() {
  var l = leads[currentIdx];
  if (!l) return;
  // 已有 ai 就不重生成
  if (l.ai && Array.isArray(l.ai.talks) && l.ai.talks.length && l.ai.recommendedKey) { render(); return; }
  var hasCtx = (l.conversationId || l.memberId || l.customer && l.customer.interests && l.customer.interests.length);
  if (!hasCtx) { render(); return; }
  generateTalks(l, 'reply', '');
}

// 精细爬取: 把当前候选的资料卡 URL 入队, 呼吸式抓 Lead.extras(需求2)
export function refineCrawl() {
  var l = leads[currentIdx];
  if (!l) return;
  // 收集: 当前卡 + 后续几张(优先带 sourceHref/资料卡的, 没的传 name 让后端反查 Lead 池 profileUrl)
  var items = leads.slice(0, 5).map(function(x) {
    return { leadId: x.id, name: x.customer && x.customer.name, memberId: x.memberId, url: x.sourceHref || null, age: x.customer && x.customer.age, region: x.customer && x.customer.city };
  });
  // 有 url 的优先, 没 url 的留 name 让后端反查(全部保留, 后端自己判断可爬的)
  items.sort(function(a, b) { return (b.url ? 1 : 0) - (a.url ? 1 : 0); });
  if (!items.length) {
    // 无资料卡链接(收件箱模式候选没 sourceHref)→ 提示需先有资料卡
    alert('当前候选没有资料卡链接（收件箱模式候选不带 sourceHref）。\n请先在「线索池」精确定位客户的资料卡链接，或开 17098 窗口让卡片流带 sourceHref。');
    return;
  }
  fetch('/api/console/card/refine-crawl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items, max: 5 }) })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d.ok) { toastCf('已启动精细爬取 ' + d.started + ' 个资料卡（呼吸式 20-40s 间隔, 后台跑不挡操作）'); pollRefineStatus(); }
      else if (d.reason === 'already-running') toastCf('精细爬取进行中, 等完再发');
      else toastCf('精细爬取失败: ' + (d.msg || d.reason));
    }).catch(function() { toastCf('精细爬取请求失败'); });
}

function pollRefineStatus() {
  if (pollRefineStatus._t) return;
  pollRefineStatus._t = setInterval(function() {
    fetch('/api/console/card/refine-crawl/status').then(function(r) { return r.json(); }).then(function(d) {
      if (!d.running && d.total > 0) {
        clearInterval(pollRefineStatus._t); pollRefineStatus._t = null;
        toastCf('精细爬取完成: ' + d.done + '/' + d.total + (d.lastError ? ' (末次错: ' + d.lastError + ')' : ''));
        // 补完资料卡后重生成当前卡 AI
        loadLeads();
      }
    }).catch(function() {});
  }, 5000);
}

function toastCf(msg) {
  var t = document.getElementById('toast');
  if (t) { t.textContent = msg; t.style.display = 'block'; setTimeout(function() { t.style.display = 'none'; }, 3500); }
}

function mapCard(c, i) {
  return {
    id: c.id || ('L' + i),
    platform: c.platform || 'ichigo',
    platformName: c.platform === 'happymail' ? '快乐' : '出会',
    noRevoke: c.noRevoke !== false,
    cat: c.cat || '', source: c.source || '',
    memberId: c.memberId || null,
    contactId: c.contactId || null,
    conversationId: c.conversationId || null,
    unread: c.unread || 0,
    customer: {
      name: c.name || '（未名）', age: c.age || '', city: c.city || '',
      interests: c.interests || [], selfIntro: c.selfIntro || '',
      avatarUrls: c.avatarUrls || []
    },
    accountSelf: ACCOUNT_SELF,
    onlineIcon: c.onlineIcon || null,
    chatHistory: Array.isArray(c.chatHistory) ? c.chatHistory : [],
    lastMsg: c.lastMsg || '', lastMsgZh: c.lastMsgZh || '', lastTime: c.lastTime || '',
    ai: c.ai, state: 'PENDING', selectedTalk: null, tags: c.tags || [], opLog: c.opLog || []
  };
}

// 4/5 键: assistant B v1.1 真生成
export async function generateTalks(l, intent, adjustNote) {
  l.ai = null;
  render();
  try {
    var cust = l.customer || {};
    var r = await fetch('/api/console/card/regenerate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: l.conversationId || l.id,
        contactId: l.memberId || l.conversationId || l.id,
        platform: l.platform, accountId: l.platform === 'happymail' ? '18595' : '17098',
        intent: intent || 'reply', adjustNote: adjustNote || '',
        customer: { name: cust.name, age: cust.age, city: cust.city, interests: cust.interests || [], selfIntro: cust.selfIntro || '' },
        history: (l.chatHistory || []).slice(-12).map(function(m) { return { from: (m.who === 'me' || m.dir === 'send') ? 'me' : 'peer', text: m.textJp || m.text || '', at: m.at || m.time }; })
      })
    });
    var d = await r.json();
    // assistant.chat 返回: { ok, analysis, strategy, replies:[{type,content,translation}], degraded }
    if (d.ok && d.ai && Array.isArray(d.ai.replies) && d.ai.replies.length) {
      l.ai = {
        analysis: d.ai.analysis || '（模型未返回分析）',
        strategy: d.ai.strategy || '（模型未返回策略）',
        recommendedKey: 'A',
        degraded: !!d.ai.degraded,
        talks: d.ai.replies.slice(0, 4).map(function(rp, i) {
          var key = ['A', 'B', 'C', 'D'][i] || 'A';
          return { key: key, intent: rp.type || 'reply', textJp: rp.content || '', textZh: rp.translation || '', conf: null };
        })
      };
    } else if (d.ok && d.ai && d.ai.replies) {
      // 有 ai 但 replies 空(降级模板)
      l.ai = d.ai;
    }
  } catch (e) { /* 降级 */ }
  if (!l.ai || !Array.isArray(l.ai.talks)) l.ai = buildPlaceholderAi(l);
  render();
}

function buildPlaceholderAi(c) {
  var it = (c.customer && c.customer.interests && c.customer.interests.length) ? c.customer.interests : [];
  var first = it[0] || '';
  var talks = [
    { key: 'A', intent: '破冰·兴趣切入', textJp: first ? ('最近' + first + 'はよくやりますか？一緒にどうですか？') : 'この前の休日、何しましたか？', textZh: first ? ('最近常玩「' + first + '」吗？要一起吗？') : '上个休息日做了什么？', conf: 0.78 },
    { key: 'B', intent: '推进·线下', textJp: '今週末、少し会えますか？三重でいい場所知ってます。', textZh: '这周末见个面？我知道三重不错的地方。', conf: 0.62 },
    { key: 'C', intent: '轻唤回', textJp: first ? ('先日話した' + first + '、覚えてますか？') : '先日も話した事、覚えてますか？', textZh: first ? ('前几天聊的「' + first + '」还记得吗？') : '前几天聊的事还记得吗？', conf: 0.55 },
    { key: 'D', intent: '婉转', textJp: 'お疲れ様でした。ゆっくり休んでください。', textZh: '辛苦了，好好休息。', conf: 0.40 }
  ];
  var best = talks.reduce(function(b, t) { return t.conf > b.conf ? t : b; }, talks[0]);
  return {
    recommendedKey: best.key,
    analysis: c.lastMsg ? ('对方最后说：「' + c.lastMsg + '」→ ' + (it.length ? ('兴趣重合：' + it.slice(0, 3).join('/') + '，从兴趣切入最稳') : '暂无兴趣数据，建议软话题破冰')) : '（暂无聊天记录）',
    strategy: it.length ? ('从「' + it[0] + '」切入 → 推进线下 → 观察回复节奏') : '先软话题破冰，观察对方回复节奏再推进。',
    talks: talks
  };
}

function MOCK_DEMO_CARD() {
  return { id: 'DEMO-1', platform: 'ichigo', platformName: '出会', noRevoke: true, cat: 'like', source: '点赞',
    customer: { name: '流石（示例）', age: '49', city: '伊勢市', interests: ['温泉', '読書'], selfIntro: '仕事の関係で伊勢に住む事になりました。', avatarUrls: [] },
    accountSelf: ACCOUNT_SELF, chatHistory: [], lastMsg: 'こんばんは、口下手で…', lastMsgZh: '晚上好，我口拙…', lastTime: '10/27 19:39', ai: null, state: 'PENDING', selectedTalk: null, tags: [], opLog: [] };
}

// ============ 渲染(挂 #cardPage) ============
export function render() {
  var root = document.getElementById('cardPage');
  if (!root || !leadsLoaded) return;
  var l = leads[currentIdx];
  if (!l) {
    root.innerHTML = '<div class="cf-main"><div style="padding:40px;color:var(--muted,#8b8fa3);text-align:center;font-size:13px">（无候选——CDP 窗口未开或线索池为空）</div></div>';
    return;
  }
  if (!l.ai || !l.ai.talks) l.ai = buildPlaceholderAi(l);
  root.innerHTML =
    '<div class="cf-main">'
    +   '<div class="cfFilterBar" style="display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap">' +
    +     '<span style="font-size:11px;color:var(--muted,#8b8fa3)">来源:</span>' +
    +     '<button class="cfFilt" data-f="profile" style="font-size:12px;padding:3px 10px;border-radius:4px;cursor:pointer;border:1px solid ' + (_cfFilter === 'profile' ? 'var(--accent,#4f8cff)' : 'var(--border,#2a3550)') + ';background:' + (_cfFilter === 'profile' ? 'var(--accent,#4f8cff)' : 'var(--card,#1a1d27)') + ';color:' + (_cfFilter === 'profile' ? '#fff' : 'var(--text)') + ';margin:0">📇 已抓资料</button>' +
    +     '<button class="cfFilt" data-f="lead" style="font-size:12px;padding:3px 10px;border-radius:4px;cursor:pointer;border:1px solid ' + (_cfFilter === 'lead' ? 'var(--accent,#4f8cff)' : 'var(--border,#2a3550)') + ';background:' + (_cfFilter === 'lead' ? 'var(--accent,#4f8cff)' : 'var(--card,#1a1d27)') + ';color:' + (_cfFilter === 'lead' ? '#fff' : 'var(--text)') + ';margin:0">互动线索</button>' +
    +     '<button class="cfFilt" data-f="active" style="font-size:12px;padding:3px 10px;border-radius:4px;cursor:pointer;border:1px solid ' + (_cfFilter === 'active' ? 'var(--accent,#4f8cff)' : 'var(--border,#2a3550)') + ';background:' + (_cfFilter === 'active' ? 'var(--accent,#4f8cff)' : 'var(--card,#1a1d27)') + ';color:' + (_cfFilter === 'active' ? '#fff' : 'var(--text)') + ';margin:0">最近活跃</button>' +
    +     '<button class="cfFilt" data-f="all" style="font-size:12px;padding:3px 10px;border-radius:4px;cursor:pointer;border:1px solid ' + (_cfFilter === 'all' ? 'var(--accent,#4f8cff)' : 'var(--border,#2a3550)') + ';background:' + (_cfFilter === 'all' ? 'var(--accent,#4f8cff)' : 'var(--card,#1a1d27)') + ';color:' + (_cfFilter === 'all' ? '#fff' : 'var(--text)') + ';margin:0">全部</button>' +
    +     '<span id="cfFilterNote" style="font-size:11px;color:var(--muted,#8b8fa3);margin-left:4px"></span>' +
    +   '</div>' +
    +   '<div class="cf-grid">'
    +     '<div class="cf-col cf-left">' + renderLeft(l) + '</div>'
    +     '<div class="cf-col cf-mid">' + renderMid(l) + '</div>'
    +     '<div class="cf-col cf-right">' + renderRight(l) + '</div>'
    +   '</div>'
    +   '<div class="cf-progress"><span id="cfProgress"></span><div class="cf-bar"><div id="cfBar" style="width:0%"></div></div><div id="cfQueueStats"></div></div>'
    +   '<div class="cf-toolbar"><div class="cf-hint"><kbd>A</kbd>~<kbd>D</kbd> 选话术入队 · <kbd>1</kbd>标记 <kbd>2</kbd>拉黑 <kbd>3</kbd>跳过 <kbd>4</kbd>重生成 <kbd>5</kbd>微调 · <kbd>→</kbd>下一张 <kbd>←</kbd>上一张</div><div class="cf-queue" id="cfQueue"></div></div>'
    + '</div>';
  renderProgress(); renderQueue();
  var brc = document.getElementById('btnRefineCrawl');
  if (brc) brc.onclick = function() { refineCrawl(); };
}

function renderLeft(l) {
  var isHappy = l.platform === 'happymail';
  var interests = (l.customer.interests || []).map(function(x) { return '<span class="cf-tag">' + x + '</span>'; }).join('');
  var avatar = (l.customer.avatarUrls && l.customer.avatarUrls.length)
    ? '<img src="' + l.customer.avatarUrls[0] + '" style="width:44px;height:44px;border-radius:8px;object-fit:cover;border:1px solid var(--border,#2d3140)" onerror="this.style.display=\'none\'">'
    : '<div style="width:44px;height:44px;border-radius:8px;background:var(--panel2,#22252f);display:flex;align-items:center;justify-content:center;color:var(--muted,#8b8fa3);font-size:11px">無写真</div>';
  return '<div class="cf-plate"><h4>平台 / 撤回性</h4>'
    + '<span class="cf-badge ' + l.platform + '">' + (isHappy ? '快乐 happymail' : '出会 ichigo') + '</span>'
    + '<span class="cf-badge ' + (l.noRevoke ? 'no-rev' : 'rev') + '">' + (l.noRevoke ? '⚠ 出会·不可撤回' : '✓ 快乐·可撤回') + '</span>'
    + '<div style="font-size:10px;color:var(--muted,#8b8fa3);margin-top:5px">来源: ' + (l.fromProfilePool ? '<span style="color:#2AB788">📇 已抓资料(资料池)</span>' : (l.source || '—')) + '</div></div>'
    + '<div class="cf-plate"><h4>客户</h4><div style="display:flex;gap:10px;align-items:center">' + avatar
    + '<div><div style="font-size:15px;font-weight:700">' + l.customer.name + '</div><div style="font-size:11px;color:var(--muted,#8b8fa3);margin-top:3px">'
    + (l.customer.age ? l.customer.age + ' · ' : '') + (l.customer.city || '') + '</div></div></div>'
    + (l.onlineIcon ? '<div style="margin-top:6px;font-size:11px;color:var(--green,#34c38f)">● 在线(' + l.onlineIcon + ')</div>' : '') + '</div>'
    + '<div class="cf-plate"><h4>兴趣重合</h4><div>' + (interests || '<span style="color:var(--muted,#8b8fa3);font-size:11px">（无兴趣数据）</span>') + '</div></div>'
    + '<div class="cf-plate"><h4>我方人设（' + l.accountSelf.name + '）</h4>'
    + '<div style="font-size:11px;color:var(--muted,#8b8fa3)">' + l.accountSelf.age + '歳 · ' + l.accountSelf.city + '</div>'
    + '<div style="font-size:11px;color:var(--purple,#a78bfa);margin-top:3px">' + l.accountSelf.traits + '</div></div>'
    + '<div class="cf-plate"><h4>自己紹介</h4><p style="font-size:12px;line-height:1.5">'
    + (l.customer.selfIntro ? l.customer.selfIntro.slice(0, 200) : '<span style="color:var(--muted,#8b8fa3)">（无）</span>') + '</p></div>';
}

function renderMid(l) {
  var ai = l.ai || {};
  var chat = (l.chatHistory || []).slice(-5).map(function(m) {
    var who = (m.who === 'me' || m.dir === 'send') ? '私:' : '彼:';
    var jp = m.textJp || m.text || '';
    var zh = m.zh || m.textZh || '';
    var t = m.at || m.time || '';
    return '<div class="cf-mline"><div class="cf-jp">' + who + ' 「' + jp + '」</div>'
      + (zh ? '<div class="cf-zh">' + zh + '</div>' : '') + (t ? '<div class="cf-t">' + t + '</div>' : '') + '</div>';
  }).join('');
  return '<div class="cf-ai"><h5>🧠 心理分析</h5><p>' + (ai.analysis || '<span style="color:var(--muted,#8b8fa3)">按 4 键生成…</span>') + '</p></div>'
    + '<div class="cf-ai"><h5>🎯 应对策略</h5><p>' + (ai.strategy || '<span style="color:var(--muted,#8b8fa3)">按 4 键生成…</span>') + '</p></div>'
    + '<div class="cf-chat"><h5>💬 最近 5 轮（日原文 + 中译文）</h5>'
    + (chat ? chat : '<div style="color:var(--muted,#8b8fa3);font-size:11px;padding:10px;text-align:center">（暂无聊天记录）</div>') + '</div>';
}

function renderRight(l) {
  var ai = l.ai || buildPlaceholderAi(l);
  var talks = (ai.talks || []).map(function(t) {
    return '<div class="cf-talk ' + (l.selectedTalk === t.key ? 'sel' : '') + '">'
      + '<div class="cf-talkhead"><span class="cf-key">' + t.key + '</span><span class="cf-intent">' + (t.intent || 'reply') + '</span>'
      + '<span class="cf-conf">conf ' + (t.conf != null ? t.conf : '-') + '</span></div>'
      + '<div class="cf-jp">「' + t.textJp + '」</div>'
      + (t.textZh ? '<div class="cf-zh">' + t.textZh + '</div>' : '') + '</div>';
  }).join('');
  return '<div style="font-size:11px;color:var(--muted,#8b8fa3);margin-bottom:8px">💬 话术 A-D（日原文 + 中译文 · 按 A~D 入队）</div>'
    + (talks || '<div style="color:var(--muted,#8b8fa3);font-size:11px">（按 4 键生成话术）</div>')
    + '<div style="margin-top:10px;font-size:11px;color:var(--muted,#8b8fa3);line-height:1.8">'
    + '按 A~D 选话术入队（20s±10s 浮动串行）· 4 重生成 · 5 微调 · <button id="btnRefineCrawl" style="margin-top:8px;background:var(--accent,#4f8cff);color:#fff;border:none;border-radius:5px;padding:5px 12px;font-size:11px;cursor:pointer">🔭 精细爬取资料卡</button></div>';
}

function renderProgress() {
  var p = document.getElementById('cfProgress');
  var processed = leads.filter(function(l) { return l.state !== 'PENDING'; }).length;
  if (p) p.textContent = (currentIdx + 1) + ' / ' + leads.length + '（已处理 ' + processed + '）';
  var bar = document.getElementById('cfBar');
  if (bar) bar.style.width = (leads.length ? processed / leads.length * 100 : 0) + '%';
  var qs = document.getElementById('cfQueueStats');
  if (qs) {
    var q = queueItems.filter(function(x) { return x.status === 'queued' || x.status === 'pending'; }).length;
    qs.innerHTML = '<span style="color:var(--yellow,#fbbf24);font-weight:700">' + q + '</span> 待发';
  }
}

function renderQueue() {
  var qbar = document.getElementById('cfQueue');
  if (!qbar) return;
  var active = queueItems.filter(function(q) { return q.status === 'queued' || q.status === 'pending'; });
  qbar.innerHTML = active.slice(0, 6).map(function(q) {
    var l = leads.find(function(x) { return x.id === q.leadId; });
    var name = l ? l.customer.name : q.leadId;
    var cancelBtn = '<span class="cf-cancel" data-qid="' + q.id + '">×</span>';
    var revokeBtn = (q.platform === 'happymail' && q.status === 'sent') ? '<span class="cf-rev" data-qid="' + q.id + '">↩撤回</span>' : '';
    return '<div class="cf-qitem"><span>' + name + ' · 话术' + (q.talkKey || '') + '</span>'
      + '<span class="cf-timer" data-qid="' + q.id + '">' + countdown(q.scheduledAt) + '</span>' + cancelBtn + revokeBtn + '</div>';
  }).join('');
  // 队列条按钮绑定(事件委托)
  Array.prototype.forEach.call(qbar.querySelectorAll('.cf-cancel'), function(el) {
    el.onclick = function() { cancelQueueItem(el.getAttribute('data-qid')); };
  });
  Array.prototype.forEach.call(qbar.querySelectorAll('.cf-rev'), function(el) {
    el.onclick = function() { revokeQueueItem(el.getAttribute('data-qid')); };
  });
}

function countdown(ts) {
  if (!ts) return '-';
  var diff = new Date(ts) - Date.now();
  if (diff <= 0) return '0s';
  return Math.ceil(diff / 1000) + 's';
}

function cancelQueueItem(id) {
  queueItems = queueItems.filter(function(x) { return x.id !== id; });
  fetch('/api/console/card/send-queue/cancel?id=' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(function() {});
  renderQueue();
}
function revokeQueueItem(id) {
  fetch('/api/console/card/send-queue/revoke?id=' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'user-revoke' }) })
    .then(function(r) { return r.json(); }).then(function(d) { if (d && d.ok) { var q = queueItems.find(function(x) { return x.id === id; }); if (q) q.status = 'revoked'; renderQueue(); } }).catch(function() {});
}

function loadQueueSnapshot() {
  fetch('/api/console/card/send-queue?status=pending&limit=50')
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d.ok && Array.isArray(d.queue)) {
        queueItems = d.queue.map(function(q) {
          return { id: q.queueId, leadId: q.conversationId, talkKey: q.talkIntent || '', talkText: q.talkText, scheduledAt: q.scheduledAt, status: q.status, platform: q.platform };
        });
        renderQueue();
      }
    }).catch(function() {});
}

// ============ 操作 ============
function _bindCfFilter(root) {
  Array.prototype.forEach.call(root.querySelectorAll('.cfFilt'), function(b) {
    b.onclick = function() { _cfFilter = b.getAttribute('data-f'); window.__cfFilter = _cfFilter; loadLeads(); };
  });
}
export function selectTalk(idx, talkKey) {
  var l = leads[idx];
  if (!l || l.state === 'SENT' || l.state === 'BLOCKED') return;
  var talk = (l.ai && l.ai.talks ? l.ai.talks.find(function(t) { return t.key === talkKey; }) : null);
  if (!talk) { generateTalks(l, 'reply'); return; }
  l.selectedTalk = talkKey; l.state = 'DRAFTED';
  l.opLog.push({ op: 'select-talk', at: now(), note: '选 ' + talkKey });
  enqueueToBackend(l, talk, talkKey);
  currentIdx = Math.min(idx + 1, leads.length - 1);
  render();
}

function enqueueToBackend(l, talk, talkKey) {
  fetch('/api/console/card/send-queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: l.id, platform: l.platform, accountId: l.platform === 'happymail' ? '18595' : '17098', contactKey: l.memberId || l.id, talkText: talk.textJp, talkZh: talk.textZh, talkIntent: talk.intent, talkConfidence: talk.conf })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok && d.queue) {
      queueItems.push({ id: d.queue.queueId, leadId: l.id, talkKey: talkKey, talkText: talk.textJp, scheduledAt: d.queue.scheduledAt, status: d.queue.status, platform: l.platform });
      renderQueue(); renderProgress();
    }
  }).catch(function() {});
}

export function handleAction(idx, action) {
  var l = leads[idx];
  if (!l) return;
  switch (action) {
    case '1': l.tags = l.tags || []; if (l.tags.indexOf('重点') === -1) l.tags.push('重点'); l.opLog.push({ op: 'mark', at: now() }); render(); break;
    case '2': pendingBlock = idx; showBlockOverlay(l); break;
    case '3': l.state = 'SKIPPED'; queueItems = queueItems.filter(function(q) { return !(q.leadId === l.id && q.status !== 'sent' && q.status !== 'skipped'); }); l.opLog.push({ op: 'skip', at: now() }); currentIdx = Math.min(idx + 1, leads.length - 1); render(); break;
    case '4': generateTalks(l, 'reply', ''); break;
    case '5': pendingAdjust = idx; showAdjustOverlay(); break;
    case '6': var c = document.getElementById('cardPage'); if (c) c.scrollTop = 0; break;
  }
}

function showBlockOverlay(l) {
  var ov = document.getElementById('cfBlockOverlay');
  if (!ov) return;
  document.getElementById('cfBlockName').textContent = l.customer.name + ' · ' + (l.customer.age || '');
  ov.classList.add('show');
}
export function confirmBlock() {
  if (pendingBlock === null) return;
  var l = leads[pendingBlock];
  l.state = 'BLOCKED'; l.opLog.push({ op: 'block', at: now(), note: '拉黑 ' + l.customer.name });
  var ov = document.getElementById('cfBlockOverlay'); if (ov) ov.classList.remove('show');
  fetch('/api/console/card/block', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: l.id, contactId: l.memberId || l.id, platform: l.platform, accountId: l.platform === 'happymail' ? '18595' : '17098', reason: 'card-deck 拉黑' })
  }).catch(function() {});
  pendingBlock = null; currentIdx = Math.min(currentIdx + 1, leads.length - 1); render();
}
export function cancelBlock() { pendingBlock = null; var ov = document.getElementById('cfBlockOverlay'); if (ov) ov.classList.remove('show'); }

function showAdjustOverlay() {
  var ov = document.getElementById('cfAdjustOverlay'); if (!ov) return;
  var ta = document.getElementById('cfAdjustNote'); if (ta) ta.value = '';
  ov.classList.add('show');
}
export function doAdjust() {
  if (pendingAdjust === null) return;
  var l = leads[pendingAdjust];
  var note = (document.getElementById('cfAdjustNote') || {}).value || '';
  var ov = document.getElementById('cfAdjustOverlay'); if (ov) ov.classList.remove('show');
  generateTalks(l, 'reply', note);
  pendingAdjust = null;
}
export function cancelAdjust() { var ov = document.getElementById('cfAdjustOverlay'); if (ov) ov.classList.remove('show'); pendingAdjust = null; }

export function nextCard() { currentIdx = Math.min(currentIdx + 1, leads.length - 1); render(); }
export function prevCard() { currentIdx = Math.max(currentIdx - 1, 0); render(); }

export function isCardFlowBusy() { return pendingBlock !== null || pendingAdjust !== null; }

// 卡片流倒计时(1s 一次)
export function startQueueTick() {
  if (startQueueTick._t) return;
  startQueueTick._t = setInterval(function() { renderQueue(); }, 1000);
}
export function stopQueueTick() {
  if (startQueueTick._t) { clearInterval(startQueueTick._t); startQueueTick._t = null; }
}


export function _idx() { return currentIdx; }
