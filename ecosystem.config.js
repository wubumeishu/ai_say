// =============================================================================
// Ai SAY · pm2 守护配置（task-6 · 终极蓝图 §-1.1 群控基座 / §-1.2 抗风控基石）
// 职责：crash 自重启 + 优雅退出 + 内存护栏 + 崩溃退避
// 用法：npx pm2 start ecosystem.config.js
// 日常：npx pm2 logs ai-say / npx pm2 monit / npx pm2 restart ai-say
//
// 设计原则（详见 docs/GUARDIAN.md）：
//   1. fork 模式（非 cluster）：每平台/账号 = 独立进程 + 独立端口，对齐群控基座
//      「N 账号/窗口并行」；cluster 要求端口共享，本服务不适用。
//   2. 崩溃即重启：uncaughtException 钩子（backend-lead 补）log + close SQLite +
//      exit(1)，由 pm2 按本策略拉起干净进程（抗风控基石：崩溃=回退到已知安全态）。
//   3. 退避防风暴：min_uptime + max_restarts + exp_backoff，崩溃循环 10 次后 pm2
//      判 errored 停手，交看板/watchdog 告警，不做无脑无限重启。
//   4. 内存护栏：max_memory_restart 兜底 WebSocket/窗口泄漏（AGENTS §3.9）。
//   5. 优雅退出：kill_timeout 给 SIGTERM 路径（关 server + close SQLite + 1.5s 兜底）
//      留足缓冲，超时才 kill -9。
//
// 注意：pm2 需先安装：npm i -D pm2（首次 npx 会拉取；装好后走本地 ./node_modules/.bin/pm2）。
// =============================================================================
'use strict';

module.exports = {
  apps: [
    {
      name: 'ai-say',
      script: 'server/index.js',
      cwd: __dirname,
      // fork：每账号独立进程（群控基座）。cluster 不适用（非 cluster-aware、端口不共享）。
      exec_mode: 'fork',
      instances: 1,

      // ---- 崩溃自重启策略 ----
      autorestart: true,
      // 进程须存活满 30s 才算「稳定」；短于此即计一次失败重启
      min_uptime: '30s',
      // 连续失败重启达到 10 次 → pm2 判 errored 停止自动重启（防重启风暴），交 watchdog
      max_restarts: 10,
      // 指数退避：首次 200ms，每次崩溃翻倍（200/400/800/1600…ms）
      exp_backoff_restart_delay: 200,

      // ---- 资源护栏 ----
      // CDP/WebSocket/窗口泄漏（AGENTS §3.9）兜底：堆超 512M 主动重启换新进程
      max_memory_restart: '512M',
      // 优雅退出缓冲：SIGTERM → shutdown()（关 server + close SQLite + 1.5s 兜底）
      kill_timeout: 10000,

      // ---- 运行环境（与 settings.json 解耦，群控多实例时按账号覆盖）----
      env: {
        NODE_ENV: 'production',
        PORT: '8300',
        HOST: '127.0.0.1',
        BIT_BROWSER_API_URL: 'http://127.0.0.1:54346',
        // task-10 A（GUARDIAN §4.3 双方向 guard）：不配置 = 缺省 { denyByDefault:false, list:[] }
        // = 全 log-only 起步（0 行为变化，§-1.2 稳定优先）；运营收紧时按 §4.3.4 三态配置：
        //   黑名单:  AI_SAY_REJECTION_GUARD='{"denyByDefault":false,"list":[{"match":"ECONNRESET","kind":"cdp"}]}'
        //   收紧期:  AI_SAY_REJECTION_GUARD='{"denyByDefault":true,"list":[{"match":"timeout","kind":"cdp"}]}'
        // AI_SAY_REJECTION_GUARD: '',   // 起步留空；需收紧时取消注释并填 JSON
      },

      // ---- 日志（logs/ 已进 .gitignore，不进 Git）----
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },

    // ------------------------------------------------------------------
    // 群控基座（终极蓝图 §-1.1）多账号预留：
    //   加账号 = 复制一份 app 条目，改 name + PORT + 该账号的 BIT_BROWSER_API_URL。
    //   ⚠ data 目录参数化（每账号独立 SQLite）属 backend-lead 代码改造；改造完成前
    //   多实例会共用 data/aisay.db（AGENTS §3.7 双存储债），切勿并行起多实例写同一 db。
    // 示例（data 目录参数化改造后再启用）：
    // {
    //   name: 'ai-say-ichigo-2',
    //   script: 'server/index.js',
    //   exec_mode: 'fork', instances: 1,
    //   autorestart: true, min_uptime: '30s', max_restarts: 10,
    //   exp_backoff_restart_delay: 200, max_memory_restart: '512M', kill_timeout: 10000,
    //   env: { NODE_ENV: 'production', PORT: '8301', HOST: '127.0.0.1',
    //          BIT_BROWSER_API_URL: 'http://127.0.0.1:54346' },
    //   out_file: 'logs/pm2-ichigo-2-out.log',
    //   error_file: 'logs/pm2-ichigo-2-error.log',
    // },
  ],
};
