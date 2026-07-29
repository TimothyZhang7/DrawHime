# 生产运维执行规范

## 唯一标准链路

本项目默认按以下顺序完成一次代码或配置变更。任何步骤失败都停在当前步骤，修正并重跑后再继续。

1. **发现**：确认工作目录、`git status --short`、适用 `AGENTS.md`；通过 `rg --files` 定位真实文档和源码。
2. **理解**：完整阅读 API、scheduler、Worker、Runtime、数据库最终状态和主站集成链路；跨程序类型先更新 `docs/interfaces/README.md` 与 `packages/contracts`。
3. **修改**：只修改本次范围，执行 `git diff --check`，不得处理无关工作树内容。
4. **最小验证**：开发迭代只运行受影响包的 `type-check` 或测试。部署脚本会执行 `db:validate`、全仓类型检查、测试和构建，因此正式部署前不再手工重复整套命令。
5. **生产预检**：检查本地 diff、私有配置键是否齐全、生产 `/health`/`/ready`、数据库活动任务和脱敏后的 ComfyUI 队列计数；运行部署 `--dry-run`。
6. **部署**：按实际端点选择 `web`、`admin`、`api`、`scheduler`、`gpu-agent`、`inference-worker`、`training-worker` 或 `artifact-service`；只改部署工具与文档使用 `source`。只有基础设施、跨全平台配置或首次安装才使用 `all`。
7. **验收**：验证六个服务 `/health`、API `/ready`、公网用户端和 API；模型变化额外查询模型目录、最新工作流版本和实际 Runtime 节点参数。
8. **提交**：仅在部署与验收成功后，用明确路径暂存，执行暂存区 diff 检查并创建本地提交。
9. **公开同步**：把已部署源码和文档同步到 `DrawHime-public/local-platform`，先做逐文件比较，再提交、推送并核对远端 SHA。

## 速度预算与停止扩展

- 小型单端任务以 15 分钟为目标，跨主站与独立平台任务以 30 分钟为目标；预算用于约束范围，不得用于绕过失败门禁、鉴权、计费或数据安全。
- 初始发现只执行一个并行只读批次；之后只读取补丁上下文或失败目标，禁止重复全文读取未变化的规范、文档和源码。
- 一个 diff 对同一包只运行一次成功的最小检查；部署脚本会执行相同门禁时不提前重复，修复失败后只重跑失败目标及必要依赖。
- 生产验收默认只做目标健康、公网入口和一个代表性业务断言；鉴权任务追加未授权断言，数据库迁移追加迁移状态断言。
- 所有本地项目提交完成后再一次性同步公开仓库；源码逐文件比较，公开路径适配文档只修改本次片段。
- 纯文档任务直接执行 Markdown、diff、提交和公开同步，不运行构建、部署 dry-run、服务重启或生产业务回归。

## 快速命令骨架

普通单服务变更：

```powershell
git status --short
git diff --check
pnpm --filter @drawhime/<affected-package> run type-check
node scripts/deploy-production.mjs --target <affected-service> --dry-run
node scripts/deploy-production.mjs --target <affected-service>
git add -- <明确路径>
git diff --cached --check
git commit -m "<类型>: <中文摘要>"
```

只修改用户前端：

```powershell
pnpm --filter @drawhime/web run type-check
node scripts/deploy-production.mjs --target web --dry-run
node scripts/deploy-production.mjs --target web
```

文档独立修改不重启运行服务；完成链接、Markdown、diff、提交和公开同步检查即可。训练 Runtime 变化使用 `node scripts/deploy-training-runtime.mjs --dry-run` 后再正式部署，不与平台部署命令混用。

桌面应用更新先构建 NSIS，再使用私有签名目录准备并原子发布；`--dry-run` 只校验安装包、版本、契约、公钥和目标配置，不改本地清单或生产文件：

