# task-3 · 频控账本落库设计（rate-ledger-persist）

> 状态：**设计文档**（不写业务代码，code-reviewer 复审第 2 轮）
> 作者：dba ｜ 依据：talkEngine.js 现状（2026-10-06 实测）+ 终极蓝图 §-1
> 前置：send-live 合规闸门前置（§1.1 / §3.6）；24h 限额跨重启有效
> 跨单协同（task-① task-2 外键 schema 定稿后）：本文表挂 Account / Conversation 外键。
> **_migration 版本裁决（跨单协同）**：task-2 占 v2（task-① 嵌套 schema 外键表），
> task-3 占 **v3**（本文 SentLog / GateBlock / PendingQueue 三表挂 task-2 外键后迁移，
> 顺序成立：v2 先建外键源表，v3 再建账本表挂外键）。本文 §1.4 / §5 已同步改为 v3。
>
> **修订记录（code-reviewer 复审 2026-10-06）**：
> - 打回 #1 · NoopLedger 破旧断言：_sentLog / _pendingQueue 保持原始数组导出形状，
>   LedgerHandle 另开 _ledger 句柄注入（数组=账本快照读接口，句柄=写入口）。
> - 打回 #2 · L579 优先序矛盾：明确「注入静态数组 + 内部 LedgerHandle」时 rollbackLastTalk
>   读源判定规则；注入裸数组 = NoopLedger 降级（只读不写回）。
> - 打回 #3 · §2 expire 语义合并：72h expire = 状态机标记 expired，物理归档只按行量
>   阈值；confirmed 行 72h 内不被裁。
> - 打回 #4 · §4.4 补 (ts, seq) 字典序 + NoopLedger 负例哨兵（抄送 qa-lead 纳入 task-4 111 基线）。

---

## 0. 现状勘察结论（只读核实）

| 内存结构 | 位置 | 现状形状 | 重启行为 |
|---|---|---|---|
| sentLog | talkEngine.js L114 | `{ accountId, contactId, ts, kind, blocked, pending, templateVersion, variant }` | 清零 → 24h 限额可绕过 |
| pendingQueue | talkEngine.js L118 | `{ accountId, contactId, tier, text, talk, gateBlocked, reason, ts, confirmed, confirmedAt, governanceRules }` | 清零 → 待确认话术丢失 |
| gateBlockLog | talkEngine.js L116 | `{ ts, reason, kind: compliance\|rateLimit\|blacklist }` | 清零 → 审计断层 |
| abStats | talkEngine.js L112 | 已落 `TalkAbStat` 表（persistAbStat 内联 CREATE） | 不丢（已有先例） |

**重要勘误**：任务书中的 "pushLedger" 经全仓 grep（server/ + tests/）**不存在**。
实际三本账是 **sentLog / gateBlockLog / pendingQueue**。本文按实际命名设计；
若 architect 的 task-① 统一了账本命名，实施时改名即可（表名可保持
SentLog/GateBlock/PendingQueue，与「账本」语义对齐）。

裁剪现状：sentLog/pendingQueue 只 push 不裁剪（§3.6），gateBlockLog 无界。

**注入路径核实（code-reviewer 挂账 #1）**：
- L579 `rollbackLastTalk`：`const sent = Array.isArray(opts.sentLog) ? opts.sentLog : sentLog` —— 注入方
  `opts.sentLog` 优先于内部账本；若注入方仍给静态内存数组，持久化账本被绕过，24h 限额仍可绕过。
  合并策略见 §4.4。
- L450 `ctx.alreadyReminded` + L592 `last.kind === 'remind'`：remind 流水是 30min 提醒窗口
  判定与回滚语义的依赖，裁剪必须保留（§2 窗口修订）。

---

## 1. 表设计（SQLite，加进 server/db/schema.sql，_migration v2）

### 1.1 SentLog · 发送/生成流水（append-only，与 Message 同纪律）

