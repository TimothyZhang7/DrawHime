# DrawHime Desktop 完整设计规范

## 1. 文档目的

本文档是 DrawHime Desktop 的长期权威设计。桌面端最终必须成为可离线运行、可登录网页账号、使用用户本人电脑完成生成、打标和 LoRA 训练，并能与网站模型仓库、LoRA 仓库和图库可靠同步的 Windows 程序。

当前实现位于 `apps/desktop`。任何桌面 IPC、在线接口、Runtime 清单和数据库字段变更都应同步更新本文档、`docs/interfaces/README.md` 与 `packages/contracts`。

## 2. 产品边界

- 安装包包含 Tauri 桌面壳、本地核心和 SQLite，不包含底模、LoRA、打标模型、训练模型、PyTorch 或 ComfyUI Runtime。
- 本地生成和训练使用用户本人 GPU，不进入网页钱包计费，也不应用共享 GPU 的用户提交冷却。
- 首次联网授权和环境安装完成后，已安装的生成、打标、训练、模型管理和任务记录均可离线使用。
- 本地结果先保存和校验，再进入独立图库同步队列；网络上传不决定本地任务成功状态。
- 网页账号、正式图库、公开模型目录和私有 LoRA 权限仍由网站负责。

## 3. 支持的 Windows 范围

### 3.1 首版正式支持

| 系统 | 架构 | 支持状态 | 说明 |
|---|---|---|---|
| Windows 11 | x64 | 正式支持 | 22H2 及以后版本作为主要测试环境 |
| Windows 10 | x64 | 正式支持 | 最低 1809，推荐 22H2 |
| Windows 11 ARM64 | ARM64 | 规划支持 | 需要独立 ARM64 安装包和 Runtime 清单 |
| Windows Server | x64 | 条件支持 | 需要桌面体验、WebView2 和显卡驱动完整安装 |
| Windows 7/8/8.1 | x64 | 不纳入支持 | WebView2、驱动和依赖生态已停止可靠维护 |

程序必须读取真实系统版本和构建号。未达到支持范围时保持模型管理可用，并持续提示系统升级要求；生成和训练入口保持锁定。

### 3.2 安装依赖

- WebView2：NSIS 使用 Tauri 下载引导模式；离线安装包后续提供固定版本 WebView2 离线引导包。
- Visual C++ Runtime：安装器检测缺失后安装微软签名运行库。
- NVIDIA 驱动：根据 Runtime 清单中的最低驱动版本判断，不在客户端硬编码单一版本。
- 长路径：模型和训练目录使用长路径安全 API，界面提示过深目录风险。
- 文件系统：推荐 NTFS/ReFS；FAT32 因单文件 4GB 限制禁止作为模型和 Runtime 目录。

## 4. 总体架构

```text
React WebView
  -> Tauri IPC（每条命令登记共享契约）
    -> Desktop Core
      -> SQLite（设置、账号快照、任务、同步 outbox）
      -> 本地文件仓库（模型、LoRA、数据集、作品）
      -> Runtime Manager（环境安装、版本切换、自检、回滚）
      -> Local Scheduler（推理、训练、打标队列）
      -> Gallery Sync Worker（断点上传、权限同步、对账）
      -> Website Client（设备授权、资源目录、更新）
```

桌面核心不监听公网端口。WebView 只能调用 Tauri 白名单命令；Runtime 仅绑定回环地址并使用随机会话令牌。

## 5. 本地数据

SQLite 使用 WAL、外键和显式 schema migration。数据库至少包含：

- `desktop_settings`：主题、目录、默认隐私和上传策略。
- `desktop_accounts`：网页账号脱敏快照、设备凭证引用和最后验证时间。
- `environment_snapshots`：最近 20 次脱敏环境报告。
- `runtime_installations`：组件版本、安装状态、哈希和回滚关系。
- `local_models`、`local_loras`：稳定资源 ID、文件哈希、兼容系列和来源。
- `local_jobs`、`local_job_attempts`、`local_artifacts`：任务、尝试和产物审计。
- `training_datasets`、`training_assets`、`training_captions`：训练集与人工确认状态。
- `gallery_sync_queue`：图库上传、断点、远端 ID、隐私和错误状态。
- `software_updates`：下载、签名校验、安装和回滚状态。

