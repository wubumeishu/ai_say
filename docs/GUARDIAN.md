# Ai SAY · 进程守护策略（crash 自重启 · pm2 + 容器）

> task-6 交付物（DevOps 出策略 + 配置；backend-lead 按 §4 补代码钩子）
> 依据：终极蓝图 §-1.1 群控基座 / §-1.2 抗风控基石；AGENTS §3.2（仍缺 crash 自重启 / pm2 守护 / SQLite close）
> 配套配置：[ecosystem.config.js](../ecosystem.config.js)（pm2）· [Dockerfile](../Dockerfile) + [docker-compose.example.yml](../docker-compose.example.yml)（容器重启策略）

---

## 1. 现状勘察（只读核实，2026-10-06）

| 项 | 现状 | 位置 | 缺口 |
|---|---|---|---|
| 优雅退出 | SIGTERM/SIGINT → `shutdown()`（关 server + 1.5s 兜底 `process.exit(0)`） | `server/index.js` L315-322 | ✅ 已做（task-36） |
| uncaughtException | 只 log 不重启（「已兜底，服务继续」） | `server/index.js` L18-20 | ❌ 缺 crash 自重启 |
| unhandledRejection | 只 log | `server/index.js` L21-23 | ❌ 缺（是否 fatal 见 §4.3 决议） |
| SQLite close | 无 `db.close()`，进程退出时 DatabaseSync 未显式关闭 | `server/db/store.js` L344-357（导出含 `db`） | ❌ 缺优雅/崩溃路径的 close |
| 内存账本 | `sentLog`/`gateBlockLog`/`pendingQueue` 重启清零（24h 限额可绕过） | `server/acquisition/talkEngine.js` L176-180 | ⚠ 守护重启会放大此债；落库设计见 [rate-ledger-persist.md](plan/rate-ledger-persist.md)（task-3） |
| 守护进程 | 无 pm2 / 无容器 restart / `start-console.js` 仅 detached spawn 无 watchdog | `start-console.js` | ❌ 缺守护层 |

关键事实：
- Node 24 内置 `node:sqlite`，`store.db` 是 `DatabaseSync` 实例，**`db.close()` 为同步方法**（已实测可用）；崩溃/退出路径调用它是确定性的，无异步 flush 窗口。
- `server`（http.Server）声明在 `if (isMain)` 块内（L303），**块级作用域**；顶层 L18 的 uncaughtException 钩子**看不到 `server`**。这是实现钩子的关键约束（§4.2）。
- 本项目是「单平台单账号」形态服务；终极蓝图 §-1.1 群控 = N 账号并行 = **N 个独立 Node 进程 + N 个独立端口 + N 个独立数据目录**，因此守护必须按「每账号一实例」设计，而非 cluster 端口共享。

## 2. 三层守护设计（分工与边界）

```
  第 1 层 · 进程内钩子（backend-lead 代码）
    uncaughtException / unhandledRejection → log + close SQLite + exit(1)
    SIGTERM/SIGINT                          → shutdown()（关 server + close SQLite + exit(0)）
        │  职责：崩溃时回到「已知安全态」+ 非零退出码告知外层
        ▼
  第 2 层 · 守护进程（pm2，Windows/Linux 通用）
    autorestart + min_uptime(30s) + max_restarts(10) + exp_backoff(200ms)
    + max_memory_restart(512M) + kill_timeout(10s)
        │  职责：按退避拉起干净进程；崩溃循环 10 次后判 errored 停手（防风暴）
        ▼
  第 3 层 · 容器/平台（restart: unless-stopped，群控 HA 基线）
    docker restart 策略 + 轻量健康探针（/api/console/health 仅探端口+CDP，
    不打 network/health —— 平台风控码/体检非 200 一律加白不归不健康，task-9）
        │  职责：宿主机重启 / 容器被杀后自动拉起
```

出口码契约（三层共同遵守）：
- `exit(0)` = 正常停止（SIGTERM/SIGINT 优雅退出）→ 守护层**不**计为崩溃、不触发退避重启
- `exit(1)` = 崩溃（uncaughtException/unhandledRejection）→ 守护层**按退避策略重启**
- `exit(>1)` 或被 `kill -9` = 异常 → 守护层按崩溃重启

## 3. pm2 守护配置说明（ecosystem.config.js）

关键参数与理由：

