'use strict';
// 呼吸引擎（breathEngine）：二期任务编排核心（AGENTS.md §二一期定案 + §六待办 T3）。
// 宏观调度：把 TaskQueue 里「有主 + 已绑账号」的呼吸任务按拟人节拍唤醒，
// 双段节拍 pre_fixed→pre_random→执行→post_fixed→post_random（Irwin-Hall 三角分布近似），
// 调度公平：GROUP BY accountId + MIN(nextWakeAt) 折叠每账号最早到期 + 内存 Round-Robin（每 500ms tick），
// 单账号串行互斥锁 inFlightAccounts（D3），401/403/429/503 连续异常计数（D2 复用 TaskResult 聚合）。
//
// 设计契约（§二 4 条锁死）：
//  - D1：仅调度 accountId IS NOT NULL 的已绑定任务；无主任务 → 跳过（分配器归上游，不进引擎）
//  - D2：连续异常计数 = 按 accountId 倒序聚合最近 3 条 TaskResult（executedAt >= AccountProfile.updatedAt），不落内存 Map
//  - D3：inFlightAccounts 进程级互斥，重启归零；单步套 120s 超时守卫
//  - D4：AccountProfile.pool 每日 00:05 JST 自动晋升（用户 2026-11-04 裁定：去掉注册满 7d 门槛，改为近 72h 无硬熔断 + manualPoolLock=0）
//
// 落地边界（本阶段 = 引擎 + 路由 + 前端看板，任务真实副作用由用户确认的 SOP 执行器驱动，
// 引擎本身只负责「何时唤醒 + 节拍 + 抢单 + 异常熔断」，不直接发消息 / 发链接（铁律 0.1）。

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 1. 节拍采样：Irwin-Hall 三角分布近似（两次独立 crypto.randomInt 取均值，O(1) 向中位聚拢）
// ---------------------------------------------------------------------------
function irwinHall(min, max, stepMs = 50) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (hi - lo <= 0) return lo;
  const a = lo;
  const b = hi - lo;
  // 两次独立均匀采样均值 → 三角分布（向中位聚拢）
  const r1 = crypto.randomInt(0, b + 1);
  const r2 = crypto.randomInt(0, b + 1);
  const mid = (r1 + r2) / 2;
  return Math.round(a + Math.round(mid / stepMs) * stepMs);
}

// ---------------------------------------------------------------------------
// 2. 节拍解析：GovernanceRule 双段节拍（缺列/缺行 → 默认保守值）
// ---------------------------------------------------------------------------
const DEFAULT_BEAT = {
  preFixedWaitMs: 3000,
  preRandomMinMs: 2000,
  preRandomMaxMs: 8000,
  postFixedWaitMs: 5000,
  postRandomMinMs: 3000,
  postRandomMaxMs: 10000
};

function resolveBeat(db, scene, accountGroup) {
  let row = null;
  try {
    row = db.prepare(
      "SELECT * FROM GovernanceRule WHERE scene = ? AND accountGroup = ? AND status = 'active' LIMIT 1"
    ).get(scene, accountGroup || 'warmup');
  } catch (_) { row = null; }
  if (!row) {
    try {
      // 兜底：同账号组的任意呼吸规则（scene 不限），取 priority 最高
      row = db.prepare(
        "SELECT * FROM GovernanceRule WHERE accountGroup = ? AND scene NOT IN ('legacy','default') AND status = 'active' ORDER BY priority DESC LIMIT 1"
      ).get(accountGroup || 'warmup');
    } catch (_) { row = null; }
  }
  const m = (k, d) => {
    const v = row ? Number(row[k]) : Number.NaN;
    return Number.isFinite(v) ? v : d;
  };
  return {
    scene: row ? row.scene : 'default',
    beat: {
      preFixedWaitMs: m('preFixedWaitMs', DEFAULT_BEAT.preFixedWaitMs),
      preRandomMinMs: m('preRandomMinMs', DEFAULT_BEAT.preRandomMinMs),
      preRandomMaxMs: m('preRandomMaxMs', DEFAULT_BEAT.preRandomMaxMs),
      postFixedWaitMs: m('postFixedWaitMs', DEFAULT_BEAT.postFixedWaitMs),
      postRandomMinMs: m('postRandomMinMs', DEFAULT_BEAT.postRandomMinMs),
      postRandomMaxMs: m('postRandomMaxMs', DEFAULT_BEAT.postRandomMaxMs)
    }
  };
}

