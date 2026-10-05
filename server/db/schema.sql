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
-- 迁移元数据：记录 schema 版本与迁移批次（幂等判断用）
-- =============================================================================
CREATE TABLE IF NOT EXISTS _migration (
  version   INTEGER PRIMARY KEY,
  appliedAt TEXT NOT NULL,
  note      TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES
  (1, datetime('now'), 'M0: 14 实体初版 schema');
