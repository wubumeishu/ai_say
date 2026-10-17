// 第二刀 · theme.js（主题切换，复制自 ichigo-console.html L739-763）
'use strict';

var THEME_KEY = 'aisay-theme';

export function getTheme() {
  try { var t = localStorage.getItem(THEME_KEY); if (t === 'light' || t === 'dark') return t; } catch (e) { console.warn('[theme] 读取失败', e); }
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

export function applyTheme(t, animate) {
  var theme = (t === 'light') ? 'light' : 'dark';
  var root = document.documentElement;
  if (animate) {
    root.classList.add('theme-anim');
    setTimeout(function() { root.classList.remove('theme-anim'); }, 260);
  }
  root.setAttribute('data-theme', theme);
  var ic = document.getElementById('themeIcon');
  var lb = document.getElementById('themeLabel');
  if (ic) ic.textContent = (theme === 'light') ? '☀️' : '🌙';
  if (lb) lb.textContent = (theme === 'light') ? '白天' : '黑夜';
  var btn = document.getElementById('themeToggle');
  if (btn) btn.title = (theme === 'light') ? '当前：白天（点击切到黑夜）' : '当前：黑夜（点击切到白天）';
}

export function toggleTheme() {
  var next = (getTheme() === 'light') ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { console.warn('[theme] 保存失败', e); }
  applyTheme(next, true);
}

// 第 8 刀收口：theme 模块导出挂 globalThis.__AISAY__.theme 的过渡桥接已拆除