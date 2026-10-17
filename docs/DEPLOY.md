# Ai SAY · 部署与使用手册

> 面向运营者（非程序员）。详细接口见 [API.md](API.md)，开发契约见 [../AGENTS.md](../AGENTS.md)。

## 1. 运行环境

| 组件 | 要求 |
|---|---|
| 操作系统 | Windows（bat 脚本必须 CRLF 换行） |
| Node.js | 项目按 Node 24 开发 |
| 比特浏览器 | 客户端已启动，本地 API 开在 54345 或 54346 |
| 出会窗口 | 已登录的出会平台窗口（windowId 写进 settings.json） |
| LLM 模型 | ollama 或兼容 OpenAI 的接口（settings.json 的 model / models） |

## 2. 首次部署

1. 克隆仓库：`git clone https://github.com/wubumeishu/ai_say`（数据与密钥不在库里）。
2. 安装依赖：`npm install`（依赖仅 ws）。
3. 复制配置模板：`settings.example.json` → `settings.json`，填写：
   - `apiBase` / `bitBrowserApiPort`：比特浏览器 API 地址；
   - `windowId`：出会窗口 id（如 2315e879dd6642559bdc11a07bb1fc43，自用勿删）；
   - `model`：provider / baseUrl / model / apiKey（**apiKey 勿提交**）。
4. 启动：双击 `start-console.bat`。看到
   `Ai SAY 控制台: http://127.0.0.1:8300/` 即成功。
5. 打开 http://127.0.0.1:8300/ichigo-console。

## 3. 日常使用（窗口行为约定）

1. 打开主控制台 → 页头 netChip 显示网络体检结果；异常先点「换 IP」。
2. 左栏客户列表自动轮询收件箱（30 分钟一次）；点客户卡片进入该客户聊天页，
   才会同步抓取历史/资料。
3. 中栏看客户消息（日文原文 + 中文翻译）；右栏 Ai SAY 面板自然语言提问。
4. 需要发消息时：让助手/话术引擎出建议 → 你点确认卡片 → 系统才真发。
5. 所有操作的最终步骤 = 返回收件箱页 + 查是否有新消息；有新消息显示 new。

## 4. 运维要点

- **停服务**：stop-console.bat，或在启动窗口 Ctrl+C（SIGTERM/SIGINT 优雅退出）。
- **服务偶发退出**（8300 ECONNREFUSED）：重启即可；crash 自重启守护尚未做（规划中）。
- **CDP 偶发超时**（send-live 返回 reason=send-failed）：重试就好；自动重连 + 重试
  属 Phase 3。
- **换 IP**：页头「换 IP」按钮 = 先 dryRun 确认槽位 → 执行 → 15s 后自动体检。
  代理池规则：90 分钟粘性、30 分钟冷却、事件驱动（不做定时轮换，避免平台风控）。
- **日志/自动化信息**：规划中的「看板」菜单（Phase 4），目前看 console 输出。

## 5. 数据与备份

- 数据库：data/aisay.db（客户画像/会话/规则/LeadEvent）；缓存：data/console-cache.json。
- 备份在 backups/。删除 data/ 里任何 .db 或根目录调试脚本前，先征得运营者同意。
- 客户数据含隐私（画像/消息），**任何情况下不进 Git、不外发**。

## 6. 排障速查（现象 → 先怀疑被吞的错误）

| 现象 | 先查 |
|---|---|
| 没报错但没效果 | 对应路径的 catch 是否把异常吞了（项目有 43 处空 catch 历史） |
| 推荐回复恒空 | recommender 写 LeadEvent 漏传 score → SQLite 绑定 undefined 抛错 |
| 确认发送遇频控规则必 500 | talkEngine.checkGate 未传 limits，Object.assign 崩 |
| 指标趋势线恒空 | db.prepare(sql, since) 把 since 当 options 抛错被吞 |
| 画像存不住 | INSERT OR REPLACE 把 age/region/height 清成 null（已规划 ON CONFLICT + COALESCE） |
| A/B 恒 B | sha1 hex 串 % 2 = NaN |
| 重启后频控限额被绕过 | 频控账本仅内存（sentLog/pushLedger/pendingQueue 重启清零） |
| /api/* 与 /api/console/* 数据对不上 | 双存储：旧轨 JSON、控制台 SQLite，数据分叉（待统一） |
| 8300 ECONNREFUSED | 服务进程退出了，重启 |

## 7. 测试

```bash
# 全量 16 个测试文件（npm test 只跑其中 4 个）
node --test tests/*.test.js \
  server/db/recommender.test.js server/db/recommender.live.test.js \
  server/db/leadScoring.test.js server/db/dedup.test.js server/db/profileExtractor.test.js \
  server/acquisition/talkEngine.test.js
```

修复代码级 bug 时：先写复现测试 → 修 → 跑全量给前后对比。
真发相关改动只做只读验证（抓历史/查缓存），不真发测试。
