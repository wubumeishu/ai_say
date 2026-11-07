# Ai SAY · 开发工具

## 1. 全量测试

已把 `npm test` 对齐为全量测试口径，等价于 `test:all`：

```powershell
npm test
# 或
npm run test:all
```

对应命令：

```powershell
node --test tests/*.test.js server/db/*.test.js server/acquisition/*.test.js
```

## 2. ESLint

已加入低扰动起步版配置 `eslint.config.js`。本地安装依赖后：

```powershell
npm i -D eslint@9
npx eslint server tests
npx eslint . --fix
```

## 3. Prettier

已加入 `.prettierrc.json`。本地安装依赖后：

```powershell
npm i -D prettier
npx prettier --check .
npx prettier --write .
```

## 4. SQLite 查看工具

已加入 `scripts/sqlite-view.js`，无新增 npm 依赖，默认只读。

```powershell
node scripts/sqlite-view.js --list
node scripts/sqlite-view.js --table ContactProfile --limit 20
node scripts/sqlite-view.js --query "SELECT name, type FROM sqlite_master WHERE type='table' ORDER BY name"
```

## 5. VS Code

`.vscode/extensions.json` 已推荐：ESLint、Prettier、SQLite Viewer。
