# Ai SAY · API 接口文档

> 服务默认监听 `http://127.0.0.1:8300`（可用环境变量 `PORT` / `HOST` 覆盖）。
> 响应统一为 JSON。旧轨路由（`/api/*`）写在 [server/app.js](../server/app.js)，
> 控制台路由（`/api/console/*`）写在 [server/consoleRoutes.js](../server/consoleRoutes.js)。
> 注意双存储：旧轨读写 `data/*.json`，控制台读写 SQLite `data/aisay.db`（待统一，见 AGENTS.md §3.7）。

## 通用约定

- 请求体：`Content-Type: application/json`。
- 成功返回 `{ ok: true, ...data }`；失败返回 `{ ok: false, msg }`（或 HTTP 4xx/5xx）。
- `/api/console/mailbox` 是所有 live 端点的前置：先建收件箱快照，客户详情/真发才可用。

## 控制台路由（/api/console/*）

### 客户与账号
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/console/customers | 客户卡片列表（画像 + 人设 + 会话 + 推荐回复） |
| GET | /api/console/customers/:id | 单个客户详情（对话流 + 推荐回复 + 引流事件） |
| GET | /api/console/customers/:id/profile | 客户资料页（ContactProfile + anchors） |
| GET | /api/console/accounts | 账号列表：`[{ accountId, platform, label, status, active, windowCount, conversationCount }]` |
| GET | /api/console/accounts/:id | 账号资料页（Account + AccountPersona） |
| GET | /api/console/account | 当前账号信息 |
| POST | /api/console/account/refresh | 抓取账号自己的资料卡（snsmypage/show_profile.html） |
| POST | /api/console/account/update | 更新账号资料 `{ nicknameOverride?, profileOverride?, places? }` |
| GET | /api/console/tags | 标签分层 `[{ layer, values: [{ value, contactCount, tags }] }]` |

### 收件箱 / 抓取（live）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/console/mailbox | 轻量轮询：抓收件箱 → 写缓存 → 返回轻量列表（含未读） |
| GET | /api/console/live | 连活出会窗口抓出会页面（BitBrowser CDP） |
| GET | /api/console/live/deep | 深度抓取（收件箱/历史/资料）；构建失败时返回 501 |
| GET | /api/console/live/customers | 全量客户（缓存快照） |
| GET | /api/console/live/customer?id=xxx | 单客户详情（缓存优先；缺则按需抓历史/资料） |
| POST | /api/console/live/customer/read?id=xxx | 标记已读 |
| POST | /api/console/live/customer/refresh?id=xxx | 强制重抓历史 + 资料 |

### 翻译
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/console/translate?text=xxx&from=ja&to=zh-CN | 单条翻译（LLM，内容寻址缓存） |
| POST | /api/console/translate/batch | `{ items: [{ text, from, to }] }` → `{ results, stats }` |
| GET | /api/console/translate/stats | 翻译缓存统计 |
| POST | /api/console/translate/clear | 清空翻译缓存 |

### 常用语
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/console/phrases | 常用语列表 + 分组 |
| POST | /api/console/phrases/save | `{ id?, group, text }` 新增或更新 |
| POST | /api/console/phrases/delete?id= | 删除 |
| POST | /api/console/phrases/use?id= | 记一次使用（排序/统计） |

### 模型管理
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/console/model-status | `{ configured, model, baseUrl, provider }` |
| GET | /api/console/models | `{ models: [...], activeId }` |
| POST | /api/console/models/create | `{ name, provider, baseUrl, model, apiKey }` |
| POST | /api/console/models/update?id=xxx | 同 create 字段 |
| POST | /api/console/models/delete?id=xxx | 删除 |
| POST | /api/console/models/activate?id=xxx | 设为当前项目使用 |
| POST | /api/console/models/test?id=xxx | 连通性测试（id 或 body 直接给未保存配置） |
| POST | /api/console/model-config | `{ provider, baseUrl, model, apiKey }` 写 settings.json 的 model 字段 |

### 话术 / 发送（⚠️ 发送类：AI 只出建议，人工确认才发）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/console/rules | 生效的 GovernanceRule |
| POST | /api/console/rules/rollback | `{ contactId?, templateVersion? }` 话术一键回滚 |
| GET | /api/console/likely-same | likelySame 待确认队列 |
| GET | /api/console/locator-misses | adapter 定位失败告警 |
| POST | /api/console/send-confirm | `{ contactId, accountId?, text?, tier?, governanceRules? }` 走合规闸门 + 频控再发 |
| POST | /api/console/send-live | `{ contactId, text, doConfirm?, waitMs?, toInbox? }` 页面真发（填 textarea → #sendButton → 确认弹窗 → #submitBtn），发完切回收件箱。当前无闸门/频控/审计（自动化引流准入条件，见 AGENTS.md §1.1） |
| GET | /api/console/pending-queue?contactId=&limit= | 还没发的话术列表（审计视图「待确认」数据源） |
| GET | /api/console/audit | `{ complianceSummary, banDrillStatus, recentAudit[20] }` |
| GET | /api/console/private-domain | 引流私域（LINE）状态 |

### Ai SAY 助手（面板 B v1）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/console/assistant | `{ message, contactId?, history?, maxMsgs? }` → `{ reply, actions: [{type,label,payload}] }`；上下文 = 画像 + 最近 N 条消息 + 工具清单；发送类动作只出确认卡片 |

### 网络与代理
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/console/network/health | 出口 IP / 国家 / 延迟 / DNS / 平台连通 / CDP → 归因「网络 / 平台 / CDP 卡住」 |
| GET | /api/console/proxy/pool | 代理池状态（槽位/使用/冷却/粘性/密码就绪） |
| POST | /api/console/proxy/rotate | `{ windowId?, dryRun?, force? }` 手动换 IP（30min 冷却，force 跳过） |
| POST | /api/console/proxy/pool/expand | `{ n }` 扩池 |
| POST | /api/console/proxy/pool/sticky | `{ minutes }` 改粘性时长 |
| POST | /api/console/proxy/health-rotate | 体检驱动换 IP（body 不传 health 则现测） |

### 指标
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/console/metrics | 四大核心指标（自动处理/引流/LINE 转化/去重），按日聚合 |

## 旧轨路由（/api/*，JSON 存储，待与 SQLite 统一）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | /api/settings | 读写 settings（apiKey 等，勿提交真实值） |
| GET / POST | /api/platform-groups | 平台组（窗口分组） |
| POST | /api/platform-groups/move | 组内排序 |
| POST | /api/browsers | 拉比特浏览器窗口列表 |
| POST | /api/inspect-page | 抓页面结构 |
| POST | /api/accounts/save-profile | 保存账号资料 |
| GET | /api/platforms/accounts | 平台账号列表 |
| GET | /api/accounts/profiles | 账号资料 |
| POST | /api/profile /profile/fields /profile/inspect /profile/patch | 客户资料维护 |
| POST | /api/message | 单条消息翻译 + 推荐 |
| GET / POST | /api/conversations /api/contacts | 会话 / 联系人（JSON 存储） |
| POST | /api/messages/inspect | 消息页扫描 |
| POST | /api/monitor | 开窗口 + DevTools 监控 |
| GET / POST | /api/ai/settings | LLM 配置 |
| POST | /api/ai/translate /api/ai/page-insight /api/ai/reply | LLM 翻译 / 页面理解 / 推荐回复 |
| POST | /api/screenshot /api/stop | 截图 / 停止会话 |

## 页面入口

- 主控制台：`/ichigo-console`（public/ichigo-console.html）
- 卡片式控制台：`/console`（public/console.html + console.js）
- 旧页面：`/`
