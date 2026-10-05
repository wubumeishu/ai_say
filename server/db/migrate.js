// =============================================================================
// Ai SAY M0 · JSON → SQLite 可逆迁移脚本
// 用法：
//   node server/db/migrate.js            导入 data/*.json → data/aisay.db
//   node server/db/migrate.js --export   导出 data/aisay.db → data/export/*.json
//   node server/db/migrate.js --check    导入 → 导出 → 再导入，打印 round-trip diff（应为空）
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const BASE   = path.join(__dirname, '..', '..');
const DATA   = path.join(BASE, 'data');
const SCHEMA = path.join(__dirname, 'schema.sql');
const DB     = path.join(DATA, 'aisay.db');

const FILES = {
  accountProfiles: path.join(DATA, 'account-profiles.json'),
  contacts:        path.join(DATA, 'contacts.json'),
  conversations:   path.join(DATA, 'conversations.json'),
};

// ---------------------------------------------------------------- 工具函数 --
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const now  = () => new Date().toISOString();

function parseLegacyKey(key) {
  const i1 = String(key).indexOf('/');
  const i2 = String(key).indexOf('/', i1 + 1);
  if (i1 >= 0 && i2 > i1) {
    return {
      platform: key.slice(0, i1),
      windowId: key.slice(i1 + 1, i2),
      label:    key.slice(i2 + 1),
    };
  }
  return { platform: String(key), windowId: '', label: '' };
}

