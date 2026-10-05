# M4 交接单 · LINE 官方 OA 凭据（待老板提供）

> 当前状态：M0–M3、M5 已全链路跑通（50/50 自检全绿、round-trip 通过、模块全加载）。
> M4（LINE 私域）代码已写完并 mock 通过，唯一阻塞是「接真实 LINE 官方账号凭据」。

## 老板需提供的 3 项凭据
1. **channelAccessToken**（LINE Official Account 的 Channel access token）
2. **channelSecret**（用于 LINE Login 获取 phone join key）
3. **webhookSecret**（LINE 管理台设置，用于 X-Line-Signature HMAC-SHA256 校验）

## 接入方式（已就绪，只需传 3 个值）
```js
const { createLineOa } = require('./server/acquisition/lineOa');
const lineOa = createLineOa({
  store,                       // M0 store
  webhookSecret,               // 老板提供
  channelAccessToken,          // 老板提供
  channelSecret,               // 老板提供
  fetchImpl: fetch,            // 用 Node 内置 fetch 切真实 LINE API（当前 mock 用 fetchImpl=mockFetch）
  phoneResolver: async (openId) => { /* 经 ContactAnchor strong phone 反查，绑定平台客户 */ }
});
// 注册 Webhook 路由（需一个公网/内网可达的 endpoint，老板需在 LINE 管理台登记）
app.post('/line/webhook', lineOa.handleWebhook);
```

## M4 验收标准（来自 04-roadmap）
- 只用 LINE 官方 OA（不走个人号、不爬），引流客户 100% 绑定 LineMember；
- 标签准确率 ≥85%；
- 绑定键优先级 phone（join key） > openId（兜底）；
- 标签群发：批≤50 / 间隔≥5s / 单用户 24h push≤2 / 静默 30 天移出 / 预算双层告警；
- 风控：失败率>5% 自动降速、敏感词拦截、A/B 双变体固定分流。

## 封号/合规演练（M4 出口条件）
- 平台侧：账号级频控硬编码、新号 7 天养期、多号轮换、限流信号自动停发 24h、账号隔离；
- 演练项：故意触发限流 → 验证 24h 停发开关生效；故意 5% 失败 → 验证 LINE 自动降速。
