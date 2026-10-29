'use strict';
// 全域运营前端模块（模块4-8）：调 /api/console/domain/* 路由，渲染 6 卡片
import { state } from './state.js';
import { toast } from './util.js';

export async function loadAshiato() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '足迹反撩（最近访问者）';
  if (el) el.innerHTML = '<div style="color:var(--muted,#888);font-size:12px">加载中...</div>';
  try {
    var r = await fetch('/api/console/domain/ashiato');
    var d = await r.json();
    if (!d.ok) { renderError(el, d); return; }
    if (!d.footmarks || d.footmarks.length === 0) {
      el.innerHTML = '<div style="padding:24px;color:var(--muted,#888);font-size:12px">当前无足迹数据</div>';
      return;
    }
    var visitInfo = d.visitCount !== null ? ('<div style="margin-bottom:8px;font-size:12px;color:var(--muted)">本日访问者数: ' + d.visitCount + '</div>') : '';
    var rows = d.footmarks.map(function(f) {
      var src = f.source ? ' (' + f.source + ')' : '';
      var time = f.time ? ' ' + f.time : '';
      var online = f.online ? ' <span style="color:#2ecc71">online</span>' : '';
      var ageCity = f.age ? (f.age + (f.city ? '/' + f.city : '')) : '';
      return '<div style="padding:8px 12px;border-bottom:1px solid var(--border,#333);display:flex;justify-content:space-between">'
        + '<span>' + (f.name || '匿名') + ' ' + ageCity + online + src + time + '</span>'
        + '<span style="font-size:11px;color:var(--muted,#888)">' + (f.footmarkId ? 'ID:' + f.footmarkId : '') + '</span></div>';
    }).join('');
    el.innerHTML = visitInfo + rows + '<div style="margin-top:12px;font-size:11px;color:var(--muted,#888)">共 ' + d.footmarks.length + ' 条</div>';
  } catch (e) { renderError(el, { msg: String(e) }); }
}

export async function loadFaces() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '找对象页会员列表';
  if (el) el.innerHTML = '<div style="color:var(--muted,#888);font-size:12px">加载中...</div>';
  try {
    var r = await fetch('/api/console/domain/faces');
    var d = await r.json();
    if (!d.ok) { renderError(el, d); return; }
    if (!d.members || d.members.length === 0) {
      el.innerHTML = '<div style="padding:24px;color:var(--muted,#888);font-size:12px">当前无会员卡片</div>';
      return;
    }
    var cards = d.members.map(function(m) {
      return '<div style="padding:8px 12px;border-bottom:1px solid var(--border,#333);display:flex;justify-content:space-between">'
        + '<span>' + (m.name || '匿名') + (m.age ? ' (' + m.age + ')' : '') + ' <span style="color:var(--muted,#888)">' + [m.pref, m.city].filter(Boolean).join(' / ') + '</span></span>'
        + '<span style="font-size:11px;color:var(--muted,#888)">ID:' + (m.memberId || '?') + '</span></div>';
    }).join('');
    el.innerHTML = '<div style="margin-bottom:8px;font-size:12px;color:var(--muted,#888)">共 ' + d.count + ' 位会员</div>' + cards;
  } catch (e) { renderError(el, { msg: String(e) }); }
}

export async function loadSearch() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '高级搜索（dry-run）';
  if (el) el.innerHTML = buildSearchForm();
  var collect = function(submit) {
    return {
      submit: submit,
      confirmed: submit,
      fields: {
        ageFrom: document.getElementById('sAgeFrom').value || undefined,
        ageTo: document.getElementById('sAgeTo').value || undefined,
        married: [document.getElementById('sMarried').value || undefined],
        sortOrder: parseInt(document.getElementById('sSort').value || '1', 10)
      }
    };
  };
  document.getElementById('searchDryBtn').addEventListener('click', function() {
    doSearch(false);
  });
  document.getElementById('searchGoBtn').addEventListener('click', function() {
    if (!confirm('确认执行高级搜索提交？')) return;
    doSearch(true);
  });
  async function doSearch(submit) {
    var opts = collect(submit);
    var res = await fetch('/api/console/domain/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opts: opts }) });
    var d = await res.json();
    var el2 = document.getElementById('searchResult');
    if (!d.ok) { el2.innerHTML = '<div style="color:#c0392b;font-size:12px">' + (d.msg || d.reason || 'failed') + '</div>'; return; }
    el2.innerHTML = '<div style="font-size:12px;color:' + (d.ok ? '#2ecc71' : '#c0392b') + '">已填 ' + (d.fieldsSet || 0) + ' 字段' + (d.step === 'filled' ? '（dry-run 未提交）' : '') + '</div>';
  }
}

