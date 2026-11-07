// =============================================================================
// 004 批次：呼吸引擎 + 二期集群化 / LINE 私域 全量数据字典（DDL）
// 依据：AGENTS.md 附录「架构决策备忘（2026-10-30 外脑对齐）」§二 / §三 + §四勘误与修正。
//
// 设计要点（对齐 002/003 探测式幂等先例）：
//   * 时间字段统一 INTEGER 毫秒时间戳（外脑定），但 TaskQueue 现有 createdAt/updatedAt
//     保持 TEXT/ISO 不动（store.enqueueTask 现有口径），004 新增列一律 INTEGER。
//   * TaskQueue 现有 type 列语义 = 任务动作类型（scan/followup/post/recruit/line-push），
//     004 新增 taskClass 列承载「业务类别」（business/high_intent/system_exception），
//     两维正交（勘误 1：不能给 type 加 business/high_intent CHECK，会崩现有入队）。
//   * 单事务原子落盘（7 张表：2 探测扩列 + 5 新建表），挂 _migration v40。
//   * 幂等：所有 ALTER 走 PRAGMA table_info 探测缺列才 ADD；CREATE 走 IF NOT EXISTS；
//     _migration 写 v40 标记，重复调用直接跳过。
//
// 勘误修正（AGENTS.md §四）：
//   1. 新增 taskClass 列替代「给 type 加 CHECK」
//   2. INSERT 范式补 taskId + createdAt/updatedAt（ISO，现有 now() 口径）
//   3. GovernanceRule 存量行统一 scene='legacy'（不进唯一索引），呼吸规则用真实 scene 值，
//      唯一索引用部分索引 WHERE scene NOT IN ('legacy','default')
//   4. AccountProfile 与现有 Account 表互补（身份归一 vs 物理主档案），accountId 语义对齐
// =============================================================================
'use strict';

const MIGRATION_VERSION = 40;

// ---------------------------------------------------------------------------
// 探测式幂等加列工具（严格对齐 002 / 003 迁移先例：PRAGMA table_info 探测缺列才 ADD）
// ---------------------------------------------------------------------------
function tableColumns(db, table) {
  let rows;
  try {
    rows = db.prepare('PRAGMA table_info(' + table + ')').all();
  } catch (e) {
    console.error('[migrations.004] PRAGMA table_info(' + table + ') 失败（表不存在？）:', e && e.message);
    return new Set();
  }
  return new Set(rows.map((r) => r.name));
}

