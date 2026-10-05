// Ai SAY M1 - leadScoring.js (意向评分引擎)
// 导出: createLeadScoring({ store, aiService })
'use strict';

const crypto = require('crypto');

const SIGNAL_WEIGHTS = {
  lineWillingness: 30, priceInquiry: 20, replySpeed: 15, keywordHit: 15, reactivation: 10, negativeSentiment: -10
};

const SIGNAL_DETECTION = {
  lineWillingness: { keywords: ['line','LINE','ライン','add me on line'] },
  priceInquiry: { keywords: ['料金','いくら','価格','price','how much','費用'] },
  keywordHit: { keywords: ['会いたい','デート','結婚','本気','serious','date','遊び','飲み'] },
  negativeSentiment: { keywords: ['嫌い','もういい','やめて','no thanks','無駄','失望'] },
};

function scoreToTier(score) {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cold';
}

function createLeadScoring(opts) {
  opts = opts || {};
  const store = opts.store;
  const aiService = opts.aiService || null;
  if (!store) throw new Error('createLeadScoring: store is required');

  function scoreConversation(messages, meta) {
    meta = meta || {};
    const signals = [];
    let score = 0;
    const allText = messages.map(m => [m.original, m.translation, m.text].filter(Boolean).join(' ')).join(' ');
    const lower = allText.toLowerCase();

    function addSignal(detKey) {
      const det = SIGNAL_DETECTION[detKey];
      if (!det) return;
      const hits = det.keywords.filter(k => lower.includes(k.toLowerCase()));
      if (!hits.length) return;
      const baseW = Math.abs(SIGNAL_WEIGHTS[detKey]);
      let w;
      if (detKey === 'priceInquiry') w = Math.min(baseW, hits.length * 8);
      else if (detKey === 'keywordHit') w = Math.min(baseW, hits.length * 6);
      else w = baseW;
      if (detKey === 'negativeSentiment') w = -w;
      score += w;
      signals.push({ signal: detKey, weight: w, hits: hits });
    }

    addSignal('lineWillingness');
    addSignal('priceInquiry');

    { // 回复速度
      const peerMsgs = messages.filter(m => (m.role==='other'||m.role==='peer') && m.timeIso).sort((a,b)=>new Date(a.timeIso)-new Date(b.timeIso));
      const intervals = [];
      for (let i=1;i<peerMsgs.length;i++) intervals.push((new Date(peerMsgs[i].timeIso)-new Date(peerMsgs[i-1].timeIso))/60000);
      if (intervals.length) {
        const avg = intervals.reduce((a,b)=>a+b,0)/intervals.length;
        let w=0;
        if (avg<=5) w=15; else if (avg<=30) w=11; else if (avg<=120) w=6;
        if (w>0) { score+=w; signals.push({signal:'replySpeed',weight:w,avgIntervalMin:Math.round(avg)}); }
      }
    }

    addSignal('keywordHit');

    { // 沉默再活跃
      const silentDays = meta.silentDays||0;
      const hasMsg = messages.some(m=>m.role==='other'||m.role==='peer');
      if (silentDays>7 && hasMsg) { score+=10; signals.push({signal:'reactivation',weight:10,silentDays}); }
    }

    addSignal('negativeSentiment');

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score, tier: scoreToTier(score), signals };
  }

  async function scoreConversationWithLLM(messages, meta) {
    meta = meta||{};
    const rule = scoreConversation(messages, meta);
    if (!aiService || typeof aiService.chatCompletion!=='function')
      return Object.assign({}, rule, { llmUsed:false, llmNote:'rule-only' });
    try {
      const history = messages.slice(-12).map(m=>((m.role==='self'||m.role==='me')?'self':'peer')+': '+(m.translation||m.original||m.text||'')).join('\n');
      const out = await aiService.chatCompletion({messages:[{role:'system',content:'Return strict JSON score 0-100 and tier hot/warm/cold'},{role:'user',content:history}]});
      let parsed=null;
      if (typeof out==='string') { try{parsed=JSON.parse(out.trim());}catch(e){} }
      if (parsed && typeof parsed.score==='number') {
        const fused=Math.round(rule.score*0.6+parsed.score*0.4);
        return {score:fused,tier:scoreToTier(fused),signals:rule.signals.concat([{signal:'llm',llmScore:parsed.score}]),llmUsed:true};
      }
      return Object.assign({}, rule, { llmUsed:false, llmNote:'LLM unparseable' });
    } catch(e) {
      return Object.assign({}, rule, { llmUsed:false, llmNote:'LLM failed:'+e.message });
    }
  }

  function writeLeadEvent(p) {
    const now=new Date().toISOString();
    const id=crypto.createHash('sha1').update('lead/'+p.contactId+'/'+now+'/'+Math.random()).digest('hex');
    const evt={leadEventId:id,contactId:p.contactId,score:p.score,tier:p.tier,signals:JSON.stringify(p.signals||[]),action:p.action||'triggered',lineOffered:p.lineOffered?1:0,lineAdded:p.lineAdded?1:0,createdAt:now};
    if (store.db && store.db.prepare)
      store.db.prepare('INSERT OR IGNORE INTO LeadEvent (leadEventId,contactId,score,tier,signals,action,lineOffered,lineAdded,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id,p.contactId,p.score,p.tier,JSON.stringify(p.signals||[]),p.action||'triggered',p.lineOffered?1:0,p.lineAdded?1:0,now);
    else if (store.upsertLeadEvent) store.upsertLeadEvent(evt);
    return evt;
  }

  async function run(p) {
    p=p||{};
    const meta=p.conversationMeta||{};
    const contactId=meta.contactId||p.contactId||'';
    if(!contactId) throw new Error('contactId required');
    const result = p.useLLM ? await scoreConversationWithLLM(p.messages||[],meta) : scoreConversation(p.messages||[],meta);
    const leadEvent=writeLeadEvent({contactId,score:result.score,tier:result.tier,signals:result.signals});
    return Object.assign({},result,{leadEvent,contactId});
  }

  return { scoreConversation, scoreConversationWithLLM, writeLeadEvent, run, _SIGNAL_WEIGHTS:SIGNAL_WEIGHTS, _scoreToTier:scoreToTier };
}

module.exports = { createLeadScoring };