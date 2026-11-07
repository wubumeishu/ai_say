// 卡片交互原型 JS（mock 数据，真键盘操作，不碰真发）
'use strict';

// ============ Mock 数据（模拟出会平台真实候选） ============
// ============ 真实数据加载（/api/console/card-leads）============
// 基底 = Lead 线索池（已灌库，CDP 窗口关着也有数据）+ CDP 实时 P1/P2 补全
var MOCK_LEADS = [];   // 兜底：拉不到时显示"无数据"
// 按候选数据拼 4 条占位话术（真实 LLM 生成待接 assistant.js B v1.1；当前仅为模拟数据流跑通界面）
function buildPlaceholderAi(c) {
  var it = (c.interests && c.interests.length) ? c.interests : [];
  var first = it[0] || '';
  var talks = [
    { key: 'A', intent: '破冰·兴趣切入', textJp: first ? ('最近' + first + 'はよくやりますか？一緒にどうですか？') : 'この前の休日、何しましたか？', textZh: first ? ('最近常玩「' + first + '」吗？要一起吗？') : '上个休息日做了什么？', conf: 0.78 },
    { key: 'B', intent: '推进·线下', textJp: '今週末、少し会えますか？三重でいい場所知ってます。', textZh: '这周末见个面？我知道三重不错的地方。', conf: 0.62 },
    { key: 'C', intent: '轻唤回', textJp: first ? ('先日話した' + first + '、覚えてますか？') : '先日も話した事、覚えてますか？', textZh: first ? ('前几天聊的「' + first + '」还记得吗？') : '前几天聊的事还记得吗？', conf: 0.55 },
    { key: 'D', intent: '婉转', textJp: 'お疲れ様でした。ゆっくり休んでください。', textZh: '辛苦了，好好休息。', conf: 0.40 },
  ];
  var best = talks.reduce(function(b, t) { return t.conf > b.conf ? t : b; }, talks[0]);
  return {
    recommendedKey: best.key,
    analysis: c.lastMsg ? ('对方最后说：「' + c.lastMsg + '」→ ' + (it.length ? ('兴趣重合：' + it.slice(0, 3).join('/') + '，从兴趣切入最稳') : '暂无兴趣数据，建议软话题破冰')) : '（暂无聊天记录）',
    strategy: it.length ? ('从「' + it[0] + '」切入 → 推进线下 → 观察回复节奏') : '先软话题破冰，观察对方回复节奏再推进。',
    talks: talks,
  };
}
// 调试示例卡（?mock=1 用）
function MOCK_DEMO_CARD() {
  return { id:'DEMO-1', platform:'ichigo', platformName:'出会', noRevoke:true, cat:'like', source:'点赞',
    customer:{ name:'流石（示例）', age:'49', city:'伊勢市', interests:['温泉','読書'], selfIntro:'仕事の関係で伊勢に住む事になりました。' },
    accountSelf:{ name:'ともね', age:38, city:'三重・津市', traits:'美人系·巨乳·B型' },
    chatHistory:[], lastMsg:'こんばんは、口下手で…', lastTime:'10/27 19:39', sourceHref:null,
    ai:null, state:'PENDING', selectedTalk:null, tags:[], opLog:[] };
}
function MOCK_DEMO_CARD2() {
  return { id:'DEMO-2', platform:'ichigo', platformName:'出会', noRevoke:true, cat:'browse', source:'BBS帖子',
    customer:{ name:'つよし＿（示例）', age:'46', city:'伊勢市', interests:[], selfIntro:'今日〜火曜日に伊勢市周辺で' },
    accountSelf:{ name:'ともね', age:38, city:'三重・津市', traits:'美人系·巨乳·B型' },
    chatHistory:[], lastMsg:'', lastTime:'10/27', sourceHref:null,
    ai:null, state:'PENDING', selectedTalk:null, tags:[], opLog:[] };
}