图片先写临时文件，完成格式、尺寸和 SHA-256 校验后原子移动，再提交数据库终态。

## 6. 登录与离线身份

### 6.1 在线授权

1. 桌面端生成 256 位随机设备密钥和排除易混淆字符的八位用户码，服务端只保存设备密钥 SHA-256。
2. 使用系统浏览器打开同源网站设备授权页，设备密钥不进入地址栏。
3. 用户使用现有网页账号登录并核对用户码，再明确确认当前设备。
4. 桌面端按服务端间隔轮询；确认后同一随机设备密钥成为可撤销独立会话，网络响应丢失时可幂等重试。
5. 会话密钥只写入 Windows Credential Manager；WebView 只收到脱敏账号状态，SQLite 不保存原始凭据。

桌面端不接收密码、不复制密码哈希、不内置主站服务密钥。

### 6.2 离线登录

- 完成一次在线授权后，Credential Manager 凭据保留；断网时不删除可能仍有效的会话。
- 本地生成、打标、训练和记录不依赖在线账号，离线启动不设置登录门禁。
- 离线期间本地功能持续可用；联网后再检查设备是否被撤销。
- 账号切换不能把旧账号同步队列上传到新账号。

## 7. 环境检测与能力门禁

### 7.1 检测来源

- WMI/CIM：系统、CPU、物理内存、虚拟内存和磁盘。
- DXGI：显卡枚举和独立/共享显存。
- NVML 与 `nvidia-smi`：NVIDIA 型号、驱动、显存、温度和利用率。
- Runtime 自检：PyTorch Tensor、ComfyUI 最小工作流、WebP 输出、训练前向/反向和打标模型。

### 7.2 状态

- `ready`：当前能力自检通过。
- `installable`：硬件满足要求，但 Runtime 未安装。
- `degraded`：部分能力可用，存在显存占用或未完成自检。
- `blocked`：系统、GPU、驱动或 Runtime 明确不支持。

GPU 或 Runtime 不可用时，所有页面顶部持续显示不可永久关闭的提示；导航显示状态点；生成和训练按钮同时展示明确原因。

### 7.3 复检策略

- 启动时完整检查。
- 每 90 秒进行后台检查，窗口重新获得焦点且距上次检查超过 30 秒时复检。
- 提交推理或训练前执行轻量 GPU、显存和 Runtime 检查。
- 系统休眠恢复、驱动重启和 Runtime 退出后立即复检。
- 环境快照只保留最近 20 条，禁止无限写入数据库。

## 8. Runtime 管理

网站发布签名 Runtime 清单，包含 OS、架构、GPU 后端、Compute Capability、最低驱动、Python、PyTorch、组件、文件大小和 SHA-256。

安装顺序：

1. 系统、GPU、空间和权限预检。
2. 分片断点下载到版本临时目录。
3. 校验每个文件大小、SHA-256 和签名。
4. 安装私有 Python，不读取系统 Python 或 PATH。
5. 执行推理、训练、打标最小自检。
6. 原子切换 `runtime/current`。
7. 保留上一个可用版本用于回滚。

Runtime 更新不能中断运行中任务；队列空闲后切换。

### 8.1 依赖来源、测速与镜像切换

桌面端的 Runtime、底模、LoRA、打标模型和训练组件统一经过资源管理器安装。界面必须提供一键下载、暂停、继续、修复和卸载，不把寻找安装包、复制文件或配置 Python 环境转交给用户。

依赖来源有三种持久设置：

- `auto`：默认模式。优先探测并使用资源清单登记的官方来源；官方连接失败或持续缓慢时自动切换主站镜像。
- `official`：固定官方来源。失败时显示具体网络原因并保留断点，不切换镜像。
- `mirror`：固定主站镜像，仍校验官方签名清单登记的大小和 SHA-256。

自动模式的单次选择流程：