**终版形态 = Variant A（node 2 直接落，外键已挂）**：backend-lead node 1 交付已坐实
v2 外键源表 Account/Contact/Conversation 均在 schema.sql 内且定稿（Platform/PlatformGroup/
AccountGroup + Conversation/Contact/ContactProfile 列补齐 + InboxSnapshot + AccountProfileRaw
+ _migration v2），Variant A 前置满足 → node 2 走 Variant A，三表 DDL 直接带 REFERENCES。
（回退脚注：若 v2 源表未定稿则降级 Variant B，三表 accountId/contactId/conversationId
改普通 TEXT NOT NULL 无 REFERENCES，v4 再迁挂——见 §5 第 2 点。）

```sql
-- pk：确定性 = sha1(accountId|contactId|ts|kind|seq)；seq = 同 (accountId,ts) 内行序
CREATE TABLE IF NOT EXISTS SentLog (
  sentLogId        TEXT PRIMARY KEY,          -- sha1(accountId|contactId|ts|kind|seq)
  accountId        TEXT NOT NULL REFERENCES Account(accountId),
  contactId        TEXT NOT NULL REFERENCES Contact(contactId),
  conversationId  TEXT,                       -- 可空；有值时 REFERENCES Conversation(conversationId)
                                               -- （conversationId = sha1(accountId|contactId|channel) 幂等拼，与 Conversation 主键同构）
  ts               INTEGER NOT NULL,          -- epoch ms（对齐内存账本 Date.parse(nowIso())）
  kind             TEXT NOT NULL DEFAULT 'guide' CHECK (kind IN ('guide','remind','push','other')),
  blocked          INTEGER NOT NULL DEFAULT 0,  -- 1 = 被合规/频控拦截仍计数（task-31 生成口径）
  pending          INTEGER NOT NULL DEFAULT 0,  -- 1 = 已生成未真发（task-37 待确认口径）
  templateVersion  TEXT,
  variant          TEXT,                      -- A/B 变体
  seq              INTEGER NOT NULL DEFAULT 0
);
-- 24h 客户级热路径：WHERE accountId=? AND contactId=? AND ts>=?
CREATE INDEX IF NOT EXISTS idx_sent_customer_day  ON SentLog(accountId, contactId, ts DESC);
-- 1h 账号级热路径：WHERE accountId=? AND blocked=0 AND ts>=?
CREATE INDEX IF NOT EXISTS idx_sent_account_hour  ON SentLog(accountId, blocked, ts DESC);
-- 每分钟 cap（窗口小，与上一索引共享前缀即可，不另建）
```

语义对齐：
- 单客户 24h（perCustomerPerDay）按 **blocked=0 与 blocked=1 都计**（task-31「生成口径」，防绕过）；
- 账号 1h / 每分钟 cap 只按 **blocked=0** 计（真实发送压力）；
- pending 只标记「生成未真发」，**计数仍计**（与 now withinRateLimit 一致）。

### 1.2 PendingQueue · 待确认话术（活跃队列落库）

```sql
CREATE TABLE IF NOT EXISTS PendingQueue (
  pendingId        TEXT PRIMARY KEY,          -- sha1(accountId|contactId|ts|textHash)
  accountId        TEXT NOT NULL REFERENCES Account(accountId),
  contactId        TEXT NOT NULL REFERENCES Contact(contactId),
  tier             TEXT NOT NULL DEFAULT 'warm',
  text             TEXT NOT NULL,            -- 话术原文（≤500 字）
  talkRef          TEXT,                     -- JSON：{ variant, templateVersion, platform, fallback }（不塞全量 talk）
  gateBlocked      INTEGER NOT NULL DEFAULT 0,
  gateReason       TEXT NOT NULL DEFAULT '',
  confirmed        INTEGER NOT NULL DEFAULT 0,
  confirmedAt      TEXT,                     -- ISO
  expired          INTEGER NOT NULL DEFAULT 0,  -- 打回 #3：72h 未确认状态机标志（confirmed 行 72h 内不被置 1）
  createdAt        TEXT NOT NULL
);
-- 活跃队列查询（getPendingQueue 取未确认且未过期）：
CREATE INDEX IF NOT EXISTS idx_pending_active  ON PendingQueue(confirmed, expired, accountId, contactId, createdAt DESC);
-- confirmSend 按 (accountId, contactId, text) 定位：
CREATE INDEX IF NOT EXISTS idx_pending_lookup  ON PendingQueue(accountId, contactId, text);
```

