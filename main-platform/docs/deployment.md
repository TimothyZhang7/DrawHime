# 通用部署说明

## 前置条件

- Node.js 22 与 pnpm 10；
- MariaDB、Redis 和可选的 S3 兼容对象存储；
- PM2 或等价进程管理器；
- Nginx/OpenResty 反向代理；
- 仅部署机可读的 SSH 密钥和环境文件。

## 私有配置

从 `configs/env.example` 创建私有环境文件，并至少配置：

```text
DATABASE_URL=mysql://<user>:<password>@<host>:3306/aiimagev3
REDIS_URL=redis://:<password>@<host>:6379
JWT_SECRET=<random-32-bytes>
WS_PROXY_TOKEN=<random-32-bytes>
APP_BASE_URL=https://<web-domain>
PUBLIC_MEDIA_BASE_URL=https://<web-domain>
```

真实配置不得提交到 Git。生产 PM2 配置与 Backend 环境文件应在发布时保留，不从源码包覆盖。

## 构建流程

```bash
pnpm install --frozen-lockfile
pnpm --prefix apps/backend run db:generate
pnpm run build:packages
pnpm run type-check
pnpm run deploy:build
```

数据库结构变更使用 `apps/backend/prisma/migrations` 中的可审计迁移；生产环境不得使用 `prisma db push`。

## 服务启动

复制 `ecosystem.config.example.js` 为私有 `ecosystem.config.js`，写入真实环境变量后启动：

```bash
pm2 start ecosystem.config.js
pm2 save
```

默认健康端口：

| 服务 | 端口 |
|---|---:|
| backend | 6369 |
| drawing-service | 3005 |
| bot-service | 3004 |
| wsproxy-service | 3011 |
| drawing-worker | 3012 |
| media-service | 3013 |
| bot-renderer | 3014 |
| notification-worker | 3015 |
| ops-worker | 3016 |

## 发布与回滚

1. 备份受影响服务源码、构建产物和私有配置；数据库变更额外备份相关表。
2. 上传只包含 Git 跟踪文件的源码包，排除依赖、构建产物、环境文件、媒体和备份。
3. 安装依赖、执行迁移、构建受影响程序。
4. 使用完整私有 PM2 配置重启目标服务。
5. 验证各服务 `/health`、Backend `/health/db` 与前端公开地址。
6. 验证失败时恢复备份并重新执行健康检查。

快速部署脚本要求显式设置 `AIIMAGE_DEPLOY_HOST` 或传入 `--host`，不会使用仓库内置生产地址：

```powershell
node scripts/quick-deploy.mjs --target backend --host root@HOST --dry-run
node scripts/quick-deploy.mjs --changed --host root@HOST --dry-run
node scripts/quick-deploy.mjs --target source --host root@HOST
```

`--changed` 根据 Git 已跟踪改动选择最小服务或前端；`source` 仅同步部署工具、规范和文档。普通 app 变化只构建并重启对应端点，共享包、锁文件或全局构建配置变化会保守选择全部真实依赖端点。
