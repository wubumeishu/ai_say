// =============================================================================
// Ai SAY task-2 · 双存储统一迁移脚本（migrateUnify.js）
// 依据：docs/plan/dual-store-unify.md §2 伪码 + §3 双写/切换/回滚
// 终极蓝图 §-1.1：群控基座 [平台ID-账号ID-会话ID] 三级嵌套，三轨归位
//   （JSON 轨 data/*.json + SQLite 轨 aisay.db + 缓存轨 console-cache.json → SQLite 单轨）。
//
// 导出：runMigration({ dbPath, jsonDir, cachePath, dryRun, phase })
//   - dryRun=true：只读，输出三轨对账计数（accounts/contacts/conversations/cache）+
//     4.5 跨轨归并预演（不写 DB），用于迁移前核对 §3.1 双写镜像与 §3.2 切单轨前置。
//   - dryRun=false：实写（事务），执行 4 步 + 4.5 跨轨归并 + _migration v2 标记。
//   - phase='A'：双写镜像（JSON 轨保留三元组键只读归档 + SQLite 单轨写入；缓存轨归位）；
//     phase='B'：切单轨（JSON 轨转只读归档标记 + 对账；回滚 = backups/aisay-pre-unify-*.db 快照）。
//
// 约束（铁律）：
//   - 不碰旧 14 表既有数据（全 ADD/INSERT OR IGNORE/ON CONFLICT，零删改）；
//   - 迁移只读源数据（JSON/缓存），写 SQLite；不真发；
//   - 归并可回滚：4.5 跨轨归并走 store.mergeContact（MergeEvent 审计 + rollBackMerge 回滚，§0.3）；
//   - catch 必 log 模块.动作+错误（禁空 catch，§0.5）。
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

// 幂等拼三级键（与 store.js M0 同构，零映射成本）：
//   accountId    = sha1('acc/' + platform + '/' + windowId + '/' + label)
//   contactId(weak) = sha1('weak/' + legacyKey)
//   conversationId = sha1(accountId + '|' + contactId + '|' + channel)
const ACC = (platform, windowId, label) => sha1('acc/' + platform + '/' + windowId + '/' + label);
const WEAK = (legacyKey) => sha1('weak/' + legacyKey);
const CONV = (accountId, contactId, channel) => sha1(accountId + '|' + contactId + '|' + channel);

function loadJsonArr(p) {
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) || []; }
  catch (e) { console.error('[migrateUnify] 读 ' + p + ' 失败（按空处理）:', e && e.message); return []; }
}

/**
 * 执行迁移。
 * @param {object} o { dbPath, jsonDir, cachePath, dryRun, phase, logger }
 * @returns {{ ok, dryRun, counts, crossMerge, errors }}
 */
