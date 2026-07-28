# 文档索引

本文件是新版文档入口。旧文档已备份到 `backup/archived-docs-20260609/`。

## 固定入口

| 文档 | 用途 |
|---|---|
| [README.md](README.md) | 项目总览 |
| [AGENTS.md](AGENTS.md) | AI/维护者硬约束 |
| [TASKS.md](TASKS.md) | 当前任务状态 |
| [DEPLOY.md](DEPLOY.md) | 部署快速入口 |
| [docs/architecture.md](docs/architecture.md) | 架构、调用方向、边界 |
| [docs/services.md](docs/services.md) | 服务职责、端口、环境变量 |
| [docs/data-model.md](docs/data-model.md) | Prisma 数据模型摘要 |
| [docs/wallet-identity-design.md](docs/wallet-identity-design.md) | Web/QQ Bot 独立钱包、绑定共享、解绑和扣费设计 |
| [docs/api.md](docs/api.md) | API 分组摘要 |
| [docs/development.md](docs/development.md) | 本地开发与验证 |
| [docs/deployment.md](docs/deployment.md) | 生产部署流程 |
| [docs/backend-cache-design.md](docs/backend-cache-design.md) | backend 内部缓存、Redis、端点 TTL 和失效设计 |
| [docs/security.md](docs/security.md) | 凭证、安全、脱敏 |
| [docs/workbench-prompt-guidelines.md](docs/workbench-prompt-guidelines.md) | 工作台 Agent 绘图提示词规范 |
| [docs/image-reverse-hybrid-pipeline-design-20260726.md](docs/image-reverse-hybrid-pipeline-design-20260726.md) | 图片反推、WD14 标签证据与 Anima 混合提示词管线设计 |
| [docs/image-reverse-calibration-baseline-20260726.md](docs/image-reverse-calibration-baseline-20260726.md) | 图片反推 10 图真实链路、阈值扫描与 A/B 盲评基线 |
| [docs/local-model-standalone-platform-design-20260726.md](docs/local-model-standalone-platform-design-20260726.md) | 本地模型独立项目、账号钱包图库集成、LoRA 训练扩展与主站迁移退出设计 |
| [docs/lora-captioning-tool-design-20260728.md](docs/lora-captioning-tool-design-20260728.md) | 主站 LoRA 打标工具、独立训练集联动、自动打标、翻译与标签持久化设计 |
| [apps/local-model-platform/README.md](apps/local-model-platform/README.md) | 独立本地模型平台 |
| [docs/operations.md](docs/operations.md) | 运维检查 |
| [docs/known-issues.md](docs/known-issues.md) | 已知问题 |
| [docs/production-incident-20260622.md](docs/production-incident-20260622.md) | 2026-06-22 生产不可访问巡检记录 |
| [docs/context-handoff-20260618.md](docs/context-handoff-20260618.md) | 迁移开发环境上下文、最近部署提交、Bot 参考图和生成页拖动链路记录 |
| [docs/context-handoff-20260621.md](docs/context-handoff-20260621.md) | 迁移开发环境上下文、参考图上传加速、存储清理和当前部署基线 |
| [docs/context-handoff-20260622.md](docs/context-handoff-20260622.md) | 迁移开发环境上下文、用户公开主页、模板 AI、图库详情和最新部署基线 |
| [docs/context-handoff-20260623.md](docs/context-handoff-20260623.md) | 迁移开发环境上下文、本地存储和本地推理文件链路最新部署基线 |
| [docs/context-handoff-20260626.md](docs/context-handoff-20260626.md) | 迁移开发环境上下文、Bot 最终回复、图库多图和灯箱修复最新部署基线 |
| [docs/context-handoff-20260706.md](docs/context-handoff-20260706.md) | 迁移开发环境上下文、工作台 Agent、图片放大和手机导航最新部署基线 |
| [local/README.md](local/README.md) | 本地私有目录说明 |
| [standards/README.md](standards/README.md) | 准入规范 |
| [standards/interfaces/README.md](standards/interfaces/README.md) | 接口类型登记 |

## 任务路由

| 任务 | 必读 |
|---|---|
| 后端 API | `docs/api.md`, `docs/data-model.md`, `standards/interfaces/README.md` |
| 后端性能/缓存 | `docs/backend-cache-design.md`, `docs/api.md` |
| Prisma/数据库 | `docs/data-model.md`, `docs/security.md` |
| 余额/钱包重构 | `docs/wallet-identity-design.md`, `docs/data-model.md`, `standards/interfaces/README.md` |
| 绘图链路 | `docs/architecture.md`, `docs/services.md`, `docs/api.md` |
| Bot/wsproxy | `docs/services.md`, `docs/api.md`, `standards/interfaces/README.md` |
| 前台/后台页面 | `docs/api.md`, `docs/development.md` |
| 部署 | `DEPLOY.md`, `docs/deployment.md`, `deploy/PORTS.md` |
| 环境迁移/上下文恢复 | `docs/context-handoff-20260706.md`, `docs/context-handoff-20260626.md`, `docs/context-handoff-20260623.md`, `docs/context-handoff-20260622.md`, `docs/context-handoff-20260621.md`, `docs/context-handoff-20260618.md`, `README.md`, `AGENTS.md`, `docs/deployment.md` |
| 清理/归档 | `docs/security.md`, `docs/known-issues.md`, `local/README.md` |

## 程序索引

| 程序 | README |
|---|---|
| backend | [apps/backend/README.md](apps/backend/README.md) |
| drawing-service | [apps/drawing-service/README.md](apps/drawing-service/README.md) |
| drawing-worker | [apps/drawing-worker/README.md](apps/drawing-worker/README.md) |
| media-service | [apps/media-service/README.md](apps/media-service/README.md) |
| bot-service | [apps/bot-service/README.md](apps/bot-service/README.md) |
| bot-renderer | [apps/bot-renderer/README.md](apps/bot-renderer/README.md) |
| wsproxy-service | [apps/wsproxy-service/README.md](apps/wsproxy-service/README.md) |
| notification-worker | [apps/notification-worker/README.md](apps/notification-worker/README.md) |
| ops-worker | [apps/ops-worker/README.md](apps/ops-worker/README.md) |
| local-model-platform | [apps/local-model-platform/README.md](apps/local-model-platform/README.md) |
| web-frontend | [apps/web-frontend/README.md](apps/web-frontend/README.md) |
| admin-portal | [apps/admin-portal/README.md](apps/admin-portal/README.md) |

## 维护要求

- 新增文档时同步更新本索引。
- 新增程序时同步更新 README、services、deployment 和根 `package.json` 脚本。
- 新增接口类型时同步更新 `standards/interfaces/README.md` 和 `packages/shared-contracts`。
- 文档与代码冲突时，以源码和构建结果为准，再修正文档。
