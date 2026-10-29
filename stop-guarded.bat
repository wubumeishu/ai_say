@echo off
setlocal
title Ai SAY Console (pm2 guarded) - Stop
cd /d "I:\deepseek\Ai SAY"

echo ======================================
echo   Stop pm2 guard (ai-say)
echo   - stops server process only
echo   - does NOT touch BitBrowser windows
echo   - windows (18585 etc) remain manually controlled
echo ======================================

if not exist "node_modules\.bin\pm2.cmd" (
  echo   [pm2 not installed] run start-guarded.bat first
  pause
  exit /b 1
)

rem ---- stop the pm2 guard ----
call node_modules\.bin\pm2.cmd stop ai-say
echo.
echo   Stopped. To re-guard: start-guarded.bat
echo   To fully delete pm2 record: node_modules\.bin\pm2.cmd delete ai-say
echo   Check status: node_modules\.bin\pm2.cmd list
pause