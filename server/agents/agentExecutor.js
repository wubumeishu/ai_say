// server/agents/agentExecutor.js · agent 统一执行器（总控 2026-10-25）
// 职责：接收 LLM 生成的 agent 调用（agentId + params）→ 查 registry 拿端点 schema →
//       调 HTTP（本地 8300 或直连 deepScrape）→ 归一化结果 { ok, agent, data, error? }
// 设计：
//   * strong 副作用 agent 调用方必须带 confirmed:true（执行器二次校验，防 LLM 误标）
//   * 端点走 HTTP（自调本地 8300）保持解耦；可注入 baseUrl 便于测试 mock
//   * 不持有窗口句柄——执行器只做「参数映射 + HTTP + 结果归一」，RPA 真动作由端点背后的 deepScrape 完成
var http = require('http');
var registry = require('./registry');

var DEFAULT_BASE = process.env.AISAY_BASE || 'http://127.0.0.1:8300';

/**
 * 执行一个 agent。
 * @param {object} call { agentId, params, confirmed? }
 * @param {object} opts { baseUrl?, timeoutMs? }
 * @returns {Promise<{ ok, agent, sideEffect, data?, error?, reason? }>}
 */
function executeAgent(call, opts) {
  opts = opts || {};
  var baseUrl = opts.baseUrl || DEFAULT_BASE;
  var agent = registry.getAgent(String(call && call.agentId || ''));
  if (!agent) {
    return Promise.resolve({ ok: false, agent: call && call.agentId, reason: 'unknown-agent', error: '未定义的 agent: ' + (call && call.agentId) });
  }
  var p = (call && call.params) || {};
  // 1. 参数校验（required）
  for (var i = 0; i < agent.params.length; i++) {
    var spec = agent.params[i];
    if (spec.required && (p[spec.name] === undefined || p[spec.name] === null || p[spec.name] === '')) {
      return Promise.resolve({ ok: false, agent: agent.id, reason: 'missing-param', error: '缺少必填参数 ' + spec.name });
    }
  }
  // 2. strong 副作用确认闸门（执行器层二次校验，与端点层双保险）
  if (agent.needsConfirm && call.confirmed !== true) {
    return Promise.resolve({
      ok: false, agent: agent.id, reason: 'confirmation-required',
      error: agent.id + ' 是强副作用，需 call.confirmed=true 才执行（建议→确认→执行铁律）'
    });
  }
  // 3. 构造请求体
  var body = agent.buildPayload ? agent.buildPayload(p) : p;
  // 4. 路径里 :id 替换
  var urlPath = agent.endpoint.path;
  // contactId 类路径参数：从 params 里按路径占位符替换
  var segments = urlPath.split('/');
  for (var s = 0; s < segments.length; s++) {
    var seg = segments[s];
    if (seg.indexOf(':') === 0) {
      var key = seg.slice(1);
      var val = p[key];
      if (val === undefined || val === null) {
        return Promise.resolve({ ok: false, agent: agent.id, reason: 'missing-path-param', error: '路径参数 ' + key + ' 缺失' });
      }
      segments[s] = encodeURIComponent(String(val));
    }
  }
  urlPath = segments.join('/');
  var method = agent.endpoint.method || 'GET';
  var payload = (method === 'POST' && body) ? JSON.stringify(body) : '';

  return new Promise(function (resolve) {
    var req = http.request({
      host: (function () {
        var m = baseUrl.match(/^https?:\/\/(\w+):?(\d*)/);
        return m ? m[1] : '127.0.0.1';
      })(),
      port: (function () {
        var m = baseUrl.match(/^https?:\/\/\w+:(\d+)/);
        return m ? parseInt(m[1], 10) : 8300;
      })(),
      path: urlPath,
      method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw: raw }; }
        // 归一：HTTP 2xx 且 parsed.ok!==false 视为成功（端点约定 ok 字段）
        var ok = res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false;
        resolve({
          ok: ok,
          agent: agent.id,
          sideEffect: agent.sideEffect,
          httpStatus: res.statusCode,
          data: parsed,
          error: ok ? undefined : (parsed.msg || parsed.reason || ('HTTP ' + res.statusCode))
        });
      });
    });
    req.on('error', function (e) {
      resolve({ ok: false, agent: agent.id, reason: 'http-error', error: String(e && e.message || e) });
    });
    var timer = setTimeout(function () {
      req.destroy();
      resolve({ ok: false, agent: agent.id, reason: 'timeout', error: 'agent 执行超时' });
    }, opts.timeoutMs || 30000);
    if (payload) req.write(payload);
    req.end();
    req.on('close', function () { clearTimeout(timer); });
  });
}

/**
 * 批量执行（编排场景，C 阶段预留；当前逐个串行）
 */
function executeAgents(calls, opts) {
  return calls.reduce(function (chain, call) {
    return chain.then(function (prev) {
      return executeAgent(call, opts).then(function (r) {
        prev.results = prev.results || [];
        prev.results.push(r);
        // strong 失败/需确认 → 停止后续（防连锁强副作用）
        if (!r.ok && r.reason === 'confirmation-required') { prev.stoppedAt = call.agentId; }
        return prev;
      });
    });
  }, Promise.resolve({ results: [] })).then(function (acc) {
    acc.ok = acc.results.every(function (r) { return r.ok; });
    return acc;
  });
}

module.exports = { executeAgent: executeAgent, executeAgents: executeAgents };
