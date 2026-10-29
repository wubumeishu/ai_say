@echo off
rem Ai SAY · 带 CDP 调试口启动 Chrome（供 LINE 扩展 CDP 驱动）
rem 用法：双击本文件；如果 Chrome 已在运行，会追加新窗口（不影响现有标签）
setlocal EnableExtensions

set CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe
set USER_DATA=C:\Users\Administrator\AppData\Local\Google\Chrome\User Data
set CDP_PORT=9222

rem 检查 9222 是否已被占用（若占用，说明已有带调试口的 Chrome）
netstat -ano | findstr :9222 | findstr LISTENING >nul
if %errorlevel%==0 (
  echo [OK] CDP port 9222 already listening. Chrome is running with debug port.
  goto :end
)

start "" "%CHROME_EXE%" --user-data-dir="%USER_DATA%" --remote-debugging-port=%CDP_PORT% --profile-directory=Default about:blank

echo [STARTED] Chrome with CDP debug port %CDP_PORT%.
echo [NEXT] Open the LINE extension in Chrome (click the extension icon), then ask the AI to read sessions.
:end
endlocal
