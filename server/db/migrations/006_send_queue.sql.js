// 006 · 卡片流全链路: SendQueue(后台串行发送队列) + OperationLog(操作审计,含快乐平台撤回)
// Node.js 内置 db.exec 支持多语句; 本批次纯 DDL, 无参数绑定
// 表与 _migration 挂 v41, 幂等(IF NOT EXISTS)
module.exports = {
  version: 41,
  apply(db) {
    db.exec('BEGIN');
    // 后台串行发送队列: card-deck 按 A~D 选话术入队, 20s±10s 浮动串行发出
    // 状态机: pending(待发出) → sending(发出中) → sent(已发出) → revoked(已撤回) / cancelled(已撤出)
    db.exec(`CREATE TABLE IF NOT EXISTS SendQueue (
      queueId TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      platform TEXT NOT NULL,          -- ichigo / happymail
      accountId TEXT NOT NULL,         -- 17098 / 18595
      contactKey TEXT,                -- 客户稳定键
      talkText TEXT NOT NULL,         -- 要发的话术(日文原文)
      talkZh TEXT,                   -- 中文译文(留痕)
      talkIntent TEXT,               -- 意图(opening/followup/deflect/meet/other)
      talkConfidence REAL,           -- 置信度
      slotSeq INTEGER,               -- 入队序号(串行序)
      scheduledAt TEXT,             -- ISO, 计划发出时刻
      dispatchAt TEXT,              -- ISO, 实际派发时刻
      sentAt TEXT,                 -- ISO, 真发成功时刻
      revokedAt TEXT,              -- ISO, 撤回时刻
      status TEXT NOT NULL DEFAULT 'pending',  -- pending/sending/sent/revoked/cancelled
      result TEXT,                 -- 发出/撤回结果(JSON)
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idxSendQueue_status ON SendQueue(status, scheduledAt)');
    db.exec('CREATE INDEX IF NOT EXISTS idxSendQueue_conv ON SendQueue(conversationId, status)');

    // 操作审计: 卡片流 2键拉黑 / 4键重生成 / 5键微调 / 撤出 / 撤回 全落库(强副作用留痕, §0.3)
    db.exec(`CREATE TABLE IF NOT EXISTS OperationLog (
      opId INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId TEXT,
      platform TEXT,
      accountId TEXT,
      opType TEXT NOT NULL,        -- block / regen / adjust / send / revoke / cancel
      detail TEXT,                 -- JSON 留痕(发给谁、发什么,铁律 0.2)
      result TEXT,                 -- ok / err
      at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idxOpLog_conv ON OperationLog(conversationId, at)');
    db.exec('COMMIT');
    return { created: ['SendQueue', 'OperationLog'] };
  }
};
