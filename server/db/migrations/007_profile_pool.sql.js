// =============================================================================
// 007 批次：第二阶段 · 资料池 Profile 表 + Lead.contactId 回填列
// 依据：2026-11-09 用户裁定「资料池」
//   * 资料卡由线索池筛选并选择后再抓取（手动触发）
//   * 资料池分 未抓取/已抓取（Profile.crawlStatus）
//   * 收件箱有消息历史（我发或他发都算）→ 标 已沟通（Profile.communicated）
//   * 标注来源（对方浏览 ashiato/点赞 like/帖子 bbs/首页检索 search = Lead.sourceDim）
//   * 关联键：Lead 加 contactId 列（灌库时按 name+accountId 匹配 Contact 回填，精确关联收件箱会话）
// 设计：
//   * Profile 独立于 Lead/Contact：资料池=已人工筛选进入第二阶段运营对象的线索快照，
//     不随 Lead/Contact 变动（带 leadId 外键可追溯原始线索 + 快照字段可独立演化）。
//   * contacted/已沟通 判定靠 Contact.contactId → Conversation/Message 有记录，
//     Profile.communicated 是快照标记（promote 时算一次 + 可手动刷新），msgCount 存当时条数。
// 幂等：CREATE TABLE IF NOT EXISTS + _migration v60（顺接 005 v50 / 006 先例）。
// =============================================================================
'use strict';

const MIGRATION_VERSION = 60;

function up(db) {
  const migExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migration'")
    .get();
  if (migExists) {
    const applied = db.prepare('SELECT version FROM _migration WHERE version = ?').get(MIGRATION_VERSION);
    if (applied) return { skipped: true, version: MIGRATION_VERSION };
  }

  // Lead 加 contactId 列（回填收件箱会话身份；探测式幂等）
  try {
    const leadCols = db.prepare("PRAGMA table_info(Lead)").all().map((c) => c.name);
    if (leadCols.indexOf('contactId') === -1) {
      db.exec('ALTER TABLE Lead ADD COLUMN contactId TEXT');
      console.log('[007] Lead 加列 contactId');
    }
  } catch (e) {
    console.error('[007] Lead.contactId 加列失败（不阻断）:', e && e.message);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS Profile (
      profileId     TEXT PRIMARY KEY,
      leadId        TEXT NOT NULL,
      contactId     TEXT,
      platform      TEXT NOT NULL DEFAULT 'ichigo',
      accountId     TEXT,
      name          TEXT NOT NULL DEFAULT '',
      gender        TEXT,
      age           TEXT,
      region        TEXT,
      online        TEXT,
      avatarUrl     TEXT,
      profileUrl    TEXT,
      selfIntro     TEXT,
      sourceDim     TEXT NOT NULL DEFAULT 'unknown',
      crawlStatus   TEXT NOT NULL DEFAULT 'pending' CHECK (crawlStatus IN ('pending','done','failed')),
      communicated  INTEGER NOT NULL DEFAULT 0,
      msgCount      INTEGER NOT NULL DEFAULT 0,
      extras        TEXT NOT NULL DEFAULT '{}',
      pooledAt      TEXT NOT NULL,
      updatedAt     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idxProfileLead    ON Profile(leadId);
    CREATE INDEX IF NOT EXISTS idxProfileContact ON Profile(contactId);
    CREATE INDEX IF NOT EXISTS idxPlatformCrawl  ON Profile(platform, crawlStatus, updatedAt DESC);
  `);

  if (migExists) {
    db.prepare('INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES (?, ?, ?)').run(
      MIGRATION_VERSION,
      new Date().toISOString(),
      '007 批次：资料池 Profile 表（第二阶段运营对象；crawlStatus 未/已抓取 + communicated 已沟通 + sourceDim 来源 + leadId/contactId 关联）'
    );
  }
  return { skipped: false, version: MIGRATION_VERSION };
}

module.exports = { MIGRATION_VERSION, up };
