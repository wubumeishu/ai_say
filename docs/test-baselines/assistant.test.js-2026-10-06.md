# tests/assistant.test.js 基线快照（task-5 代码审查对照）

> 记录人：qa-lead（task-4 收口时留档）
> 日期：2026-10-06
> 用途：task-5（Ai SAY 面板 B v1.1 破旧立新）代码审查「无 intent → 与 B v1 黄金样本一致」断言对照；防 task-4 115 基线漂移时核对 assistant 用例现状。

## 现状（B v1 基线，5 用例全绿）

运行命令：`node --test tests/assistant.test.js`

```
✔ assistant: 模型不可用 ⇒ 降级本地摘要（不删功能） (25.9ms)
✔ assistant: parseActions 白名单过滤 + send_message 必须 needConfirm (0.36ms)
✔ assistant: parseActions 容忍 json 代码块包裹 (0.15ms)
✔ assistant: 空 message 拒绝（400 语义） (0.18ms)
✔ assistant: LLM 可用时 degraded=false 且回复=LLM 正文（mock fetch） (0.47ms)
ℹ tests 5 / pass 5 / fail 0
```

## 用例清单（B v1 黄金样本）

| # | 用例名 | 覆盖 | 状态 |
|---|---|---|---|
| 1 | 模型不可用 ⇒ 降级本地摘要 | 铁律 2（降级保底，不删功能） | 绿 |
| 2 | parseActions 白名单过滤 + send_message 必须 needConfirm | 铁律 1（发送类动作强制确认卡片） | 绿 |
| 3 | parseActions 容忍 json 代码块包裹 | 鲁棒性（LLM 输出带 ```json 块） | 绿 |
| 4 | 空 message 拒绝（400 语义） | 输入校验 | 绿 |
| 5 | LLM 可用时 degraded=false 且回复=LLM 正文（mock fetch） | 正常路径 | 绿 |

## task-5 B v1.1 对照说明

- 设计稿「无 intent → 与 B v1 黄金样本一致」= task-5 新增的 intent 参数缺省时，5 用例行为须不变（向后兼容）。
- task-5 将新增 intent 分 prompt + 强制 JSON 输出 { analysis, strategy, replies:[{type,content}] } + 脱敏（apiKey 走 header / PII 掩码）。
- 设计稿 §7 共 17 例为 task-5 目标用例数；当前 5 用例为 B v1 基线，task-5 实施前须留此快照防漂移。
- 本快照仅记录现状，不改任何测试。
