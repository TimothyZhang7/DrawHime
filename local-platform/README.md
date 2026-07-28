# DrawHime

DrawHime 是面向本地生成模型的独立推理、LoRA 管理与训练平台。它采用 pnpm monorepo，将用户端、管理端、API、调度器、GPU Agent、推理 Worker、训练 Worker 与产物服务拆分，并通过版本化接口连接外部身份、钱包和图库系统。

## 功能

- 持久化生成任务、阶段、Runtime 尝试、计费镜像和产物审计。
- ComfyUI 推理调度、真实 GPU 心跳、模型独立采样预设和高质量 WebP 输出。
- LoRA 分片上传、隐私控制、版本发布、多 LoRA 叠加与示例图库。
- 分阶段训练流程：数据集上传、自动打标、人工确认、训练、产物校验和发布。
- 独立 MariaDB、Redis 与 S3 兼容对象存储，不复制外部系统密码或钱包数据。
- 外部身份交换、资金预留/提交/释放和正式图库发布均使用受保护的集成接口。

## 架构

| 程序 | 默认端口 | 职责 |
|---|---:|---|
| `web` | 7100 | 用户生成、任务、LoRA 与训练界面 |
| `admin` | 7101 | Runtime、GPU、任务和模型管理 |
| `api` | 7102 | 身份会话、业务 API 与集成编排 |
| `scheduler` | 7103 | 任务租约和 GPU 调度 |
| `gpu-agent` | 7110 | ComfyUI 与 GPU 状态采集 |
| `inference-worker` | 7111 | 提示增强、推理、计费和图库发布 |
| `training-worker` | 7112 | 打标、训练、退款和 LoRA 草稿闭环 |
| `artifact-service` | 7113 | 产物控制面 |

更完整的职责边界见 [`docs/architecture.md`](docs/architecture.md)，跨程序契约见 [`docs/interfaces/README.md`](docs/interfaces/README.md)，生产执行顺序与命令约束见 [`docs/operations.md`](docs/operations.md)。

## 快速开始

要求 Node.js 22、pnpm 10、Docker 与 Docker Compose。

```powershell
Copy-Item configs/env.example .env
pnpm install
docker compose up -d mariadb redis minio minio-init
pnpm run db:generate
pnpm run db:migrate:dev
pnpm run type-check
pnpm run dev
```

`configs/env.example` 只包含本地开发默认值和占位符。真实 API Key、服务令牌、主机地址和生产凭证应写入 `.env` 或 `.private/production.env`，这些路径不会进入 Git。

## 验证

```powershell
pnpm run db:validate
pnpm run type-check
pnpm run test
pnpm run build
```

## 模型

仓库登记 Anima Base、Anime Bulldozer、MiaoMiao RealSkin 与 MiaoMiao 3D Harem 的工作流预设，但不分发模型权重。使用者需要遵守各模型来源页面的许可条款，自行下载文件并校验目录中登记的 SHA-256。

生产底模同步脚本从私有 `CIVITAI_API_TOKEN` 或 `CIVITAI_API_TOKEN_FILE` 读取登录令牌，并执行断点续传、原子替换和哈希校验：

```powershell
pnpm run sync:anima-models
pnpm run sync:anima-models -- --check
```

## 部署

复制 [`configs/deployment.env.example`](configs/deployment.env.example) 到 `.private/production.env` 并填写自己的主机、Runtime 和密钥路径。部署脚本不会内置项目维护者的生产地址：

```powershell
node scripts/deploy-production.mjs --dry-run
node scripts/deploy-production.mjs

# 日常优先使用受影响端点；完整 all 只用于基础设施或跨平台变更
node scripts/deploy-production.mjs --target api --dry-run
node scripts/deploy-production.mjs --target api
node scripts/deploy-production.mjs --target web
node scripts/deploy-production.mjs --target source
node scripts/deploy-training-runtime.mjs --dry-run
```

生产凭证只保存在部署机和服务器私有环境文件中。公开示例、日志和问题报告中不要提交 `.env`、数据库备份、模型权重、用户媒体或访问令牌。

## 参与贡献

提交代码前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 和 [`SECURITY.md`](SECURITY.md)。新增跨程序请求、响应、事件或队列类型时，先更新接口登记，再将共享类型落到 contracts 包。

## 许可证

源代码以 [MIT License](LICENSE) 发布。模型权重、训练数据、生成媒体及第三方依赖分别遵循其自身许可，不因本仓库许可证而改变。
