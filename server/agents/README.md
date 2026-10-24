# server/agents · agent 包（已实现功能的可复用打包）

> 总控 2026-10-25 建。把项目已实现的功能整理打包成 agent，供内置 AI（assistant.js 的 LLM）
> 发现/调用，也便于集中管理修改。

## 是什么

一个 agent = 一段「已实现功能」的封装：
- 映射到项目已有的 HTTP 端点（/api/console/*）或 RPA 表达式（ichigo*Expr.js）
- 带副作用等级（none/weak/strong）+ 参数 schema + 确认闸门
- LLM 通过统一注册表发现可用 agent，生成动作卡片；强副作用永不直接执行（建议→确认→执行铁律）

## 文件

| 文件 | 职责 |
|---|---|
| registry.js | **agent 注册表（唯一改这里）**：每个 agent 的 schema + llmType 兼容命名 |
| agentExecutor.js | 统一执行器：agentId + params → 参数校验/确认闸门/路径拼接 → HTTP 端点调用 → 结果归一 |

## 管理 agent（增删改）

**只改 registry.js 的 AGENTS 数组**，其他全自动跟随：
- 加 agent：AGENTS 里加一条 { id, name, module, desc, sideEffect, params, endpoint, needsConfirm, buildPayload? }
- 删 agent：删那条
- 改名：改 id/llmType（注意 LLM 已学的 type 名，向后兼容优先保留旧 llmType）
- assistant.js 的 TOOL_WHITELIST 从 registry.toLlmToolList() 动态生成，不用改

### 字段说明
| 字段 | 说明 |
|---|---|
| id | agent 内部标识（camelCase），getAgent 可查 |
| llmType | LLM/前端可见的工具 type（snake_case，向后兼容旧命名）；缺省用 id |
| sideEffect | none=只读 / weak=弱副作用（可直执） / strong=强副作用（永不直执，只出确认卡片） |
| needsConfirm | strong 副作用必须 true（执行器层二次校验，与端点层双保险） |
| endpoint | { method, path }，映射到已有 /api/console/* 端点 |
| buildPayload(p) | 可选：LLM params → HTTP body 的映射（处理必填/默认值/路径参数） |
| params | 参数 schema [{name,type,desc,required}] |

## 当前 agent 清单（16 个）

| llmType | 名称 | 模块 | 副作用 | 端点 |
|---|---|---|---|---|
| get_customer | 读客户画像 | mail | none | GET /customers/:id |
| list_customers | 列客户 | mail | none | GET /customers |
| search_customers | 搜客户 | mail | none | GET /customers |
| generate_replies | 生成话术 | mail | none | GET /customers/:id |
| translate | 翻译 | mail | none | GET /translate |
| fill_draft | 填入输入框 | mail | weak | POST /live/customer/refresh |
| mark_read | 标记已读 | mail | weak | POST /live/customer/read |
| switch_customer | 切客户 | mail | weak | GET /customers/:id |
| send_message | 发送消息 | mail | **strong** | POST /send-live |
| block_contact | 拉黑客户 | mail | **strong** | POST /batch |
| bbs_query_posts | 查BBS帖子 | bbs | none | GET /bbs/posts |
| bbs_edit_post | 改BBS帖 | bbs | **strong** | POST /bbs/post/edit |
| bbs_delete_post | 删BBS帖 | bbs | **strong** | POST /bbs/post/delete |
| network_health | 网络体检 | ops | none | GET /network/health |
| proxy_rotate | 换IP | ops | weak | POST /proxy/rotate |
| console_health | 控制台健康 | ops | none | GET /health |

## 调用（执行器）

```js
const executor = require('./server/agents/agentExecutor');
// 只读/弱副作用：直接执行
const r1 = await executor.executeAgent({ agentId: 'bbs_query_posts', params: { genre: 5, board: 'pure' } });
// 强副作用：必须 confirmed=true（LLM 永不自己加，由用户确认卡片带上）
const r2 = await executor.executeAgent({ agentId: 'bbs_delete_post', params: { targetBbsIds: ['178898703'] }, confirmed: true });
```

返回归一：{ ok, agent, sideEffect, httpStatus, data, error?, reason? }

## 测试

tests/agents.test.js（8 用例）：registry 新旧命名兼容 / 强副作用确认 / 参数校验 / 路径拼接 /
TOOL_WHITELIST 动态化验证。全量回归 197/197 全绿（基线 189 → 197，+8 agents）。
