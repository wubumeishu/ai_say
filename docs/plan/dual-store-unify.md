# docs/plan/dual-store-unify.md · 双存储统一（JSON→SQLite 迁移，兼容 [平台ID-账号ID-会话ID] 三级嵌套）

> 作者：System_Architect（task-2 交付物；DBA 协审 schema 口径，code-reviewer 审无 Breaking Change，backend-lead 后续实施）
> 依据：终极蓝图 §-1.1（群控基座三级嵌套）、AGENTS.md §3.7（双轨分叉）、§6（群控基座新数据模型一律三级嵌套）
> 现状基线：schema.sql 14 实体 M0 已建；**三级嵌套骨架（Account/WindowInstance/Conversation）已在 schema 里落地**；本单不删旧表，只补齐缺失的三级表 + 迁移归位 + 双写策略。
> 结论先行：**三级嵌套 schema 已 80% 就位，本单核心是「迁移归位 + 双写策略 + 补齐缺失表」，不是推倒重建。**

---

## 0. 现状勘察 · 三轨存储差异矩阵

### 0.1 三轨（不是双轨）总览

| 轨 | 载体 | 写入方 | 读取方 | 主键/键结构 |
|---|---|---|---|---|
| JSON 轨 | data/contacts.json + conversations.json + account-profiles.json | app.js 旧 /api/*（store.js legacy 182 行） | app.js /api/*、profileInspector、messageMonitor | **三元组字符串键** platform/windowId/contactKey |
| SQLite 轨 | data/aisay.db（14 表） | consoleRoutes /api/console/*（db/store.js M0） | consoleRoutes、recommender、talkEngine、dedup | **三级嵌套 PK**（accountId/contactId/conversationId = sha1） |
| 缓存轨 | data/console-cache.json（ichigoCache 三层） | deepScrape 抓取后写 | consoleRoutes live/* + assistant.js | **contactId 字典键**（收件箱快照/历史/资料 三层） |

> 关键发现：「双轨」其实是**三轨**，缓存轨（ichigoCache）是第三份数据分叉源，且它已经是「三级」结构（contactId 唯一、消息/画像/收件箱三层分缓存），是离三级嵌套最近的一份。统一时**缓存轨最先归位**（改动最小、语义最清晰），JSON 轨最后切换。

### 0.2 JSON 轨 vs SQLite 轨 字段差异矩阵（逐表）

**Account / AccountProfile（账号资料）**

| 字段 | JSON（account-profiles.json 条目） | SQLite Account + WindowInstance + AccountPersona | 归位规则 |
|---|---|---|---|
| key（三元组字符串） | platform/windowId/label | Account.legacyKey | 三元组 → legacyKey；解析出 platform→平台ID、windowId→WindowInstance、label→Account.label |
| platform | 平台显示名 | Account.platform（字符串） | **升级为 Platform 表引用**（见 §1.3）；旧字符串=provider label，非硬编码 |
| windowId | 窗口ID | WindowInstance.windowId | 直接对应（一窗口一账号） |
| accountLabel / nickname | 标签 | Account.label | 对应；nickname 并入 label |
| pageUrl / mypageUrl | 字符串 | AccountPersona（无对应列） | **新增** AccountPersona.pageUrl/mypageUrl 或留 raw JSON（§1.2） |
| fields / sections / lines / nextLevelPages / bottomNav / detection / navigation / raw | 大 JSON 块 | 无对应 | **新增** AccountProfileRaw（JSON 桶表，见 §1.2）承接，不拆细字段 |
| createdAt / updatedAt | ISO | 对应 | 直接迁 |

**Contact / 客户**

| 字段 | JSON（contacts.json 条目） | SQLite Contact + ContactAnchor + ContactProfile | 归位规则 |
|---|---|---|---|
| key（三元组） | platform/windowId/contactKey | Contact.legacyKey + ContactAnchor(value=legacyKey, kind=weak, source=legacy) | 三元组→legacyKey；弱锚点保留（schema 已有） |
| contact.name | 显示名 | Contact.displayName | 直接迁 |
| contact.candidates | 数组（候选客户列表） | ContactProfile.interests（JSON）或**新增** candidates 列 | 语义=候选锚点列表，建议入 ContactProfile.candidates JSON（§1.2） |
| contact.age/region/height/intro/loginMethod | 字符串 | ContactProfile.age/region/height/… | loginMethod=LINE **强锚点来源**（§1.3 升 strong） |
| profileUrl | 字符串 | 无对应 | 新增 Contact.profileUrl |
| createdAt/updatedAt | ISO | 对应 | 直接迁 |

**Conversation / 会话**

| 字段 | JSON（conversations.json 条目） | SQLite Conversation + Message | 归位规则 |
|---|---|---|---|
| key（三元组） | platform/windowId/contactKey | Conversation.legacyKey | 直接 |
| contactName / contact | 对象 | Conversation.contactId（查 Contact） | 由 contactKey 派生 contactId（sha1 weak） |
| messages[] | 数组 | Message（append-only，seq 去重） | 逐条迁；messageId=sha1(convId|seq|original) 幂等（schema 已定） |
| messages[].index/text/original/translation/role/time/kind/url/name/selector/className/group | 混合 | Message 各列 + raw JSON 兜底 | 已对齐（schema Message 列齐全，selector/className 进 raw） |

**缓存轨 ichigoCache（第三轨，最先归位）**

| 字段 | JSON（console-cache.json contacts[contactId]） | SQLite | 归位规则 |
|---|---|---|---|
| contactId | 字典键（q token） | Contact.contactId（**强锚点候选**） | contactId=平台会话唯一 ID，升级 strong 锚点 source=chat |
| name/age/region/ageNum | 快照字段 | ContactProfile | 迁（ageNum 新增，§1.2） |
| lastMsg/lastMsgTime/lastMsgTimeSeen/lastMsgTimeNotified/unread | 未读判定 4 字段 | **无对应** | **新增** Conversation 未读 4 列（§1.2，收件箱未读是控制台核心交互） |
| onlineTier | 在线分档 | **无对应** | 新增 Conversation.onlineTier |
| avatarUrl/avatarIsDefault | 头像 | **无对应** | 新增 Contact.avatarUrl + avatarIsDefault |
| historyUrl/profileUrl | URL | **无对应** | 新增 Conversation.historyUrl + Contact.profileUrl |
| messages/profile（延迟加载缓存） | 两层 | Message / ContactProfile.fields | 迁，messagesFetchedAt/profileFetchedAt 进 raw |

### 0.3 数据一致性风险（现网分叉点）
1. **同名客户跨轨两套 ID**：JSON 轨 contactKey=平台域名（弱，三元组内），SQLite contactId=sha1(weak/…)。同一客户在 JSON 与 SQLite 各一条，去重算法（dedup.js）只在 SQLite 内跑 → 跨轨未归并。
2. **未读态只在缓存轨**：Conversation 表无 unread 列，控制台「new 角标」完全依赖 ichigoCache，缓存丢了未读态清零（AGENTS.md §3.6 同因）。
3. **accountLabel 命名漂移**：JSON accountLabel=端口号误作 label，settings 真实 label 未对齐。

---

## 1. 三级嵌套 schema 设计（新增/补齐，不删旧表）

### 1.1 现有骨架（已就位，不动）
- **Account**（pk accountId=sha1(acc/platform/windowId/label)；platform TEXT + legacyKey）
- **WindowInstance**（pk windowId；→Account，同账号多窗口群控位）
- **Conversation**（pk conversationId=sha1(accountId|contactId|channel)；→Account+Contact+channel）
- **Contact / ContactAnchor / ContactProfile**（客户 + 强弱锚点 + 画像）
- **AccountPersona / GovernanceRule / LeadEvent / Message / MergeEvent / Tag / LineBind / LineMember**

### 1.2 本单新增表/列（最小增量，全部 ADD，零 DELETE/RENAME）

**新增 1 · Platform 表（平台ID 维度，群控多平台基座）**
sql 代码块：
CREATE TABLE IF NOT EXISTS Platform (
  platformId  TEXT PRIMARY KEY,        -- 归一化 provider key（ikuru=sp.194964.com）
  provider    TEXT NOT NULL,            -- 枚举：ikuru / line / fb / whatsapp / …
  label       TEXT NOT NULL DEFAULT '',-- 运营可读名（旧 Account.platform 字符串迁入）
  baseUrl     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS PlatformGroup (         -- 群控分组（账号可自由分组，蓝图 §-1.1）
  groupId   TEXT PRIMARY KEY,
  label     TEXT NOT NULL DEFAULT '',
  parent    TEXT,                                  -- 支持嵌套分组
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS AccountGroup (
  groupId   TEXT NOT NULL REFERENCES PlatformGroup(groupId),
  accountId TEXT NOT NULL REFERENCES Account(accountId),
  seq       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (groupId, accountId, seq)
);
迁移期 Platform.provider='ikuru' 固定一行（sp.194964.com），Account.platform 字符串 → 解析 provider 归 Platform.platformId；Account 新增 platformId 外键列（§1.4 加列）。

**新增 2 · 列补齐（ADD COLUMN，不删旧列）**
- Conversation：avatarUrl / avatarIsDefault / historyUrl / profileUrl / onlineTier / lastMsgTimeSeen / lastMsgTimeNotified / unread（未读 4 字段 + 在线分档 + 头像，全部 DEFAULT，幂等 ADD）
- Contact：avatarUrl / avatarIsDefault / profileUrl / candidates(TEXT, JSON 候选锚点)
- ContactProfile：ageNum (INTEGER, 数字年龄，防幻觉铁律用)
- Account：platformId (TEXT, fk→Platform，迁移期允许空)
- AccountPersona：pageUrl / mypageUrl

**新增 2.1 · ADD COLUMN 幂等实现口径（code-reviewer 打回 1）**
- SQLite **不支持** `ALTER TABLE ADD COLUMN IF NOT EXISTS`；schema.sql 被 openDb 每次启动 db.exec 重跑，裸 ADD COLUMN 第二次执行会报 duplicate column。
- 实施口径（backend-lead 落 server/db/migrateUnify.js）：
  1. schema.sql 里 **不直接写** `ALTER TABLE ... ADD COLUMN` 进主 DDL；新列由独立迁移批次 `server/db/migrations/002_add_columns.sql.js` 承载（JS 模块，非纯 .sql）。
  2. 每列加列前先探测：`const cols = db.prepare('PRAGMA table_info(Conversation)').all().map(r=>r.name)`；缺哪列才 `ALTER TABLE Conversation ADD COLUMN …`（逐列 try，catch 捕获 'duplicate column' 静默跳过——**catch 必 log 模块.动作+错误**，铁律 §0.5，不得空 catch）。
  3. 探测结果写 _migration 批次标记（version 字段），幂等可重跑。
  4. 新表（Platform/PlatformGroup/AccountGroup/InboxSnapshot/AccountProfileRaw）用 CREATE TABLE IF NOT EXISTS，可直接进 schema.sql 主 DDL（天然幂等）。
- schema.sql 增量落盘方式：新表 CREATE IF NOT EXISTS 进 schema.sql；新列 ALTER 进独立迁移 JS（002_add_columns）；二者都在 openDb 时按 _migration.version 顺序应用，先 CREATE 后 ALTER。

**新增 3 · 未读态与收件箱快照落库（缓存轨归位的核心）**
sql 代码块：
CREATE TABLE IF NOT EXISTS InboxSnapshot (
  contactId     TEXT NOT NULL REFERENCES Contact(contactId),
  accountId     TEXT NOT NULL REFERENCES Account(accountId),
  lastMsgTime   TEXT NOT NULL DEFAULT '',
  unread        INTEGER NOT NULL DEFAULT 0,
  onlineTier    TEXT,
  fetchedAt     TEXT NOT NULL,
  PRIMARY KEY (contactId, accountId)
);
CREATE TABLE IF NOT EXISTS AccountProfileRaw (      -- 大 JSON 桶：fields/sections/nextLevelPages…
  accountId  TEXT PRIMARY KEY REFERENCES Account(accountId),
  payload    TEXT NOT NULL,                          -- JSON：{fields,sections,lines,nextLevelPages,bottomNav,detection,navigation,raw}
  updatedAt  TEXT NOT NULL
);
设计原则：三级嵌套=Platform→Account(+WindowInstance+AccountGroup)→Conversation(+InboxSnapshot)；客户维度=Contact(+ContactAnchor+ContactProfile)独立于账号（三要素隔离 §-1.3）。缓存轨的未读 4 字段进 InboxSnapshot（按会话+账号隔离），画像进 ContactProfile，**落库互不污染**。

### 1.3 锚点升级规则（三元组归位核心）
- 迁移期所有 JSON 轨 record → **weak 锚点**（kind=weak, source=legacy, value=三元组字符串）。
- 缓存轨 contactId（平台 q token）→ **升级 strong 锚点候选**（kind=strong, source=chat），同一客户多 contactId 由 dedup.scanLikelySame 归并，归并写 MergeEvent（可回滚）。
- 账号侧 loginMethod=LINE → 预留 strong 锚点（M4 LineBind）。
- **幂等保证**：anchorId=sha1(contactId|kind|value)，重复跑只 INSERT OR IGNORE，不重复造锚点。

### 1.4 路由命名空间预留（与 console-routes-split.md §2 协同）
- Platform 表就位后，consoleRoutes 中枢加前缀路由表：/api/console/{platformId}/…（platformId 段可省略=默认平台 ikuru，向后兼容）；本次只定 schema + 路由表接口，不落地多平台路由（属 Phase 4）。

---

## 2. 迁移脚本设计（伪码，幂等可重跑）

> 执行顺序：**Platform→Account→WindowInstance→Contact→ContactAnchor→ContactProfile→Conversation→Message→InboxSnapshot→AccountProfileRaw**。每步事务 + 计数 + dryRun 报告。

伪码块：
migrate = (rootDir, { dryRun }) => {
  // 0. 读三轨源（JSON 轨 3 文件 + 缓存轨 1 文件 + SQLite 现状）
  const json = {
    contacts: readJson('data/contacts.json'),
    conversations: readJson('data/conversations.json'),
    profiles: readJson('data/account-profiles.json'),
    cache: readJson('data/console-cache.json').contacts || {},   // 缓存轨（第三轨）
  };

  // 1. Platform 归位（平台ID 维度）
  ensurePlatform({ provider:'ikuru', label:'自用出会', baseUrl:'sp.194964.com' });

  // 2. 账号归位：三元组 (platform,windowId,label) → Account(+WindowInstance)
  for (p of json.profiles) {
    const accountId = sha1('acc/'+p.platform+'/'+p.windowId+'/'+p.accountLabel);
    upsertAccount({ accountId, platformId, label, legacyKey: p.key, pageUrl, mypageUrl });
    if (p.windowId) upsertWindow({ windowId, accountId });
    upsertAccountProfileRaw({ accountId, payload: {...p.fields, p.sections, ...} });  // 大 JSON 桶
  }

  // 3. 客户归位：JSON 三元组 + 缓存 contactId 双源 → Contact(+Anchor+Profile)
  const contactMap = {};   // (platform,windowId,contactKey) → contactId
  for (c of json.contacts) {
    const cid = sha1('weak/'+c.key+'|'+c.contact?.name);
    upsertContact({ contactId: cid, displayName, nickname, legacyKey: c.key, avatarUrl, profileUrl, candidates });
    upsertAnchor({ anchorId: sha1(cid+'|weak|'+c.key), contactId: cid, kind:'weak', value:c.key, source:'legacy' });
    upsertProfile({ contactId: cid, age, region, height, ageNum, ... });
  }
  // 缓存轨 contactId（平台 q token）→ strong 锚点候选
  for ([cid, snap] of Object.entries(json.cache)) {
    upsertContact({ contactId: cid });
    upsertAnchor({ anchorId: sha1(cid+'|strong|'+cid), contactId: cid, kind:'strong', value: cid, source:'chat' });
    upsertProfile({ contactId: cid, ageNum: snap.ageNum, ... });
    upsertInbox({ contactId: cid, accountId, lastMsgTime: snap.lastMsgTime, unread: snap.unread, onlineTier: snap.onlineTier });
  }

  // 4. 会话归位：JSON conversations → Conversation(+Message)
  for (cv of json.conversations) {
    const cid = contactMap[cv.key];            // 由客户归位查表
    const convId = sha1(accountId+'|'+cid+'|platform_dm');
    upsertConv({ conversationId: convId, accountId, contactId: cid, legacyKey: cv.key, historyUrl });
    for (let i=0; i<cv.messages.length; i++) {
      const msg = cv.messages[i];
      upsertMsg({ messageId: sha1(convId+'|'+(msg.index??i)+'|'+(msg.original||msg.text||'')), conversationId: convId, ...msg });  // INSERT OR IGNORE 幂等
    }
  }

  // 4.5 跨轨归并去重（code-reviewer 打回 2 + 节点 1 backend-lead 裁定修订）：
  //      JSON 轨 weak contactId 与缓存轨 q-token contactId 不同源 → 迁移后主动按 ContactAnchor.value 反查跨轨对
  //      方向：survivor = strong(source=chat, 缓存 q-token)；merged = weak(source=legacy, JSON 三元组)
  //      注意：不依赖 dedup.scanLikelySame()（读的是已入队列的 likelySame 候选，迁移期队列里尚无跨轨候选）
  const crossPairs = db.prepare(
    "SELECT a.contactId AS survivorId, w.contactId AS mergedId " +
    "FROM ContactAnchor a " +
    "JOIN ContactAnchor w ON a.value = w.value " +
    "WHERE a.kind='strong' AND a.source='chat' " +
    "  AND w.kind='weak' AND w.source='legacy' " +
    "  AND a.contactId != w.contactId"
  ).all();
  for (const p of crossPairs) {
    store.mergeContact(p.survivorId, p.mergedId, 'cross-track-unify', 'weak');
    // 归并后 Conversation.contactId 指向 survivor（store.mergeContact 已处理），消息历史保留
  }

  // 5. 校验 + 报告（dryRun 不落盘；实跑打事务）
  return { migrated: { accounts, contacts, convos, msgs, anchors, inbox, merged: crossPairs.length }, skipped: n, dryRun };
}

> **跨轨归并去重口径（打回 2 + 节点 1 backend-lead 裁定修订）**：
> - JSON 轨 contactId = sha1('weak/三元组|displayName')（弱锚点），缓存轨 contactId = 平台 q token（强锚点 source=chat）。
> - 同一真实客户在两轨各有独立 contactId，**迁移后主动按 ContactAnchor.value 精确匹配反查跨轨对**（不依赖 dedup.scanLikelySame，因迁移期 likelySame 队列尚空）。
> - 归并方向：strong 锚点（kind='strong' AND source='chat'，缓存 q-token）为 survivor，weak 锚点（kind='weak' AND source='legacy'，JSON 三元组）为 merged，store.mergeContact 写 MergeEvent（可一键回滚）。
> - 误并护栏：只有 ContactAnchor.value 完全相同才归并（精确匹配）；姓名+地区模糊匹配走 candidateMergePairs 人工确认队列，不在迁移期自动做。
> - 归并在会话归位（第 4 步）之后、校验（第 5 步）之前执行，保证 Conversation.contactId 最终指向 survivor。
> - **/api/console/inbox/unread 端点落盘时序（裁定 2）**：节点 1（Phase A 双写期）只落 InboxSnapshot 表 + 缓存轨归位写逻辑；端点本身留 Phase B 切单轨后启用，避免过渡期双源（§3.1 第 3 条）。