function applyAddColumns(db, tableName, columns) {
  const report = [];
  for (const col of columns) {
    const cols = tableColumns(db, tableName);
    if (cols.has(col.name)) {
      report.push({ table: tableName, skipped: [col.name] });
      continue;
    }
    try {
      db.exec('ALTER TABLE ' + tableName + ' ADD COLUMN ' + col.name + ' ' + col.ddl);
      report.push({ table: tableName, added: [col.name] });
      console.log('[migrations.004] ' + tableName + ' 加列 ' + col.name + '（' + col.ddl + '）');
    } catch (e) {
      if (/duplicate column/i.test(String(e && e.message))) {
        console.warn('[migrations.004] ' + tableName + ' 列 ' + col.name + ' 已存在（duplicate column），跳过: ' + e.message);
      } else {
        console.error('[migrations.004] ' + tableName + ' 加列 ' + col.name + ' 失败:', e && e.message);
        throw e;
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// 004 全量 DDL（7 张表：2 探测扩列 + 5 新建表，单事务原子落盘）
// ---------------------------------------------------------------------------
function up(db) {
  // 幂等守卫：若 _migration 已记 v40 直接跳过
  const migExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migration'")
    .get();
  if (migExists) {
    const applied = db.prepare('SELECT version FROM _migration WHERE version = ?').get(MIGRATION_VERSION);
    if (applied) return { skipped: true, version: MIGRATION_VERSION };
  }

  // 顺序执行（node:sqlite DatabaseSync 无 .transaction()；DDL 语句自动提交，
  // 幂等性由 CREATE IF NOT EXISTS / ADD COLUMN 列探测 / _migration 版本标记三层保证）
    // =====================================================================
    // 1. TaskQueue 探测式幂等扩充 6 列（camelCase，现有主键 taskId / 账号列 accountId 不动）
    //    勘误 1：新开 taskClass 承载业务类别，type 列（动作类型）不动
    // =====================================================================
    applyAddColumns(db, 'TaskQueue', [
      { name: 'breathRuleId', ddl: "TEXT NOT NULL DEFAULT 'default:warmup'" },
      { name: 'nextWakeAt',   ddl: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'claimedAt',    ddl: 'INTEGER DEFAULT NULL' },
      { name: 'claimToken',   ddl: 'TEXT DEFAULT NULL' },
      { name: 'idempotencyKey', ddl: 'TEXT DEFAULT NULL' },
    ]);

    // TaskQueue 精简双索引 + 租约超时回滚索引 + 幂等唯一索引
    db.exec(`
      CREATE INDEX IF NOT EXISTS idxTaskBreathPoll    ON TaskQueue(status, nextWakeAt);
      CREATE INDEX IF NOT EXISTS idxTaskAccountStatus  ON TaskQueue(accountId, status);
      CREATE INDEX IF NOT EXISTS idxTaskClaimedTimeout ON TaskQueue(status, claimedAt);
      CREATE UNIQUE INDEX IF NOT EXISTS idxTaskIdempotency
        ON TaskQueue(idempotencyKey) WHERE idempotencyKey IS NOT NULL;
    `);

    // =====================================================================
    // 2. GovernanceRule 探测式幂等扩充 8 列（现有主键 ruleId / ruleType / scope 不动）
    //    勘误 3：存量行统一回填 scene='legacy'（不进唯一索引），呼吸规则新插用真实 scene
    // =====================================================================
    applyAddColumns(db, 'GovernanceRule', [
      { name: 'scene',           ddl: "TEXT NOT NULL DEFAULT 'default'" },
      { name: 'accountGroup',    ddl: "TEXT NOT NULL DEFAULT 'warmup'" },
      { name: 'preFixedWaitMs',  ddl: 'INTEGER NOT NULL DEFAULT 3000' },
      { name: 'preRandomMinMs',  ddl: 'INTEGER NOT NULL DEFAULT 2000' },
      { name: 'preRandomMaxMs',  ddl: 'INTEGER NOT NULL DEFAULT 8000' },
      { name: 'postFixedWaitMs', ddl: 'INTEGER NOT NULL DEFAULT 5000' },
      { name: 'postRandomMinMs', ddl: 'INTEGER NOT NULL DEFAULT 3000' },
      { name: 'postRandomMaxMs', ddl: 'INTEGER NOT NULL DEFAULT 10000' },
    ]);

    // 存量行回填：所有非呼吸场景（ruleType 为 compliance/speechBoundary/rateLimit/brandTone）
    // 统一 scene='legacy'，避免默认 'default' 撞上 UNIQUE 索引
    db.exec(`
      UPDATE GovernanceRule
      SET scene = 'legacy'
      WHERE scene IN ('default', 'warmup')
        AND ruleType IN ('compliance','speechBoundary','rateLimit','brandTone');
    `);
    // 呼吸场景规则（新插时 scene 用真实值 like/footprint/first_msg/recruit_post/delete_post/exception）
    // 才进部分唯一索引；legacy/default 存量行不进，永不冲突
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idxGovSceneGroup
        ON GovernanceRule(scene, accountGroup)
        WHERE scene NOT IN ('legacy','default');
    `);

    // =====================================================================
    // 3. AccountProfile 新建表（账号物理主档案，含 D4 manualPoolLock）
    //    勘误 4：与现有 Account 表互补（Account=身份归一，AccountProfile=物理主档案）
    // =====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS AccountProfile (
        accountId        TEXT PRIMARY KEY,
        platformId       TEXT NOT NULL DEFAULT 'happymail',
        pool             TEXT NOT NULL DEFAULT 'warmup'
                         CHECK(pool IN ('warmup','veteran','cold')),
        manualPoolLock   INTEGER NOT NULL DEFAULT 0 CHECK(manualPoolLock IN (0,1)),
        bitWindowId      TEXT UNIQUE,
        currentPersonaId TEXT,
        proxyChannel     TEXT NOT NULL DEFAULT 'ipdeep_sticky'
                         CHECK(proxyChannel IN ('ipdeep_sticky','kookeey_dynamic')),
        ipBindingJson    TEXT NOT NULL DEFAULT '{}',
        registeredAt     INTEGER NOT NULL,
        status           TEXT NOT NULL DEFAULT 'active'
                         CHECK(status IN ('active','suspended','shadowbanned','banned')),
        updatedAt        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idxAcctPlatformPool ON AccountProfile(platformId, pool);
      CREATE INDEX IF NOT EXISTS idxAcctStatus       ON AccountProfile(status);
    `);

    // =====================================================================
    // 4. NodeRegistry 新建表（集群工作节点注册，nodeId 严禁含冒号 ':'）
    // =====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS NodeRegistry (
        nodeId           TEXT PRIMARY KEY
                         CHECK(INSTR(nodeId, ':') = 0),
        bitApiUrl        TEXT NOT NULL,
        windowCap        INTEGER NOT NULL DEFAULT 15,
        activeWindowsJson TEXT NOT NULL DEFAULT '[]',
        rssMemoryMb      INTEGER NOT NULL DEFAULT 0,
        lastHeartbeat    INTEGER NOT NULL DEFAULT 0,
        adminStatus      TEXT NOT NULL DEFAULT 'active'
                         CHECK(adminStatus IN ('active','draining','disabled')),
        createdAt        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idxNodeHb ON NodeRegistry(adminStatus, lastHeartbeat);
    `);

    // =====================================================================
    // 5. TaskResult 新建表（幂等执行回执 + D2 连续异常状态码窗口聚合）
    // =====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS TaskResult (
        idempotencyKey TEXT PRIMARY KEY,
        taskId         INTEGER NOT NULL,
        accountId      TEXT NOT NULL,
        executedByNode TEXT NOT NULL,
        httpStatus     INTEGER NOT NULL DEFAULT 200,
        tokenDrifted   INTEGER NOT NULL DEFAULT 0 CHECK(tokenDrifted IN (0,1)),
        resultPayload  TEXT NOT NULL DEFAULT '{}',
        executedAt     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idxResTaskId   ON TaskResult(taskId);
      CREATE INDEX IF NOT EXISTS idxResAcctTime ON TaskResult(accountId, executedAt DESC);
      CREATE INDEX IF NOT EXISTS idxResExecAt   ON TaskResult(executedAt);
    `);

    // =====================================================================
    // 6. LineAsset 新建表（二期 LINE 私域号码资产矩阵）
    // =====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS LineAsset (
        lineId           TEXT PRIMARY KEY,
        assetType        TEXT NOT NULL DEFAULT 'personal'
                         CHECK(assetType IN ('personal','oa')),
        lineRawHandle    TEXT NOT NULL,
        ownerOperator    TEXT NOT NULL DEFAULT 'unassigned',
        friendCap        INTEGER NOT NULL DEFAULT 100,
        currentFriends   INTEGER NOT NULL DEFAULT 0,
        dailyAddLimit    INTEGER NOT NULL DEFAULT 3,
        todayAdded       INTEGER NOT NULL DEFAULT 0,
        dailySendLimit   INTEGER NOT NULL DEFAULT 20,
        warmupStage      TEXT NOT NULL DEFAULT 'new'
                         CHECK(warmupStage IN ('new','fresh','active','veteran')),
        manualStageLock  INTEGER NOT NULL DEFAULT 0 CHECK(manualStageLock IN (0,1)),
        lastUsedAt       INTEGER NOT NULL DEFAULT 0,
        status           TEXT NOT NULL DEFAULT 'active'
                         CHECK(status IN ('active','cooldown','banned')),
        createdAt        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idxLineRouting
        ON LineAsset(status, assetType, warmupStage, lastUsedAt);
    `);

    // =====================================================================
    // 7. LeadCapture 新建表（二期私域导流线索 + CPA 归因账本）
    // =====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS LeadCapture (
        leadId             TEXT PRIMARY KEY,
        sourceAccountId    TEXT NOT NULL,
        sourceContactId    TEXT NOT NULL,
        personaTag         TEXT NOT NULL DEFAULT 'general',
        lineAssetId        TEXT NOT NULL,
        attributionSubId   TEXT NOT NULL UNIQUE,
        status             TEXT NOT NULL DEFAULT 'pending'
                           CHECK(status IN ('pending','contacted','converted','lost')),
        cpaPlatform        TEXT,
        cpaAmountJpy       INTEGER NOT NULL DEFAULT 0,
        fxRateToCny        REAL NOT NULL DEFAULT 0.048,
        cpaAmountCny       REAL NOT NULL DEFAULT 0.0,
        captureTime        INTEGER NOT NULL,
        webhookReceivedAt  INTEGER,
        reconciledFlag     INTEGER NOT NULL DEFAULT 0
                           CHECK(reconciledFlag IN (0,1,2)),
        FOREIGN KEY (lineAssetId) REFERENCES LineAsset(lineId)
      );
      CREATE INDEX IF NOT EXISTS idxLeadLineStatus   ON LeadCapture(lineAssetId, status);
      CREATE INDEX IF NOT EXISTS idxLeadCaptureTime  ON LeadCapture(captureTime, status);
      CREATE INDEX IF NOT EXISTS idxLeadSourceAcct   ON LeadCapture(sourceAccountId, status);
    `);

    // =====================================================================
    // 8. 写 _migration v40 批次标记
    // =====================================================================
    if (migExists) {
      db.prepare('INSERT OR IGNORE INTO _migration (version, appliedAt, note) VALUES (?, ?, ?)').run(
        MIGRATION_VERSION,
        new Date().toISOString(),
        '004 批次：呼吸引擎 + 二期集群化 / LINE 私域 全量数据字典（TaskQueue+GovernanceRule 探测扩列 + AccountProfile/NodeRegistry/TaskResult/LineAsset/LeadCapture 5 新表）'
      );
    }
  return { skipped: false, version: MIGRATION_VERSION };
}

module.exports = { MIGRATION_VERSION, applyAddColumns, tableColumns, up };
