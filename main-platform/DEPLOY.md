# 部署快速入口

完整流程见 [`docs/deployment.md`](docs/deployment.md)。公开源码不包含生产主机、密钥、域名证书或真实环境文件。

## 构建

```powershell
pnpm install --frozen-lockfile
pnpm --prefix apps/backend run db:generate
pnpm run build:packages
pnpm run type-check
pnpm run deploy:build
```

## 快速部署

配置私有环境变量后执行：

```powershell
$env:AIIMAGE_DEPLOY_HOST='root@HOST'
$env:AIIMAGE_DEPLOY_KEY='C:\secure\id_ed25519'
node scripts/quick-deploy.mjs --target backend --dry-run
node scripts/quick-deploy.mjs --target backend
```

部署脚本不会覆盖生产 `ecosystem.config.js`、Backend 环境文件、数据库、媒体、备份或运行日志。