```powershell
node scripts/set-desktop-version.mjs X.Y.Z
pnpm --filter @drawhime/desktop run tauri:build
node scripts/publish-desktop-application-update.mjs prepare --installer INSTALLER.exe --version X.Y.Z --minimum-version X.Y.Z --release-notes "版本说明" --dry-run
node scripts/publish-desktop-application-update.mjs publish --installer INSTALLER.exe --version X.Y.Z --minimum-version X.Y.Z --release-notes "版本说明"
```

每台 Windows/DPI/GPU 验收主机使用同一脚本执行真实静默安装、业务数据库保留、安装目录边界、WebView2、Per-Monitor V2 和十秒启动检查；证据默认写入私有目录，不提交机器信息：

```powershell
pnpm desktop:validate-windows-host --ExpectedVersion X.Y.Z --Installer INSTALLER.exe
```

图形卸载页默认不勾选“保留模型和本地数据”，因此普通卸载会快速移出数据目录并后台清理；需要保留数据的自动化卸载必须显式传入 `/KEEPDATA`。发布工作流在一次性 Runner 上使用 `-ValidateUninstall` 依次验证保留、默认清理和恢复安装，已有业务文件的主机禁止执行该破坏性门禁。

发布脚本固定执行安装包大小/SHA-256、共享契约、Ed25519 私钥与桌面内置公钥一致性检查；生产端先上传临时文件并备份旧信封，只在资源落盘后原子切换清单，回环 API 未读到新资源时自动恢复旧信封。应用更新资源发布不重启 API，也不接触数据库、模型、LoRA、训练集、任务、媒体或钱包。

签名清单历史数据存在官方/镜像重复 URL 时，先规范化到新文件并完成签名自检，再原子替换生产信封；相同 URL 保留镜像语义，避免客户端在同一故障地址之间进行无效切换：

```powershell
pnpm desktop:resource-manifest normalize --payload OLD_PAYLOAD.json --output NEXT_PAYLOAD.json
pnpm desktop:resource-manifest add-anima-models --payload NEXT_PAYLOAD.json --output NEXT_MODELS_PAYLOAD.json
pnpm desktop:resource-manifest sign --payload NEXT_MODELS_PAYLOAD.json --private-key PRIVATE.pem --output NEXT_ENVELOPE.json --key-id KEY_ID
pnpm desktop:deploy-manifest --envelope NEXT_ENVELOPE.json --state-payload CURRENT_PAYLOAD.json --state-envelope CURRENT_ENVELOPE.json --dry-run
pnpm desktop:deploy-manifest --envelope NEXT_ENVELOPE.json --state-payload CURRENT_PAYLOAD.json --state-envelope CURRENT_ENVELOPE.json
```

`add-anima-models` 幂等补齐 Anima Base、Anime Bulldozer、MiaoMiao RealSkin 和 MiaoMiao 3D Harem。四个模型均为用户主动安装的可选资源；相同 SHA-256 的 Qwen 文本编码器和 VAE 在多个模型组合间复用本机文件，不重复下载或占用磁盘。发布前必须确认主文件已进入 `DESKTOP_RESOURCE_STORAGE_ROOT`，或存在可由 API 严格代理的签名官方来源。

可选目标：`web`、`admin`、`api`、`scheduler`、`gpu-agent`、`inference-worker`、`training-worker`、`artifact-service`、`source`、`all`。单服务目标只上传共享包与对应 app，只构建和重启该 PM2 进程；`api` 额外执行 Prisma 生成、生产迁移和标签种子，其他服务不触碰数据库。前端目标直接上传本机构建产物，不在生产机安装依赖。

## 生产队列规则

