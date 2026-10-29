@echo off
setlocal
title Ai SAY Console (pm2 guarded)
cd /d "I:\deepseek\Ai SAY"

echo ======================================
echo   Ai SAY Console (pm2 guarded)
echo   crash auto-restart + memory guard
echo   http://127.0.0.1:8300/ichigo-console
echo   NOTE: guard protects server process only;
echo   BitBrowser windows (18585 etc) are manually controlled.
echo ======================================

rem ---- install pm2 if missing ----
if not exist "node_modules\.bin\pm2.cmd" (
  echo   [installing pm2...]
  call npm i -D pm2
)

rem ---- clean up stale state: stop pm2 first, then kill 8300 leftovers ----
call node_modules\.bin\pm2.cmd stop ai-say >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8300 ^| findstr LISTENING') do (
  echo   Cleaning 8300 leftover PID %%a ...
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 >nul

rem ---- start pm2 guard ----
call node_modules\.bin\pm2.cmd start ecosystem.config.js
call node_modules\.bin\pm2.cmd save

echo.
echo   status:   node_modules\.bin\pm2.cmd monit
echo   logs:     node_modules\.bin\pm2.cmd logs ai-say
echo   restart:  node_modules\.bin\pm2.cmd restart ai-say
echo   stop:     stop-guarded.bat  (do NOT use stop-console directly)
pause