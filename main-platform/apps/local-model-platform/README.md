# local-model-platform

独立本地模型平台，和主绘图业务链路分离。
当前已具备真实模型注册、资产扫描、配置保存、用户端概览和管理端配置编辑。

## 目录

- `backend/` 服务端，端口 `3017`
- `web/` 用户端，端口 `5187`
- `admin/` 管理端，端口 `5188`
- `worker/` 任务端骨架
- `shared/` 平台内部共享类型和常量

## 当前能力

- 读取真实配置文件 `local/private/local-model-platform-config.json`
- 扫描真实模型目录
- 兼容 `models/` 根目录和外层再包一层 `models` 的两种落盘方式
- 返回首批真实模型注册清单
- 用户端展示概览
- 管理端编辑扫描根目录和目录映射

## 入口

- `backend/src/main.ts`
- `backend/src/app/local-model-platform-app.ts`
- `backend/src/modules/platform/platform-routes.ts`
- `shared/src/index.ts`
- `web/src/main.tsx`
- `web/src/app/App.tsx`
- `admin/src/main.tsx`
- `admin/src/app/App.tsx`
- `worker/src/main.ts`

## 常用命令

```bash
pnpm --prefix apps/local-model-platform/shared run type-check
pnpm --prefix apps/local-model-platform/backend run type-check
pnpm --prefix apps/local-model-platform/web run type-check
pnpm --prefix apps/local-model-platform/admin run type-check
pnpm --prefix apps/local-model-platform/worker run type-check
```

## 启动

```bash
pnpm --prefix apps/local-model-platform/backend run dev
pnpm --prefix apps/local-model-platform/web run dev
pnpm --prefix apps/local-model-platform/admin run dev
pnpm --prefix apps/local-model-platform/worker run dev
```

## 注意

- 不下载任何模型文件。
- 不接管钱包、图库或 QQ 绑定。
- 配置只写入 `local/private/`。
- 首批模型注册数据见 `packages/shared-contracts/src/local-model/local-model-registry.ts`。
