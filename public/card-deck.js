// 卡片交互原型 JS（mock 数据，真键盘操作，不碰真发）
'use strict';

// ============ Mock 数据（模拟出会平台真实候选） ============
var MOCK_LEADS = [
  {
    id: 'L1', platform: 'ichigo', platformName: '出会', noRevoke: true,
    customer: { name: 'カメ吉', age: 53, city: '神奈川県', avatar: 1, interests: ['温泉', '映画', '読書'], selfIntro: '音楽を聞きながら海山ドライブが趣味です。' },
    accountSelf: { name: 'ともね', age: 38, city: '三重・津市', traits: '美人系・巨乳・B型' },
    chatHistory: [
      { at: '10/26 23:58', dir: 'recv', textJp: 'プロフ見てもらってありがとう。', textZh: '谢谢你看了我的资料。' },
      { at: '10/27 00:07', dir: 'recv', textJp: '音楽を聞きながらドライブがスキです。', textZh: '我喜欢一边听音乐一边开车兜风。' },
    ],
    ai: {
      analysis: '对方主动点赞但没发言→试探期，兴趣重合：温泉/电影/读书（3项）→从兴趣切入最稳。',
      strategy: '先破冰拉兴趣重合点→推进线下（温泉/电影）→观察回复节奏。',
      talks: [
        { key: 'A', intent: '破冰·兴趣切入', textJp: '映画好きなら今月面白い作品ありましたね、一緒にどうですか？', textZh: '你喜欢电影的话，这个月有部很好的片子，要一起看吗？', conf: 0.82 },
        { key: 'B', intent: '推进·线下', textJp: '温泉、一緒に行ってみませんか？三重の温泉いいんですよ。', textZh: '要不要一起去泡个温泉？三重的温泉很不错哦。', conf: 0.71 },
        { key: 'C', intent: '轻唤回', textJp: '先日も見た映画、感想どうでしたか？', textZh: '前几天看到的那部电影，你感觉怎么样？', conf: 0.65 },
        { key: 'D', intent: '婉转拉扯', textJp: 'お疲れ様でした。ゆっくり休んでくださいね。', textZh: '辛苦了。好好休息哦。', conf: 0.58 },
      ],
    },
    state: 'PENDING', selectedTalk: null, tags: [], opLog: [],
  },
  {
    id: 'L2', platform: 'ichigo', platformName: '出会', noRevoke: true,
    customer: { name: 'カシオ', age: 27, city: '桑名市', avatar: 2, interests: ['車', '筋トレ', '音楽'], selfIntro: '桑名在住です！趣味は車と筋トレになります！' },
    accountSelf: { name: 'ともね', age: 38, city: '三重・津市', traits: '美人系・巨乳・B型' },
    chatHistory: [
      { at: '10/27 02:01', dir: 'recv', textJp: '桑名在住です！車と筋トレが趣味です。', textZh: '我住在桑名！喜欢开车和健身。' },
    ],
    ai: {
      analysis: '年轻男性，兴趣偏车/健身→直接聊兴趣容易尬住；年龄差11岁→需弱化年龄感，从"轻松日常"切入。',
      strategy: '避开年龄/兴趣硬碰硬→用"天气/周末"软话题破冰→观察是否主动延伸。',
      talks: [
        { key: 'A', intent: '软话题破冰', textJp: 'この前の休日、何しましたか？', textZh: '上个周末你做了什么？', conf: 0.78 },
        { key: 'B', intent: '轻松日常', textJp: '最近いい天気ですね、ドライブにはもってこいです。', textZh: '最近天气真好，很适合开车兜风。', conf: 0.69 },
        { key: 'C', intent: '试探延伸', textJp: 'ドライブの趣味、どこによく行きますか？', textZh: '你开车兜风一般去哪里？', conf: 0.61 },
        { key: 'D', intent: '轻唤回', textJp: 'お疲れ様です。今日は何しましたか？', textZh: '辛苦了。今天做了什么？', conf: 0.55 },
      ],
    },
    state: 'PENDING', selectedTalk: null, tags: [], opLog: [],
  },
  {
    id: 'L3', platform: 'ichigo', platformName: '出会', noRevoke: true,
    customer: { name: 'ゴジラ', age: 44, city: '鈴鹿市', avatar: 3, interests: ['お酒', '食べ歩き', '映画鑑賞', 'ギャンブル'], selfIntro: '誰似:藤井フミヤ。車:ある。タバコ:電子タバコ。' },
    accountSelf: { name: 'ともね', age: 38, city: '三重・津市', traits: '美人系・巨乳・B型' },
    chatHistory: [
      { at: '10/27 02:37', dir: 'recv', textJp: 'お酒が大好きです、食べ歩きも好き。', textZh: '我超爱喝酒，也喜欢逛吃。' },
    ],
    ai: {
      analysis: '兴趣丰富（酒/逛吃/电影/赌博）→高兴趣密度，适合"找共同点"策略；44岁偏成熟→语气需稳重不甜腻。',
      strategy: '从"喝酒/逛吃"切入（最易共鸣）→试探对方是否单身/社交活跃→推进线下小酌。',
      talks: [
        { key: 'A', intent: '找共鸣', textJp: '食べ歩き、よくどこに行きますか？おすすめのお店ありますか？', textZh: '你逛吃一般去哪里？有什么推荐的地方吗？', conf: 0.84 },
        { key: 'B', intent: '推进小酌', textJp: 'お酒飲むなら、一緒に飲みませんか？三重でいい場所知ってます。', textZh: '要喝酒的话，要一起喝吗？我知道三重有个不错的地方。', conf: 0.76 },
        { key: 'C', intent: '轻唤回', textJp: '昨日の飲み、楽しかったですね。', textZh: '昨天喝酒挺开心的。', conf: 0.62 },
        { key: 'D', intent: '婉转', textJp: 'お疲れ様でした。ゆっくり休んでください。', textZh: '辛苦了。好好休息。', conf: 0.50 },
      ],
    },
    state: 'PENDING', selectedTalk: null, tags: [], opLog: [],
  },
  {
    id: 'L4', platform: 'ichigo', platformName: '出会', noRevoke: true,
    customer: { name: 'ラル', age: 37, city: '愛知', avatar: 1, interests: ['サウナ', 'ゲーム'], selfIntro: '遊んでくれる方を募集してます！' },
    accountSelf: { name: 'ともね', age: 38, city: '三重・津市', traits: '美人系・巨乳・B型' },
    chatHistory: [
      { at: '10/26 04:39', dir: 'recv', textJp: 'サウナに興味あります。一緒にどうですか？', textZh: '我对桑拿感兴趣，要一起吗？' },
    ],
    ai: {
      analysis: '对方已主动提"一起"→高意向；兴趣偏游戏/桑拿→"宅+户外"混合型；37岁→可直接推进。',
      strategy: '接住对方"一起"的球→确认桑拿时间→顺势约线下（周末）。',
      talks: [
        { key: 'A', intent: '接球推进', textJp: 'サウナいいですね、今度一緒にいきましょう！', textZh: '桑拿不错，下次一起去吧！', conf: 0.88 },
        { key: 'B', intent: '确认时间', textJp: 'サウナ、いつが良さそうですか？', textZh: '桑拿什么时候去比较好？', conf: 0.74 },
        { key: 'C', intent: '轻唤回', textJp: 'サウナの話、覚えてましたよ。', textZh: '我还记得我们聊过桑拿呢。', conf: 0.58 },
        { key: 'D', intent: '婉转', textJp: 'お疲れ様でした。', textZh: '辛苦了。', conf: 0.45 },
      ],
    },
    state: 'PENDING', selectedTalk: null, tags: [], opLog: [],
  },
  {
    id: 'L5', platform: 'ichigo', platformName: '出会', noRevoke: true,
    customer: { name: '☆バル☆', age: 47, city: '四日市市', avatar: 2, interests: ['映画', '音楽'], selfIntro: 'きょうの出会いはぜったいアタリです。' },
    accountSelf: { name: 'ともね', age: 38, city: '三重・津市', traits: '美人系・巨乳・B型' },
    chatHistory: [
      { at: '10/19 15:34', dir: 'recv', textJp: 'きょうの出会いはぜったいアタリです。100%返事します。', textZh: '今天的邂逅一定是天意。我100%会回复的。' },
    ],
    ai: {
      analysis: '对方主动承诺"100%回复"→高意向但已过8天没跟进→需唤醒记忆；语气需热情不冷淡。',
      strategy: '直接唤醒对方"100%回复"的承诺→推进到具体行动（见面/LINE）。',
      talks: [
        { key: 'A', intent: '唤醒承诺', textJp: '「100%返事します」って言ってましたね、本気だったんですか？', textZh: '你说过"我100%会回复的"，是认真的吗？', conf: 0.85 },
        { key: 'B', intent: '推进LINE', textJp: 'LINEで連絡しませんか？', textZh: '我们加个LINE联系吧？', conf: 0.72 },
        { key: 'C', intent: '轻唤回', textJp: '最近どうですか？', textZh: '最近怎么样？', conf: 0.55 },
        { key: 'D', intent: '婉转', textJp: 'お疲れ様です。', textZh: '辛苦了。', conf: 0.40 },
      ],
    },
    state: 'PENDING', selectedTalk: null, tags: [], opLog: [],
  },
];