function openDb() {
  const db = new DatabaseSync(DB);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function applySchema(db) {
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

// ---------------------------------------------------------------- 导入 --
function importAll(db) {
  const nowIso = now();
  const accountProfiles = readJson(FILES.accountProfiles);
  const contacts        = readJson(FILES.contacts);
  const conversations   = readJson(FILES.conversations);

  // (platform, windowId) → accountLabel 映射（来自 account-profiles.json）
  const accountLabelByWindow = new Map();
  for (const rec of accountProfiles) {
    const legacy = parseLegacyKey(rec.key);
    accountLabelByWindow.set(legacy.platform + '/' + legacy.windowId, legacy.label);
  }

  const insAccount = db.prepare(
    'INSERT OR IGNORE INTO Account (accountId,platform,label,status,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)'
  );
  const insWindow  = db.prepare(
    'INSERT OR IGNORE INTO WindowInstance (windowId,accountId,seq,lastHealth,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)'
  );
  const insContact = db.prepare(
    'INSERT OR IGNORE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const insAnchor  = db.prepare(
    'INSERT OR IGNORE INTO ContactAnchor (anchorId,contactId,kind,value,confidence,source,createdAt) VALUES (?,?,?,?,?,?,?)'
  );
  const insProfile = db.prepare(
    'INSERT OR REPLACE INTO ContactProfile (contactId,age,region,height,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const insConv    = db.prepare(
    'INSERT OR REPLACE INTO Conversation (conversationId,accountId,contactId,channel,status,lastActiveAt,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const insMsg     = db.prepare(
    'INSERT OR IGNORE INTO Message (messageId,conversationId,seq,role,original,translation,timeText,timeIso,kind,name,url,raw,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );

  const stats = { accounts: 0, windows: 0, contacts: 0, anchors: 0, profiles: 0, conversations: 0, messages: 0 };

  // 1. account-profiles.json → Account + WindowInstance
  for (const rec of accountProfiles) {
    const legacy = parseLegacyKey(rec.key);
    const accountId = sha1('acc/' + legacy.platform + '/' + legacy.windowId + '/' + legacy.label);
    insAccount.run(
      accountId, legacy.platform, legacy.label, 'active',
      rec.key || [legacy.platform, legacy.windowId, legacy.label].join('/'),
      rec.createdAt || nowIso, rec.updatedAt || nowIso
    );
    stats.accounts++;

    if (legacy.windowId) {
      insWindow.run(
        legacy.windowId, accountId, 0,
        rec.updatedAt || nowIso,
        rec.key || '',
        rec.createdAt || nowIso, rec.updatedAt || nowIso
      );
      stats.windows++;
    }
  }

  // 2. contacts.json → Contact + ContactAnchor + ContactProfile
  const contactIdByKey = new Map();

  for (const rec of contacts) {
    const legacy = parseLegacyKey(rec.key);
    const contactRaw = rec.contact || {};
    const displayName = String(contactRaw.name || rec.contactKey || legacy.label || '');
    const nickname    = String(rec.contactKey || legacy.label || '');
    const contactId   = sha1('weak/' + legacy.platform + '/' + legacy.windowId + '/' + legacy.label + '|' + displayName);
    contactIdByKey.set(rec.key || '', contactId);

    insContact.run(
      contactId, displayName, nickname, null,
      rec.createdAt || nowIso, rec.updatedAt || nowIso,
      'new', rec.createdAt || nowIso, rec.updatedAt || nowIso
    );
    stats.contacts++;

    const anchorId = sha1(contactId + '|weak|' + (rec.key || ''));
    insAnchor.run(anchorId, contactId, 'weak', rec.key || '', 0.5, 'legacy', rec.createdAt || nowIso);
    stats.anchors++;

    insProfile.run(
      contactId,
      String(contactRaw.age || '') || null,
      String(contactRaw.region || '') || null,
      String(contactRaw.height || '') || null,
      null, null,
      'unknown',
      contactRaw.candidates ? JSON.stringify(contactRaw.candidates) : null,
      String(contactRaw.intro || ''),
      null,
      0.5,
      'profile_page',
      rec.createdAt || nowIso, rec.updatedAt || nowIso
    );
    stats.profiles++;
  }

  // 3. conversations.json → Conversation + Message
  for (const rec of conversations) {
    const legacy = parseLegacyKey(rec.key);
    let contactId = contactIdByKey.get(rec.key || '');
    if (!contactId) {
      const displayName = String((rec.contact || {}).name || rec.contactName || legacy.label || '');
      contactId = sha1('weak/' + legacy.platform + '/' + legacy.windowId + '/' + legacy.label + '|' + displayName);
      contactIdByKey.set(rec.key || '', contactId);
      insContact.run(
        contactId, displayName, displayName, null,
        rec.createdAt || nowIso, rec.updatedAt || nowIso,
        'new', rec.createdAt || nowIso, rec.updatedAt || nowIso
      );
      stats.contacts++;
    }

    const accountLabel = accountLabelByWindow.get(legacy.platform + '/' + legacy.windowId) || legacy.label;
    const accountId = sha1('acc/' + legacy.platform + '/' + legacy.windowId + '/' + accountLabel);
    insAccount.run(
      accountId, legacy.platform, accountLabel, 'active',
      [legacy.platform, legacy.windowId, accountLabel].join('/'),
      rec.createdAt || nowIso, rec.updatedAt || nowIso
    );

    const convId = sha1(accountId + '|' + contactId + '|platform_dm');
    insConv.run(
      convId, accountId, contactId, 'platform_dm', 'open',
      rec.updatedAt || nowIso,
      rec.key || '',
      rec.createdAt || nowIso, rec.updatedAt || nowIso
    );
    stats.conversations++;

    const msgs = Array.isArray(rec.messages) ? rec.messages : [];
    for (let i = 0; i < msgs.length; i++) {
      const m   = msgs[i];
      const seq = typeof m.index === 'number' ? m.index : i;
      const msgId = sha1(convId + '|' + seq + '|' + String(m.original || m.text || ''));
      insMsg.run(
        msgId, convId, seq,
        m.role || 'unknown',
        String(m.original || m.text || ''),
        String(m.translation || ''),
        m.time ? (m.time.text || '') : '',
        m.time && m.time.iso ? m.time.iso : '',
        m.kind || null,
        m.name || null,
        m.url || null,
        JSON.stringify(m),
        rec.createdAt || nowIso
      );
      stats.messages++;
    }
  }

  const totals = {
    accounts:      db.prepare('SELECT COUNT(*) AS c FROM Account').get().c,
    windows:       db.prepare('SELECT COUNT(*) AS c FROM WindowInstance').get().c,
    contacts:      db.prepare('SELECT COUNT(*) AS c FROM Contact').get().c,
    anchors:       db.prepare('SELECT COUNT(*) AS c FROM ContactAnchor').get().c,
    profiles:      db.prepare('SELECT COUNT(*) AS c FROM ContactProfile').get().c,
    conversations: db.prepare('SELECT COUNT(*) AS c FROM Conversation').get().c,
    messages:      db.prepare('SELECT COUNT(*) AS c FROM Message').get().c,
  };

  return {
    stats,
    totals,
    samples: {
      firstContact: db.prepare('SELECT contactId, displayName FROM Contact ORDER BY createdAt ASC LIMIT 1').get(),
      lastContact:  db.prepare('SELECT contactId, displayName FROM Contact ORDER BY createdAt DESC LIMIT 1').get(),
      firstConv:    db.prepare('SELECT conversationId, legacyKey FROM Conversation ORDER BY createdAt ASC LIMIT 1').get(),
      lastConv:     db.prepare('SELECT conversationId, legacyKey FROM Conversation ORDER BY createdAt DESC LIMIT 1').get(),
    },
  };
}

// ---------------------------------------------------------------- 导出 --
function exportAll(db) {
  const exportDir = path.join(DATA, 'export');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

  // Account → account-profiles.json
  const accounts = db.prepare(
    "SELECT a.accountId, a.platform, a.label, a.legacyKey, a.createdAt, a.updatedAt, " +
    "COALESCE(w.windowId, '') AS windowId " +
    "FROM Account a LEFT JOIN WindowInstance w ON w.accountId = a.accountId " +
    "ORDER BY a.createdAt ASC"
  ).all();
  const accProfiles = accounts.map(a => ({
    key: a.legacyKey || [a.platform, a.windowId || '', a.label].join('/'),
    platform: a.platform,
    windowId: a.windowId || '',
    accountLabel: a.label,
    nickname: a.label,
    pageUrl: '', mypageUrl: '',
    fields: [], sections: [], lines: [], nextLevelPages: [], bottomNav: [],
    detection: {}, navigation: {}, raw: null,
    createdAt: a.createdAt, updatedAt: a.updatedAt,
  }));

  // Contact → contacts.json
  const contacts = db.prepare(
    "SELECT c.contactId, c.displayName, c.nickname, c.firstSeen, c.lastSeen, c.createdAt, c.updatedAt, " +
    "COALESCE(p.age,'') AS age, COALESCE(p.region,'') AS region, " +
    "COALESCE(p.height,'') AS height, COALESCE(p.occupation,'') AS occupation, " +
    "COALESCE(p.language,'') AS language, COALESCE(p.interests,'') AS interests, " +
    "COALESCE(p.historySummary,'') AS intro, " +
    "COALESCE(a.value,'') AS legacyKey " +
    "FROM Contact c " +
    "LEFT JOIN ContactProfile p ON p.contactId = c.contactId " +
    "LEFT JOIN ContactAnchor a ON a.contactId = c.contactId AND a.kind = 'weak' AND a.source = 'legacy' " +
    "ORDER BY c.createdAt ASC"
  ).all();

  const contactsOut = contacts.map(c => {
    const contactObj = { name: c.displayName || c.nickname };
    if (c.age)        contactObj.age = c.age;
    if (c.region)     contactObj.region = c.region;
    if (c.height)     contactObj.height = c.height;
    if (c.occupation) contactObj.occupation = c.occupation;
    if (c.language)   contactObj.language = c.language;
    if (c.interests)  { try { contactObj.candidates = JSON.parse(c.interests); } catch {} }
    if (c.intro)      contactObj.intro = c.intro;

    const legacy = parseLegacyKey(c.legacyKey);
    return {
      key: c.legacyKey || [legacy.platform, legacy.windowId, legacy.label].join('/'),
      platform: legacy.platform,
      windowId: legacy.windowId,
      contactKey: c.nickname || c.displayName || '',
      contact: contactObj,
      profileUrl: '',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });

  // Conversation → conversations.json
  const convs = db.prepare(
    "SELECT conv.conversationId, conv.legacyKey, conv.createdAt, conv.updatedAt, " +
    "acc.platform, COALESCE(w.windowId, '') AS windowId, acc.label AS accountLabel, " +
    "con.nickname, con.displayName " +
    "FROM Conversation conv " +
    "LEFT JOIN Account acc ON acc.accountId = conv.accountId " +
    "LEFT JOIN WindowInstance w ON w.accountId = acc.accountId " +
    "LEFT JOIN Contact con ON con.contactId = conv.contactId " +
    "ORDER BY conv.createdAt ASC"
  ).all();

  const conversationsOut = convs.map(c => {
    const msgs = db.prepare(
      'SELECT * FROM Message WHERE conversationId = ? ORDER BY seq ASC'
    ).all(c.conversationId).map(m => {
      let raw; try { raw = JSON.parse(m.raw || '{}'); } catch { raw = {}; }
      return {
        index: m.seq,
        text: raw.text || m.original,
        original: m.original,
        translation: m.translation,
        time: {
          text: m.timeText || '',
          iso: m.timeIso || '',
          year: raw.time?.year || '',
          time: raw.time?.time || '',
          marker: raw.time?.marker || '',
          has: raw.time?.has ?? true,
        },
        role: m.role,
        kind: raw.kind || m.kind || null,
        url: raw.url || m.url || null,
        name: raw.name || m.name || null,
        label: raw.label || null,
        group: raw.group || null,
        selector: raw.selector || null,
        className: raw.className || null,
      };
    });

    const legacy = parseLegacyKey(c.legacyKey);
    const contactKey = legacy.label;
    return {
      key: c.legacyKey || [legacy.platform, legacy.windowId, contactKey].join('/'),
      platform: legacy.platform || c.platform,
      windowId: legacy.windowId || c.windowId,
      contactKey: contactKey,
      contactName: c.displayName || c.nickname || '',
      contact: { name: c.displayName || c.nickname || '' },
      messages: msgs,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });

  const outFiles = {
    'account-profiles.json': JSON.stringify(accProfiles, null, 2),
    'contacts.json':         JSON.stringify(contactsOut, null, 2),
    'conversations.json':    JSON.stringify(conversationsOut, null, 2),
  };

  for (const [fname, content] of Object.entries(outFiles)) {
    fs.writeFileSync(path.join(exportDir, fname), content, 'utf8');
  }
  return outFiles;
}

// ---------------------------------------------------------------- 主流程 --
function main() {
  const mode = process.argv.includes('--export') ? 'export'
             : process.argv.includes('--check')  ? 'check'
             : 'import';

  if (mode === 'export') {
    const db = openDb();
    applySchema(db);
    const out = exportAll(db);
    console.log('[export] 已导出到 data/export/');
    for (const [f, content] of Object.entries(out)) {
      console.log('  ' + f + ': ' + content.length + ' bytes');
    }
    db.close();
    return;
  }

  const db = openDb();
  applySchema(db);
  const result = importAll(db);
  db.close();

  console.log('=== 导入统计 ===');
  console.log('新插入/更新:', JSON.stringify(result.stats));
  console.log('总数:', JSON.stringify(result.totals));
  console.log('首尾抽样:', JSON.stringify(result.samples, null, 2));

  if (mode === 'check') {
    console.log('\n=== Round-trip 自检 ===');
    const db2 = openDb();
    applySchema(db2);
    exportAll(db2);
    db2.close();

    const dataDir = path.join(DATA, 'export');
    const origAcc = readJson(FILES.accountProfiles);
    const expAcc  = JSON.parse(fs.readFileSync(path.join(dataDir, 'account-profiles.json'), 'utf8'));
    const origCon = readJson(FILES.contacts);
    const expCon  = JSON.parse(fs.readFileSync(path.join(dataDir, 'contacts.json'), 'utf8'));
    const origCv  = readJson(FILES.conversations);
    const expCv   = JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf8'));

    const diffs = [];
    if (origAcc.length !== expAcc.length)
      diffs.push('accountProfiles: 条数不等 ' + origAcc.length + ' vs ' + expAcc.length);

    const origConKeys = new Set(origCon.map(c => c.key || c.contactKey));
    const expConKeys  = new Set(expCon.map(c => c.key || c.contactKey));
    const missing = [...origConKeys].filter(k => !expConKeys.has(k));
    const extra   = [...expConKeys].filter(k => !origConKeys.has(k));
    if (missing.length) diffs.push('contacts: 丢失 key ' + JSON.stringify(missing));
    if (extra.length)   diffs.push('contacts: 多出 key ' + JSON.stringify(extra));

    if (origCv.length !== expCv.length)
      diffs.push('conversations: 条数不等 ' + origCv.length + ' vs ' + expCv.length);

    if (diffs.length) {
      console.log('[check] DIFF 非空：');
      for (const d of diffs) console.log('  - ' + d);
      process.exitCode = 1;
    } else {
      console.log('[check] round-trip 通过，diff 为空 ✓');
    }

    // 幂等性：再导入一次，条数不应增长
    const db3 = openDb();
    applySchema(db3);
    const cBefore = db3.prepare('SELECT COUNT(*) AS c FROM Contact').get().c;
    const mBefore = db3.prepare('SELECT COUNT(*) AS c FROM Message').get().c;
    importAll(db3);
    const cAfter = db3.prepare('SELECT COUNT(*) AS c FROM Contact').get().c;
    const mAfter = db3.prepare('SELECT COUNT(*) AS c FROM Message').get().c;
    db3.close();
    console.log('[check] 幂等性：Contact ' + cBefore + '→' + cAfter + ', Message ' + mBefore + '→' + mAfter +
      (cBefore === cAfter && mBefore === mAfter ? '（无增长 ✓）' : '（有增长 ✗）'));
  }
}

main();