function runMigration(o) {
  o = o || {};
  const log = o.logger || console;
  const dryRun = !!o.dryRun;
  const errors = [];
  let db = null, store = null;
  const counts = { accounts: 0, contacts: 0, conversations: 0, cache: 0, crossMerge: 0 };

  try {
    const { createStore } = require('./store');
    store = createStore({ dbPath: o.dbPath });
    db = store.db;

    // 读三轨源（只读）
    const jsonDir = o.jsonDir || path.join(path.dirname(o.dbPath), '..', 'data');
    const accounts = loadJsonArr(path.join(jsonDir, 'account-profiles.json'));
    const contacts = loadJsonArr(path.join(jsonDir, 'contacts.json'));
    const conversations = loadJsonArr(path.join(jsonDir, 'conversations.json'));
    const cachePath = o.cachePath || path.join(jsonDir, 'console-cache.json');
    const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : null; // 缓存轨是单对象 {contacts:{}}，非数组（区别于 JSON 轨三文件）
    const cacheContacts = (cache && cache.contacts) ? Object.values(cache.contacts) : [];

    counts.accounts = accounts.length;
    counts.contacts = contacts.length;
    counts.conversations = conversations.length;
    counts.cache = cacheContacts.length;

    const tx = (fn) => {
      if (dryRun) return fn(); // dryRun 不实写（调用方需自行避免 db.write）
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { log.error('[migrateUnify] ROLLBACK 失败:', e2 && e2.message); } throw e; }
    };

    if (!dryRun) {
      tx(() => {
        // 1. 账号归位：JSON account-profiles → Account + WindowInstance + AccountProfileRaw + AccountPersona
        for (const a of accounts) {
          const accountId = ACC(a.platform, a.windowId, a.accountLabel || a.nickname || '');
          const legacyKey = [a.platform, a.windowId, a.accountLabel || a.nickname || ''].join('/');
          const now = new Date().toISOString();
          db.prepare("INSERT INTO Account (accountId,platform,label,status,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?) " +
            "ON CONFLICT(accountId) DO UPDATE SET platform=excluded.platform, label=excluded.label, legacyKey=excluded.legacyKey, updatedAt=excluded.updatedAt")
            .run(accountId, a.platform, a.accountLabel || a.nickname || '', 'active', legacyKey, a.createdAt || now, now);
          db.prepare("INSERT INTO WindowInstance (windowId,accountId,seq,lastHealth,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?) " +
            "ON CONFLICT(windowId) DO UPDATE SET accountId=excluded.accountId, legacyKey=excluded.legacyKey, updatedAt=excluded.updatedAt")
            .run(String(a.windowId || ''), accountId, 0, a.lastHealth || null, legacyKey, a.createdAt || now, now);
          // 大 JSON 桶 → AccountProfileRaw（不拆细列，§1.2 新增 2）
          const raw = JSON.stringify({ fields: a.fields || null, sections: a.sections || null, lines: a.lines || null,
            nextLevelPages: a.nextLevelPages || null, bottomNav: a.bottomNav || null, detection: a.detection || null,
            navigation: a.navigation || null, raw: a.raw || null });
          db.prepare("INSERT INTO AccountProfileRaw (accountId,payload,updatedAt) VALUES (?,?,?) ON CONFLICT(accountId) DO UPDATE SET payload=excluded.payload, updatedAt=excluded.updatedAt")
            .run(accountId, raw, now);
          // 人设（仅昵称，脱敏白名单 persona/tone/background，§0.3；pageUrl/mypageUrl 入 AccountPersona 新列）
          if (a.persona || a.tone || a.background || a.pageUrl || a.mypageUrl) {
            const personaId = sha1('persona/' + accountId);
            db.prepare("INSERT INTO AccountPersona (personaId,accountId,persona,tone,background,targetAudience,taboos,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?) " +
              "ON CONFLICT(personaId) DO UPDATE SET persona=excluded.persona, tone=excluded.tone, background=excluded.background, updatedAt=excluded.updatedAt")
              .run(personaId, accountId, a.persona || null, a.tone || '', a.background || '', a.targetAudience || '',
                a.taboos ? JSON.stringify(a.taboos) : null, 'active', a.createdAt || now, now);
            // pageUrl/mypageUrl 走 002 新列（AccountPersona）
            db.prepare("UPDATE AccountPersona SET pageUrl=COALESCE(?,pageUrl), mypageUrl=COALESCE(?,mypageUrl) WHERE personaId=?")
              .run(a.pageUrl || null, a.mypageUrl || null, personaId);
          }
        }

        // 2. 客户归位：JSON contacts → Contact(weak 锚点) + ContactProfile + ContactAnchor
        for (const c of contacts) {
          const legacyKey = c.key || [c.platform, c.windowId, c.contactKey].join('/');
          const contactId = WEAK(legacyKey);
          const now = new Date().toISOString();
          const ct = c.contact || {};
          db.prepare("INSERT INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?) " +
            "ON CONFLICT(contactId) DO UPDATE SET displayName=COALESCE(excluded.displayName, Contact.displayName), nickname=COALESCE(excluded.nickname, Contact.nickname), lastSeen=excluded.lastSeen, updatedAt=excluded.updatedAt")
            .run(contactId, ct.name || c.contactKey || '', ct.name || c.contactKey || '', null, c.firstSeen || c.createdAt || now, c.lastSeen || c.updatedAt || now, 'new', c.createdAt || now, now);
          // ContactProfile（COALESCE 不覆盖旧值，§3.4 task-36 已修口径沿用）
          const ageNum = (ct.ageNum != null) ? ct.ageNum : (ct.age ? parseInt(String(ct.age), 10) || null : null);
          db.prepare("INSERT INTO ContactProfile (contactId,age,region,height,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
            "ON CONFLICT(contactId) DO UPDATE SET " +
            "age=COALESCE(excluded.age, ContactProfile.age), region=COALESCE(excluded.region, ContactProfile.region), " +
            "height=COALESCE(excluded.height, ContactProfile.height), occupation=COALESCE(excluded.occupation, ContactProfile.occupation), " +
            "language=COALESCE(excluded.language, ContactProfile.language), interests=COALESCE(excluded.interests, ContactProfile.interests), " +
            "historySummary=COALESCE(excluded.historySummary, ContactProfile.historySummary), fields=COALESCE(excluded.fields, ContactProfile.fields), " +
            "confidence=MAX(excluded.confidence, ContactProfile.confidence), updatedAt=excluded.updatedAt")
            .run(contactId, ct.age || null, ct.region || null, ct.height || null, ct.occupation || null, ct.language || null,
              'unknown', ct.candidates ? JSON.stringify(ct.candidates) : null, ct.intro || '',
              ct.fields ? JSON.stringify(ct.fields) : null, 0.5, 'legacy', c.createdAt || now, now);
          // loginMethod=LINE → strong 锚点（§1.3 升 strong，source=legacy）
          if (ct.loginMethod === 'LINE') {
            const anchorId = sha1(contactId + '|strong|line/' + legacyKey);
            db.prepare("INSERT OR IGNORE INTO ContactAnchor (anchorId,contactId,kind,value,confidence,source,createdAt) VALUES (?,?,?,?,?,?,?)")
              .run(anchorId, contactId, 'strong', 'line/' + legacyKey, 0.9, 'legacy', now);
          }
          // 三元组弱锚点（schema 已有 legacyKey 降级 weak，source=legacy）
          const wAnchorId = sha1(contactId + '|weak|' + legacyKey);
          db.prepare("INSERT OR IGNORE INTO ContactAnchor (anchorId,contactId,kind,value,confidence,source,createdAt) VALUES (?,?,?,?,?,?,?)")
            .run(wAnchorId, contactId, 'weak', legacyKey, 0.5, 'legacy', now);
        }

        // 3. 会话归位：JSON conversations → Conversation + Message（append-only，seq 去重）
        for (const cv of conversations) {
          const legacyKey = cv.key || [cv.platform, cv.windowId, cv.contactKey].join('/');
          const accountId = ACC(cv.platform, cv.windowId, cv.accountLabel || cv.accountKey || '');
          const contactId = WEAK(legacyKey);
          const conversationId = CONV(accountId, contactId, cv.channel || 'ichigo');
          const now = new Date().toISOString();
          db.prepare("INSERT INTO Conversation (conversationId,accountId,contactId,channel,status,lastActiveAt,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?) " +
            "ON CONFLICT(conversationId) DO UPDATE SET lastActiveAt=excluded.lastActiveAt, legacyKey=excluded.legacyKey, updatedAt=excluded.updatedAt")
            .run(conversationId, accountId, contactId, cv.channel || 'ichigo', cv.status || 'active', cv.lastActiveAt || now, legacyKey, cv.createdAt || now, now);
          const msgs = Array.isArray(cv.messages) ? cv.messages : [];
          msgs.forEach((m, idx) => {
            const seq = (m.seq != null) ? m.seq : idx;
            const messageId = sha1(conversationId + '|' + seq + '|' + (m.original || m.text || ''));
            db.prepare("INSERT OR IGNORE INTO Message (messageId,conversationId,seq,role,original,translation,timeText,timeIso,kind,name,url,raw,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
              .run(messageId, conversationId, seq, m.role || 'other', m.original || m.text || null, m.translation || null,
                (m.time && m.time.text) || m.timeText || null, m.timeIso || null, m.kind || null, m.name || null, m.url || null,
                m.selector || m.className ? JSON.stringify({ selector: m.selector || null, className: m.className || null }) : null,
                cv.createdAt || now);
          });
        }

        // 4. 缓存轨归位（第三轨，离三级嵌套最近）：console-cache.json contacts → Contact(强锚点 q-token) + ContactProfile + InboxSnapshot
        for (const c of cacheContacts) {
          if (!c || !c.contactId) continue;
          const qToken = String(c.contactId); // 缓存轨 q-token = 平台会话唯一 ID，升 strong 锚点 source=chat
          // 缓存轨 contactId 已是三级嵌套键（q-token）；若该 q-token 在 JSON 轨无对应 weak 锚点，
          // 则直接以 q-token 作为 Contact.contactId（群控基座下强锚点优先）。
          let contactId = qToken;
          const now = new Date().toISOString();
          // 查是否已有该 q-token 的 strong 锚点指向某 contact（缓存轨重跑幂等）
          const existing = db.prepare("SELECT ca.contactId FROM ContactAnchor ca WHERE ca.kind='strong' AND ca.source='chat' AND ca.value=? LIMIT 1").get(qToken);
          if (existing) contactId = existing.contactId;
          db.prepare("INSERT INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?) " +
            "ON CONFLICT(contactId) DO UPDATE SET displayName=COALESCE(excluded.displayName, Contact.displayName), lastSeen=excluded.lastSeen, updatedAt=excluded.updatedAt")
            .run(contactId, c.name || '', c.name || '', null, c.firstSeen || now, c.lastSeen || now, 'active', c.firstSeen || now, now);
          // strong 锚点（q-token，source=chat）
          const sAnchorId = sha1(contactId + '|strong|chat/' + qToken);
          db.prepare("INSERT OR IGNORE INTO ContactAnchor (anchorId,contactId,kind,value,confidence,source,createdAt) VALUES (?,?,?,?,?,?,?)")
            .run(sAnchorId, contactId, 'strong', qToken, 0.99, 'chat', now);
          // ContactProfile（缓存快照：age/region/ageNum + 未读 4 字段 + 在线分档 + 头像 → InboxSnapshot）
          if (c.age || c.region || c.ageNum != null) {
            db.prepare("INSERT INTO ContactProfile (contactId,age,region,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) " +
              "ON CONFLICT(contactId) DO UPDATE SET age=COALESCE(excluded.age, ContactProfile.age), region=COALESCE(excluded.region, ContactProfile.region), " +
              "confidence=MAX(excluded.confidence, ContactProfile.confidence), updatedAt=excluded.updatedAt")
              .run(contactId, c.age || null, c.region || null, null, null, 'unknown', null, '', null, 0.6, 'chat', now, now);
            if (c.ageNum != null) db.prepare("UPDATE ContactProfile SET ageNum=? WHERE contactId=? AND (ageNum IS NULL OR ageNum=0)").run(c.ageNum, contactId);
          }
          // InboxSnapshot（未读态归位，§0.2 未读 4 字段 + 在线分档；accountId 取缓存轨默认账号——
          // 缓存轨单账号形态，accountId 用 Platform 种子 'ikuru' 下第一个账号，缺省用 sha1('acc/ikuru/default')）
          const accountId = c.accountId || ACC('ikuru', 'default', c.label || 'cache');
          // FK 保证：InboxSnapshot.accountId → Account，缓存轨默认账号行先存在（幂等）
          db.prepare("INSERT OR IGNORE INTO Account (accountId,platform,label,status,legacyKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)")
            .run(accountId, 'ikuru', c.label || 'cache', 'active', 'ikuru/default/' + (c.label || 'cache'), now, now);
          db.prepare("INSERT INTO InboxSnapshot (contactId,accountId,lastMsgTime,unread,onlineTier,fetchedAt) VALUES (?,?,?,?,?,?) " +
            "ON CONFLICT(contactId,accountId) DO UPDATE SET lastMsgTime=excluded.lastMsgTime, unread=excluded.unread, onlineTier=excluded.onlineTier, fetchedAt=excluded.fetchedAt")
            .run(contactId, accountId, c.lastMsgTime || '', c.unread || 0, c.onlineTier || null, c.updatedAt || now);
        }

                // 4.5 跨轨归并去重（总控裁决方案 2 · 弱指纹 likelySame 队列 + dba 方案 B 幂等收口）
        // 数据结论（node 1 实跑核实）：现网缓存轨 q-token（base64 会话 ID）与 JSON 轨 contactKey
        //   （明文 label，如 AA_test / sp.194964.com）**交集为 0，不同源**——原 a.value=w.value
        //   直接 JOIN 恒空转（假归并）。故 4.5 改接 dedup 弱指纹 likelySame 队列：
        //   ① 缓存轨 Contact（q-token 强锚点）与 JSON 轨 Contact（三元组弱锚点）按
        //      dedup.getWeakFingerprint（归一化姓名+地区+年龄，ContactProfile.region/age）比对；
        //   ② 命中对以 4.5 专属 reason 前缀 'queue:cross-track-unify|…' 入 MergeEvent 队列（§0.3 审计）；
        //      方向 survivor=q-token 侧（a）/ merged=三元组侧（b）；
        //   ③ dba 方案 B 幂等收口：入队前 DELETE 本对旧 queue:cross-track-unify| 行（重跑不产生
        //      重复队列行，且 scan 回来的是干净本次队列，不误并历史非 4.5 队列）；
        //   ④ 只 merge 本次 4.5 入队集合（4.5 专属前缀），不碰历史 likelySame 队列（人工确认域）。
        // TODO(4.5 边界 · 总控裁决留痕)：强归并（q-token=contactKey 直接 JOIN）待缓存轨补全
        //   q-token↔contactKey 映射锚点后启用；当前走弱指纹 likelySame 队列（人工确认语义），
        //   现网两套 key 不同源故强归并不适用。AGENTS.md §3.7 双存储段同步此边界。
        const { createDedup } = require('./dedup');
        const dedupInst = createDedup({ store });
        const QUEUE_PREFIX = 'queue:cross-track-unify|'; // 4.5 专属前缀（与历史 'queue: ' 区分，精准收口）
        const cacheIds = (cacheContacts.map((c) => String(c && c.contactId)).filter(Boolean));
        const jsonLegacyKeys = contacts.map((c) => c.key || [c.platform, c.windowId, c.contactKey].join('/')).filter(Boolean);
        const jsonWeakIds = jsonLegacyKeys.map((k) => WEAK(k));
        // 同批去重（避免 (cq,jw) 与 (jw,cq) 双向重复入队）
        const seenPair = new Set();
        const queuedNow = []; // 本次 4.5 入队的 queueId 集合（精准归并边界）
        for (const cq of cacheIds) {
          for (const jw of jsonWeakIds) {
            if (cq === jw) continue;
            const pairKey = [cq, jw].sort().join('§');
            if (seenPair.has(pairKey)) continue;
            seenPair.add(pairKey);
            // 与 dedup.getWeakFingerprint 同构：Contact.displayName/nickname + ContactProfile.region/age
            const fpA = dedupInst.getWeakFingerprint(cq);
            const fpB = dedupInst.getWeakFingerprint(jw);
            const emptyFp = dedupInst.normalizeWeakKey({ displayName: '', nickname: '', region: '', age: '' });
            if (fpA && fpB && fpA === fpB && fpA !== emptyFp) {
              try {
                // dba 方案 B：入队前清本对旧 4.5 队列行（幂等收口，重跑不重复入队）
                db.prepare("DELETE FROM MergeEvent WHERE survivorContactId=? AND mergedContactId=? AND reason LIKE ? " +
                  "OR (survivorContactId=? AND mergedContactId=? AND reason LIKE ?)")
                  .run(cq, jw, QUEUE_PREFIX + '%', jw, cq, QUEUE_PREFIX + '%');
                // 入队（4.5 专属前缀；direction='merge' + anchorKind='weak'，§0.3 可回滚）
                const qid = sha1('4.5/' + cq + '/' + jw + '/' + fpA); // 无 Date.now()，重跑同对同指纹 = 同 queueId（幂等）
                db.prepare(
                  "INSERT OR IGNORE INTO MergeEvent (mergeEventId,survivorContactId,mergedContactId,reason,anchorKind,direction,rollbackOf,createdAt) VALUES (?,?,?,?, 'weak', 'merge', NULL, ?)"
                ).run(qid, cq, jw, QUEUE_PREFIX + 'fp=' + fpA.slice(0, 12), new Date().toISOString());
                queuedNow.push(qid);
              } catch (e) { console.error('[migrateUnify.4.5] 入队失败（不阻断迁移）:', e && e.message); }
            }
          }
        }
        // 只归并本次 4.5 队列（queuedNow 集合，不碰历史 likelySame）
        counts.crossMerge = queuedNow.length;
        if (queuedNow.length) {
          for (const qid of queuedNow) {
            const q = db.prepare('SELECT * FROM MergeEvent WHERE mergeEventId=?').get(qid);
            if (!q) continue;
            const row = db.prepare('SELECT mergedInto FROM Contact WHERE contactId=?').get(q.mergedContactId);
            if (row && row.mergedInto) continue; // 幂等：已归并跳过
            try { store.mergeContact(q.survivorContactId, q.mergedContactId, 'cross-track-unify', 'weak'); }
            catch (e) { console.error('[migrateUnify.4.5] mergeContact 失败（不阻断迁移）:', e && e.message); }
          }
        }
        log.warn('[migrateUnify] 4.5 弱指纹 likelySame 队列命中 ' + queuedNow.length + ' 对（4.5 专属前缀 ' + QUEUE_PREFIX + '，仅归并本次队列；历史 likelySame 队列走人工确认，不碰）');
        // 5. 双写过渡标记（Phase A：JSON 轨保留只读归档；Phase B：切单轨）
        db.prepare("INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES (22, ?, ?)")
          .run(new Date().toISOString(), 'task-2 双写过渡：Phase ' + (o.phase || 'A') + '（JSON 轨归档 + SQLite 单轨）');
      });
    } else {
      // dryRun：只读对账 + 4.5 跨轨归并预演（不实写；与实写同构 = 弱指纹比对，非旧 a.value=w.value JOIN）
      const { createDedup: cd2 } = require('./dedup');
      const dedupInst2 = cd2({ store });
      const cacheIds2 = cacheContacts.map((c) => String(c && c.contactId)).filter(Boolean);
      const jsonWeakIds2 = contacts.map((c) => WEAK(c.key || [c.platform, c.windowId, c.contactKey].join('/'))).filter(Boolean);
      const emptyFp2 = dedupInst2.normalizeWeakKey({ displayName: '', nickname: '', region: '', age: '' });
      let dryPairs = 0;
      for (const cq of cacheIds2) {
        for (const jw of jsonWeakIds2) {
          if (cq === jw) continue;
          const fpA = dedupInst2.getWeakFingerprint(cq);
          const fpB = dedupInst2.getWeakFingerprint(jw);
          if (fpA && fpB && fpA === fpB && fpA !== emptyFp2) dryPairs++;
        }
      }
      counts.crossMerge = dryPairs;
      log.warn('[migrateUnify] dryRun 4.5 弱指纹预演：命中 ' + dryPairs + ' 对（未实写；实写走 4.5 专属前缀队列）');    }

    if (!dryRun && store.close) { try { store.close(); } catch (e) { log.error('[migrateUnify] store.close 失败:', e && e.message); } }
    return { ok: true, dryRun, counts, crossMerge: counts.crossMerge, errors };
  } catch (e) {
    errors.push(String(e && e.message || e));
    log.error('[migrateUnify] 迁移失败:', e && e.stack || e);
    if (store && store.close) { try { store.close(); } catch (e2) { log.error('[migrateUnify] close 失败:', e2 && e2.message); } }
    return { ok: false, dryRun, counts, crossMerge: 0, errors };
  }
}