// ============ 状态管理 ============
var currentIdx = 0;
var leads = JSON.parse(JSON.stringify(MOCK_LEADS));
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
  var l = leads[currentIdx];
  if (!l) {
    deck.innerHTML = '<div style="text-align:center;padding:60px;color:var(--muted)">全部卡片处理完毕 ✓（← 可回看）</div>';
    return;
  }
  var stateMap = { PENDING: 'pending', DRAFTED: 'drafted', QUEUED: 'queued', SENT: 'sent', SKIPPED: 'skipped', BLOCKED: 'blocked' };
  var stateTextMap = { PENDING: '待处理', DRAFTED: '待发送', QUEUED: '排队中', SENT: '已发送', SKIPPED: '已跳过', BLOCKED: '已拉黑' };

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

  deck.innerHTML = '<div class="card" id="card-' + l.id + '">'
    + '<div class="card-block">'
    + '<div class="card-left">'
    + '<div class="platform-badge ' + l.platform + '">' + l.platformName + '</div>'
    + '<div class="avatar-row">' + avatars + '</div>'
    + noRevokeHtml
    + '</div>'
    + '<div class="card-mid">'
    + '<h4>' + l.customer.name + ' · ' + l.customer.age + '歳 · ' + l.customer.city
    + ' <span class="status-badge ' + stateMap[l.state] + '">' + stateTextMap[l.state] + '</span>'
    + tags
    + '</h4>'
    + '<div class="profile-grid">'
    + '<div class="profile-cell"><h5>客户资料</h5><p>' + interests + '</p>'
    + '<p style="color:var(--muted);margin-top:4px">自己紹介: ' + l.customer.selfIntro.slice(0, 50) + '…</p></div>'
    + '<div class="profile-cell"><h5>我方账号（' + l.accountSelf.name + '）</h5>'
    + '<p>' + l.accountSelf.age + '歳 · ' + l.accountSelf.city + '</p>'
    + '<p style="color:var(--muted);margin-top:4px">' + l.accountSelf.traits + '</p></div>'
    + '</div>'
    + '<div class="ai-section"><h5>🧠 心理分析</h5><p>' + l.ai.analysis + '</p></div>'
    + '<div class="ai-section"><h5>🎯 应对策略</h5><p>' + l.ai.strategy + '</p></div>'
    + (l.chatHistory.length ? '<div class="chat-history"><h5>💬 聊天记录（原文/译文）</h5>' + chatHtml + '</div>' : '')
    + '<div class="talks"><h5>💬 话术选项（按 A-D 选择 → 入待发送，自动滑下一张）</h5>' + talkHtml + '</div>'
    + '</div></div></div>';
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

render();
