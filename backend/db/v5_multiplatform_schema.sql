-- =============================================================================
-- v5 迁移 · 多平台客源软关联与多维画像数据库（审核定稿 2026-10-21）
-- 设计：docs/plan/multi-platform-schema.md（架构蓝图）
-- 原则：全 ADD 幂等零删改——新表 CREATE TABLE IF NOT EXISTS；旧表只 ADD COLUMN
--       （SQLite 无 ADD COLUMN IF NOT EXISTS，用探测式幂等：先 PRAGMA table_info 查列）
-- 顺序：v1(M0 14 实体) → v2(task-2) → v3(task-3) → v4(H4 kairaku) → v5(本批次)
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- ① 新增表
-- -----------------------------------------------------------------------------

-- PlatformPersona · 平台人设（客户在特定平台的独立身份；1 物理人 : N 平台身份）
-- pk：personaId = sha1(contactId|platformId|platformUid)（确定性幂等）
CREATE TABLE IF NOT EXISTS PlatformPersona (
  personaId          TEXT PRIMARY KEY,
  contactId          TEXT NOT NULL REFERENCES Contact(contactId),
  platformId         TEXT NOT NULL REFERENCES Platform(platformId),
  platformUid        TEXT NOT NULL,          -- 平台内唯一 ID（出会=memberID，快乐=memberID，LINE=openId）
  displayName        TEXT NOT NULL DEFAULT '',
  avatarUrl          TEXT,
  profileUrl         TEXT,                   -- 资料页 URL（供 RAG 抓取）
  selfIntro          TEXT,                   -- 自我介绍（JSON 或纯文本）
  personaTags        TEXT,                   -- JSON array：该人设下高频标签
  chatStyle          TEXT,                   -- JSON：聊天风格指纹（LLM 抽取）
  activityPattern    TEXT,                   -- JSON：活跃时间偏好 {peakHours, activeDays, tzOffset}
  registrationProfile TEXT,                  -- JSON：平台登记完整资料（结构化，不拆细列）
  relationshipStage  TEXT NOT NULL DEFAULT 'new' CHECK (relationshipStage IN ('new','warming','active','silent','churned')),
  lastActiveAt       TEXT NOT NULL,
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persona_contact  ON PlatformPersona(contactId);
CREATE INDEX IF NOT EXISTS idx_persona_platform ON PlatformPersona(platformId, platformUid);
CREATE INDEX IF NOT EXISTS idx_persona_active   ON PlatformPersona(lastActiveAt DESC);

-- CustomerMemory · 记忆碎片（按物理人汇总；多模态 RAG 检索源）
-- pk：memoryId = sha1(contactId|memType|sha1(content))（幂等去重）
CREATE TABLE IF NOT EXISTS CustomerMemory (
  memoryId   TEXT PRIMARY KEY,
  contactId  TEXT NOT NULL REFERENCES Contact(contactId),
  memType    TEXT NOT NULL CHECK (memType IN ('preference','personality','phrasing','media','schedule','note')),
  ref        TEXT,                           -- 来源引用（media=文件 URL；preference=规则 ID；note=手动）
  content    TEXT NOT NULL,                  -- JSON 或纯文本（media 型只存 URL，不存 BLOB）
  source     TEXT NOT NULL DEFAULT 'llm_extract' CHECK (source IN ('llm_extract','manual','platform_profile','media_scan')),
  confidence REAL NOT NULL DEFAULT 0.5,
  vectorRef  TEXT,                           -- 向量库指针（预留；SQLite 存 hash，向量存外部）
  createdAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_contact ON CustomerMemory(contactId, memType);
CREATE INDEX IF NOT EXISTS idx_memory_type    ON CustomerMemory(memType);

-- CustomerMedia · 媒体文件（历史发送图片/视频/表情包/音乐；按物理人汇总）
-- pk：mediaId = sha1(contactId|msgId|sha1(url))
CREATE TABLE IF NOT EXISTS CustomerMedia (
  mediaId    TEXT PRIMARY KEY,
  contactId  TEXT NOT NULL REFERENCES Contact(contactId),
  msgId      TEXT,                           -- 来源 Message（可空，历史抓取时 NULL）
  mimeType   TEXT,
  url        TEXT NOT NULL,
  localPath  TEXT,                           -- 本地缓存路径（可空）
  duration   INTEGER,                         -- 音视频时长（秒；图片 NULL）
  width      INTEGER,
  height     INTEGER,
  direction  TEXT NOT NULL DEFAULT 'peer' CHECK (direction IN ('self','peer')),
  platformId TEXT REFERENCES Platform(platformId),
  createdAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_contact ON CustomerMedia(contactId, mimeType);
CREATE INDEX IF NOT EXISTS idx_media_msg     ON CustomerMedia(msgId);

-- CustomerTag · 标签沉淀（按物理人；替代旧 Tag.appliedTo JSON 列表的细粒度索引）
-- pk：tagId = sha1(contactId|layer|value)
CREATE TABLE IF NOT EXISTS CustomerTag (
  tagId      TEXT PRIMARY KEY,
  contactId  TEXT NOT NULL REFERENCES Contact(contactId),
  layer      TEXT NOT NULL CHECK (layer IN ('source','intent','category','status','ops')),
  value      TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source     TEXT NOT NULL DEFAULT 'rule_hit' CHECK (source IN ('llm_extract','manual','rule_hit')),
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custtag_contact ON CustomerTag(contactId, layer);

-- PersonaMemory · 人设记忆（按 PlatformPersona 隔离；与 CustomerMemory 双层）
-- pk：memId = sha1(personaId|memType|sha1(content))
CREATE TABLE IF NOT EXISTS PersonaMemory (
  memId      TEXT PRIMARY KEY,
  personaId  TEXT NOT NULL REFERENCES PlatformPersona(personaId),
  memType    TEXT NOT NULL CHECK (memType IN ('tone','phrasing','taboo','preference')),
  content    TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  createdAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persona_mem ON PersonaMemory(personaId, memType);

-- VectorStore · 向量库映射（预留；向量本体存外部 qdrant/sqlite-vec，DB 只存映射）
CREATE TABLE IF NOT EXISTS VectorStore (
  vectorId  TEXT PRIMARY KEY,                -- vs_{uuid}
  memoryId  TEXT,                            -- 来源 CustomerMemory.memoryId（可空，也可为 PersonaMemory）
  sourceRef TEXT,                            -- 来源类型提示（customer/persona）
  model     TEXT,                            -- 向量模型版本（bge-small / text-embedding-3-small / ...）
  dim       INTEGER,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vector_mem ON VectorStore(memoryId);

-- -----------------------------------------------------------------------------
-- ② 旧表增强（唯一对旧表的 ALTER；ADD COLUMN 幂等探测式）
--    SQLite 无 ADD COLUMN IF NOT EXISTS → Python 侧用 PRAGMA table_info 探测后条件执行
--    这里只声明"目标列"，实际 ADD 由 migrate_v5.py 的 ensure_column() 完成
-- -----------------------------------------------------------------------------
-- Conversation.personaId（会话 ↔ 平台人设绑定；迁移期旧数据 NULL，新数据必填）
-- Account.accountPool（账号池分组：primary/backup/cold，用于轮转调度）
-- Account.proxyProfileId（绑定代理池，复用现有 proxyPool）
-- 见 migrate_v5.py 的 ensure_column() 调用

-- -----------------------------------------------------------------------------
-- ③ 迁移元数据
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES
  (5, datetime('now'), '多平台客源软关联 + 多维画像库：PlatformPersona/CustomerMemory/CustomerMedia/CustomerTag/PersonaMemory/VectorStore 6 新表 + Conversation.personaId + Account.accountPool/proxyProfileId');
