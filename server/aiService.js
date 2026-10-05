// Reusable AI service: translation, page understanding (with screenshots),
// and reply recommendation. Works across any BitBrowser window / platform.
//
// Settings live under settings.json -> ai:
//   {
//     enabled: true,
//     provider: 'openai',
//     baseUrl: 'https://api.openai.com/v1',
//     apiKey: '',
//     model: 'gpt-4o-mini',
//     visionModel: 'gpt-4o',
//     translateLang: 'zh-CN',
//     timeoutMs: 60000,
//     useScreenshotForPage: true,
//     temperature: 0.3
//   }

const fs = require('fs');
const path = require('path');
const CONFIG_PATH = path.join(__dirname, '..', 'settings.json');

function loadAiSettings() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return cfg.ai || {};
  } catch {
    return {};
  }
}

function saveAiSettings(patch) {
  let current = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {}
  current.ai = { ...(current.ai || {}), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
  return current.ai;
}

function publicSettings(ai) {
  ai = ai || {};
  return {
    enabled: !!ai.enabled,
    provider: ai.provider || 'openai',
    baseUrl: ai.baseUrl || 'https://api.openai.com/v1',
    hasKey: !!String(ai.apiKey || '').trim(),
    model: ai.model || '',
    visionModel: ai.visionModel || '',
    translateLang: ai.translateLang || 'zh-CN',
    timeoutMs: ai.timeoutMs || 60000,
    useScreenshotForPage: ai.useScreenshotForPage !== false,
    temperature: ai.temperature != null ? ai.temperature : 0.3
  };
}

function isConfigured(ai) {
  ai = ai || {};
  return !!ai.enabled && !!String(ai.apiKey || '').trim();
}

async function chatCompletion({ settings, messages, model, temperature, maxTokens }) {
  const ai = settings || loadAiSettings();
  if (!isConfigured(ai)) {
    const err = new Error('AI not configured: please set API key and enable it in settings');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const baseUrl = String(ai.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const reqModel = model || ai.visionModel || ai.model || 'gpt-4o';
  const body = {
    model: reqModel,
    messages,
    temperature: temperature != null ? temperature : (ai.temperature != null ? ai.temperature : 0.3)
  };
  if (maxTokens) body.max_tokens = maxTokens;

  const controller = new AbortController();
  const timeoutMs = ai.timeoutMs || 60000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + String(ai.apiKey).trim()
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error('AI request failed: HTTP ' + res.status + ' ' + text.slice(0, 300));
      err.status = res.status;
      throw err;
    }
    const parsed = JSON.parse(text);
    const content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
    return String(content || '').trim();
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('AI request timeout (' + timeoutMs + 'ms)');
      e.code = 'AI_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function aiTranslate(text, opts) {
  opts = opts || {};
  const settings = opts.settings || loadAiSettings();
  const clean = String(text || '').trim();
  if (!clean) return { text: '', source: 'empty', ok: true };
  if (!isConfigured(settings)) {
    const t = require('./translator');
    const r = await t.translateToChinese(clean, { timeoutMs: settings.timeoutMs }).catch(() => ({ text: '', source: 'fallback' }));
    return { text: r.text || '', source: 'offline', ok: !!(r.text && r.text !== clean), targetLang: settings.translateLang || 'zh-CN' };
  }
  const targetLang = settings.translateLang || 'zh-CN';
  const system = 'You are a professional translator. Translate the user text accurately into ' + targetLang +
    '. Output only the translation, no explanation, do not repeat the source. If the source is already ' + targetLang + ', return it unchanged.';
  const out = await chatCompletion({ settings, messages: [
    { role: 'system', content: system },
    { role: 'user', content: clean }
  ] });
  return { text: out, source: 'ai', ok: true, targetLang };
}

function describePagePayload(payload, question) {
  payload = payload || {};
  const parts = [];
  parts.push('Page URL: ' + (payload.url || '(unknown)'));
  parts.push('Page title: ' + (payload.title || '(unknown)'));
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length) {
    parts.push('Visible text excerpt (first ' + Math.min(lines.length, 400) + ' lines):');
    parts.push(lines.slice(0, 400).join('\n'));
  }
  if (payload.extra) parts.push('Extra: ' + JSON.stringify(payload.extra));
  parts.push('Question: ' + (question || 'Describe what this page is and what identifiable information/features it has.'));
  return parts.join('\n\n');
}

async function aiUnderstandPage(payload, opts) {
  opts = opts || {};
  const settings = opts.settings || loadAiSettings();
  if (!isConfigured(settings)) {
    return { ok: false, configured: false, note: 'AI not configured; enable it in settings to understand pages.', text: '' };
  }
  const useImage = settings.useScreenshotForPage !== false && payload && payload.screenshotBase64;
  const question = opts.question || 'Describe what this page is and what identifiable information/features it has.';
  const sys = 'You analyze web pages. Based on the provided text, url, title, and screenshot (if any), answer the user question. Be structured, accurate, and based only on real page content; state any missing fields explicitly.';
  const messages = [{ role: 'system', content: sys }];
  if (useImage) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: describePagePayload(payload, question) },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + payload.screenshotBase64 } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: describePagePayload(payload, question) });
  }
  const model = settings.visionModel || settings.model;
  const out = await chatCompletion({ settings, messages, model });
  return { ok: true, configured: true, text: out, usedScreenshot: useImage };
}

async function aiRecommendReply({ messages, peerName, context, style }, opts) {
  opts = opts || {};
  const settings = opts.settings || loadAiSettings();
  if (!isConfigured(settings)) {
    const t = require('./translator');
    const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
    const rec = t.buildRecommendation({ text: last ? (last.original || last.text || '') : '' }, { customerName: peerName });
    return { ok: true, source: 'rules', reply: rec.message, rationale: rec.rationale, confidence: rec.confidence };
  }
  const history = (Array.isArray(messages) ? messages : []).slice(-12).map((m) => {
    const role = m.role === 'self' ? 'self' : 'peer';
    const txt = m.translation || m.original || m.text || '';
    return role + ': ' + String(txt);
  }).join('\n');
  const sys = 'You are a professional customer support assistant replying on a dating/social platform. Reply in Chinese.'
    + ' Avoid empty boilerplate; handle price/order/logistics with proper talk tracks. One reply per line, no numbering, no extra commentary.'
    + '. Tailor to the peer\'s content, avoid empty boilerplate; handle price/order/logistics questions with proper talk tracks. Output one reply per line, no numbering beyond a bullet, no extra commentary.';
  const user = 'Peer: ' + (peerName || '(unknown)') + '\nContext: ' + (context ? JSON.stringify(context) : '(none)') +
    '\nHistory:\n' + (history || '(empty)') + '\nGive 1-3 reply suggestions.';
  const out = await chatCompletion({ settings, messages: [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ] });
  const replies = out.split('\n').map((s) => s.replace(/^\s*\d+[.、)）]\s*/, '').replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  return {
    ok: true,
    source: 'ai',
    replies: replies.length ? replies : [out],
    reply: replies[0] || out,
    rationale: 'AI-generated reply suggestion',
    confidence: 0.85
  };
}

module.exports = {
  loadAiSettings,
  saveAiSettings,
  publicSettings,
  isConfigured,
  chatCompletion,
  aiTranslate,
  aiUnderstandPage,
  aiRecommendReply,
  describePagePayload
};
