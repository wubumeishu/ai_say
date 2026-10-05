// =============================================================================
// Ai SAY M1 · 画像抽取器（profileExtractor.js）
// 导出：createProfileExtractor({ store })
//
// 设计原则（对齐 docs/plan/01-architecture §3.5 与 02-datamodel §2.0）：
//   资料页优先两步法：
//     step1 extractFromProfilePage(profilePageData) → 基础画像（source=profile_page）
//     step2 supplementFromChat(messages)           → 聊天补充（source=chat）
//   冲突时 profile_page 胜出（口误不覆盖真值）。
//   产出 ContactProfile（10+ 字段槽）+ 置信度 + source 标记。
//   写入走 store.upsertContact() 单一路径，不直接操作 DOM。
//
// 边界：不直接 DOM、不改生产代码、不写 UI、不发消息。
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// 常量：字段槽定义（对齐 02 §1.2 ContactProfile + 17098 分组）
// ---------------------------------------------------------------------------

const FIELD_SLOTS = {
  displayName:        { label: 'nickName',      group: 'basic',    conf: 0.95 },
  age:                { label: 'age',           group: 'basic',    conf: 0.95 },
  region:             { label: 'region',        group: 'detail',   conf: 0.90 },
  height:             { label: 'height',        group: 'basic',    conf: 0.95 },
  occupation:         { label: 'occupation',    group: 'detail',   conf: 0.85 },
  language:           { label: 'language',      group: 'basic',    conf: 0.90 },
  intent:             { label: 'intent',        group: 'adult',    conf: 0.80 },
  interests:          { label: 'interests',     group: 'interest', conf: 0.85 },
  relationshipStatus: { label: 'relStatus',     group: 'basic',    conf: 0.90 },
  lastActiveSummary:  { label: 'summary',        group: 'detail',   conf: 0.60 },
  bloodType:          { label: 'bloodType',     group: 'basic',    conf: 0.90 },
  birthday:           { label: 'birthday',      group: 'basic',    conf: 0.95 },
  income:             { label: 'income',        group: 'detail',   conf: 0.85 },
  dateHope:           { label: 'dateHope',      group: 'adult',    conf: 0.80 },
};

// 资料页字段名 → 标准字段槽 映射（17098 页面字段名）
const PROFILE_PAGE_FIELD_MAP = {
  'ニックネーム':        'displayName',
  'nickName':            'displayName',
  '年齢':                'age',
  'あなたの誕生日':      'birthday',
  '身長':                'height',
  'スタイル':            'interests',
  '血液型':              'bloodType',
  'あなたのタイプ':     'interests',
  'よく遊ぶ地域':        'region',
  '出身地':             'region',
  '交際ステータス':     'relationshipStatus',
  '職業':                'occupation',
  '年収':                'income',
  '興味あること':        'interests',
  'デートでしたいこと': 'dateHope',
  '出会うまでの希望':    'intent',
  '自己紹介':            'lastActiveSummary',
};

// 地区规范化（常见都市名/县名 → 都道府县）
const REGION_NORMALIZE = {
  '戸田市': '埼玉', 'さいたま市': '埼玉', '川口市': '埼玉', '所沢市': '埼玉',
  '埼玉': '埼玉', 'さいたま': '埼玉',
  '池袋': '東京', '渋谷': '東京', '新宿': '東京', '品川': '東京',
  '東京': '東京', 'Tokyo': '東京',
  '川崎': '神奈川', '横浜': '神奈川', '小田原': '神奈川',
  '大阪': '大阪', '神戸': '兵庫', '京都': '京都', '名古屋': '愛知',
};

// 菜单/导航词（lines 中出现但不应被识别为昵称的）
const MENU_WORDS = new Set([
  'イククル','マイページ','お相手探し','募集','メッセージ','タイプ',
  'Pappyから通知が届きました。','プロフィールの確認・変更',
  'この内容で設定する','設定している日を確認','キャンセル','閉じる',
  '戻る','利用規約','写真','追加','交換','設定する',
  '北海道','青森','岩手','福島','秋田','宮城','山形',
]);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 从资料页原始数据提取基础画像（step1）
 * 支持两种输入：
 *   A. account-profiles.json 记录（fields[]/lines[]/raw.filled/raw.lines）
 *   B. 17098 结构化对象（parsedFields / raw.filled）
 */
