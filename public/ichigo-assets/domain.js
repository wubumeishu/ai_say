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
    console.log('[leads] fetch result ok:', d.ok, 'count:', d.count || 0, 'reason:', d.reason || '');
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
    case 'domain-leads': loadLeads(); break;
    case 'domain-persona': loadPersona(); break;
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
  // 模板库（PhraseLibrary：场景标签 + 多语言 + 人设过滤，走 /phrase-library）
  fetch('/api/console/phrase-library').then(function(r) { return r.json(); }).then(function(d) {
    var box = document.getElementById('toolboxPhr');
    if (!d.ok) { box.innerHTML = '<div class="empty">模板库不可用</div>'; return; }
    var rows = (d.phrases || []).slice(0, 12).map(function(ph) {
      return '<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border,#333)">' +
        '<span style="color:var(--accent,#e64340);font-size:10px">[' + (ph.scene || '-') + '·' + (ph.lang || '-') + '] ' + (ph.usageCount || 0) + '用</span> ' +
        String(ph.content || '').slice(0, 60) + '…</div>';
    }).join('');
    box.innerHTML = '<div class="section-title" style="font-size:12px">🗂 模板库（' + (d.count || 0) + '）</div>' + (rows || '<div class="empty">暂无（POST /api/console/phrase-library 添加）</div>');
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


// ---------- 引流 T2 · 线索池 + 筛选器（005 Lead 表）----------

// 线索池 · 平台/窗口标识（从 /api/console/platforms + /api/console/account-pool 取）
async function loadPlatformChip() {
  var chip = document.getElementById('leadPlatChip');
  if (!chip) return;
  try {
    var [pf, pool] = await Promise.all([
      fetch('/api/console/platforms').then(function(r){ return r.json(); }),
      fetch('/api/console/account-pool').then(function(r){ return r.json(); }),
    ]);
    // 平台 id -> 简称
    var labels = {};
    ((pf && pf.platforms) || []).forEach(function(p) {
      labels[p.id] = p.label;
    });
    var active = pf && pf.active;
    // 账号 label（窗口号，如 17098）
    var accs = ((pool && pool.accounts) || []);
    var names = accs.map(function(a) {
      var pl = a.platform || (a.platformId ? labels[a.platformId] : '');
      return (pl ? pl + '-' : '') + a.label;
    }).filter(Boolean);
    if (names.length) {
      chip.textContent = names.join(' / ');
      chip.title = '线索池当前覆盖的窗口';
    } else {
      chip.textContent = (active ? labels[active] : '未连接') + '（无窗口账号）';
    }
  } catch (e) {
    chip.textContent = '平台信息不可用';
  }
}

export async function loadLeads() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '🎯 线索池（平台-窗口 · 累积留痕）';
  if (!el) { console.warn('[leads] domainContent not found'); return; }

  // 简化筛选：只按平台分组
  var filterHtml = [
    '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center">',
    '  <span style="font-size:12px;color:var(--muted,#888)">平台分组：</span>',
    '  <select id="leadFilterPlatform" style="font-size:12px;padding:3px 6px">',
    '    <option value="">全部平台</option>',
    '    <option value="ichigo">出会</option>',
    '    <option value="happymail">快乐</option>',
    '  </select>',
    '  <button id="leadFilterApply" style="font-size:12px;padding:3px 10px;cursor:pointer">应用</button>',
    '  <button id="leadFilterReset" style="font-size:12px;padding:3px 10px;cursor:pointer;color:var(--muted,#888)">重置</button>',
    '  <span style="flex:1"></span>',
    '  <span style="font-size:12px;color:var(--muted,#888)">侦测目标：</span>',
    '  <select id="leadExplorePlatform" style="font-size:12px;padding:3px 6px">',
    '    <option value="ichigo" selected>出会 17098</option>',
    '    <option value="happymail">快乐 18595</option>',
    '  </select>',
    '  <select id="leadExploreDims" style="font-size:12px;padding:3px 6px">',
    '    <option value="all">侦测全部维度</option>',
    '    <option value="like">点赞</option>',
    '    <option value="bbs">帖子</option>',
    '    <option value="ashiato">足迹</option>',
    '    <option value="search">检索</option>',
    '  </select>',
    '  <button id="leadExploreBtn" style="font-size:12px;padding:3px 10px;cursor:pointer;background:#1e5aa8;color:#fff;border:none;border-radius:3px">🔭 侦测灌库</button>',
    '  <span id="leadExploreStatus" style="font-size:11px;color:var(--muted,#888)"></span>',
    '</div>',
    '<div id="leadAgg" style="font-size:11px;color:var(--muted,#888);margin-bottom:8px"></div>',
    '<div id="leadList" style="max-height:600px;overflow-y:auto"></div>',
    '<div id="leadTaskBoard" style="margin-top:12px;padding:10px;border:1px solid var(--border,#2a3550);border-radius:6px">',
    '  <div style="font-size:13px;font-weight:600;margin-bottom:6px">📋 任务编排（呼吸引擎 · 节拍调度）',
    '    <span style="font-weight:400;color:var(--muted,#888);font-size:11px;margin-left:8px">引擎只调度节拍，副作用由 SOP 执行器驱动（铁律：不自动发消息）</span>',
    '  </div>',
    '  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">',
    '    <button id="leadBoardSeed" style="font-size:11px;padding:3px 8px;cursor:pointer;background:#3a4a6b;color:#fff;border:none;border-radius:3px">🌱 播种呼吸规则</button>',
    '    <button id="leadBoardEnqueue" style="font-size:11px;padding:3px 8px;cursor:pointer;background:#1e5aa8;color:#fff;border:none;border-radius:3px">➕ 入队示例任务(30s)</button>',
    '    <button id="leadBoardStart" style="font-size:11px;padding:3px 8px;cursor:pointer;background:#2ecc71;color:#fff;border:none;border-radius:3px">▶ 启动引擎</button>',
    '    <button id="leadBoardStop" style="font-size:11px;padding:3px 8px;cursor:pointer;background:#888;color:#fff;border:none;border-radius:3px">⏸ 停止引擎</button>',
    '    <button id="leadBoardRefresh" style="font-size:11px;padding:3px 8px;cursor:pointer;background:#3a4a6b;color:#fff;border:none;border-radius:3px">🔄 刷新看板</button>',
    '  </div>',
    '  <div id="leadTaskBoardStatus" style="font-size:12px;color:var(--muted,#888)" title=""></div>',
    '</div>',
    '<div style="margin-top:8px;font-size:11px;color:var(--muted,#888)" id="leadMeta"></div>',
  ].join('');
  el.innerHTML = filterHtml;

  document.getElementById('leadFilterApply').addEventListener('click', function() { fetchAndRender(); });
  document.getElementById('leadFilterReset').addEventListener('click', function() {
    document.getElementById('leadFilterPlatform').value = '';
    fetchAndRender();
  });

  // 侦测灌库按钮
  var exploreBtn = document.getElementById('leadExploreBtn');
  var exploreStatus = document.getElementById('leadExploreStatus');
  exploreBtn.addEventListener('click', async function() {
    var platSel = document.getElementById('leadExplorePlatform').value;
    var dimSel = document.getElementById('leadExploreDims').value;
    var dims = dimSel === 'all' ? ['like', 'bbs', 'ashiato', 'search'] : [dimSel];
    exploreBtn.disabled = true;
    exploreStatus.textContent = platSel === 'happymail' ? '快乐侦测中…' : '出会侦测中…（完成后自动回收件箱）';
    exploreStatus.style.color = '#f39c12';
    try {
      var url = platSel === 'happymail' ? '/api/console/leads/explore-happy' : '/api/console/leads/explore';
      var r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dims: dims, maxPages: platSel === 'happymail' ? 2 : 3 })
      });
      var j = await r.json();
      if (j.ok) {
        var dimNames = { like: '点赞', bbs: '帖子', ashiato: '足迹', search: '检索' };
        var dimStr = Object.keys(j.byDim || {}).filter(function(k) { return (j.byDim[k] || 0) > 0; })
          .map(function(k) { return dimNames[k] + ' ' + j.byDim[k]; }).join(' / ');
        exploreStatus.textContent = '完成：' + dimStr + '（灌入 ' + j.upserted + ' 条，共 ' + j.totalForWindow + ' 条）';
        if (j.emptyNote) { exploreStatus.textContent += ' ' + j.emptyNote; }
        exploreStatus.style.color = '#2ecc71';
        if ((j.errors || []).length) exploreStatus.textContent += ' | ' + j.errors.slice(0, 2).join('；');
        fetchAndRender();
      } else {
        exploreStatus.textContent = '失败：' + (j.reason || j.msg || '未知');
        exploreStatus.style.color = '#c0392b';
      }
    } catch (e) {
      exploreStatus.textContent = '请求失败：' + e.message;
      exploreStatus.style.color = '#c0392b';
    } finally {
      exploreBtn.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // T3 任务编排：看板（来源分布 / 完成情况 / 人工介入 high_intent / 引擎启停 / 入队）
  // 调 /api/console/tasks/breath/*；引擎只调度节拍，副作用由 SOP 执行器驱动。
  // ------------------------------------------------------------------
  var boardEl = document.getElementById('leadTaskBoard');
  if (boardEl) {
    var boardStatus = document.getElementById('leadTaskBoardStatus');
    async function renderTaskBoard() {
      try {
        var r = await fetch('/api/console/tasks/breath/board');
        var d = await r.json();
        if (!d.ok) { boardStatus.textContent = '看板不可用: ' + (d.reason || ''); boardStatus.style.color = '#c0392b'; return; }
        var eng = d.engine || {};
        var q = eng.queue || {};
        var highIntent = (d.highIntent || []);
        var byType = (d.byType || []);
        var rows = byType.map(function(x) { return x.type + '/' + x.status + ' ' + x.n; }).join(' · ');
        var engineTxt = eng.running ? '🟢 引擎运行中（tick ' + eng.tickMs + 'ms）' : '⚪ 引擎已停';
        var hiTxt = highIntent.length ? ('⚠️ ' + highIntent.length + ' 条人工介入（high_intent）: ' + highIntent.slice(0, 5).map(function(h) { return (h.accountId || '?') + '#' + (h.taskId || '').slice(0, 8); }).join(' ')) : '✅ 无人工介入待办';
        boardStatus.textContent = engineTxt + ' | 队列: pending ' + (q.pending || 0) + ' / done ' + (q.done || 0) + ' / failed ' + (q.failed || 0) + ' | 来源分布: ' + (rows || '(空)');
        boardStatus.style.color = eng.running ? '#2ecc71' : '#888';
        boardStatus.dataset.highIntent = hiTxt;
        // 详情挂到 title（悬停看 high_intent 明细）
        boardStatus.title = hiTxt + '\n' + (d.recent || []).slice(0, 10).map(function(t) { return (t.taskId || '').slice(0, 8) + ' ' + t.type + ' ' + t.status + (t.error ? ' ⚠' + t.error : ''); }).join('\n');
      } catch (e) {
        boardStatus.textContent = '看板请求失败: ' + e.message;
        boardStatus.style.color = '#c0392b';
      }
    }
    document.getElementById('leadBoardRefresh').addEventListener('click', renderTaskBoard);
    document.getElementById('leadBoardSeed').addEventListener('click', async function() {
      var r = await fetch('/api/console/tasks/breath/rules/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pool: 'warmup' }) });
      var d = await r.json();
      boardStatus.textContent = (d.ok ? '✅ 呼吸规则已播种 ' + d.inserted + ' 条' : '播种失败: ' + d.reason);
      boardStatus.style.color = d.ok ? '#2ecc71' : '#c0392b';
      setTimeout(renderTaskBoard, 600);
    });
    document.getElementById('leadBoardStart').addEventListener('click', async function() {
      var r = await fetch('/api/console/tasks/breath/start', { method: 'POST' });
      var d = await r.json();
      boardStatus.textContent = d.ok ? '🟢 引擎已启动（节拍调度中）' : '启动失败: ' + d.reason;
      boardStatus.style.color = d.ok ? '#2ecc71' : '#c0392b';
      setTimeout(renderTaskBoard, 400);
    });
    document.getElementById('leadBoardStop').addEventListener('click', async function() {
      var r = await fetch('/api/console/tasks/breath/stop', { method: 'POST' });
      var d = await r.json();
      boardStatus.textContent = d.ok ? '⚪ 引擎已停止' : '停止失败: ' + d.reason;
      boardStatus.style.color = d.ok ? '#888' : '#c0392b';
      setTimeout(renderTaskBoard, 400);
    });
    // 入队示例任务（点赞场景 + 当前平台窗口 + 30s 后唤醒）
    document.getElementById('leadBoardEnqueue').addEventListener('click', async function() {
      var plat = document.getElementById('leadFilterPlatform') ? document.getElementById('leadFilterPlatform').value : '';
      var acc = plat === 'happymail' ? '18595' : '17098';
      var r = await fetch('/api/console/tasks/breath/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: plat || 'ichigo', accountId: acc, type: 'like', nextWakeAt: Date.now() + 30000, delayMs: 30000 }) });
      var d = await r.json();
      boardStatus.textContent = (d.ok ? '✅ 已入队 ' + (d.taskId || '').slice(0, 10) + '…（30s 后唤醒，like 场景节拍）' : '入队失败: ' + d.reason);
      boardStatus.style.color = d.ok ? '#2ecc71' : '#c0392b';
      setTimeout(renderTaskBoard, 400);
    });
    // 首次进线索池渲染一次看板
    renderTaskBoard();
  }

  async function fetchAndRender() {
    var plat = document.getElementById('leadFilterPlatform').value;
    var qs = new URLSearchParams();
    if (plat) qs.set('platform', plat);
    qs.set('limit', '1000');
    var r = await fetch('/api/console/leads?' + qs.toString());
    var d = await r.json();
    var listEl = document.getElementById('leadList');
    var aggEl = document.getElementById('leadAgg');
    var metaEl = document.getElementById('leadMeta');
    if (!d.ok) { listEl.innerHTML = '<div style="padding:24px;color:#c0392b;font-size:12px">加载失败：' + (d.reason || d.msg || '') + '</div>'; return; }

    // 按平台+窗口(accountId)分组
    var groups = {};
    (d.leads || []).forEach(function(l) {
      var key = (l.platform || 'unknown') + '-' + (l.accountId || '?');
      if (!groups[key]) groups[key] = [];
      groups[key].push(l);
    });

    var platName = { ichigo: '出会', happymail: '快乐' };
    aggEl.textContent = '共 ' + Object.keys(groups).length + ' 个窗口分组，' + (d.leads||[]).length + ' 条线索';

    // 渲染每个分组
    var rows = Object.keys(groups).map(function(key) {
      var gLeads = groups[key];
      var gKey = key.split('-');
      var platLabel = platName[gKey[0]] || gKey[0];
      var winLabel = gKey[1];
      var gHtml = '<div style="padding:10px 0;border-bottom:2px solid var(--border,#444);margin-bottom:8px">' +
        '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">📍 ' +
        escapeHtml(platLabel) + ' - ' + escapeHtml(winLabel) +
        ' <span style="font-size:11px;color:var(--muted,#888);font-weight:400">' + gLeads.length + ' 条</span></div>' +
        '<div style="font-size:10px;color:var(--muted,#888);margin-bottom:4px">地区 = 客户自己填写的位置（按实际显示为准，非检索条件）</div>' +
        gLeads.map(function(l) {
          // 按来源维度显示具体时间
          var timeText = '';
          var extras = l.extras || {};
          if (l.sourceDim === 'like') {
            timeText = '点赞 ' + (extras.like_time || '未知');
          } else if (l.sourceDim === 'bbs') {
            timeText = '发帖 ' + (extras.bbs_date || '未知');
          } else if (l.sourceDim === 'ashiato') {
            timeText = '访问 ' + (extras.foot_time || '未知');
          } else if (l.sourceDim === 'faces') {
            timeText = '上线 ' + String(l.lastSeen || '').slice(5, 16);
          } else if (l.sourceDim === 'search') {
            timeText = '检索 ' + String(l.firstSeen || '').slice(5, 16);
          } else {
            timeText = '发现 ' + String(l.firstSeen || '').slice(5, 16);
          }
          // 在线图标(会出=实时在线档 online-icon1/2/3;快乐=最后登录 24h 内活跃/7 天内近期/离线)
          var on = String(l.online || '');
          var onlineIcon = '⚪';
          var onlineTip = '';
          if (on.indexOf('happy-green') !== -1) { onlineIcon = '🟢'; onlineTip = '在线(平台绿点)'; }
          else if (on.indexOf('happy-yellow') !== -1) { onlineIcon = '🟡'; onlineTip = '不常在线(平台黄点)'; }
          else if (on.indexOf('happy-gray') !== -1) { onlineIcon = '⚪'; onlineTip = '离线(平台灰点)'; }
          else if (on.indexOf('online-icon1') !== -1) { onlineIcon = '🟢'; onlineTip = '在线'; }
          else if (on.indexOf('online-icon2') !== -1) { onlineIcon = '🟡'; onlineTip = '24h 内在线'; }
          else if (on.indexOf('offline') !== -1) { onlineIcon = '⚪'; onlineTip = '离线(最后登录 ' + ((l.extras && l.extras.last_login) || '未知') + ')'; }
          if ((l.extras && l.extras.last_login) && on.indexOf('happy-') !== 0) onlineTip = onlineTip ? onlineTip : '最后登录 ' + l.extras.last_login;
          // 翻译简介
          var introText = '';
          if (l.selfIntro) {
            var introEl = document.createElement('span');
            introEl.textContent = l.selfIntro;
            introText = l.selfIntro.slice(0, 60);
            // 触发翻译（异步）
            translateAndSet(l.selfIntro, function(zh) {
              introText = zh;
            });
          }
          return '<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;font-size:12px">' +
            '<span style="min-width:18px" title="' + onlineTip + '">' + onlineIcon + '</span>' +
            '<span style="min-width:60px;font-weight:600">' + escapeHtml(l.name || '?') + '</span>' +
            '<span style="min-width:26px;color:var(--muted,#888)">' + (l.age || '') + '</span>' +
            '<span style="min-width:44px;color:var(--muted,#888)" title="客户自己填写的地区（检索条件不代表客户位置）">' + escapeHtml(l.region || '') + '</span>' +
            '<span style="font-size:10px;color:var(--muted,#888)">' + escapeHtml(l.sourceDim || '') + '</span>' +
            '<span style="font-size:10px;color:#4aa3ff">' + escapeHtml(timeText) + '</span>' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted,#888);font-size:11px" data-intro-id="' + l.leadId + '">' +
              escapeHtml(introText || '') +
            '</span>' +
            '</div>';
        }).join('') +
        '</div>';
      return gHtml;
    }).join('');
    listEl.innerHTML = rows;
    metaEl.textContent = '共 ' + d.count + ' 条（累积留痕，同客户以最新记录为准）';

    // 翻译所有简介（批量）
    translateAllIntros(listEl, d.leads);
  }

  // 批量翻译简介
  function translateAllIntros(listEl, leads) {
    var toTranslate = leads.filter(l => l.selfIntro && l.selfIntro.length > 0);
    if (toTranslate.length === 0) return;
    // 去重
    var uniqueIntros = [...new Set(toTranslate.map(l => l.selfIntro))];
    var batch = uniqueIntros.map(t => ({ text: t, from: 'ja', to: 'zh-CN' }));
    fetch('/api/console/translate/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: batch })
    }).then(r => r.json()).then(function(j) {
      if (!j.ok || !j.results) return;
      // 建立映射
      var transMap = {};
      j.results.forEach(function(item, i) {
        transMap[batch[i].text] = item.text || batch[i].text;
      });
      // 更新 DOM
      leads.forEach(function(l) {
        if (l.selfIntro && transMap[l.selfIntro]) {
          var el2 = listEl.querySelector('[data-intro-id="' + l.leadId + '"]');
          if (el2) el2.textContent = transMap[l.selfIntro];
        }
      });
    }).catch(function(e) { console.warn('[leads] 批量翻译失败:', e); });
  }

  function translateAndSet(text, cb) {
    // 单条翻译（备用）
    fetch('/api/console/translate?text=' + encodeURIComponent(text) + '&from=ja&to=zh-CN')
      .then(r => r.json())
      .then(j => { if (j.ok && j.text) cb(j.text); else cb(text); })
      .catch(() => cb(text));
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  fetchAndRender().catch(function(e) { console.error('[leads] fetch error:', e); });
}



// ---------- 账号人设(出会 17098 本账号资料卡) ----------
// 抓出会 17098 本账号(ともね)的资料卡 → AccountPersona, 供 AI 生成话术时注入"人设"要素
export async function loadPersona() {
  var el = document.getElementById('domainContent');
  var title = document.getElementById('domainTitle');
  if (title) title.textContent = '账号人设（出会 17098 · ともね）';
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:13px">加载中…</div>';
  // 读当前 AccountPersona
  var persona = null;
  try {
    var r = await fetch('/api/console/account-persona?accountId=17098');
    var d = await r.json();
    if (d.ok && d.persona) {
      persona = JSON.parse(d.persona.persona || '{}');
    }
  } catch (e) { /* 未注入降级 */ }
  var rows = '';
  if (persona && (persona.name || persona.interests)) {
    rows = '<div class="persona-grid">'
      + personaField('姓名', persona.name)
      + personaField('年龄', persona.age)
      + personaField('地区', persona.region)
      + personaField('职业', persona.occupation)
      + personaField('身高', persona.height)
      + personaField('收入', persona.income)
      + personaField('风格', persona.style)
      + '<div class="persona-field"><h5>兴趣</h5><p>' + (Array.isArray(persona.interests) ? persona.interests.join(' · ') : '<span style="color:var(--muted)">（无）</span>') + '</p></div>'
      + '<div class="persona-field"><h5>自我介绍</h5><p>' + (persona.selfIntro || '<span style="color:var(--muted)">（无）</span>') + '</p></div>'
      + (persona.crawledAt ? '<div style="font-size:11px;color:var(--muted);margin-top:8px">抓取于 ' + persona.crawledAt + '</div>' : '')
      + '</div>';
  } else {
    rows = '<div style="padding:16px;color:var(--muted);font-size:13px">暂无账户人设数据。开 17098 窗口后点「抓取本账号资料卡」。</div>';
  }
  el.innerHTML = rows
    + '<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">'
    + '<button id="btnPersonaCrawl" style="background:var(--accent,#4f8cff);color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:12px;cursor:pointer">🔭 抓取本账号资料卡（17098）</button>'
    + '<button id="btnPersonaUpdate" style="background:var(--panel2,#22252f);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 16px;font-size:12px;cursor:pointer">✏️ 一键修改（后续）</button>'
    + '</div>';
  var bc = document.getElementById('btnPersonaCrawl');
  if (bc) bc.onclick = function() { crawlPersona(); };
  // 样式内联
  var st = document.createElement('style');
  st.textContent = '.persona-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.persona-field{background:var(--panel2);border-radius:8px;padding:8px 12px}.persona-field h5{font-size:11px;color:var(--muted);margin-bottom:4px;font-weight:600}.persona-field p{font-size:12px;line-height:1.5}';
  el.appendChild(st);
}

function personaField(label, val) {
  return '<div class="persona-field"><h5>' + label + '</h5><p>' + (val != null && val !== '' ? val : '<span style="color:var(--muted)">（无）</span>') + '</p></div>';
}

async function crawlPersona() {
  var btn = document.getElementById('btnPersonaCrawl');
  if (btn) { btn.textContent = '⏳ 抓取中…'; btn.disabled = true; }
  try {
    var r = await fetch('/api/console/account-persona/crawl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: '17098' }) });
    var d = await r.json();
    if (btn) { btn.textContent = '🔭 抓取本账号资料卡（17098）'; btn.disabled = false; }
    if (d.ok) { loadPersona(); }
    else { alert('抓取失败: ' + (d.msg || d.reason)); }
  } catch (e) {
    if (btn) { btn.textContent = '🔭 抓取本账号资料卡（17098）'; btn.disabled = false; }
    alert('请求失败: ' + e.message);
  }
}
