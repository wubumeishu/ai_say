
'use strict';
// 出会全域探测 · 通用 CDP 执行器（_probe_channel.js 的 Node 侧封装）
// 用法: node _probe_run.js <ops.json> [screenshots.json]
// ops.json: [{ expression, awaitPromise?, timeoutMs?, reconnectWaitMs?, save?, saveDecode? }]
// 每条 op 结果: { ok, value?|error?|exception?, savedTo? }。导航导致 target 失效时自动重连新 page target。
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = 'I:/deepseek/Ai SAY';
const { BitBrowserClient } = require(path.join(ROOT, 'server/bitbrowser.js'));
const WebSocket = require(path.join(ROOT, 'node_modules/ws'));
const WINDOW = '2315e879dd6642559bdc11a07bb1fc43';
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } }); }).on('error', reject);
  });
}
async function main() {
  const opsFile = process.argv[2];
  const shotFile = process.argv[3];
  const outdir = process.argv[4] || path.join(ROOT, 'docs', 'tools', 'bbs-probe');
  const ops = JSON.parse(fs.readFileSync(String(opsFile), 'utf8'));
  let shots = [];
  if (shotFile && shotFile !== 'null') { try { shots = JSON.parse(fs.readFileSync(shotFile, 'utf8')); } catch (_) { shots = []; } }
  const bit = new BitBrowserClient('http://127.0.0.1:54346');
  const live = await bit.openLiveCdp(WINDOW, { queue: true });
  const hostport = String(live.http || live.ws).replace(/^wss?:\/\//, '').split('/')[0];
  let ws;
  const targets0 = await getJson('http://' + hostport + '/json/list');
  let sp = targets0.find(t => t.type === 'page' && String(t.url || '').indexOf('194964.com') !== -1) || targets0.find(t => t.type === 'page');
  if (!sp) { console.log(JSON.stringify({ ok: false, error: 'no-page-target' })); live.client.close(); process.exit(1); }
  async function reconnect() {
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const ts = await getJson('http://' + hostport + '/json/list');
      const sp2 = ts.find(t => t.type === 'page' && String(t.url || '').indexOf('194964.com') !== -1) || ts.find(t => t.type === 'page');
      if (sp2) {
        sp = sp2;
        try { ws.close(); } catch (_) {}
        ws = new WebSocket(sp2.webSocketDebuggerUrl, { perMessageDeflate: false });
        await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
        ws.on('message', onMsg);
        await new Promise(r => setTimeout(r, 2500));
        return true;
      }
    }
    return false;
  }
  ws = new WebSocket(sp.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  let seq = 0; const pending = new Map();
  function onMsg(data) {
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || 'CDP error')); else p.resolve(m.result);
    }
  }
  ws.on('message', onMsg);
  function cdp(method, params, timeoutMs) {
    seq += 1; const id = seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp-timeout ' + method)); }, timeoutMs || 25000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  const results = [];
  for (const op of ops) {
    let done = false;
    try {
      const res = await cdp('Runtime.evaluate', { expression: op.expression, returnByValue: true, awaitPromise: !!op.awaitPromise }, op.timeoutMs || 60000);
      if (res.exceptionDetails) results.push({ ok: false, exception: (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text });
      else results.push({ ok: true, value: res.result ? res.result.value : undefined });
      done = true;
    } catch (e) {
      // nav error → reconnect and mark; op's own async work already completed inside the page
      if (/navigated|closed|not found|Target|stale/i.test(e.message)) {
        const ok = await reconnect();
        results.push({ ok: ok, navigated: true, error: ok ? undefined : e.message });
        done = ok;
      } else {
        results.push({ ok: false, error: e.message });
        done = true;
      }
    }
    if (done) {
      const last = results[results.length - 1];
      if (op.save && last.ok && typeof last.value === 'string') {
        try {
          let content = last.value;
          if (op.saveDecode !== false) { try { content = JSON.parse(content); } catch (_) {} }
          const p = path.join(outdir, op.save);
          fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 1));
          last.savedTo = op.save;
        } catch (e) { last.saveError = e.message; }
      }
    }
  }
  for (const s of shots) {
    try {
      const res = await cdp('Page.captureScreenshot', { format: 'png' }, 30000);
      const p = path.join(outdir, s);
      fs.writeFileSync(p, Buffer.from(res.data, 'base64'));
      results.push({ ok: true, screenshot: s });
    } catch (e) {
      // screenshot may fail if target changed; try reconnect
      const ok = await reconnect();
      if (ok) {
        try {
          const res = await cdp('Page.captureScreenshot', { format: 'png' }, 30000);
          const p = path.join(outdir, s);
          fs.writeFileSync(p, Buffer.from(res.data, 'base64'));
          results.push({ ok: true, screenshot: s, reconnected: true });
        } catch (e2) { results.push({ ok: false, screenshotError: s + ': ' + e2.message }); }
      } else results.push({ ok: false, screenshotError: s + ': ' + e.message });
    }
  }
  console.log(JSON.stringify({ ok: true, window: WINDOW, initialPage: sp.url, results }));
  try { ws.close(); } catch (_) {}
  live.client.close();
  process.exit(0);
}
main().catch(e => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