// ---------------------------------------------------------------- 对账（Phase B 切单轨前置，§3.2）
/**
 * reconcile({ dbPath, jsonDir, cachePath }) → 三轨计数 + 不一致清单。
 * 切单轨前必须：JSON/缓存轨每条在 SQLite 有对应（幂等键命中）；不一致 → 中止切单轨，先补镜像。
 */
function reconcile(o) {
  o = o || {};
  const log = o.logger || console;
  const jsonDir = o.jsonDir || path.join(path.dirname(o.dbPath), '..', 'data');
  const out = { ok: true, missing: [], counts: {} };
  try {
    const { createStore } = require('./store');
    const store = createStore({ dbPath: o.dbPath });
    const db = store.db;
    const accounts = loadJsonArr(path.join(jsonDir, 'account-profiles.json'));
    const contacts = loadJsonArr(path.join(jsonDir, 'contacts.json'));
    const conversations = loadJsonArr(path.join(jsonDir, 'conversations.json'));
    out.counts = { jsonAccounts: accounts.length, jsonContacts: contacts.length, jsonConversations: conversations.length };
    for (const a of accounts) {
      const id = ACC(a.platform, a.windowId, a.accountLabel || a.nickname || '');
      const r = db.prepare('SELECT 1 FROM Account WHERE accountId=?').get(id);
      if (!r) out.missing.push({ type: 'account', key: id });
    }
    for (const c of contacts) {
      const legacyKey = c.key || [c.platform, c.windowId, c.contactKey].join('/');
      const id = WEAK(legacyKey);
      const r = db.prepare('SELECT 1 FROM Contact WHERE contactId=?').get(id);
      if (!r) out.missing.push({ type: 'contact', key: id });
    }
    for (const cv of conversations) {
      const legacyKey = cv.key || [cv.platform, cv.windowId, cv.contactKey].join('/');
      const accountId = ACC(cv.platform, cv.windowId, cv.accountLabel || cv.accountKey || '');
      const contactId = WEAK(legacyKey);
      const id = CONV(accountId, contactId, cv.channel || 'ichigo');
      const r = db.prepare('SELECT 1 FROM Conversation WHERE conversationId=?').get(id);
      if (!r) out.missing.push({ type: 'conversation', key: id });
    }
    out.ok = out.missing.length === 0;
    if (!out.ok) log.warn('[migrateUnify] 对账缺失 ' + out.missing.length + ' 条，切单轨前需补镜像写');
    if (store.close) { try { store.close(); } catch (e) { log.error('[migrateUnify.reconcile] close 失败:', e && e.message); } }
    return out;
  } catch (e) {
    log.error('[migrateUnify.reconcile] 对账失败:', e && e.message);
    return { ok: false, missing: [], counts: {}, errors: [String(e && e.message || e)] };
  }
}

