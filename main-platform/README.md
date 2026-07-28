# DrawHime 主站平台

主站平台负责用户身份、Web 与 QQ 独立钱包、余额、图库、模板、绘图调度、上游模型调用、媒体、Bot、邮件和运维任务。各服务采用 pnpm workspace 管理，通过共享契约和受保护内部接口协作。

## 服务组成

| 程序 | 默认端口 | 职责 |
|---|---:|---|
| `backend` | 6369 | 用户、认证、钱包、图库、模板、充值和管理 API |
| `drawing-service` | 3005 | 接收绘图任务并投递 Worker |
| `drawing-worker` | 3012 | 站点选择、上游调用、重试、媒体保存和状态回写 |
| `media-service` | 3013 | 图片存储、读取和缩略图 |
| `bot-service` | 3004 | OneBot 事件、命令和通知 |
| `bot-renderer` | 3014 | Bot 卡片渲染 |
| `wsproxy-service` | 3011 | OneBot WebSocket 代理 |
| `notification-worker` | 3015 | 邮件通知 |
| `ops-worker` | 3016 | 超时修复、清理和健康采样 |
| `web-frontend` | 5173 | 用户前台 |
| `admin-portal` | 5174 | 管理后台 |

`apps/local-model-platform/` 是主站连接独立本地模型平台的前端与集成支撑源码；独立推理和训练实现位于仓库的 `../local-platform/`。

## 初始化

要求 Node.js 22、pnpm 10、MariaDB 和 Redis。

```powershell
Copy-Item configs/env.example .env
pnpm install
pnpm --prefix apps/backend run db:generate
pnpm run dev:check
pnpm run dev
```

示例配置仅用于本地开发。生产密码、JWT、服务 Token、SMTP、对象存储和上游 API Key 必须写入私有环境文件。

## 验证

```powershell
pnpm run build:packages
pnpm run type-check
pnpm run deploy:build
pnpm run seo:check
```

## 文档

- [`AI_INDEX.md`](AI_INDEX.md)：源码与文档索引。
- [`docs/architecture.md`](docs/architecture.md)：服务边界与调用方向。
- [`docs/services.md`](docs/services.md)：服务职责和端口。
- [`docs/data-model.md`](docs/data-model.md)：数据模型摘要。
- [`docs/wallet-identity-design.md`](docs/wallet-identity-design.md)：身份钱包规则。
- [`docs/api.md`](docs/api.md)：API 摘要。
- [`docs/development.md`](docs/development.md)：本地开发。
- [`docs/deployment.md`](docs/deployment.md)：通用部署流程。
- [`docs/security.md`](docs/security.md)：安全与脱敏规则。

## 数据边界

- Web 用户钱包与 QQ 钱包独立存在，绑定只共享可访问余额，不迁移或合并钱包。
- 卡密、邮箱验证 Token、密码重置 Token 和服务凭证只保存哈希或进入一次性响应。
- 钱包写入、退款和任务终态保持事务化或幂等。
- 图片先保存到本地或对象存储，再回写业务记录。
