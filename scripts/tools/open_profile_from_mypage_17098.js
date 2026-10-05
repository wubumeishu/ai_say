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

  const clickJs = "(() => {\n" +
    "  const target=Array.from(document.querySelectorAll('a, button, [role=button], .btn-changeprofile'))\n" +
    "    .find((el)=>el.innerText && el.innerText.trim()==='プロフィールの確認・変更');\n" +
    "  if(!target){return {clicked:false, reason:'profile button not found'};}\n" +
    "  const href=target.href || target.getAttribute('href') || '';\n" +
    "  if(href){ location.href=href; return {clicked:true, method:'href', href, classes:target.className||'', tag:target.tagName}; }\n" +
    "  target.click();\n" +
    "  return {clicked:true, method:'click', classes:target.className||'', tag:target.tagName};\n" +
    "})()";
  const clickRes = await send('Runtime.evaluate', null, { returnByValue: true, expression: clickJs });
  const click = (clickRes.result && clickRes.result.value) || {};
  await sleep(3000);

  const readState = async () => {
    const readJs = "(() => {\n" +
      "  const text=(document.body && document.body.innerText) || '';\n" +
      "  const lines=text.split('\\n').map((s)=>s.trim()).filter(Boolean);\n" +
      "  const pairs=Array.from(document.querySelectorAll('form, .form-item, .field, [class*=item], .info, dl, table, .profile-detail, .my-profile, .user-info'))\n" +
      "    .map((el)=>(el.innerText||el.textContent||'').replace(/\\n+/g,' | ').replace(/\\s+/g,' ').trim())\n" +
      "    .filter((s)=>s && s.length>0 && s.length<400);\n" +
      "  const inputs=Array.from(document.querySelectorAll('input, textarea, select')).map(el=>({tag:el.tagName,name:el.name||el.id||'',type:el.type||'',placeholder:el.placeholder||'',value:(el.value||'').slice(0,500)}));\n" +
      "  return {url:location.href, title:document.title, readyState:document.readyState, lines:lines.slice(0,400), pairs:pairs.slice(0,200), inputs:inputs.slice(0,200)};\n" +
      "})()";
    const r = await send('Runtime.evaluate', null, { returnByValue: true, expression: readJs });
    return (r.result && r.result.value) || {};
  };

  const after = await readState();
  console.log(JSON.stringify({
    source: 'readonly-devtools',
    beforeUrl: target.url,
    click,
    after
  }, null, 2));
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
