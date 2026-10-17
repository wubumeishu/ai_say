// 第七刀 · accounts.js（账号卡 + 地点管理，复制自 ichigo-console.html L1784-1979/L2132）
// 依赖：util.js(esc/prettyFields/toast/copyText) + phrases.js(openPhraseModal/closePhraseModal/deletePhrase 跨模块保护)
'use strict';
import { esc, prettyFields, toast, copyText } from './util.js';
import { openPhraseModal, closePhraseModal, savePhraseForm, deletePhrase } from './phrases.js'; // 第 8 刀收口：直接 import

// 账号状态（原 L1784 全局 acctState）
export var acctState = { account: null, places: [], editingPlaceId: null, phrases: [], groups: [], activeGroup: '__all__', editingPhraseId: null };

// 加载账号（复制自 L1786）
export function loadAccount() {
  return fetch('/api/console/account').then(function(r) { return r.json(); }).then(function(j) {
    if (!j.ok || !j.account) return;
    acctState.account = j.account;
    acctState.places = j.account.places || [];
    renderAccount(j.account);
    if (!j.account.profileCard) refreshAccountCard(true);
  }).catch(function(e) { console.warn('account load failed', e); });
}

// 抓取资料卡（复制自 L1798）
export function refreshAccountCard(silent) {
  if (!silent) toast('正在抓取账号资料卡…');
  return fetch('/api/console/account/refresh', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (j.ok && j.account) {
        acctState.account = j.account;
        acctState.places = j.account.places || [];
        renderAccount(j.account);
        renderAcctCard(j.account.profileCard);
        if (!silent) toast('资料卡已更新', true);
      } else {
        if (!silent) toast('抓取失败：' + (j.err || '窗口可能未打开'), false);
        renderAcctCard(null, j.err);
      }
    }).catch(function(e) {
      if (!silent) toast('抓取失败：' + e.message, false);
      renderAcctCard(null, e.message);
    });
}

// 资料卡渲染（复制自 L1820）
export function renderAcctCard(card, err) {
  var body = document.getElementById('acctCardBody');
  var sub = document.getElementById('acctCardSub');
  if (!body) return;
  if (!card) {
    body.innerHTML = '<div class="empty">' + esc(err || '暂无资料卡（比特浏览器窗口未打开时无法抓取）') + '</div>';
    if (sub) sub.textContent = '';
    return;
  }
  if (sub) sub.textContent = card.fetchedAt ? ('抓取于 ' + String(card.fetchedAt).slice(0, 19).replace('T', ' ')) : '';
  var html = '';
  var top = [];
  if (card.nickname) top.push({ k: '昵称', v: card.nickname, hl: true });
  if (card.ageNum) top.push({ k: '年龄', v: card.ageNum + '岁', hl: false });
  if (card.region) top.push({ k: '现居', v: card.region, hl: true });
  if (card.birthplace) top.push({ k: '出身', v: card.birthplace, hl: true });
  if (card.onlineText) top.push({ k: '在线', v: card.onlineText, hl: false });
  if (top.length) html += '<div class="pf-top">' + top.map(function(t) {
    return '<div class="pf-top-row' + (t.hl ? ' hl' : '') + '"><span class="pk">' + t.k + '</span><span class="pv">' + esc(t.v) + '</span></div>';
  }).join('') + '</div>';
  var byGroup = card.byGroup || {};
  var ORDER = ['基本情報', '見た目', '大人の交際', '生活', 'お相手に望むこと'];
  var gs = ORDER.filter(function(g) { return byGroup[g] && byGroup[g].length; })
    .concat(Object.keys(byGroup).filter(function(g) { return ORDER.indexOf(g) === -1 && byGroup[g].length; }));
  html += gs.map(function(g) {
    return '<div class="pf-group"><div class="pf-group-title">' + esc(g) + '</div>' +
      byGroup[g].map(function(f) {
        return '<div class="pf-row"><span class="pk">' + esc(f.label) + '</span><span class="pv">' + prettyFields(f.key, f.value) + '</span></div>';
      }).join('') + '</div>';
  }).join('');
  if (!html) html = '<div class="empty">资料卡为空（字段未解析到）</div>';
  body.innerHTML = html;
}

// 打开资料卡（复制自 L1854）
export function openAcctCard() {
  document.getElementById('acctCardModal').style.display = 'flex';
  var card = acctState.account && acctState.account.profileCard;
  if (card) renderAcctCard(card);
  else { renderAcctCard(null); refreshAccountCard(false); }
}

