const WebSocket = require('ws');
const http = require('http');
const { BitBrowserClient } = require('I:/project/Ai SAY/server/bitbrowser.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const c = new BitBrowserClient('http://127.0.0.1:54346');
  const ports = await c.call('/browser/ports', {}).catch(() => ({}));
  const port = ports['2315e879dd6642559bdc11a07bb1fc43'];
  if (!port) { console.log(JSON.stringify({ error: 'window not open; no debug port', ports })); process.exit(1); }
  const listUrl = 'http://127.0.0.1:' + port + '/json/list';
  const targets = await new Promise((resolve, reject) => {
    http.get(listUrl, (res) => {
      let d = '';
      res.on('data', (x) => d += x);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('json/list parse failed: ' + d.slice(0, 500))); }
      });
    }).on('error', reject);
  });
  const target = targets.find((t) => t.type === 'page' && t.url && t.url.includes('sp.194964.com/mypage.html')) ||
    targets.find((t) => t.type === 'page') || targets[0];
  if (!target) { console.log(JSON.stringify({ error: 'no page target', targets: targets.map((t) => ({ type: t.type, url: t.url })) })); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  let seq = 0;
  const pending = new Map();
  const send = (method, session, params = {}) => new Promise((resolve, reject) => {
    seq += 1;
    const id = seq;
    const msg = { id, method, params };
    if (session) msg.session = session;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify(msg));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 10000);
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, method } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(method + ': ' + (m.error.message || JSON.stringify(m.error))));
      else resolve(m.result || {});
    }
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2000);

  const readJs = "(() => {\n" +
    "  const text=(document.body && document.body.innerText) || '';\n" +
    "  const q=(sel)=>Array.from(document.querySelectorAll(sel)).map(el=>(el.innerText||el.textContent||'').trim()).filter(Boolean);\n" +
    "  const lines=text.split('\\n').map((s)=>s.trim()).filter(Boolean);\n" +
    "  const visibleTexts=q('[class*=mypage], [class*=profile], [class*=user], [class*=setting], [class*=menu], li, p, h1, h2, h3, div');\n" +
    "  const buttons=q('a, button, [role=button], [class*=btn], li');\n" +
    "  const inputs=Array.from(document.querySelectorAll('input, textarea, select')).map(el=>({tag:el.tagName,name:el.name||el.id||'',type:el.type||'',placeholder:el.placeholder||'',value:(el.value||'').slice(0,200)}));\n" +
    "  return {url:location.href, title:document.title, readyState:document.readyState, textLength:text.length, textPreview:text.slice(0,12000), lines:lines.slice(0,250), visibleTexts:visibleTexts.slice(0,200), buttons:buttons.slice(0,160), inputs:inputs.slice(0,60)};\n" +
    "})()";
  const result = await send('Runtime.evaluate', null, { returnByValue: true, expression: readJs });
  if (result.exceptionDetails) {
    console.log(JSON.stringify({ url: target.url, exception: result.exceptionDetails }, null, 2));
  } else {
    const value = (result.result && result.result.value) || {};
    console.log(JSON.stringify({
      source: 'readonly-devtools',
      target: { id: target.id, url: target.url, title: target.title },
      data: value
    }, null, 2));
  }
  ws.close();
  await sleep(200);
  process.exit(0);
}

main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
