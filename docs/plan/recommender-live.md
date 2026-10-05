# 真实 LLM 接入说明（recommender · M1 收尾）

> 适用：老板提供 **API key + baseUrl + model** 后，把 Ai SAY 的推荐回复从「AI 未配置时降级模板」切到「hot 客户真 LLM 个性化」。
> 自检一条命令：`node --test server/db/recommender.live.test.js`（本地 mock LLM，不烧 token、不打真实 API）。

---

## 1. aiService.settings 怎么配（老板给凭据后）

推荐回复的 LLM 走 `server/aiService.js` 的 `chatCompletion({ settings, messages, model, temperature, maxTokens })`。
设置存在 `settings.json → ai`，由 `aiService.loadAiSettings()` 读取、`aiService.isConfigured(settings)` 判定是否可用。

### 1.1 settings.json 字段（`ai` 块）

```json
{
  "ai": {
    "enabled": true,
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",   // 老板给的 baseUrl（OpenAI 兼容网关就填对应域名 + /v1）
    "apiKey": "sk-xxxxxxxx",                 // 老板给的 API key
    "model": "gpt-4o-mini",                  // 老板给的 model（chat 用）
    "visionModel": "gpt-4o",
    "timeoutMs": 60000,
    "temperature": 0.3
  }
}
```

### 1.2 生效判定（`isConfigured`）

`aiService.isConfigured(settings) === true` 当且仅当：`enabled === true` 且 `apiKey` 非空。
recommender 对 hot 客户只有在此为 true 时才会真正调 LLM；否则 **自动降级** 到 talkEngine 模板（绝不卡死，见 §3）。

### 1.3 快速写入（可选，不手改 json）

```bash
node -e "const a=require('./server/aiService.js'); a.saveAiSettings({ enabled:true, baseUrl:'https://api.openai.com/v1', apiKey:'sk-xxx', model:'gpt-4o-mini' }); console.log(a.publicSettings(a.loadAiSettings()));"
```
（`publicSettings` 只回显 `hasKey` 布尔，不回显 key 本身，避免泄漏。）

---

## 2. hot 客户个性化路径 + 降级链

`recommender.recommendReply(ctx)` 按 `ctx.tier` 分流：

```
hot 客户
  │
  ├─ aiService.isConfigured(settings) === true
  │     调 aiService.chatCompletion({ settings,
  │            messages: [ {role:'system', content:三要素 prompt},
  │                        {role:'user',  content:客户画像+最近消息} ],
  │            model, temperature:0.3, maxTokens:300 })
  │        │
  │        ├─ 返回 1-3 条 → splitReplies 拆行 → 逐条 gateReply
  │        └─ 返回空 / 抛错 → 降级模板
  │
  └─ isConfigured === false（未配置 / key 缺失 / 关闭）
        直接走 talkEngine.buildTalks 模板（source='template'，省 token，不卡死）

warm / cold 客户
  → 不走 LLM（省 token），直接 talkEngine.buildTalks 模板（source='template'）
```

### system prompt 三要素（`buildPrompt` 强制加载）

| 要素 | 来源 | 进 prompt 的内容 |
| --- | --- | --- |
| 账号人设 | `accountPersona` | persona（身份/角色）/ tone（语气）/ background（背景）/ taboos（人设禁忌） |
| 客户画像 | `customerProfile` | name / age / region / intent / interests / lastSeen |
| 统一规则 | `governanceRules.rules` | compliance `keywords` + speechBoundary `forbidden` 的红线词清单（回复出现即作废） |

`user` 消息 = 最近 ≤12 条对话（self/peer 角色标注）+ 当前档位。

### 降级链（任何一环失败都落模板，绝不卡死）

1. `isConfigured === false` → 模板；
2. `chatCompletion` 抛错（超时/网络/HTTP 非 2xx）→ `catch` 记 `note` → 模板；
3. LLM 返回空 / 拆不出行 → 模板；
4. LLM 输出全被合规闸门拦 → 模板再兜底一次（`source` 标记 `ai+template`）。

---

## 3. 合规闸门怎么保证 LLM 输出不过红线

LLM 生成 **不等于放行**。每条回复都要过 `gateReply(text, governanceRules)`：

- 解析每条 `governanceRule` 的 `rule`（JSON）：
  - `ruleType==='compliance'` → `spec.keywords` 命中任一 ⇒ 丢弃（`reason='compliance 红线命中: …'`）；
  - `ruleType==='speechBoundary'` → `spec.forbidden` 命中 / 超 `maxLen` ⇒ 丢弃；
- 命中的从最终 `replies` 剔除，保留 `gated` 全量（含被丢原因）供审计。

**双保险**：
1. **生成前**——红线词已写进 system prompt（「回复中出现任一词即作废」），引导 LLM 不产出；
2. **生成后**——`gateReply` 逐条硬过滤，LLM 真出了红线词也会被拦掉。

全被拦时走 §2 降级链第 4 步的模板兜底，模板自身也再过一遍 `gateReply`。
LeadEvent（action='triggered'）+ RecommenderAudit（action='replied'）双记录，红线命中数写进 `gated` 计数。

---

## 4. 一条命令跑 live 自检（不打真实 API）

```bash
node --test server/db/recommender.live.test.js
```

`recommender.live.test.js` 起一个 **本地 http server** 模拟 OpenAI `/chat/completions`
（返回符合 OpenAI schema 的 JSON：`choices[0].message.content`），并把
`aiService.isConfigured` 指向它（`loadAiSettings` 返回 `{ enabled, apiKey, baseUrl: mock, model }`）。

覆盖 4 个场景（共 9 个断言）：

| 场景 | 断言 |
| --- | --- |
| hot + 合规 LLM | system prompt 含 人设(tone/persona/taboo) + 画像(intent/interests/region) + 规则(compliance 红线词)；user prompt 含最近消息 |
| hot + LLM 返回含「gambling」敏感词 | `gateReply` 把该条丢弃（compliance 命中），最终 `replies` 不含敏感词 |
| hot + LLM 返回合规 3 行 | 生成 1-3 条 + `source='ai'` + 写 `LeadEvent(action='triggered')` + `RecommenderAudit(action='replied')` 落库 |
| hot + LLM 返回空 | 降级 talkEngine 模板（`source` 含 `template`，`note` 说明 LLM 空输出，不卡死） |

> 真实接入验证：把 `settings.json` 的 `ai` 块换成老板的真凭据后，
> 跑 `node --test server/db/recommender.live.test.js` 仍走本地 mock（验证 prompt 构造与闸门逻辑）；
> 要验证 **真实** LLM 出参，临时把 `mockAiService` 的 `chatCompletion` 换成 `aiService.chatCompletion` 实参 + `loadAiSettings()` 真 settings 即可（测试内已留 `aiService.chatCompletion(args)` 的调用点）。