| 参数 | 值 | 理由 |
|---|---|---|
| `exec_mode` | `fork` | 每账号独立进程（群控基座）；cluster 要求应用 cluster-aware + 共享端口，本服务不适用 |
| `instances` | `1` | 当前单账号；多账号 = 加 app 条目（§6），不是 `instances: N`（那会让 N 个进程抢同一端口） |
| `autorestart` | `true` | crash 即重启 |
| `min_uptime` | `30s` | 存活满 30s 才算稳定；短于此的退出计失败重启。取 30s = 服务正常启动耗时（含 SQLite 建表 + 各模块构建）的 ~2× 余量 |
| `max_restarts` | `10` | 连续 10 次失败重启 → pm2 判 `errored` 停止重启（防重启风暴 + 留排障窗口），交看板/watchdog 告警（§7 遗留） |
| `exp_backoff_restart_delay` | `200` | 指数退避 200/400/800/1600…ms。首次快恢复，反复崩溃则间隔拉长，避免打挂宿主机 CDP |
| `max_memory_restart` | `512M` | 兜底 §3.9 WebSocket/窗口泄漏（sessions 只增不减）：堆超 512M 主动重启换新进程。可按实际基线调 |
| `kill_timeout` | `10000` | SIGTERM 后给 `shutdown()` 的「关 server + close SQLite + 1.5s 兜底」留足缓冲，超时才 SIGKILL |
| `out_file`/`error_file` | `logs/pm2-*.log` | 日志落 `logs/`（已进 .gitignore，§0.3 不进 Git） |

启动与日常命令（pm2 需先 `npm i -D pm2`）：
```bash
npx pm2 start ecosystem.config.js      # 首次启动 + 注册守护
npx pm2 start ai-say                   # 重新拉起（已注册后）
npx pm2 stop ai-say                    # 正常停（走 SIGTERM 优雅退出，exit 0）
npx pm2 restart ai-say                 # 重启（kill + 拉新，代码更新后）
npx pm2 logs ai-say --lines 100        # 看日志（排障先怀疑被吞的错误 §0.5）
npx pm2 monit                          # 实时监控（重启次数/内存/状态）
npx pm2 describe ai-say                # 看重启计数/状态（errored 一目了然）
```

## 4. uncaughtException 自动重启钩子规格（backend-lead 实现）

### 4.1 目标行为（对照 §2 出口码契约）

> **规格 = lead 总控裁决口径（task-10 终审 A 项消矛盾定稿）**：配置入口统一 =
> **env `AI_SAY_REJECTION_GUARD`（双方向 JSON：`{ denyByDefault, list:[{match:正则串, kind}] }`）**，
> **废弃 `AIsAY_CRASH_WHITELIST` / `settings.json.crashWhitelist`（拼写错 + 单方向子串，不再支持）**。
> **起步默认 = 全 log-only（缺省 `{ denyByDefault:false, list:[] }`，0 行为变化）**；
> 演进：log-only + 黑名单收紧 → 稳定期切 `denyByDefault=true` 全 fatal + 白名单（§4.3.5）。
> 钩子下沉 `if(isMain)` 块内（测试 `require` 不挂钩子）。backend-lead 按本规格落地/返工 index.js。

```js
// server/index.js · 进程级兜底（task-10 A 定稿规格 · backend-lead 落地）
// ① 崩溃日志：写 data/crash.log（时间戳 + pid + tag + stack，排障回溯 §0.5）
function _crashLog(err, tag) { /* fs.appendFileSync(data/crash.log, [ts] pid=.. tag .. stack)；try/catch 不吞 */ }

// ② 双方向 guard 配置（task-10 A · 总控裁决口径）
function _loadRejectionGuard() {
  // env AI_SAY_REJECTION_GUARD = JSON.stringify({ denyByDefault, list:[{match:正则串, kind}] })
  // 缺省 / 解析失败 → { denyByDefault: false, list: [] } = 全 log-only（起步保守态，0 行为变化）
  const raw = process.env.AI_SAY_REJECTION_GUARD;
  if (!raw) return { denyByDefault: false, list: [] };
  try {
    const p = JSON.parse(raw);
    return {
      denyByDefault: !!p.denyByDefault,
      list: Array.isArray(p.list) ? p.list.filter(x => x && typeof x.match === 'string')
              .map(x => ({ match: x.match, kind: String(x.kind || 'unknown') })) : [],
    };
  } catch (e) { console.warn('[crash-guard] AI_SAY_REJECTION_GUARD 解析失败，回退起步保守态（全 log-only）:', e && e.message); return { denyByDefault: false, list: [] }; }
}

// ③ 双方向判定：reason 是否应 fatal
//    · denyByDefault=true  → 默认全 fatal；list=白名单（命中良性特征正则 ⇒ 放行 log-only）
//    · denyByDefault=false → 默认全 log-only；list=黑名单（命中危险特征正则 ⇒ 升级 fatal）
function _shouldFatalRejection(reason) {
  const g = _loadRejectionGuard();
  const hit = g.list.some(r => { try { return new RegExp(r.match).test(String((reason && reason.message) || reason || '')); } catch (e) { return false; } });
  return g.denyByDefault ? !hit : hit;     // 命中黑名单→fatal / 命中白名单→放行
}

// ④ 钩子（注册在 if (isMain) 内；close 走 store.close() 幂等接口；【不 spawn/respawn】拉起 100% 归 pm2）
process.on('uncaughtException', function (err) {                       // 恒 fatal（无白名单概念，同步崩溃）
  console.error('[uncaughtException] crash-guard：记录后 close+exit(1)，拉起归 pm2：', (err && err.stack) || err);
  _crashLog(err, 'uncaughtException');
  try { store.close(); } catch (e) { console.error('[crash-guard] store.close 失败:', e && e.message); }
  setTimeout(function () { process.exit(1); }, 200).unref();
});
process.on('unhandledRejection', function (reason) {                   // 走双方向 guard 判定
  if (!_shouldFatalRejection(reason)) {                                // 未判 fatal（起步 log-only）⇒ 只 log 不退出
    console.warn('[unhandledRejection] guard 判 log-only（不退出，人工兜底 §-1.5；GUARDIAN §4.3）:', (reason && reason.stack) || reason);
    _crashLog(reason, 'unhandledRejection-logonly');
    return;
  }
  console.error('[unhandledRejection] crash-guard fatal：记录后 close+exit(1)，拉起归 pm2：', (reason && reason.stack) || reason);
  _crashLog(reason, 'unhandledRejection');
  try { store.close(); } catch (e) { console.error('[crash-guard] store.close 失败:', e && e.message); }
  setTimeout(function () { process.exit(1); }, 200).unref();
});
```