**幂等与 provenance**：
- 全 PK/锚点都是内容寻址 sha1，重跑只 INSERT OR IGNORE / ON CONFLICT，零重复。
- 每条迁移 record 带 provenance = { source: 'legacy-json' | 'cache', key: 三元组, migratedAt }（进 raw JSON 桶或 _migration 批次表），**历史可溯源**。
- _migration 表加版本 2：INSERT OR IGNORE (2, now, '双轨统一：三级嵌套 + 缓存轨归位')。

**_migration 版本协同（跨单）**：task-2 占 v2（三级外键源表 + 缓存轨归位），task-3 占 v3（频控账本三表挂 v2 外键）。版本序：v1(M0 14 实体) → **v2(task-2 外键源表，本文)** → v3(task-3 账本表) → v4(账本表挂外键迁移)。本文 §2 保持 v2 不动；task-3 文档已同步改为 v3。

**与 task-3（频控账本落库）协同**：本单先定稿三级嵌套 schema（Platform/Account/Conversation 表 + 外键），task-3 的 SentLog/RateLedger 挂 accountId + platformId 外键（§1.2 的 Account.platformId 列就是挂载点）。**schema 定稿顺序：本单先行**，task-3 依赖本单外键；若 dba 并行出 task-3 schema，则 task-3 自含 platformId/accountId 三级字段，本单定稿时合并。