async function loadLeads() {
  // 调试：/card-deck?mock=1 直接返回本地示例数据（不请求后端，排查前端渲染用）
  if (String(location.search || '').indexOf('mock=1') !== -1) {
    return [MOCK_DEMO_CARD(), MOCK_DEMO_CARD2()];
  }
  try {
    var r = await fetch('/api/console/card-leads?maxLeads=60&maxLikes=20&maxChats=10');
    var d = await r.json();
    if (d.ok && Array.isArray(d.cards) && d.cards.length) {
      // 把后端 cards[] 映射成卡片对象（补 customer/accountSelf/ai 结构）
      return d.cards.map(function(c, i) {
        return {
          id: c.id || ('L' + i),
          platform: c.platform || 'ichigo',
          platformName: c.source || '出会',
          noRevoke: c.noRevoke !== false,
          cat: c.cat || '',
          source: c.source || '',
          memberId: c.memberId || null,
          customer: {
            name: c.name || '（未名）',
            age: c.age || '',
            city: c.city || '',
            avatar: (c.avatarUrls && c.avatarUrls.length) ? c.avatarUrls.length : 0,
            avatarUrls: c.avatarUrls || [],
            interests: c.interests || [],
            selfIntro: c.selfIntro || ''
          },
          accountSelf: { name: 'ともね', age: 38, city: '三重・津市', traits: '美人系·巨乳·B型' },
          chatHistory: [],
          lastMsg: c.lastMsg || '',
          lastTime: c.lastTime || '',
          sourceHref: c.sourceHref || null,
          ai: (c.ai && Array.isArray(c.ai.talks) && c.ai.talks.length) ? c.ai : buildPlaceholderAi(c),
          state: 'PENDING',
          selectedTalk: null,
          tags: c.tags || [],
          opLog: c.opLog || [],
        };
      });
    }
  } catch (e) { /* 网络失败 → 用 mock 兜底 */ }
  // 兜底 mock（拉不到真实数据时，至少界面能跑）
  return [
    { id:'L1', platform:'ichigo', platformName:'出会', noRevoke:true, cat:'like', source:'点赞', memberId:null,
      customer:{ name:'（拉取失败·示例）', age:'', city:'', avatar:0, avatarUrls:[], interests:[], selfIntro:'CDP 窗口未开，未能抓到真实线索。请开 17098 出会窗口后刷新。' },
      accountSelf:{ name:'ともね', age:38, city:'三重・津市', traits:'美人系·巨乳·B型' },
      chatHistory:[], lastMsg:'', lastTime:'', sourceHref:null, ai: buildPlaceholderAi({ name:'（拉取失败·示例）', interests:[], lastMsg:'', selfIntro:'CDP 窗口未开，未能抓到真实线索。' }), state:'PENDING', selectedTalk:null, tags:[], opLog:[] }
  ];
}

// ============ 状态管理 ============

// ============ 状态管理 ============
var currentIdx = 0;
var leads = [];          // 由 loadLeads() 异步填充
var leadsLoaded = false;
var queueItems = [];
var pendingBlock = null;

function now() { return new Date().toISOString().replace('T',' ').slice(0,19); }
function operator() { return 'A'; }

// ============ 渲染 ============
function render() {
  renderActiveCard();
  renderQueue();
  renderStats();
  renderProgress();
}

