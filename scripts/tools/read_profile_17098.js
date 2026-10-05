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

  const target = targets.find((t) => t.type === 'page' && t.url && t.url.includes('sp.194964.com/sns/snsmypage/show_profile.html')) ||
    targets.find((t) => t.type === 'page' && t.url && t.url.includes('sp.194964.com')) ||
    targets.find((t) => t.type === 'page') ||
    targets[0];

  if (!target) {
    console.log(JSON.stringify({ error: 'no page target', targets: targets.map((t) => ({ type: t.type, url: t.url })) }, null, 2));
    process.exit(1);
  }

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
    "  const lines=text.split('\\n').map((s)=>s.trim()).filter(Boolean);\n" +
    "  const labels=Array.from(document.querySelectorAll('label, dt, .label, .field-label, .title, h1, h2, h3, h4, .caption, .name, .key, .row-label, [class*=label]'))\n" +
    "    .map((el)=>(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean);\n" +
    "  const values=Array.from(document.querySelectorAll('input, textarea, select, dd, .value, .field-value, .content, .item-value, [class*=value]'))\n" +
    "    .map((el)=>{\n" +
    "      if(el.tagName==='SELECT'){\n" +
    "        const opt=el.options && el.options[el.selectedIndex];\n" +
    "        return (opt ? (opt.textContent||'').trim() : (el.value||'')).replace(/\\s+/g,' ').trim();\n" +
    "      }\n" +
    "      return ((el.value!==undefined && el.value!=='') ? String(el.value) : ((el.innerText||el.textContent||''))).replace(/\\s+/g,' ').trim();\n" +
    "    }).filter((s)=>s);\n" +
    "  const fields=Array.from(document.querySelectorAll('form, .form-item, .field, [class*=item], dl, table, .profile-detail, .my-profile, .user-info, .detail, .info'))\n" +
    "    .map((el)=>(el.innerText||el.textContent||'').replace(/\\n+/g,' | ').replace(/\\s+/g,' ').trim())\n" +
    "    .filter((s)=>s && s.length>0 && s.length<400);\n" +
    "  const buttons=Array.from(document.querySelectorAll('button, a, [role=button], [class*=btn]'))\n" +
    "    .map((el)=>(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean);\n" +
    "  return {url:location.href, title:document.title, readyState:document.readyState, textLength:text.length, lines:lines.slice(0,500), labels:labels.slice(0,220), values:values.slice(0,220), fields:fields.slice(0,220), buttons:buttons.slice(0,160)};\n" +
    "})()";
  const result = await send('Runtime.evaluate', null, { returnByValue: true, expression: readJs });
  const data = (result.result && result.result.value) || {};
  console.log(JSON.stringify({
    source: 'readonly-devtools',
    target: { id: target.id, url: target.url, title: target.title },
    data
  }, null, 2));
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
