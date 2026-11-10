@echo off
setlocal
title Ai SAY Console (热重载守护)
cd /d "I:\deepseek\Ai SAY"

echo ======================================
echo   Ai SAY Console · 热重载守护
echo   http://127.0.0.1:8300/ichigo-console
echo   server/ 代码改动 → 自动重载(不用手动重启)
echo   前端 public/ 改动 → 仍需 Ctrl+Shift+R
echo   崩溃 → 自动拉起(带退避)
echo   Ctrl+C / 关窗口 = 停止
echo ======================================

rem ---- 先停掉旧的 8300 实例 + pm2 守护(防端口占用/双跑) ----
if exist "node_modules\.bin\pm2.cmd" (
  call node_modules\.bin\pm2.cmd stop ai-say >nul 2>&1
)
for /f "tokens=5" %%a in '(netstat -ano ^| findstr :8300 ^| findstr LISTENING)' do (
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 >nul

rem ---- 启动热重载守护(前台, 日志可见, Ctrl+C 停) ----
node server\watchguard.js

echo.
echo 守护已停止。
pause