function renderProgress() {
  var el = document.getElementById('progress');
  if (el) el.textContent = (currentIdx + 1) + ' / ' + leads.length + '（已处理 ' +
    leads.filter(function(l) { return l.state !== 'PENDING'; }).length + '）';
  var bar = document.getElementById('progressBar');
  if (bar) {
    var processed = leads.filter(function(l) { return l.state !== 'PENDING'; }).length;
    bar.style.width = (processed / leads.length * 100) + '%';
  }
}
function renderActiveCard() {
  var deck = document.getElementById('cardDeck');
  if (!deck) return;
  if (!leadsLoaded) {
    deck.innerHTML = '<div style="text-align:center;padding:60px;color:var(--muted)">加载中…（拉取 /card-leads 真实候选）</div>';
    return;
  }
  var l = leads[currentIdx];
  if (!l || leads.length === 0) {
    deck.innerHTML = '<div style="text-align:center;padding:60px;color:var(--muted)">（无候选卡片——CDP 窗口未开或线索池为空）<br><br><span style="color:var(--accent);font-size:13px">刷新本页面重新拉取</span> · 或开 17098 出会窗口后刷新</div>';
    return;
  }
  var stateMap = { PENDING: 'pending', DRAFTED: 'drafted', QUEUED: 'queued', SENT: 'sent', SKIPPED: 'skipped', BLOCKED: 'blocked' };
  var stateTextMap = { PENDING: '待处理', DRAFTED: '待发送', QUEUED: '排队中', SENT: '已发送', SKIPPED: '已跳过', BLOCKED: '已拉黑' };
  // 防御：ai / customer 缺失时用占位对象，避免 null 引用崩渲染
  if (!l.ai || !Array.isArray(l.ai.talks) || !l.ai.talks.length) l.ai = buildPlaceholderAi(l);
  if (!l.customer) l.customer = { name: l.name || '（未名）', age: l.age || '', city: l.city || '', interests: l.interests || [], selfIntro: l.selfIntro || '' };
  if (!l.accountSelf) l.accountSelf = { name: 'ともね', age: 38, city: '三重・津市', traits: '美人系·巨乳·B型' };
  l.customer.interests = Array.isArray(l.customer.interests) ? l.customer.interests : [];
  l.customer.selfIntro = l.customer.selfIntro || '';
  l.customer.name = l.customer.name || '（未名）';

  var talkHtml = l.ai.talks.map(function(t) {
    return '<div class="talk ' + (l.selectedTalk === t.key ? 'selected' : '') + '">'
      + '<span class="key">' + t.key + '</span>'
      + '<div class="content"><div class="jp">「' + t.textJp + '」</div>'
      + '<div class="zh">“' + t.textZh + '”（中） · ' + t.intent + ' · conf' + t.conf + '</div></div>'
      + '</div>';
  }).join('');

  var chatHtml = l.chatHistory.map(function(m) {
    var cls = m.dir === 'recv' ? 'recv' : 'send';
    var who = m.dir === 'recv' ? '彼:' : '私:';
    return '<div class="msg ' + cls + '"><div class="jp">' + who + '「' + m.textJp + '」</div>'
      + '<div class="zh">' + m.textZh + '</div><div class="time">' + m.at + '</div></div>';
  }).join('');

  var interests = (l.customer.interests || []).map(function(x) {
    return '<span class="tag">' + x + '</span>';
  }).join('');
  var tags = (l.tags || []).map(function(t) {
    return '<span style="font-size:10px;color:var(--orange);margin-left:4px">#' + t + '</span>';
  }).join('');
  var noRevokeHtml = l.noRevoke
    ? '<div class="no-revoke">⚠ 出会：发出后不可撤回</div>'
    : '<div style="font-size:11px;color:var(--green);margin-top:4px">✓ 快乐：发出后可撤回</div>';

  var avatars = '';
  for (var a = 1; a <= Math.min(l.customer.avatar, 3); a++) {
    avatars += '<div class="avatar">写真' + a + '</div>';
  }

  var recKey2 = (l.ai && l.ai.recommendedKey) ? l.ai.recommendedKey : 'A';
  var recTalk2 = (l.ai && l.ai.talks ? l.ai.talks.filter(function(t){ return t.key === recKey2; })[0] : null);
  var lastMsgHtml = l.lastMsg
    ? '<div class="last-msg"><div class="lm-jp">最后：「' + l.lastMsg + '」</div><div class="lm-time">' + (l.lastTime || '') + '</div></div>'
    : '';
  var srcBadge = l.source ? '<span class="src-badge">来源:' + l.source + '</span>' : '';
  var onlineDot = l.onlineIcon
    ? '<span class="online-dot ' + String(l.onlineIcon).replace('online-icon','tier') + '"></span>'
    : '';

  deck.innerHTML = '<div class="card single" id="card-' + l.id + '">'
    + '<div class="rec-banner">'
    +   '<span class="rb-label">⚡ AI 推荐</span>'
    +   '<span class="rb-key">' + recKey2 + '</span>'
    +   (recTalk2 ? '<span class="rb-text">「' + recTalk2.textJp + '」</span>' : '')
    +   '<span class="rb-conf">conf ' + (recTalk2 ? recTalk2.conf : '-') + '</span>'
    +   '<span class="rb-hint">按 ' + recKey2 + ' 一键入待发送</span>'
    + '</div>'
    + '<div class="card-body">'
    +   '<div class="card-col col-left">'
    +     '<div class="ident">'
    +       '<div class="platform-badge ' + l.platform + '">' + l.platformName + ' ' + srcBadge + '</div>'
    +       '<div class="avatar-row">' + avatars + onlineDot + '</div>'
    +       noRevokeHtml
    +     '</div>'
    +     '<div class="who">'
    +       '<div class="who-name">' + l.customer.name + '</div>'
    +       '<div class="who-meta">' + (l.customer.age ? l.customer.age + '歳' : '') + ' ' + (l.customer.city ? l.customer.city : '') + '</div>'
    +       '<span class="status-badge ' + stateMap[l.state] + '">' + stateTextMap[l.state] + '</span>'
    +       tags
    +     '</div>'
    +     lastMsgHtml
    +   '</div>'
    +   '<div class="card-col col-mid">'
    +     '<div class="profile-cell"><h5>客户资料 / 兴趣</h5><p>' + (interests || '<span style="color:var(--muted)">（无兴趣数据）</span>') + '</p>'
    +     '<p class="intro">自己紹介: ' + (l.customer.selfIntro ? l.customer.selfIntro.slice(0, 80) : '（无）') + '</p></div>'
    +     '<div class="profile-cell me"><h5>我方账号（' + l.accountSelf.name + '）</h5>'
    +     '<p>' + l.accountSelf.age + '歳 · ' + l.accountSelf.city + '</p>'
    +     '<p class="traits">' + l.accountSelf.traits + '</p></div>'
    +     '<div class="ai-section"><h5>🧠 心理分析</h5><p>' + l.ai.analysis + '</p></div>'
    +     '<div class="ai-section"><h5>🎯 应对策略</h5><p>' + l.ai.strategy + '</p></div>'
    +     (l.chatHistory.length ? '<div class="chat-history"><h5>💬 聊天记录（原文/译文）</h5>' + chatHtml + '</div>' : '')
    +   '</div>'
    +   '<div class="card-col col-right">'
    +     '<div class="talks"><h5>💬 话术 A-D（原文+译文 · 按键入待发送）</h5>' + talkHtml + '</div>'
    +   '</div>'
    + '</div>'
    + '</div>';
}
function renderCard(l, i) {
  var active = i === currentIdx ? ' active' : '';
  var sent = l.state === 'SENT' ? ' sent' : '';
  var talkHtml = l.ai.talks.map(function(t) {
    return '<div class="talk ' + (l.selectedTalk === t.key ? 'selected' : '') + '" data-key="' + t.key + '" data-idx="' + i + '">'
      + '<span class="key">' + t.key + '</span>'
      + '<div class="content"><div class="jp">「' + t.textJp + '」</div>'
      + '<div class="zh">"' + t.textZh + '"（中） · ' + t.intent + ' conf' + t.conf + '</div></div>'
      + '</div>';
  }).join('');
  var chatHtml = l.chatHistory.map(function(m) {
    var cls = m.dir === 'recv' ? 'recv' : 'send';
    var who = m.dir === 'recv' ? '彼:' : '私:';
    return '<div class="msg ' + cls + '"><div class="jp">' + who + '「' + m.textJp + '」</div>'
      + '<div class="zh">' + m.textZh + '</div><div class="time">' + m.at + '</div></div>';
  }).join('');
  var interests = (l.customer.interests || []).map(function(x) {
    return '<span class="tag">' + x + '</span>';
  }).join('');
  var tags = (l.tags || []).map(function(t) {
    return '<span style="font-size:10px;color:var(--orange);margin-left:4px">#' + t + '</span>';
  }).join('');
  var noRevokeHtml = l.noRevoke
    ? '<div class="no-revoke">⚠ 出会：发出后不可撤回</div>'
    : '<div style="font-size:11px;color:var(--green);margin-top:4px">✓ 快乐：发出后可撤回</div>';
  var avatars = '';
  for (var a = 1; a <= Math.min(l.customer.avatar, 3); a++) {
    avatars += '<div class="avatar">写真' + a + '</div>';
  }
  return '<div class="card' + active + sent + '" data-idx="' + i + '" id="card-' + l.id + '">'
    + '<div class="card-block">'
    + '<div class="card-left">'
    + '<div class="platform-badge ' + l.platform + '">' + l.platformName + '</div>'
    + '<div class="avatar-row">' + avatars + '</div>'
    + noRevokeHtml
    + '</div>'
    + '<div class="card-mid">'
    + '<h4>' + l.customer.name + ' · ' + l.customer.age + '歳 · ' + l.customer.city
    + ' <span class="status-badge ' + l.state.toLowerCase() + '">' + getStateText(l.state) + '</span>'
    + tags
    + '</h4>'
    + '<div class="profile-grid">'
    + '<div class="profile-cell"><h5>客户资料</h5><p>' + interests + '</p>'
    + '<p style="color:var(--muted);margin-top:4px">自己紹介: ' + l.customer.selfIntro.slice(0, 40) + '…</p></div>'
    + '<div class="profile-cell"><h5>我方账号（' + l.accountSelf.name + '）</h5>'
    + '<p>' + l.accountSelf.age + '歳 · ' + l.accountSelf.city + '</p>'
    + '<p style="color:var(--muted);margin-top:4px">' + l.accountSelf.traits + '</p></div>'
    + '</div>'
    + '<div class="ai-section"><h5>🧠 心理分析 <span style="font-size:10px;color:var(--muted);margin-left:auto">点击折叠</span></h5><p>' + l.ai.analysis + '</p></div>'
    + '<div class="ai-section"><h5>🎯 应对策略</h5><p>' + l.ai.strategy + '</p></div>'
    + (l.chatHistory.length ? '<div class="chat-history"><h5>💬 聊天记录（原文/译文）</h5>' + chatHtml + '</div>' : '')
    + '<div class="talks"><h5>💬 话术选项（日语原文 + 中文译文）</h5>' + talkHtml + '</div>'
    + '<div class="card-actions">'
    + '<button data-action="1" class="a1">1·标记</button>'
    + '<button data-action="2" class="a2">2·拉黑</button>'
    + '<button data-action="3" class="a3">3·跳过</button>'
    + '<button data-action="4" class="a4">4·重新生成</button>'
    + '<button data-action="5" class="a5">5·AI对话</button>'
    + '<button data-action="6" class="a6">6·展开</button>'
    + '</div>'
    + '</div></div></div>';
}