设计要点（逐条给 code-reviewer 核对）：
1. **fatal 而非「继续服务」**：现状 L18「已兜底，服务继续」在崩溃后继续跑 = 在未知态上继续接 CDP/写 SQLite，风险更高。抗风控基石（§-1.2）要求「崩溃 = 回退到已知安全态」，故改为 **log + close + exit(1)**，交给守护层换新进程。
2. **防重入 `_shuttingDown`**：uncaughtException 与 SIGTERM 可能并发；置位后二次崩溃直接返回，避免 `db.close()` 二次调用抛「Database is closed」。
3. **close SQLite 必须 try/catch**：崩溃时 db 可能已半损坏 / 已被 close，`db.close()` 可能 throw；不能让它再抛一次把钩子打断（否则进不到 `process.exit(1)`）。catch 里必须 log（§6 开发规范：禁止空 catch）。
4. **exit(1) 而非 exit(0)**：守护层据此识别「崩溃」走退避重启（§3 `exp_backoff_restart_delay`）。

### 4.2 关键作用域约束（实现时务必处理）

`server`（L303）声明在 `if (isMain)` 块内 = **块级作用域**；而顶层 L18 的钩子**看不到它**。
两种实现路径（二选一，推荐 A）：
- **A（推荐）**：把 `_fatalCrash` 的定义与 `process.on('uncaughtException'/'unhandledRejection')` 的注册**下沉到 `if (isMain)` 块内**（`server`、`store`、`shutdown` 都在作用域内）。删除顶层 L18-23 的旧钩子。测试路径（`require` 而非 main）不注册 fatal 钩子，保持现状（测试自建临时 server）。
- **B**：把 `let server = null` 提升到模块顶层，`if (isMain)` 内再赋值；顶层钩子保持。改动面大，不推荐。

### 4.3 unhandledRejection 双方向 guard 机制（可配置规格 · task-10 终审 A 项 · lead 总控裁决定稿）

> **统一口径（消矛盾定稿）**：配置入口 = **env `AI_SAY_REJECTION_GUARD`**（双方向 JSON：
> `{ denyByDefault: bool, list: [{ match: 正则串, kind: 标注 }] }`）；**废弃 `AIsAY_CRASH_WHITELIST`
> 与 `settings.json.crashWhitelist`（拼写错 + 单方向子串模型，不再支持）**。
> 与 `server/index.js` 落地 1:1 对齐：`_loadRejectionGuard` / `_matchesGuardList` /
> `_shouldFatalRejection`（兼容别名 `_isWhitelistedRejection`）/ 钩子注册于 `if(isMain)` 块内。

#### 4.3.1 设计决议（双方向 + 起步默认全 log-only，总控裁决）

模型 = **双方向 `denyByDefault` 开关 + 一份正则 list**，两方向语义显式定义：

