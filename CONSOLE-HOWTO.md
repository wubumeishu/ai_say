# Ai SAY 控制台 · 启动说明

## 启动
双击 `start-console.bat`，会弹出黑色 cmd 窗口，看到 `Ai SAY 控制台: http://127.0.0.1:8300/` 即可。
- 控制台: http://127.0.0.1:8300/console
- 旧页面: http://127.0.0.1:8300/
- 停服务: 在那个 cmd 窗口按 Ctrl+C，或双击 `stop-console.bat`

## 比特浏览器 CDP
服务会监听 54345/54346 等比特浏览器 API；BitBrowser 没开时控制台仍可访问，平台数据会是空。

## 数据
SQLite: I:\deepseek\Ai SAY\data\aisay.db