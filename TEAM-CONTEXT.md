# TEAM-CONTEXT.md · 团队共享上下文（总控中心下发）

> 本文件由总控中心（Team Lead）维护，是 8 名成员的最高调度指导原则。
> 与 AGENTS.md 冲突时：AGENTS.md 的铁律优先；本文件的流程规则次之。每次任务拆解前先读本文件。

---

## 1. 项目全局定位（用户 2026-10-06 下发）

- 项目：Ai SAY —— 出会平台（sp.194964.com）运营控制台 + 智能体管理系统（Node 原生 HTTP + 原生 JS/HTML + SQLite）。
- 核心价值：高并发下代理 IP 可用性检测、自动化任务稳定调度、可视化运行状态监控。
- 技术栈：后端 Node（server/，8300 端口，唯一 npm 依赖 ws）；前端原生 JS/HTML（public/）；数据库 SQLite（data/aisay.db，双轨 JSON 待统一）。

## 2. 当前阶段与核心痛点

- 阶段：按 AGENTS.md §7 路线推进，本次立项 = Phase 3：修复 4 个假可用 bug（用户授权 B 方案选定）。
- 核心痛点：
  1. 4 个静默失效 bug：推荐回复恒空（recommender.js:294 漏传 score）、确认发送频控必 500（talkEngine.js checkGate 未传 limits）、消息监控空转（app.js onMessage 序列化丢失）、指标趋势线恒空（consoleRoutes.js:628 误用 bind 参数）。
  2. 数据库画像写入 bug：store.js INSERT OR REPLACE 清字段，需 ON CONFLICT + COALESCE（DBA 工单）。
  3. 前端 ichigo-console.html 1956 行臃肿（本次不动，Phase 4 再拆）。
  4. 测试红色 2 个（audit-view / talk-rollback，task-1 处理中，根因是 task-37 语义变更，非代码 bug）。

## 3. 团队协作最高铁律（派单强制项）

1. 安全与稳定第一：任何 DB Schema 修改或核心路由重构，必须先经 system-architect + dba 出方案，code-reviewer 确认无 Breaking Change 后方可动工。
2. 不制造黑盒：前后端修改必须有清晰中文注释；复杂逻辑由 tech-writer 同步更新 docs/（README / API.md / DEPLOY.md）。
3. 测试驱动：修复 Bug 前 qa-lead 确认测试基线（契约口径 23 文件；物理 tests/ 目录 10 文件 54 用例，基线 52 通过 2 失败，task-1 修复后必须 54 全绿）；修复后全量回归 node --test，耗时基线约 35s。
4. 继承 AGENTS.md 铁律：绝不擅自发客户消息；发送=建议→确认→执行；密钥不进 Git；改动后必须验证；排障先查被吞的 catch。
5. 测试卫生：新测试一律用 os.tmpdir()，禁止在 data/ 留测试残留 db。
6. 禁止空 catch：catch 里至少 log 模块.动作 + 错误。

## 4. 调度状态快照（总控维护）

| 工单 | 内容 | 负责人 | 状态 |
|---|---|---|---|
| task-1 | 修 2 个红色测试断言 + TMP_DB 迁 os.tmpdir() | qa-lead | in_progress（前置：backend-lead 确认 triggerGuide task-37 新语义） |
| task-2~ | Phase 3 假可用 bug 修复（待架构预研后建） | - | 待建 |

---
*维护人：Team Lead（总控中心）。任何成员发现本文件与 AGENTS.md 冲突，先上报，不得擅自改文件。*