| `denyByDefault` | 默认行为 | list 角色 | 判定式 |
|---|---|---|---|
| `false`（**起步默认**） | **全 log-only**（0 行为变化） | **黑名单**：命中危险特征 ⇒ 升级 fatal | `_shouldFatalRejection = 命中 list` |
| `true`（抗风控收紧期） | **全 fatal** | **白名单**：命中良性特征 ⇒ 放行 log-only | `_shouldFatalRejection = 未命中 list` |

**为何起步选「全 log-only」（lead 总控裁决，§-1.2 抗风控基石 = 稳定运行减少风控触发）**：
- 起步全 fatal 会让偶发 benign CDP reject（task-36 已通道级重连 + 2 次重试自愈过）触发
  `exit(1) → pm2 退避重启 → CDP 通道重建 → 平台检测频繁连接 = 反触发风控`，守护放大风控风险。
- 起步全 log-only = **0 行为变化**（不破坏测试基线），偶发 reject 走人工兜底（§-1.5），
  由 crash.log 积累特征谱后再收紧。
- **演进路径（§4.3.5）**：log-only + 黑名单收紧 → 稳定期切 `denyByDefault=true` 全 fatal + 白名单放行良性。
- **`uncaughtException` 恒 fatal（无白名单概念，同步崩溃无「放行继续跑」）——此条不变**。

#### 4.3.2 配置入口与识别函数特征（可配置规格，与 backend-lead 落地 1:1）

| 项 | 规格 |
|---|---|
| **配置入口（唯一）** | env `AI_SAY_REJECTION_GUARD`（JSON 字符串）；**`AIsAY_CRASH_WHITELIST` / `settings.json.crashWhitelist` 已废弃（拼写错 + 单方向），代码与文档全部移除** |
| **JSON 结构** | `{ "denyByDefault": bool, "list": [ { "match": "<正则串>", "kind": "<cdp|db|llm|net|other>" } ] }` |
| **缺省 / 解析失败** | `{ denyByDefault: false, list: [] }` = **全 log-only**（起步保守态，0 行为变化，回退安全） |
| **识别函数** | `_matchesGuardList(reason, list)`：取 `reason.message`（非 Error 则 `String(reason)`），逐条 `new RegExp(rule.match).test(msg)`（**正则命中**；单条坏正则 try/catch 返回 false，不崩钩子） |
| **判定函数** | `_shouldFatalRejection(reason)` = `guard.denyByDefault ? !命中 : 命中`（起步 `false` + 空 list = 恒 false = log-only） |
| **兼容别名** | `_isWhitelistedRejection(reason)` = 转调 `_shouldFatalRejection`（旧单测引用兼容；**语义 = 是否 fatal，非字面白名单**，index.js L81-82 注释已标明） |
| **导出（测试钩）** | `module.exports._crashGuard = { _shouldFatalRejection, _loadRejectionGuard, _crashLog, ... }`（`tests/crash-guard.test.js` require 断言；`isMain=false` 不挂钩子，测试安全） |

已知**危险种子特征**（通道级**无法**自愈、须重启才干净；起步态配进黑名单 = 升级 fatal；
**默认不预置进代码**，由运维在日志体检确认某类 reject 自愈不了后经 env 配置）：

| match 正则 | kind | 场景 | 依据 |
|---|---|---|---|
| `ECONNRESET` | cdp | CDP 连接被重置（非偶发超时；重试 2 次仍败 = 通道真断） | §3.1 isRetryable；重试耗尽后 reject |
| `SQLITE_` | db | 写库失败 / 库损坏（在坏库上继续跑风险更高） | §3.2 SQLite close 纪律 |
| `socket hang up` | cdp | CDP socket 偶发断开（通道级重连失败路径） | §3.1 task-36 残留 |

#### 4.3.3 命中 / 未命中行为表（双方向，spec 级，backend-lead 已照做落地）

| 场景 | guard 配置 | 判定结果 | 行为 | 退出码 | pm2 处理 |
|---|---|---|---|---|---|
| unhandledRejection（**起步默认**） | 缺省 `{denyByDefault:false, list:[]}` | log-only | `console.warn`（不退出，服务继续；人工兜底 §-1.5） | — | 不重启 |
| unhandledRejection | `denyByDefault:false` + 黑名单 | **命中**（如 `ECONNRESET`） | `_crashLog` + `store.close()` + exit(1) | 1 | 按 exp_backoff 退避拉起 |
| unhandledRejection | `denyByDefault:false` + 黑名单 | **未命中** | 同起步默认：log-only 不退出 | — | 不重启 |
| unhandledRejection | `denyByDefault:true` + 白名单 | **命中良性**（如 `timeout`） | log-only 不退出 | — | 不重启 |
| unhandledRejection | `denyByDefault:true` + 白名单 | **未命中** | `_crashLog` + close + exit(1) | 1 | 退避拉起 |
| uncaughtException | 任意 | 恒 fatal | `_crashLog` + `store.close()` + exit(1) | 1 | 退避拉起 |
| SIGTERM/SIGINT | 不适用 | — | `shutdown()`：close server + close SQLite + exit(0) | 0 | 不计失败重启 |

