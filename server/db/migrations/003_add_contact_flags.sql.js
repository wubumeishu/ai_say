// =============================================================================
// 模块 1 · 003 批次：出会消息队列同步与批量操作（列补齐，幂等）
// 依据：总控 2026-10-21「出会平台消息队列同步与批量操作功能（模块 1）」
//
// 语义：
//   * Contact.archived     INTEGER NOT NULL DEFAULT 0  已归档（平台侧删除/退会，主列表默认隐藏；备份保留，可恢复）
//   * Contact.blacklisted  INTEGER NOT NULL DEFAULT 0  已拉黑（批量操作栏「拉黑」置 1；同归档一样主列表默认隐藏）
//   两列都是「新增值列」，零删改，不碰既有 14+11 表数据。
// 前端主列表过滤：/api/console/mailbox?includeArchived=0（默认）→ 排除 archived=1 或 blacklisted=1 的客户。
// =============================================================================
'use strict';

const COLUMNS = [
  { table: 'Contact', col: 'archived',     ddl: 'ADD COLUMN archived INTEGER NOT NULL DEFAULT 0' },
  { table: 'Contact', col: 'blacklisted',  ddl: 'ADD COLUMN blacklisted INTEGER NOT NULL DEFAULT 0' },
];

function tableColumns(db, table) {
  let rows;
  try {
    rows = db.prepare('PRAGMA table_info(' + table + ')').all();
  } catch (e) {
    console.error('[migrations.003] PRAGMA table_info(' + table + ') 失败（表不存在？）:', e && e.message);
    return new Set();
  }
  return new Set(rows.map((r) => r.name));
}

/**
 * 应用 003 批次列补齐（幂等；探测已存在的列，缺哪列才 ADD；duplicate column 静默跳过但必 log）。
 * @param {import('node:sqlite').DatabaseSync} db
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
      console.log('[migrations.003] ' + item.table + ' 加列 ' + item.col + '（' + item.ddl + '）');
    } catch (e) {
      if (/duplicate column/i.test(String(e && e.message))) {
        console.warn('[migrations.003] ' + item.table + ' 列 ' + item.col + ' 已存在（duplicate column），跳过: ' + e.message);
      } else {
        console.error('[migrations.003] ' + item.table + ' 加列 ' + item.col + ' 失败（不阻断 openDb）:', e && e.message);
      }
    }
  }
  // 写批次标记（独立 version 31，避免与 002 批次 v21 冲突）
  try {
    db.prepare('INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES (31, ?, ?)').run(
      new Date().toISOString(),
      '模块1 003 批次：Contact.archived/blacklisted 列补齐（出会消息队列过滤 + 批量操作）'
    );
  } catch (e) {
    console.error('[migrations.003] 写 _migration(31) 批次标记失败:', e && e.message);
  }
  return report;
}

module.exports = { applyAddColumns, COLUMNS, tableColumns };