1. 从经过签名验证的同一资源清单取得官方与镜像 URL、文件大小、分片信息和 SHA-256。
2. 对候选源执行不超过 2 MiB 的 Range 探测，记录连接时间、首字节时间和持续吞吐；探测数据只用于本次下载和短期健康记录。
3. 官方发生连接超时、TLS/HTTP 错误，或连续 20 秒有效吞吐低于 1 MiB/s 时，将该源短期熔断并从已校验偏移切换镜像。
4. 只有文件大小、资源 ID 和 SHA-256 完全一致的来源才允许承接断点；切换来源后继续写同一临时文件，不重新下载已校验分片。
5. 下载完成后执行整体 SHA-256、清单签名和格式检查，再原子移动到正式目录；任何校验失败都隔离临时文件并显示来源和失败原因。
6. 熔断 10 分钟后重新小范围探测官方；正在运行的下载不因恢复探测而反复切源。

下载界面展示资源实际来源、实时速度、已下载/总大小、预计剩余时间、最近切源原因和校验阶段。测速、下载和哈希均在 Rust 后台任务执行；同时下载数和带宽限制受本地设置控制，生成或训练运行时自动降低下载优先级，避免抢占磁盘与网络。

每个资源同时声明下载字节数 `byteSize` 与安装后最大字节数 `installedSize`。安装前按后者加安全余量检查目标卷空间；ZIP/7z 归档只允许 Runtime、打标和训练组件，底模与 LoRA 必须是大小一致的原始文件。解压拒绝绝对路径、父级穿越、重解析点、Windows 保留名、重复文件和超出声明的展开体积。所有内容先写同卷临时路径，再原子切换到正式目录；旧版本重命名保留，切换或标记写入失败时恢复旧版本。

正式实现前必须先在 `docs/interfaces/README.md` 登记网站签名清单、镜像地址和更新协议，并在 `packages/contracts` 落地真实响应契约；客户端不内置未经登记的下载地址。

资源发布顺序：

1. 首次发布在隔离运维机执行 `pnpm desktop:resource-manifest generate --private-key .private/desktop-resource-signing.pem --public-key .private/desktop-resource-public.txt`，私钥只留在离线发布机。
2. 维护人员准备符合 `DesktopResourceManifestPayload` 的 JSON，官方与镜像条目必须指向同一字节大小和 SHA-256。
3. 执行 `pnpm desktop:resource-manifest sign --payload PAYLOAD_JSON --private-key PRIVATE_PEM --output ENVELOPE_JSON --key-id KEY_ID`；脚本先用共享契约校验，再压缩载荷、签名并自检。
4. API 只读取 `DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE` 指向的信封，不持有签名私钥；未发布或信封结构异常时返回 HTTP 503。
5. 正式桌面安装包在 `resource.rs` 固定公开清单 URL、密钥 ID 与 32 字节 Ed25519 公钥；私钥不进入源码、构建机环境或安装包。密钥轮换必须先发布同时受旧新密钥覆盖的过渡客户端，再切换清单签名。

首个 NVIDIA Runtime 使用 `Comfy-Org/ComfyUI` 正式发布的 `v0.28.0` CUDA 12.6 Windows 便携包，构建脚本固定 GitHub 发布资产大小和 SHA-256 `6af1b60b...4157cc0`。执行 `pnpm desktop:build-runtime --output BUILD_DIR --cache CACHE_DIR` 后，脚本断点下载并验证上游 7z、实际解压确认便携 Python 与 ComfyUI 入口及展开体积，再复用相同官方 7z 字节生成可直接进入签名清单的元数据。桌面端安全解压后写入自己的 Runtime 内部清单；因此官方来源和主站镜像可共享完全相同的哈希，下载量由 5.63GB 降至 2.03GB。版本升级必须修改固定版本、大小和 GitHub 摘要并重新经过生成、自检和 LoRA 训练回归，不允许静默跟随 latest。

首个一键底模组合使用 WAI Anima v1.0 主文件、`qwen_3_06b_base.safetensors` 和 `qwen_image_vae.safetensors`。三个签名资源分别安装到 `diffusion_models`、`text_encoders` 和 `vae`，全部哈希匹配后自动登记为一个 Anima 底模。WAI 主文件优先从 Hugging Face 官方下载，失败后由主站镜像端点按 8 MiB Range 代理同一签名官方对象；CLIP/VAE 使用主站已校验镜像。代理逐段核对状态码、`Content-Length`、`Content-Range` 和总大小，最终客户端仍执行完整 SHA-256，不信任代理传输结果。