// 账号行渲染（复制自 L1861）
export function renderAccount(a) {
  var host = document.getElementById('acctRows');
  if (!host) return;
  var autoTag = function(isAuto) { return isAuto ? '<span class="auto-tag">自动</span>' : '<span class="auto-tag">已改</span>'; };
  var rows = [];
  rows.push('<div class="acct-row"><span class="k">窗口</span><span class="v"><span class="acct-win">🪟 ' + esc(a.window || '—') + '</span></span></div>');
  rows.push('<div class="acct-row"><span class="k">平台</span><span class="v">' + esc(a.platform || '—') + '</span></div>');
  rows.push('<div class="acct-row"><span class="k">昵称</span><span class="v' + (a.nicknameIsAuto ? ' auto' : '') + '">' + (esc(a.nickname) || '—') + autoTag(a.nicknameIsAuto) + '</span></div>');
  rows.push('<div class="acct-row"><span class="k">资料</span><span class="v' + (a.profileIsAuto ? ' auto' : '') + '">' + (esc(a.profile) || '—') + autoTag(a.profileIsAuto) + '</span></div>');
  var card = a.profileCard;
  if (card) {
    if (card.region) rows.push('<div class="acct-row"><span class="k">现居</span><span class="v">' + esc(card.region) + '</span></div>');
    if (card.birthplace) rows.push('<div class="acct-row"><span class="k">出身</span><span class="v">' + esc(card.birthplace) + '</span></div>');
  }
  host.innerHTML = rows.join('');
  renderPlaces(acctState.places);
}

// 地点列表渲染（复制自 L1880）
export function renderPlaces(places) {
  var host = document.getElementById('placeList');
  if (!host) return;
  if (!places || !places.length) { host.innerHTML = '<div class="empty">还没有地址，点 ＋ 添加</div>'; return; }
  host.innerHTML = places.map(function(p, i) {
    return '<div class="place-card" data-idx="' + i + '" title="点击复制地址">' +
      '<div class="pl-acts">' +
        '<button data-pact="edit" data-idx="' + i + '">改</button>' +
        '<button data-pact="del" data-idx="' + i + '">删</button>' +
      '</div>' +
      (p.label ? '<div class="pl-label">' + esc(p.label) + '</div>' : '') +
      '<div class="pl-addr">' + esc(p.address || '') + '</div>' +
      (p.note ? '<div class="pl-note">' + esc(p.note) + '</div>' : '') +
    '</div>';
  }).join('');
  Array.prototype.forEach.call(host.querySelectorAll('.place-card'), function(card) {
    card.addEventListener('click', function(e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-pact');
      var idx = +card.getAttribute('data-idx');
      if (act === 'edit') { e.stopPropagation(); openPlaceModal(idx); return; }
      if (act === 'del') { e.stopPropagation(); deletePlace(idx); return; }
      copyText(acctState.places[idx].address || '', '地址已复制');
    });
  });
}

// 保存地点（复制自 L1906）
export function savePlaces(places, okMsg) {
  return fetch('/api/console/account/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ places: places })
  }).then(function(r) { return r.json(); }).then(function(j) {
    if (j.ok && j.account) {
      acctState.account = j.account;
      acctState.places = j.account.places || [];
      renderPlaces(acctState.places);
      toast(okMsg || '已保存', true);
    } else toast(j.msg || '保存失败', false);
  }).catch(function(e) { console.warn('[accounts] 保存地点失败', e); toast('保存失败', false); });
}

// 删地点（复制自 L1920）
export function deletePlace(idx) {
  var p = acctState.places[idx];
  if (!p) return;
  if (!confirm('删除地址「' + (p.label || p.address || '') + '」？')) return;
  var next = acctState.places.slice();
  next.splice(idx, 1);
  savePlaces(next, '地址已删除');
}

// 开地点弹窗（复制自 L1929）
export function openPlaceModal(idx) {
  acctState.editingPlaceId = (idx == null) ? null : idx;
  var p = (idx == null) ? { label: '', address: '', note: '' } : acctState.places[idx];
  document.getElementById('placeModalTitle').textContent = (idx == null) ? '📍 新增见面地址' : '📍 编辑见面地址';
  document.getElementById('placeLabel').value = p.label || '';
  document.getElementById('placeAddress').value = p.address || '';
  document.getElementById('placeNote').value = p.note || '';
  document.getElementById('btnPlaceDelete').style.display = (idx == null) ? 'none' : '';
  document.getElementById('placeModal').style.display = 'flex';
}

