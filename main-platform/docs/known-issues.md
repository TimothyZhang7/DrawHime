# 已知问题

## 文档与配置

- 旧文档已备份到 `../backup/archived-docs-20260609/`，新文档不再保留旧阶段叙事。
- `docker-compose.yml` 只作为本地容器开发参考，当前生产由 1Panel MariaDB/Redis、PM2 和 OpenResty 管理，未按 docker-compose 口径启动验证。
- `configs/env.example` 已脱敏为占位符，真实环境仍需私有 `.env`。
- 生产 `/v3` 已确认是 `/data/v3` 软链接；后续新增脚本仍需避免把缓存、备份或构建产物写回系统盘。

## 源码维护

- `apps/bot-service/src/modules/wsproxy-client/wsproxy-event-service.ts` 超过 600 行，后续应按命令解析、任务轮询、渲染、状态缓存拆分。
- `packages/shared-contracts` 当前导出范围少于 `standards/interfaces/README.md` 的登记范围。
- 部分服务端 app 的默认端口和历史文档曾不一致，修改端口时必须全局搜索。

## 验证缺口

- 当前源码包没有明显的统一测试目录。
- 核心链路应补充最小冒烟：注册/登录、QQ 绑定、提交任务、Worker 回写、图库展示、Bot ping。

## Geek2API Grok 参考图能力

- 2026-07-11 真实反证测试确认：`/v1/images/generations` 即使收到不存在的 `image.image_url` 仍返回 HTTP 200 成图，不能作为有效图生图端点。
- 当前 Geek2API Grok 只通过 `/v1/images/edits` multipart 支持 1 张参考图；站点必须配置 `openai_images`、`maxReferenceImages=1`、`referenceImageField=image`、`referenceImageOverflowStrategy=reject`。
- Grok 多参考图当前明确拒绝，不允许合并、截断或继续调用会忽略参考图的 generations 端点。
