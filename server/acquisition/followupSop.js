'use strict';
// =============================================================================
// 跟进 SOP 引擎（v5.3 C 阶段 · "3 天加ライン"软推进规则）
// 纯逻辑：入参 = 会话状态 { stage, lastMsgAt, daysSinceLast, contactId }
// 出参 = { action: { kind, days, templateKey, urgency }, talks: [3 类参考话术] }
// 设计原则（用户口径）：
//   - 不秒回：轮询只是"发现新消息→触发该做的事"，不是定时轰炸
//   - LINE 一律「ライン」（不直说 LINE 品牌），软推进
//   - 男性付费语境：话术从"我忙/关心你/轻松聊天/理解"切入，不硬逼见面
// =============================================================================

// 三类参考话术模板（{name} 占位；ja 主 + zh 对照；LINE 用 ライン）
const TEMPLATES = {
  care: {
    // 关心（对方久不回时，先关心再轻提）
    ja: "お疲れですか？\n忙しくても無理に返信しなくて大丈夫。\n少し心配だから、ついでに一声。",
    zh: "最近辛苦吧？\n忙的话也不用勉强回我。\n我只是有点担心，顺带说一声。",
  },
  nudge: {
    // 软推进（3 天没回 → 自然带出 ライン，不硬逼）
    ja: "お仕事も忙しそうだから、返信遅れても大丈夫だよ。\n実は、もっと気軽に話せると嬉しいなと思って、\nラインで連絡をとることもある。\nよかったら、こっちでも気軽に話す？",
    zh: "看你工作也挺忙的，回消息慢一点完全没问题。\n其实我觉得能轻松聊聊天会更好，\n所以有时会在ライン上联系。\n方便的话，要不要在那边也聊聊？",
  },
  understand: {
    // 理解退路（对方不接ライン/不推进时，给台阶，不掉价）
    ja: "もしラインが面倒だったら、\nここでチャットすることも全然問題ないよ。\nあなたのペースでゆっくりで。\n会いたい時は、またいつでも声かけてね。",
    zh: "如果觉得ライン麻烦的话，\n在这里聊天也完全没问题。\n按你的节奏慢慢来就好。\n想见我的时候，随时跟我说一声。",
  },
  meet: {
    // 约见面（stage=2 推进线下）
    ja: "そろそろ会った方が、もっと色々話せるかなって思うよ。\n今週、時間ありますか？\nあなたの都合に合わせて、遠慮なく言ってください。",
    zh: "我觉得见面的话，能聊的会更多一些。\n这周有时间吗？\n按你的方便来，别客气。",
  },
};

/**
 * 根据"距上条消息天数 + 当前 stage"算该做的动作。
 * @param {object} ctx { daysSinceLast, stage, contactId }
 * @returns {{ action: { kind, days, templateKey, urgency } | null, reason: string }}
 *   - daysSinceLast < 2 且 stage>=1 → 不催（太早），只标记跟进中
 *   - 2-4 天 + stage=1 → care（先关心）
 *   - >=3 天 + stage=1/2 → nudge（软推进ライン）【3 天加ライン核心】
 *   - 推过ライン后未回 >=3 天 → understand（理解退路）
 *   - stage=5（冷却）→ 不触发
 */
function decideNext(ctx) {
  const days = Number(ctx.daysSinceLast) || 0;
  const stage = Number(ctx.stage) || 0;
  if (stage === 5) return { action: null, reason: 'sop-cooldown', note: '冷却期，不触发' };
  // stage 2（约见面）后 >=3 天没回应 → 理解退路
  if (stage === 2 && days >= 3) return { action: { kind: 'understand', templateKey: 'line', urgency: 'soft' }, reason: 'sop-line-no-response', note: '推過ライン未回应，给台阶' };
  // 核心：3 天没回 + 还在跟进中(1) → 软推进ライン
  if (stage === 1 && days >= 3) return { action: { kind: 'nudge', templateKey: 'line', urgency: 'soft' }, reason: 'sop-3day-line', note: '3天未回，软推进ライン' };
  // 2 天没回 + 跟进中 → 先关心
  if (stage === 1 && days >= 2) return { action: { kind: 'care', templateKey: 'care', urgency: 'low' }, reason: 'sop-care', note: '2天未回，先关心' };
  // 破冰期（stage 0）不催
  return { action: null, reason: 'sop-pending', note: '仍在破冰期，不触发跟进' };
}

/**
 * 生成某类参考话术（带 name 占位替换 + 中英对照 + 原话判断）。
 * @param {string} kind care|nudge|understand|meet
 * @param {object} ctx { name?, scene? }
 * @returns {{ kind, ja, zh, suggested: string, note: string }}
 */
function buildTalks(kind, ctx = {}) {
  const tpl = TEMPLATES[kind] || TEMPLATES.care;
  const name = ctx.name || 'あなた';
  const fill = (s) => String(s).replace(/{name}/g, name);
  return {
    kind,
    ja: fill(tpl.ja),
    zh: fill(tpl.zh),
    suggested: fill(tpl.ja),   // 建议发送的日文（保留换行）
    note: kind === 'nudge' ? 'ライン 软推进（3天未回核心动作），不直接说 LINE 品牌' :
          kind === 'understand' ? '理解退路（对方不接ライン时给台阶），不掉价' :
          kind === 'care' ? '关心切入（男性付费语境：你先忙，不硬逼回）' :
          '约见面（stage=2 推进线下）',
  };
}

/**
 * 组合入口：decide + 一次给 3 类参考话术（供前端面板"AI SAY"选）。
 */
function generate(ctx) {
  const dec = decideNext(ctx);
  const kind = dec.action ? dec.action.kind : 'care';
  return {
    decision: dec,
    talks: [buildTalks('care', ctx), buildTalks('nudge', ctx), buildTalks('understand', ctx)],
    recommended: buildTalks(kind, ctx),
  };
}

module.exports = { TEMPLATES, decideNext, buildTalks, generate };
