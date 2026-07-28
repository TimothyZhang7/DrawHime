# DrawHime

DrawHime 是完整的 AI 绘图平台开源仓库，包含主站业务平台和独立本地模型平台。两个项目拥有独立数据库与运行边界，通过版本化接口共享登录、钱包和正式图库能力。

## 项目目录

| 目录 | 职责 |
|---|---|
| [`main-platform/`](main-platform/) | 用户前台、管理后台、绘图调度、上游 Worker、媒体、Bot、邮件与运维服务 |
| [`local-platform/`](local-platform/) | ComfyUI 本地推理、模型目录、LoRA 仓库、训练调度、GPU Agent 与产物管理 |

两个目录都是可独立安装、构建和部署的 pnpm workspace。请进入对应目录执行其 README 中的命令。

## 开源范围

仓库包含完整运行源码、数据库迁移、共享契约、前端资源、部署示例与开发文档。以下内容不进入 Git：

- 生产凭证、真实环境文件和私有主机地址；
- 用户数据、钱包数据、数据库备份和生成媒体；
- 模型权重、训练数据、依赖目录和构建产物；
- 一次性迁移脚本、生产事故记录、内部验收记录和历史交接材料。

## 验证

```powershell
cd main-platform
pnpm install
pnpm run type-check
pnpm run deploy:build

cd ..\local-platform
pnpm install
pnpm run type-check
pnpm run test
pnpm run build
```

## 许可证

源代码使用 [MIT License](LICENSE)。模型权重、训练数据、生成媒体和第三方依赖分别遵循其自身许可。