- 查询独立数据库中的 `READY/RUNNING` 数量和 ComfyUI `running/pending` 数量，禁止输出完整队列对象。
- 部署会重载 Worker 前，应优先等待正在执行的不可中断任务完成；等待必须设置总截止时间。
- 生产已有用户队列时，不提交会插队的合成测试。使用真实任务审计、动态工作流构建测试和脱敏参数核验完成验收。
- 必须执行生成实测时，测试任务进入正常调度和计费链路，或者在明确的维护窗口使用不抢占用户任务的测试队列。
- ComfyUI 推理与 LoRA 训练当前共享物理 GPU 1；`drawhime-gpu-arbiter` 以 ComfyUI 真实队列为准，在推理运行或等待期间向训练 Runtime 登记的进程组发送 `SIGSTOP`，队列清空后发送 `SIGCONT`。仲裁器只读取 `/data/drawhime-training/jobs/*/state.json` 中的运行中 PID，不扫描或控制其他 GPU 程序；仲裁器退出前必须恢复训练，队列接口不可达时按空闲处理，避免训练永久冻结。
- ComfyUI Anima 使用 `--cache-lru 50` 显式保留常用底模、文本编码器、VAE 与近期 LoRA 节点结果；GPU 主机具有足够系统内存，缓存用于减少底模切换时的冷加载波动，不改变采样输出。缓存变更只允许通过 `node scripts/deploy-training-runtime.mjs --comfy-cache-only` 在队列为空时重启 ComfyUI。

## 已发生错误与预防

| 错误 | 强制预防措施 |
|---|---|
| 读取仓库中不存在的部署文档 | 先运行 `rg --files docs`，只读取返回的真实路径 |
| `rg` 使用未闭合正则 | 固定文本一律使用 `rg -F`，多条件拆开执行 |
| PowerShell/SSH 引号导致远端 URL 失真 | 多行脚本经标准输入发送，远端脚本自行展开环境变量 |
| 压缩的远端 JavaScript 括号错误 | 保持多行结构；复杂查询写成可审计脚本并先检查语法 |
| 一次 ComfyUI 连接超时终止轮询 | 捕获异常并退避重试，用 `/ready`、端口和进程交叉判断 |
| 手工全仓验证后部署脚本再次验证 | 迭代只跑最小检查，完整门禁只交给部署脚本一次 |
| 查询队列时输出用户提示词 | 数据库与 Runtime 查询显式投影必要字段，不输出 prompt、图片和凭证 |
| 并行诊断因单条命令失败丢失其他输出 | 独立诊断使用 `Promise.allSettled`，允许无匹配的搜索不作为整批失败 |
| `apply_patch` 上下文不精确导致补丁失败 | 先用 `rg -n -F` 核对原文并使用最小上下文；失败后重新读取目标行再重试 |
| 公开导出 README 整文件比较被相对链接差异阻断 | 只核验本次新增片段；对公开目录必须保留的路径适配建立明确允许差异 |
| GitHub 首次推送出现 443 连接超时 | 保留本地提交，最多三次递增退避重试；成功后核对远端 SHA，连续失败才报告网络阻塞 |
| 本地执行 Prisma 校验提示缺少 `DATABASE_URL` | 校验和 Client 生成使用明确的回环开发占位连接串；不得读取或回显生产数据库凭证，部署脚本继续使用自身受控环境 |
| Windows PowerShell 继承 PowerShell 7 的 `PSModulePath` 后找不到 `Get-FileHash` | 更新辅助脚本使用 `System.Security.Cryptography.SHA256` 和文件流计算哈希，不依赖 PowerShell 模块自动加载；必须在该继承环境执行一次真实升级 |

## 失败分支

- 本地检查失败：修复源码或测试，只重跑失败的目标检查，成功后再 dry-run。
- dry-run 失败：修正私有配置、目标或连接，不上传任何文件。
- 部署失败：保留脚本输出和生产备份，修复后重新完整部署及验收；此时不创建部署提交。
- 健康检查失败：检查 PM2、依赖和 Runtime，就绪前不把 HTTP 存活当作业务成功。
- Git 提交失败：确认暂存路径和 diff，不使用全量 `git add .`，不回滚用户无关改动。

## 验收清单

- 本次目标的本地最小检查成功。
- dry-run 与正式部署成功且只影响预期目标。
- API、scheduler、GPU Agent、推理 Worker、训练 Worker、产物服务均返回健康状态。
- 必要的 readiness、数据库连接、公网页面和关键业务配置验证成功。
- 没有打印或提交生产凭证、用户提示词、媒体、模型权重和数据库内容。
- 本地部署提交只包含本次已部署文件；公开仓库内容与本地提交一致。
