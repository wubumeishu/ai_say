// =============================================================================
// 005 批次：线索池 Lead 表（引流第一阶段"侦测"统一落点）
// 依据：AGENTS.md 附录「架构决策备忘」+ 2026-10-31 用户定案
//
// 设计要点：
//   * Lead 与 Contact/ContactProfile 分离：Lead=还没开聊、只存基础资料的线索；
//     开聊后迁移/升级到 Contact（两条数据流不打架）。
//   * 通用字段（会友平台基本都有）+ 平台特色走 extras JSON（ichigo_feature/happy_feature），
//     新平台接入只需往 extras 塞新 key，不改表。
//   * sourceDim 统一 5 个值（跨平台枚举）：search/ashiato/like/bbs/faces。
//     平台维度名差异（如快乐没有 faces）不影响 sourceDim 枚举，缺的维度平台不灌就行。
//   * warmupDay：养号进度（0=未养、1~3=适应期天数、4+=已进 veteran）；
//     contactedAt：是否已开过聊（null=纯线索、有值=已升级为客户线索）。
//
// 幂等：CREATE TABLE IF NOT EXISTS + _migration v50 标记，顺接 v40（004 批次）先例。
// 索引：复合索引 (platform, sourceDim, firstSeen DESC) 覆盖"按平台+来源+时间"筛选主查询；
//       (platform, age, online, firstSeen) 覆盖"按年龄+在线状态"筛选；
//       (sourceDim) 单列覆盖"按来源维度统计"（任务汇报用）。
// =============================================================================
'use strict';

const MIGRATION_VERSION = 50;

function up(db) {
  // 幂等守卫：_migration 已记 v50 直接跳过
  const migExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migration'")
    .get();
  if (migExists) {
    const applied = db.prepare('SELECT version FROM _migration WHERE version = ?').get(MIGRATION_VERSION);
    if (applied) return { skipped: true, version: MIGRATION_VERSION };
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS Lead (
      leadId         TEXT PRIMARY KEY,
      platform       TEXT NOT NULL DEFAULT 'ichigo',
      accountId      TEXT,
      name           TEXT NOT NULL DEFAULT '',
      gender         TEXT,
      age            TEXT,
      region         TEXT,
      online         TEXT,
      avatarUrl      TEXT,
      profileUrl     TEXT,
      selfIntro      TEXT,
      sourceDim      TEXT NOT NULL DEFAULT 'search'
                     CHECK(sourceDim IN ('search','ashiato','like','bbs','faces','unknown')),
      firstSeen      TEXT NOT NULL,
      lastSeen       TEXT NOT NULL,
      warmupDay      INTEGER NOT NULL DEFAULT 0,
      contactedAt    TEXT,
      extras         TEXT NOT NULL DEFAULT '{}',
      createdAt      TEXT NOT NULL,
      updatedAt      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idxLeadDimTime   ON Lead(platform, sourceDim, firstSeen DESC);
    CREATE INDEX IF NOT EXISTS idxLeadFilter     ON Lead(platform, age, online, firstSeen DESC);
    CREATE INDEX IF NOT EXISTS idxLeadSourceDim  ON Lead(sourceDim);
  `);

  if (migExists) {
    db.prepare('INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES (?, ?, ?)').run(
      MIGRATION_VERSION,
      new Date().toISOString(),
      '005 批次：Lead 线索池表（引流第一阶段"侦测"统一落点；通用字段 + 平台特色 extras JSON；sourceDim 5 枚举跨平台）'
    );
  }
  return { skipped: false, version: MIGRATION_VERSION };
}

module.exports = { MIGRATION_VERSION, up };