---

## 3. 双写过渡期策略 + 回滚

### 3.1 双写（Phase A，过渡 1-2 周）
1. **SQLite 为主轨，JSON 为影子**：store.js（M0）写 SQLite 的同时，镜像写 JSON 三文件（保留旧 shape，兼容未切的旧 /api/* 读方）。镜像写**不改变 JSON 语义**（仍三元组键），只保证数据一致。
2. **缓存轨归位优先**：ichigoCache 写 SQLite InboxSnapshot（新列）后，console-cache.json 变只读快照（不删），控制台「new 角标」改读 SQLite。
3. **new 角标读 SQLite 契约（code-reviewer 打回 3）**：
   - consoleRoutes 新增端点 `GET /api/console/inbox/unread`（只读，归 actions.js 域）：
     ```
     GET /api/console/inbox/unread?accountId= &limit=
       → 200 {
           ok: true,
           data: [
             { contactId, accountId, name, unread, lastMsgTime, onlineTier, fetchedAt }
           ],
           total: n
         }
     ```
     - 数据源 = InboxSnapshot（SQLite，§1.2 新表）按 unread>0 过滤，JOIN Contact.displayName。
     - 前端 ichigo-console.html 角标改读此端点（替代直接读 console-cache.json 内存态）；轮询间隔 = 收件箱轮询周期（2min），命中 unread>0 显示 new 角标。
     - 旧前端过渡期仍读缓存（不变），新端点仅 Phase B 切单轨后启用（避免过渡期双源）。
4. **切读方**：consoleRoutes 全部读 SQLite（现状已满足）；旧 /api/* 仍读 JSON（过渡期不动）。

### 3.2 切单轨（Phase B）
- 旧 /api/* 写方逐个改调 store.js（M0，写 SQLite）；app.js 里 store.upsert* 全替换为 db/store 对应方法。
- 验证：JSON 与 SQLite 对账脚本（逐 key 比对 count + 抽样 diff），全绿后 JSON 转**只读归档**（加 .archive 后缀，不删，铁律 §1.12 清理谨慎）。

### 3.3 回滚
- **双写期回滚**=停镜像写，SQLite 回退前快照（backups/aisay-pre-unify-*.db，迁移前必打），JSON 始终有全量 → 随时回退单 JSON 轨。
- **切单轨后回滚**=SQLite 是主轨，JSON 归档只读；回滚=停 SQLite 写入、切读回 JSON 归档（仅过渡期有效，单轨稳定后回滚窗口关闭，改走蓝本回退）。
- 迁移脚本 dryRun 先行 + 事务 + 计数，失败可重跑（幂等），**不手工改库**。

### 3.4 风险清单
| 风险 | 等级 | 缓解 |
|---|---|---|
| 缓存轨 contactId（q token）跨窗口漂移 | 中 | strong 锚点 + dedup 归并 + MergeEvent 可回滚（§1.3） |
| accountLabel 命名漂移（端口号误作 label） | 低 | 迁移时 label 归一，settings.json 对齐（Phase 0 已外置密钥） |
| 大 JSON 桶（fields/sections）迁 SQLite 列宽度 | 低 | AccountProfileRaw 独立 JSON 桶表，不拆细列 |
| 双写期性能（写 2 份） | 低 | 镜像写异步 + 失败仅 log（铁律 §0.5 不吞错：catch 必 log 模块.动作） |
| 回滚窗口关闭后数据回退 | 中 | Phase B 稳定 1 周后关闭回滚窗口，此后走备份恢复 |
| 测试残留（data/ 16 个 test.db） | 中 | 迁移只读 aisay.db，test.db 不入迁移；清理走 §1.12 用户同意 |

---

## 4. 交付物与验收（给 backend-lead / code-reviewer）

- **本单交付**：本文档（差异矩阵 + 新 DDL + 迁移伪码 + 双写/切换/回滚 + 风险清单），不写业务代码。
- **实施拆分（backend-lead）**：
  1. schema.sql 增量（§1.2 新增表/列，ADD 幂等）→ DBA 协审；
  2. 迁移脚本 server/db/migrateUnify.js（§2 伪码，dryRun + 事务）→ 跑全量测试；
  3. 双写镜像（§3.1）→ 对账脚本 → 切单轨（§3.2）→ 回滚演练（§3.3）。
- **验收口径（铁律 §0.4）**：每步 node --test 全量（双口径 §1.6）；迁移 dryRun 计数与 JSON/缓存三轨对账一致；consoleRoutes + 旧 /api/* 双读冒烟；**不真发、不删 data/ 归档**。
- **Breaking Change 审查点（code-reviewer）**：
  - 全部 DDL 是 ADD/CREATE IF NOT EXISTS，零 DROP/RENAME → 无 schema Breaking；
  - store.js（M0）方法签名不变（upsertContact/upsertConversation 入参兼容旧 shape）→ 调用方零改；
  - JSON 轨保留只读归档，旧 /api/* 过渡期读方不受影响；
  - 新表 InboxSnapshot/AccountProfileRaw/Platform* 为新增，不碰旧 14 表数据。