function buildSearchForm() {
  return '<div style="padding:12px">'
    + '<div style="font-size:12px;color:var(--muted,#888);margin-bottom:12px">填入搜索条件（默认 dry-run，需确认才提交）</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">'
    + '<label style="font-size:12px">age <select id="sAgeFrom" style="font-size:12px;padding:4px"><option value="">-</option><option>20</option><option>25</option><option>30</option><option>35</option></select>'
    + ' <select id="sAgeTo" style="font-size:12px;padding:4px"><option value="">-</option><option>30</option><option>35</option><option>40</option><option>45</option></select></label>'
    + '<label style="font-size:12px">married <select id="sMarried" style="font-size:12px;padding:4px"><option value="1">single</option><option value="2">divorced</option></select></label>'
    + '<label style="font-size:12px">sort <select id="sSort" style="font-size:12px;padding:4px"><option value="1">distance</option><option value="2">age</option></select></label>'
    + '</div>'
    + '<button id="searchDryBtn" class="batch-btn" style="font-size:12px;padding:6px 14px;margin-right:8px">Dry-run</button>'
    + '<button id="searchGoBtn" class="batch-btn batch-danger" style="font-size:12px;padding:6px 14px">Submit</button>'
    + '<div id="searchResult" style="margin-top:12px"></div></div>';
}

export async function loadIgnore() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '忽略列表';
  if (el) el.innerHTML = '<div style="color:var(--muted,#888);font-size:12px">加载中...</div>';
  try {
    var r = await fetch('/api/console/domain/ignore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opts: { action: 'list' } }) });
    var d = await r.json();
    if (!d.ok) { renderError(el, d); return; }
    if (!d.ignoredMemberIds || d.ignoredMemberIds.length === 0) {
      el.innerHTML = '<div style="padding:24px;color:var(--muted,#888);font-size:12px">忽略列表为空（0 条）</div>';
      return;
    }
    var rows = d.ignoredMemberIds.map(function(id) {
      return '<div style="padding:8px 12px;border-bottom:1px solid var(--border,#333);display:flex;justify-content:space-between">'
        + '<span>ID: ' + id + '</span>'
        + '<button class="batch-btn batch-ghost" style="font-size:11px;padding:4px 10px" data-unignore="' + id + '">解除</button></div>';
    }).join('');
    el.innerHTML = '<div style="margin-bottom:8px;font-size:12px;color:var(--muted,#888)">共 ' + d.count + ' 条</div>' + rows;
    el.querySelectorAll('[data-unignore]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = this.getAttribute('data-unignore');
        if (!confirm('确认解除对 ' + id + ' 的忽略？')) return;
        var that = this;
        fetch('/api/console/domain/ignore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opts: { action: 'unignore', memberIds: [id], confirmed: true } }) })
          .then(function(r) { return r.json(); })
          .then(function(d2) {
            if (!d2.ok) { renderError(el, d2); return; }
            toast('已解除 ' + id, true);
            loadIgnore();
          });
      });
    });
  } catch (e) { renderError(el, { msg: String(e) }); }
}

