'use strict';

// Ai SAY · 轻量 SQLite 只读查看工具（无新增依赖，Node 24 内置 node:sqlite）
// 用法：node scripts/sqlite-view.js --list
// 用法：node scripts/sqlite-view.js --table ContactProfile --limit 20
// 用法：node scripts/sqlite-view.js --query "SELECT name FROM sqlite_master WHERE type='table' LIMIT 50"
// 用法：node scripts/sqlite-view.js --db data/aisay.db --table Conversation --limit 10

const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const out = {
    db: path.join(__dirname, '..', 'data', 'aisay.db'),
    list: false,
    table: null,
    query: null,
    limit: 50,
    all: false,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db' || a === '-d') out.db = argv[i += 1];
    else if (a === '--list' || a === '-l') out.list = true;
    else if (a === '--table' || a === '-t') out.table = argv[i += 1];
    else if (a === '--query' || a === '-q') out.query = argv[i += 1];
    else if (a === '--limit' || a === '-n') out.limit = Math.max(0, parseInt(argv[i += 1] || '50', 10) || 50);
    else if (a === '--all') out.all = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown arg: ' + a);
  }
  return out;
}

function printHelp() {
  console.log('Usage:');
  console.log('  node scripts/sqlite-view.js --list');
  console.log('  node scripts/sqlite-view.js --table <TableName> --limit 20');
  console.log('  node scripts/sqlite-view.js --query "SELECT ... FROM ..."');
  console.log('  node scripts/sqlite-view.js --db <path> --list');
}

function isSafeQuery(sql) {
  const t = String(sql || '').trim();
  if (!t) return false;
  const head = t.split(/\s|\(/, 2)[0].toUpperCase();
  if (head !== 'SELECT' && head !== 'WITH') return false;
  if (/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|ATTACH|DETACH|REINDEX|ANALYZE|PRAGMA)\b/i.test(t)) return false;
  return true;
}

function shortCell(v, max = 120) {
  if (v === null || v === undefined) return 'NULL';
  let s;
  if (typeof v === 'object') {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  } else {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const dbPath = path.resolve(process.cwd(), args.db);
  if (!fs.existsSync(dbPath)) {
    console.error('db not found: ' + dbPath);
    process.exitCode = 2;
    return;
  }

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (args.list) {
      const rows = db.prepare(`SELECT type, name FROM sqlite_master WHERE type IN ('table','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
      const byType = { table: [], view: [], index: [] };
      for (const r of rows) byType[r.type].push(r.name);
      console.log('DB: ' + dbPath);
      console.log('\nTables:');
      for (const t of byType.table) {
        try {
          const cnt = db.prepare('SELECT COUNT(*) AS c FROM "' + t.replace(/"/g, '""') + '"').get();
          console.log('  ' + t + '  (' + Number(cnt.c) + ')');
        } catch (e) {
          console.log('  ' + t + '  (count error: ' + e.message + ')');
        }
      }
      if (byType.view.length) {
        console.log('\nViews:');
        for (const v of byType.view) console.log('  ' + v);
      }
      if (byType.index.length) {
        console.log('\nIndexes:');
        for (const x of byType.index) console.log('  ' + x);
      }
      return;
    }

    if (args.table) {
      const t = String(args.table).replace(/"/g, '""');
      const cols = db.prepare('PRAGMA table_info("' + t + '")').all();
      let rowCount = -1;
      try {
        const c = db.prepare('SELECT COUNT(*) AS c FROM "' + t + '"').get();
        rowCount = Number(c.c);
      } catch (e) {
        console.error('count failed: ' + e.message);
      }
      console.log('Table: ' + args.table);
      console.log('Columns: ' + (cols.map(c => c.name).join(', ') || '(none)'));
      if (rowCount >= 0) console.log('Rows: ' + rowCount);

      const limit = args.all ? -1 : args.limit;
      const q = 'SELECT * FROM "' + t + '"' + (limit > 0 ? ' LIMIT ' + limit : '');
      const rows = db.prepare(q).all();
      if (cols.length && rows.length) {
        const headers = cols.map(c => c.name);
        const lines = [headers.join(' | '), headers.map(() => '---').join(' | ')];
        for (const r of rows) lines.push(headers.map(h => shortCell(r[h])).join(' | '));
        console.log('\nSample rows:');
        console.log(lines.join('\n'));
      } else {
        console.log('\n(no rows)');
      }
      return;
    }

    if (args.query) {
      const q = String(args.query).trim();
      if (!isSafeQuery(q)) {
        console.error('refused: only safe read-only SELECT/WITH queries allowed.');
        process.exitCode = 3;
        return;
      }
      const rows = db.prepare(q).all();
      if (!rows.length) {
        console.log('(no rows)');
        return;
      }
      const headers = Object.keys(rows[0] || {});
      const lines = [headers.join(' | '), headers.map(() => '---').join(' | ')];
      for (const r of rows) lines.push(headers.map(h => shortCell(r[h])).join(' | '));
      console.log(lines.join('\n'));
      if (rows.length >= args.limit && !args.all) console.log('\n(truncated to ' + args.limit + ' rows; use --limit N or --all to expand)');
      return;
    }

    printHelp();
  } finally {
    db.close();
  }
}

try {
  main();
} catch (e) {
  console.error('error: ' + (e && e.message || e));
  process.exitCode = 4;
}
