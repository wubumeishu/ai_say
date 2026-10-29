@echo off
setlocal
title Ai SAY Console Stop
cd /d "I:\deepseek\Ai SAY"

echo Stopping Ai SAY console on port 8300 ...

rem ---- critical: stop pm2 guard first, otherwise taskkill triggers autorestart ----
if exist "node_modules\.bin\pm2.cmd" (
  echo   Stopping pm2 guard ai-say ...
  call node_modules\.bin\pm2.cmd stop ai-say >nul 2>&1
)

rem ---- kill leftover 8300 processes (pm2 already stopped, no auto-restart) ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8300 ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
  echo   Stopped PID %%a
)
echo Done.
echo   Note: guard protects server process only; BitBrowser windows are NOT auto opened/closed.
timeout /t 2 >nul