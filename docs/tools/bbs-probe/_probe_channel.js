
const path = require('path');
const ROOT = 'I:/deepseek/Ai SAY';
const { BitBrowserClient } = require(path.join(ROOT, 'server/bitbrowser.js'));
const WINDOW = '2315e879dd6642559bdc11a07bb1fc43';
const OPS = process.env.OPS_SCRIPT; // JSON: [{method, expression, awaitPromise, timeoutMs}]
(async () => {
  const bit = new BitBrowserClient('http://127.0.0.1:54346');
  const live = await bit.openLiveCdp(WINDOW, { queue: true });
  const { DevToolsClient } = require(path.join(ROOT, 'server/devtools.js'));
  const httpEndpoint = live.http || live.ws;
  // resolve sp.194964.com page target
  const http = require('http');
  function getJson(url) {
    return new Promise((resolve, reject) => {
      http.get(url, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } }); }).on('error', reject);
    });
  }
  const cdpHostPort = httpEndpoint.replace(/^wss?:\/\/([^:/]+)/, '$1').replace(/\/.*/, '').replace(/^\//, '');
  const host = cdpHostPort.split(':')[0], port = cdpHostPort.split(':')[1];
  const targets = await getJson('http://' + host + ':' + port + '/json/list');
  const sp = targets.find(t => t.type === 'page' && String(t.url || '').indexOf('194964.com') !== -1);
  if (!sp) { console.log(JSON.stringify({ ok: false, reason: 'no-sp-target', targets: targets.map(t => ({ type: t.type, url: t.url })) })); live.client.close(); process.exit(0); }
  // connect page-level ws directly
  const WebSocket = require(path.join(ROOT, 'node_modules/ws'));
  const ws = new WebSocket(sp.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  let seq = 0;
  const pending = new Map();
  ws.on('message', data => {
    const m = JSON.parse(String(data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || 'CDP error')); else p.resolve(m.result);
    }
  });
  function cdp(method, params, timeoutMs) {
    seq += 1; const id = seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp-timeout ' + method)); }, timeoutMs || 25000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  const ops = JSON.parse(OPS || '[]');
  const results = [];
  for (const op of ops) {
    try {
      const res = await cdp('Runtime.evaluate', { expression: op.expression, returnByValue: true, awaitPromise: !!op.awaitPromise }, op.timeoutMs);
      if (res.exceptionDetails) { results.push({ ok: false, exception: (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text }); }
      else { results.push({ ok: true, value: res.result ? res.result.value : undefined }); }
    } catch (e) { results.push({ ok: false, error: e.message }); }
  }
  console.log(JSON.stringify({ ok: true, window: WINDOW, page: sp.url, results }));
  try { ws.close(); } catch (_) {}
  live.client.close();
  process.exit(0);
})().catch(e => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
