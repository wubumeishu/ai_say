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
  // task-2 双存储统一：schema.sql 落新表（Platform/PlatformGroup/AccountGroup/InboxSnapshot/AccountProfileRaw）
  // 后，应用 002 批次列补齐（PRAGMA table_info 探测式幂等 ADD COLUMN，duplicate 静默跳过但必 log）。
  // 失败不阻断 openDb（列补齐缺失只影响新端点，M0 既有读写不受影响）。
  try {
    const { applyAddColumns } = require('./migrations/002_add_columns.sql.js');
    applyAddColumns(db);
  } catch (e) {
    console.error('[store.openDb] 002 列补齐批次应用失败（不阻断，M0 表可用）:', e && e.message);
  }
  // 模块 1 · 003 批次：Contact.archived/blacklisted（出会消息队列过滤 + 批量操作）
  try {
    const { applyAddColumns: apply003 } = require('./migrations/003_add_contact_flags.sql.js');
    apply003(db);
  } catch (e) {
    console.error('[store.openDb] 003 列补齐批次应用失败（不阻断）:', e && e.message);
  }
  // v5.3 C 阶段：Conversation.followupStage 探测式 ADD COLUMN（幂等，同 002/003 先例）
  try {
    const cols = db.prepare('PRAGMA table_info(Conversation)').all().map((c) => c.name);
    if (cols.indexOf('followupStage') === -1) {
      db.exec('ALTER TABLE Conversation ADD COLUMN followupStage INTEGER NOT NULL DEFAULT 0');
      console.log('[store.openDb] Conversation 加列 followupStage（v5.3 C 阶段）');
    }
  } catch (e) {
    console.error('[store.openDb] followupStage 列补齐失败（不阻断）:', e && e.message);
  // 007 批次：资料池 Profile 表 + Lead.contactId 列
  try {
    const { up: apply007 } = require('./migrations/007_profile_pool.sql.js');
    apply007(db);
  } catch (e) {
    console.error('[store.openDb] 007 资料池批次应用失败（不阻断）:', e && e.message);
  }
  }
  return db;
}