function renderQueue() {
  var panel = document.getElementById('queuePanel');
  var items = queueItems.slice();
  var active = items.filter(function(q) { return q.status === 'queued' || q.status === 'pending'; });
  panel.innerHTML = '<h3>⏳ 待发送队列（' + active.length + ' 待发）</h3>' + items.map(function(q) {
    var l = leads.find(function(x) { return x.id === q.leadId; });
    var name = l ? l.customer.name : q.leadId;
    return '<div class="queue-item"><span>' + name + ' · ' + q.talkKey + '</span>'
      + '<span class="qstatus ' + q.status + '">' + (q.status === 'sent' ? '已发' : q.status === 'skipped' ? '跳过' : q.status === 'blocked' ? '拉黑' : '排队') + '</span></div>';
  }).join('');
}

function renderStats() {
  var queued = queueItems.filter(function(q) { return q.status === 'queued' || q.status === 'pending'; }).length;
  var sent = queueItems.filter(function(q) { return q.status === 'sent'; }).length;
  var skipped = queueItems.filter(function(q) { return q.status === 'skipped'; }).length;
  document.getElementById('queueStats').innerHTML =
    '<span>' + queued + '</span> 待发 · <span>' + sent + '</span> 已发 · <span>' + skipped + '</span> 跳过';
}