export async function loadCalendar() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '日历（可会面日）';
  if (el) el.innerHTML = '<div style="color:var(--muted,#888);font-size:12px">加载中...</div>';
  try {
    var r = await fetch('/api/console/domain/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opts: { action: 'list' } }) });
    var d = await r.json();
    if (!d.ok) { renderError(el, d); return; }
    var prefInfo = d.prefId ? '<div style="margin-bottom:8px;font-size:12px;color:var(--muted)">prefId=' + d.prefId + '</div>' : '';
    var rows = (d.entries || []).map(function(e) {
      var dayStr = [e.month, e.date, e.day].filter(Boolean).join(' ');
      var area = e.area ? ' ' + e.area : '';
      return '<div style="padding:8px 12px;border-bottom:1px solid var(--border,#333);display:flex;justify-content:space-between">'
        + '<span>' + dayStr + area + '</span>'
        + (e.hasRelease ? '<button class="batch-btn batch-ghost" style="font-size:11px;padding:4px 10px" data-release>解除</button>' : '')
        + '</div>';
    }).join('');
    el.innerHTML = prefInfo + (rows || '<div style="color:var(--muted,#888);font-size:12px">当前无已登记</div>')
      + '<div style="padding:8px 12px;display:flex;align-items:center;gap:8px;margin-top:12px">'
      + '<span style="font-size:12px;color:var(--muted,#888)">添加:</span>'
      + '<input type="date" id="calAddDate" style="font-size:12px;padding:4px">'
      + '<button id="calAddBtn" class="batch-btn" style="font-size:12px;padding:6px 14px">添加</button></div>'
      + '<div id="calResult" style="margin-top:12px"></div>';
    var addBtn = document.getElementById('calAddBtn');
    if (addBtn) addBtn.addEventListener('click', function() {
      var day = document.getElementById('calAddDate').value;
      if (!day) { toast('请选择日期', false); return; }
      if (!confirm('确认添加 ' + day + '？')) return;
      fetch('/api/console/domain/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opts: { action: 'addDays', days: [day], confirmed: true } }) })
        .then(function(r) { return r.json(); })
        .then(function(d2) {
          var el2 = document.getElementById('calResult');
          if (!d2.ok) { el2.innerHTML = '<div style="color:#c0392b;font-size:12px">' + (d2.msg || d2.reason || 'failed') + '</div>'; return; }
          el2.innerHTML = '<div style="color:#2ecc71;font-size:12px">' + (d2.note || '已添加') + '</div>';
          loadCalendar();
        });
    });
    el.querySelectorAll('[data-release]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (!confirm('确认解除？')) return;
        fetch('/api/console/domain/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opts: { action: 'release', confirmed: true } }) })
          .then(function(r) { return r.json(); })
          .then(function(d2) {
            var el2 = document.getElementById('calResult');
            if (!d2.ok) { el2.innerHTML = '<div style="color:#c0392b;font-size:12px">' + (d2.msg || d2.reason || 'failed') + '</div>'; return; }
            el2.innerHTML = '<div style="color:#2ecc71;font-size:12px">' + (d2.note || '已解除') + '</div>';
            loadCalendar();
          });
      });
    });
  } catch (e) { renderError(el, { msg: String(e) }); }
}

export async function loadDiary() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '日记';
  if (el) el.innerHTML = '<div style="padding:12px">'
    + '<div style="font-size:12px;color:var(--muted,#888);margin-bottom:12px">发布日记（需确认）</div>'
    + '<div style="display:flex;gap:8px;margin-bottom:8px">'
    + '<input id="diaryTitle" placeholder="标题" style="flex:1;font-size:12px;padding:6px">'
    + '</div>'
    + '<textarea id="diaryBody" placeholder="正文" rows="4" style="width:100%;font-size:12px;padding:6px;margin-bottom:8px;resize:vertical"></textarea>'
    + '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">'
    + '<select id="diaryPublic" style="font-size:12px;padding:4px"><option value="1">public</option><option value="2">members</option><option value="6">draft</option></select>'
    + '<select id="diaryComment" style="font-size:12px;padding:4px"><option value="1">accept</option><option value="0">reject</option></select>'
    + '<button id="diaryPubBtn" class="batch-btn" style="font-size:12px;padding:6px 14px">发布</button>'
    + '</div><div id="diaryResult" style="margin-top:12px"></div></div>';
  document.getElementById('diaryPubBtn').addEventListener('click', function() {
    var t = document.getElementById('diaryTitle').value.trim();
    var b = document.getElementById('diaryBody').value.trim();
    if (!t || !b) { toast('请填写标题和正文', false); return; }
    if (!confirm('确认发布日记「' + t + '」？')) return;
    var opts = { action: 'write', title: t, body: b, publicFlag: parseInt(document.getElementById('diaryPublic').value, 10), commentReceptFlag: parseInt(document.getElementById('diaryComment').value, 10), confirmed: true };
    fetch('/api/console/domain/diary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opts: opts }) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var el2 = document.getElementById('diaryResult');
        if (!d.ok) { el2.innerHTML = '<div style="color:#c0392b;font-size:12px">' + (d.msg || d.note || d.reason || 'failed') + '</div>'; return; }
        el2.innerHTML = '<div style="color:#2ecc71;font-size:12px">' + (d.note || 'published') + '</div>';
      });
  });
}

