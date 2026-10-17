// =============================================================================
// task-2 双存储统一 · 002 批次：列补齐（ADD COLUMN 幂等）
// 依据：docs/plan/dual-store-unify.md §1.2.1（code-reviewer 打回 1）
//
// SQLite 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS；schema.sql 被 openDb 每次
// db.exec 重跑，裸 ADD COLUMN 第二次执行会报 duplicate column。故列补齐不进
// schema.sql 主 DDL，由本独立迁移批次承载：
//   1. 每列加列前先 PRAGMA table_info(表名) 探测已存在的列；
//   2. 缺哪列才 ALTER TABLE … ADD COLUMN …（逐列 try，catch 捕获
//      'duplicate column' 静默跳过——catch 必 log 模块.动作+错误，铁律 §0.5，不空 catch）；
//   3. 全部加完后写 _migration 批次标记（version 字段），幂等可重跑。
//
// 调用方：server/db/store.js 的 openDb() 在 exec(schema.sql) 之后调用
//   applyAddColumns(db)；测试经 createStore() 自动应用，无需手动调。
// =============================================================================
'use strict';

// 列补齐清单：表 → [{ col, ddl }]。ddl 是完整的 ADD COLUMN 子句（带默认值/约束）。
// 全部是「新增可空/带默认值列」，零删改，不碰旧 14 表既有数据。
const COLUMNS = [
  // Conversation：未读 4 字段 + 在线分档 + 头像 + 历史/资料 URL（§0.2 缓存轨归位）
  { table: 'Conversation', col: 'avatarUrl',          ddl: "ADD COLUMN avatarUrl TEXT" },
  { table: 'Conversation', col: 'avatarIsDefault',    ddl: "ADD COLUMN avatarIsDefault INTEGER NOT NULL DEFAULT 0" },
  { table: 'Conversation', col: 'historyUrl',         ddl: "ADD COLUMN historyUrl TEXT" },
  { table: 'Conversation', col: 'profileUrl',         ddl: "ADD COLUMN profileUrl TEXT" },
  { table: 'Conversation', col: 'onlineTier',          ddl: "ADD COLUMN onlineTier TEXT" },
  { table: 'Conversation', col: 'lastMsgTimeSeen',     ddl: "ADD COLUMN lastMsgTimeSeen TEXT" },
  { table: 'Conversation', col: 'lastMsgTimeNotified', ddl: "ADD COLUMN lastMsgTimeNotified TEXT" },
  { table: 'Conversation', col: 'unread',              ddl: "ADD COLUMN unread INTEGER NOT NULL DEFAULT 0" },
  // Contact：头像 + 资料 URL + 候选锚点 JSON
  { table: 'Contact', col: 'avatarUrl',       ddl: "ADD COLUMN avatarUrl TEXT" },
  { table: 'Contact', col: 'avatarIsDefault', ddl: "ADD COLUMN avatarIsDefault INTEGER NOT NULL DEFAULT 0" },
  { table: 'Contact', col: 'profileUrl',      ddl: "ADD COLUMN profileUrl TEXT" },
  { table: 'Contact', col: 'candidates',      ddl: "ADD COLUMN candidates TEXT" }, // JSON：候选锚点列表
  // ContactProfile：数字年龄（防幻觉铁律用，结构化数字不靠字符串解析）
  { table: 'ContactProfile', col: 'ageNum', ddl: "ADD COLUMN ageNum INTEGER" },
  // Account：platformId 外键列（三级嵌套挂载点；§1.4 迁移期允许空，无 REFERENCES 便于幂等）
  { table: 'Account', col: 'platformId', ddl: "ADD COLUMN platformId TEXT" },
  // AccountPersona：pageUrl / mypageUrl（旧 JSON account-profiles 的 pageUrl/mypageUrl 归位）
  { table: 'AccountPersona', col: 'pageUrl',   ddl: "ADD COLUMN pageUrl TEXT" },
  { table: 'AccountPersona', col: 'mypageUrl', ddl: "ADD COLUMN mypageUrl TEXT" },
];

/**
 * 取某表当前已存在的列名集合（PRAGMA table_info）。
 * @returns {Set<string>}
 */
function tableColumns(db, table) {
  let rows;
  try {
    rows = db.prepare('PRAGMA table_info(' + table + ')').all();
  } catch (e) {
    console.error('[migrations.002] PRAGMA table_info(' + table + ') 失败（表不存在？）:', e && e.message);
    return new Set();
  }
  return new Set(rows.map((r) => r.name));
}

/**
 * 应用列补齐（幂等：探测已存在的列，缺哪列才 ADD；duplicate column 静默跳过但必 log）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ added: string[], skipped: string[], table: string }[]}
 */
function applyAddColumns(db) {
  const report = [];
  for (const item of COLUMNS) {
    const cols = tableColumns(db, item.table);
    if (cols.has(item.col)) {
      report.push({ table: item.table, skipped: [item.col] });
      continue;
    }
    try {
      db.exec('ALTER TABLE ' + item.table + ' ' + item.ddl);
      report.push({ table: item.table, added: [item.col] });
      console.log('[migrations.002] ' + item.table + ' 加列 ' + item.col + '（' + item.ddl + '）');
    } catch (e) {
      // 铁律 §0.5：catch 必 log 模块.动作+错误。duplicate column（并发重跑/竞态）静默跳过；
      // 其他错误（语法/表缺失）记 error 但不抛，避免阻断 openDb。
      if (/duplicate column/i.test(String(e && e.message))) {
        console.warn('[migrations.002] ' + item.table + ' 列 ' + item.col + ' 已存在（duplicate column），跳过: ' + e.message);
      } else {
        console.error('[migrations.002] ' + item.table + ' 加列 ' + item.col + ' 失败（不阻断 openDb）:', e && e.message);
      }
    }
  }
  // 写批次标记（_migration v2.1 列补齐完成；用独立 version 21 避免与表 DDL v2 冲突）
  try {
    db.prepare('INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES (21, ?, ?)').run(
      new Date().toISOString(),
      'task-2 002 批次：Conversation/Contact/ContactProfile/Account/AccountPersona 列补齐（幂等）'
    );
  } catch (e) {
    console.error('[migrations.002] 写 _migration(21) 批次标记失败:', e && e.message);
  }
  return report;
}

module.exports = { applyAddColumns, COLUMNS, tableColumns };
