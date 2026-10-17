// 第七刀 · phrases.js（常用语管理，复制自 ichigo-console.html L1994-2107）
// 依赖：util.js(esc/toast) + ichigo.js(translateAll 跨模块保护) + accounts.js(acctState 跨模块保护)
// 无循环：phrases → ichigo / accounts 单向（accounts.js 对 phrases 也走 window 保护，运行时互不 import）
'use strict';
import { esc, toast } from './util.js';

// 读 accounts.js 的 acctState（第 8 刀收口：直接 import，无 window 桥）
import { acctState as accountsAcctState } from './accounts.js';
function getAcctState() {
  return accountsAcctState;
}

// 加载常用语（复制自 L1994）
export function loadPhrases() {
  return fetch('/api/console/phrases').then(function(r) { return r.json(); }).then(function(j) {
    if (!j.ok) return;
    var s = getAcctState();
    s.phrases = j.phrases || [];
    s.groups = j.groups || [];
    renderPhraseTabs();
    renderPhrases();
  }).catch(function(e) { console.warn('phrases load failed', e); });
}

// 分组 tab 渲染（复制自 L2004）
export function renderPhraseTabs() {
  var host = document.getElementById('phraseTabs');
  if (!host) return;
  var s = getAcctState();
  var counts = {};
  s.phrases.forEach(function(p) { var g = p.group || '未分组'; counts[g] = (counts[g] || 0) + 1; });
  var tabs = ['<button class="ptab' + (s.activeGroup === '__all__' ? ' on' : '') + '" data-g="__all__">全部 ' + s.phrases.length + '</button>'];
  s.groups.forEach(function(g) {
    tabs.push('<button class="ptab' + (s.activeGroup === g ? ' on' : '') + '" data-g="' + esc(g) + '">' + esc(g) + ' ' + (counts[g] || 0) + '</button>');
  });
  host.innerHTML = tabs.join('');
  Array.prototype.forEach.call(host.querySelectorAll('.ptab'), function(b) {
    b.addEventListener('click', function() {
      s.activeGroup = b.getAttribute('data-g');
      renderPhraseTabs(); renderPhrases();
    });
  });
  var dl = document.getElementById('phGroupList');
  if (dl) dl.innerHTML = s.groups.map(function(g) { return '<option value="' + esc(g) + '">'; }).join('');
}

// 常用语列表渲染（复制自 L2025；点击填入输入框 + 批量翻译）
export function renderPhrases() {
  var host = document.getElementById('phraseList');
  if (!host) return;
  var s = getAcctState();
  var list = s.phrases.filter(function(p) {
    return s.activeGroup === '__all__' || (p.group || '未分组') === s.activeGroup;
  });
  if (!list.length) { host.innerHTML = '<div class="empty">该分组下没有常用语</div>'; return; }
  host.innerHTML = list.map(function(p) {
    return '<div class="phrase-card" data-id="' + esc(p.id) + '" title="点击填入消息输入框">' +
      '<div class="pc-acts">' +
        '<button data-pact="edit" data-id="' + esc(p.id) + '">改</button>' +
        '<button data-pact="del" data-id="' + esc(p.id) + '">删</button>' +
      '</div>' +
      '<div class="pc-group">' + esc(p.group || '') + '</div>' +
      '<div class="pc-text">' + esc(p.text || '') + '</div>' +
      '<div class="text-zh pc-zh" data-src="' + esc(p.text || '') + '">翻译中…</div>' +
    '</div>';
  }).join('');
  Array.prototype.forEach.call(host.querySelectorAll('.phrase-card'), function(card) {
    card.addEventListener('click', function(e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-pact');
      var id = card.getAttribute('data-id');
      if (act === 'edit') { e.stopPropagation(); openPhraseModal(id); return; }
      if (act === 'del') { e.stopPropagation(); deletePhrase(id); return; }
      var ph = s.phrases.filter(function(x) { return x.id === id; })[0];
      if (!ph) return;
      var inp = document.getElementById('msgInput');
      if (inp) {
        inp.value = (inp.value ? inp.value.replace(/\s+$/, '') + ' ' : '') + ph.text;
        inp.focus();
        var sb = document.getElementById('btnSend'); if (sb) sb.disabled = false;
      }
      toast('已填入输入框');
      fetch('/api/console/phrases/use?id=' + encodeURIComponent(id), { method: 'POST' }).catch(function(e) { console.warn('[phrases] use 上报失败', e); });
    });
  });
  // 日语下方补中文译文（跨模块 translateAll 走 window 保护）
  var _ta = translateAll; // 第 8 刀收口：直接 import
  if (typeof _ta === 'function') _ta(host.querySelectorAll('.pc-zh'));
}

// 开常用语弹窗（复制自 L2064）
export function openPhraseModal(id) {
  var s = getAcctState();
  s.editingPhraseId = id || null;
  var ph = id ? s.phrases.filter(function(x) { return x.id === id; })[0] : null;
  document.getElementById('phraseModalTitle').textContent = id ? '💬 编辑常用语' : '💬 新增常用语';
  document.getElementById('phGroup').value = ph ? (ph.group || '') : (s.activeGroup !== '__all__' ? s.activeGroup : '');
  document.getElementById('phText').value = ph ? (ph.text || '') : '';
  document.getElementById('btnPhraseDelete').style.display = id ? '' : 'none';
  document.getElementById('phraseModal').style.display = 'flex';
  setTimeout(function() { var t = document.getElementById('phText'); if (t) t.focus(); }, 50);
}

// 关常用语弹窗（复制自 L2074）
export function closePhraseModal() { document.getElementById('phraseModal').style.display = 'none'; }

// 保存常用语（复制自 L2076）
export function savePhraseForm() {
  var s = getAcctState();
  var g = document.getElementById('phGroup').value.trim() || '未分组';
  var t = document.getElementById('phText').value.trim();
  if (!t) { toast('内容不能为空', false); return; }
  fetch('/api/console/phrases/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.editingPhraseId || undefined, group: g, text: t })
  }).then(function(r) { return r.json(); }).then(function(j) {
    if (j.ok) {
      s.phrases = j.phrases || [];
      s.groups = j.groups || [];
      closePhraseModal();
      renderPhraseTabs(); renderPhrases();
      toast(s.editingPhraseId ? '已保存' : '已新增常用语', true);
    } else toast(j.msg || '保存失败', false);
  }).catch(function(e) { console.warn('[phrases] 保存失败', e); toast('保存失败', false); });
}

// 删常用语（复制自 L2094）
export function deletePhrase(id) {
  var s = getAcctState();
  var ph = s.phrases.filter(function(x) { return x.id === id; })[0];
  if (!ph) return;
  if (!confirm('删除常用语？\n\n' + (ph.text || '').slice(0, 60))) return;
  fetch('/api/console/phrases/delete?id=' + encodeURIComponent(id), { method: 'POST' })
    .then(function(r) { return r.json(); }).then(function(j) {
      if (j.ok) {
        s.phrases = j.phrases || [];
        s.groups = j.groups || [];
        renderPhraseTabs(); renderPhrases();
        toast('已删除', true);
      } else toast(j.msg || '删除失败', false);
    }).catch(function(e) { console.warn('[phrases] 删除失败', e); toast('删除失败', false); });
}

// 过渡桥接（第 7 刀保留，第 8 刀删）