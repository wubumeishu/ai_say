-- =============================================================================
-- Ai SAY M0 · SQLite DDL（14 实体）
-- 依据：docs/plan/02-datamodel.md §1（实体总览 + 核心字段定义）
-- 设计要点：
--   * 客户真主键 = 稳定身份锚点哈希（Contact.contactId）；旧 平台+窗口+标签
--     三元组降级为 ContactAnchor(kind='weak', source='legacy') 的 legacyKey；
--   * Message 只追加（append-only）：无 UPDATE 列，无 deletedAt，无 updatedAt；
--   * 档案合并不物理删除：Contact.mergedInto 指针 + MergeEvent 审计，可一键回滚；
--   * 索引覆盖高频查询：contactId / conversationId / accountId / scope+priority。
-- 适用：node:sqlite（Node ≥22.5，内置）或 better-sqlite3。
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Account · 平台账号（一个登录身份，可挂多窗口）
-- pk: accountId（归一化邮箱/手机号/平台内ID，迁移期用 legacy 三元组归一化占位）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Account (
  accountId   TEXT PRIMARY KEY,          -- 归一化身份；M0 迁移期 = sha1(platform/windowId/label)
  platform    TEXT NOT NULL,            -- 出会 / LINE / FB / WhatsApp / …
  label       TEXT NOT NULL DEFAULT '',  -- 运营可读名（旧 accountLabel）
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  legacyKey   TEXT,                     -- 旧三元组字符串（platform/windowId/label），可逆迁移用
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_platform  ON Account(platform);

-- -----------------------------------------------------------------------------
-- WindowInstance · 账号在某个浏览器窗口里的实例（旧三元组里的 windowId）
-- pk: windowId（BitBrowser 窗口 ID），一个窗口只属于一个账号
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS WindowInstance (
  windowId    TEXT PRIMARY KEY,
  accountId   TEXT NOT NULL REFERENCES Account(accountId),
  seq         INTEGER NOT NULL DEFAULT 0,   -- 同账号下窗口序号
  lastHealth  TEXT,                          -- 最近一次 CDP 健康检查时间
  legacyKey   TEXT,                          -- 旧三元组字符串
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_window_account  ON WindowInstance(accountId);

-- -----------------------------------------------------------------------------
-- AccountPersona · 账号人设（挂在 Account 下，与 ContactProfile 严格分离）
-- pk: personaId；一个账号可有多版本人设（当前用 status 区分 active/draft）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS AccountPersona (
  personaId        TEXT PRIMARY KEY,
  accountId        TEXT NOT NULL REFERENCES Account(accountId),
  persona          TEXT,   -- JSON：身份/背景故事/口吻基调
  tone             TEXT NOT NULL DEFAULT '',
  background       TEXT NOT NULL DEFAULT '',
  targetAudience   TEXT NOT NULL DEFAULT '',
  taboos           TEXT,   -- JSON array：禁忌词/禁忌话题
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft')),
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persona_account   ON AccountPersona(accountId, status);

-- -----------------------------------------------------------------------------
-- Contact · 客户（跨窗口/跨平台去重后的画像载体）
-- pk: contactId = 强锚点哈希（sha1(normalizedAnchorValue)）或归一化名+特征；
--     弱锚点 Contact 的 contactId = sha1('weak/' + legacyKey + '|' + normalizedFeature)
-- mergedInto: 归并指针，不物理删除（历史消息/档案仍在，聚合视图按根账号展示）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Contact (
  contactId     TEXT PRIMARY KEY,
  displayName   TEXT NOT NULL DEFAULT '',
  nickname      TEXT NOT NULL DEFAULT '',   -- 旧 label / 昵称
  mergedInto    TEXT,                        -- fk → Contact（归并指针，可空）
  firstSeen     TEXT NOT NULL,
  lastSeen      TEXT NOT NULL,
  lifecycle     TEXT NOT NULL DEFAULT 'new' CHECK (lifecycle IN ('new','active','silent','churned')),
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_merged_into  ON Contact(mergedInto);
CREATE INDEX IF NOT EXISTS idx_contact_lifecycle    ON Contact(lifecycle);

-- -----------------------------------------------------------------------------
-- ContactAnchor · 客户稳定身份锚点（真主键来源）
-- pk: anchorId = sha1(contactId + '|' + kind + '|' + value)
-- kind: strong（LINE openId/邮箱/手机号/平台内ID）| weak（设备指纹/归一化姓名特征/legacyKey）
-- legacyKey: 旧三元组字符串（platform/windowId/contactKey），以 kind='weak', source='legacy' 保留
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ContactAnchor (
  anchorId     TEXT PRIMARY KEY,
  contactId    TEXT NOT NULL REFERENCES Contact(contactId),
  kind         TEXT NOT NULL CHECK (kind IN ('strong','weak')),
  value        TEXT NOT NULL,       -- 邮箱 / LINE openId / 手机号 / 设备指纹 / 平台内ID / legacyKey
  confidence   REAL NOT NULL DEFAULT 0.5,
  source       TEXT NOT NULL DEFAULT '',  -- 首次来源渠道：chat / profile_page / line_api / legacy
  createdAt    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anchor_contact   ON ContactAnchor(contactId);
CREATE INDEX IF NOT EXISTS idx_anchor_value     ON ContactAnchor(value, kind);  -- 合并判定时按值反查

-- -----------------------------------------------------------------------------
-- ContactProfile · 客户画像（自动抽取器产出，独立于账号人设）
-- pk: contactId（1:1）；写入走单一 upsertContactProfile 路径
-- source: profile_page（资料页优先）| chat（聊天补充）| manual
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ContactProfile (
  contactId        TEXT PRIMARY KEY REFERENCES Contact(contactId),
  age              TEXT,
  region           TEXT,
  height           TEXT,
  occupation       TEXT,
  language         TEXT,
  intent           TEXT NOT NULL DEFAULT 'unknown' CHECK (intent IN ('casual','serious','transactional','unknown')),
  interests        TEXT,          -- JSON
  historySummary   TEXT NOT NULL DEFAULT '',
  fields           TEXT,          -- JSON：完整字段槽（17098 分组：基本/详细/兴趣/成人交友）
  confidence       REAL NOT NULL DEFAULT 0.5,
  source           TEXT NOT NULL DEFAULT 'chat',
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_contact   ON ContactProfile(contactId);

-- -----------------------------------------------------------------------------
-- Conversation · 会话（某账号 ↔ 某客户，按渠道）
-- pk: conversationId = sha1(accountId + '|' + contactId + '|' + channel)（幂等）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Conversation (
  conversationId   TEXT PRIMARY KEY,
  accountId        TEXT NOT NULL REFERENCES Account(accountId),
  contactId        TEXT NOT NULL REFERENCES Contact(contactId),
  channel          TEXT NOT NULL DEFAULT 'platform_dm' CHECK (channel IN ('platform_dm','line','fb','whatsapp')),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  lastActiveAt     TEXT NOT NULL,
  legacyKey        TEXT,          -- 旧三元组字符串
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
);
-- v5.3 · C 阶段多轮状态机：Conversation.followupStage 由 store.ensureFollowupColumns 探测式 ADD COLUMN（幂等）；
--   stage 语义：0=破冰 1=跟进中 2=约见面 3=已推ライン 4=私域(ライン已绑) 5=冷却/终止

-- -----------------------------------------------------------------------------
-- FollowupSop · 跟进 SOP 配置（v5.3 C 阶段；"第 N 天做动作 X" 的规则表）
-- 一条 SOP = 在 stage 停留满 afterDays 天 → 触发 kind 动作（用哪类话术）
-- pk: sopId = sha1('sop/' + scope + '/' + seq)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FollowupSop (
  sopId         TEXT PRIMARY KEY,
  scope         TEXT NOT NULL DEFAULT 'global',   -- global | platform | account
  accountId     TEXT,
  platform      TEXT,
  stage         INTEGER NOT NULL,                 -- 从哪个 stage 出发
  afterDays     INTEGER NOT NULL,                 -- 停留 N 天后触发
  actionKind    TEXT NOT NULL,                    -- care(关心) | nudge(软推进) | line-push(推ライン) | understand(理解退路) | meet(约见面)
  templateKey   TEXT,                             -- 指向 PhraseLibrary 的 scene/intent
  note          TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sop_stage ON FollowupSop(stage);


CREATE INDEX IF NOT EXISTS idx_conv_account   ON Conversation(accountId);
CREATE INDEX IF NOT EXISTS idx_conv_contact   ON Conversation(contactId);
CREATE INDEX IF NOT EXISTS idx_conv_lastActive ON Conversation(lastActiveAt);

-- -----------------------------------------------------------------------------
-- Message · 消息流水（append-only）
-- pk: messageId = sha1(conversationId + '|' + seq + '|' + original)（幂等，可去重）
-- 约束：只 INSERT，无 UPDATE 列（schema 层不含 updatedAt/deletedAt）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Message (
  messageId       TEXT PRIMARY KEY,
  conversationId  TEXT NOT NULL REFERENCES Conversation(conversationId),
  seq             INTEGER NOT NULL,      -- 会话内序号（迁移期 = 旧 messages[].index）
  role            TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('me','other','unknown')),
  original        TEXT NOT NULL,
  translation     TEXT NOT NULL DEFAULT '',
  timeText        TEXT,                  -- 旧 time.text
  timeIso         TEXT,                  -- 旧 time.iso（可空）
  kind            TEXT,                  -- 旧 kind（text/link/stamp…）
  name            TEXT,                  -- 旧 name（如 "♂爽快！さん"）
  url             TEXT,
  raw             TEXT,                  -- JSON：旧消息对象全量（含 selector/className/group 等观测字段）
  createdAt       TEXT NOT NULL          -- 只追加
);
CREATE INDEX IF NOT EXISTS idx_msg_conversation   ON Message(conversationId, seq);

-- -----------------------------------------------------------------------------
-- LeadEvent · 引流事件（03 章评分落库载体）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS LeadEvent (
  leadEventId     TEXT PRIMARY KEY,
  contactId       TEXT NOT NULL REFERENCES Contact(contactId),
  score           INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  tier            TEXT NOT NULL DEFAULT 'cold' CHECK (tier IN ('hot','warm','cold')),
  signals         TEXT,                  -- JSON：命中的会话信号 + 治理规则命中 id
  action          TEXT NOT NULL DEFAULT 'triggered' CHECK (action IN ('triggered','reminded','archived')),
  lineOffered     INTEGER NOT NULL DEFAULT 0,   -- bool
  lineAdded       INTEGER NOT NULL DEFAULT 0,   -- bool
  createdAt       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_contact   ON LeadEvent(contactId, createdAt);

-- -----------------------------------------------------------------------------
-- LineMember · LINE 官方账号（OA）私域成员
-- pk: openId
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS LineMember (
  openId          TEXT PRIMARY KEY,
  displayName     TEXT NOT NULL DEFAULT '',
  region          TEXT NOT NULL DEFAULT '',
  lineTag         TEXT,                  -- JSON
  bindPhone       TEXT,
  silentDays      INTEGER NOT NULL DEFAULT 0,   -- 30 天未互动移出（03 章）
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_linemember_phone   ON LineMember(bindPhone);

-- -----------------------------------------------------------------------------
-- LineBind · 平台客户 ↔ LINE 成员绑定
-- pk: bindId = sha1(contactId + '|' + openId + '|' + joinKey)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS LineBind (
  bindId          TEXT PRIMARY KEY,
  contactId       TEXT NOT NULL REFERENCES Contact(contactId),
  openId          TEXT NOT NULL REFERENCES LineMember(openId),
  joinKey         TEXT NOT NULL CHECK (joinKey IN ('phone','openId','deviceId')),
  confidence      REAL NOT NULL DEFAULT 0.5,
  createdAt       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_linebind_contact   ON LineBind(contactId);
CREATE INDEX IF NOT EXISTS idx_linebind_openid    ON LineBind(openId);

-- -----------------------------------------------------------------------------
-- Tag · 客户标签（03 章五层：source/intent/category/status/ops）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Tag (
  tagId           TEXT PRIMARY KEY,
  layer           TEXT NOT NULL CHECK (layer IN ('source','intent','category','status','ops')),
  value           TEXT NOT NULL,
  appliedTo       TEXT,                  -- JSON：contactId/openId 列表
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tag_layer   ON Tag(layer, value);

-- -----------------------------------------------------------------------------
-- GovernanceRule · 统一规则（全局生效，独立于账号人设与客户画像）
-- 下发契约：getEffectiveRules(scope) 按 global ⊃ platform ⊃ account 叠加，
-- 同层取 priority 高者；compliance 类未命中默认拒绝。
-- 索引按 (scope, priority) + status 覆盖高频下发查询。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS GovernanceRule (
  ruleId          TEXT PRIMARY KEY,
  ruleType        TEXT NOT NULL CHECK (ruleType IN ('compliance','speechBoundary','rateLimit','brandTone')),
  scope           TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','platform','account','channel')),
  scopeKey        TEXT,                  -- scope=platform/account/channel 时的具体值；global 为 NULL
  rule            TEXT,                  -- JSON：阈值/关键词/话术边界描述
  priority        INTEGER NOT NULL DEFAULT 0,  -- 高数字胜出；global 默认 0，platform 10，account 100
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft','deprecated')),
  effectiveFrom   TEXT,
  effectiveTo     TEXT,
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_govrule_scope_priority   ON GovernanceRule(scope, priority DESC, status);
CREATE INDEX IF NOT EXISTS idx_govrule_type             ON GovernanceRule(ruleType, status);

-- -----------------------------------------------------------------------------
-- MergeEvent · 合并审计记录（可审计可回滚）
-- 每次 merge 写一条；回滚 = 再写一条 direction='rollback' 指向原 mergeEvent
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS MergeEvent (
  mergeEventId        TEXT PRIMARY KEY,
  survivorContactId   TEXT NOT NULL REFERENCES Contact(contactId),
  mergedContactId     TEXT NOT NULL REFERENCES Contact(contactId),
  reason              TEXT NOT NULL DEFAULT '',
  anchorKind          TEXT NOT NULL CHECK (anchorKind IN ('strong','weak')),
  direction           TEXT NOT NULL DEFAULT 'merge' CHECK (direction IN ('merge','rollback')),
  rollbackOf          TEXT,              -- 回滚时指向原 mergeEventId
  createdAt            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merge_event_merged   ON MergeEvent(mergedContactId);
CREATE INDEX IF NOT EXISTS idx_merge_event_survivor ON MergeEvent(survivorContactId);


-- =============================================================================
-- task-2 双存储统一 · 群控基座三级嵌套（终极蓝图 §-1.1 [平台ID-账号ID-会话ID]）
-- 依据：docs/plan/dual-store-unify.md §1.2
-- 设计原则：全 ADD 幂等零删改，不碰旧 14 表；三要素隔离（人设/画像/上下文落库互不污染）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Platform · 平台维度（群控多平台基座；provider 不硬编码 ikuru，可扩 line/fb/whatsapp）
-- 迁移期 Platform.provider='ikuru' 固定一行（sp.194964.com），Account.platform 字符串解析归位
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Platform (
  platformId  TEXT PRIMARY KEY,        -- 归一化 provider key（ikuru=sp.194964.com）
  provider    TEXT NOT NULL,            -- 枚举：ikuru / line / fb / whatsapp / …
  label       TEXT NOT NULL DEFAULT '',-- 运营可读名（旧 Account.platform 字符串迁入）
  baseUrl     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- PlatformGroup / AccountGroup · 群控分组（账号可自由分组，蓝图 §-1.1）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PlatformGroup (
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

-- -----------------------------------------------------------------------------
-- InboxSnapshot · 未读态与收件箱快照（缓存轨归位的核心；§0.2 未读 4 字段 + 在线分档）
-- 按 [contactId, accountId] 隔离（三要素隔离：消息上下文按会话）；未读 4 字段 =
--   lastMsgTime / unread / lastMsgTimeSeen / lastMsgTimeNotified（控制台「new 角标」数据源）
-- Phase B 切单轨后前端改读 GET /api/console/inbox/unread（本单只落表，端点留 Phase B）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS InboxSnapshot (
  contactId     TEXT NOT NULL REFERENCES Contact(contactId),
  accountId     TEXT NOT NULL REFERENCES Account(accountId),
  lastMsgTime   TEXT NOT NULL DEFAULT '',
  unread        INTEGER NOT NULL DEFAULT 0,
  onlineTier    TEXT,
  fetchedAt     TEXT NOT NULL,
  PRIMARY KEY (contactId, accountId)
);

-- -----------------------------------------------------------------------------
-- AccountProfileRaw · 大 JSON 桶（fields/sections/lines/nextLevelPages/bottomNav/detection/navigation/raw）
-- 不拆细列，整包进 payload（§1.2 新增 2）；避免 JSON 列宽度膨胀
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS AccountProfileRaw (
  accountId  TEXT PRIMARY KEY REFERENCES Account(accountId),
  payload    TEXT NOT NULL,                          -- JSON：{fields,sections,lines,nextLevelPages,bottomNav,detection,navigation,raw}
  updatedAt  TEXT NOT NULL
);


-- =============================================================================

-- 迁移期平台种子：ikuru（sp.194964.com，出会平台）；provider 行幂等 INSERT OR IGNORE
INSERT OR IGNORE INTO Platform (platformId, provider, label, baseUrl, status, createdAt, updatedAt)
VALUES ('ikuru', 'ikuru', '自用出会', 'sp.194964.com', 'active', datetime('now'), datetime('now')),
  -- task-H1 · 快乐平台 kairaku（happymail.co.jp）种子（测绘图 v4 坐实，幂等 INSERT OR IGNORE）
  ('kairaku', 'kairaku', '快乐', 'happymail.co.jp', 'active', datetime('now'), datetime('now'));


-- 迁移元数据：记录 schema 版本与迁移批次（幂等判断用）
-- =============================================================================
CREATE TABLE IF NOT EXISTS _migration (
  version   INTEGER PRIMARY KEY,
  appliedAt TEXT NOT NULL,
  note      TEXT NOT NULL DEFAULT ''
);

-- =============================================================================
-- task-3 频控账本落库（rate-ledger-persist.md §1，Variant A · 挂 v2 外键）
-- 顺序：v1(M0 14 实体) → v2(task-2 外键源表) → v3(task-3 账本表挂 v2 外键)
-- 三表自含 [accountId, contactId, conversationId] 三级字段，挂 Account/Contact/Conversation 外键
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SentLog · 发送/生成流水（append-only，与 Message 同纪律）
-- pk：确定性 = sha1(accountId|contactId|ts|kind|seq)；seq = 同 (accountId,ts) 内行序
-- 语义：单客户 24h 按「生成条数」计（blocked=0/1 都计，task-31 防绕过）；账号 1h/每分钟 cap 只计 blocked=0
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS SentLog (
  sentLogId        TEXT PRIMARY KEY,          -- sha1(accountId|contactId|ts|kind|seq)
  accountId        TEXT NOT NULL REFERENCES Account(accountId),
  contactId        TEXT NOT NULL REFERENCES Contact(contactId),
  conversationId  TEXT,                       -- 可空；有值时 REFERENCES Conversation(conversationId)
  ts               INTEGER NOT NULL,          -- epoch ms（对齐内存账本 Date.parse(nowIso())）
  kind             TEXT NOT NULL DEFAULT 'guide' CHECK (kind IN ('guide','remind','push','other')),
  blocked          INTEGER NOT NULL DEFAULT 0,  -- 1 = 被合规/频控拦截仍计数
  pending          INTEGER NOT NULL DEFAULT 0,  -- 1 = 已生成未真发（task-37 待确认口径）
  templateVersion  TEXT,
  variant          TEXT,                      -- A/B 变体
  seq              INTEGER NOT NULL DEFAULT 0
);
-- 24h 客户级热路径：WHERE accountId=? AND contactId=? AND ts>=?
CREATE INDEX IF NOT EXISTS idx_sent_customer_day  ON SentLog(accountId, contactId, ts DESC);
-- 1h 账号级热路径：WHERE accountId=? AND blocked=0 AND ts>=?
CREATE INDEX IF NOT EXISTS idx_sent_account_hour  ON SentLog(accountId, blocked, ts DESC);

-- -----------------------------------------------------------------------------
-- PendingQueue · 待确认话术（活跃队列落库）
-- expire 语义（打回 #3）：72h 未确认 → 状态机标记 expired=1（不动 confirmed 列，confirmed 行 72h 内不被裁）；
--   物理归档只按行量阈值 + 过 72h 时间窗（confirmed 行 72h 内既不 expire 也不归档）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PendingQueue (
  pendingId        TEXT PRIMARY KEY,          -- sha1(accountId|contactId|ts|textHash)
  accountId        TEXT NOT NULL REFERENCES Account(accountId),
  contactId        TEXT NOT NULL REFERENCES Contact(contactId),
  tier             TEXT NOT NULL DEFAULT 'warm',
  text             TEXT NOT NULL,            -- 话术原文（≤500 字）
  talkRef          TEXT,                     -- JSON：{ variant, templateVersion, platform, fallback }
  gateBlocked      INTEGER NOT NULL DEFAULT 0,
  gateReason       TEXT NOT NULL DEFAULT '',
  confirmed        INTEGER NOT NULL DEFAULT 0,
  confirmedAt      TEXT,                     -- ISO
  expired          INTEGER NOT NULL DEFAULT 0,  -- 72h 未确认状态机标志
  createdAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_active  ON PendingQueue(confirmed, expired, accountId, contactId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_pending_lookup  ON PendingQueue(accountId, contactId, text);


-- -----------------------------------------------------------------------------
-- ContactRecruitPost · 客户招募帖（v5.2 快乐平台新增情报维度；独立于 ContactProfile 落库隔离）
-- 来源：快乐 get_profile_billboard.php（列表）+ get_billboard.php（单帖正文/标签）
-- pk: postId = sha1(contactId + '|' + billboardId)（幂等，一客户多帖按 billboardId 分）
-- 字段（坐实）：subject/body/genre/postTime/readCount/retCount/tags（JSON 数组）/telephone
-- 三要素隔离：招募帖属客户侧情报，落库挂 contactId，不混入 AccountPersona
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ContactRecruitPost (
  postId           TEXT PRIMARY KEY,
  contactId        TEXT NOT NULL REFERENCES Contact(contactId),
  billboardId      TEXT,
  subject          TEXT,
  body             TEXT,
  genreName        TEXT,
  postTime         TEXT,
  readCount        INTEGER,
  retCount         INTEGER,
  tags             TEXT,          -- JSON 数组（scene_name_list）
  telephone        TEXT,          -- 客户电话（PII，落库走脱敏，展示前掩码）
  source           TEXT NOT NULL DEFAULT 'happy-billboard',
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruitpost_contact ON ContactRecruitPost(contactId);


-- -----------------------------------------------------------------------------
-- GateBlock · 拦截审计（append-only，供看板/审计视图）
-- kind 判定：rateLimit（频控前缀）/ blacklist（黑名单|denyByDefault|红线）/ compliance（其余）/ other
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS GateBlock (
  gateBlockId      TEXT PRIMARY KEY,          -- sha1(ts|reason|kind|seq)
  accountId        TEXT,                      -- 可空（全局拦截无账号）；有值时 REFERENCES Account(accountId)
  contactId        TEXT,
  ts               INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('compliance','rateLimit','blacklist','other')),
  reason           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateblock_ts  ON GateBlock(ts DESC);

INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES
  (1, datetime('now'), 'M0: 14 实体初版 schema'),
  (2, datetime('now'), 'task-2 双存储统一：三级嵌套新表 Platform/PlatformGroup/AccountGroup/InboxSnapshot/AccountProfileRaw + 缓存轨归位'),
  (3, datetime('now'), 'task-3 频控账本落库：SentLog/PendingQueue/GateBlock 三表（Variant A，挂 v2 外键）'),
  (4, datetime('now'), 'kairaku 快乐平台种子（happymail.co.jp）+ 7 Expr 草案'),
  (5, datetime('now'), 'kairaku v5.2：ContactRecruitPost 表（客户招募帖 13 API 坐实）+ 4 新 Expr（帖子列表/详情/撤回/发送坐实）'),
  (6, datetime('now'), 'v5.3 运营工具箱：Memo（备忘录）+ CalendarEvent（日历）+ PhraseLibrary（模板库/常用语升级）三表'),
  (7, datetime('now'), 'v5.3 C 阶段：Conversation.followupStage（探测式 ADD）+ FollowupSop 跟进 SOP 表（3天加ライン规则）'),
  (8, datetime('now'), 'v5.3 批1 群控基座：TaskQueue 跨账号任务分发表（pending→assigned→running→done/failed）');

-- -----------------------------------------------------------------------------
-- Memo · 运营备忘录（v5.3；按 账号 维度，挂 accountId，独立于会话）
-- 用途：给某个客户/账号记"别的事"（例：客户说下周三面试、上次聊到约千歳、忌讳话题等）
-- pk: memoId = sha1('memo/' + accountId + '/' + seq)
-- kind: customer（挂客户）| account（账号级）| general（全局）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Memo (
  memoId        TEXT PRIMARY KEY,
  accountId     TEXT,
  contactId     TEXT,            -- 可空；customer 类挂客户
  kind          TEXT NOT NULL DEFAULT 'general',
  title         TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  dueAt         TEXT,            -- 可空；到期提醒（配合日历）
  pinned        INTEGER NOT NULL DEFAULT 0,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memo_account ON Memo(accountId);
CREATE INDEX IF NOT EXISTS idx_memo_contact ON Memo(contactId);

-- -----------------------------------------------------------------------------
-- CalendarEvent · 运营日历（v5.3；时间约定/跟进节点，非群发）
-- 用途：记录"和客户约的见面时间"、"3 天后追ライン"、"明天发新帖"等节点
-- pk: eventId = sha1('cal/' + accountId + '/' + seq)
-- kind: meet（见面约定）| followup（跟进节点）| line-push（加ライン节点）| post（发帖节点）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS CalendarEvent (
  eventId       TEXT PRIMARY KEY,
  accountId     TEXT,
  contactId     TEXT,            -- 可空
  kind          TEXT NOT NULL DEFAULT 'followup',
  title         TEXT NOT NULL DEFAULT '',
  scheduledAt   TEXT NOT NULL,   -- ISO 时间
  reminded      INTEGER NOT NULL DEFAULT 0,
  done          INTEGER NOT NULL DEFAULT 0,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calevent_account ON CalendarEvent(accountId);
CREATE INDEX IF NOT EXISTS idx_calevent_sched ON CalendarEvent(scheduledAt);

-- -----------------------------------------------------------------------------
-- PhraseLibrary · 模板库/常用语（v5.3 升级；场景标签 + 多语言 + 人设贴合）
-- 用途：可复用的话术模板（比 consolePrefs 种子更强：带场景、可翻译、可按人设过滤）
-- pk: phraseId = sha1('phrase/' + scope + '/' + seq)
-- scope: global | platform | account
-- scene: opening（破冰）| followup（跟进）| meet（约见面）| line（加ライン软推进）
--        | deflect（婉拒）| care（关心）| understand（理解/退路）| close（收尾）
-- lang: ja（默认）| zh | en
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PhraseLibrary (
  phraseId      TEXT PRIMARY KEY,
  scope         TEXT NOT NULL DEFAULT 'global',
  accountId     TEXT,
  platform      TEXT,
  scene         TEXT NOT NULL DEFAULT 'general',
  intent        TEXT,              -- reply/deflect/meet/analyze/care
  lang          TEXT NOT NULL DEFAULT 'ja',
  content       TEXT NOT NULL,     -- 模板正文（可含 {name} {place} {time} 占位符）
  translated    TEXT,              -- 译文（zh 对照）
  tags          TEXT,             -- JSON 数组
  usageCount    INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'manual',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phrase_scene ON PhraseLibrary(scene);
CREATE INDEX IF NOT EXISTS idx_phrase_account ON PhraseLibrary(accountId);



-- -----------------------------------------------------------------------------
-- TaskQueue · 跨账号任务分发（v5.3 · 批1；群控基座 §-1.1）
-- 一条任务 = 给某账号的某个动作（scan/followup/post/recruit），由分配器按账号 idle 状态领取
-- pk: taskId = sha1('task/' + seq + '/' + Date.now())
-- status: pending（待分发）| assigned（已分给账号）| running | done | failed | skipped
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS TaskQueue (
  taskId      TEXT PRIMARY KEY,
  platform    TEXT NOT NULL DEFAULT 'ichigo',
  accountId   TEXT,               -- 目标账号（pending 时可为 null，由分配器定）
  type        TEXT NOT NULL,      -- scan / followup / post / recruit / line-push
  payload     TEXT,               -- JSON（任务参数：contactId/conversationId 等）
  status      TEXT NOT NULL DEFAULT 'pending',
  priority    INTEGER NOT NULL DEFAULT 0,
  assignedAt  TEXT,
  finishedAt  TEXT,
  error       TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_status ON TaskQueue(status);
CREATE INDEX IF NOT EXISTS idx_task_account ON TaskQueue(accountId);


-- 注：v4 = task-H1 快乐平台识别 + 抓取原语；v2/v21/v3 各单写源不变
  -- 注：Conversation/Contact/ContactProfile/Account/AccountPersona 的 ADD COLUMN（未读4字段/头像/profileUrl/candidates/ageNum/pageUrl/mypageUrl/platformId）
  --    由独立迁移批次 002_add_columns.sql.js 承载（SQLite 无 ADD IF NOT EXISTS；探测式幂等，见 server/db/migrations/）；
  --    版本号口径（单写源收敛，node 2 核验基准）：v2 = 本 DDL 静态写「新表已落」；列补齐批次独立写 v21（002_add_columns.sql.js），互不冲突。


-- =====================================================================
-- 006 批次 · 卡片流全链路: SendQueue(后台串行发送队列) + OperationLog(操作审计)
-- 2026-11-07 A 卡片流: A~D 选话术入队, 20s±10s 浮动串行调度; 强副作用(拉黑/撤回/微调)落库留痕
-- =====================================================================
CREATE TABLE IF NOT EXISTS SendQueue (
  queueId TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  platform TEXT NOT NULL,          -- ichigo / happymail
  accountId TEXT NOT NULL,         -- 17098 / 18595
  contactKey TEXT,
  talkText TEXT NOT NULL,          -- 要发的话术(日文原文)
  talkZh TEXT,                    -- 中文译文
  talkIntent TEXT,
  talkConfidence REAL,
  slotSeq INTEGER,
  scheduledAt TEXT,
  dispatchAt TEXT,
  sentAt TEXT,
  revokedAt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idxSendQueue_status ON SendQueue(status, scheduledAt);
CREATE INDEX IF NOT EXISTS idxSendQueue_conv ON SendQueue(conversationId, status);

CREATE TABLE IF NOT EXISTS OperationLog (
  opId INTEGER PRIMARY KEY AUTOINCREMENT,
  conversationId TEXT,
  platform TEXT,
  accountId TEXT,
  opType TEXT NOT NULL,           -- block / regen / adjust / send / revoke / cancel
  detail TEXT,
  result TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idxOpLog_conv ON OperationLog(conversationId, at);

