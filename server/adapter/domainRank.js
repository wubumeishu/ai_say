'use strict';
// 全域运营 · 线索排序器（domainRank.js）
// 总控 2026-10-27 定死规则：
//   一级 = 引流类别 P1~P6（严格字典序，不跨类）
//   二级 = 在线档（同类别内）：1现在在线 > 2最近在线(x小时) > 3近期上线(x天) > 5未知 > 4有点时间没上线
//   "未知"排"近期上线"和"有点时间没上线(3天以上)"之间；低优先类别不过滤只降级。
// 数据源（2026-10-27 实测坐实）：
//   图标 span.online-icon.online-iconN → 主判据（icon1=在线/icon2=小时级/icon3=天级/icon4=3天以上/缺失=未知）
//   文案 span#online-label → 佐证（「オンライン」「3時間以内」「4時間以内」「3日以内」「3日以上」），用于档内细分
// 本模块纯函数、零副作用、可单测（喂 mock 候选 → 断言顺序）。

// 在线档数值（越小越靠前）。注意总控定的 5未知 插在 3近期 和 4(3天以上) 之间。
// 用 0/1/2/3/4 表示 档1..档5 的排序权重；"未知"=4？不——按总控：
//   档1现在在线=0, 档2最近在线=1, 档3近期上线=2, 档5未知=3, 档4有点时间没上线=4
const RANK = { online: 0, hours: 1, days: 2, unknown: 3, stale: 4 };

// 解析单个候选的在线档。
// 输入 online: { iconClass?: 'online-icon2', label?: '4時間以内', present?: boolean }
// 返回 { tier: 1|2|3|4|5, rankNum: number, sub: number }（sub 用于档内细分，如档2里 3h<4h）
function resolveOnline(online) {
  online = online || {};
  // 1) 缺图标 → 未知档（总控：未知=中间档）
  var cls = String(online.iconClass || '');
  var mIcon = cls.match(/online-icon(\d)/);
  if (!mIcon) {
    // 无图标：若文案明确「オンライン」仍可判在线（保守）
    var lb = String(online.label || '');
    if (/オンライン/.test(lb)) return { tier: 1, rankNum: RANK.online, sub: 0 };
    return { tier: 5, rankNum: RANK.unknown, sub: 0 };
  }
  var iconNum = parseInt(mIcon[1], 10);
  var label = String(online.label || '');
  if (iconNum === 1) {
    return { tier: 1, rankNum: RANK.online, sub: 0 };
  }
  if (iconNum === 2) {
    // 档2 最近在线：文案里的小时数做档内细分（3h 排 4h 前）
    var hm = label.match(/(\d+)時間/);
    return { tier: 2, rankNum: RANK.hours, sub: hm ? parseInt(hm[1], 10) : 99 };
  }
  if (iconNum === 3) {
    // 档3 近期上线：天数细分
    var dm = label.match(/(\d+)日/);
    return { tier: 3, rankNum: RANK.days, sub: dm ? parseInt(dm[1], 10) : 99 };
  }
  if (iconNum === 4) {
    // 档4 有点时间没上线（3天以上）
    var em = label.match(/(\d+)日以上/);
    return { tier: 4, rankNum: RANK.stale, sub: em ? parseInt(em[1], 10) : 99 };
  }
  // iconN 未知 N（>4）→ 按最旧处理
  return { tier: 4, rankNum: RANK.stale, sub: 99 };
}

// 引流类别 P1~P6（总控定的顺序）。cat 取 'chat'|'like'|'comment'|'viewed'|'footmark'|'browse'
const CAT_ORDER = { chat: 1, like: 2, comment: 3, viewed: 4, footmark: 5, browse: 6 };

// 解析单个候选的类别序号
function catNum(cat) {
  return CAT_ORDER[cat] !== undefined ? CAT_ORDER[cat] : 99;
}

// 对候选列表排序（原地不改，返回新数组）。
// candidate: { cat, online:{iconClass,label}, ...其他业务字段 }
function rankCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  var enriched = candidates.map(function(c) {
    var o = resolveOnline(c.online);
    return { cand: c, catN: catNum(c.cat), rankNum: o.rankNum, sub: o.sub, tier: o.tier };
  });
  enriched.sort(function(a, b) {
    if (a.catN !== b.catN) return a.catN - b.catN;              // 一级：引流类别
    if (a.rankNum !== b.rankNum) return a.rankNum - b.rankNum;  // 二级：在线档
    return a.sub - b.sub;                                        // 三级：档内细分（小时/天数）
  });
  return enriched.map(function(e) {
    return Object.assign({}, e.cand, {
      onlineTier: e.tier,
      catPriority: e.catN,
      onlineSub: e.sub
    });
  });
}

module.exports = {
  RANK: RANK,
  CAT_ORDER: CAT_ORDER,
  resolveOnline: resolveOnline,
  catNum: catNum,
  rankCandidates: rankCandidates
};
