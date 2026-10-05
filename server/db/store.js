// =============================================================================
// Ai SAY M0 · SQLite Store（CommonJS）
// 导出：createStore({ dbPath })
// 与旧 server/store.js 形状兼容（入参/出参相同），底层为 SQLite。
// =============================================================================
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const schemaPath = path.join(__dirname, 'schema.sql');

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return db;
}

function createStore({ dbPath = path.join(__dirname, '..', '..', 'data', 'aisay.db') } = {}) {
  if (!fs.existsSync(dbPath)) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
  const now  = () => new Date().toISOString();

  // ----------------------------------------------------------- Account ------
  function upsertAccountProfile(input = {}) {
    // 兼容旧 shape：接收 { windowId, platform, accountLabel, ... }
    // accountId 归一化 = sha1('acc/platform/windowId/label')
    const legacy = {
      platform: String(input.platform || '').trim(),
      windowId: String(input.windowId || '').trim(),
      label:    String(input.accountLabel || input.nickname || input.name || '').trim(),
    };
    const accountId = sha1('acc/' + legacy.platform + '/' + legacy.windowId + '/' + legacy.label);
    const legacyKey = [legacy.platform, legacy.windowId, legacy.label].join('/');

    const existing = db.prepare('SELECT * FROM Account WHERE accountId = ?').get(accountId);
    const createdAt = existing ? existing.createdAt : now();
    db.prepare(
      'INSERT OR REPLACE INTO Account (accountId,platform,label,status,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)'
    ).run(accountId, legacy.platform, legacy.label, 'active', legacyKey, createdAt, now());

    if (legacy.windowId) {
      const win = db.prepare('SELECT * FROM WindowInstance WHERE windowId = ?').get(legacy.windowId);
      db.prepare(
        'INSERT OR REPLACE INTO WindowInstance (windowId,accountId,seq,lastHealth,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)'
      ).run(legacy.windowId, accountId, 0, now(), legacyKey, win ? win.createdAt : createdAt, now());
    }

    return db.prepare('SELECT * FROM Account WHERE accountId = ?').get(accountId);
  }

  function listAccountProfiles(query = {}) {
    let sql = 'SELECT * FROM Account';
    const params = [];
    if (query.platform) { sql += ' WHERE platform = ?'; params.push(query.platform); }
    sql += ' ORDER BY createdAt ASC';
    return db.prepare(sql).all(...params);
  }

  // ----------------------------------------------------------- Contact ------
  function upsertContact(input = {}) {
    // 兼容旧 shape：接收 { windowId, platform, contactKey, contact, ... }
    const legacy = {
      platform:  String(input.platform || '').trim(),
      windowId:  String(input.windowId || '').trim(),
      label:     String(input.contactKey || '').trim(),
    };
    const contactRaw  = input.contact || {};
    const displayName = String(contactRaw.name || legacy.label || '');
    const nickname    = String(legacy.label || '');
    const contactId   = sha1('weak/' + legacy.platform + '/' + legacy.windowId + '/' + legacy.label + '|' + displayName);
    const legacyKey   = [legacy.platform, legacy.windowId, legacy.label].join('/');

    const existing = db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(contactId);
    const createdAt = existing ? existing.createdAt : now();
    const firstSeen = existing ? existing.firstSeen : (input.createdAt || createdAt);
    const lastSeen  = input.updatedAt || now();

    db.prepare(
      'INSERT OR REPLACE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(contactId, displayName, nickname, null, firstSeen, lastSeen,
         existing ? existing.lifecycle : 'new', createdAt, now());

    // 弱锚点（legacyKey）
    const anchorId = sha1(contactId + '|weak|' + legacyKey);
    const anchorExists = db.prepare('SELECT 1 FROM ContactAnchor WHERE anchorId = ?').get(anchorId);
    if (!anchorExists) {
      db.prepare(
        'INSERT INTO ContactAnchor (anchorId,contactId,kind,value,confidence,source,createdAt) VALUES (?,?,?,?,?,?,?)'
      ).run(anchorId, contactId, 'weak', legacyKey, 0.5, 'legacy', createdAt);
    }

    // ContactProfile（INSERT OR REPLACE，保留高置信度规则由调用方负责）
    db.prepare(
      'INSERT OR REPLACE INTO ContactProfile (contactId,age,region,height,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      contactId,
      String(contactRaw.age || '') || null,
      String(contactRaw.region || '') || null,
      String(contactRaw.height || '') || null,
      null, null,
      'unknown',
      contactRaw.candidates ? JSON.stringify(contactRaw.candidates) : null,
      String(contactRaw.intro || ''),
      input.fields ? JSON.stringify(input.fields) : null,
      0.5,
      input.source || 'profile_page',
      existing ? existing.createdAt : createdAt,
      now()
    );

    return db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(contactId);
  }

  function listContacts(query = {}) {
    let sql = 'SELECT c.* FROM Contact c';
    const params = [];
    if (query.lifecycle) { sql += ' WHERE c.lifecycle = ?'; params.push(query.lifecycle); }
    sql += ' ORDER BY c.lastSeen DESC LIMIT ' + Math.min(Number(query.limit) || 100, 1000);
    return db.prepare(sql).all(...params);
  }

  // ----------------------------------------------------------- Conversation --
  function upsertConversation(input = {}) {
    // 兼容旧 shape：接收 { windowId, platform, contactKey, contactName, contact, messages, ... }
    const legacy = {
      platform:  String(input.platform || '').trim(),
      windowId:  String(input.windowId || '').trim(),
      label:     String(input.contactKey || '').trim(),
    };
    const contactRaw  = input.contact || {};
    const displayName = String(contactRaw.name || input.contactName || legacy.label || '');
    const contactId   = sha1('weak/' + legacy.platform + '/' + legacy.windowId + '/' + legacy.label + '|' + displayName);

    // 确保 Contact 存在
    const contactExists = db.prepare('SELECT 1 FROM Contact WHERE contactId = ?').get(contactId);
    if (!contactExists) {
      upsertContact({ ...input, contact: { name: displayName } });
    }

    // Account
    const accountLabel = legacy.label || '';
    const accountId = sha1('acc/' + legacy.platform + '/' + legacy.windowId + '/' + accountLabel);
    const accountExists = db.prepare('SELECT 1 FROM Account WHERE accountId = ?').get(accountId);
    if (!accountExists) {
      upsertAccountProfile({ ...input, accountLabel });
    }

    const convId = sha1(accountId + '|' + contactId + '|platform_dm');
    const existing = db.prepare('SELECT * FROM Conversation WHERE conversationId = ?').get(convId);
    const createdAt = existing ? existing.createdAt : (input.createdAt || now());

    db.prepare(
      'INSERT OR REPLACE INTO Conversation (conversationId,accountId,contactId,channel,status,lastActiveAt,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(convId, accountId, contactId, 'platform_dm', 'open',
         input.updatedAt || now(),
         [legacy.platform, legacy.windowId, legacy.label].join('/'),
         createdAt, now());

    // Messages（append-only，用 seq + original 去重）
    const msgs = Array.isArray(input.messages) ? input.messages : [];
    for (let i = 0; i < msgs.length; i++) {
      const m   = msgs[i];
      const seq = typeof m.index === 'number' ? m.index : i;
      const msgId = sha1(convId + '|' + seq + '|' + String(m.original || m.text || ''));
      db.prepare(
        'INSERT OR IGNORE INTO Message (messageId,conversationId,seq,role,original,translation,timeText,timeIso,kind,name,url,raw,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
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
        createdAt
      );
    }

    return db.prepare('SELECT * FROM Conversation WHERE conversationId = ?').get(convId);
  }

  function listConversations(query = {}) {
    let sql = 'SELECT conv.*, con.displayName FROM Conversation conv LEFT JOIN Contact con ON con.contactId = conv.contactId';
    const params = [];
    if (query.contactId) { sql += ' WHERE conv.contactId = ?'; params.push(query.contactId); }
    sql += ' ORDER BY conv.lastActiveAt DESC LIMIT ' + Math.min(Number(query.limit) || 100, 1000);
    return db.prepare(sql).all(...params);
  }

  function getMessages(conversationId, limit = 200) {
    return db.prepare(
      'SELECT * FROM Message WHERE conversationId = ? ORDER BY seq ASC LIMIT ?'
    ).all(conversationId, Math.min(limit, 1000));
  }

  // ----------------------------------------------------------- 新增能力 ------

  /**
   * mergeContact(survivorId, mergedId, reason, anchorKind)
   * - 写 MergeEvent + 设置 mergedId.mergedInto = survivorId
   * - 可审计可回滚：回滚 = 调用 rollBackMerge(mergeEventId)
   */
  function mergeContact(survivorId, mergedId, reason = '', anchorKind = 'strong') {
    const mergeEventId = sha1('merge/' + survivorId + '/' + mergedId + '/' + Date.now());
    db.prepare(
      "INSERT INTO MergeEvent (mergeEventId,survivorContactId,mergedContactId,reason,anchorKind,direction,rollbackOf,createdAt) VALUES (?,?,?,?,?, 'merge', NULL, ?)"
    ).run(mergeEventId, survivorId, mergedId, reason, anchorKind, now());

    // 设置 mergedInto 指针（不物理删除）
    db.prepare(
      'UPDATE Contact SET mergedInto = ?, updatedAt = ? WHERE contactId = ?'
    ).run(survivorId, now(), mergedId);

    // 把 mergedId 的锚点迁移到 survivorId
    db.prepare(
      'UPDATE ContactAnchor SET contactId = ? WHERE contactId = ?'
    ).run(survivorId, mergedId);

    // 把 mergedId 的会话指向 survivorId（保留消息历史）
    db.prepare(
      'UPDATE Conversation SET contactId = ? WHERE contactId = ?'
    ).run(survivorId, mergedId);

    // 更新 survivor 的 lastSeen
    db.prepare(
      'UPDATE Contact SET lastSeen = ?, updatedAt = ? WHERE contactId = ?'
    ).run(now(), now(), survivorId);

    return db.prepare('SELECT * FROM MergeEvent WHERE mergeEventId = ?').get(mergeEventId);
  }

  /**
   * rollBackMerge(mergeEventId)
   * - 写一条 direction='rollback' 的 MergeEvent，恢复指针
   */
  function rollBackMerge(mergeEventId) {
    const evt = db.prepare('SELECT * FROM MergeEvent WHERE mergeEventId = ?').get(mergeEventId);
    if (!evt) throw new Error('MergeEvent not found: ' + mergeEventId);

    const rbEventId = sha1('rollback/' + mergeEventId + '/' + Date.now());
    db.prepare(
      "INSERT INTO MergeEvent (mergeEventId,survivorContactId,mergedContactId,reason,anchorKind,direction,rollbackOf,createdAt) VALUES (?,?,?,?,?, 'rollback', ?, ?)"
    ).run(rbEventId, evt.mergedContactId, evt.survivorContactId,
         'rollback of ' + mergeEventId, evt.anchorKind, mergeEventId, now());

    // 恢复 mergedId 的指针
    db.prepare(
      'UPDATE Contact SET mergedInto = NULL, updatedAt = ? WHERE contactId = ?'
    ).run(now(), evt.mergedContactId);

    // 恢复锚点
    db.prepare(
      'UPDATE ContactAnchor SET contactId = ? WHERE contactId = ?'
    ).run(evt.mergedContactId, evt.survivorContactId);

    // 恢复会话
    db.prepare(
      'UPDATE Conversation SET contactId = ? WHERE contactId = ?'
    ).run(evt.mergedContactId, evt.survivorContactId);

    return db.prepare('SELECT * FROM MergeEvent WHERE mergeEventId = ?').get(rbEventId);
  }

  /**
   * upsertAccountPersona(accountId, { persona, tone, background, targetAudience, taboos, status })
   */
  function upsertAccountPersona(accountId, input = {}) {
    const existing = db.prepare(
      "SELECT * FROM AccountPersona WHERE accountId = ? AND status = 'active'"
    ).get(accountId);
    const personaId = existing ? existing.personaId : sha1('persona/' + accountId + '/' + Date.now());
    db.prepare(
      'INSERT OR REPLACE INTO AccountPersona (personaId,accountId,persona,tone,background,targetAudience,taboos,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(
      personaId, accountId,
      input.persona ? JSON.stringify(input.persona) : null,
      input.tone || '',
      input.background || '',
      input.targetAudience || '',
      input.taboos ? JSON.stringify(input.taboos) : null,
      input.status || 'active',
      existing ? existing.createdAt : now(),
      now()
    );
    return db.prepare('SELECT * FROM AccountPersona WHERE personaId = ?').get(personaId);
  }

  /**
   * getEffectiveRules(scope)
   * scope: { accountId?, platform?, channel? }
   * 按 global ⊃ platform ⊃ account 叠加，同层取 priority 高者；
   * compliance 类未命中默认拒绝（返回的 denyByDefault 标记）。
   * 返回：{ rules: [...], denyByDefault: bool }
   */
  function getEffectiveRules(scope = {}) {
    const { accountId, platform, channel } = scope;
    // 查询：scope IN ('global')  OR (scope='platform' AND scopeKey=?)
    //              OR (scope='account' AND scopeKey=?)
    //              OR (scope='channel' AND scopeKey=?)
    // 且 status='active'，在有效期内
    const conditions = ["scope = 'global'"];
    const params = [];
    if (platform)  { conditions.push("(scope = 'platform' AND scopeKey = ?)");  params.push(platform); }
    if (accountId) { conditions.push("(scope = 'account'  AND scopeKey = ?)");  params.push(accountId); }
    if (channel)   { conditions.push("(scope = 'channel'  AND scopeKey = ?)");   params.push(channel); }

    const sql =
      'SELECT * FROM GovernanceRule WHERE status = \'active\' AND (' + conditions.join(' OR ') + ') ' +
      'AND (effectiveFrom IS NULL OR effectiveFrom <= ?) ' +
      'AND (effectiveTo   IS NULL OR effectiveTo   >= ?) ' +
      'ORDER BY priority DESC';
    const nowIso = now();
    const rules = db.prepare(sql).all(...params, nowIso, nowIso);

    // compliance 类未命中 → denyByDefault
    const hasCompliance = rules.some(r => r.ruleType === 'compliance');
    return { rules, denyByDefault: hasCompliance };
  }

  return {
    upsertAccountProfile,
    listAccountProfiles,
    upsertContact,
    listContacts,
    upsertConversation,
    listConversations,
    getMessages,
    mergeContact,
    rollBackMerge,
    upsertAccountPersona,
    getEffectiveRules,
    db,
  };
}

module.exports = { createStore };
