# task-9 守护验收收口报告（task-6 守护正式上线 · 路线 B 三节点最后一环）

> 作者：DevOps_Lead ｜ 日期：2026-10-06 ｜ 状态：**交 code-reviewer task-9 终复审 + 总控核验**
> 配套：[GUARDIAN.md](GUARDIAN.md)（策略全集）· [ecosystem.config.js](../ecosystem.config.js) · [Dockerfile](../Dockerfile) · [docker-compose.example.yml](../docker-compose.example.yml)

---

## 0. 三前置全清确认（lead 2026-10-06 裁决收口）

| 前置 | 状态 | 核实证据 |
|---|---|---|
| ① /api/console/health 轻量端点落地 | ✅ | `server/consoleRoutes.js` L1491-1513：恒 200 `{ ok, service:'alive', port, cdp:{reachable,port}, ts }`；纯只读三不（不调 network/health / 不做风控归因 / 不读代理池）；CDP 不可达 reachable=false 仍 200；`tests/console-health.test.js` 3 用例（os.tmpdir mock 不真连） |
| ② task-3 频控账本落库 | ✅ | `server/db/schema.sql` L354/377/398 三表（SentLog/GateBlock/PendingQueue）+ 5 索引 + 活库 `_migration` v3 挂 v2；`store.js` 7 方法（archiveRateLedgers 分片归档 + loadRateLedger 24h 热账本跨重启 + 50ms 双写 + SIGTERM flushQueue）；`tests/rate-ledger.test.js` 6 用例。**pm2 频繁重启不再绕过 24h 限额**（§3.6 债闭环） |
| ③ GUARDIAN §4.3 三处矛盾消解 | ✅ | `AI_SAY_REJECTION_GUARD` 双方向 JSON（`{denyByDefault, list:[{match 正则, kind}]}`）+ 起步全 log-only（缺省 `{denyByDefault:false,list:[]}`，0 行为变化）+ uncaughtException 恒 fatal；`AIsAY_CRASH_WHITELIST` 废弃（全仓 grep 零功能残留）；backend-lead index.js 落地 1:1（`_loadRejectionGuard`/`_matchesGuardList`/`_shouldFatalRejection` + 兼容别名） |

## 1. 三层守护验收清单（进程内钩子 → pm2 → 容器）

### 1.1 第 1 层 · 进程内钩子（server/index.js，已落地）
- [x] **uncaughtException 恒 fatal**：写 `data/crash.log`（`_crashLog` 时间戳+pid+stack，排障 §0.5）→ `store.close()`（幂等）→ `exit(1)`；**不 spawn/respawn**（拉起归 pm2，防 double-restart）。
- [x] **unhandledRejection 双方向 guard**（GUARDIAN §4.3 定稿口径）：缺省全 log-only（0 行为变化）；`denyByDefault=false` + 命中黑名单 ⇒ fatal；`denyByDefault=true` + 命中白名单 ⇒ 放行；正则命中 + 坏正则 try/catch 不崩钩子。
- [x] **SIGTERM/SIGINT 优雅退出**：`shutdown()` 关 server + `store.close()`（防 -wal 残留，幂等）+ 1.5s 兜底 `exit(0)`；close 时序对齐 pm2 `kill_timeout`。
- [x] **钩子下沉 `if(isMain)`**（方案 A / code-reviewer B 项）：测试 `require` 不挂钩子，不杀测试进程；`_crashGuard` 导出供 `tests/crash-guard.test.js` 8 用例断言。

### 1.2 第 2 层 · pm2 守护（ecosystem.config.js，已交付）
| 参数 | 值 | 验收要点 |
|---|---|---|
| `exec_mode` | `fork` | 群控基座：每账号独立进程+端口（N 实例 ≠ `instances:N` 抢端口）；文件内多实例预留注释（data 目录参数化改造后启用） |
| `min_uptime` / `max_restarts` | `30s` / `10` | 崩溃循环 10 次判 `errored` 停手（防重启风暴），交看板/watchdog（Phase 4） |
| `exp_backoff_restart_delay` | `200` | 200/400/800…ms 指数退避，防打挂宿主 CDP |
| `max_memory_restart` | `512M` | 兜底 §3.9 WebSocket/窗口泄漏 |
| `kill_timeout` | `10000` | 给 `shutdown()`（关 server + close SQLite + 1.5s 兜底）留足缓冲，超时才 SIGKILL |
| `out_file`/`error_file` | `logs/pm2-*.log` | `logs/` 已进 .gitignore（§0.3） |
| 打端点逻辑 | **无** | pm2 原生无 endpoint healthcheck → **无平台风控误判路径**（GUARDIAN ⑤ 核对项，ecosystem 无需改） |

