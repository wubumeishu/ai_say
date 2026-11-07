'use strict';
// sopExecutor（onTask SOP 执行器）：把 breathEngine 到点唤醒的任务真正驱动「开窗 + 场景动作」。
// 铁律 0.1/0.2 边界（用户裁定「先做 sop」= 引擎到点做真实动作，但动作分强弱两档）：
//   * 强副作用（发消息 / 发链接 / 删帖 / 点「はい」）→ 绝不自动执行，只生成「待确认动作」
//     （TaskQueue type='sop-confirm' + 前端置顶提醒 + 可查待确认列表），人工确认后才走 send-live 链路。
//   * 弱副作用（开窗、抓资料/历史/帖子/点赞列表、跑检索等只读动作）→ 自动执行，结果写 TaskResult。
// 场景动作映射（scene = task.type 归一）：
//   like / footprint / first_msg / recruit_post / delete_post / exception
// 执行链路：先保窗口在收件箱态（若未开则 POST /window/open，窗口手动控制模式下的第二入口），
//           再按 scene 调对应 adapter 方法（deepScrape 出会 / happyScanner 快乐），最后回收件箱（§1.9）。

const REPO_ROOT = require('path').join(__dirname, '..', '..');

function createSopExecutor(store, deps) {
  const o = deps || {};
  const db = store ? store.db : null;
  const log = (m) => { if (o.log) o.log(m); else console.log('[sopExecutor] ' + m); };
  const warn = (m) => { if (o.logWarn) o.logWarn(m); else console.warn('[sopExecutor] ' + m); };

  // 场景 → 动作定义（read=只读自动跑，write=强副作用需确认）
  const SCENES = {
    'like':           { read: 'fetchTypedLikes', write: false },
    'footprint':      { read: 'fetchAshiato',    write: false },
    'first_msg':      { read: 'fetchChatInbox',  write: true },   // 发首消息=强副作用
    'recruit_post':   { read: null,             write: true },   // 发帖/删帖=强副作用（只生成待确认）
    'delete_post':    { read: null,             write: true },
    'exception':      { read: null,             write: false }   // 熔断异常=只登记不自动
  };

  function sceneOf(task) {
    const map = { like: 'like', footprint: 'footprint', ashiato: 'footprint', first_msg: 'first_msg',
                  recruit: 'recruit_post', post: 'recruit_post', delete_post: 'delete_post', exception: 'exception', scan: 'like' };
    return map[String(task.type || 'like')] || 'like';
  }

  // 保窗口在收件箱态：开窗（若关）→ 回收件箱（§1.9 最终步骤）
  async function ensureWindow(task, actx) {
    const platform = String(task.platform || 'ichigo');
    const accountId = String(task.accountId || '');
    // 平台 → 开窗 deps（liveScanner 出会 / happyScanner 快乐 各自 openLiveCdpSafe）
    const opener = platform === 'happymail' ? o.happyOpenCdp : o.openCdp;
    if (opener && typeof opener === 'function') {
      try {
        const r = await opener(accountId);
        if (r && r.ok === false) {
          // 窗口未开且无法开 → 降级：跳过本次执行（不报错崩，留痕）
          warn('开窗失败 ' + accountId + '：' + (r.reason || 'closed'));
          return { ok: false, reason: r.reason || 'window-closed' };
        }
      } catch (e) {
        warn('开窗异常 ' + accountId + '：' + (e && e.message));
        return { ok: false, reason: 'open-exception' };
      }
    }
    // 回收件箱（出会 deepScrape.navigateInbox；快乐 happyScanner 保态）
    const back = platform === 'happymail' ? o.happyBackInbox : o.navigateInbox;
    if (back && typeof back === 'function') {
      try { await back(accountId); } catch (_) { /* 回收件箱失败不阻断 */ }
    }
    return { ok: true };
  }

  // 执行只读场景动作（adapter 是实例对象，按平台分发到对应方法）
  async function runReadOnly(scene, task, actx) {
    const platform = String(task.platform || 'ichigo');
    const accountId = String(task.accountId || '');
    const def = SCENES[scene];
    if (!def || !def.read) return { ok: false, reason: 'no-read-action', scene };
    // 平台 adapter：出会 deepScrape 实例（fetchTypedLikes/fetchAshiato/fetchChatInbox…）
    //             快乐 happyScanner 实例（scanSource 包装）
    const fn = platform === 'happymail' ? (o.happyScrape || o.happyScanner) : o.deepScrape;
    if (!fn) return { ok: false, reason: 'adapter-not-injected' };
    // 场景方法名 → adapter 方法名（出会有同名方法；快乐统一走 scanSource）
    let methodName = def.read;
    if (platform === 'happymail') {
      // 快乐：like→type / footprint→ashiato / first_msg→inbox 扫描（只读）
      const map = { like: 'type', footprint: 'ashiato', first_msg: 'inbox' };
      methodName = map[scene] || 'type';
    }
    const fnRef = typeof fn[methodName] === 'function' ? fn[methodName] : (typeof fn[def.read] === 'function' ? fn[def.read] : null);
    if (!fnRef) return { ok: false, reason: 'method-missing:' + methodName, scene };
    const r = await fnRef.call(fn, accountId);
    // 只读结果留痕（不塞全量进 TaskResult，防膨胀）
    let dataKeys = null;
    try {
      if (r && typeof r === 'object') {
        if (Array.isArray(r)) dataKeys = ['items:' + r.length];
        else dataKeys = Object.keys(r).slice(0, 8);
      }
    } catch (_) {}
    return { ok: true, scene, method: methodName, dataKeys: dataKeys };
  }

  // 生成「待确认动作」（强副作用，绝不自动执行）
  function queueConfirm(task, scene, reason) {
    if (!db) return { ok: false, reason: 'no-db' };
    let tid = null;
    try {
      const payload = {
        scene,
        sourceTaskId: task.taskId,
        accountId: task.accountId,
        platform: task.platform,
        reason,
        // 动作描述（前端展示「发给谁/做什么」，确认后走 send-live）
        description: scene === 'first_msg' ? '向客户发首消息（需你确认）'
                    : scene === 'recruit_post' ? '发布/维护招募帖（需你确认）'
                    : scene === 'delete_post' ? '删除招募帖（需你确认）'
                    : 'SOP 动作（需你确认）',
        requestedAt: new Date().toISOString()
      };
      const row = store.enqueueTask({
        platform: task.platform || 'ichigo',
        accountId: task.accountId || null,
        type: 'sop-confirm',
        payload,
        priority: 90,
        taskId: 'sopc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
      });
      tid = row ? row.taskId : null;
    } catch (e) {
      warn('生成待确认动作失败：' + (e && e.message));
    }
    return { ok: true, confirmTaskId: tid };
  }

  // 主入口：breathEngine.onTask(task, {scene, beat}) → 返回 TaskResult 用的 httpStatus（供 D2 熔断聚合）
  async function onTask(task, actx) {
    const scene = sceneOf(task);
    const def = SCENES[scene];
    const ctx = { scene };
    try {
      // 1) 保窗口态
      const wr = await ensureWindow(task, ctx);
      if (!wr.ok) {
        // 窗口不可用 → 记 503（D2 熔断口径：503 计入异常）
        return { httpStatus: 503, ok: false, reason: wr.reason, scene };
      }
      // 2) 按场景分档
      if (def.write) {
        // 强副作用：只生成待确认动作，不自动执行
        const cq = queueConfirm(task, scene, 'write-action-needs-confirm');
        return { httpStatus: 200, ok: true, needsConfirm: true, confirmTaskId: cq.confirmTaskId, scene,
                 note: '强副作用未自动执行，已生成待确认动作（铁律 0.1）' };
      }
      // 3) 只读动作：自动执行
      const rr = await runReadOnly(scene, task, ctx);
      if (rr.ok === false) {
        return { httpStatus: 500, ok: false, reason: rr.reason, scene };
      }
      return { httpStatus: 200, ok: true, scene, dataKeys: rr.data ? Object.keys(rr.data).slice(0, 8) : [] };
    } catch (e) {
      warn('onTask 异常 ' + (task.taskId || '') + '：' + (e && e.stack || e));
      return { httpStatus: 500, ok: false, reason: String(e && e.message || e), scene };
    }
  }

  // 待确认动作清单（供前端/路由查询，人工确认后走 send-live）
  function listConfirms(limit) {
    if (!db) return [];
    try {
      return db.prepare(
        "SELECT taskId, platform, accountId, payload, priority, createdAt FROM TaskQueue WHERE type='sop-confirm' AND status='pending' ORDER BY priority DESC, createdAt ASC LIMIT ?"
      ).all(Number(limit) || 50);
    } catch (e) {
      warn('listConfirms 异常：' + (e && e.message));
      return [];
    }
  }

  // 人工确认执行（路由调用；内部仍走 send-live 链路 + 复核目标，绝不自动发）
  async function confirmTask(confirmTaskId) {
    if (!db) return { ok: false, reason: 'no-db' };
    let row = null;
    try { row = db.prepare("SELECT * FROM TaskQueue WHERE taskId=?").get(confirmTaskId); } catch (_) {}
    if (!row) return { ok: false, reason: 'not-found' };
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
    // 标记 done（真实副作用由路由层的 send-live / bbsWritePost / bbsDeletePosts 执行，需用户在对话确认）
    try {
      db.prepare("UPDATE TaskQueue SET status='done', finishedAt=?, updatedAt=? WHERE taskId=?")
        .run(new Date().toISOString(), new Date().toISOString(), confirmTaskId);
    } catch (e) { warn('confirmTask 更新失败：' + (e && e.message)); }
    return {
      ok: true, confirmed: true,
      note: '已标记确认；真实副作用（发消息/发帖/删帖）由你手动触发对应路由执行，AI 不代发（铁律 0.1）',
      scene: payload.scene, accountId: row.accountId, payload
    };
  }

  return {
    onTask,
    listConfirms,
    confirmTask,
    _internal: { sceneOf, queueConfirm, SCENES }
  };
}

module.exports = { createSopExecutor };