#### 4.3.4 配置示例（env `AI_SAY_REJECTION_GUARD` 三态）

```bash
# ① 起步（不配置）= 全 log-only（0 行为变化；偶发 reject 走人工兜底 + crash.log 积累谱）

# ② 起步 + 黑名单收紧（通道级无法自愈的危险特征升级 fatal）：
export AI_SAY_REJECTION_GUARD='{"denyByDefault":false,"list":[{"match":"ECONNRESET","kind":"cdp"},{"match":"SQLITE_","kind":"db"}]}'

# ③ 抗风控收紧期（稳定后切全 fatal + 白名单放行已知良性）：
export AI_SAY_REJECTION_GUARD='{"denyByDefault":true,"list":[{"match":"timeout","kind":"cdp"}]}'
```

#### 4.3.5 抗风控演进路径（对齐 §-1.2）

| 阶段 | denyByDefault | 行为 | 何时切 |
|---|---|---|---|
| 起步（task-6 上线，**总控裁决默认态**） | `false` + 空 list | **全 log-only**（0 行为变化，避免 benign CDP reject 触发重启→CDP 重建→平台风控） | 现在 |
| 运营稳定期 | `false` + 黑名单 | log-only 起步 + 危险特征（ECONNRESET/SQLITE_/socket hang up）升级 fatal | crash.log 特征谱稳定后 |
| 抗风控收紧期 | `true` + 白名单 | 默认全 fatal，白名单放行已知良性（CDP 偶发 timeout 等） | 总控评估、确认未知 reject 应一律重启时 |

> **消矛盾定稿说明（lead 总控裁决 2026-10-06）**：本文档 §4.3 曾一度写「单方向 + 默认空=全 fatal
> + `AIsAY_CRASH_WHITELIST`」，与 §9 修订记录的「`AI_SAY_REJECTION_GUARD` 双方向」自相矛盾；现统一为本节
> **双方向 + `AI_SAY_REJECTION_GUARD` + 起步全 log-only** 口径（§-1.2 抗风控基石 = 稳定运行减少风控
> 触发，起步全 fatal 会让偶发 benign reject 触发 exit(1)→pm2 退避→CDP 重建→平台检测频繁连接 = 反触发风控）。
> backend-lead 已按此口径返工 index.js（`_loadRejectionGuard`/`_matchesGuardList`/`_shouldFatalRejection` +
> 兼容别名 `_isWhitelistedRejection`）；§3.11 测试 4 红 = 旧断言未同步新语义 + task-2 双存储漂移，0 红待回归坐实。

### 4.4 与优雅退出路径（shutdown）合并：SQLite close 时机（与 backend-lead 落地 1:1）

close 统一走 **`store.close()`（幂等接口，task-6 已加到 `server/db/store.js`）**，而非直接 `store.db.close()`——幂等保证「crash 路径已 close」与「shutdown 路径再 close」不冲突（重复调用 no-op 不抛，`tests/crash-guard.test.js` 用例 1 已验证）。

```js
function shutdown() {
  console.log('[shutdown] 收到退出信号，关闭 server + SQLite（task-6：close 时序对齐 pm2 kill_timeout ≥ 2000ms）…');
  try { server.close(); } catch (e) { console.error('[shutdown] server.close 失败:', e && e.message); }
  // task-6：SIGTERM/SIGINT 前显式关 SQLite（防 -wal 残留；幂等，uncaughtException 路径已关则 no-op）
  try { store.close(); } catch (e) { console.error('[shutdown] store.close 失败:', e && e.message); }
  setTimeout(function() { process.exit(0); }, 1500).unref();
}
```
- **close 时机 = `server.close()` 之后、`process.exit` 之前**：先停接新请求（不再有新写入），再 close db 同步 flush，最后退出。顺序反了（先 close 再关 server）会在 close 后仍有在途请求写 db → 抛「Database is closed」。
- **close 走 `store.close()` 幂等接口**（封装 node:sqlite `DatabaseSync.close` 同步落盘 + 防二次 close）；保留 1.5s 兜底 exit(0) 是防 `server.close()` 等在途连接不关。
- **crash 路径（§4.1）与 shutdown 路径共享同一幂等 `store.close()`**：uncaughtException/unhandledRejection 先 close 再 exit(1)；SIGTERM/SIGINT close 再 exit(0)；二次调用 no-op（§3.2 task-6 设计）。

