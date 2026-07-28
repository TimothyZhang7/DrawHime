# bot-service

Bot 命令服务。接收 wsproxy 投递的 OneBot 事件，解析命令，调用 backend、drawing-service、wsproxy-service 和 bot-renderer。

## 端口

`BOT_PORT=3004`

## 入口

- `src/main.ts`
- `src/app/bot-service-app.ts`

## 模块

- `wsproxy-client`

## 命令

```bash
pnpm --prefix apps/bot-service run dev
pnpm --prefix apps/bot-service run type-check
pnpm --prefix apps/bot-service run build
```

## 维护重点

`wsproxy-event-service.ts` 当前过长，后续应拆分命令解析、任务轮询、通知发送和状态缓存。
