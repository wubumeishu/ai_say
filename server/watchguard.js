// Ai SAY · 文件热重载守护(免 pm2, Node 原生)
// 职责: ① 监听 server/ 目录代码变动 → 优雅重启服务子进程(不用手动重启)
//       ② 子进程崩溃 → 自动拉起(带指数退避, 10 次后停手交人工)
// 用法: node server/watchguard.js   (start-watch.bat 调这个, 替代 start-console.bat 的前台 node)
// 注意: 只监听 server/ 后端代码; 前端 public/ 改动仍需 Ctrl+Shift+R(浏览器缓存), 不触发服务重启
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WATCH_DIRS = [path.join(ROOT, 'server')];
const ENTRY = path.join(__dirname, 'index.js');
const RESTART_DELAY_MS = 800;
const MAX_CRASH_RESTARTS = 10;
const BACKOFF_BASE_MS = 1000;

let child = null;
let stopping = false;
let crashStreak = 0;          // 连续崩溃计数(正常 file-change 重启不算)
let debounce = null;         // 文件变动防抖(编辑器写文件常触发多次)

function log(...a) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log('[watchguard ' + t + '] ' + a.join(' '));
}

function startChild() {
  log("starting service child: node server/index.js");
  child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write('[server] ' + d));
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) { log("service stopped (stopping), guard exiting"); process.exit(0); }
    // 崩溃 → 自动拉起(带退避)
    crashStreak++;
    if (crashStreak > MAX_CRASH_RESTARTS) {
      log("crash streak " + crashStreak + " > " + MAX_CRASH_RESTARTS + ", stopping guard for manual check");
      process.exit(1);
    }
    const backoff = BACKOFF_BASE_MS * Math.pow(1.5, crashStreak - 1);
    log("child exited (code=" + code + ", signal=" + signal + "), auto-restart in " + Math.round(backoff) + "ms (crash #" + crashStreak + ")");
    setTimeout(startChild, Math.min(backoff, 30000));
  });
  // 正常 startChild(非崩溃)重置连续崩溃计数
  crashStreak = 0;
}

// 监听 server/ 递归文件变动 → 防抖重启
function watchAll() {
  WATCH_DIRS.forEach(dir => {
    try {
      const w = fs.watch(dir, { recursive: true }, (evt, fname) => {
        // 只关心 .js/.json 变动(忽略 .db/缓存/日志)
        if (!/.\.(js|json)$/i.test(String(fname))) return;
        if (stopping) return;
        log("file change: " + fname + " -> restart service in " + RESTART_DELAY_MS + "ms");
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(restart, RESTART_DELAY_MS);
      });
      w.on('error', e => log('fs.watch ' + dir + ' 错误: ' + e.message));
    } catch (e) {
      log('监听 ' + dir + ' 失败: ' + e.message);
    }
  });
}

function restart() {
  if (!child || stopping) return;
  log("file change -> hot-reload (graceful restart)...");
  // 先发 SIGTERM 走 index.js 的优雅退出路径, 超时才强杀
  try { child.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => {
    if (child) { try { child.kill('SIGKILL'); } catch (_) {} }
  }, 5000);
  // 等子进程退出后(exit 事件里 stopping=true 会直接退, 所以这里手动重拉)
  setTimeout(startChild, 1500);
}

process.on('SIGINT', () => { stopping = true; try { if (child) child.kill('SIGTERM'); } catch (_) {} log("Ctrl+C received, stopping guard"); });
process.on('SIGTERM', () => { stopping = true; try { if (child) child.kill('SIGTERM'); } catch (_) {} });

log("Ai SAY hot-reload guard started");
log("watching: " + WATCH_DIRS.join(", "));
log("public/ changes still need Ctrl+Shift+R in browser; no service restart");
startChild();
watchAll();