## 5. 容器重启策略（群控多实例预留 · 终极蓝图 §-1.1）

- **restart: `unless-stopped`**：容器崩溃 / 被杀 → 自动拉起；宿主机重启 → 自动拉起（群控 HA 基线）。主动 `docker stop` 则不起（留人工停的余地）。
- **健康检查 = 轻量探针（task-9 终审修正，task-6 终审 code-reviewer 实测提醒）**：探针**只探「服务端口监听 + CDP 可达」**，**不打 `/api/console/network/health`**：
  - **为何不打 network/health**：该端点含**平台风控归因**（风控码 / 平台不可用也返回非 200）。若健康检查打它，**平台一来风控 → 端点非 200 → 探针判不健康 → 重启容器 → 新进程同风控态再判不健康 → 重启风暴**——蓝图 §-1.2 抗风控基石反被守护放大（风控一来就杀进程，恶性循环）。
  - **探针端点（backend-lead 落地纯只读轻量端点，task-11 联调前闭环）**：`GET /api/console/health`，语义 = **仅判断「服务进程活着 + 端口监听 + CDP 54346 TCP 可达」**，**不**调平台、**不**做风控归因、**不**读代理池；任意平台风控/网络体检非 200 都**不影响**本端点返回 200。
  - **纯 TCP 兜底**：若轻量端点尚未落地，容器健康检查可先退化为「TCP 探 8300 端口监听」（`wget -q -O /dev/null http://127.0.0.1:8300/` 任意路由即证服务活着），**绝不**用 network/health 的业务归因做 liveness 判定。
  - **风控码/网络体检非 200 加白名单（不归不健康）**：`/api/console/network/health` 的「平台风控 / 平台不可用 / CDP 卡住」归因态**一律不进健康检查判定**；这些态走「页头 netChip 提示 + 手动换 IP」（AGENTS §4），**不是**容器重启的触发条件。
  - **不健康才重启 + 退避兜底**：探针只在「服务真挂（端口不监听 / 进程死）」时判不健康 → restart 策略拉起；配合 pm2 `exp_backoff`（§3）防重启风暴。**不做自动换 IP**（AGENTS §4：换太勤触发平台风控）。
- **数据/密钥隔离（§0.3 铁律）**：`data/`（SQLite + 缓存 + 代理池密钥）= named volume；`settings.json`（模型 apiKey）= 只读挂载；两者**绝不进镜像**（.dockerignore 已排除）。
- **CDP 宿主回连**：BitBrowser 在宿主机，容器经 `host.docker.internal:54346` 回连（Linux 需 `extra_hosts: host-gateway`，Windows/macOS Docker Desktop 内置）。多账号群控 = 每账号 1 容器 + 独立数据卷 + 独立端口（见 docker-compose.example.yml 注释块）。
- **多实例数据目录参数化（前置代码改造）**：当前 `dbPath` 硬编码 `__dirname/../data/aisay.db`（index.js L34）。群控多实例前，backend-lead 需把数据目录做成 env 可配（如 `AI_SAY_DATA_DIR`，缺省 `data/`），否则多容器写同一 SQLite 会撞库（§3.7 双存储债放大）。**此为群控多实例的准入条件，已在 §6 标注。**

## 6. 群控多实例预留（对齐终极蓝图 §-1.1）

| 维度 | 单实例（现形态） | 多实例（群控预留） |
|---|---|---|
| 进程模型 | 1 个 Node 进程 :8300 | N 个 Node 进程 :8300/:8301/…（pm2 N app 条目 / N 容器） |
| 数据目录 | `data/aisay.db` 单一 | 每账号独立 `data/{platform}-{account}/`（需数据目录参数化，§5 末项） |
| 三要素隔离 | 同库内按 accountId 分 | 库级物理隔离（§-1.3 人设/画像/上下文落库互不污染，多账号更彻底） |
| 代理池 | 共享 `data/proxy-pool.json` | 每账号独立池（避免 A 账号换 IP 影响 B 账号窗口） |
| 守护 | pm2 单 app / 1 容器 | pm2 N app 条目（各独立退避）/ N 容器（各独立 restart） |

> ⚠ 多实例启用前必须完成「数据目录参数化」改造；否则所有实例共用同一 db + 同一代理池，群控形态退化为「单库多窗口」，违反 §-1.1 三级嵌套隔离。

## 7. 验收标准与遗留

