# FB / WhatsApp 真实接入说明（骨架版）

本文件说明 Facebook (Messenger) 与 WhatsApp Web 两个适配器从「骨架」升级为「可运行」需要补齐的真实样本与定位规则，以及新平台零改引擎/架构的接入清单。

## 1. 为什么是骨架

Facebook / WhatsApp 的前端选择器**不在代码里写死**，全部收敛在 `locatorConfig`（JSON，见下方示例）。
当前 `facebook.js` / `whatsapp.js` 内的 `DEFAULT_LOCATOR_CONFIG` 是基于各平台**公开 UI 结构**给出的骨架选择器，已用 `// SKELETON: 需真实页面样本校准` 标注。
接入前**必须**用真实页面样本校准这些 selector，否则 `probeRule` 命中率低、`onLocatorMiss` 会持续告警。

## 2. 需要哪些真实页面样本

每个平台至少采集以下 4 类样本（URL + 截图 + DOM 结构）：

| 样本类型 | Facebook Messenger | WhatsApp Web |
|---|---|---|
| 会话列表页 | `facebook.com/messages`（已登录） | `web.whatsapp.com`（主面板） |
| 聊天页（有消息） | 任一有往来的会话 | 任一有往来的会话 |
| 个人资料页 | 客户主页 `facebook.com/<profile>` | 会话头部联系人信息区 |
| 空输入/空列表 | 新账号或清空状态 | 新设备扫码后的空状态 |

采集方法：用比特浏览器打开对应窗口，DevTools → Elements 复制目标节点的完整 CSS 选择器路径 + 截图 + 该节点 `innerText` / `getAttribute` 关键值。

## 3. 定位规则 JSON 怎么填进 locatorConfig

把校准后的选择器填入 `locatorConfig.rules` 的对应 `selectors` 数组，每条 rule 保留 `minHits` / `missThreshold`。结构：

```jsonc
{
  "rules": {
    "chatBubble": {
      "selectors": [".messageContainer", ".messageRow"], // ← 用真实样本校准后的 selector 替换骨架
      "minHits": 1,
      "missThreshold": 0.1,        // 可选：命中率低于 10% 触发告警
      "appliesTo": ["chat"]         // 可选：限定适用 pageKey
    }
  },
  "send": {
    "input": ["<真实输入框 selector>"],
    "button": ["<真实发送按钮 selector>"],
    "key": "Enter"
  }
}
```

选择器语法三态（与出会 17098 一致）：
- `"css"` — 纯 CSS 选择器
- `"text|css"` — 在 css 范围内精确文本匹配；css 未命中时回退全页文本
- `"css||text"` — CSS 优先，失败再全页文本

## 4. onLocatorMiss 告警怎么跑

基类 `probeRule(ruleId)` 在每次探测后自动：
1. 更新 `adapter.locatorStats`（ruleId → `{ hits, total, lastHits, at }`）
2. 命中数 `< minHits` 或命中率 `< missThreshold` 时：`adapter.locatorMissCount += 1` 并发 `onLocatorMiss` 事件

告警 payload：`{ platform, ruleId, hits, total, threshold, minHits, url, probe }`，
其中 `probe` 数组每条含 `{ css, text, cssHits, textHit, sample, href, ok }`，可直接定位哪个 selector 没命中。
M5 健康面板直接拉 `adapter.locatorMissCount` / `adapter.locatorStats` 展示。

## 5. 新平台「零改引擎/架构」4 方法契约清单

接入任何新平台，只需做 4 件事（引擎/架构零改动）：

1. **新建子类** `server/adapter/<platform>.js`，`extends PlatformAdapter`，覆写：
   - `parseProfile(probe, kind)` — 把探测结果映射为 AccountPersona/CustomerProfile 字段
   - `scanMessagesJs()` — 返回聊天页消息扫描脚本（可选，默认走 inbox 行扫描）
2. **准备 locatorConfig JSON** — `pages` / `rules` / `actions` / `send` 四块，selector 用真实样本校准
3. **注册** — 在 `platformAdapter.js` 的 `registry` 加一行 + `createAdapter` switch 加一个 case
4. **注入创建** — `createAdapter(platform, { cdp, targetId, locatorConfig })`，`cdp` 是 `server/devtools.js` 的 `DevToolsClient` 实例

4 方法契约（基类已实现，子类可覆写）：
- `scanProfile()` — 结构化账号/客户资料页
- `scanMessages(conversationId)` — 结构化消息流（role/original/translation/time）
- `navigate(urlOrAction)` — 页面跳转/操作（URL 或 actionId）
- `send(text, {to})` — 发消息（合规闸门由 acquisition 前置）

## 6. FB / WA 骨架 selector 速查（待校准）

| rule | Facebook 骨架 | WhatsApp 骨架 |
|---|---|---|
| 消息列表 | `.messageListItem` / `.li[data-sigil="message"]` | `.conversation-list-item` / `li[data-testid^="conversation"]` |
| 聊天气泡 | `.messageContainer` / `.messageRow` | `#msg .message-in` / `#msg .message-out` |
| 输入框 | `textarea[aria-label*="write"]` / `.richTextComposer textarea` | `#msg [contenteditable="true"].copyable-text` |
| 发送按钮 | `button[aria-label*="Send"]` | `#msg [data-icon="send"]` / `button[data-automation-id="send-message"]` |
| 资料页 | `.profileHeader` / `.contactContainer` | 会话头部 `.copyable-text` |

全部标 `// SKELETON: 需真实页面样本校准`，接入前逐条用真实 DOM 核对替换。