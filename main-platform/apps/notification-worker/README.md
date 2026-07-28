# notification-worker

通知 Worker。负责异步邮件通知和后续可扩展通知通道。

## 端口

`NOTIFICATION_WORKER_PORT=3015`

## 入口

- `src/main.ts`
- `src/app/notification-worker-app.ts`

## 模块

- `email`

## 命令

```bash
pnpm --prefix apps/notification-worker run dev
pnpm --prefix apps/notification-worker run type-check
pnpm --prefix apps/notification-worker run build
```

## 注意

通知失败不得影响主业务完成状态。