**验收（task-6 放行条件）**：
1. `npx pm2 start ecosystem.config.js` 后 kill 进程 → pm2 自动按退避拉起（`pm2 monit` 看 restarts 计数递增）；反复 kill 至 `max_restarts` 上限 → 状态转 `errored`（不无限重启）。
2. 触发 uncaughtException（临时在代码里 `throw`）→ 写 `data/crash.log`（`_crashLog`，时间戳+pid+stack，排障 §0.5）+ `store.close()` 被调用（幂等）+ 进程 exit(1) + pm2 按退避重启（钩子内**不 spawn/respawn**，拉起归 pm2，防 double-restart）。
3. `pm2 stop ai-say`（SIGTERM）→ `shutdown()` 路径：关 server + close SQLite + exit(0)，**不**计入失败重启。
4. `node --test` 全量不回归（钩子改造不影响 `module.exports` 导出形状；测试路径不注册 fatal 钩子）。

**验收（task-9 守护验收硬卡点 · 健康探针风控误判）**：
5. 容器/pm2 健康探针**只打 `/api/console/health`**（纯只读：服务活 + 端口监听 + CDP 54346 TCP 可达），**不打 `/api/console/network/health`**（含平台风控归因）；模拟「平台风控态（network/health 非 200）」时探针仍判健康 → **不触发重启**（防重启风暴，§-1.2）。
6. `/api/console/health` 端点落地**挂账进 backend-lead task-2 实施范围**（lead task-12 裁决：加 /api/console/inbox/unread 路由时顺带落）；规格 + 1 最小测试（os.tmpdir mock）见 §8；未落地前容器健康检查全红 = **预期态**（可先退化纯 TCP 探 8300：`wget -q -O /dev/null`），task-2 落地后即转绿；全程**不**用 network/health 归因做 liveness。
7. `ecosystem.config.js` 无健康打端点逻辑（pm2 原生无 endpoint healthcheck，靠 autorestart/max_memory_restart/kill_timeout，不探端口外端点）→ 无风控误判路径，**无需改**（核对项）。

**验收（task-10 终审 A 项 · unhandledRejection 双方向 guard 可配置，与 backend-lead 落地 1:1）**：
8. 配置入口统一 = env `AI_SAY_REJECTION_GUARD`（双方向 JSON `{denyByDefault, list:[{match 正则, kind}]}`）；`AIsAY_CRASH_WHITELIST` / `settings.json.crashWhitelist` **已废弃移除**（拼写错 + 单方向）；缺省/解析失败 = `{denyByDefault:false, list:[]}` = **全 log-only（起步 0 行为变化，§-1.2 稳定优先）**。
9. 命中/未命中行为对齐 §4.3.3 双方向行为表：`denyByDefault=false` + 命中黑名单 ⇒ fatal（close+exit(1)+pm2 退避）；未命中 ⇒ log-only；`denyByDefault=true` + 命中白名单 ⇒ log-only，未命中 ⇒ fatal；uncaughtException 恒 fatal 不受 guard 影响。
10. 匹配为**正则命中**（`new RegExp(rule.match).test(reason.message)`，与 `_matchesGuardList` 落地一致；单条坏正则 try/catch 不崩钩子）；危险种子特征（ECONNRESET/SQLITE_/socket hang up）**默认不预置**，运维经 env 配置。
11. `node --test` 全量含 `tests/crash-guard.test.js`（store.close 幂等 + uncaughtException 钩子静态 + guard 双方向判定 + 兼容别名 `_isWhitelistedRejection`）全绿；`module.exports._crashGuard` 导出供测试，`isMain=false` 不挂钩子。（注：§3.11 当前 4 红 = 本项断言未同步新语义 + task-2 漂移，0 红待回归坐实。）

**遗留 / 后续（不在 task-6 范围）**：
- pm2 判 `errored` 后的**告警通道** = Phase 4「看板」菜单（AGENTS §1.10：日志/自动化信息放看板）+ 外部 watchdog；目前靠 `pm2 describe` 人工看。
- 内存账本落库（`sentLog`/`gateBlockLog`/`pendingQueue`）= [rate-ledger-persist.md](plan/rate-ledger-persist.md)（task-3，DBA 设计已出，backend 实施中）。**守护重启会放大 §3.6 债**（重启清零 24h 限额），故 task-3 落库是「崩溃可安全重启」的配套前置。
- 数据目录参数化（§5/§6 群控多实例准入条件）= backend 代码改造，与 task-① 三级嵌套 schema 协同。
- `start-console.js`（detached spawn）现状保留作 Windows 本地快速启动；**生产/长期跑走 pm2**，两者不混用（避免双守护抢 8300 端口）。

## 8. 交付物清单

