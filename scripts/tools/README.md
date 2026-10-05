# scripts/tools — 窗口 17098 DevTools 注入调试脚本

本目录存放针对「Ai SAY」窗口（window id 17098）的**一次性 DevTools 注入调试脚本**。

- 这些 `.js` 脚本原本位于仓库 `src/` 下，是开发/调试期间通过 DevTools `Runtime.evaluate` 等机制注入到 17098 窗口执行的临时脚本，**不属于应用运行时依赖**。
- 对应说明文档见 `docs/tools/`（`click_mypage_17098.md`、`profile_17098_fields.md`、`show_profile_17098_fields.md`）。
- 这些脚本为一次性调试用途，可能随 17098 窗口的功能变更而过期；修改前请先核对目标页面的实际 DOM 结构。

文件清单（9 个）：

| 脚本 | 用途 |
| --- | --- |
| `click_mypage_17098.js` | 点击 mypage 页面元素 |
| `doc_click_mypage_17098.js` | 基于 document 直接定位并点击 mypage 元素 |
| `inspect_profile_button_17098.js` | 检查/定位 profile 按钮 |
| `open_messages_17098.js` | 打开消息列表 |
| `open_profile_17098.js` | 打开个人资料页 |
| `open_profile_from_mypage_17098.js` | 从 mypage 跳转到个人资料页 |
| `read_mypage_17098.js` | 读取 mypage 页面数据 |
| `read_profile_17098.js` | 读取个人资料数据 |
| `scroll_profile_17098.js` | 滚动个人资料页 |

> 注意：`server/` 与 `public/` 目录未改动。