## 9. 本地生成、打标和训练

- 生成页复用网页端模型、LoRA、画幅、提示词和任务详情语义，但数据源切换为本地仓库和 Local Scheduler。
- 模型选择必须依据 Runtime、GPU、显存和模型清单实时过滤。
- 自动打标使用独立 Runtime；人工标签保存后不再被后台二次改写。
- LoRA 训练沿用“图片→自动打标→逐图确认→参数→训练任务”的逐页校验流程。
- 每次任务固化环境、模型哈希、LoRA ID/哈希/权重、提示词、负面提示词和工作流版本。
- OOM 不进行无限重试；返回经过计算的安全分辨率、Rank 或 offload 建议。

### 9.1 本地训练集事实源

桌面端训练集必须先于自动打标和训练 Runtime 独立成立，SQLite 与受控数据集目录共同构成事实源：

1. 用户创建角色、画风或概念训练集，标题、类型和触发词立即持久化。
2. 每次可导入多张 PNG、JPEG 或 WebP；核心读取真实格式和尺寸、流式计算 SHA-256、原子复制到 `datasets/<datasetId>`，保留用户原文件，不以浏览器临时对象作为记录。
3. 同一训练集按内容哈希去重，图片总数限制 5–200；添加或删除图片后确认状态失效，但已经人工保存的其他图片 Caption 保持不变。
4. Caption 允许逐图保存；后台自动打标只能写入尚未人工确认的图片，人工修改后的 Caption 不再被后台改写。
5. 只有全部图片具有非空 Caption 且图片数满足范围时才允许确认数据集；确认后才开放训练参数步骤。
6. 应用重启、页面切换和 Runtime 退出都从 SQLite 恢复当前阶段，禁止依赖前端内存推进训练流程。

真实图片导入、逐图 Caption 和确认门禁已经完成。首个签名 `captioner` 使用 Apache-2.0 的 `SmilingWolf/wd-vit-tagger-v3` v2.0 ONNX 与 MIT 的 ONNX Runtime 1.22.1，默认通用阈值 0.35、角色阈值 0.85；RGBA 合成白底、方形补边、双三次缩放及 RGB→BGR 严格对齐官方示例。批量任务跳过 `caption_source=manual` 的人工 Caption，单图“重新打标”属于用户明确覆盖操作；任务、逐图结果、进度、错误和取消状态全部写入 SQLite，应用重启后继续未完成图片。

本地 LoRA 训练使用签名 `trainer.anima-sd-scripts` 组件，固定 `kohya-ss/sd-scripts` 修订 `37a1cbbc5725ed2a3575506e7bd2001c9908ac92` 和 Windows CPython 3.12 依赖；组件包含 CUDA 12.6 的 `bitsandbytes`，不使用需要用户自行安装 MSVC/Triton 的 `torch.compile` 路径。提交时固化已确认数据集、每张图 SHA-256/Caption、Anima DiT/Qwen3/VAE 哈希与完整参数；Worker 先校验快照，再停止 ComfyUI 释放显存，调用 `anima_train_network.py` 并持久化 JSON 进度。生成与训练经过应用内可中断单 GPU 协调器串行执行，取消时终止完整子进程树，应用退出时任务回到同一快照队列。训练成功后再次校验 safetensors 并原子导入 LoRA 仓库；OOM 只收敛为一次失败与确定性分辨率/Rank 建议，不进行无限重试。Trainer v2 通过任务级启动脚本显式恢复 Windows Embedded Python 忽略的组件依赖路径；已在 RTX 4060 Laptop 8GB 上以 5 张真实图片、512 分辨率和 Rank 8 完成训练，生成 23MB safetensors，并确认进度单调递增和训练进程完整退出。