### 1.3 GateBlock · 拦截审计（append-only，供看板/审计视图）

```sql
CREATE TABLE IF NOT EXISTS GateBlock (
  gateBlockId      TEXT PRIMARY KEY,          -- sha1(ts|reason|kind|seq)
  accountId        TEXT,                     -- 可空（全局拦截无账号）；有值时 REFERENCES Account(accountId)
  contactId        TEXT,                     -- 可空；有值时 REFERENCES Contact(contactId)
  ts               INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('compliance','rateLimit','blacklist','other')),
  reason           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateblock_ts  ON GateBlock(ts DESC);
```

### 1.4 迁移登记（v3，挂 task-2 v2 外键 · Variant A 终版）

`INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES (3, datetime('now'), 'task-3: SentLog/PendingQueue/GateBlock 账本落库（Variant A，挂 v2 外键）');`

> 顺序：task-2 v2 先建 Account/Contact/Conversation 外键源表 → task-3 v3 建账本表挂外键。
> **Variant A 终版（node 2 直接落）**：backend-lead node 1 已坐实 v2 源表在 schema.sql
> 内定稿，三表 DDL 直接带 REFERENCES（§1.1/§1.2/§1.3），_migration v3 行随落盘一起执行。
> **回退脚注**：若 v2 源表未定稿 → 降级 Variant B（自含三级字段无外键），v4「建新表+
> 拷贝+切名」再挂外键（§5 第 2 点）；node 2 开工前 backend-lead ping 我确认实际落 A/B。

---

## 2. 裁剪策略（防无限增长 · 时间窗 + 账号分片归档）

| 表 | 活跃窗 | 归档去向 | 归档频率 | 触发 |
|---|---|---|---|---|
| SentLog | **max(24h 限额窗, 30min remindWindow) + 7 天缓冲**（挂账 #2：ctx.alreadyReminded 依赖 kind=remind 流水，裁太狠会误判「已提醒」） | `data/archive/sentlog-YYYYMM-{accountId}.sqlite`（按账号分片） | 每日 00:30 定时器 | 行数 > 5000 或过窗即清 |
| PendingQueue | **状态机 expire**：72h 未确认自动标记 `expired=1`（**不动 confirmed 列**，confirmed 行 72h 内不被裁）；物理归档只按行量阈值 | 并入当月 pending 分片 | 同上 | 72h 行量 > 2000（含 expired+confirmed 全量） |
| GateBlock | 30 天 | 归档分片 | 每周 | 行数 > 20000 |

**expire 语义合并表述（打回 #3）**：「72h expire」与「行量阈值裁剪」是**两层独立机制**，
实施方不得误读为「72h 行物理删」：
- **expire（状态机层）**：PendingQueue 行 72h 未确认 → 标记 `expired=1`（新增列，
  confirmed/expired 双标志独立），**confirmed=1 的行 72h 内不被 expire**（老板已确认的
  话术保留供审计）；expire 只改标志，不删行。
- **物理归档（存储层）**：只按行量阈值（72h 行量 > 2000 或过时间窗）触发，归档目标
  `data/archive/pending-YYYYMM-{accountId}.sqlite`（月×账号分片），归档后源表行删除。
- 两层关系：expire 标志行仍参与物理归档；confirmed=1 行 72h 内不参与 expire 但参与物理
  归档（过 72h 时间窗后归档，不丢审计数据）。

归档实现（伪码，store.js 新增 `archiveRateLedgers()`）：
1. SentLog：`SELECT * FROM SentLog WHERE ts < cutoff` → 按 accountId GROUP BY 写分片 db
   （分片用 node:sqlite 第二实例，同 schema）→ `DELETE FROM SentLog WHERE ts < cutoff`（单事务）；
   cutoff = now - max(24h, 30min remindWindow, 7 天缓冲)（§2 表头口径）。