function renderError(el, d) {
  if (!el) return;
  el.innerHTML = '<div style="padding:24px;color:#c0392b;font-size:12px">' + (d.msg || d.note || d.reason || 'unknown error') + '</div>';
}


// ---------- 统一待办列表（P1~P6 类别 × 在线档 排序） ----------
// candidates: [{ cat, online:{iconClass,label}, name, memberId, source, ... }]
export async function renderUnifiedList() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '全域待办（按优先级排序）';
  if (el) el.innerHTML = '<div style="color:var(--muted,#888);font-size:12px">加载中…（并行抓 6 类线索 + 排序）</div>';
  // 并行抓各来源候选（能抓哪个抓哪个，失败降级）
  var sources = [
    { cat: 'chat', fetchFn: async () => {
      var r = await fetch('/api/console/domain/chat');
      var d = await r.json();
      if (!d.ok || !d.chats) return [];
      return d.chats.map(function(c) {
        return { cat: 'chat', name: c.name, age: c.age, city: c.city, source: c.source, raw: c.raw, hasUnread: c.hasUnread,
                 online: { present: c.onlineIcon ? true : false, iconClass: c.onlineIcon || null, label: '' } };
      });
    } },
    { cat: 'like', fetchFn: async () => {
      // P2 抓 3 个 tab：received(别人给我点赞) + sent(我给别人) + mutual(互赞，最高价值)
      var tabs = ['received', 'sent', 'mutual'];
      var out = [];
      for (var t = 0; t < tabs.length; t++) {
        try {
          var r = await fetch('/api/console/domain/like?tab=' + tabs[t] + '&maxPages=3&maxItems=50');
          var d = await r.json();
          if (d.ok && d.likes) {
            var tabLabel = tabs[t] === 'mutual' ? '互赞' : (tabs[t] === 'sent' ? '我赞的' : '待回赞');
            d.likes.forEach(function(l) {
              out.push({ cat: 'like', name: l.name, age: l.age, city: l.city, memberId: l.memberId, source: (l.source || tabs[t]) + '(' + tabLabel + ')', time: l.time,
                        likeTab: tabs[t],
                        online: { present: l.onlineIcon ? true : false, iconClass: l.onlineIcon || null, label: '' } });
            });
          }
        } catch (e) { /* skip */ }
      }
      return out;
    } },
    { cat: 'viewed', fetchFn: async () => {
      // P4 抓 2 个方向：received(别人看我) + mine(我看别人)
      var dirs = ['received', 'mine'];
      var out = [];
      for (var di = 0; di < dirs.length; di++) {
        try {
          var r = await fetch('/api/console/domain/ashiato?direction=' + dirs[di] + '&maxPages=4&maxItems=50');
          var d = await r.json();
          if (d.ok && d.footmarks) {
            var dirLabel = dirs[di] === 'mine' ? '我看过的' : '看我的';
            d.footmarks.forEach(function(f) {
              out.push({ cat: 'viewed', name: f.name, age: f.age, city: f.city, source: (f.source || dirs[di]) + '(' + dirLabel + ')', time: f.time, footmarkId: f.footmarkId,
                         viewedDir: dirs[di],
                         online: { present: f.iconClass ? true : (f.online !== false), iconClass: f.iconClass || null, label: f.onlineLabel || '' } });
            });
          }
        } catch (e) { /* skip */ }
      }
      return out;
    } },
    { cat: 'browse', fetchFn: async () => {
      var r = await fetch('/api/console/domain/faces');
      var d = await r.json();
      if (!d.ok || !d.members) return [];
      return d.members.map(function(m) {
        return { cat: 'browse', name: m.name, age: m.age, city: m.city, memberId: m.memberId, source: 'お相手探し',
                 online: { present: m.iconClass ? true : false, iconClass: m.iconClass || null, label: m.onlineLabel || '' } };
      });
    } },
  ];
  var all = [];
  for (var i = 0; i < sources.length; i++) {
    try {
      var cands = await sources[i].fetchFn();
      all = all.concat(cands);
    } catch (e) { /* 单源失败不影响其他 */ }
  }
  if (all.length === 0) {
    el.innerHTML = '<div style="padding:24px;color:var(--muted,#888);font-size:12px">当前无可用线索（各来源均未返回数据）</div>';
    return;
  }
  // 喂给后端排序
  try {
    var r = await fetch('/api/console/domain/rank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates: all }) });
    var d = await r.json();
    if (!d.ok) { el.innerHTML = '<div style="color:#c0392b;font-size:12px">排序失败: ' + (d.msg || d.reason) + '</div>'; return; }
    var tierNames = { 1: '在线', 2: '最近在线', 3: '近期上线', 4: '较久未上线', 5: '未知' };
    var catNames = { chat: '正在聊', like: '点赞待回', comment: '留言', viewed: '被看', footmark: '足迹', browse: '主动浏览' };
    var rows = d.ranked.map(function(c) {
      var tier = tierNames[c.onlineTier] || c.onlineTier;
      var cat = catNames[c.cat] || c.cat;
      var name = c.name || c.memberId || '?';
      var meta = [c.age ? c.age + '歳' : '', c.city, c.source ? '来源:' + c.source : '', c.time ? c.time : ''].filter(Boolean).join(' · ');
      return '<div style="padding:8px 12px;border-bottom:1px solid var(--border,#333);display:flex;justify-content:space-between">'
        + '<span>' + name + (meta ? ' <span style="color:var(--muted,#888);font-size:11px">' + meta + '</span>' : '') + '</span>'
        + '<span style="font-size:11px;color:var(--muted,#888)">P' + c.catPriority + ' ' + cat + ' · ' + tier + '</span></div>';
    }).join('');
    el.innerHTML = '<div style="margin-bottom:8px;font-size:12px;color:var(--muted,#888)">共 ' + d.total + ' 条 · 按 引流类别×在线档 排序</div>' + rows;
  } catch (e) {
    el.innerHTML = '<div style="color:#c0392b;font-size:12px">排序接口不可用: ' + String(e) + '</div>';
  }
}

