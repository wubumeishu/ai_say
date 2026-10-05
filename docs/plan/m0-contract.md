# M0 · SQLite Store 契约文档

> 产出文件：`server/db/store.js`、`server/db/migrate.js`、`server/db/schema.sql`
> 验收依据：`docs/plan/02-datamodel.md` §1/§4、`docs/plan/04-roadmap.md` M0 可验收标准

---

## 1. 文件清单

| 文件 | 说明 |
|------|------|
| `server/db/schema.sql` | SQLite DDL，14 实体 + 索引，`CREATE TABLE IF NOT EXISTS` 幂等 |
| `server/db/migrate.js` | JSON → SQLite 可逆迁移脚本，`node` 直接跑 |
| `server/db/store.js` | CommonJS store，`createStore({dbPath})` 导出 |
| `data/aisay.db` | SQLite 数据库文件（迁移后生成） |
| `data/export/` | `--export` 模式的输出目录 |

---

## 2. 实体字段表（14 实体）

| 实体 | pk | 关键 FK | 核心字段 |
|------|----|---------|----------|
| **Account** | `accountId` | — | platform, label, status, legacyKey, createdAt/updatedAt |
| **WindowInstance** | `windowId` | → Account | seq, lastHealth, legacyKey |
| **AccountPersona** | `personaId` | → Account | persona(JSON), tone, background, targetAudience, taboos(JSON), status |
| **Contact** | `contactId` | mergedInto → Contact | displayName, nickname, firstSeen/lastSeen, lifecycle |
| **ContactAnchor** | `anchorId` | → Contact | kind(strong/weak), value, confidence, source |
| **ContactProfile** | `contactId` | → Contact | age/region/height/occupation/language, intent, interests(JSON), historySummary, confidence, source |
| **Conversation** | `conversationId` | → Account, Contact | channel, status, lastActiveAt, legacyKey |
| **Message** | `messageId` | → Conversation | seq, role, original, translation, timeText/timeIso, kind/name/url, raw(JSON), createdAt |
| **LeadEvent** | `leadEventId` | → Contact | score, tier, signals(JSON), action, lineOffered/lineAdded |
| **LineMember** | `openId` | — | displayName, region, lineTag(JSON), bindPhone, silentDays |
| **LineBind** | `bindId` | → Contact, LineMember | joinKey(phone/openId/deviceId), confidence |
| **Tag** | `tagId` | — | layer(source/intent/category/status/ops), value, appliedTo(JSON) |
| **GovernanceRule** | `ruleId` | — | ruleType, scope(global/platform/account/channel), scopeKey, rule(JSON), priority, status, effectiveFrom/To |
| **MergeEvent** | `mergeEventId` | → Contact×2 | survivorContactId, mergedContactId, reason, anchorKind, direction(merge/rollback), rollbackOf |

主键生成规则：
- `accountId` = `sha1('acc/' + platform + '/' + windowId + '/' + label)`
- `contactId` = `sha1('weak/' + platform + '/' + windowId + '/' + label + '|' + displayName)`（M0 迁移期弱锚点；M2 起强锚点替换）
- `conversationId` = `sha1(accountId + '|' + contactId + '|platform_dm')`
- `messageId` = `sha1(conversationId + '|' + seq + '|' + original)`（幂等去重）

---

## 3. API 签名（`createStore({ dbPath })`）

### 3.1 与旧 `server/store.js` 兼容（形状不变，底层 SQLite）

| 方法 | 入参 | 出参 | 说明 |
|------|------|------|------|
| `upsertAccountProfile(input)` | `{platform, windowId, accountLabel/nickname/name, fields, ...}` | Account 行 | 兼容旧 shape；自动维护 WindowInstance |
| `listAccountProfiles(query)` | `{platform?, limit?}` | Account[] | 按 platform 过滤 |
| `upsertContact(input)` | `{platform, windowId, contactKey, contact{name,age,region,...}, ...}` | Contact 行 | 自动建弱锚点 + ContactProfile |
| `listContacts(query)` | `{lifecycle?, limit?}` | Contact[] | 按 lifecycle 过滤 |
| `upsertConversation(input)` | `{platform, windowId, contactKey, contactName, contact, messages[]}` | Conversation 行 | 自动建缺失的 Contact/Account；消息 append-only |
| `listConversations(query)` | `{contactId?, limit?}` | Conversation[] | 按 contactId 过滤 |
| `getMessages(conversationId, limit)` | string, number | Message[] | 按 seq 升序 |