Local Scheduler 使用桌面 SQLite 作为唯一事实源。提交命令先固化模型哈希、正负提示词、尺寸、采样器、调度器、步数、CFG、种子与隐私并立即返回；后台 Worker 单卡串行领取。每次执行创建独立 attempt，ComfyUI prompt ID 在提交成功时立刻写入。正常退出时运行中任务回到队列并把本次 attempt 标为 `interrupted`，用户取消则删除对应 prompt 并调用中断接口。产物下载后先校验 PNG 和尺寸，再原子写入作品目录、提交任务终态并在同一事务中加入图库 outbox。

首版支持两类真实工作流：单文件 `CheckpointLoaderSimple`，以及 Anima 的独立 `UNETLoader + CLIPLoader + VAELoader`。正面与负面提示词始终进入不同 conditioning。模型导入只接受结构可解析的 safetensors，复制时流式计算 SHA-256，遇到同名不同内容时生成哈希后缀，不覆盖已有文件。

## 10. 模型与 LoRA 仓库

- 支持网站公开模型、网站公开 LoRA、当前账号私有 LoRA和本地导入文件。
- 下载使用分片、断点、SHA-256、签名和原子安装。
- 本地导入默认接受 `safetensors`，以内容哈希去重。
- 每个资源记录底模系列、类型、触发词、来源、许可证、最低显存和 Runtime 兼容范围。
- 当前电脑不可运行的资源允许保存，但必须清晰标记并禁止任务提交。

## 11. 图库同步与隐私

- 每个成功产物自动进入 `gallery_sync_queue`。
- 默认隐私为 `private`；用户可在全局设置、任务提交和任务详情修改为 `public`。
- 上传使用稳定幂等键、分片断点和整体 SHA-256。
- 上传原始输出，网站单独生成缩略图；不上传底模、LoRA、训练集或参考图原文件。
- 离线时保持 `waiting_network`，登录过期时保持 `waiting_auth`，不得删除本地结果。
- 隐私冲突采用更严格的私有状态，等待用户解决。
- 本地删除、网页删除和同时删除必须分开确认。

## 12. 主题与窗口适配

主题模式包括：

- `system`：跟随 Windows 应用主题并监听实时变化。
- `dark`：强制深色。
- `light`：强制亮色。

主题保存在 SQLite，并同步设置 WebView 和原生窗口主题。所有颜色使用语义变量，禁止组件硬编码只适用于深色的正文、边框和背景。

窗口要求：

- 最小窗口 720×560；推荐 1280×800。
- ≥1100px：固定侧栏和多列仪表盘。
- 760–1099px：顶部紧凑导航、两列卡片。
- 720–759px：图标优先导航、单列复杂表单、横向滚动步骤条。
- 支持 Windows 100%–250% 缩放，不使用依赖物理像素的布局。
- 支持键盘焦点、`prefers-reduced-motion`、高对比模式和系统字体缩放。

## 13. 性能约束

- 首屏不读取模型文件内容，只读取 SQLite 摘要和环境状态。
- 大图库、任务和模型仓库使用分页、虚拟列表和缩略图。
- 私有原图进入视口后再读取。
- 哈希、解码、下载和 Runtime 操作在 Rust 后台线程执行，禁止阻塞 WebView。
- 后台检测不得高频启动 PowerShell；完整系统探测与轻量 GPU 健康检查分离。
- SQLite 写操作短事务化，长时间文件 IO 不持有数据库锁。

## 14. 更新与回滚

- 桌面程序、Runtime、工作流和资源使用独立版本通道。
- 软件更新包必须有发布签名和 SHA-256。
- 更新先下载到新目录，验证后切换；失败恢复上一个版本。
- 提供离线更新包和离线 Runtime 包。
- 更新不修改模型、LoRA、任务、账号或图库队列数据。

## 15. 安全要求

- 账号凭证写 Windows Credential Manager。
- Tauri 只开放登记命令和最小 capability。
- Runtime 只监听回环地址并使用随机令牌。
- 私有路径、令牌、提示词、训练图片和模型内容不进入诊断包。
- 第三方模型先校验格式和哈希；默认不加载 pickle 类权重。
- 自动更新、Runtime 清单和网站资源必须验证签名。

## 16. 测试矩阵

### 系统