export function renderDomainPage(view) {
  var page = document.getElementById('domainPage');
  if (!page) return;
  switch (view) {
    case 'domain-ashiato': loadAshiato(); break;
    case 'domain-faces': loadFaces(); break;
    case 'domain-search': loadSearch(); break;
    case 'domain-ignore': loadIgnore(); break;
    case 'domain-calendar': loadCalendar(); break;
    case 'domain-pool': loadAccountPool(); break;
    case 'domain-toolbox': loadToolbox(); break;
    case 'domain-diary': loadDiary(); break;
    case 'domain-unified': renderUnifiedList(); break;
    case 'domain-toolbox': loadToolbox(); break;
    case 'domain-pool': loadAccountPool(); break;
    default: page.style.display = 'none'; return;
  }
  page.style.display = '';
}


// ---------- v5.3 · 批1 账号池/窗口池 + 健康巡检看板 ----------
export async function loadToolbox() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '运营工具箱';
  if (!el) return;
  var html = '<div style="padding:12px"><div class="section-title">📝 备忘录 / 🗓 日历 / 🗂 模板库</div>';
  html += '<div id="toolboxMemo" style="margin:8px 0"></div><div id="toolboxCal" style="margin:8px 0"></div><div id="toolboxPhr" style="margin:8px 0"></div></div>';
  el.innerHTML = html;
  // 备忘录
  fetch('/api/console/memos').then(function(r) { return r.json(); }).then(function(d) {
    var box = document.getElementById('toolboxMemo');
    if (!d.ok) { box.innerHTML = '<div class="empty">备忘录不可用：' + (d.reason || '') + '</div>'; return; }
    var rows = (d.memos || []).slice(0, 20).map(function(m) {
      return '<div style="font-size:12px;padding:3px 0;border-bottom:1px solid var(--border,#333)">' +
        (m.pinned ? '📌' : '') + ' <b>' + String(m.title || '').slice(0, 30) + '</b> ' + String(m.body || '').slice(0, 50) +
        ' <span style="color:var(--muted,#888);font-size:10px">[' + m.kind + ']' + (m.dueAt ? ' ⏰' + String(m.dueAt).slice(5, 16) : '') + '</span></div>';
    }).join('');
    box.innerHTML = '<div class="section-title" style="font-size:12px">📝 备忘录（' + (d.count || 0) + '）</div>' + (rows || '<div class="empty">暂无</div>');
  }).catch(function() {});
  // 日历
  fetch('/api/console/calendar').then(function(r) { return r.json(); }).then(function(d) {
    var box = document.getElementById('toolboxCal');
    if (!d.ok) { box.innerHTML = '<div class="empty">日历不可用</div>'; return; }
    var rows = (d.events || []).filter(function(e) { return !e.done; }).slice(0, 15).map(function(e) {
      var kindIcon = { meet: '🎯', followup: '⏰', 'line-push': '📱', post: '📢' }[e.kind] || '•';
      return '<div style="font-size:12px;padding:3px 0">' + kindIcon + ' ' + String(e.scheduledAt).slice(5, 16) + ' ' + String(e.title || e.kind).slice(0, 40) + '</div>';
    }).join('');
    box.innerHTML = '<div class="section-title" style="font-size:12px">🗓 待办日历（' + (d.count || 0) + '）</div>' + (rows || '<div class="empty">暂无待办</div>');
  }).catch(function() {});
  // 模板库
  fetch('/api/console/phrases').then(function(r) { return r.json(); }).then(function(d) {
    var box = document.getElementById('toolboxPhr');
    if (!d.ok) { box.innerHTML = '<div class="empty">模板库不可用</div>'; return; }
    var rows = (d.phrases || []).slice(0, 12).map(function(ph) {
      return '<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border,#333)">' +
        '<span style="color:var(--accent,#e64340);font-size:10px">[' + ph.scene + '·' + ph.lang + '] ' + (ph.usageCount || 0) + '用</span> ' +
        String(ph.content || '').slice(0, 60) + '…</div>';
    }).join('');
    box.innerHTML = '<div class="section-title" style="font-size:12px">🗂 模板库（' + (d.count || 0) + '）</div>' + (rows || '<div class="empty">暂无（POST /api/console/phrases 添加）</div>');
  }).catch(function() {});
}