2. PendingQueue：先 `UPDATE PendingQueue SET expired=1 WHERE confirmed=0 AND createdAt < now-72h`
   （expire 状态机，单语句），再物理归档 `SELECT * FROM PendingQueue WHERE createdAt < now-72h`
   （含 expired+confirmed 全量，过窗才归档）→ 按 accountId 分片写 → DELETE。
   **confirmed=1 且 createdAt 在 72h 内的行既不被 expire 也不被归档**。
3. 分片命名带月 + 账号 = 「时间窗 + 账号分片」双维度，群控规模下单文件不膨胀；
4. 归档失败只 log（模块.动作 + 错误），不阻断主流程；下次定时器补扫。

**不做**：TTL 自动删活跃窗内数据（限额必须跨重启有效，宁可多留不可少算）；
confirmed 行 72h 内物理裁（保留审计）。

---

## 3. 索引与 24h 热路径（对齐 task-①）

- 三条频控查询全部走 1.1 的两个索引（(accountId, contactId, ts DESC) 与
  (accountId, blocked, ts DESC)），单客户 24h 与每分钟 cap 共享前缀，
  账号 1h 走 (accountId, blocked, ts)。无全表扫。
- 热路径只读 COUNT，内存热账本（§4）命中时**根本不查 SQLite**，
  SQLite 仅做「载入 + 兜底 + 审计」，写入异步，不阻塞 talkEngine。
- 群控扩展：索引前缀均以 accountId 开头，N 账号并行查询天然分片，无锁竞争
  （SQLite busy_timeout=15000 已配；写走单写者 + 异步落库队列）。

---

## 4. 读写路径伪码（双写 + 启动载入）

### 4.1 启动：SQLite → 内存热账本（只读快照）

```
createStore():
  loadRateLedger(db):
    // 挂账 #3：快照窗口 = max(24h, 30min remindWindow) + 7 天缓冲，与 §2 裁剪窗一致
    cutoff = now - max(24h, 7d, now - lastRemindTs_of_relevant_accounts)  // 简化：直接取 7 天缓冲
    sentLog ← SELECT * FROM SentLog WHERE ts >= cutoff          // 只读快照，载入后不再回写本表（写走 §4.2 新行）
    pendingQueue ← SELECT * FROM PendingQueue WHERE confirmed=0 AND createdAt >= now-72h
    gateBlockLog ← 不载入（审计只读走 db，getAuditSummary 查 db 聚合）
    // 快照载入即完成「24h 限额跨重启有效」
    // withinRateLimit 用 Date.parse(nowIso()) 实时算窗口边界，快照数据与实时时钟无漂移累积问题
    // （快照行自带 ts，判定 = 快照行 + 本进程新 push 行，同一时间轴拼接）
```

### 4.2 写：内存即时 + SQLite 异步（双写，保序单写者）

```
logSent(entry):
  sentLog.push(entry)                       // 内存：限频判定立即生效
  ledgerQueue.push({ table:'SentLog', op:'INSERT', row: entry })   // 异步落库

flushQueue()（50ms 批量 + 进程退出前同步 flush）:
  BEGIN;
  INSERT INTO SentLog ... VALUES (...);      // 确定性 pk 冲突 → INSERT OR IGNORE（幂等）
  COMMIT;
  // 失败：保留队列头 + log('store.flushQueue', err)；下次 flush 重放（幂等保证不重不丢）

confirmSend():
  entry.confirmed = true / confirmedAt        // 内存
  UPDATE PendingQueue SET confirmed=1, confirmedAt=? WHERE pendingId=?   // 单行同步写（确认是关键路径，同步）
```

要点：
- **限额判定永远读内存**（μs 级），SQLite 不做热路径；
- **关键确认同步写**（PendingQueue 状态机不可乱序），流水表异步批量；
- 进程 SIGTERM 时先 `flushQueue()` 再关 db（对齐 §3.2 已修优雅退出，纳入 shutdown）；
- 崩溃窗口（flush 前挂）最多丢 50ms 流水 → 重启载入略少 1 条，**限额偏保守**（少计=放行，
  方向安全：风控上宁可少计不超发，超发由合规闸门兜底）；若要严格，落库窗口降到 10ms 或改同步。

