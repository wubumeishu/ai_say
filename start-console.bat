@echo off
setlocal
title Ai SAY Console
cd /d "I:\deepseek\Ai SAY"

echo ======================================
echo   Ai SAY Console
echo   http://127.0.0.1:8300/ichigo-console
echo ======================================

rem ---- 1) If an old instance is already listening on 8300, stop it first ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8300 ^| findstr LISTENING') do (
  echo   Stopping old instance PID %%a ...
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 >nul

rem ---- 2) Start the server in this window's foreground (logs stay visible; Ctrl+C stops it) ----
node server\index.js

rem ---- 3) Node exited -> don't vanish the window silently ----
echo.
echo Server stopped.
pause
