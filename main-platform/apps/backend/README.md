# backend

核心业务 API。负责用户、认证、QQ 绑定、余额、模板、图库、充值、管理 API，以及生成任务最终状态写入。

## 端口

`BACKEND_PORT=6369`

## 入口

- `src/main.ts`
- `src/app/backend-app.ts`

## 模块

- `auth`
- `users`
- `qq-binding`
- `quota`
- `generations`
- `gallery`
- `images`
- `templates`
- `recharge`
- `admin`
- `config`
- `wsproxy-admin`

## 命令

```bash
pnpm --prefix apps/backend run dev
pnpm --prefix apps/backend run type-check
pnpm --prefix apps/backend run build
pnpm --prefix apps/backend run db:generate
```

## 注意

强一致业务写入归 backend。其他服务不得直接改用户、余额、充值和任务最终状态。
