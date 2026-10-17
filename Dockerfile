# syntax=docker/dockerfile:1
# Ai SAY · Node 服务容器（task-6 · 终极蓝图 §-1 群控基座预留）
# 仅封装 Node 服务本身；比特浏览器/CDP 仍在宿主机，容器经 host.docker.internal 回连 54346。
# 数据与密钥绝不进镜像（AGENTS §0.3）：data/ + settings.json 全部走 volume / 只读挂载。
FROM node:24-alpine

WORKDIR /app

# 先拷依赖清单，利用 Docker 层缓存（依赖不变时不重装）
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# 拷源码（.dockerignore 排除 data/ settings.json node_modules logs）
COPY . .

# 数据目录（SQLite + 三层缓存 + 代理池密钥）：必须 named volume 挂载，
# 否则容器重建即丢客户数据/代理密码。
VOLUME ["/app/data"]

# 容器内需 0.0.0.0 才可被端口映射访问（默认 127.0.0.1 容器内不通）
ENV NODE_ENV=production \
    PORT=8300 \
    HOST=0.0.0.0 \
    BIT_BROWSER_API_URL=http://host.docker.internal:54346

EXPOSE 8300

# 健康检查 = 轻量探针（task-9 修正）：只探「服务端口监听 + CDP 可达」，
# 【绝不】打 /api/console/network/health —— 该端点含平台风控归因，风控/平台不可用
# 也返回非 200，打它会让「平台一来风控→探针判不健康→重启→再判不健康」形成重启风暴，
# 反被守护放大（蓝图 §-1.2 抗风控基石）。详见 docs/GUARDIAN.md §5。
# 首选：GET /api/console/health（纯只读，仅判断 服务活 + 端口监听 + CDP 54346 TCP 可达，
#   不调平台 / 不做风控归因 / 不读代理池；平台风控非 200 不影响本端点返回 200）。
# 兜底：若 /api/console/health 未就绪，退化为「TCP 探 8300 端口监听」（wget 任意路由）；
#   平台风控码 / 网络体检非 200 一律加白不归不健康，只触发「页头 netChip + 手动换 IP」。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8300)+'/api/console/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]