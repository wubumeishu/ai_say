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
  };
}

module.exports = { createStore };
