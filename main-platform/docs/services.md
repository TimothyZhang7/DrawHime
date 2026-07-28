# 服务清单

本文件只登记当前生产仍运行的服务。工作流和本地模型推理已下线，源码入口、后台入口、部署 target 和公开路由不再开放；`/workflow`、`/api/workflows` 在 OpenResty 层返回 `404`。

## 服务端程序

| 程序 | PM2 名称 | 端口环境变量 | 默认端口 | 源码入口 | 构建入口 |
|---|---|---|---:|---|---|
| backend | `v3-backend` | `BACKEND_PORT` | 6369 | `apps/backend/src/main.ts` | `apps/backend/dist/main.js` |
| drawing-service | `v3-drawing` | `DRAWING_PORT` | 3005 | `apps/drawing-service/src/main.ts` | `apps/drawing-service/dist/main.js` |
| drawing-worker | `v3-worker` | `DRAWING_WORKER_PORT` | 3012 | `apps/drawing-worker/src/main.ts` | `apps/drawing-worker/dist/main.js` |
| media-service | `v3-media` | `MEDIA_PORT` | 3013 | `apps/media-service/src/main.ts` | `apps/media-service/dist/main.js` |
| bot-service | `v3-bot` | `BOT_PORT` | 3004 | `apps/bot-service/src/main.ts` | `apps/bot-service/dist/main.js` |
| bot-renderer | `v3-renderer` | `BOT_RENDERER_PORT` | 3014 | `apps/bot-renderer/src/main.ts` | `apps/bot-renderer/dist/main.js` |
| wsproxy-service | `v3-wsproxy` | `WSPROXY_PORT` | 3011 | `apps/wsproxy-service/src/main.ts` | `apps/wsproxy-service/dist/main.js` |
| notification-worker | `v3-notification` | `NOTIFICATION_WORKER_PORT` | 3015 | `apps/notification-worker/src/main.ts` | `apps/notification-worker/dist/main.js` |
| ops-worker | `v3-ops` | `OPS_WORKER_PORT` | 3016 | `apps/ops-worker/src/main.ts` | `apps/ops-worker/dist/main.js` |

服务端程序必须提供：

- `GET /health`
- `GET /version`

## 前端程序

前端静态文件在宿主机上复制到 `/data/1panel/www/sites/*/index`；OpenResty 容器内配置文件使用 `/www/sites/*/index` 作为 `root`。

| 程序 | 默认端口 | 生产域名 | 宿主机静态目录 | OpenResty `root` | 说明 |
|---|---:|---|---|---|---|
| web-frontend | 5173 | `https://www.xanime.ink` | `/data/1panel/www/sites/xanime.ink/index` | `/www/sites/xanime.ink/index` | 用户前台，`/` 即生成页面 |
| admin-portal | 5174 | `https://admin.xanime.ink` | `/data/1panel/www/sites/admin.xanime.ink/index` | `/www/sites/admin.xanime.ink/index` | 管理后台 |

## 内部地址

| 变量 | 用途 |
|---|---|
| `BACKEND_INTERNAL_URL` | 内部服务调用 backend |
| `DRAWING_SERVICE_URL` | backend 或 bot-service 调用 drawing-service |
| `DRAWING_WORKER_URL` | drawing-service 投递 drawing-worker |
| `MEDIA_SERVICE_URL` | worker 调用 media-service |
| `PUBLIC_MEDIA_BASE_URL` | worker 把站内参考图转换为无用户信息的公网 HTTPS URL，供 Grok 视频上游拉取 |
| `BOT_SERVICE_URL` | wsproxy-service 投递事件到 bot-service |
| `BOT_RENDERER_URL` | bot-service 调用 bot-renderer |
| `WSPROXY_SERVICE_URL` | backend/bot-service 查询 wsproxy |
| `WSPROXY_PUBLIC_WS_URL` | backend 生成给用户的 WebSocket 地址，生产为 `wss://wsbot.xanime.ink` |
| `NOTIFICATION_WORKER_URL` | backend 调用通知 worker |
| `OPS_WORKER_URL` | backend 或运维检查调用 ops-worker |

## 构建命令

```bash
pnpm run build:packages
pnpm run build:services
pnpm run build:web
pnpm run build:admin
```