// ============ 操作处理 ============
function selectTalk(idx, talkKey) {
  var l = leads[idx];
  if (l.state === 'SENT' || l.state === 'BLOCKED') return;
  l.selectedTalk = talkKey;
  l.state = 'DRAFTED';
  var talk = l.ai.talks.find(function(t) { return t.key === talkKey; });
  // 入队列（如果还没入）
  var exists = queueItems.find(function(q) { return q.leadId === l.id && q.status !== 'sent' && q.status !== 'skipped'; });
  if (!exists) {
    var delay = 20 + Math.floor(Math.random() * 11); // 20-30s
    var sched = new Date(Date.now() + delay * 1000);
    queueItems.push({
      leadId: l.id, talkKey: talkKey,
      talkJp: talk.textJp, talkZh: talk.textZh,
      scheduledAt: sched.toISOString().replace('T', ' ').slice(0, 16),
      status: 'queued',
    });
  }
  l.opLog.push({ op: 'select-talk', operator: operator(), at: now(), note: '选 ' + talkKey + '「' + talk.textJp.slice(0, 10) + '…」' });
  // 自动滑到下一张
  currentIdx = Math.min(idx + 1, leads.length - 1);
  render();
}

function handleAction(idx, action) {
  var l = leads[idx];
  switch (action) {
    case '1': // 标记 - 不滑卡
      if (l.tags.indexOf('重点') === -1) l.tags.push('重点');
      l.opLog.push({ op: 'mark', operator: operator(), at: now(), note: '标记为重点跟进' });
      render();
      break;
    case '2': // 拉黑 - 需二次确认
      pendingBlock = idx;
      document.getElementById('blockTargetName').textContent = l.customer.name + ' · ' + l.customer.age + '歳';
      document.getElementById('blockOverlay').classList.remove('hidden');
      break;
    case '3': // 跳过 - 挪队尾 + 记日志 + 滑卡
      l.state = 'SKIPPED';
      var qi = queueItems.findIndex(function(q) { return q.leadId === l.id; });
      if (qi !== -1) {
        var item = queueItems.splice(qi, 1)[0];
        item.status = 'skipped';
        queueItems.push(item);
      }
      l.opLog.push({ op: 'skip', operator: operator(), at: now(), note: '【暂不回复】跳过，挪到队尾' });
      currentIdx = Math.min(idx + 1, leads.length - 1);
      render();
      break;
    case '4': // 重新生成（mock：随机调整置信度）
      l.ai.talks = l.ai.talks.map(function(t) {
        return { key: t.key, intent: t.intent, textJp: t.textJp, textZh: t.textZh,
          conf: Math.max(0.1, Math.min(1, t.conf + (Math.random() - 0.5) * 0.15)).toFixed(2) };
      });
      l.opLog.push({ op: 'regen', operator: operator(), at: now(), note: '重新生成话术' });
      render();
      break;
    case '5': // AI 对话（mock）
      alert('🤖 AI 对话（mock）\n\n你："更活泼一点，强调兴趣重合"\nAI："收到，已重新生成 4 条更活泼的话术（见 A-D）"\n\n（真实版将接 assistant.js）');
      l.opLog.push({ op: 'ai-dialog', operator: operator(), at: now(), note: '与 AI 对话微调话术' });
      render();
      break;
    case '6': // 展开/收起
      var card = document.getElementById('card-' + l.id);
      if (card) {
        Array.from(card.querySelectorAll('.ai-section')).forEach(function(s) {
          s.classList.remove('collapsed');
        });
      }
      render();
      break;
  }
}

