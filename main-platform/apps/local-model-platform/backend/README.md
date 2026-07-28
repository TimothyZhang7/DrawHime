# local-model-platform backend

本目录承载独立本地模型平台的服务端。

这里只放后端服务实现，不再混放 web、admin、worker 和 shared 代码。

## 入口

- `src/main.ts`
- `src/app/local-model-platform-app.ts`
- `src/modules/platform/platform-routes.ts`

## 端口

`LOCAL_MODEL_PLATFORM_PORT=3017`

当前 backend 已暴露健康检查、平台状态、配置查询/保存、概览和首批模型注册清单。

## 已实现接口

- `GET /health`
- `GET /version`
- `GET /api/local-model-platform/status`
- `GET /api/local-model-platform/config`
- `PUT /api/local-model-platform/config`
- `GET /api/local-model-platform/overview`
- `GET /api/local-model-platform/registry`

## 存储规则

- 配置写入 `local/private/local-model-platform-config.json`
- 模型资产只做本地扫描，不下载、不伪造
- 目录映射支持 `models/diffusion_models` 这类相对目录