| 文件 | 类型 | 内容 |
|---|---|---|
| [ecosystem.config.js](../ecosystem.config.js) | 配置 | pm2 守护（fork + 退避 + 内存护栏 + 群控多实例预留注释） |
| [docs/GUARDIAN.md](GUARDIAN.md) | 文档 | 本策略（三层守护 + 钩子规格 + §4.3 unhandledRejection 双方向 guard 可配置（`AI_SAY_REJECTION_GUARD`，黑名单/白名单随 `denyByDefault` 切换）+ 容器重启 + 群控预留 + 验收） |
| [Dockerfile](../Dockerfile) | 构建 | Node 24-alpine 服务镜像（数据/密钥不进镜像；**task-9** 健康检查改轻量探针 `/api/console/health`，绝不打 network/health） |
| [.dockerignore](../.dockerignore) | 构建 | 排除 data/ settings.json logs/ node_modules/（§0.3） |
| [docker-compose.example.yml](../docker-compose.example.yml) | 配置 | 容器 restart: unless-stopped + **task-9** 健康检查改轻量探针 `/api/console/health`（纯 TCP 兜底）+ CDP host-gateway + 多实例群控预留注释 |
| `package.json` | 脚本 | 新增 `guard:*` + `test:all` 脚本（`npm run guard:start` 等） |
| `.gitignore` | 忽略 | 新增 `logs/`（pm2 日志不进 Git） |
| `server/index.js` 钩子 | **代码（backend-lead）** | 按 §4 实现 fatal 钩子 + §4.3 双方向 guard（`AI_SAY_REJECTION_GUARD`，起步全 log-only；`_loadRejectionGuard`/`_matchesGuardList`/`_shouldFatalRejection` + 兼容别名 `_isWhitelistedRejection`）+ shutdown 补 db.close（task-6 联调） |
| `/api/console/health` 轻量端点 | **代码（backend-lead）** | **挂账进 task-2 实施范围**（lead task-12 裁决：加 /api/console/inbox/unread 路由时顺带落，免 task-9 再等一轮）。规格 = GET → 200 `{ ok, service:'alive', port:8300, cdp:{reachable:bool, port:54346}, ts }`；纯只读（服务活 + 8300 监听 + CDP 54346 TCP 可达探测），**不调** /api/console/network/health、**不做**风控归因、**不读**代理池（风控非 200 不影响它 200，防 GUARDIAN ⑤ 重启风暴）；+ 1 最小测试（os.tmpdir，断言 200 + cdp.reachable 字段存在，mock 不真连 CDP）。**端点落地前容器健康检查全红 = 预期态**，task-2 落地后即转绿（§5 + §7 验收 5-6 + §9 task-12 行） |

> 代码钩子（§4）由 backend-lead 实施；本交付物为**策略 + 配置**，联调后一并交 code-reviewer 审。

---

## 9. 修订记录

| 日期 | task | 修订 |
|---|---|---|
| 2026-10-06 | task-6 | 初版：三层守护 + pm2/容器重启 + SQLite close + 群控预留 |
| 2026-10-06 | task-9 终审 | §5 + Dockerfile + compose 健康检查从 `network/health` 改**轻量探针 `/api/console/health`**（平台风控码/体检非 200 加白不归不健康，防重启风暴放大抗风控基石）；ecosystem.config.js 核对无打端点逻辑无需改；§7 验收补 5-7 项 |
| 2026-10-06 | task-10 终审 A 项 | §4.3 补 **unhandledRejection 白名单可配置规格**（`AI_SAY_REJECTION_GUARD` env + `denyByDefault` 双方向语义 + 起步 `denyByDefault=false` 与 backend-lead log-only 现状 0 行为变化 + 抗风控收紧演进路径）；§4.1 钩子伪代码含白名单判定；§7 验收补 8-11 项 |
| 2026-10-06 | task-10 消矛盾定稿（lead 总控裁决） | §4.3/§4.1/§7 统一为**双方向 `AI_SAY_REJECTION_GUARD` + 起步全 log-only**（`AIsAY_CRASH_WHITELIST`/`settings.json.crashWhitelist` 废弃移除，settings.example.json 还原）；§4.3.1 决议表 + §4.3.2 配置/识别函数表 + §4.3.3 双方向行为表 + §4.3.4 三态示例 + §4.3.5 演进路径重写；ecosystem.config.js env 块补 guard 注释；§7 验收 8-11 + 第 2 项同步 |
| 2026-10-06 | task-12（lead 裁决挂账） | `/api/console/health` 轻量端点落地**挂账进 backend-lead task-2 实施范围**（顺带落，免 task-9 再等一轮）；端点规格 = 200 `{ ok, service:'alive', port:8300, cdp:{reachable,port:54346}, ts }`（纯只读，不调 network/health/不做风控归因/不读代理池）+ 1 最小测试（os.tmpdir mock）；端点落地前容器健康检查全红 = 预期态；§7 第 6 项 + §8 health 行 + 交付物表同步为 task-2 挂账口径 |