### 4.3 兜底：内存与 db 不一致

- 内存热账本行数 < db 行数且差 > 1%（载入失败/部分丢失）→ 以 db 为准重载（重载耗时
  24h COUNT 走索引 < 10ms）；
- getAuditSummary 改为「内存 recentSent（本进程）+ db 聚合（跨重启）」合并口径。

### 4.4 注入 vs 持久化 · 读写合并策略（打回 #1 + #2 修订）

**问题**：L579 `rollbackLastTalk` 现状 `Array.isArray(opts.sentLog) ? opts.sentLog : sentLog`
注入优先序，若注入方仍给静态内存数组，持久化账本被绕过；`withinRateLimit` 只读内部
`sentLog`，注入方账本不进限频判定 → 24h 限额可绕过。

**断言核实（打回 #1 · code-reviewer 实测）**：tests/talk-rollback L57/58/76/77 直接断言
`talkEngine._sentLog.length` / `_sentLog[i].blocked` / `_sentLog[i].pending`（数组语义）；
tests/send-confirm L205/221/222/226 直接 `talkEngine._pendingQueue.push(...)`。
→ **修订选法 (a)（最小改动，不破断言）**：

1. **导出形状不变（数组是快照读接口，句柄是写入口）**：
   - `_sentLog` / `_pendingQueue` **保持原始数组导出形状**（talkEngine 内部维护，
     供旧测试断言与快照读），**不换成 LedgerHandle**；
   - **LedgerHandle 另开 `_ledger` 句柄注入**：`createTalkEngine({ store, ledger, ... })`
     新增可选参数 `ledger`（store 导出的句柄对象），与 `opts.sentLog` / `opts.pendingQueue`
     并存不互斥；
   - 旧测试不传 `ledger` → talkEngine 内部 fallback 用 NoopLedger（§4.4.3），_sentLog /
     _pendingQueue 数组语义完整保留，4 处断言（talk-rollback L57/58/76/77 + send-confirm
     L205/221/222/226）不破。
   - 生产路径（server/index.js 组装）传 `ledger`（store.loadRateLedger 返回的句柄）→
     写走句柄，_sentLog / _pendingQueue 数组作快照读（每 1s 异步同步一次，供断言与
     getAuditSummary 用，不进限频判定）。

2. **LedgerHandle 接口（store 导出，新增）**：
   ```
   LedgerHandle = {
     push(row),                // 写：进内存热账本 + 异步落库队列（§4.2）
     since(t, dim),            // 读：内存热账本（24h/72h 窗，含启动快照 + 本进程新写）
     lastFor(contactId),       // rollbackLastTalk 专用：热账本查最近一条（跨重启有效）
     flush(), syncFlush(),     // SIGTERM 前同步
     snapshot(),               // 返回当前热账本数组快照（供 _sentLog / _pendingQueue 同步）
   }
   ```

3. **NoopLedger 降级（旧测试 + 注入裸数组场景）**：
   - `class NoopLedger` 实现 push/since/lastFor/flush/snapshot 五方法，**底层是数组**
     （不接 db），since/lastFor 只读本进程数组（无跨重启）；
   - 注入方传裸数组（`opts.sentLog` 是 Array）→ talkEngine 内部 `ledger = new NoopLedger(opts.sentLog)`
     包装，**只读不写回**（NoopLedger.push 只更新内部包装数组，不回写注入方原始数组引用，
     避免「写回污染」注入方状态）；
   - **NoopLedger 负例哨兵（打回 #4 · 抄送 qa-lead 纳入 task-4 111 基线）**：
     加一条对抗测试「NoopLedger 降级 + 注入静态数组预置 24h 内 2 条 → 第 3 条生成
     仍放行（24h 限额可绕）」，**验证降级路径的绕过是预期行为**，作为「生产走
     LedgerHandle 不降级」的回归哨兵——若生产路径误走 NoopLedger 仍能绕 24h，说明
     server/index.js 组装漏传 ledger，测试应红。

