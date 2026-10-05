// =============================================================================
// Ai SAY M2 · 跨平台客户归并算法（dedup）
// 导出：createDedup({ store })
// 依据：01 §3.4（客户去重合并策略）、02 §3（归并键分层 + 误并防护）
//
// 分层规则：
//   强锚点（LINE openId / 邮箱 / 手机号 / 设备指纹）命中 ⇒ 直接 merge
//   平台内 ID 同平台 ⇒ 直接 merge
//   弱锚点（归一化姓名 + 年龄 + 地区）⇒ 仅进 likelySame 待确认队列，不自动合并
//   误并护栏：强锚点命中但「平台+地区」矛盾 ⇒ 降级为弱锚点，不自动合并
//
// API：
//   candidateMergePairs(a, b)   → { mergeable, reason, downgraded }
//   autoMergeStrong(pair)       → MergeEvent | null（仅强锚点且无矛盾）
//   queueLikelySame(pair)       → 入 likelySame 队列（写 MergeEvent direction='merge' + reason='queue:...' 标记）
//   rollBackMerge(mergeEventId) → 调用 store.rollBackMerge
// =============================================================================
const crypto = require('crypto');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

// 强锚点 kind 集合（命中即 merge）
const STRONG_ANCHOR_KINDS = new Set([
  'line_openid',   // LINE openId
  'email',         // 邮箱
  'phone',         // 手机号
  'device_fingerprint', // 设备指纹
]);

// 归一化：姓名/地区/年龄的弱锚点指纹
function normalizeWeakKey(contact) {
  const name    = String(contact.displayName || contact.nickname || '').trim().toLowerCase();
  const region  = String(contact.region || '').trim().toLowerCase();
  const age     = String(contact.age || '').trim();
  return sha1('weak/' + name + '|' + region + '|' + age);
}