- Windows 10 1809、21H2、22H2。
- Windows 11 22H2、23H2、24H2。
- 100%、125%、150%、200%、250% 缩放。
- 无 WebView2、旧 WebView2、当前 WebView2。

### 硬件

- 无独显、双显卡、NVIDIA 旧架构、NVIDIA 现代架构。
- 4GB、6GB、8GB、12GB、16GB、24GB 显存。
- 驱动缺失、驱动过旧、GPU 被禁用、显存被其他程序占满。
- 16GB、32GB、64GB 内存；页面文件关闭和空间不足。

### 网络与存储

- 完全离线、弱网、代理、断点恢复、CDN 切换。
- NTFS、网络盘、OneDrive、只读目录和磁盘写满。
- 上传中关机、应用崩溃和账号切换。

## 17. 发布验收门禁

完整正式版只有在以下证据全部存在时才可标记完成：

- Windows 支持矩阵的安装、启动、更新和卸载测试通过。
- GPU 不可用提示在所有页面持续存在，GPU 恢复后通过自检才解除。
- 深色、亮色和系统主题在运行中切换正确，原生标题栏一致。
- 最小窗口和高 DPI 下没有遮挡、溢出或不可操作控件。
- 环境一键安装、生成、打标、训练和恢复均经过真实 Runtime 测试。
- 网页账号授权、离线解锁、撤销和多账号隔离通过。
- 公开/私有图库上传、断点、幂等、冲突和删除流程通过。
- 软件、Runtime 和资源更新支持签名验证与回滚。
- 安装包不包含底模、LoRA 或训练模型。

## 18. 当前实现状态

当前已完成：Tauri 工程、Windows/NVIDIA 基础检测、Windows 10 1809 构建号门禁、持续环境提示、SQLite 设置及升级、主题跟随/手动切换、依赖来源偏好、环境快照、默认图库隐私、图库 outbox、响应式桌面 UI、签名资源清单契约和 API、离线签名工具、8 MiB Range 断点下载、低速切源、SHA-256 隔离、资源进度事件、安全 ZIP/7z 解压、磁盘预检、同卷原子安装、旧版本保留与回滚、Runtime 安装状态回归测试和 NSIS 构建。首个 NVIDIA Runtime、WAI Anima 模型组合、固定公钥、签名清单和主站 Range 镜像已经发布；清单签名、模型资源分片、完整 7z 安装及 NSIS 安装包均已通过真实验证。桌面核心现已支持 ComfyUI 动态回环启动、状态轮询、GPU/节点自检、受控日志、停止回收、safetensors 原子导入、Checkpoint/Anima 工作流、SQLite 本地任务/attempt/产物、串行调度、取消恢复和自动图库 outbox。LoRA 已支持安全导入、类型与触发词管理、单任务最多四个独立强度、任务级不可变快照，以及 Checkpoint/Anima 工作流真实串联；真实 Runtime 生命周期、自带 LoRA 的 512×512 Anima 生成和 NSIS 启动冒烟均已通过。本地训练集现已支持 5–200 张 PNG/JPEG/WebP 原子导入、内容去重、逐图人工 Caption、文件完整性复核与确认门禁。WD ViT Tagger v3 签名组件、ONNX Runtime 私有依赖、持久化批量/单图打标队列、人工 Caption 保护、取消和重启恢复已经接入 UI；真实动漫图片离线推理、签名 ZIP 安装及公开 Range 首尾分片均已验证。Anima Trainer 现已具备签名 ZIP、固定上游源码与 Windows CUDA 12.6 依赖、SQLite 任务/尝试/快照、共享 GPU 协调、取消进程树、OOM 建议、结果 LoRA 自动登记以及参数与任务 UI；Trainer v2 已在 RTX 4060 Laptop 8GB 上以 5 张真实图片完成 512 分辨率、Rank 8 的完整训练并生成 23MB safetensors。浏览器设备码授权、服务端哈希存储、幂等换取可撤销会话、Windows Credential Manager、离线账号状态和自适应账号 UI 已落地。

后续按顺序推进：网站模型/LoRA 授权下载 → 图库分片上传执行器与账号隔离 → 签名软件更新 → Windows 完整系统矩阵和安装包验收。