// ---------------------------------------------------------------- 回滚（§3.3：backups 快照 + 停镜像写）
/**
 * rollback({ dbPath, backupDbPath, jsonDir }) → 用迁移前快照回滚 SQLite（停双写镜像），
 * JSON 轨归档保留（不删，§1.12 用户同意才清理）。回滚 = 数据可逆，非删档。
 */
function rollback(o) {
  o = o || {};
  const log = o.logger || console;
  try {
    if (!fs.existsSync(o.backupDbPath)) throw new Error('备份快照不存在: ' + o.backupDbPath);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(o.dbPath);
    db.exec('PRAGMA busy_timeout = 15000');
    // 停双写镜像（Phase B 切单轨后回滚 = 恢复迁移前 DB 快照）
    const src = fs.readFileSync(o.backupDbPath);
    db.exec('VACUUM INTO ' + JSON.stringify(o.dbPath)); // 先 flush
    db.close();
    fs.copyFileSync(o.backupDbPath, o.dbPath);
    log.warn('[migrateUnify.rollback] 已从 ' + o.backupDbPath + ' 回滚（停双写镜像，JSON 轨归档保留）');
    return { ok: true };
  } catch (e) {
    log.error('[migrateUnify.rollback] 回滚失败:', e && e.message);
    return { ok: false, errors: [String(e && e.message || e)] };
  }
}

module.exports = { runMigration, reconcile, rollback, ACC, WEAK, CONV };