### 1.3 第 3 层 · 容器/平台（Dockerfile + docker-compose.example.yml，已交付）
- [x] **`restart: unless-stopped`**：崩溃/被杀/宿主机重启自动拉起（群控 HA 基线）；主动 stop 则不起。
- [x] **健康检查 = 轻量探针 `/api/console/health`**（GUARDIAN ⑤ task-9 修正）：只探「服务端口监听 + CDP 可达」，**绝不打 `/api/console/network/health`**（含平台风控归因，风控/平台不可用也非 200 → 打它会造成「风控一来就杀进程 → 重启 → 再风控」恶性循环，反放大 §-1.2）；平台风控码/网络体检非 200 **一律加白不归不健康**（走页头 netChip + 手动换 IP，AGENTS §4 不做定时换 IP）。
- [x] **端点落地前全红 = 预期态**（lead task-12 裁决挂账 task-2 时标注；现 ① 已落地即转绿）；纯 TCP 兜底 `wget -q -O /dev/null http://127.0.0.1:8300/`。
- [x] **数据/密钥隔离（§0.3）**：`data/` = named volume；`settings.json` = 只读挂载；`.dockerignore` 排除全部（数据密钥绝不进镜像）。
- [x] **CDP 宿主回连**：`host.docker.internal:54346`（Linux `extra_hosts: host-gateway`，Win/mac Docker Desktop 内置）；多实例群控 = N service + 独立数据卷 + 独立端口（compose 注释块预留）。

## 2. 测试与基线（本次收口实测）

- **全量 `node --test tests/*.test.js server/db/*.test.js server/acquisition/*.test.js` = 138/138 全绿（0 红，~60s，本次收口 DevOps 独立复跑坐实）**。
- 守护相关用例：`tests/crash-guard.test.js` 8（store.close 幂等 + 钩子静态 + guard 双方向判定 + 兼容别名）；`tests/console-health.test.js` 3（health 探针 200 + cdp.reachable 字段 + 不可达仍 200）；`tests/rate-ledger.test.js` 6（三账本跨重启 24h 限额 + 归档裁剪）——**路线 B 三节点测试证据链完整**。

## 3. 抗风控基石 §-1.2 闭环论证

1. **崩溃 = 回退到已知安全态**：钩子 close SQLite（幂等）+ exit(1) → pm2 退避拉起；频控账本已落库（②），重启**不**绕过 24h 限额（§3.6 闭环）→ 崩溃重启对风控姿态安全。
2. **不反触发风控**：起步全 log-only（③）避免 benign CDP reject 触发重启风暴；健康探针打轻量端点 + 风控码加白（GUARDIAN ⑤）避免「平台风控 → 误判不健康 → 杀进程 → 频繁重连 → 平台检测」恶性循环；代理池事件驱动换 IP（AGENTS §4）不变。
3. **人工兜底底线（§-1.5）**：guard log-only 路径不退出，服务继续，用户可经 netChip + 手动操作兜底。

## 4. 归 Phase 4 的遗留（不卡 task-9 收口）

| 项 | 归口 | 说明 |
|---|---|---|
| **Docker 真机镜像实测**（`docker build` + `compose` 健康检查真连 8300/54346） | **Phase 4 部署批次** | 当前 Docker Desktop pipe 未启动（构建验证待宿主可用）；配置层（Dockerfile/compose 探针指向 `/api/console/health`）已就绪，真机实测在 Phase 4 部署时执行 |
| pm2 `errored` 告警通道 | Phase 4 看板 | `pm2 describe` 人工看 → 看板自动告警（AGENTS §1.10） |
| 群控多实例启用 | data 目录参数化改造后 | `AI_SAY_DATA_DIR` env + 每账号独立 SQLite + 独立代理池（GUARDIAN §6 准入条件） |
| `AI_SAY_REJECTION_GUARD` 运营收紧（log-only → 黑名单 → 全 fatal+白名单） | 运营 1-2 周 + crash.log 谱稳定后 | GUARDIAN §4.3.5 演进路径 |

## 5. 收口结论

**task-9 守护验收收口条件全部满足，可放行 task-6 守护正式上线**：
1. 三层守护（进程内钩子 / pm2 / 容器）配置 + 代码全部就绪，出口码契约统一（exit 0=优雅 / exit 1=崩溃 / pm2 退避拉起）；
2. 健康检查打轻量探针 `/api/console/health`（已落地，①），风控码加白不归不健康（GUARDIAN ⑤ 防重启风暴）；
3. 频控账本落库（②）使崩溃重启对 24h 限额安全（§3.6 闭环）；
4. guard 双方向可配置（③）起步 0 行为变化 + 演进路径清晰；
5. 全量 138/138 全绿（本次独立复跑）；Docker 真机实测归 Phase 4 部署批次（不卡收口）。

> **请 code-reviewer task-9 终复审 + 总控核验 → task-6 守护正式上线放行（路线 B 全链路收口最后一环：守护上线 = 抗风控基石 §-1.2 的工程落地闭环）。**