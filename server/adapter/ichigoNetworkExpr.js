(async function() {
  // 网络体检（只读）：出口 IP + 平台连通 + 时间戳。绝不改动页面任何状态。
  var out = { ts: new Date().toISOString() };
  var ip = null;
  try {
    var r = await fetch('https://ipinfo.io/json', { cache: 'no-store' });
    if (r.ok) { var j = await r.json(); ip = { ip: j.ip, country: j.country || '', city: j.city || '', org: j.org || '' }; }
  } catch (e) { /* 换备用服务 */ }
  if (!ip) {
    try {
      var r2 = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
      if (r2.ok) { var j2 = await r2.json(); ip = { ip: String(j2.ip || '') }; }
    } catch (e2) { /* 两个都挂 */ }
  }
  out.exitIp = ip;
  var t0 = Date.now();
  try {
    var r3 = await fetch('https://sp.194964.com/favicon.ico', { cache: 'no-store' });
    out.platform = { ok: r3.ok || r3.status === 404, ms: Date.now() - t0, status: r3.status };
  } catch (e4) {
    out.platform = { ok: false, ms: Date.now() - t0, error: String((e4 && e4.message) || e4) };
  }
  return out;
})()

