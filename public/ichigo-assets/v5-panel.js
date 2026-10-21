// 第 9 刀 · v5 画像库纵向切片（前端渲染 + 写入闭环）
// 职责：选客户 → 拉 /v5/persona → 渲染「客户画像分析」下方的画像库面板 → 输入框写入 CustomerMemory → 刷新
// 设计：独立 module，不碰老 ichigo.js；由 main.js 在 initMain() 里接线（DOMContentLoaded 后）
'use strict';

// FastAPI 基址（CORS 已开；同源部署可改空串）
const V5_API = 'http://127.0.0.1:8400';
const currentPlatform = () => {
  try {
    const v = localStorage.getItem('aisay:platform:v1');
    return (v === 'kairaku') ? 'kairaku' : 'ikuru';
  } catch (e) { return 'ikuru'; }
};

function el(id) { return document.getElementById(id); }

// 渲染单个记忆碎片
function memHtml(m) {
  const time = (m.createdAt || '').replace('T', ' ').slice(0, 19);
  return '<div class="v5-mem"><span class="v5-mem-type">' + (m.memType || m.type || 'note') +
    '</span><span class="v5-mem-content">' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) +
    '</span><span class="v5-mem-src">来源 ' + (m.source || '?') + '</span>' +
    '<div class="v5-mem-time">' + time + '</div></div>';
}

// 读 persona + 双层记忆，渲染面板
export function loadV5Panel(contactId) {
  var sec = el('v5Section');
  var mem = el('v5Memories');
  var pmem = el('v5PersonaMemories');
  var sum = el('v5PersonSummary');
  if (!sec || !contactId) return;
  sec.style.display = 'block';
  if (mem) mem.innerHTML = '<div class="v5-loading">加载中…</div>';
  if (pmem) pmem.innerHTML = '<div class="v5-loading">加载中…</div>';
  if (sum) sum.textContent = '加载中…';

  fetch(V5_API + '/v5/persona?contactId=' + encodeURIComponent(contactId) + '&platformId=' + currentPlatform())
    .then(function(r) { return r.json(); })
    .then(function(p) {
      if (!p) return;
      // 人设摘要
      if (sum) {
        var name = p.displayName || contactId;
        var stage = p.relationshipStage || 'new';
        sum.innerHTML = '平台身份 ' + (p.platformUid || p.platformId) + ' · ' + name +
          ' <span class="stage">' + stage + '</span>';
      }
      // 物理人级记忆
      if (mem) {
        var list = (p.memories || []);
        mem.innerHTML = list.length
          ? list.map(memHtml).join('')
          : '<div class="v5-empty">（暂无物理人级记忆碎片）</div>';
      }
      // 人设级记忆
      if (pmem) {
        var plist = (p.persona_memories || []);
        pmem.innerHTML = plist.length
          ? plist.map(function(m) { return memHtml(m); }).join('')
          : '<div class="v5-empty">（暂无人设级记忆）</div>';
      }
    })
    .catch(function(e) {
      if (mem) mem.innerHTML = '<div class="v5-err">画像库拉取失败：' + e.message + '</div>';
      if (pmem) pmem.innerHTML = '';
      if (sum) sum.textContent = '';
    });
}

// 写入一条 CustomerMemory → 刷新本客户记忆
export function addV5Memory(contactId) {
  var ta = el('v5NewMemContent');
  var typeEl = el('v5NewMemType');
  var btn = el('v5AddMemBtn');
  if (!ta || !contactId) return;
  var content = String(ta.value || '').trim();
  if (!content) { if (ta) ta.focus(); return; }
  var memType = typeEl ? (typeEl.value || 'note') : 'note';

  if (btn) { btn.disabled = true; btn.textContent = '存入中…'; }
  fetch(V5_API + '/v5/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contactId: contactId, memType: memType, content: content,
      source: 'manual', confidence: 0.5,
    })
  })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (btn) { btn.disabled = false; btn.textContent = '＋ 存入'; }
      if (ta) ta.value = '';
      // 立即重拉刷新
      loadV5Panel(contactId);
    })
    .catch(function(e) {
      if (btn) { btn.disabled = false; btn.textContent = '＋ 存入'; }
      if (typeof toast === 'function') toast('存入失败：' + e.message, false);
    });
}

// 选客户钩子：main.js 在 selectCustomer 后调
export function bindV5Panel() {
  var btn = el('v5AddMemBtn');
  if (btn) btn.addEventListener('click', function() {
    var c = (typeof state !== 'undefined' && state && state.selectedId) ? state.selectedId : null;
    addV5Memory(c);
  });
  // Enter 提交（Shift+Enter 换行）
  var ta = el('v5NewMemContent');
  if (ta) ta.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); btn && btn.click(); }
  });
}
