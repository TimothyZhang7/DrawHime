# drawing-service

绘图任务接收服务。它接收 backend 或 bot-service 提交的任务，写入调度子任务，并投递 drawing-worker。

## 端口

`DRAWING_PORT=3005`

## 入口

- `src/main.ts`
- `src/app/drawing-service-app.ts`

## 模块

- `drawing-api`
- `site-info`

## 命令

```bash
pnpm --prefix apps/drawing-service run dev
pnpm --prefix apps/drawing-service run type-check
pnpm --prefix apps/drawing-service run build
```

## 不负责

- 不创建主任务。
- 不扣减余额。
- 不保存最终业务记录。
