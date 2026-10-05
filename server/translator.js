const https = require('https');
const http = require('http');

const COMMON_PHRASES = [
  { label: '开场问候', text: '您好，很高兴为您服务，请问有什么可以帮您？' },
  { label: '询问需求', text: '请问您具体想了解哪方面的内容？' },
  { label: '确认订单', text: '麻烦您确认一下订单信息，确认后我们会尽快为您处理。' },
  { label: '支付说明', text: '支付完成后，我们会立即为您安排处理，感谢您的耐心等待。' },
  { label: '物流查询', text: '您的订单正在处理中，请您耐心等待，我们会第一时间更新物流信息。' },
  { label: '售后保障', text: '如有任何问题，请随时联系我们，我们会为您妥善解决。' }
];

function detectLanguage(text) {
  if (/[一-鿿]/.test(text || '')) return 'zh';
  if (/[\u3040-\u30ff]/.test(text || '')) return 'ja';
  if (/[\uac00-\ud7af]/.test(text || '')) return 'ko';
  return 'foreign';
}

function myMemoryTranslate(text, sourceLang, targetLang, timeoutMs) {
  const clean = String(text || '').trim();
  if (!clean) return Promise.resolve('');
  const q = encodeURIComponent(clean);
  const langpair = encodeURIComponent((sourceLang || 'autodetect') + '|' + (targetLang || 'zh-CN'));
  const url = 'https://api.mymemory.translated.net/get?q=' + q + '&langpair=' + langpair;
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const out = parsed && parsed.responseData && parsed.responseData.translatedText;
          if (typeof out !== 'string' || !out.trim()) {
            return reject(new Error('翻译引擎未返回可用结果'));
          }
          resolve(out);
        } catch (err) {
          reject(new Error('翻译引擎返回解析失败: ' + err.message));
        }
      });
    });
    req.on('error', (err) => reject(new Error('翻译引擎请求失败: ' + err.message)));
    req.setTimeout(timeoutMs || 8000, () => req.destroy(new Error('翻译引擎请求超时')));
  });
}

function buildRecommendation(message, context) {
  const text = (message && message.text) || '';
  const lower = String(text).toLowerCase();
  const rules = [
    { when: /hi|hello|hey|你好|您好|哈喽|안녕|こんにちは/.test(lower), reply: '您好，很高兴为您服务，请问有什么可以帮您？' },
    { when: /price|cost|how much|多少钱|价格|费用|いくら|price/.test(lower), reply: '关于价格，不同方案略有差异，麻烦您告诉我具体需求，我为您核算最合适的一档。' },
    { when: /order|buy|purchase|下单|购买|订单|注文/.test(lower), reply: '收到，麻烦您确认一下订单信息，确认后我们会尽快为您处理。' },
    { when: /pay|payment|paypal|stripe|支付|付款|支払/.test(lower), reply: '支付完成后，我们会立即为您安排处理，感谢您的耐心等待。' },
    { when: /ship|delivery|logistic|track|发货|物流|快递|発送/.test(lower), reply: '您的订单正在处理中，我们会尽快安排发货，并第一时间为您更新物流信息。' },
    { when: /refund|return|complain|投诉|退款|退货/.test(lower), reply: '非常抱歉给您带来不便，请提供订单编号，我们会第一时间为您核实并妥善处理。' },
    { when: /thank|谢谢|感谢|thanks|有難|감사/.test(lower), reply: '不客气，很高兴能帮到您，后续有任何问题随时联系我们。' }
  ];
  const hit = rules.find((r) => r.when);
  const result = {
    message: hit ? hit.reply : '您好，已经收到您的消息，请稍等，我们马上为您核实处理。',
    rationale: hit ? '根据关键词匹配常用话术' : '通用兜底话术',
    confidence: hit ? 0.9 : 0.6
  };
  if (context && context.customerName) {
    result.message = '您好 ' + context.customerName + '，' + result.message.replace(/^您好[，,]?/, '').trim();
  }
  return result;
}

function translateToChinese(text, options) {
  const opts = options || {};
  const trimmed = String(text || '').trim();
  if (!trimmed) return Promise.resolve({ text: '', source: 'empty' });
  if (detectLanguage(trimmed) === 'zh') return Promise.resolve({ text: trimmed, source: 'passthrough' });
  return myMemoryTranslate(trimmed, 'autodetect', 'zh-CN', opts.timeoutMs)
    .then((out) => ({ text: out, source: 'engine' }))
    .catch((err) => ({ text: '【原文】' + trimmed, source: 'fallback', error: err.message }));
}

module.exports = { COMMON_PHRASES, buildRecommendation, detectLanguage, myMemoryTranslate, translateToChinese };