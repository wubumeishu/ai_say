// 第一刀 · util.js（工具函数，复制自 ichigo-console.html）
// 策略：先复制后分离——老内联同名 function 一字不动，本文件是并行 ES6 模块副本。
// 依赖：FIELD_ZH + state 从 state.js 导入（第 8 刀收口，无 window 桥）。
'use strict';
import { FIELD_ZH, state } from './state.js';

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

export function toast(msg, ok) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.background = ok ? '#2e7d32' : (ok === false ? '#c62828' : '#37474f');
  t.classList.add('show');
  clearTimeout(t.__timer);
  t.__timer = setTimeout(function() { t.classList.remove('show'); }, 2600);
}

export function fmtClock(d) {
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ' 已刷新';
}

// 第 8 刀收口：直接 import state（单一数据源，无 window 桥）
export function findContact(id) {
  var contacts = (state && Array.isArray(state.contacts)) ? state.contacts : [];
  for (var i = 0; i < contacts.length; i++) if (contacts[i].contactId === id) return contacts[i];
  return null;
}

export function firstChar(name) {
  var s = String(name || '').replace(/^[♂♀\s]+/, '');
  return s.charAt(0) || '?';
}

export function timeRank(t) {
  var m = String(t || '').match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  return ((+m[1]) * 31 + (+m[2])) * 10000 + (+m[3]) * 100 + (+m[4]);
}

export function copyText(text, okMsg) {
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() { toast(okMsg || '已复制'); },
        function() { fallbackCopy(text, okMsg); });
      return;
    }
  } catch (e) { console.warn('[copyText] clipboard 不可用', e); }
  fallbackCopy(text, okMsg);
}

export function fallbackCopy(text, okMsg) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(okMsg || '已复制');
  } catch (e) { toast('复制失败', false); }
}

export function hasJa(s) { return /[぀-ゟ゠-ヿ]/.test(String(s || '')); }

export function zhOf(key, val) {
  var m = FIELD_ZH[key];
  if (!m) return '';
  return m[val] || '';
}

export function prettyFields(key, val) {
  var zh = zhOf(key, val);
  return esc(val) + (zh && zh !== val ? '（' + zh + '）' : '');
}