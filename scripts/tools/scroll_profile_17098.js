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
  await sleep(1000);

  // Scroll through the whole profile page and collect all labels/values/inputs
  const scrollJs = "(() => {\n" +
    "  const step=600;\n" +
    "  const items=[];\n" +
    "  function collect(){\n" +
    "    const q=(sel)=>Array.from(document.querySelectorAll(sel)).map(el=>(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean);\n" +
    "    const labels=q('label, dt, .label, .field-label, .title, h1, h2, h3, h4, .caption, .name, .key, .row-label, [class*=label]');\n" +
    "    const values=Array.from(document.querySelectorAll('input, textarea, select, dd, .value, .field-value, .content, .item-value, [class*=value]'))\n" +
    "      .map((el)=>{\n" +
    "        if(el.tagName==='SELECT'){const opt=el.options&&el.options[el.selectedIndex];return (opt?(opt.textContent||'').trim():(el.value||'')).replace(/\\s+/g,' ').trim();}\n" +
    "        return ((el.value!==undefined&&el.value!=='')?String(el.value):((el.innerText||el.textContent||''))).replace(/\\s+/g,' ').trim();\n" +
    "      }).filter((s)=>s);\n" +
    "    const inputs=Array.from(document.querySelectorAll('input, textarea, select, button, a, [role=button], [class*=btn]'))\n" +
    "      .map((el)=>({tag:el.tagName, name:el.name||el.id||'', type:el.type||'', placeholder:el.placeholder||'', value:((el.value!==undefined&&el.value!=='')?String(el.value):(el.innerText||el.textContent||'')).replace(/\\s+/g,' ').slice(0,200), clickable:el.tagName==='BUTTON'||el.tagName==='A'||el.getAttribute('role')==='button'||/btn/i.test(String(el.className||''))}));\n" +
    "    items.push({scrollTop:Math.round(window.scrollY), labels, values, inputs});\n" +
    "  }\n" +
    "  collect();\n" +
    "  const max=Math.max(document.body.scrollHeight||0, document.documentElement.scrollHeight||0);\n" +
    "  for(let y=step; y<max; y+=step){ window.scrollTo(0, y); collect(); }\n" +
    "  window.scrollTo(0, 0);\n" +
    "  const seenLabels=[]; const seenInputs=[]; const seenPairs=[];\n" +
    "  for(const chunk of items){\n" +
    "    for(const l of chunk.labels){ if(!seenLabels.includes(l)) seenLabels.push(l); }\n" +
    "    for(const i of chunk.inputs){\n" +
    "      const key=i.tag+'|'+i.name+'|'+i.type+'|'+i.placeholder+'|'+i.value;\n" +
    "      if(!seenInputs.some((x)=>x.key===key)) seenInputs.push({key, ...i});\n" +
    "    }\n" +
    "    const pairs=[];\n" +
    "    chunk.labels.forEach((l,idx)=>{ const v=chunk.values[idx]; if(v) pairs.push(l+' => '+v); });\n" +
    "    for(const p of pairs){ if(!seenPairs.includes(p)) seenPairs.push(p); }\n" +
    "  }\n" +
    "  return {\n" +
    "    scrollHeight:document.documentElement.scrollHeight,\n" +
    "    innerHeight:window.innerHeight,\n" +
    "    chunks:items.length,\n" +
    "    labels:seenLabels,\n" +
    "    labelsCount:seenLabels.length,\n" +
    "    uniqueInputs:seenInputs.map((x)=>({tag:x.tag,name:x.name,type:x.type,placeholder:x.placeholder,value:x.value,clickable:x.clickable})),\n" +
    "    uniqueInputsCount:seenInputs.length,\n" +
    "    labelValuePairs:seenPairs,\n" +
    "    labelValuePairsCount:seenPairs.length,\n" +
    "    url:location.href,\n" +
    "    title:document.title\n" +
    "  };\n" +
    "})()";

  const result = await send('Runtime.evaluate', null, { returnByValue: true, expression: scrollJs, awaitPromise: true });
  const data = (result.result && result.result.value) || result.exceptionDetails || {};

  console.log(JSON.stringify({
    source: 'readonly-devtools-scroll',
    target: { id: target.id, url: target.url, title: target.title },
    data
  }, null, 2));

  ws.close();
  process.exit(0);
}

main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