// ---------- v5.3 · 批1 账号池/窗口池看板 ----------
export async function loadAccountPool() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '账号池 / 窗口池';
  if (!el) return;
  el.innerHTML = '<div style="padding:12px;color:var(--muted,#888);font-size:12px">巡检中…</div>';
  fetch('/api/console/account-pool').then(function(r) { return r.json(); }).then(function(d) {
    if (!d.ok) { el.innerHTML = '<div class="empty">账号池不可用：' + (d.reason || '') + '</div>'; return; }
    var winRows = (d.windows || []).map(function(w) {
      var h = (d.health || []).find(function(x) { return x.windowId === w.windowId; });
      var badge = h ? (h.status === 'healthy' ? '🟢' : '🔴') : '⚪';
      return '<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border,#333)">' +
        badge + ' <b>' + String(w.windowId).slice(0, 16) + '…</b> <span style="color:var(--muted,#888)">[' + w.accountId + ']' +
        (h && h.status === 'healthy' ? ' CDP 通' : (h ? ' ' + h.status : ' 未检')) + '</div>';
    }).join('');
    var accRows = (d.accounts || []).map(function(a) {
      return '<div style="font-size:12px;padding:3px 0">' + '👤 ' + a.label + ' <span style="color:var(--muted,#888)">[' + a.platform + '·' + a.status + ']</span></div>';
    }).join('');
    el.innerHTML = '<div style="padding:12px">' +
      '<div class="section-title">账号（' + (d.accounts || []).length + '）</div>' + (accRows || '<div class="empty">无账号</div>') +
      '<div class="section-title" style="margin-top:10px">窗口健康（' + (d.windows || []).length + '）</div>' + (winRows || '<div class="empty">无窗口</div>') +
      '</div>';
  }).catch(function(e) { el.innerHTML = '<div class="empty">巡检失败：' + e.message + '</div>'; });
}