4. **L579 读源判定（打回 #2 · 优先序矛盾修订）**：
   - **现状**：`L579 const sent = Array.isArray(opts.sentLog) ? opts.sentLog : sentLog`
     注入优先；
   - **修订后读源规则**（明确，消除「句柄是唯一写入口 vs 注入优先」矛盾）：
     - **有 `ledger` 句柄（生产路径）**：`L579 改读 ledger.lastFor(contactId)`（跨重启
       有效，合并视图 = 启动快照 + 本进程），**忽略 `opts.sentLog` 静态数组**（注入方
       静态数组此时只作 NoopLedger 包装源，不进限频判定）；
     - **无 `ledger` 句柄（旧测试 fallback NoopLedger）**：`L579 仍读
       Array.isArray(opts.sentLog) ? opts.sentLog : sentLog`（现状行为，不破旧断言）；
     - 判定式（实施伪码）：`const source = ledger ? ledger.lastFor(cid) : (Array.isArray(opts.sentLog) ? opts.sentLog.slice().reverse().find(...) : sentLog.slice().reverse().find(...))`；
   - **注入契约失效场景处理**：注入方传静态数组 + 内部同时有 LedgerHandle 时 →
     **LedgerHandle 优先**（静态数组降级为 NoopLedger 包装源只读），写只走 LedgerHandle，
     静态数组不回写（避免「注入方仍走内存可绕过」残留）；
   - 验收：加一条测试「注入静态数组（预置 24h 内 2 条）+ 传 LedgerHandle（空）→ 第 3 条
     生成被 24h 拦（LedgerHandle 优先，静态数组不算）」。

5. **读写合并规则（关键：限额判定永远读「快照 + 本进程」合并视图）**：
   - `withinRateLimit` 读 = `ledger ? ledger.since(dayAgo, {accountId, contactId}) : sentLog.filter(...)`
     → 有句柄时内部 = 启动快照行（ts 来自 db，只读）+ 本进程 push 行（未 flush 的也在内存里）；
     **不查 db**（快照载入后 db 只作追加源，避免读放大与锁竞争）；无句柄（NoopLedger
     降级）时退回现状 `sentLog.filter`（不破旧测试）；
   - `rollbackLastTalk` 读 = 上述 L579 读源判定（§4.4.4）；
   - 写 = 一律 `ledger.push`（有句柄时），**禁止绕过 LedgerHandle 直接写 db 或裸数组**——
     这是「注入方仍走内存可绕过」的根治点：句柄是唯一写入口（NoopLedger 降级路径除外，
     负例哨兵覆盖）；

6. **(ts, seq) 字典序（打回 #4 · 补进合并规则）**：
   - `since(t, dim)` 返回时对「快照行 vs 本进程 push 行」做 ts 边界比较时，按
     **(ts, seq) 字典序**（先 ts，ts 相同按 seq 升序）——`SentLog.seq` 字段设计有
     （§1.1），合并规则显式写明；
   - 伪码：`rows.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq))`；
   - 确定性 pk（sha1(accountId|contactId|ts|kind|seq)）+ INSERT OR IGNORE 保证
     崩溃重放不重复计数，(ts, seq) 字典序在重放后仍单调（seq 由同 (accountId, ts)
     内行序分配，重放走 pk 去重不产生新 seq）。

---

## 5. 与 task-① 嵌套 schema 的挂接点（协同约定）

1. 本文三张表 **先自含三级字段**（accountId / contactId / conversationId 为普通列），
   不挂外键，保证 task-① 未定稿也能开工；
2. task-① 定稿后一次性迁移：`ALTER TABLE ... ADD CONSTRAINT` 不可行（SQLite 无
   ALTER ADD FK），走 **建新表 + 拷贝 + 切名** 脚本（store.js 里已验证过的
   _migration 版本化模式，v3 登记）；
3. 外键列顺序对齐嵌套 schema：SentLog/PendingQueue 的 conversationId 用
   sha1(accountId|contactId|channel) 幂等拼，与 Conversation 主键同构，零映射成本；
