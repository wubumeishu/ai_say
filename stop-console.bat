@echo off
setlocal
title Ai SAY Console Stop
echo Stopping Ai SAY console on port 8300 ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8300 ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
  echo   Stopped PID %%a
)
echo Done.
timeout /t 2 >nul
