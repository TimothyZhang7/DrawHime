# 本地开发

## 环境

- Node.js 22+
- pnpm 10.14+
- Docker Desktop 或兼容 Docker Engine

## 初始化

```powershell
Copy-Item configs/env.example .env
pnpm install
docker compose up -d mariadb redis minio minio-init
pnpm run db:generate
pnpm run db:migrate:dev
```

首次启动时 `minio-init` 会幂等创建 `drawhime-local` Bucket；不会覆盖已有对象。

## 验证

```powershell
pnpm run db:validate
pnpm run type-check
pnpm run test
pnpm run build
```

根目录 `pnpm run dev` 会并行启动八个程序。用户端访问 `http://127.0.0.1:7100`，管理端访问 `http://127.0.0.1:7101`。

## 第一阶段端点验证

```powershell
Invoke-RestMethod http://127.0.0.1:7102/health
Invoke-WebRequest http://127.0.0.1:7102/ready -SkipHttpErrorCheck
Invoke-RestMethod http://127.0.0.1:7102/v1/system/overview
Invoke-WebRequest http://127.0.0.1:7110/ready -SkipHttpErrorCheck
```

`/ready` 的 HTTP `503` 表示清单中的真实依赖尚未接通，不影响 `/health` 对进程存活的判断。

生产环境使用 `docker-compose.production.yml`，数据库、Redis 与 MinIO 只监听回环地址。首次部署必须在 `/local-platform/.env` 写入随机凭证，再执行迁移；`scripts/install-production-nginx-paths.mjs` 会备份并幂等更新 1Panel OpenResty 站点配置。

只修改用户前端时使用静态产物快速部署：

```powershell
node scripts/deploy-production.mjs --target web --dry-run
node scripts/deploy-production.mjs --target web
```

该模式只在本地检查并构建 `@drawhime/web`，上传 `apps/web/dist` 后备份并发布用户端静态目录；旧指纹资源会暂时保留，避免边缘缓存中的旧 HTML 引用失效。该模式不会启动基础设施、执行数据库迁移、重载 PM2、改写 OpenResty，也不会触碰余额、对象存储或 LoRA 数据。未指定 `--target` 时仍执行完整平台部署。

API、scheduler 和 worker 的 `/ready` 会真实检查配置或依赖。开发环境缺少数据库、Redis、主站或 ComfyUI 时返回 `503`，这是预期状态。

## 训练 Runtime

生产 GPU Runtime 使用 `node scripts/deploy-training-runtime.mjs` 部署。脚本固定 `sd-scripts` 修订、创建隔离 Python 环境、安装 systemd 服务并把 `7120` 限制为仅平台生产主机访问。部署前可运行 `node scripts/deploy-training-runtime.mjs --dry-run` 检查目标；服务令牌不得回显或写入仓库。
