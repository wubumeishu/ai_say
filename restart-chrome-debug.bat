@echo off
rem Ai SAY · 重启 Chrome 并带 CDP 调试口（解决 9222 端口静默绑定失败）
rem 用法：双击本文件；会先关闭所有 Chrome 窗口（未保存的网页状态会丢失，LINE 扩展登录态保留在 user-data-dir）
setlocal EnableExtensions

set CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe
set USER_DATA=C:\Users\Administrator\AppData\Local\Google\Chrome\User Data
set CDP_PORT=9222

echo [1/4] Closing all Chrome instances...
taskkill /F /IM chrome.exe >nul 2>&1
echo       Chrome killed.

echo [2/4] Waiting 3s for port 9222 to release...
ping -n 4 127.0.0.1 >nul

echo [3/4] Verifying port 9222 is free...
netstat -ano | findstr :9222 | findstr LISTENING >nul
if %errorlevel%==0 (
  echo [WARN] Port 9222 still in use. Retrying in 2s...
  ping -n 3 127.0.0.1 >nul
  netstat -ano | findstr :9222 | findstr LISTENING >nul
  if %errorlevel%==0 (
    echo [ERROR] Port 9222 is still occupied. Check what is using it:
    netstat -ano | findstr :9222
    pause
    goto :end
  )
)

echo [4/4] Starting Chrome with CDP debug port 9222...
start "" "%CHROME_EXE%" --user-data-dir="%USER_DATA%" --remote-debugging-port=%CDP_PORT% --profile-directory=Default about:blank

echo [OK] Chrome started with CDP debug port 9222.
echo [NEXT] Open the LINE extension in Chrome, then run:
echo       node "I:\deepseek\Ai SAY\server\adapter\lineExtensionAdapter.js" health
:end
endlocal
