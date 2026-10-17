// 第一刀 · state.js（全局状态 + 常量，复制自 ichigo-console.html L765-799）
'use strict';

export const API = {
  mailbox:   '/api/console/mailbox',
  list:      '/api/console/live/customers',
  detail:    '/api/console/live/customer',
  refresh:   '/api/console/live/customer/refresh',
  translate: '/api/console/translate',
  accountRefresh: '/api/console/account/refresh',
  model:     '/api/console/model-status',
  models:    '/api/console/models',
  mCreate:   '/api/console/models/create',
  mUpdate:   '/api/console/models/update',
  mDelete:   '/api/console/models/delete',
  mActivate: '/api/console/models/activate',
  mTest:     '/api/console/models/test',
  sendLive:  '/api/console/send-live'
};

export const POLL_MS = 1800000; // 30 分钟轮询一次

export const state = { contacts: [], details: {}, selectedId: null, unread: 0, lastPollAt: null, currentView: null, qtDir: 'ja2zh' };

export const QT_LANG = {
  'ja2zh': { from: 'ja', to: 'zh-CN', fromName: '日语', toName: '简体中文' },
  'zh2ja': { from: 'zh-CN', to: 'ja', fromName: '简体中文', toName: '日语' }
};

export const ONLINE = {
  online: { cls: 'od-online', tip: '在线（1小时内）' },
  recent: { cls: 'od-recent', tip: '最近在线（24小时内）' },
  away:   { cls: 'od-away',   tip: '有段时间没在线' },
  long:   { cls: 'od-long',   tip: '很久没上线' }
};

export const FIELD_ZH = {
  birthplace: { '東京': '东京', '埼玉': '埼玉', '神奈川': '神奈川', '千葉': '千叶', '大阪': '大阪', '愛知': '爱知', '北海道': '北海道', '福岡': '福冈' },
  marital: { '未婚': '未婚', '既婚': '已婚', '離婚': '离异', '死別': '丧偶' },
  children: { 'いない': '没有', 'いる': '有' },
  occupation: { '会社員': '公司职员', 'サービス業': '服务业', '自営業': '个体经营', '公務員': '公务员', '医療関係': '医疗', '学生': '学生', '主婦': '主妇', '無職': '无业' },
  carrier: { 'スマートフォン': '智能手机', 'ガラケー': '功能机', 'その他': '其他' },
  build: { '普通': '普通', 'ややぽっちゃり': '微胖', 'ぽっちゃり': '偏胖', 'スリム': '苗条', 'やせ型': '偏瘦', '筋肉質': '肌肉型' },
  type: { 'さわやか系': '清爽型', 'その他': '其他', 'いやし系': '治愈系' },
  eyes: { '二重': '双眼皮', '一重': '单眼皮' },
  dateWant: { '相手に合わせる': '配合对方', 'その他': '其他' },
  meetingIntent: { '目的が合えば会いたい': '目标合得来就想见', 'デートしたい': '想约会', '大人の関係': '成人关系' },
  smoking: { '吸わない': '不吸烟', 'ときどき吸う': '偶尔抽', '吸う': '吸烟' },
  drinking: { '飲まない': '不饮酒', 'ときどき飲む': '偶尔喝', '飲む': '饮酒' },
  car: { 'あり': '有车', 'なし': '没车' },
  zodiac: { 'おひつじ座': '白羊座', 'おうし座': '金牛座', 'ふたご座': '双子座', 'かに座': '巨蟹座', 'しし座': '狮子座', 'おとめ座': '处女座', 'てんびん座': '天秤座', 'さそり座': '天蝎座' }
};