function confirmBlock() {
  if (pendingBlock !== null) {
    var l = leads[pendingBlock];
    l.state = 'BLOCKED';
    l.opLog.push({ op: 'block', operator: operator(), at: now(), note: '拉黑 ' + l.customer.name });
    var qi = queueItems.findIndex(function(q) { return q.leadId === l.id; });
    if (qi !== -1) queueItems[qi].status = 'blocked';
    var nextIdx = pendingBlock;
    pendingBlock = null;
    document.getElementById('blockOverlay').classList.add('hidden');
    currentIdx = Math.min(nextIdx + 1, leads.length - 1);
    render();
  }
}
function cancelBlock() {
  pendingBlock = null;
  document.getElementById('blockOverlay').classList.add('hidden');
}

// ============ 键盘快捷键 ============
document.addEventListener('keydown', function(e) {
  if (document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return;
  var k = e.key.toLowerCase();
  if (pendingBlock !== null) {
    if (k === 'y') { e.preventDefault(); confirmBlock(); }
    if (k === 'escape') { e.preventDefault(); cancelBlock(); }
    return;
  }
  switch (k) {
    case 'a': selectTalk(currentIdx, 'A'); e.preventDefault(); break;
    case 'b': selectTalk(currentIdx, 'B'); e.preventDefault(); break;
    case 'c': selectTalk(currentIdx, 'C'); e.preventDefault(); break;
    case 'd': selectTalk(currentIdx, 'D'); e.preventDefault(); break;
    case '1': handleAction(currentIdx, '1'); e.preventDefault(); break;
    case '2': handleAction(currentIdx, '2'); e.preventDefault(); break;
    case '3': handleAction(currentIdx, '3'); e.preventDefault(); break;
    case '4': handleAction(currentIdx, '4'); e.preventDefault(); break;
    case '5': handleAction(currentIdx, '5'); e.preventDefault(); break;
    case '6': handleAction(currentIdx, '6'); e.preventDefault(); break;
    case 'arrowright':
    case ' ': currentIdx = Math.min(currentIdx + 1, leads.length - 1); render(); e.preventDefault(); break;
    case 'arrowleft': currentIdx = Math.max(currentIdx - 1, 0); render(); e.preventDefault(); break;
  }
});

// 导航切换
Array.from(document.querySelectorAll('.nav-item')).forEach(function(n) {
  n.addEventListener('click', function() {
    Array.from(document.querySelectorAll('.nav-item')).forEach(function(x) { x.classList.remove('active'); });
    n.classList.add('active');
    var view = n.dataset.view;
    var deck = document.getElementById('cardDeck');
    var toolbar = document.getElementById('toolbar');
    if (view === 'deck') {
      deck.style.display = 'flex';
      toolbar.style.display = 'flex';
      render();
    } else {
      deck.style.display = 'block';
      toolbar.style.display = 'none';
      if (view === 'queue') {
        deck.innerHTML = '<h2 style="font-size:16px;margin-bottom:12px;color:var(--accent)">⏳ 待发送队列</h2>' +
          queueItems.map(function(q) {
            var l = leads.find(function(x) { return x.id === q.leadId; });
            return '<div style="padding:8px 12px;border-bottom:1px solid var(--border)"><strong>'
              + (l ? l.customer.name : q.leadId) + '</strong> · 话术' + q.talkKey + ' · ' + q.status + ' · 计划 ' + q.scheduledAt + '</div>';
          }).join('') || '<div style="padding:16px;color:var(--muted)">暂无待发送项</div>';
      }
      if (view === 'log') {
        var allLog = leads.flatMap(function(l) {
          return l.opLog.map(function(e) { return { op: e.op, operator: e.operator, at: e.at, note: e.note, leadId: l.id, name: l.customer.name }; });
        });
        deck.innerHTML = '<h2 style="font-size:16px;margin-bottom:12px;color:var(--accent)">📝 操作日志</h2>' +
          allLog.map(function(e) {
            return '<div style="padding:6px 12px;border-bottom:1px solid var(--border);font-size:12px">'
              + e.at + ' · 操作员' + e.operator + ' · <strong>' + e.name + '</strong> · 【' + e.note + '】</div>';
          }).join('') || '<div style="padding:16px;color:var(--muted)">暂无操作日志</div>';
      }
      if (view === 'help') {
        deck.innerHTML = '<h2 style="font-size:16px;margin-bottom:12px;color:var(--accent)">❓ 快捷键说明</h2><div style="padding:16px;font-size:13px;line-height:2.2">'
          + '<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">A</kbd>~<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">D</kbd> 选话术 → 待发送（自动滑卡）<br>'
          + '<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">1</kbd> 标记（不滑卡） · '
          + '<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">2</kbd> 拉黑（需 Y 确认） · '
          + '<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">3</kbd> 跳过（挪队尾+记日志）<br>'
          + '<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">4</kbd> 重新生成 · '
          + '<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">5</kbd> AI 对话 · '
          + '<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">6</kbd> 展开分析<br>'
          + '<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">→</kbd>/<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">Space</kbd> 下一张 · '
          + '<kbd style="background:var(--panel2);border-radius:4px;padding:2px 6px">←</kbd> 上一张<br>'
          + '<br>发送节奏：每 20 秒 ± 0-10 秒浮动（后台队列池串行发）</div>';
      }
    }
  });
});

window.onerror = function(msg, src, line, col, err) {
  try {
    var el = document.getElementById('cardDeck');
    if (el) el.innerHTML = '<div style="padding:20px;color:#ef4444;font-family:monospace;font-size:12px">JS 错误: ' + msg + ' @ ' + line + ':' + col + '<br>' + (err && err.stack ? err.stack.split('\n').slice(0,5).join('<br>') : '') + '</div>';
  } catch (_) {}
  console.error('[card-deck] onerror:', msg, src, line, col, err && err.stack);
};
loadLeads().then(function(list) {
  leads = list;
  leadsLoaded = true;
  render();
}).catch(function(e) {
  leadsLoaded = true;
  render();
});

