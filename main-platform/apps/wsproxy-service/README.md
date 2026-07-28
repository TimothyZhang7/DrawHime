# wsproxy-service

OneBot WebSocket 代理服务。负责动态端点校验、OneBot 连接、事件去重、心跳和事件投递。

## 端口

`WSPROXY_PORT=3011`

## 入口

- `src/main.ts`
- `src/app/wsproxy-service-app.ts`

## 模块

- `connection`

## 命令

```bash
pnpm --prefix apps/wsproxy-service run dev
pnpm --prefix apps/wsproxy-service run type-check
pnpm --prefix apps/wsproxy-service run build
```

## 注意

动态端点 token 明文只允许在创建响应中出现一次。
