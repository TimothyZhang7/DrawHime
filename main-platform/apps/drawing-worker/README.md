# drawing-worker

绘图执行 Worker。负责拉取或接收任务、选择站点、调用上游绘图 API、执行重试、保存图片并回写任务结果。

## 端口

`DRAWING_WORKER_PORT=3012`

## 入口

- `src/main.ts`
- `src/app/drawing-worker-app.ts`

## 模块

- `site-selection`
- `image-api`
- `retry`

## 命令

```bash
pnpm --prefix apps/drawing-worker run dev
pnpm --prefix apps/drawing-worker run type-check
pnpm --prefix apps/drawing-worker run build
```

## 注意

Worker 采用 at-least-once 思路，所有回写必须幂等。