// ---------------------------------------------------------------------------
// 3. D2 连续异常计数：按 accountId 倒序聚合最近 3 条 TaskResult（限定 executedAt >= AccountProfile.updatedAt）
//    401/403/429/503 连续 N 次（默认 3）= 硬熔断，推 high_intent 人工兜底队列
// ---------------------------------------------------------------------------
const HTTP_RETRYABLE = [401, 403, 429, 503];
function countConsecutiveHttpFaults(db, accountId, sinceMs) {
  if (!accountId) return 0;
  let out = [];
  try {
    out = db.prepare(
      'SELECT httpStatus FROM TaskResult WHERE accountId = ? AND executedAt >= ? ORDER BY executedAt DESC LIMIT 3'
    ).all(accountId, sinceMs || 0);
  } catch (_) { out = []; }
  let n = 0;
  for (const r of out) {
    if (HTTP_RETRYABLE.indexOf(Number(r.httpStatus)) !== -1) n++;
    else break; // 连续中断
  }
  return n;
}

// ---------------------------------------------------------------------------
// 4. 引擎主体（注入 store 句柄，纯函数 + 可单测）
// ---------------------------------------------------------------------------
function createBreathEngine(store, opts) {
  const o = opts || {};
  const db = store.db;
  const tickMs = Number(o.tickMs) || 500;                 // 每 500ms tick
  const maxDispatchPerTick = Number(o.MAX_DISPATCH_PER_TICK) || 4; // 单 tick 最多派 4 单（环形游标）
  const stepTimeoutMs = Number(o.stepTimeoutMs) || 120000; // 单步 120s 超时守卫（D3）
  const httpFaultThreshold = Number(o.httpFaultThreshold) || 3; // D2 连续 3 次 = 硬熔断
  // D3：进程级互斥锁（重启即归零）
  const inFlightAccounts = new Set();
  // Round-Robin 环形游标（每账号公平，不饿死）
  let rrCursor = 0;
  let timer = null;
  let running = false;
  let lastTickStats = null;

  // 取某账号最早到期的呼吸任务（折叠每账号最早 nextWakeAt）
  function pickDueTask(accountId) {
    let row = null;
    try {
      row = db.prepare(
        "SELECT * FROM TaskQueue WHERE accountId = ? AND status = 'pending' AND nextWakeAt > 0 AND nextWakeAt <= ? ORDER BY nextWakeAt ASC LIMIT 1"
      ).get(accountId, Date.now());
    } catch (_) { row = null; }
    return row;
  }

  // D1：仅已绑定账号的任务可被引擎调度（accountId IS NOT NULL）
  function isEngineOwned(task) {
    return !!(task && task.accountId);
  }

  // 解析任务节拍（scene = task.type 映射呼吸场景，accountGroup = 该账号 pool）
  function taskSceneOf(task) {
    const map = {
      'like': 'like', 'footprint': 'footprint', 'ashiato': 'footprint',
      'first_msg': 'first_msg', 'recruit': 'recruit_post', 'post': 'recruit_post',
      'delete_post': 'delete_post', 'exception': 'exception', 'scan': 'like'
    };
    return map[String(task.type || 'like')] || 'like';
  }

  // 抢单（CAS：claimed_at + claim_token 租约 120s，幂等键）
  function claimFor(task) {
    const token = crypto.randomBytes(8).toString('hex');
    const idempKey = [task.accountId, task.type, Date.now() >> 11, task.taskId].join(':');
    let changes = 0;
    try {
      const r = db.prepare(
        "UPDATE TaskQueue SET status = 'assigned', claimedAt = ?, claimToken = ?, idempotencyKey = ?, assignedAt = ?, updatedAt = ? WHERE taskId = ? AND status = 'pending'"
      ).run(Date.now(), token, idempKey, new Date().toISOString(), new Date().toISOString(), task.taskId);
      changes = r && r.changes;
    } catch (_) { changes = 0; }
    return changes === 1; // CAS 成功才认
  }

  // 执行节拍（双段：pre → 业务副作用（本阶段 = 占位回执，不真发）→ post）
  async function executeTaskWithBeat(task) {
    const scene = taskSceneOf(task);
    const grp = o.accountGroupResolver ? o.accountGroupResolver(task.accountId) : 'warmup';
    const { beat } = resolveBeat(db, scene, grp);
    // 前置：pre_fixed → pre_random
    await sleep(beat.preFixedWaitMs || 0);
    await sleep(irwinHall(beat.preRandomMinMs, beat.preRandomMaxMs));
    // 业务副作用占位（铁律 0.1：引擎不直接发；真实执行由 SOP 执行器接管，写 TaskResult）
    if (o.onTask && typeof o.onTask === 'function') {
      await Promise.race([
        o.onTask(task, { scene, beat }),
        new Promise((res) => setTimeout(() => res({ timeout: true }), stepTimeoutMs)) // D3 120s 守卫
      ]);
    }
    // 后置：post_fixed → post_random
    await sleep(beat.postFixedWaitMs || 0);
    await sleep(irwinHall(beat.postRandomMinMs, beat.postRandomMaxMs));
  }

  function sleep(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    return new Promise((r) => setTimeout(r, ms));
  }

  // 记 TaskResult（幂等回执，供 D2 聚合 + 任务看板）
  function recordResult(task, ok, error, httpStatus) {
    let changes = 0;
    try {
      const key = task.idempotencyKey || [task.accountId, task.type, task.taskId].join(':');
      changes = db.prepare(
        'INSERT OR IGNORE INTO TaskResult (idempotencyKey, taskId, accountId, executedByNode, httpStatus, executedAt) VALUES (?,?,?,?,?,?)'
      ).run(key, task.taskId, task.accountId, o.nodeId || 'local-node', Number(httpStatus) || (ok ? 200 : 500), Date.now());
    } catch (_) { changes = 0; }
    if (error) {
      try {
        db.prepare("UPDATE TaskQueue SET status = 'failed', finishedAt = ?, error = ?, updatedAt = ? WHERE taskId = ?")
          .run(new Date().toISOString(), String(error), new Date().toISOString(), task.taskId);
      } catch (_) {}
    } else {
      try {
        db.prepare("UPDATE TaskQueue SET status = 'done', finishedAt = ?, updatedAt = ? WHERE taskId = ?")
          .run(new Date().toISOString(), new Date().toISOString(), task.taskId);
      } catch (_) {}
    }
    return changes;
  }

  // 单 tick：Round-Robin 折叠每账号最早到期，每账号最多派 1 单（D3 串行互斥）
  async function tickOnce() {
    let dispatched = 0;
    let skipped = 0;
    let circuitBroken = 0;
    // 折叠每账号最早 nextWakeAt（GROUP BY accountId + MIN）
    let dueAccounts = [];
    try {
      const rows = db.prepare(
        "SELECT accountId, MIN(nextWakeAt) AS mn FROM TaskQueue WHERE status = 'pending' AND nextWakeAt > 0 GROUP BY accountId HAVING mn <= ? ORDER BY mn ASC"
      ).all(Date.now());
      dueAccounts = rows.map((r) => r.accountId).filter((a) => a && a !== 'null');
    } catch (_) { dueAccounts = []; }

    // Round-Robin 游标起点（公平不饿死）
    if (dueAccounts.length > 0) {
      rrCursor = rrCursor % dueAccounts.length;
    }

    for (let i = 0; i < dueAccounts.length && dispatched < maxDispatchPerTick; i++) {
      const accountId = dueAccounts[(rrCursor + i) % dueAccounts.length];
      // D3：单账号串行互斥（in-flight 跳过）
      if (inFlightAccounts.has(accountId)) { skipped++; continue; }
      // D1：仅已绑定账号
      if (!accountId) { skipped++; continue; }
      const task = pickDueTask(accountId);
      if (!task) { skipped++; continue; }
      if (!isEngineOwned(task)) { skipped++; continue; }

      // D2：连续异常计数 → 硬熔断
      let acctUpdated = 0;
      try { acctUpdated = Number(db.prepare('SELECT updatedAt FROM AccountProfile WHERE accountId = ?').get(accountId).updatedAt) || 0; } catch (_) {}
      const faults = countConsecutiveHttpFaults(db, accountId, acctUpdated);
      if (faults >= httpFaultThreshold) {
        // 硬熔断：推 high_intent 人工兜底（TaskQueue high_intent + 前端置顶提醒），不再调度
        try {
          db.prepare(
            "INSERT OR REPLACE INTO TaskQueue (taskId, platform, accountId, type, payload, status, priority, createdAt, updatedAt)"
          ).run(
            'hi_' + crypto.createHash('sha1').update(accountId + ':' + Date.now()).digest('hex').slice(0, 12),
            task.platform || 'ichigo', accountId, 'exception',
            JSON.stringify({ reason: 'http-fault-circuit', faults, lastTaskId: task.taskId }),
            'pending', 100, new Date().toISOString(), new Date().toISOString()
          );
        } catch (_) {}
        circuitBroken++;
        continue;
      }

      // 抢单（CAS）
      inFlightAccounts.add(accountId);
      try {
        const claimed = claimFor(task);
        if (!claimed) { skipped++; continue; }
        dispatched++;
        let ok = true;
        let err = null;
        try {
          await executeTaskWithBeat(task);
        } catch (e) { ok = false; err = e && e.message || String(e); }
        recordResult(task, ok, err);
        rrCursor = (rrCursor + 1) % Math.max(1, dueAccounts.length);
      } finally {
        inFlightAccounts.delete(accountId);
      }
    }
    lastTickStats = { at: new Date().toISOString(), dispatched, skipped, circuitBroken, dueAccounts: dueAccounts.length, inFlight: inFlightAccounts.size };
    return lastTickStats;
  }

  // 启动 / 停止（引擎只调度，不碰 CDP / 窗口 / 发送）
  function start() {
    if (running) return { ok: true, already: true };
    running = true;
    timer = setInterval(() => {
      tickOnce().catch((e) => {
        // 禁止空 catch：记录 tick 异常，不崩进程
        if (o.onTickError) o.onTickError(e);
        else console.error('[breathEngine] tick error:', e && e.message);
      });
    }, tickMs);
    // 首 tick 立即跑一次（不等 500ms）
    tickOnce().catch((e) => { if (o.onTickError) o.onTickError(e); else console.error('[breathEngine] first tick error:', e && e.message); });
    return { ok: true };
  }
  function stop() {
    if (!running) return { ok: false, already: true };
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    return { ok: true };
  }
  function status() {
    let pendingCount = 0, doneCount = 0, failedCount = 0;
    try {
      pendingCount = db.prepare("SELECT COUNT(*) n FROM TaskQueue WHERE status='pending'").get().n;
      doneCount = db.prepare("SELECT COUNT(*) n FROM TaskQueue WHERE status='done'").get().n;
      failedCount = db.prepare("SELECT COUNT(*) n FROM TaskQueue WHERE status='failed'").get().n;
    } catch (_) {}
    let highIntent = 0;
    try { highIntent = db.prepare("SELECT COUNT(*) n FROM TaskQueue WHERE type='exception' AND status='pending'").get().n; } catch (_) {}
    return {
      running: running, tickMs, maxDispatchPerTick,
      inFlight: Array.from(inFlightAccounts).slice(),
      queue: { pending: pendingCount, done: doneCount, failed: failedCount, highIntentPending: highIntent },
      lastTick: lastTickStats
    };
  }

  // D4：每日 00:05 JST 晋升守护（warmup→veteran，注册满 7d + 近 72h 无硬熔断 + manualPoolLock=0）
  // D4 晋升判据（用户 2026-11-04 裁定：去掉「注册满 7 天」门槛）：
  // 仅当 近 72h 无硬熔断 + manualPoolLock=0 时 warmup→veteran。
  // registeredAt 只记入表备查，不参与晋升判定。
  function promoteDueAccounts() {
    let promoted = 0;
    const skippedFault = 0;
    try {
      const rows = db.prepare(
        "SELECT accountId, manualPoolLock FROM AccountProfile WHERE pool = 'warmup' AND manualPoolLock = 0"
      ).all();
      const now = Date.now();
      const D3 = 3 * 86400000;
      for (const r of rows) {
        const faults = countConsecutiveHttpFaults(db, r.accountId, now - D3);
        if (faults > 0) continue; // 近 72h 有硬熔断 → 暂不晋升
        db.prepare("UPDATE AccountProfile SET pool = 'veteran', updatedAt = ? WHERE accountId = ?").run(now, r.accountId);
        promoted++;
      }
    } catch (e) {
      if (o.onPromoteError) o.onPromoteError(e); else console.error('[breathEngine] promote error:', e && e.message);
    }
    return { ok: true, promoted };
  }

  return {
    start, stop, status, tickOnce, promoteDueAccounts,
    _internal: { irwinHall, resolveBeat, inFlightAccounts, isEngineOwned, claimFor, countConsecutiveHttpFaults }
  };
}

module.exports = { createBreathEngine, irwinHall, DEFAULT_BEAT, HTTP_RETRYABLE };