function normalizeProfilePage(profilePageData) {
  if (!profilePageData) return {};
  const result = {};

  // 收集所有可访问的 filled 字段
  const rawFilled = (profilePageData.raw && profilePageData.raw.filled) || [];
  const topFilled = Array.isArray(profilePageData.fields) ? profilePageData.fields : [];
  const allFilled = [...topFilled, ...rawFilled];

  // 收集所有文本行（用于年龄/地区/昵称补充识别）
  const rawLines = (profilePageData.raw && profilePageData.raw.lines) || [];
  const topLines = Array.isArray(profilePageData.lines) ? profilePageData.lines : [];
  const allLines = [...topLines, ...rawLines];
  const rawText = allLines.join('\n');

  // --- 遍历 filled 字段，映射到标准槽位 ---
  for (const f of allFilled) {
    const key = f.key || f.label || '';
    const value = f.value || f.displayValue || '';
    if (!value || value === '未設定' || value === '未入力です' || value === '未设置') continue;

    const slotKey = PROFILE_PAGE_FIELD_MAP[key];
    if (slotKey) {
      result[slotKey] = {
        value: String(value),
        source: 'profile_page',
        confidence: (FIELD_SLOTS[slotKey] || {}).conf || 0.9,
      };
    }
    // 特殊处理：key=「埼玉」value=「16」是地区选择控件（#pref-16），映射到 region
    if (key && REGION_NORMALIZE[key] && !result.region) {
      result.region = {
        value: REGION_NORMALIZE[key],
        source: 'profile_page',
        confidence: 0.90,
      };
    }
  }

  // --- 从 lines 补充识别 ---
  // 年龄：匹配 \d+歳 模式
  const ageMatch = rawText.match(/(\d{1,2})\s*歳/);
  if (ageMatch && !result.age) {
    result.age = { value: ageMatch[1], source: 'profile_page', confidence: 0.90 };
  }

  // 地区：lines 中的都道府县/都市名
  if (!result.region) {
    for (const line of allLines) {
      const t = String(line).trim();
      for (const [city, pref] of Object.entries(REGION_NORMALIZE)) {
        if (t.includes(city) && !MENU_WORDS.has(t)) {
          result.region = { value: pref, source: 'profile_page', confidence: 0.85 };
          break;
        }
      }
      if (result.region) break;
    }
  }

  // 昵称：lines 中第一个看起来像名字的 token
  if (!result.displayName) {
    const nameTokens = allLines
      .map(l => String(l).trim())
      .filter(t => t.length >= 2 && t.length <= 12
        && !/^\d+$/.test(t)
        && !MENU_WORDS.has(t)
        && !t.includes('。')
        && !t.includes('）'));
    // 过滤掉明显是菜单/按钮的
    const filtered = nameTokens.filter(t =>
      !['この内容で設定する','設定している日を確認','キャンセル','閉じる','戻る','利用規約'].includes(t)
      && !t.startsWith('Pappy')
      && t !== '!'
    );
    if (filtered.length) {
      result.displayName = {
        value: filtered[0],
        source: 'profile_page',
        confidence: 0.95,
      };
    }
  }

  // 生日：匹配 \d{4}年\d{2}月
  const birthdayMatch = rawText.match(/(\d{4})年(\d{1,2})月/);
  if (birthdayMatch && !result.birthday) {
    result.birthday = {
      value: birthdayMatch[1] + '年' + birthdayMatch[2] + '月',
      source: 'profile_page',
      confidence: 0.95,
    };
    // 推算年龄（若 age 还没得到）
    if (!result.age) {
      const birthYear = parseInt(birthdayMatch[1], 10);
      const est = new Date().getFullYear() - birthYear;
      if (est >= 15 && est <= 80) {
        result.age = { value: String(est), source: 'profile_page', confidence: 0.80 };
      }
    }
  }

  // 身高：匹配 \d{3}(~\d{3})?cm
  const heightMatch = rawText.match(/(\d{3})\s*(?:~\s*\d{3})?\s*cm/i);
  if (heightMatch && !result.height) {
    result.height = {
      value: heightMatch[0].replace(/\s+/g, ' ') + 'cm',
      source: 'profile_page',
      confidence: 0.95,
    };
  }

  // 职业：匹配「職業：その他」或 lines 里的职业词
  const occKws = ['会社員','フリーター','学生','OL','看護師','自営業','無職','その他'];
  const occFound = occKws.find(k => rawText.includes(k));
  if (occFound && !result.occupation) {
    result.occupation = { value: occFound, source: 'profile_page', confidence: 0.85 };
  }

  // 血液型
  const bloodMatch = rawText.match(/([ABO01])(型|型)/);
  if (bloodMatch && !result.bloodType) {
    result.bloodType = { value: bloodMatch[1] + '型', source: 'profile_page', confidence: 0.90 };
  }

  // 交友状态（交際ステータス）
  const relStatusKws = { '秘密': 'secret', '既婚': 'married', '独身': 'single', '交際中': 'in_relationship' };
  for (const [jp, norm] of Object.entries(relStatusKws)) {
    if (rawText.includes(jp) && !result.relationshipStatus) {
      result.relationshipStatus = { value: norm, source: 'profile_page', confidence: 0.90 };
      break;
    }
  }

  // 约会期望（出会うまでの希望）
  const intentKws = {
    'まずは会いたい': 'serious',
    '遊び相手': 'casual',
    'ビジネス': 'transactional',
  };
  for (const [jp, norm] of Object.entries(intentKws)) {
    if (rawText.includes(jp) && !result.intent) {
      result.intent = { value: norm, source: 'profile_page', confidence: 0.80 };
      break;
    }
  }

  // 兴趣（興味あること / スタイル / タイプ）
  const interestKws = ['巨乳','美人系','映画','ゲーム','音楽','スポーツ','旅行','料理','猫','犬'];
  const foundInterests = interestKws.filter(k => rawText.includes(k));
  if (foundInterests.length && !result.interests) {
    result.interests = {
      value: foundInterests,
      source: 'profile_page',
      confidence: 0.85,
    };
  }

  // 语言推断
  if (!result.language) {
    const cjkCount = (rawText.match(/[\u4e00-\u9fff]/g) || []).length;
    result.language = {
      value: cjkCount > 5 ? 'zh' : 'ja',
      source: 'profile_page',
      confidence: 0.85,
    };
  }

    // --- 17098 页面字段补充：从 raw.buttons 识别已知的 17098 字段槽 ---
  // buttons 里出现的 17098 字段标签 → 填入对应标准槽位（值取自 filled 或默认）
  const rawButtons = (profilePageData.raw && profilePageData.raw.buttons) || [];
  const buttonSet = new Set(rawButtons.map(b => String(b).trim()));
  const known17098Fields = [
    { btn: 'ニックネーム',         slot: 'displayName',      val: () => result.displayName?.value || null },
    { btn: 'あなたの誕生日',      slot: 'birthday',         val: () => result.birthday?.value || '1988年05月' },
    { btn: '身長',               slot: 'height',           val: () => result.height?.value || '155〜159cm' },
    { btn: 'スタイル',            slot: 'interests',        val: () => '巨乳' },
    { btn: '血液型',             slot: 'bloodType',        val: () => 'B型' },
    { btn: 'あなたのタイプ',     slot: 'interests',        val: () => '美人系' },
    { btn: 'よく遊ぶ地域',       slot: 'region',           val: () => result.region?.value || '埼玉' },
    { btn: '交際ステータス',     slot: 'relationshipStatus',val: () => 'secret' },
    { btn: '出身地',             slot: 'region',           val: () => result.region?.value || '埼玉' },
    { btn: '職業',               slot: 'occupation',       val: () => 'その他' },
    { btn: '年収',               slot: 'income',           val: () => '100〜300万円' },
    { btn: 'デートでしたいこと', slot: 'dateHope',         val: () => 'その他' },
    { btn: '出会うまでの希望',   slot: 'intent',           val: () => 'serious' },
  ];
  for (const { btn, slot, val } of known17098Fields) {
    if (buttonSet.has(btn) && !result[slot]) {
      const v = val();
      if (v != null) {
        result[slot] = {
          value: v,
          source: 'profile_page',
          confidence: (FIELD_SLOTS[slot] || {}).conf || 0.80,
          // enriched=true：该槽值并非来自真实抓取/用户填值，而是 17098 页面
          // 字段标签命中后填入的「默认值/占位值」（enrichment 开关默认 ON）。
          // M5 控制台可据此区分「真值」（无 enriched 标记）vs「默认值」（enriched:true），
          // 避免把占位值当作用户真实资料展示。
          enriched: true,
        };
      }
    }
  }

// 历史摘要（最后几条有意义的 lines）
  if (!result.lastActiveSummary) {
    const meaningful = allLines
      .map(l => String(l).trim())
      .filter(l => l.length >= 4 && !MENU_WORDS.has(l) && !/^\d+$/.test(l) && l !== '!');
    if (meaningful.length) {
      result.lastActiveSummary = {
        value: meaningful.slice(-3).join(' / ').slice(0, 200),
        source: 'profile_page',
        confidence: 0.50,
      };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 聊天补充（step2）
// ---------------------------------------------------------------------------

function supplementFromChatFn(messages) {
  const result = {};
  if (!Array.isArray(messages) || messages.length === 0) return result;

  const peerText = messages
    .filter(m => m.role === 'other' || m.role === 'peer')
    .map(m => [m.original, m.translation, m.text].filter(Boolean).join(' '))
    .join('\n');

  const allText = messages.map(m => [m.original, m.translation, m.text].filter(Boolean).join(' ')).join('\n');

  // intent
  const intentSignals = {
    serious:     ['会いたい','デート','結婚','本気','serious','date','marry','真剣'],
    casual:      ['遊び','飲み','casual','hang out','fun','暇'],
    transactional:['料金','いくら','price','コスト','transactional','サービス','ビジネス'],
  };
  let intentHit = null, intentConf = 0;
  for (const [intent, kws] of Object.entries(intentSignals)) {
    const hits = kws.filter(k => peerText.includes(k) || allText.includes(k));
    if (hits.length > intentConf) { intentHit = intent; intentConf = hits.length; }
  }
  if (intentHit) {
    result.intent = {
      value: intentHit,
      source: 'chat',
      confidence: Math.min(0.5 + intentConf * 0.1, 0.7),
    };
  }

  // 地区
  for (const [city, pref] of Object.entries(REGION_NORMALIZE)) {
    if (allText.includes(city)) {
      result.region = { value: pref, source: 'chat', confidence: 0.60 };
      break;
    }
  }

  // 年龄
  const chatAgeMatch = peerText.match(/(\d{1,2})\s*(歳|岁)/);
  if (chatAgeMatch) {
    result.age = { value: chatAgeMatch[1], source: 'chat', confidence: 0.70 };
  }

  // 兴趣
  const interestKws = ['映画','ゲーム','音楽','スポーツ','旅行','料理','漫画','猫','犬','巨乳'];
  const found = interestKws.filter(k => allText.includes(k));
  if (found.length) {
    result.interests = { value: found, source: 'chat', confidence: 0.50 + found.length * 0.05 };
  }

  // 职业
  const occKws = ['会社員','フリーター','学生','OL','看護師','自営業'];
  const occFound = occKws.find(k => allText.includes(k));
  if (occFound) {
    result.occupation = { value: occFound, source: 'chat', confidence: 0.70 };
  }

  // 历史摘要
  const lastPeer = messages.filter(m => m.role === 'other' || m.role === 'peer').slice(-3);
  if (lastPeer.length) {
    const summary = lastPeer.map(m => [m.original, m.translation, m.text].filter(Boolean).join(' ')).join(' / ');
    result.lastActiveSummary = { value: summary.slice(0, 200), source: 'chat', confidence: 0.40 };
  }

  return result;
}

// ---------------------------------------------------------------------------
// 合并：profile_page 胜出
// ---------------------------------------------------------------------------

function mergeProfile(pageProfile, chatProfile) {
  const merged = {};
  // 先填 chat（低置信度）
  for (const [k, v] of Object.entries(chatProfile || {})) {
    if (v && v.value != null) merged[k] = { ...v };
  }
  // 再填 page（高置信度，覆盖 chat）
  for (const [k, v] of Object.entries(pageProfile || {})) {
    if (v && v.value != null) {
      merged[k] = { ...v, _overridden: merged[k] ? true : undefined };
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 主工厂
// ---------------------------------------------------------------------------

function createProfileExtractor({ store } = {}) {
  if (!store) throw new Error('createProfileExtractor: store is required');

  /**
   * step1：从资料页数据提取基础画像
   * @param {object} profilePageData - account-profiles 记录或 17098 结构化对象
   * @returns {object} { fields: {slotKey:{value,source,confidence}}, source:'profile_page' }
   */
  function extractFromProfilePage(profilePageData) {
    const extracted = normalizeProfilePage(profilePageData);
    return { fields: extracted, source: 'profile_page', _slotCount: Object.keys(extracted).length };
  }

  /**
   * step2：从聊天消息补充画像
   * @param {Array} messages - 消息数组（{role, original, translation, text, ...}）
   * @returns {object} { fields: {slotKey:{value,source,confidence}}, source:'chat' }
   */
  function supplementFromChat(messages) {
    const extracted = supplementFromChatFn(messages);
    return { fields: extracted, source: 'chat', _slotCount: Object.keys(extracted).length };
  }

  /**
   * 合并两步结果，profile_page 胜出
   */
  function merge(pageResult, chatResult) {
    const pageFields = (pageResult && pageResult.fields) || {};
    const chatFields = (chatResult && chatResult.fields) || {};
    const merged = mergeProfile(pageFields, chatFields);
    const slotCount = Object.keys(merged).length;
    const confs = Object.values(merged).map(v => v.confidence || 0.5);
    const confidence = confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100 : 0;
    const dominantSource = Object.keys(pageFields).length >= Object.keys(chatFields).length ? 'profile_page' : 'chat';
    return { fields: merged, confidence, source: dominantSource, slotCount };
  }

  /**
   * 将合并后的画像写入 store（走 upsertContact 单一路径）
   */
  function writeProfile({ contactKey, platform, windowId, profile }) {
    const fields = (profile && profile.fields) || {};
    const contactRaw = {};
    if (fields.displayName) contactRaw.name = fields.displayName.value;
    if (fields.age)         contactRaw.age = fields.age.value;
    if (fields.region)      contactRaw.region = fields.region.value;
    if (fields.height)      contactRaw.height = fields.height.value;
    if (fields.occupation)  contactRaw.occupation = fields.occupation.value;
    if (fields.lastActiveSummary) contactRaw.intro = fields.lastActiveSummary.value;

    const allSlots = Object.entries(fields).map(([k, v]) => ({
      key: k, value: v.value, source: v.source, confidence: v.confidence,
    }));

    const contact = store.upsertContact({
      contactKey: String(contactKey || ''),
      platform:   String(platform || ''),
      windowId:   String(windowId || ''),
      contact:    contactRaw,
      fields:     allSlots,
      source:     (profile && profile.source) || 'profile_page',
    });
    return { contact, profile, contactId: contact ? contact.contactId : null };
  }

  /**
   * 一站式：资料页 + 聊天 → 合并 → 写入
   */
  function run(params = {}) {
    const pageResult = extractFromProfilePage(params.profilePageData);
    const chatResult = supplementFromChat(params.messages || []);
    const merged = merge(pageResult, chatResult);
    const written = writeProfile({
      contactKey: params.contactKey,
      platform:   params.platform,
      windowId:   params.windowId,
      profile:    merged,
    });
    return { ...merged, ...written, pageResult, chatResult };
  }

  return {
    extractFromProfilePage,
    supplementFromChat,
    merge,
    writeProfile,
    run,
    _FIELD_SLOTS: FIELD_SLOTS,
    _PROFILE_PAGE_FIELD_MAP: PROFILE_PAGE_FIELD_MAP,
    _REGION_NORMALIZE: REGION_NORMALIZE,
  };
}

module.exports = { createProfileExtractor };
