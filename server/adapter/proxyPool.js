'use strict';
// =============================================================================
// Ai SAY · IPDeep 代理池 v1（proxyPool.js）
// 设计依据 docs/IPDeep实验协议.md 定稿：
//   粘性 90 分钟 / 池=随机数变体 / 事件驱动换 IP / 冷却 30 分钟 / 密码不入 Git
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOLDOWN_MS = 30 * 60 * 1000;
const STICKY_MIN = 90;
const RANDOM_MIN = 10000;
const RANDOM_MAX = 9999999999;

function randInt(lo, hi) {
  const range = hi - lo;
  const buf = Buffer.alloc(4);
  crypto.randomFillSync(buf);
  return lo + (buf.readUInt32BE(0) % range);
}

function createProxyPool(opts = {}) {
  const rootDir = opts.rootDir || path.join(__dirname, '..', '..');
  const poolPath = opts.poolPath || path.join(rootDir, 'data', 'proxy-pool.json');
  const secretsPath = opts.secretsPath || path.join(rootDir, 'data', 'proxy-secrets.json');
  const bit = opts.bitbrowser || null;
  let failStreak = {};

  function loadPool() {
    try { if (fs.existsSync(poolPath)) return JSON.parse(fs.readFileSync(poolPath, 'utf8')); } catch (e) {}
    return null;
  }
  function savePool(cfg) {
    fs.mkdirSync(path.dirname(poolPath), { recursive: true });
    const tmp = poolPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, poolPath);
  }
  function loadSecrets() {
    try { if (fs.existsSync(secretsPath)) return JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch (e) {}
    return {};
  }
  function saveSecrets(s) {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify(s, null, 2), 'utf8');
  }
  function getBit() {
    if (bit) return bit;
    const settingsPath = path.join(rootDir, 'settings.json');
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    const { BitBrowserClient } = require('../bitbrowser');
    return new BitBrowserClient(settings.apiBase || 'http://127.0.0.1:54346');
  }
  function getWindowId() {
    const settingsPath = path.join(rootDir, 'settings.json');
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    return String(settings.windowId || ((settings.platformGroups && settings.platformGroups[0] && settings.platformGroups[0].windows && settings.platformGroups[0].windows[0]) || ''));
  }

  // 首次使用：从当前窗口代理提取，建 8 槽位池（第一槽用当前随机数=不换 IP）
  async function ensurePool() {
    let cfg = loadPool();
    if (cfg && Array.isArray(cfg.slots) && cfg.slots.length) return cfg;
    const windowId = getWindowId();
    const client = getBit();
    let win = null;
    for (let page = 1; page <= 10 && !win; page++) {
      const list = await client.listBrowsers({ page: page, pageSize: 50 });
      const all = (list && list.list) || [];
      win = all.find(function(w) { return w.id === windowId; }) || null;
      if (all.length < 50) break; // 已是最后一页
    }
    if (!win) throw new Error('proxyPool: 窗口 ' + windowId + ' 未在 BitBrowser 列表（先开窗或改 settings）');
    const secrets = loadSecrets();
    if (!secrets.ipdeep) { secrets.ipdeep = String(win.proxyPassword || ''); saveSecrets(secrets); }
    const cfgBase = {
      provider: 'ipdeep',
      host: win.host || 'gate.ipdeep.com',
      port: win.port || 8082,
      accountPrefix: String(win.proxyUserName || 'd2849313000-res-country-JP').split('-session-')[0],
      proxyType: win.proxyType || 'socks5',
      stickyMin: STICKY_MIN,
      passwordKey: 'ipdeep',
      windows: [windowId],
      slots: [],
      lastRotateAt: {}
    };
    const m = String(win.proxyUserName || '').match(/session-(\d+)-/);
    const randoms = [m ? m[1] : String(randInt(RANDOM_MIN, RANDOM_MAX))];
    while (randoms.length < 8) randoms.push(String(randInt(RANDOM_MIN, RANDOM_MAX)));
    cfgBase.slots = randoms.map(function(r, i) {
      return { id: 'slot-' + i, random: r, stickyMin: STICKY_MIN, status: i === 0 ? 'in_use' : 'available', lastUsedAt: null, exitIp: null };
    });
    cfg = cfgBase;
    savePool(cfg);
    return cfg;
  }

  function buildAccount(cfg, slot) {
    return cfg.accountPrefix + '-session-' + slot.random + '-sessiontime-' + (slot.stickyMin || cfg.stickyMin || STICKY_MIN);
  }

  function pickSlot(cfg) {
    let cand = cfg.slots.find(function(s) { return s.status === 'available'; });
    if (!cand) cand = cfg.slots.reduce(function(a, b) { return ((a.lastUsedAt || 0) < (b.lastUsedAt || 0)) ? a : b; });
    return cand || null;
  }

  // 换 IP（冷却 + 事件驱动）。dryRun 只返回将执行的字段；force 跳过冷却。
  async function rotate(windowId, opts) {
    opts = opts || {};
    const cfg = await ensurePool();
    const secrets = loadSecrets();
    const password = secrets[cfg.passwordKey || 'ipdeep'] || '';
    if (!password && !opts.dryRun) return { ok: false, reason: 'no-password', msg: 'data/proxy-secrets.json 缺密码（手动填写，勿提交 Git）' };
    const lastAt = new Date(((cfg.lastRotateAt || {})[String(windowId)]) || 0).getTime();
    if (lastAt && Date.now() - lastAt < COOLDOWN_MS && !opts.force) {
      const leftMin = Math.ceil((COOLDOWN_MS - (Date.now() - lastAt)) / 60000);
      return { ok: false, reason: 'cooling-down', msg: '该窗口 ' + leftMin + ' 分钟内不能再换 IP（30min 冷却）', cooldownLeftMin: leftMin };
    }
    const slot = pickSlot(cfg);
    if (!slot) return { ok: false, reason: 'no-slot', msg: '代理池无可用槽位（先扩池）' };
    const account = buildAccount(cfg, slot);
    if (opts.dryRun) return { ok: true, dryRun: true, windowId: String(windowId), slotId: slot.id, random: slot.random, account: account, stickyMin: slot.stickyMin || cfg.stickyMin };
    const client = getBit();
    await client.updateProxy({
      ids: [String(windowId)], ipCheckService: 'ip123in', proxyMethod: 2, proxyType: cfg.proxyType || 'socks5',
      host: cfg.host, port: cfg.port, proxyUserName: account, proxyPassword: password
    });
    try { await client.closeBrowser(String(windowId)); } catch (e) {}
    await client.openBrowser({ id: String(windowId), queue: true });
    cfg.slots.forEach(function(s) { if (s.id !== slot.id) s.status = 'available'; });
    slot.status = 'in_use'; slot.lastUsedAt = new Date().toISOString(); slot.exitIp = null;
    cfg.lastRotateAt = cfg.lastRotateAt || {};
    cfg.lastRotateAt[String(windowId)] = new Date().toISOString();
    savePool(cfg);
    return { ok: true, windowId: String(windowId), slotId: slot.id, random: slot.random, account: account, stickyMin: slot.stickyMin || cfg.stickyMin, refetchNeeded: true, note: '已换代理并重开窗口；新出口 IP 用 /api/console/network/health 确认' };
  }

  // 体检驱动：连续 2 次「出口正常但平台不可达」才自动换
  async function healthDrivenRotate(windowId, healthResult) {
    const h = (healthResult && healthResult.health) || {};
    const key = String(windowId);
    const should = !!(h.platform && !h.platform.ok && h.exitIp);
    if (should) failStreak[key] = (failStreak[key] || 0) + 1; else { failStreak[key] = 0; return { ok: true, rotated: false, reason: 'healthy-or-no-signal' }; }
    if (failStreak[key] < 2) return { ok: true, rotated: false, reason: 'streak-not-reached', streak: failStreak[key], hint: '需连续 2 次才自动换（现第 ' + failStreak[key] + ' 次）' };
    const r = await rotate(windowId, {});
    if (r && r.ok) failStreak[key] = 0;
    return Object.assign({ ok: true, rotated: !!(r && r.ok) }, r || {});
  }

  function list() {
    const cfg = loadPool();
    if (!cfg) return { empty: true };
    const secrets = loadSecrets();
    return {
      provider: cfg.provider, host: cfg.host, port: cfg.port, stickyMin: cfg.stickyMin,
      slotCount: (cfg.slots || []).length,
      slots: (cfg.slots || []).map(function(s) { return { id: s.id, random: s.random, stickyMin: s.stickyMin, status: s.status, lastUsedAt: s.lastUsedAt, exitIp: s.exitIp }; }),
      lastRotateAt: cfg.lastRotateAt || {},
      hasPassword: !!(secrets[cfg.passwordKey || 'ipdeep']),
    };
  }
  async function expand(n) {
    const cfg = await ensurePool();
    n = Math.min(Number(n) || 4, 50);
    const base = cfg.slots.length;
    for (let i = 0; i < n; i++) cfg.slots.push({ id: 'slot-' + (base + i), random: String(randInt(RANDOM_MIN, RANDOM_MAX)), stickyMin: STICKY_MIN, status: 'available', lastUsedAt: null, exitIp: null });
    savePool(cfg);
    return list();
  }
  async function setSticky(minutes) {
    const cfg = await ensurePool();
    const m = Math.max(1, Number(minutes) || STICKY_MIN);
    cfg.stickyMin = m;
    cfg.slots.forEach(function(s) { s.stickyMin = m; });
    savePool(cfg);
    return { ok: true, stickyMin: m };
  }
  function recordExitIp(slotId, ip) {
    const cfg = loadPool(); if (!cfg) return;
    const s = (cfg.slots || []).find(function(x) { return x.id === slotId; });
    if (s) { s.exitIp = ip; savePool(cfg); }
  }

  return { ensurePool: ensurePool, rotate: rotate, healthDrivenRotate: healthDrivenRotate, list: list, expand: expand, setSticky: setSticky, recordExitIp: recordExitIp, buildAccount: buildAccount, _COOLDOWN_MS: COOLDOWN_MS, _STICKY_MIN: STICKY_MIN };
}

module.exports = { createProxyPool: createProxyPool, randInt: randInt };