function createDedup({ store }) {
  if (!store || !store.db) throw new Error('createDedup: store 必须来自 createStore()');
  const db = store.db;
  const now = () => new Date().toISOString();

  // ------------------------------------------------------------- 锚点查询 --
  /** 取某 contact 的全部强锚点（kind ∈ STRONG_ANCHOR_KINDS） */
  function getStrongAnchors(contactId) {
    return db.prepare(
      "SELECT * FROM ContactAnchor WHERE contactId = ? AND kind = 'strong' " +
      "AND value != '' ORDER BY confidence DESC"
    ).all(contactId);
  }

  /** 按 (kind, value) 反查是否有其它 contact 已持有同一强锚点（合并判定） */
  function findStrongAnchorOwner(kind, value, excludeContactId = null) {
    const rows = db.prepare(
      "SELECT ca.* FROM ContactAnchor ca " +
      "WHERE ca.kind = ? AND ca.value = ? AND ca.contactId != ? " +
      "ORDER BY ca.confidence DESC LIMIT 1"
    ).all(kind, value, excludeContactId || '');
    return rows[0] || null;
  }

  /** 取某 contact 的归一化弱指纹 */
  function getWeakFingerprint(contactId) {
    const c = db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(contactId);
    if (!c) return null;
    // 弱锚点里可能已存 region/age（迁移期 profile_page 字段），拼进指纹
    const p = db.prepare('SELECT * FROM ContactProfile WHERE contactId = ?').get(contactId) || {};
    return normalizeWeakKey({
      displayName: c.displayName,
      nickname: c.nickname,
      region: p.region,
      age: p.age,
    });
  }

  // ------------------------------------------------------------- candidate --
  /**
   * candidateMergePairs(a, b)
   * a / b: { contactId, platform?, region? }（region 来自 ContactProfile）
   * 返回 { mergeable, reason, downgraded, matchedAnchor }
   */
  function candidateMergePairs(a, b) {
    const ca = db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(a.contactId);
    const cb = db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(b.contactId);
    if (!ca || !cb) return { mergeable: false, reason: 'contact not found', downgraded: false };

    // 1. 强锚点比对：两侧任一强锚点 (kind,value) 相同 ⇒ 候选命中
    const anchorsA = getStrongAnchors(a.contactId);
    const anchorsB = getStrongAnchors(b.contactId);
    let matched = null;
    for (const aa of anchorsA) {
      for (const bb of anchorsB) {
        if (aa.kind === bb.kind && aa.value === bb.value && aa.value) {
          matched = { kind: aa.kind, value: aa.value };
          break;
        }
      }
      if (matched) break;
    }

    if (matched) {
      // 误并护栏：两侧「平台+地区」矛盾 ⇒ 降级为弱锚点，不自动合并
      const pa = db.prepare('SELECT * FROM ContactProfile WHERE contactId = ?').get(a.contactId) || {};
      const pb = db.prepare('SELECT * FROM ContactProfile WHERE contactId = ?').get(b.contactId) || {};
      const regionA = String(pa.region || a.region || '').trim();
      const regionB = String(pb.region || b.region || '').trim();
      const platformA = String(a.platform || ca.platform || '').trim();
      const platformB = String(b.platform || cb.platform || '').trim();

      // 地区矛盾：两侧都有地区且不同（规范化后）
      const regionConflict = regionA && regionB && regionA.toLowerCase() !== regionB.toLowerCase();
      // 平台矛盾（跨平台同名客户时，平台不同不阻止合并；此处仅地区矛盾才降级）
      if (regionConflict) {
        return {
          mergeable: false,
          downgraded: true,
          reason: 'strong anchor match but region conflict: ' + regionA + ' vs ' + regionB,
          matchedAnchor: matched,
        };
      }
      return {
        mergeable: true,
        downgraded: false,
        reason: 'strong anchor match: ' + matched.kind + '=' + matched.value,
        matchedAnchor: matched,
      };
    }

    // 2. 弱锚点：归一化姓名+年龄+地区 相同 ⇒ 进 likelySame，不自动合并
    const weakA = getWeakFingerprint(a.contactId);
    const weakB = getWeakFingerprint(b.contactId);
    if (weakA && weakA === weakB) {
      return {
        mergeable: false,
        downgraded: false,
        reason: 'weak fingerprint match, queued as likelySame',
        matchedAnchor: { kind: 'weak_fingerprint', value: weakA },
      };
    }

    return { mergeable: false, downgraded: false, reason: 'no anchor match' };
  }

  // ------------------------------------------------------------- autoMerge --
  /**
   * autoMergeStrong(pair)
   * 仅当 candidateMergePairs(pair).mergeable === true 时执行 store.mergeContact
   * 返回 MergeEvent 行，否则 null
   */
  function autoMergeStrong(pair) {
    const result = candidateMergePairs(pair.a, pair.b);
    if (!result.mergeable) return null;
    const survivorId = pair.a.contactId; // 约定 pair.a 为 survivor
    const mergedId   = pair.b.contactId;
    return store.mergeContact(survivorId, mergedId, result.reason, 'strong');
  }

  // ------------------------------------------------------------- queue -----
  /**
   * queueLikelySame(pair)
   * 弱锚点匹配或强锚点降级时调用，写入 likelySame 待确认队列（审计记录）。
   * 使用 MergeEvent 表 direction='merge' + reason='queue:...' 前缀作为待确认队列载体（schema 枚举只有 merge/rollback）。
   */
  function queueLikelySame(pair) {
    const result = candidateMergePairs(pair.a, pair.b);
    const queueId = sha1('queue/' + pair.a.contactId + '/' + pair.b.contactId + '/' + Date.now());
    // direction='merge'（schema 枚举只有 merge/rollback），用 reason 前缀 'queue: ' 标记待确认队列
    db.prepare(
      "INSERT INTO MergeEvent (mergeEventId,survivorContactId,mergedContactId,reason,anchorKind,direction,rollbackOf,createdAt) " +
      "VALUES (?, ?, ?, 'queue: ' || ?, 'weak', 'merge', NULL, ?)"
    ).run(queueId, pair.a.contactId, pair.b.contactId, result.reason || 'likelySame', now());
    return db.prepare('SELECT * FROM MergeEvent WHERE mergeEventId = ?').get(queueId);
  }

  // ------------------------------------------------------------- rollback ---
  /** rollBackMerge(mergeEventId)：转发到 store.rollBackMerge，保留审计链 */
  function rollBackMerge(mergeEventId) {
    return store.rollBackMerge(mergeEventId);
  }

  // ------------------------------------------------------------- 批量扫描 --
  /**
   * scanLikelySame(limit = 50)
   * 扫描所有 likelySame 队列（reason LIKE 'queue: %'），
   * 按 weak fingerprint 分组，返回候选对列表（供控制台人工确认）。
   */
  function scanLikelySame(limit = 50) {
    const queued = db.prepare(
      "SELECT * FROM MergeEvent WHERE reason LIKE 'queue: %' " +
      "ORDER BY createdAt DESC LIMIT ?"
    ).all(limit);
    return queued.map((q) => ({
      queueId: q.mergeEventId,
      contactA: q.survivorContactId,
      contactB: q.mergedContactId,
      reason: q.reason,
      createdAt: q.createdAt,
    }));
  }

  return {
    candidateMergePairs,
    autoMergeStrong,
    queueLikelySame,
    rollBackMerge,
    scanLikelySame,
    normalizeWeakKey,
    getStrongAnchors,
    getWeakFingerprint,
  };
}

module.exports = { createDedup, STRONG_ANCHOR_KINDS };
