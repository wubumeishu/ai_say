'use strict';
// =============================================================================
// 未读/未回复轮询器（v5.3 · 批2；非秒回 = 周期轮询未读增量，发现才触发动作）
// 职责：
//   - 每 intervalMs（默认 60s）扫一次各平台收件箱未读（出会 liveScanner.scanInbox / 快乐 happyScanner.scanInbox）
//   - 维护每个 (platform, memberID/contactKey) 的"已见未读基线"，发现增量 → 推 unread-event
//   - 事件回调 onUnread(evt) 由调用方注入：可做"查资料/查历史/生成参考话术"，但【不自动发消息】（铁律 §0.1）
// 降级：scanner 未注入 / CDP 不可达 → 跳过该轮，不崩、不卡（仿 liveScanner 降级先例）。
//
// ⚠ 窗口自动拉起修复（2026-10-29）：scanInbox（happyScanner）会调
//   bitbrowser.openLiveCdp → POST /browser/open，该 API 在窗口未启动时会**自动启动窗口**。
//   本 poller 每 30s 调一次，会把用户已关闭的 BitBrowser 窗口重新拉起。
//   修复：autoOpenWindow（默认 false）= 只探测 CDP 是否可达，可达才扫；不可达跳过该轮，
//   绝不主动 /browser/open 开窗。需要自动开窗时由调用方显式传 autoOpenWindow: true。
// =============================================================================
function createUnreadPoller(deps = {}) {
  const intervalMs = Number(deps.intervalMs) || 60000;
  const autoOpenWindow = deps.autoOpenWindow === true; // 默认关：守护不碰窗口开关
  const platforms = Array.isArray(deps.platforms) ? deps.platforms : [];
  // [{ platform, scanner, label }]
  const state = {
    baselines: new Map(),    // key = platform + '|' + memberKey -> { unread, lastSeenAt }
    timer: null,
    running: false,
    events: [],              // 最近 N 条未读事件（供看板/审计）
    maxEvents: 200,
    listeners: [],           // onUnread 回调
    lastRunAt: null,
    lastOk: null,
    lastError: null,
  };

  function emit(evt) {
    evt.ts = new Date().toISOString();
    state.events.push(evt);
    if (state.events.length > state.maxEvents) state.events.shift();
    state.listeners.forEach((fn) => {
      try { fn(evt); } catch (_) { /* 监听器异常不阻断 */ }
    });
  }

  function onUnread(fn) {
    if (typeof fn === 'function') state.listeners.push(fn);
    return () => { state.listeners = state.listeners.filter((x) => x !== fn); };
  }

  // 扫单个平台未读（platform 可为现成 scanner 或 { getScanner, getInbox } 工厂）
  async function pollOne(platform) {
    // 适配：getScanner/getInbox 工厂（index.js 注入形态）→ 现成 scanInbox
    let scanner = platform.scanner || null;
    if (!scanner && typeof platform.getScanner === 'function') {
      const s = platform.getScanner();
      if (s && typeof s.scanInbox === 'function') scanner = s;
    }
    if (!scanner) { state.lastError = 'scanner-not-ready(' + platform.label + ')'; return; }
    let scan;
    try {
      // 窗口自动拉起修复（2026-10-29）：默认 autoOpenWindow=false —— 守护不碰窗口开关。
      // 规则：
      //   ① 平台没有可用扫描源（无 getInbox 且 scanner 无 scanInbox）→ 直接跳过（该 scanner 形态就不扫收件箱，非错误）
      //   ② autoOpenWindow=false 时：先 probeCdp 只读探测窗口是否已开（/browser/list?opened=true，不启动窗口）
      //      窗口没开 → 跳过该轮（cdp-skip-window-closed），绝不 /browser/open 拉起
      //   ③ autoOpenWindow=true（显式开启）→ 跳过探测，直接扫（scanInbox 内部会 openLiveCdp 自动开窗）
      const hasScanSource = (typeof platform.getInbox === 'function') || (typeof scanner.scanInbox === 'function');
      if (!hasScanSource) {
        // liveScanner（只有 scanLive/openCdpSession）等无收件箱源的 scanner：静默跳过，不记 error
        return;
      }
      if (!autoOpenWindow && typeof scanner.probeCdp === 'function') {
        const probe = await scanner.probeCdp();
        if (!probe || !probe.ok) {
          state.lastError = 'cdp-skip-window-closed(' + platform.label + ')';
          return; // 窗口没开 → 跳过，不拉起
        }
      }
      // 有扫描源 → 正常扫
      if (typeof platform.getInbox === 'function') scan = await platform.getInbox(scanner);
      else scan = await scanner.scanInbox(false, {});
    } catch (e) {
      state.lastError = String((e && e.message) || e);
      return;
    }
    if (!scan || !scan.ok) { state.lastError = 'scan-failed(' + (scan && scan.reason) + ')'; return; }
    state.lastOk = platform.label;
    // 逐客户比未读增量
    const contacts = Array.isArray(scan.contacts) ? scan.contacts : [];
    let newCount = 0;
    for (const c of contacts) {
      const key = String(c.memberID || c.contactKey || c.name || '');
      if (!key) continue;
      // 出会/快乐 的 unread 可能在 contact.unread 或 contact.unreadCnt；兼容多字段
      const rawUnread = (c.unread != null ? c.unread : (c.unreadCnt != null ? c.unreadCnt : null));
      const unread = rawUnread == null ? null : (parseInt(rawUnread, 10) || 0);
      if (unread == null) continue;
      const bkey = platform.label + '|' + key;
      const prev = state.baselines.get(bkey);
      // 首次 = 建基线（不触发）；增量 = unread > prev.unread（可能有新消息）
      if (!prev) {
        state.baselines.set(bkey, { unread, lastSeenAt: new Date().toISOString() });
      } else if (unread > prev.unread) {
        newCount += 1;
        state.baselines.set(bkey, { unread, lastSeenAt: new Date().toISOString(), delta: unread - prev.unread });
        // 触发"该做的事"：查资料/查历史/生成参考话术（由注入的 onUnread 决定；不自动发消息）
        emit({ type: 'unread-increment', platform: platform.label, memberKey: key, memberName: c.name || '', unread, delta: unread - prev.unread });
      } else if (unread < prev.unread) {
        // 未读下降（对方读了/我发了/清空）→ 更新基线，不触发
        state.baselines.set(bkey, { unread, lastSeenAt: new Date().toISOString() });
      }
    }
  }

  async function tick() {
    if (state.running) return;
    state.running = true;
    state.lastRunAt = new Date().toISOString();
    try {
      for (const p of platforms) await pollOne(p);
    } finally { state.running = false; }
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (state.timer.unref) state.timer.unref();
    // 启动立即扫一轮（建基线）
    tick().catch(() => {});
  }
  function stop() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  return {
    start, stop, tick, onUnread,
    // autoOpenWindow：是否允许 poller 主动开窗（默认 false = 守护不碰窗口）
    getAutoOpenWindow: () => autoOpenWindow,
    // 状态读取（供 /api/console/poller 端点 + 看板）
    snapshot: () => ({
      running: !!state.timer,
      intervalMs,
      lastRunAt: state.lastRunAt,
      lastOk: state.lastOk,
      lastError: state.lastError,
      baselineCount: state.baselines.size,
      autoOpenWindow,
      recentEvents: state.events.slice(-20),
    }),
    _state: state,
  };
}

module.exports = { createUnreadPoller };
