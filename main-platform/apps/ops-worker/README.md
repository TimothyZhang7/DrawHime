# ops-worker

运维 Worker。负责超时任务修复、本地媒体巡检、统计快照和健康采样。

## 端口

`OPS_WORKER_PORT=3016`

## 入口

- `src/main.ts`
- `src/app/ops-worker-app.ts`

## 模块

- `stale-repair`
- `local-inference-health`
- `local-inference-stale-run-repair`

## 命令

```bash
pnpm --prefix apps/ops-worker run dev
pnpm --prefix apps/ops-worker run type-check
pnpm --prefix apps/ops-worker run build
```

## 注意

所有运维写操作必须幂等。