4. 两单并行出设计、实施串行：本文先落（v3 自含三级字段无外键版本），task-① task-2
   v2 定稿后跑 v4「建新表+拷贝+切名」挂 task-2 外键；_migration 版本序：v1(M0 14 实体) →
   v2(task-2 外键源表) → v3(task-3 账本表) → v4(账本表挂外键迁移)。

---

## 6. 验收口径（给 code-reviewer 的 checklist）

- [ ] schema.sql 增 3 表 + _migration v2，跑 `openDb` 幂等（IF NOT EXISTS）；
- [ ] store 导出 loadRateLedger / flushQueue / archiveRateLedgers，**零新增空 catch**；
- [ ] talkEngine 的 sentLog/pendingQueue 换为注入账本（接口不变，_sentLog 测试断言仍过）；
- [ ] **打回 #1（注入合并，选法 a）**：`_sentLog` / `_pendingQueue` 保持原始数组
  导出形状（不破 talk-rollback L57/58/76/77 + send-confirm L205/221/222/226 共 4 处断言）；
  LedgerHandle 另开 `_ledger` 句柄注入（createTalkEngine 新增可选参数 ledger）；旧测试不传
  ledger 走 NoopLedger 降级；生产组装（server/index.js）传 ledger；`rollbackLastTalk` L579
  有句柄改读 `ledger.lastFor`（跨重启有效），无句柄保持现状注入优先；`withinRateLimit`
  有句柄读「快照+本进程」合并视图（注入方静态数组不再能绕 24h 限额）；
  - [ ] **打回 #2（L579 优先序）**：加测试「注入静态数组 + 传 LedgerHandle → LedgerHandle
  优先，静态数组降级 NoopLedger 只读不回写」；
  - [ ] **打回 #3（§2 expire 语义）**：PendingQueue 新增 `expired` 列；72h expire =
  UPDATE expired=1（confirmed 行 72h 内不被置 1）；物理归档只按行量阈值 + 过 72h 时间窗，
  含 expired+confirmed 全量；confirmed 行 72h 内既不 expire 也不归档；
  - [ ] **打回 #4（(ts,seq) 字典序 + NoopLedger 负例哨兵）**：since(t) 合并按 (ts, seq)
  字典序（ts 相同 seq 升序）；NoopLedger 降级 + 注入静态数组预置 24h 内 2 条 → 第 3 条
  生成仍放行（**验证降级路径可绕 24h 是预期行为**，作「生产走 LedgerHandle 不降级」的
  回归哨兵，抄送 qa-lead 纳入 task-4 111 基线）；
  - [ ] **跨单协同（_migration 版本）**：task-3 占 v3（task-2 占 v2）；本文 §1.4 / §5 已改 v3；
  task-3 v3 表挂 task-2 外键（顺序：v2 先建外键源表 → v3 建账本表挂外键）；
- [ ] **挂账 #2（裁剪窗）**：SentLog 归档 cutoff ≥ max(24h, 30min remindWindow, 7 天缓冲)，
  归档后 `ctx.alreadyReminded` / `kind=remind` 判定数据仍在；加一条 remind 窗口测试
  （30min 内二次 remind 不重发）；
- [ ] **挂账 #3（快照只读）**：loadRateLedger 载入后，SentLog 快照行对内存热账本只读，
  本进程写只走 LedgerHandle.push 追加；withinRateLimit 实时 Date.parse 边界与快照
  拼接无时钟漂移（加一条时钟前移测试：fake now +5min 后快照+新写仍单调）；
- [ ] 24h 限额跨重启：重启后 withinRateLimit 结果与重启前一致（23 口径全量测试）；
- [ ] 全量测试：`node --test tests/*.test.js server/db/*.test.js server/acquisition/*.test.js` 全绿；
- [ ] 新测试 db 一律 os.tmpdir()（§6 规范，不留 data/ 垃圾）；
- [ ] 归档分片文件命名含月 + 账号，单文件 < 50MB。