// 关地点弹窗（复制自 L1939）
export function closePlaceModal() { document.getElementById('placeModal').style.display = 'none'; }

// 保存地点表单（复制自 L1941）
export function savePlaceForm() {
  var label = document.getElementById('placeLabel').value.trim();
  var address = document.getElementById('placeAddress').value.trim();
  var note = document.getElementById('placeNote').value.trim();
  if (!address) { toast('请填写地址', false); return; }
  var next = acctState.places.slice();
  if (acctState.editingPlaceId == null) next.push({ label: label, address: address, note: note });
  else next[acctState.editingPlaceId] = Object.assign({}, next[acctState.editingPlaceId], { label: label, address: address, note: note });
  closePlaceModal();
  savePlaces(next, '地址已保存');
}

// 开账号弹窗（复制自 L1954）
export function openAcctModal() {
  var a = acctState.account || {};
  document.getElementById('acctAutoNick').textContent = a.nickname || '—';
  document.getElementById('acctAutoProf').textContent = a.profile || '—';
  document.getElementById('acctNickInput').value = a.nicknameIsAuto ? '' : (a.nickname || '');
  document.getElementById('acctProfInput').value = a.profileIsAuto ? '' : (a.profile || '');
  document.getElementById('acctModal').style.display = 'flex';
}

// 关账号弹窗（复制自 L1962）
export function closeAcctModal() { document.getElementById('acctModal').style.display = 'none'; }

// 保存账号表单（复制自 L1964）
export function saveAcctForm() {
  var nick = document.getElementById('acctNickInput').value.trim();
  var prof = document.getElementById('acctProfInput').value.trim();
  fetch('/api/console/account/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nicknameOverride: nick, profileOverride: prof })
  }).then(function(r) { return r.json(); }).then(function(j) {
    if (j.ok && j.account) {
      acctState.account = j.account;
      acctState.places = j.account.places || [];
      renderAccount(j.account);
      closeAcctModal();
      toast('账号信息已保存', true);
    } else toast(j.msg || '保存失败', false);
  }).catch(function(e) { console.warn('[accounts] 保存账号失败', e); toast('保存失败', false); });
}

// 绑定账号事件（复制自 L2132；常用语跨模块走 window 保护）
export function bindAccountEvents() {
  var g = function(id) { return document.getElementById(id); };
  if (g('btnEditAccount')) g('btnEditAccount').addEventListener('click', openAcctModal);
  if (g('btnAccountCard')) g('btnAccountCard').addEventListener('click', openAcctCard);
  if (g('btnAcctCardClose')) g('btnAcctCardClose').addEventListener('click', function() { g('acctCardModal').style.display = 'none'; });
  if (g('btnAcctCardRefresh')) g('btnAcctCardRefresh').addEventListener('click', function() { refreshAccountCard(false); });
  if (g('btnAcctSave')) g('btnAcctSave').addEventListener('click', saveAcctForm);
  if (g('btnAcctCancel')) g('btnAcctCancel').addEventListener('click', closeAcctModal);
  if (g('btnAddPlace')) g('btnAddPlace').addEventListener('click', function() { openPlaceModal(null); });
  if (g('btnPlaceSave')) g('btnPlaceSave').addEventListener('click', savePlaceForm);
  if (g('btnPlaceCancel')) g('btnPlaceCancel').addEventListener('click', closePlaceModal);
  if (g('btnPlaceDelete')) g('btnPlaceDelete').addEventListener('click', function() {
    var i = acctState.editingPlaceId;
    closePlaceModal();
    if (i != null) deletePlace(i);
  });
  // 常用语（跨模块 phrases.js：走 window 桥，未迁移时 undefined 保护）
  if (g('btnAddPhrase')) g('btnAddPhrase').addEventListener('click', function() { openPhraseModal(null); });
  if (g('btnPhraseSave')) g('btnPhraseSave').addEventListener('click', savePhraseForm);
  if (g('btnPhraseCancel')) g('btnPhraseCancel').addEventListener('click', closePhraseModal);
  if (g('btnPhraseDelete')) g('btnPhraseDelete').addEventListener('click', function() {
    deletePhrase(acctState.editingPhraseId);
  });
  ['acctModal', 'placeModal', 'phraseModal', 'acctCardModal'].forEach(function(id) {
    var m = g(id);
    if (m) m.addEventListener('click', function(e) { if (e.target === m) m.style.display = 'none'; });
  });
}

// 过渡桥接（第 7 刀保留，第 8 刀删）