# 本地开发

## 安装

```bash
cd <repository>/main-platform
pnpm install
```

## 环境

默认读取 `configs/env.example`。真实本地配置放在 `local/private/.env`，不要放到根目录：

```bash
cp configs/env.example local/private/.env
```

必填项：

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `WS_PROXY_TOKEN`
- `CORS_ALLOWED_ORIGINS`

`local/` 已被 `.gitignore` 忽略，可保存本机数据库、Redis、JWT、服务 token、SMTP 等私有值。

`pnpm run dev` 和 `pnpm run dev:check` 会执行 Prisma `db push --accept-data-loss`，默认只允许 `DATABASE_URL` 指向 `localhost`、`127.0.0.1` 或 `::1`。确认目标是开发库且必须使用远端数据库时，才设置 `AIIMAGE_ALLOW_REMOTE_DB_PUSH=true`。

## 初始化

```bash
pnpm run dev:check
pnpm --prefix apps/backend run db:generate
```

## 启动

```bash
pnpm run dev
```

也可以单独启动：

```bash
pnpm run dev:backend
pnpm run dev:drawing
pnpm run dev:drawing-worker
pnpm run dev:web
pnpm run dev:admin
```

## 验证

```bash
pnpm run type-check
pnpm run build
```

多图批次并发释放回归检查：

```bash
node scripts/check-batch-concurrency.mjs
```

该脚本只做内存状态机验证，不连接数据库、不创建真实任务。预期语义：后台多图并发配置为 `2`、用户提交 `N=3` 时，批次初始只释放 2 个任务；其中一个任务完成后只补齐 1 个空位，第三张才进入队列，不会一次释放超过并发上限。

前端入口检查：

- `apps/web-frontend/src/main.tsx` 必须导入 `./styles/index.css`。
- `apps/admin-portal/src/main.tsx` 必须导入 `./styles/index.css`。

## 清洁原则

不要提交或归档：

- `node_modules`
- `dist`
- `.next`
- `*.tsbuildinfo`
- 测试报告
- 日志
- 真实 `.env` 或任何私有配置
