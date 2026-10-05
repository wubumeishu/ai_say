# M2 平台适配器（adapter）

本目录实现 M2 跨平台聚合的适配层：**每个新平台只需实现 4 个方法契约 + 提供 locatorConfig（JSON），引擎/架构零改动。**

## 适配器清单（M2：≥3 平台全链路）

| 平台 | 文件 | 状态 | 说明 |
|---|---|---|---|
| 出会/Pappy/イククル | `ichigo194964.js` | ✅ 已验证 | 复用 17098 已验证选择器，真实 DOM 解析 |
| LINE OA | `line.js` | 占位 mock | M4 接 LINE 官方 API |
| Facebook | `facebook.js` | 占位 mock | M2 后续补真实 DOM 实现 |
| WhatsApp | `whatsapp.js` | 占位 mock | M2 后续补真实 DOM 实现 |

4 平台全部通过 `createAdapter` 工厂 + 注册表接入，满足 M2 验收「≥3 平台全链路跑通」的平台数量要求（全链路细节随各平台真实现落地）。

## 文件清单

| 文件 | 说明 |
|---|---|
| `platformAdapter.js` | 基类 + `createAdapter(platform, opts)` 工厂 + 注册表 |
| `ichigo194964.js` | 出会/Pappy/イククル（sp.194964.com）适配器，复用 17098 已验证选择器 |
| `line.js` | LINE OA 占位适配器（M4 接真实 API） |
| `facebook.js` | Facebook 占位适配器（mock，M2 后续补真实 DOM 实现） |
| `whatsapp.js` | WhatsApp 占位适配器（mock，M2 后续补真实 DOM 实现） |
| `adapters.test.js` | 4 平台 createAdapter 自检（断言子类 + 4 方法 + mock 返回） |
| `README.md` | 本文件 |

## 4 方法契约

| 方法 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `scanProfile()` | — | `{ ok, pageKey, url, accountPersona, customerProfile, probe, miss, scannedAt }` | 读当前页资料，返回 AccountPersona / CustomerProfile 字段槽（对齐 02 章 schema）；子类覆写 `parseProfile(probe, kind)` 做字段映射 |
| `scanMessages(conversationId)` | 会话 id | `{ ok, source, pageKey, conversationId, messages[], rows[], pagination, scannedAt }` | 读消息流；messages 每条含 `role / original / translation / time / kind / url`；translation 由 engine 填充 |
| `navigate(urlOrAction)` | URL 或 actionId | `{ ok, via, to, url, pageKey, action? }` | http/URL → 直接跳转；actionId → 查 `locatorConfig.actions`，按 steps 执行（href 优先，click 回退） |
| `send(text, {to})` | 文本 + 可选 to | `{ ok, mock, via, sentAt }` | 走 `locatorConfig.send`（input 选择器 + Enter/按钮）；合规闸门由 acquisition 前置 |

## 定位规则数据化（locatorConfig JSON）

所有 DOM 选择器存在 `locatorConfig`（可来自数据库/配置文件），**不写死在适配器代码里**。

### 结构

```jsonc
{
  "pages": {
    "inbox":   { "urlPattern": "sp\\.194964\\.com/mail" },
    "mypage":  { "urlPattern": "sp\\.194964\\.com/mypage\\.html" },
    "profile": { "urlPattern": "show_profile\\.html" }
  },
  "rules": {
    "<ruleId>": {
      "selectors": ["text|css", "css", "css||text", "..."],  // 定位字符串清单
      "minHits": 1,          // 至少命中数（默认 1）
      "missThreshold": 0,    // 命中率下限（0=不启用；>0 时 hits/total < 阈值触发告警）
      "appliesTo": ["inbox", "profile"]  // 适用 pageKey 清单（缺省=全部）
    }
  },
  "actions": {
    "<actionId>": {
      "steps": [
        { "rule": "<ruleId>", "strategy": "href" }  // href 优先；click 回退
      ]
    }
  },
  "send": {
    "input":  ["textarea.chat-input", "textarea[class*=input]"],
    "button": ["button.send", ".send-btn"],
    "key": "Enter"
  }
}
```

### 定位字符串语法

| 语法 | 含义 |
|---|---|
| `"css"` | 纯 CSS 选择器，命中 = 至少 1 个元素 |
| `"text|css"` | 在 css 范围内找 `innerText === text` 的元素；css 未命中时做全页精确文本探测 |
| `"css||text"` | 优先 css，css 失败时全页精确文本找首个含该文本的可交互元素 |

### 命中失败 → 告警事件

`probeRule(ruleId)` 每次探测后更新 `this.locatorStats`（ruleId → { hits, total, lastHits, at }）。
当命中数 < `minHits` 或命中率 < `missThreshold` 时：

1. `this.locatorMissCount += 1`
2. 调用 `this.emit('onLocatorMiss', { platform, ruleId, hits, total, threshold, minHits, url, probe })`

M5 健康面板直接拉 `adapter.locatorMissCount` 和 `adapter.locatorStats` 展示告警。

## 新增平台步骤（零改引擎/架构）

1. 新建 `server/adapter/<platform>.js`，继承 `PlatformAdapter`，覆写 `parseProfile` / `scanMessagesJs` 等需要的方法。
2. 在 `platformAdapter.js` 的 `registry` 加一行 + `createAdapter` switch 加一个 case。
3. 准备该平台的 `locatorConfig` JSON（可存库或配置文件），传入 `createAdapter(platform, { cdp, targetId, locatorConfig })`。
4. 完成。引擎不感知平台差异。

## DevToolsClient 复用

所有适配器通过 `opts.cdp` 注入已连接的 `DevToolsClient`（来自 `server/devtools.js`），不重造 CDP 通道。
`this.eval(expr)` 是 `cdp.evaluate(expr, this.targetId)` 的薄封装。
