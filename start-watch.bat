@echo off
setlocal
title Ai SAY Console (hot-reload guard)
cd /d "I:\deepseek\Ai SAY"

echo ======================================
echo   Ai SAY Console - hot-reload guard
echo   http://127.0.0.1:8300/ichigo-console
echo   server/ code changed  -> auto reload (no manual restart)
echo   public/ changed       -> still Ctrl+Shift+R in browser
echo   crash                 -> auto restart (backoff)
echo   Ctrl+C / close window = stop
echo ======================================

rem ---- stop old 8300 instance + pm2 guard (avoid port clash / double run) ----
if exist "node_modules\.bin\pm2.cmd" call node_modules\.bin\pm2.cmd stop ai-say >nul 2>&1
node kill8300.js
timeout /t 1 >nul

rem ---- start hot-reload guard (foreground, logs visible, Ctrl+C to stop) ----
node server\watchguard.js

echo.
echo Guard stopped.
pause