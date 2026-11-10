// 杀掉 8300 端口残留的 Ai SAY 服务进程(供 start-watch.bat 启动前清理, 免 bat 管道转义陷阱)
'use strict';
const { execSync } = require('child_process');
try {
  const out = execSync('netstat -ano 2>nul').toString();
  out.split(/\r?\n/).forEach(function (l) {
    if (l.indexOf(':8300') === -1 || l.indexOf('LISTENING') === -1) return;
    var p = l.trim().split(/\s+/).pop();
    if (!p || p === '0') return;
    try { execSync('taskkill /F /PID ' + p); } catch (e) { /* 已退/权限, 忽略 */ }
  });
} catch (e) { /* netstat 不可用则跳过 */ }