function createStore({ dbPath = path.join(__dirname, '..', '..', 'data', 'aisay.db') } = {}) {
  if (!fs.existsSync(dbPath)) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  // 模块 1 · 出会运营标志表（专门存归档/拉黑标志；键=contactId，live 客户也能打标）
  db.exec(`
    CREATE TABLE IF NOT EXISTS ContactOpsFlags (
      contactId    TEXT PRIMARY KEY,
      archived     INTEGER NOT NULL DEFAULT 0,
      blacklisted  INTEGER NOT NULL DEFAULT 0,
      updatedAt    TEXT NOT NULL
    );
  `);
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
    // task-36 修 Bug：原 INSERT OR REPLACE 会把 occupation/language 硬编码 null、
    // 且新写入把 age/region/height 清成 null（旧值丢失）。改 ON CONFLICT DO UPDATE + COALESCE：
    // 新值为空则保留旧值，真正写入 occupation/language（不再 null）。
    db.prepare(
      "INSERT INTO ContactProfile (contactId,age,region,height,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(contactId) DO UPDATE SET " +
      "age = COALESCE(excluded.age, ContactProfile.age), " +
      "region = COALESCE(excluded.region, ContactProfile.region), " +
      "height = COALESCE(excluded.height, ContactProfile.height), " +
      "occupation = COALESCE(excluded.occupation, ContactProfile.occupation), " +
      "language = COALESCE(excluded.language, ContactProfile.language), " +
      "intent = excluded.intent, " +
      "interests = COALESCE(excluded.interests, ContactProfile.interests), " +
      "historySummary = COALESCE(excluded.historySummary, ContactProfile.historySummary), " +
      "fields = COALESCE(excluded.fields, ContactProfile.fields), " +
      "confidence = MAX(excluded.confidence, ContactProfile.confidence), " +
      "source = excluded.source, " +
      "updatedAt = excluded.updatedAt"
    ).run(
      contactId,
      String(contactRaw.age || '') || null,
      String(contactRaw.region || '') || null,
      String(contactRaw.height || '') || null,
      String(contactRaw.occupation || '') || null,
      String(contactRaw.language || '') || null,
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
  // ===== v5.3 · 备忘录 / 日历 / 模板库（运营工具箱） =====
  /** 备忘录 upsert。memoId = sha1('memo/' + accountId + '/' + (input.memoId||Date.now()))。 */
  function upsertMemo(accountId, input = {}) {
    const memoId = input.memoId || sha1('memo/' + (accountId || 'na') + '/' + Date.now());
    const existing = db.prepare('SELECT * FROM Memo WHERE memoId = ?').get(memoId);
    db.prepare(
      'INSERT OR REPLACE INTO Memo (memoId,accountId,contactId,kind,title,body,dueAt,pinned,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(
      memoId, accountId || null, input.contactId || null,
      input.kind || 'general', input.title || '', input.body || '',
      input.dueAt || null, input.pinned ? 1 : 0,
      existing ? existing.createdAt : now(), now()
    );
    return db.prepare('SELECT * FROM Memo WHERE memoId = ?').get(memoId);
  }

  /** 列备忘录（按 accountId；kind/contactId 可选过滤；pinned 优先 + updatedAt 倒序）。 */
  function listMemos(accountId, opts = {}) {
    const where = [];
    const args = [];
    if (accountId) { where.push('accountId = ?'); args.push(accountId); }
    if (opts.contactId) { where.push('contactId = ?'); args.push(opts.contactId); }
    if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
    const sql = 'SELECT * FROM Memo ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY pinned DESC, updatedAt DESC';
    return db.prepare(sql).all(...args);
  }

  function deleteMemo(memoId) {
    if (!memoId) return false;
    return db.prepare('DELETE FROM Memo WHERE memoId = ?').run(memoId).changes > 0;
  }

  /** 日历事件 upsert。eventId = sha1('cal/' + accountId + '/' + (input.eventId||Date.now()))。 */
  function upsertCalendarEvent(accountId, input = {}) {
    const eventId = input.eventId || sha1('cal/' + (accountId || 'na') + '/' + Date.now());
    const existing = db.prepare('SELECT * FROM CalendarEvent WHERE eventId = ?').get(eventId);
    db.prepare(
      'INSERT OR REPLACE INTO CalendarEvent (eventId,accountId,contactId,kind,title,scheduledAt,reminded,done,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(
      eventId, accountId || null, input.contactId || null,
      input.kind || 'followup', input.title || '', input.scheduledAt || now(),
      input.reminded ? 1 : (existing ? existing.reminded : 0),
      input.done ? 1 : (existing ? existing.done : 0),
      existing ? existing.createdAt : now(), now()
    );
    return db.prepare('SELECT * FROM CalendarEvent WHERE eventId = ?').get(eventId);
  }

  /** 取到期待办日历（scheduledAt <= until 且 done=0；accountId 可空=全账号）。 */
  function dueCalendarEvents(accountId, untilIso) {
    const where = ['done = 0'];
    const args = [];
    if (accountId) { where.push('accountId = ?'); args.push(accountId); }
    if (untilIso) { where.push('scheduledAt <= ?'); args.push(untilIso); }
    return db.prepare('SELECT * FROM CalendarEvent WHERE ' + where.join(' AND ') + ' ORDER BY scheduledAt ASC').all(...args);
  }

  function completeCalendarEvent(eventId) {
    if (!eventId) return false;
    return db.prepare("UPDATE CalendarEvent SET done = 1, updatedAt = ? WHERE eventId = ?").run(now(), eventId).changes > 0;
  }

  /** 模板库 upsert。phraseId = sha1('phrase/' + scope + '/' + (input.phraseId||Date.now()))。 */
  function upsertPhrase(input = {}) {
    const scope = input.scope || 'global';
    const phraseId = input.phraseId || sha1('phrase/' + scope + '/' + Date.now());
    const existing = db.prepare('SELECT * FROM PhraseLibrary WHERE phraseId = ?').get(phraseId);
    db.prepare(
      'INSERT OR REPLACE INTO PhraseLibrary (phraseId,scope,accountId,platform,scene,intent,lang,content,translated,tags,usageCount,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      phraseId, scope, input.accountId || null, input.platform || null,
      input.scene || 'general', input.intent || null, input.lang || 'ja',
      input.content || '', input.translated || null,
      Array.isArray(input.tags) ? JSON.stringify(input.tags) : (input.tags || null),
      input.usageCount || 0, input.source || 'manual',
      existing ? existing.createdAt : now(), now()
    );
    const row = db.prepare('SELECT * FROM PhraseLibrary WHERE phraseId = ?').get(phraseId);
    try { if (row && row.tags) row.tags = JSON.parse(row.tags); } catch (_) { if (row) row.tags = []; }
    return row;
  }

  /** 按场景/账号/平台/语言取模板（usageCount 倒序，热模板在前）。 */
  function listPhrases(filters = {}) {
    const where = [];
    const args = [];
    if (filters.scene) { where.push('scene = ?'); args.push(filters.scene); }
    if (filters.accountId) { where.push('(accountId = ? OR scope = ?)'); args.push(filters.accountId, 'global'); }
    if (filters.platform) { where.push('(platform = ? OR scope = ?)'); args.push(filters.platform, 'global'); }
    if (filters.lang) { where.push('lang = ?'); args.push(filters.lang); }
    const sql = 'SELECT * FROM PhraseLibrary ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY usageCount DESC, updatedAt DESC';
    const rows = db.prepare(sql).all(...args);
    rows.forEach((r) => { try { if (r.tags) r.tags = JSON.parse(r.tags); } catch (_) { r.tags = []; } });
    return rows;
  }

  /** 模板命中计数（被选用时 +1）。 */
  function bumpPhraseUsage(phraseId) {
    if (!phraseId) return;
    db.prepare('UPDATE PhraseLibrary SET usageCount = usageCount + 1, updatedAt = ? WHERE phraseId = ?').run(now(), phraseId);
  }

    // ===== v5.3 · C 阶段多轮状态机（followupStage + FollowupSop） =====
  /** 读会话的 followupStage（缺省 0）。 */
  function getFollowupStage(conversationId) {
    const row = db.prepare('SELECT followupStage FROM Conversation WHERE conversationId = ?').get(conversationId);
    return row ? Number(row.followupStage) || 0 : 0;
  }

  /** 设会话的 followupStage（0-5）。 */
  function setFollowupStage(conversationId, stage) {
    const s = Math.max(0, Math.min(5, Number(stage) || 0));
    db.prepare('UPDATE Conversation SET followupStage = ?, updatedAt = ? WHERE conversationId = ?').run(s, now(), conversationId);
    return s;
  }

  /** SOP upsert。sopId = sha1('sop/' + scope + '/' + (input.sopId||Date.now()))。 */
  function upsertFollowupSop(input = {}) {
    const scope = input.scope || 'global';
    const sopId = input.sopId || sha1('sop/' + scope + '/' + Date.now());
    const existing = db.prepare('SELECT * FROM FollowupSop WHERE sopId = ?').get(sopId);
    db.prepare(
      'INSERT OR REPLACE INTO FollowupSop (sopId,scope,accountId,platform,stage,afterDays,actionKind,templateKey,note,active,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      sopId, scope, input.accountId || null, input.platform || null,
      Number(input.stage) || 0, Number(input.afterDays) || 1,
      input.actionKind || 'care', input.templateKey || null, input.note || null,
      input.active === false ? 0 : 1,
      existing ? existing.createdAt : now(), now()
    );
    return db.prepare('SELECT * FROM FollowupSop WHERE sopId = ?').get(sopId);
  }

  /** 取活跃 SOP（scope 匹配 global/platform/account，按 stage 过滤）。 */
  function listFollowupSops(filters = {}) {
    const where = ['active = 1'];
    const args = [];
    if (filters.stage !== undefined) { where.push('stage = ?'); args.push(Number(filters.stage) || 0); }
    if (filters.platform) { where.push('(platform = ? OR scope = ?)'); args.push(filters.platform, 'global'); }
    if (filters.accountId) { where.push('(accountId = ? OR scope = ?)'); args.push(filters.accountId, 'global'); }
    return db.prepare('SELECT * FROM FollowupSop WHERE ' + where.join(' AND ') + ' ORDER BY stage, afterDays').all(...args);
  }

    // ===== v5.3 · 批1 群控基座（账号池/窗口池/跨账号任务分发） =====
  /** 账号池：列账号（可按 status/platform 过滤）。 */
  function listAccounts(filters = {}) {
    const where = [];
    const args = [];
    if (filters.status) { where.push('status = ?'); args.push(filters.status); }
    if (filters.platform) { where.push('platform = ?'); args.push(filters.platform); }
    const sql = 'SELECT * FROM Account ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY createdAt';
    return db.prepare(sql).all(...args);
  }

  /** 窗口池：列窗口（可按 accountId 过滤），带健康时间。 */
  function listWindows(filters = {}) {
    const where = [];
    const args = [];
    if (filters.accountId) { where.push('accountId = ?'); args.push(filters.accountId); }
    const sql = 'SELECT * FROM WindowInstance ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY accountId, seq';
    return db.prepare(sql).all(...args);
  }

  /** 标记窗口健康（巡检后回写 lastHealth）。 */
  function markWindowHealth(windowId, healthy, detail) {
    const ts = now();
    db.prepare('UPDATE WindowInstance SET lastHealth = ?, updatedAt = ? WHERE windowId = ?').run(
      JSON.stringify({ healthy: !!healthy, at: ts, detail: detail || null }), windowId && ts || ts, windowId
    );
  }

  /** 任务入队（跨账号分发）。taskId = sha1('task/' + type + '/' + accountId + '/' + Date.now())。 */
  function enqueueTask(input = {}) {
    const type = input.type || 'scan';
    const taskId = input.taskId || sha1('task/' + type + '/' + (input.accountId || 'na') + '/' + Date.now());
    db.prepare(
      'INSERT OR REPLACE INTO TaskQueue (taskId,platform,accountId,type,payload,status,priority,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(
      taskId, input.platform || 'ichigo', input.accountId || null, type,
      input.payload ? JSON.stringify(input.payload) : null,
      'pending', Number(input.priority) || 0, now(), now()
    );
    return db.prepare('SELECT * FROM TaskQueue WHERE taskId = ?').get(taskId);
  }

  /** 领取任务（分配器：取某账号下一条 pending，置 assigned + assignedAt）。 */
  function claimTask(accountId, platform) {
    const row = db.prepare(
      "SELECT * FROM TaskQueue WHERE status = 'pending' AND (accountId = ? OR accountId IS NULL) AND platform = ? ORDER BY priority DESC, createdAt ASC LIMIT 1"
    ).get(accountId, platform);
    if (!row) return null;
    db.prepare("UPDATE TaskQueue SET status = 'assigned', assignedAt = ?, updatedAt = ? WHERE taskId = ?").run(now(), now(), row.taskId);
    return db.prepare('SELECT * FROM TaskQueue WHERE taskId = ?').get(row.taskId);
  }

  /** 完成任务（done/failed + finishedAt + error）。 */
  function finishTask(taskId, ok, error) {
    db.prepare("UPDATE TaskQueue SET status = ?, finishedAt = ?, error = ?, updatedAt = ? WHERE taskId = ?")
      .run(ok ? 'done' : 'failed', now(), error || null, now(), taskId);
    return db.prepare('SELECT * FROM TaskQueue WHERE taskId = ?').get(taskId);
  }

  /** 列任务（按 status/account 过滤，倒序）。 */
  function listTasks(filters = {}) {
    const where = [];
    const args = [];
    if (filters.status) { where.push('status = ?'); args.push(filters.status); }
    if (filters.accountId) { where.push('accountId = ?'); args.push(filters.accountId); }
    const sql = 'SELECT * FROM TaskQueue ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY updatedAt DESC LIMIT 200';
    return db.prepare(sql).all(...args);
  }

    /**
   * v5.2 快乐平台 · 客户招募帖（ContactRecruitPost）



   * upsert：postId = sha1(contactId + '|' + billboardId)；同客户多帖按 billboardId 分。
   * 活库缺表时由调用方先 migrate（_migration v5 挂 ContactRecruitPost），此处不自动建表。
   * @param {string} contactId
   * @param {object} input { billboardId, subject, body, genreName, postTime, readCount, retCount, tags[], telephone, source }
   * @returns {object|null} 写入后的行（tags 已解析回数组）
   */
  function upsertContactRecruitPost(contactId, input = {}) {
    if (!contactId) return null;
    const billboardId = String(input.billboardId || '');
    const postId = sha1('recruitpost/' + contactId + '/' + billboardId);
    const existing = db.prepare('SELECT * FROM ContactRecruitPost WHERE postId = ?').get(postId);
    db.prepare(
      'INSERT OR REPLACE INTO ContactRecruitPost (postId,contactId,billboardId,subject,body,genreName,postTime,readCount,retCount,tags,telephone,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      postId, contactId,
      billboardId || null,
      input.subject || null,
      input.body || null,
      input.genreName || null,
      input.postTime || null,
      Number.isFinite(input.readCount) ? input.readCount : null,
      Number.isFinite(input.retCount) ? input.retCount : null,
      Array.isArray(input.tags) ? JSON.stringify(input.tags) : (typeof input.tags === 'string' ? input.tags : null),
      input.telephone || null,
      input.source || 'happy-billboard',
      existing ? existing.createdAt : now(),
      now()
    );
    return parseRecruitPost(db.prepare('SELECT * FROM ContactRecruitPost WHERE postId = ?').get(postId));
  }

  /** 客户招募帖列表（按 contactId，倒序 updatedAt）。 */
  function listContactRecruitPosts(contactId) {
    const rows = db.prepare('SELECT * FROM ContactRecruitPost WHERE contactId = ? ORDER BY updatedAt DESC').all(contactId);
    return rows.map(parseRecruitPost);
  }

  /** 行解析：tags JSON 数组回解；无行返 null。 */
  function parseRecruitPost(row) {
    if (!row) return null;
    try { if (row.tags) row.tags = JSON.parse(row.tags); } catch (_) { row.tags = []; }
    return row;
  }

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
  /**
   * ensureBbsCooldownRule(spec) — 模块3 防封：招募帖子 1h 冷却期落库为 rateLimit 类 GovernanceRule
   * spec: { ruleId?, cooldownMinutes?, platform?, accountId? }
   * 幂等：ruleId 已存在（任意 status）→ 不插入，返回 { created: false, ruleId, status }
   * 未带 status 约束 → INSERT 默认 active；活库无表由调用方先 migrate（_migration 挂）
   * @returns {{ created: boolean, ruleId: string, status?: string }}
   */
  function ensureBbsCooldownRule(spec = {}) {
    spec = spec || {};
    const ruleId = spec.ruleId || 'bbs-post-cooldown';
    const minutes = spec.cooldownMinutes || 60;
    const scope = spec.accountId ? 'account' : (spec.platform ? 'platform' : 'global');
    const scopeKey = spec.accountId || spec.platform || null;
    const ruleJson = JSON.stringify({
      kind: 'bbsPostCooldown',
      cooldownMinutes: minutes,
      desc: '出会 BBS 招募帖子发帖/改帖/删帖后 ' + minutes + ' 分钟冷却期内不可再发帖（平台明写 1h）',
      appliesTo: ['bbs_createPost', 'bbs_editPost', 'bbs_deletePost']
    });
    const nowIso = now();
    // 幂等：先查 ruleId 是否存在（任意 status）
    const existing = db.prepare('SELECT ruleId, status FROM GovernanceRule WHERE ruleId = ?').get(ruleId);
    if (existing) return { created: false, ruleId: ruleId, status: existing.status };
    db.prepare(
      'INSERT INTO GovernanceRule (ruleId, ruleType, scope, scopeKey, rule, priority, status, effectiveFrom, createdAt, updatedAt) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      ruleId,
      'rateLimit',
      scope,
      scopeKey,
      ruleJson,
      100, // account 层 priority
      'active',
      nowIso,
      nowIso,
      nowIso
    );
    return { created: true, ruleId: ruleId, status: 'active' };
  }

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

  // =================================================================
  // task-3 · 频控账本 LedgerHandle（rate-ledger-persist.md §4，Variant A 挂 v2 外键）
  // 句柄 = 唯一写入口；_sentLog/_pendingQueue 数组保持快照读形状不破 4 处断言（选法 a）。
  // 内存热账本：loadRateLedger 载 7 天缓冲快照（跨重启限额有效）+ 本进程 push 行；
  //   withinRateLimit 永远读内存合并视图（(ts,seq) 字典序），不查 SQLite（热路径 μs 级）；
  //   SQLite 仅做启动载入 + 50ms 异步兜底落库 + 审计聚合。
  // =================================================================
  const sha1Hex = (s2) => crypto.createHash('sha1').update(String(s2)).digest('hex');
  const _ledgerBuf = [];      // 本进程热账本（内存）
  const _ledgerQueue = [];    // 异步落库队列（{table, op, row}）
  let _ledgerTimer = null;    // 50ms 批量 flush 定时器
  let _ledgerLoaded = false;  // loadRateLedger 完成标记

  // 确定性 pk：sha1(accountId|contactId|ts|kind|seq)，INSERT OR IGNORE 幂等去重
  function _sentLogPk(row, seq) {
    return sha1Hex([row.accountId, row.contactId, row.ts, row.kind || 'guide', (seq != null ? seq : 0)].join('|'));
  }

  /**
   * loadRateLedger()：启动时 SQLite → 内存热账本（快照窗口 7 天缓冲，覆盖 24h+30min remindWindow，挂账 #2）。
   * @returns {boolean} 载入成功（失败回 false，调用方降级 NoopLedger）
   */
  function loadRateLedger() {
    try {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000; // 7 天缓冲
      _ledgerBuf.length = 0;
      db.prepare('SELECT ts, kind, blocked, pending, templateVersion, variant, seq, accountId, contactId FROM SentLog WHERE ts >= ? ORDER BY ts ASC').all(cutoff)
        .forEach((r) => {
          _ledgerBuf.push({ accountId: r.accountId, contactId: r.contactId, ts: r.ts, kind: r.kind, blocked: !!r.blocked, pending: !!r.pending, templateVersion: r.templateVersion, variant: r.variant, seq: r.seq });
        });
      _ledgerLoaded = true;
      console.log('[store.loadRateLedger] 热账本载入 ' + _ledgerBuf.length + ' 条（7 天缓冲，跨重启限额有效）');
      return true;
    } catch (e) {
      console.error('[store.loadRateLedger] 载入失败（降级内存空白账本，24h 限额仅本进程内有效）:', e && e.message);
      _ledgerLoaded = false;
      return false;
    }
  }

  /**
   * pushLedger(row, table)：双写——内存即时（限频判定立即生效）+ 异步落库队列（50ms 批量 INSERT OR IGNORE 幂等）。
   * 句柄是唯一写入口（NoopLedger 降级路径除外）。@returns {boolean}
   */
  function pushLedger(row, table = 'SentLog') {
    if (!row) return false;
    if (table === 'SentLog') _ledgerBuf.push(Object.assign({ seq: row.seq != null ? row.seq : _ledgerBuf.length }, row));
    _ledgerQueue.push({ table, op: 'INSERT', row: Object.assign({}, row), _enqueuedAt: Date.now() });
    if (!_ledgerTimer) {
      _ledgerTimer = setInterval(function() { _flushLedgerQueue(); }, 50);
      if (_ledgerTimer.unref) _ledgerTimer.unref(); // 不阻止进程退出（SIGTERM 前 syncFlushLedger）
    }
    return true;
  }

  /**
   * _flushLedgerQueue()：批量落库（单事务，INSERT OR IGNORE 幂等去重）。
   * 失败：保留队列头 + log（铁律 §0.5 禁空 catch）；下次 flush 重放（幂等不重不丢）。
   */
  function _flushLedgerQueue() {
    if (!_ledgerQueue.length) return;
    const batch = _ledgerQueue.splice(0, _ledgerQueue.length);
    try {
      db.exec('BEGIN');
      for (const item of batch) {
        if (item.table === 'SentLog') {
          const row = item.row;
          const seq = row.seq != null ? row.seq : 0;
          db.prepare("INSERT OR IGNORE INTO SentLog (sentLogId,accountId,contactId,conversationId,ts,kind,blocked,pending,templateVersion,variant,seq) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(row.sentLogId || _sentLogPk(row, seq), row.accountId, row.contactId, row.conversationId || null, row.ts,
              row.kind || 'guide', row.blocked ? 1 : 0, row.pending ? 1 : 0, row.templateVersion || null, row.variant || null, seq);
        } else if (item.table === 'GateBlock') {
          const row = item.row;
          db.prepare("INSERT OR IGNORE INTO GateBlock (gateBlockId,accountId,contactId,ts,kind,reason) VALUES (?,?,?,?,?,?)")
            .run(row.gateBlockId || sha1Hex([row.ts, row.reason, row.kind || 'other'].join('|')), row.accountId || null, row.contactId || null, row.ts, row.kind || 'other', row.reason);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      console.error('[store.flushLedger] 批量落库失败（' + batch.length + ' 条保留队首重放）:', e && e.message);
      try { db.exec('ROLLBACK'); } catch (e2) { console.error('[store.flushLedger] ROLLBACK 失败:', e2 && e2.message); }
      _ledgerQueue.unshift(...batch);
    }
  }

  /**
   * syncFlushLedger()：SIGTERM/进程退出前同步 flush（对齐 §3.2 优雅退出，纳入 shutdown）。
   */
  function syncFlushLedger() {
    if (_ledgerTimer) { clearInterval(_ledgerTimer); _ledgerTimer = null; }
    _flushLedgerQueue();
  }

  /**
   * snapshotLedger()：返回当前热账本数组快照（供 _sentLog 每 1s 异步同步，供旧断言与 getAuditSummary 用，不进限频判定）。
   */
  function snapshotLedger() { return _ledgerBuf.slice(); }

  /**
   * sinceLedger(t, dim)：读内存热账本（快照+本进程合并视图，(ts,seq) 字典序，不查 db）。
   * dim = { accountId?, contactId? }；返回 ts>=t 的行，按 (ts, seq) 升序（打回 #4）。
   */
  function sinceLedger(t, dim = {}) {
    const rows = _ledgerBuf.filter((r) => r.ts >= t && (!dim.accountId || r.accountId === dim.accountId) && (!dim.contactId || r.contactId === dim.contactId));
    rows.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
    return rows;
  }

  /**
   * lastForLedger(contactId)：rollbackLastTalk 专用——热账本查该客户最近一条（跨重启有效，打回 #2）。
   */
  function lastForLedger(contactId) {
    const rows = _ledgerBuf.filter((r) => r.contactId === contactId);
    rows.sort((a, b) => (b.ts - a.ts) || (b.seq - a.seq));
    return rows[0] || null;
  }

  /**
   * pushPendingLedger(row)：PendingQueue 同步单行写（confirmSend 关键路径，§4.2 不可乱序）。
   * @returns {string} pendingId
   */
  function pushPendingLedger(row) {
    const textHash = sha1Hex(String(row.text || ''));
    const pendingId = row.pendingId || sha1Hex([row.accountId, row.contactId, row.ts, textHash].join('|'));
    try {
      db.prepare("INSERT OR IGNORE INTO PendingQueue (pendingId,accountId,contactId,tier,text,talkRef,gateBlocked,gateReason,confirmed,confirmedAt,expired,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(pendingId, row.accountId, row.contactId, row.tier || 'warm', row.text,
          row.talkRef ? JSON.stringify(row.talkRef) : null, row.gateBlocked ? 1 : 0, row.gateReason || '', 0, null, 0, row.createdAt || new Date().toISOString());
      console.log('[store.pushPendingLedger] PendingQueue 同步写 ' + pendingId);
    } catch (e) {
      console.error('[store.pushPendingLedger] PendingQueue 同步写失败（confirmSend 仍走内存，账本缺失审计）:', e && e.message);
    }
    return pendingId;
  }

  /**
   * confirmPendingLedger(pendingId, confirmedAtIso)：老板点确认后同步更新 PendingQueue.confirmed=1（§4.2 关键路径同步写）。
   */
  function confirmPendingLedger(pendingId, confirmedAtIso) {
    try {
      const r = db.prepare("UPDATE PendingQueue SET confirmed=1, confirmedAt=? WHERE pendingId=?").run(confirmedAtIso, pendingId);
      if (!r || !r.changes) console.warn('[store.confirmPendingLedger] pendingId 未命中（可能已归档/未落库），仅内存确认: ' + pendingId);
      return !!r && !!r.changes;
    } catch (e) {
      console.error('[store.confirmPendingLedger] 同步更新失败（内存 confirmed 已置，账本缺失）:', e && e.message);
      return false;
    }
  }

  /**
   * archiveRateLedgers()：裁剪归档（§2 时间窗 + 账号分片，防无限增长；dba 终版口径）。
   * SentLog：cutoff = now - 7d（7 天缓冲覆盖 24h+30min remindWindow）→ 按 月+账号 分片 .sqlite → DELETE；
   *   PendingQueue：先 expire 状态机（UPDATE expired=1 WHERE confirmed=0 AND createdAt<now-72h，confirmed 行 72h 内不置 1），
   *   再物理归档（createdAt<now-72h 全量，含 expired+confirmed；confirmed=1 且 72h 内既不 expire 也不归档）；
   *   GateBlock：cutoff = now-30d，同 SentLog 分片归档。
   * 归档失败只 log（模块.动作+错误），不阻断主流程；下次定时器补扫。
   */
  function archiveRateLedgers() {
    const nowMs = Date.now();
    const ym = new Date(nowMs).getUTCFullYear() + String(new Date(nowMs).getUTCMonth() + 1).padStart(2, '0');
    const sentCutoff = nowMs - 7 * 24 * 3600 * 1000;          // 7 天缓冲
    const pendingCutoffIso = new Date(nowMs - 72 * 3600 * 1000).toISOString(); // 72h
    const gateCutoff = nowMs - 30 * 24 * 3600 * 1000;          // 30 天
    let archivedSent = 0, archivedPending = 0, expiredPending = 0, archivedGate = 0;
    const archDir = path.join(__dirname, '..', '..', 'data', 'archive');
    function openShard(file, ddl) {
      fs.mkdirSync(archDir, { recursive: true });
      const full = path.join(archDir, file);
      const { DatabaseSync } = require('node:sqlite');
      if (!fs.existsSync(full)) {
        const fresh = new DatabaseSync(full);
        fresh.exec(ddl);
        return fresh;
      }
      return new DatabaseSync(full);
    }
    try {
      // 1) PendingQueue expire 状态机（confirmed 行 72h 内不置 1）
      const exp = db.prepare("UPDATE PendingQueue SET expired=1 WHERE confirmed=0 AND createdAt < ? AND expired=0").run(pendingCutoffIso);
      expiredPending = (exp && exp.changes) ? exp.changes : 0;
      // 2) SentLog 归档（ts < cutoff 按 accountId 分片 .sqlite）
      const sentOld = db.prepare('SELECT DISTINCT accountId FROM SentLog WHERE ts < ?').all(sentCutoff);
      for (const row of sentOld) {
        const acc = row.accountId;
        const rows = db.prepare('SELECT * FROM SentLog WHERE ts < ? AND accountId = ?').all(sentCutoff, acc);
        const shard = openShard('sentlog-' + ym + '-' + acc + '.sqlite',
          "CREATE TABLE IF NOT EXISTS SentLog (sentLogId TEXT PRIMARY KEY, accountId TEXT, contactId TEXT, conversationId TEXT, ts INTEGER, kind TEXT, blocked INTEGER, pending INTEGER, templateVersion TEXT, variant TEXT, seq INTEGER)");
        for (const r of rows) {
          shard.prepare('INSERT OR IGNORE INTO SentLog (sentLogId,accountId,contactId,conversationId,ts,kind,blocked,pending,templateVersion,variant,seq) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(r.sentLogId, r.accountId, r.contactId, r.conversationId || null, r.ts, r.kind, r.blocked, r.pending, r.templateVersion, r.variant, r.seq);
        }
        db.prepare('DELETE FROM SentLog WHERE ts < ? AND accountId = ?').run(sentCutoff, acc);
        if (shard.close) shard.close();
        archivedSent += rows.length;
      }
      // 3) PendingQueue 物理归档（createdAt < 72h，含 expired+confirmed 全量；confirmed=1 且 72h 内不裁）
      const pendingOld = db.prepare('SELECT * FROM PendingQueue WHERE createdAt < ?').all(pendingCutoffIso);
      if (pendingOld.length) {
        const byAcc = {};
        pendingOld.forEach((r) => { const k = r.accountId || 'default'; (byAcc[k] = byAcc[k] || []).push(r); });
        for (const acc of Object.keys(byAcc)) {
          const shard = openShard('pending-' + ym + '-' + acc + '.sqlite',
            "CREATE TABLE IF NOT EXISTS PendingQueue (pendingId TEXT PRIMARY KEY, accountId TEXT, contactId TEXT, tier TEXT, text TEXT, talkRef TEXT, gateBlocked INTEGER, gateReason TEXT, confirmed INTEGER, confirmedAt TEXT, expired INTEGER, createdAt TEXT)");
          byAcc[acc].forEach((r) => {
            shard.prepare('INSERT OR IGNORE INTO PendingQueue (pendingId,accountId,contactId,tier,text,talkRef,gateBlocked,gateReason,confirmed,confirmedAt,expired,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(r.pendingId, r.accountId, r.contactId, r.tier, r.text, r.talkRef, r.gateBlocked, r.gateReason, r.confirmed, r.confirmedAt, r.expired, r.createdAt);
          });
          db.prepare("DELETE FROM PendingQueue WHERE createdAt < ? AND COALESCE(accountId,'') = ?").run(pendingCutoffIso, acc);
          if (shard.close) shard.close();
          archivedPending += byAcc[acc].length;
        }
      }
      // 4) GateBlock 归档（30 天分片；accountId 可空 → global 分片）
      const gateAccs = db.prepare('SELECT DISTINCT COALESCE(accountId, ?) AS acc FROM GateBlock WHERE ts < ?').all('global', gateCutoff);
      for (const row of gateAccs) {
        const acc = row.acc;
        const isGlobal = acc === 'global';
        const sel = isGlobal
          ? db.prepare('SELECT * FROM GateBlock WHERE ts < ? AND accountId IS NULL')
          : db.prepare('SELECT * FROM GateBlock WHERE ts < ? AND accountId = ?');
        const del = isGlobal
          ? db.prepare('DELETE FROM GateBlock WHERE ts < ? AND accountId IS NULL')
          : db.prepare('DELETE FROM GateBlock WHERE ts < ? AND accountId = ?');
        const rows = isGlobal ? sel.all(gateCutoff) : sel.all(gateCutoff, acc);
        const shard = openShard('gateblock-' + ym + '-' + acc + '.sqlite',
          "CREATE TABLE IF NOT EXISTS GateBlock (gateBlockId TEXT PRIMARY KEY, accountId TEXT, contactId TEXT, ts INTEGER, kind TEXT, reason TEXT)");
        for (const r of rows) {
          shard.prepare('INSERT OR IGNORE INTO GateBlock (gateBlockId,accountId,contactId,ts,kind,reason) VALUES (?,?,?,?,?,?)')
            .run(r.gateBlockId, r.accountId, r.contactId, r.ts, r.kind, r.reason);
        }
        if (isGlobal) del.run(gateCutoff); else del.run(gateCutoff, acc);
        if (shard.close) shard.close();
        archivedGate += rows.length;
      }
      console.log('[store.archiveRateLedgers] SentLog ' + archivedSent + ' / PendingQueue expire ' + expiredPending + ' 归档 ' + archivedPending + ' / GateBlock ' + archivedGate + '（' + ym + ' 分片）');
    } catch (e) {
      console.error('[store.archiveRateLedgers] 裁剪归档失败（不阻断，下次定时器补扫）:', e && e.message);
    }
    return { archivedSent, archivedPending, expiredPending, archivedGate };
  }

  // =======================================================================
  // 模块 1 · 出会批量操作（归档/拉黑/恢复）—— 003 批次列补齐后启用
  // =======================================================================
  /** 批量归档/拉黑：把一组 contactId 的指定标志置 1（ContactOpsFlags 表 upsert，live 客户也能打标）。 */
  function batchSetContactFlag(contactIds, flag) {
    if (!Array.isArray(contactIds) || !contactIds.length) return { updated: 0, ids: [] };
    const valid = (flag === 'archived' || flag === 'blacklisted') ? flag : null;
    if (!valid) throw new Error('batchSetContactFlag: flag must be archived|blacklisted');
    const now = new Date().toISOString();
    const ids = contactIds.map(String);
    const run = db.prepare(
      'INSERT INTO ContactOpsFlags (contactId, ' + valid + ', updatedAt) VALUES (?, 1, ?) ' +
      'ON CONFLICT(contactId) DO UPDATE SET ' + valid + ' = 1, updatedAt = excluded.updatedAt'
    );
    let n = 0;
    for (const id of ids) {
      const r = run.run(id, now);
      n += (r.changes || 0);
    }
    return { updated: n, ids: ids };
  }

  /** 批量恢复（取消归档/拉黑）：把一组 contactId 的指定标志置 0（ContactOpsFlags 表）。 */
  function batchClearContactFlag(contactIds, flag) {
    if (!Array.isArray(contactIds) || !contactIds.length) return { updated: 0, ids: [] };
    const valid = (flag === 'archived' || flag === 'blacklisted') ? flag : null;
    if (!valid) throw new Error('batchClearContactFlag: flag must be archived|blacklisted');
    const now = new Date().toISOString();
    const ids = contactIds.map(String);
    const marks = ids.map(() => '?').join(',');
    const run = db.prepare(
      'UPDATE ContactOpsFlags SET ' + valid + ' = 0, updatedAt = ? WHERE contactId IN (' + marks + ')'
    );
    const out = run.run(now, ...ids);
    return { updated: out.changes, ids: ids };
  }

  /** 读一组 contactId 的归档/拉黑标志（ContactOpsFlags 表；miss 兜底 0/0）。 */
  function getContactFlags(contactIds) {
    if (!Array.isArray(contactIds) || !contactIds.length) return new Map();
    const ids = contactIds.map(String);
    const marks = ids.map(() => '?').join(',');
    const rows = db.prepare(
      'SELECT contactId, archived, blacklisted FROM ContactOpsFlags WHERE contactId IN (' + marks + ')'
    ).all(...ids);
    const m = new Map();
    rows.forEach((r) => m.set(String(r.contactId), { archived: r.archived || 0, blacklisted: r.blacklisted || 0 }));
    return m;
  }

  let _closed = false;
  /** task-6 crash-guard：SQLite 关闭（幂等；SIGTERM/SIGINT/uncaughtException 前调用，防 -wal 残留） */
  function close() {
    if (_closed) return;
    _closed = true;
    try { db.close(); } catch (e) { console.warn('[store.close] 关库失败（可能已关）:', e && e.message); }
  }

  
  // ---- 005 · 线索池 Lead（引流一期"侦测"统一落点；平台-窗口累积留痕，同客户以最新为准）----
  function listLeads(filter = {}, opts = {}) {
    const where = [];
    const params = [];
    if (filter.platform) { where.push('platform = ?'); params.push(String(filter.platform)); }
    if (filter.sourceDim) { where.push('sourceDim = ?'); params.push(String(filter.sourceDim)); }
    if (filter.accountId) { where.push('accountId = ?'); params.push(String(filter.accountId)); }
    if (filter.online) { where.push('online = ?'); params.push(String(filter.online)); }
    if (filter.ageFrom != null) { where.push('age >= ?'); params.push(String(filter.ageFrom)); }
    if (filter.ageTo != null) { where.push('age <= ?'); params.push(String(filter.ageTo)); }
    const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 1000));
    const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
    try {
      return db.prepare('SELECT * FROM Lead' + whereSql + ' ORDER BY firstSeen DESC LIMIT ?').all(...params, limit);
    } catch (e) {
      console.error('[store.listLeads] 查询失败:', e && e.message);
      return [];
    }
  }

  function leadBySourceDim(filter = {}) {
    const where = [];
    const params = [];
    if (filter.platform) { where.push('platform = ?'); params.push(String(filter.platform)); }
    if (filter.accountId) { where.push('accountId = ?'); params.push(String(filter.accountId)); }
    const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
    try {
      return db.prepare('SELECT sourceDim, COUNT(*) n FROM Lead' + whereSql + ' GROUP BY sourceDim').all(...params);
    } catch (e) {
      console.error('[store.leadBySourceDim] 查询失败:', e && e.message);
      return [];
    }
  }

  function upsertLead(input = {}) {
    const ts = now();
    const memberId = input.memberId || (input.extras && input.extras.memberId) || null;
    const identityKey = memberId
      ? String(input.platform || 'ichigo') + '/m/' + memberId
      : String(input.platform || 'ichigo') + '/n/' + (input.name || '') + '/' + (input.age != null ? input.age : '') + '/' + (input.region || '') + '/' + (input.sourceDim || '');
    const leadId = input.leadId || ('L' + sha1(identityKey));
    const old = db.prepare('SELECT * FROM Lead WHERE leadId = ?').get(leadId);
    const firstSeen = old ? old.firstSeen : (input.firstSeen || ts);
    let newExtras = {};
    try { newExtras = JSON.parse(JSON.stringify(input.extras || {})); } catch (e) { newExtras = input.extras || {}; }
    if (old) {
      let oldExtras = {};
      try { oldExtras = JSON.parse(old.extras || '{}'); } catch (e) { oldExtras = {}; }
      const history = Array.isArray(oldExtras._history) ? oldExtras._history.slice(-4) : [];
      history.push({ at: ts, online: old.online, age: old.age, region: old.region, intro: String(old.selfIntro || '').slice(0, 40) });
      newExtras._history = history.slice(-5);
      db.prepare(
        'UPDATE Lead SET online=?, avatarUrl=?, profileUrl=?, selfIntro=?, sourceDim=?, lastSeen=?, extras=?, updatedAt=? WHERE leadId=?'
      ).run(
        input.online || null,
        input.avatarUrl || null,
        input.profileUrl || null,
        input.selfIntro || null,
        String(input.sourceDim || 'unknown'),
        input.lastSeen || ts,
        JSON.stringify(newExtras),
        ts,
        leadId
      );
    } else {
      db.prepare(
        'INSERT INTO Lead (leadId, platform, accountId, name, gender, age, region, online, avatarUrl, profileUrl, selfIntro, sourceDim, firstSeen, lastSeen, warmupDay, contactedAt, extras, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        leadId,
        String(input.platform || 'ichigo'),
        input.accountId || null,
        String(input.name || ''),
        input.gender || null,
        input.age != null ? String(input.age) : null,
        input.region || null,
        input.online || null,
        input.avatarUrl || null,
        input.profileUrl || null,
        input.selfIntro || null,
        String(input.sourceDim || 'unknown'),
        firstSeen,
        input.lastSeen || ts,
        Number(input.warmupDay) || 0,
        input.contactedAt || null,
        JSON.stringify(newExtras),
        ts,
        ts
      );
    }
    return db.prepare('SELECT * FROM Lead WHERE leadId = ?').get(leadId);
  }

  const insertLead = upsertLead;

  // ================================================================ 007 · 资料池 Profile(第二阶段运营对象)
  /** promote 线索进资料池: 复制 Lead 快照 + 算已沟通(msgCount) + 默认 crawlStatus=pending */
  function upsertProfile(input = {}) {
    const ts = now();
    const leadId = String(input.leadId || '');
    if (!leadId) throw new Error('upsertProfile 需要 leadId');
    const profileId = input.profileId || ('P' + sha1Hex(leadId));
    const old = db.prepare('SELECT * FROM Profile WHERE profileId = ?').get(profileId);
    const communicated = old && old.communicated ? 1 : 0;
    const msgCount = old ? Number(old.msgCount || 0) : 0;
    const crawlStatus = old ? old.crawlStatus : 'pending';
    if (old) {
      db.prepare(
        'UPDATE Profile SET contactId=?, platform=?, accountId=?, name=?, gender=?, age=?, region=?, online=?, avatarUrl=?, profileUrl=?, selfIntro=?, sourceDim=?, communicated=?, msgCount=?, extras=?, updatedAt=? WHERE profileId=?'
      ).run(
        input.contactId || old.contactId || null,
        String(input.platform || old.platform || 'ichigo'),
        input.accountId || old.accountId || null,
        String(input.name || old.name || ''),
        input.gender || old.gender || null,
        input.age != null ? String(input.age) : old.age,
        input.region || old.region || null,
        input.online || old.online || null,
        input.avatarUrl || old.avatarUrl || null,
        input.profileUrl || old.profileUrl || null,
        input.selfIntro || old.selfIntro || null,
        String(input.sourceDim || old.sourceDim || 'unknown'),
        input.communicated != null ? (input.communicated ? 1 : 0) : communicated,
        input.msgCount != null ? Number(input.msgCount) : msgCount,
        JSON.stringify(input.extras || old.extras ? (function () { try { return JSON.parse(old.extras || '{}'); } catch (_) { return {}; } })() : {}),
        ts, profileId
      );
    } else {
      db.prepare(
        'INSERT INTO Profile (profileId, leadId, contactId, platform, accountId, name, gender, age, region, online, avatarUrl, profileUrl, selfIntro, sourceDim, crawlStatus, communicated, msgCount, extras, pooledAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        profileId, leadId, input.contactId || null,
        String(input.platform || 'ichigo'), input.accountId || null,
        String(input.name || ''), input.gender || null, input.age != null ? String(input.age) : null,
        input.region || null, input.online || null, input.avatarUrl || null, input.profileUrl || null,
        input.selfIntro || null, String(input.sourceDim || 'unknown'), crawlStatus,
        input.communicated ? 1 : 0, Number(input.msgCount || 0), JSON.stringify(input.extras || {}), ts, ts
      );
    }
    return db.prepare('SELECT * FROM Profile WHERE profileId = ?').get(profileId);
  }

  /** 标记资料池抓取状态(done/failed) + 写回抓到的资料字段(extras 合并) */
  function markProfileCrawled(profileId, status, mergedExtras) {
    const row = db.prepare('SELECT * FROM Profile WHERE profileId = ?').get(profileId);
    if (!row) return null;
    let extras = {};
    try { extras = JSON.parse(row.extras || '{}'); } catch (_) { extras = {}; }
    if (mergedExtras && typeof mergedExtras === 'object') Object.assign(extras, mergedExtras);
    extras.crawledAt = now();
    db.prepare('UPDATE Profile SET crawlStatus=?, extras=?, updatedAt=? WHERE profileId=?').run(
      String(status || 'done'), JSON.stringify(extras), now(), profileId
    );
    return db.prepare('SELECT * FROM Profile WHERE profileId = ?').get(profileId);
  }

  /** 刷新资料池"已沟通"标记: 按 contactId 查 Conversation/Message 有记录即 communicated=1 + msgCount */
  function refreshProfileComms(profileId) {
    const row = db.prepare('SELECT * FROM Profile WHERE profileId = ?').get(profileId);
    if (!row || !row.contactId) return row;
    let msgCount = 0;
    try {
      const c = db.prepare('SELECT COUNT(*) AS c FROM Message WHERE contactId = ?').get(row.contactId);
      msgCount = c ? Number(c.c || 0) : 0;
    } catch (_) { msgCount = 0; }
    const communicated = msgCount > 0 ? 1 : 0;
    db.prepare('UPDATE Profile SET communicated=?, msgCount=?, updatedAt=? WHERE profileId=?').run(
      communicated, msgCount, now(), profileId
    );
    return db.prepare('SELECT * FROM Profile WHERE profileId = ?').get(profileId);
  }

  /** 资料池列表: 按 platform/crawlStatus/filter, 解析 extras */
  function listProfiles(filter = {}, opts = {}) {
    const where = [];
    const params = [];
    if (filter.platform) { where.push('platform = ?'); params.push(String(filter.platform)); }
    if (filter.accountId) { where.push('accountId = ?'); params.push(String(filter.accountId)); }
    if (filter.crawlStatus) { where.push('crawlStatus = ?'); params.push(String(filter.crawlStatus)); }
    if (filter.communicated != null) { where.push('communicated = ?'); params.push(filter.communicated ? 1 : 0); }
    if (filter.sourceDim) { where.push('sourceDim = ?'); params.push(String(filter.sourceDim)); }
    const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 1000));
    const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
    try {
      return db.prepare('SELECT * FROM Profile' + whereSql + ' ORDER BY updatedAt DESC LIMIT ?').all(...params, limit);
    } catch (e) {
      console.error('[store.listProfiles] 查询失败:', e && e.message);
      return [];
    }
  }

  function getProfile(profileId) {
    return db.prepare('SELECT * FROM Profile WHERE profileId = ?').get(profileId) || null;
  }


  // ================================================================ 006 · 卡片流 SendQueue + OperationLog
  /** SendQueue · 后台串行发送队列(20s±10s 浮动调度)。强副作用留痕, 铁律 0.2。 */
  function enqueueSend(q) {
    const ts = now();
    const queueId = q.queueId || ('Q' + crypto.createHash('sha1').update(q.conversationId + ':' + q.talkText + ':' + ts).digest('hex').slice(0, 12));
    const dbSlot = db.prepare('SELECT COALESCE(MAX(slotSeq), 0) + 1 AS n FROM SendQueue WHERE status = ?');
    const slot = dbSlot.get('pending').n;
    // 20s 基础 + 0~10s 随机浮动; 按 slot 排布(前一条未发不派后一条 → 实际由 dispatcher 串行, scheduledAt 给前端倒计时展示)
    const baseMs = 20000 + Math.floor(Math.random() * 10000);
    const scheduledAt = new Date(Date.now() + baseMs * slot).toISOString();
    db.prepare(`INSERT INTO SendQueue (queueId, conversationId, platform, accountId, contactKey, talkText, talkZh, talkIntent, talkConfidence, slotSeq, scheduledAt, status, createdAt, updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`)
      .run(queueId, q.conversationId, q.platform || 'ichigo', q.accountId || '', q.contactKey || null, q.talkText, q.talkZh || null, q.talkIntent || null, q.talkConfidence != null ? q.talkConfidence : null, slot, scheduledAt, ts, ts);
    return db.prepare('SELECT * FROM SendQueue WHERE queueId = ?').get(queueId);
  }

  function listSendQueue(status, limit) {
    const lim = Math.min(parseInt(limit || '50', 10), 200);
    if (status) {
      return db.prepare('SELECT * FROM SendQueue WHERE status = ? ORDER BY slotSeq ASC, scheduledAt ASC LIMIT ?').all(status, lim);
    }
    return db.prepare('SELECT * FROM SendQueue ORDER BY slotSeq ASC, scheduledAt ASC LIMIT ?').all(lim);
  }

  function getSendQueue(queueId) {
    return db.prepare('SELECT * FROM SendQueue WHERE queueId = ?').get(queueId);
  }

  function markSendQueue(queueId, patch) {
    const ts = now();
    const old = getSendQueue(queueId);
    if (!old) return null;
    const keys = Object.keys(patch || {});
    if (!keys.length) return old;
    const setSql = keys.map(k => k + ' = ?').join(', ') + ", updatedAt = ?";
    const vals = keys.map(k => patch[k]);
    vals.push(ts, queueId);
    db.prepare('UPDATE SendQueue SET ' + setSql + ' WHERE queueId = ?').run(...vals);
    return getSendQueue(queueId);
  }

  function cancelSendQueue(queueId) {
    return markSendQueue(queueId, { status: 'cancelled' });
  }

  function revokeSendQueue(queueId, result) {
    return markSendQueue(queueId, { status: 'revoked', revokedAt: now(), result: result ? String(result).slice(0, 500) : null });
  }

  /** OperationLog · 强副作用审计(拉黑/重生成/微调/发送/撤回/撤出), §0.3 留痕。 */
  function logOperation(op) {
    const ts = now();
    const r = db.prepare('INSERT INTO OperationLog (conversationId, platform, accountId, opType, detail, result, at) VALUES (?,?,?,?,?,?,?)')
      .run(op.conversationId || null, op.platform || 'ichigo', op.accountId || null, op.opType, op.detail ? String(op.detail) : null, op.result || 'ok', ts);
    return { opId: Number(r.lastInsertRowid), at: ts };
  }

  function listOperationLog(conversationId, limit) {
    const lim = Math.min(parseInt(limit || '50', 10), 200);
    if (conversationId) {
      return db.prepare('SELECT * FROM OperationLog WHERE conversationId = ? ORDER BY at DESC LIMIT ?').all(conversationId, lim);
    }
    return db.prepare('SELECT * FROM OperationLog ORDER BY at DESC LIMIT ?').all(lim);
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
    close,
    // 005 · 线索池 Lead
    listLeads,
    leadBySourceDim,
    upsertLead,
    insertLead,
    // 007 · 资料池 Profile(第二阶段)
    upsertProfile, markProfileCrawled, refreshProfileComms, listProfiles, getProfile,
    // 006 · 卡片流 SendQueue + OperationLog
    enqueueSend,
    listSendQueue,
    getSendQueue,
    markSendQueue,
    cancelSendQueue,
    revokeSendQueue,
    logOperation,
    listOperationLog,
    // task-3 · 频控账本 LedgerHandle 导出（选法 a：数组=快照读，句柄=写入口）
    loadRateLedger,
    pushLedger,
    pushPendingLedger,
    confirmPendingLedger,
    syncFlushLedger,
    snapshotLedger,
    sinceLedger,
    lastForLedger,
    archiveRateLedgers,
    // 模块 1 · 出会批量操作
    batchSetContactFlag,
    batchClearContactFlag,
    getContactFlags,
    // 模块3 · BBS 1h 冷却规则落库（幂等）
    ensureBbsCooldownRule,
    // v5.2 · 客户招募帖（快乐平台 get_profile_billboard/get_billboard 坐实）
    upsertContactRecruitPost,
    listContactRecruitPosts,
    // v5.3 · 运营工具箱（备忘录/日历/模板库）
    upsertMemo, listMemos, deleteMemo,
    upsertCalendarEvent, dueCalendarEvents, completeCalendarEvent,
    upsertPhrase, listPhrases, bumpPhraseUsage,
    // v5.3 · C 阶段多轮状态机（followupStage + FollowupSop）
    getFollowupStage, setFollowupStage, upsertFollowupSop, listFollowupSops,
    // v5.3 · 批1 群控基座（账号池/窗口池/任务分发）
    listAccounts, listWindows, markWindowHealth,
    enqueueTask, claimTask, finishTask, listTasks,
  };
}

module.exports = { createStore };