### 3.2 新增能力

| 方法 | 签名 | 说明 |
|------|------|------|
| `mergeContact` | `mergeContact(survivorId, mergedId, reason, anchorKind) → MergeEvent` | 写 MergeEvent + mergedInto 指针 + 迁移锚点/会话；**不物理删除** |
| `rollBackMerge` | `rollBackMerge(mergeEventId) → MergeEvent` | 写 direction='rollback' 的 MergeEvent，恢复指针/锚点/会话 |
| `upsertAccountPersona` | `upsertAccountPersona(accountId, {persona, tone, background, targetAudience, taboos, status}) → AccountPersona` | 账号人设，与 ContactProfile 严格分离 |
| `getEffectiveRules` | `getEffectiveRules({accountId?, platform?, channel?}) → {rules[], denyByDefault}` | global⊃platform⊃account 叠加，同层 priority 高者胜；compliance 未命中 denyByDefault=true |

---

## 4. 去重合并算法

1. **强锚点命中**（LINE openId / 邮箱 / 手机号）：直接 `mergeContact`，写 MergeEvent(anchorKind='strong')。
2. **弱锚点命中**（legacyKey / 设备指纹 / 归一化姓名+特征）：进 `likelySame` 待确认队列，不自动合并。
3. **合并后**：
   - `Contact.mergedInto` = survivorId（指针，不物理删除）
   - `ContactAnchor` 迁移到 survivorId
   - `Conversation.contactId` 指向 survivorId（消息历史保留）
4. **回滚**：`rollBackMerge(mergeEventId)` 写 direction='rollback'，恢复所有指针。

---

## 5. 治理下发契约（GovernanceRule）

```
getEffectiveRules({ accountId, platform, channel })
  → 查询 status='active' 且在 effectiveFrom/To 窗口内的规则
  → scope 叠加：global（无条件）⊃ platform ⊃ account ⊃ channel
  → 同层多条取 priority 最高
  → compliance 类存在 → denyByDefault=true（未命中规则时默认拒绝外发）
  → 返回 { rules: [...], denyByDefault }
```

规则变更：M5 控制台 `saveGovernanceRule` API，每次变更写 auditLog，支持回滚（保留 status='deprecated' 历史行）。

---

## 6. 迁移与验收步骤

### 6.1 迁移（一次性）

```bash
# 导入现有 3 个 JSON → SQLite
node server/db/migrate.js

# 可逆导出（验证等价性）
node server/db/migrate.js --export

# round-trip 自检（导入→导出→再导入，diff 应为空）
node server/db/migrate.js --check
```

### 6.2 可验收标准对应（04-roadmap.md M0）

| # | 验收项 | 验证方式 |
|---|--------|----------|
| 1 | 3 个 JSON 100% 导入无字段丢失 | `--check` 打印条数对比 + round-trip diff 为空 |
| 2 | 同客户跨窗口合并保留 firstSeen/lastSeen | `mergeContact` 后查 `Contact.firstSeen/lastSeen` 不丢 |
| 3 | 并发写不产生半写/损坏 | SQLite WAL 模式（`PRAGMA journal_mode=WAL`）+ 事务 |
| 4 | 实体带 createdAt/updatedAt，kill 后数据完整 | `--check` 幂等性验证（重复导入条数不增长） |

### 6.3 并发写安全（M0 验收标准 3）

`store.js` 内部在写操作使用 `db.exec('BEGIN IMMEDIATE')` 包裹多表写，避免半写。
`Message` 只追加（append-only），无 UPDATE 列，schema 层无 updatedAt/deletedAt。

---

## 7. 与现有代码的共存

- **不改** `server/store.js`（JSON 版保留，兼容旧脚本）
- **不改** `package.json` 现有 `ws` 依赖（`node:sqlite` 为 Node ≥22.5 内置，无需外部包）
- 新代码全部在 `server/db/` 下，旧代码通过 `require('../store')` 继续使用 JSON 版
- M2 起逐步将 `server/app.js` 的 store 调用切换到 `createStore({dbPath})`

---

*产出：architect，M0 交付物*
