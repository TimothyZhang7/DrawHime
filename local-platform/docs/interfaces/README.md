# 跨程序接口登记

类型实现位于 `packages/contracts`。任何新增跨程序字段必须先修改本文件。

## 通用响应

```json
{ "ok": true, "data": {} }
{ "ok": false, "code": "dependency_unavailable", "message": "依赖未就绪" }
```

## 当前已实现

### Anima 提示增强上游

- 调用方：`inference-worker`。
- 协议：OpenAI 兼容 `POST {PROMPT_ASSIST_BASE_URL}/chat/completions`，使用 Bearer 服务密钥。
- 输入：模型名、一次性用户提示词、Anima 系统知识、`response_format=json_object`、可配置推理强度与任务级 `prompt_cache_key`。
- 输出：`choices[0].message.content` 内的 `{"effectivePrompt":"..."}`；解析后写入独立任务和 `PROMPT_ENHANCEMENT` 阶段。
- 语义：每个主任务只创建一个持久化增强阶段；Runtime 重试只复用 `effectivePrompt`，不会再次调用增强上游。
- 失败：任务直接进入失败终态并释放主站预留，不使用原提示词静默继续。

| 接口 | 调用方 | 提供方 | 契约 |
|---|---|---|---|
| `GET /health` | 运维 | 所有服务 | `ServiceHealthView` |
| `GET /ready` | 运维/调度 | 所有服务 | `ServiceReadinessView` |
| `GET /v1/system/overview` | web/admin | api | `PlatformOverviewView` |
| `desktop_bootstrap` | desktop webview | desktop core | 返回 SQLite 持久设置、真实本机环境报告和待同步图库数量；对应 `DesktopBootstrapView` |
| `desktop_inspect_environment` | desktop webview | desktop core | 重新检测 Windows 名称、版本、构建号、支持状态、CPU、内存、磁盘、NVIDIA GPU、驱动和本地 Runtime，并持久化脱敏快照 |
| `desktop_save_settings` | desktop webview | desktop core | 校验并保存主题模式、依赖来源、模型/输出/Runtime 目录以及默认图库隐私和上传策略；对应 `DesktopSettingsUpdate` |
| `POST /v1/desktop-auth/requests` | desktop core | api | 创建 10 分钟有效的设备授权请求；服务端只保存随机设备密钥 SHA-256，返回用户码、浏览器确认地址和轮询间隔 |
| `POST /v1/desktop-auth/requests/approve` | local web | api | 由已登录主站并完成本地平台身份交换的用户确认设备码；设备码过期、已确认或账号状态失效时保持拒绝 |
| `POST /v1/desktop-auth/token` | desktop core | api | 使用设备密钥幂等轮询；确认后把同一随机密钥哈希登记为可撤销独立会话，原始密钥只写入 Windows Credential Manager |
| `desktop_account_status` | desktop webview | desktop core | 从 Windows Credential Manager 读取会话并在线校验；断网时仅返回离线状态，不向 WebView 暴露会话密钥 |
| `desktop_start_authorization` | desktop webview | desktop core | 创建浏览器设备授权请求并返回确认地址；不在 SQLite、日志或页面持久化设备密钥 |
| `desktop_poll_authorization` | desktop webview | desktop core | 按服务端间隔轮询，授权完成后写入 Windows Credential Manager 并只返回脱敏账号视图 |
| `desktop_sign_out` | desktop webview | desktop core | 尽力撤销服务端会话后删除 Windows Credential Manager 凭据；网络异常不阻止本机退出 |
| `GET /v1/desktop/resources/manifest` | desktop core | api/CDN | 返回 `{ ok: true, data: DesktopResourceManifestEnvelope }`；`payload` 是原始 UTF-8 JSON，`signature` 是服务端 Ed25519 签名，桌面端使用安装包内固定公钥验签后才解析资源；模型资源额外固化受控安装目录和模型组合的 group/role，只有主文件、文本编码器与 VAE 全部通过哈希安装后才自动登记 Anima 底模 |
| `GET /v1/desktop/resources/:id/content` | desktop core | api | 从签名清单定位主站镜像资源，只流式返回大小与清单一致的受控文件；支持单段 HTTP Range、`ETag=SHA-256` 和断点续传，不接受客户端文件路径；本地镜像文件缺失时只允许代理同一签名资源登记的 `official` HTTPS 来源，并严格核对上游 `Content-Range`、长度和总大小，私有下载令牌不回显给桌面端 |
| `desktop_load_resource_catalog` | desktop webview | desktop core | 拉取并验签资源清单，校验过期时间、Windows/架构、文件名、大小、SHA-256 与 HTTPS 来源后返回可展示目录；未配置真实清单和公钥时明确返回未配置状态 |
| `desktop_download_resource` | desktop webview | desktop core | 按资源 ID 执行断点下载；`auto` 优先官方，连接失败或持续低速后从相同哈希的主站镜像续传，完成整体 SHA-256 后原子写入本机下载缓存 |
| `desktop-resource-progress` | desktop core | desktop webview | 资源下载进度事件；对应 `DesktopResourceDownloadView`，包含当前来源、已下载字节、总字节、速度、状态与脱敏错误 |
| `desktop_install_resource` | desktop webview | desktop core | 再次校验缓存 SHA-256 与磁盘空间后安装资源；ZIP 拒绝路径穿越、链接和 Windows 保留名，在临时目录完成后原子切换，旧版本保留为可回滚目录 |
| `desktop-resource-install-progress` | desktop core | desktop webview | 资源校验、解压、切换和回滚事件；对应 `DesktopResourceInstallView` |
| `desktop_runtime_status` | desktop webview | desktop core | 返回当前设备 ComfyUI 子进程状态、PID、回环端口、启动时间、最近健康检查和脱敏错误；对应 `DesktopRuntimeStatusView` |
| `desktop_start_runtime` | desktop webview/local scheduler | desktop core | 校验已安装 Runtime 后，以私有 Python、动态回环端口和受控模型目录配置启动 ComfyUI；等待 `/system_stats` 真实就绪后返回，不向局域网或公网监听 |
| `desktop_stop_runtime` | desktop webview | desktop core | 幂等终止由当前桌面进程创建的 ComfyUI 子进程并等待退出；运行中本地任务存在时由 Local Scheduler 阻止停止 |
| `desktop_self_test_runtime` | desktop webview | desktop core | 启动或复用本机 Runtime，校验 `/system_stats`、GPU 设备及生成必需节点；成功后原子更新 Runtime 内部自检状态，失败时保留具体原因而不伪造就绪 |
| `desktop_import_local_model` | desktop webview | desktop core | 校验用户选择的 safetensors、计算 SHA-256、原子复制到受控模型目录并登记 `DesktopLocalModelView`；Anima 同时校验独立 UNet、文本编码器和 VAE，不加载 pickle 权重 |
| `desktop_list_local_models` | desktop webview | desktop core | 返回当前设备已登记且文件元数据仍匹配的本地底模，不扫描或读取未登记文件内容 |
| `desktop_import_local_lora` | desktop webview | desktop core | 校验并原子导入单个 safetensors LoRA，固化标题、类型、触发词、SHA-256、字节数和修改时间；同内容幂等复用，不覆盖其他文件 |
| `desktop_list_local_loras` | desktop webview | desktop core | 返回当前设备已登记 LoRA 及实时文件可用性；本地任务最多选择 4 个不同内容的 LoRA，每个独立设置 0–1.5 强度 |
| `desktop_create_training_dataset` | desktop webview | desktop core | 创建角色、画风或概念训练集并持久化标题和触发词，返回 `DesktopTrainingDatasetView` |
| `desktop_list_training_datasets` | desktop webview | desktop core | 返回当前设备训练集、真实图片文件摘要、逐图 Caption 和确认状态；应用重启后仍以 SQLite 为准 |
| `desktop_add_training_images` | desktop webview | desktop core | 校验并原子复制用户选择的 PNG/JPEG/WebP，读取真实尺寸和 SHA-256；同训练集内容去重且总量不超过 200，添加后重新执行确认门禁 |
| `desktop_update_training_caption` | desktop webview | desktop core | 逐图保存人工 Caption；修改后只使当前训练集回到待确认，不改写其他图片内容 |
| `desktop_create_caption_job` | desktop webview | desktop core/caption scheduler | 按训练集或单张图片创建持久化离线打标任务；批量任务跳过人工 Caption，单图重新打标属于用户明确覆盖操作；对应 `DesktopCaptionJobCreateInput` 和 `DesktopCaptionJobView` |
| `desktop_list_caption_jobs` | desktop webview | desktop core | 返回最近 100 个打标任务、逐图状态、阈值、进度和脱敏错误；应用重启后仍以 SQLite 为准 |
| `desktop_cancel_caption_job` | desktop webview | desktop core/caption scheduler | 幂等取消排队或运行中的打标任务，已经成功落库的逐图 Caption 保留 |
| `desktop-caption-job-updated` | desktop core/caption scheduler | desktop webview | 离线打标任务及逐图状态变化事件；载荷为 `DesktopCaptionJobView` |
| `desktop_confirm_training_dataset` | desktop webview | desktop core | 仅在训练集含 5–200 张图片且每张 Caption 非空时事务化确认，确认成功后才允许进入训练参数阶段 |
| `desktop_create_training_job` | desktop webview | desktop core/training scheduler | 固化已确认训练集、Anima 底模文件快照与训练参数并立即返回排队记录；对应 `DesktopTrainingJobCreateInput` 和 `DesktopTrainingJobView` |
| `desktop_list_training_jobs` | desktop webview | desktop core | 返回最近 100 个训练任务、尝试、排队位置、进度、产物 LoRA ID 与 OOM 降档建议 |
| `desktop_cancel_training_job` | desktop webview | desktop core/training scheduler | 幂等取消排队或运行中的本地训练；运行中进程树由核心终止，已成功登记的 LoRA 不回滚 |
| `desktop-training-job-updated` | desktop core/training scheduler | desktop webview | 本地训练任务状态变化事件；载荷为 `DesktopTrainingJobView` |
| `desktop_create_local_job` | desktop webview | desktop core/local scheduler | 校验模型与最多 4 个 LoRA 快照、提示词和参数后持久化创建 `DesktopLocalJobView`；提交立即返回排队状态，后台串行调度不会阻塞页面 |
| `desktop_list_local_jobs` | desktop webview | desktop core | 分页前的首版接口返回当前设备最近 100 个本地任务及产物摘要，任务、尝试和错误在应用重启后保留 |
| `desktop_cancel_local_job` | desktop webview | desktop core/local scheduler | 幂等取消排队任务；运行中任务向当前 ComfyUI prompt 发出删除和中断请求，终态任务保持不变 |
| `desktop-local-job-updated` | desktop core/local scheduler | desktop webview | 本地任务状态、进度或产物变化事件；载荷为 `DesktopLocalJobView`，刷新页面后仍以 SQLite 为准 |
| `desktop_enqueue_gallery_publication` | desktop runtime/UI | desktop core | 校验本地结果文件、计算 SHA-256，并以本地任务和文件哈希幂等写入图库同步队列 |
| `desktop_list_gallery_sync_queue` | desktop webview | desktop core | 读取当前设备本地图库同步队列；对应 `DesktopGallerySyncItem[]` |
| `desktop-gallery-sync-updated` | desktop core/gallery sync worker | desktop webview | 图库分片上传、等待登录、网络重试或发布终态变化事件；载荷为最新 `DesktopGallerySyncItem` |
| `POST /v1/desktop/gallery/uploads` | desktop core | api | 使用设备会话按账号、桌面任务 ID 与产物 SHA-256 幂等创建上传会话；固化隐私、尺寸、提示词、模型和参数快照，返回服务端真实偏移与 4 MiB 分片大小 |
| `GET/PUT /v1/desktop/gallery/uploads/:id` | desktop core | api | 查询真实断点或按 `x-upload-offset` 追加单个分片；上传会话严格绑定创建账号，偏移冲突返回服务端真实偏移 |
| `POST /v1/desktop/gallery/uploads/:id/complete` | desktop core | api/main backend | 校验完整字节数、SHA-256、图片格式与尺寸后原子写入对象存储，再通过桌面专用主站集成端点幂等发布正式图库；重试复用同一产物和发布键 |
| `POST /internal/integrations/local-model/desktop-generations/:externalTaskId/publish` | api | main backend | 使用主站服务凭证发布已由设备会话绑定用户并完整校验的本机作品；不创建共享 GPU 计费，仍事务创建正式图库任务、媒体参数快照和发布镜像 |
| `POST /v1/auth/session/exchange` | web/admin | api | 主站 Bearer JWT 换取 `LocalPlatformSessionView` |
| `GET /v1/auth/me` | web/admin | api | `LocalPlatformSessionView` |
| `DELETE /v1/auth/session` | web/admin | api | 撤销当前独立平台会话 |
| `GET /v1/models` | web/admin | api | 当前可用本地模型、工作流、模型独立的采样器/调度器/步数/CFG/质量前缀、采样最长边、画幅补偿像素预算、最终输出最大尺寸和主站价格版本；完整微调底模不得套用 Anima Base 的 Turbo 参数。全部 LoRA 组合使用同一模型级采样质量参数，不通过降低步数或像素预算伪造耗时一致 |
| `POST /v1/training/tag-translations` | web/main-web | api | 登录用户批量解析英文 LoRA 训练标签；优先读取持久化翻译集，缺失项由真实 AI 翻译后入库，返回简体中文、来源和每个标签稳定唯一色，不改写训练 Caption |
| `POST /v1/training/datasets/:id/assets/:assetId/caption-jobs` | main-web/web | api/training-worker | 为单张训练图片创建持久化自动打标任务；只替换该图 Caption，完成后使既有全量确认回到待确认，不重跑其他图片 |
| `GET /v1/model-library[/:id]` | web/admin | api | 浏览当前底模仓库和详情；返回格式、采样配置、带站点名称的多个来源链接、示例图片以及引用该底模的公开任务 |
| `POST /v1/admin/model-library` | admin | api | 管理员按 Anima 格式登记已经安装到私有 GPU 的 safetensors 底模，同时创建模型、Runtime、不可变工作流和主站价格版本 |
| `PATCH /v1/admin/model-library/:id` | admin | api | 管理员编辑底模仓库外显名称、描述、多个来源链接、使用说明和公开状态，不改写历史任务 |
| `POST/DELETE /v1/admin/model-library/:id/examples[/:exampleId]` | admin | api | 管理员上传或删除底模封面与示例图；第一张示例作为仓库封面，图片统一转为高质量 WebP |
| `GET /v1/model-library/examples/:id/content` | web/admin | api | 登录用户读取可访问底模的仓库示例图，不暴露对象存储键 |
| `POST /v1/inference/jobs` | web | api | `InferenceJobCreateRequest` 创建持久化任务并完成主站资金预留后入队；同一独立身份默认每 180 秒只接受一个新任务，幂等重放不重复占用冷却，命中限制返回 HTTP 429 `inference_submission_cooldown`；正面提示词与可空的用户负面提示词独立保存，Worker 分别映射到 Runtime 的 positive/negative conditioning；`loraVersionIds` 可跨角色、画风、概念、服装、姿势等类型多选，最多 4 个且不可重复；`loraStrengths` 与 `loraSelections` 固化每个版本的 0–1.5 强度及触发词快照，Worker 以显式强度优先并把实际 LoRA 链、采样尺寸和最终提示词写入任务审计 |
| `GET /v1/inference/jobs` | web/admin | api | 当前身份任务列表；管理员可读取全局列表；等待执行的任务批量返回全局推理队列位置、前方任务数、队列任务总数及预计等待/执行/完成秒数 |
| `GET /v1/inference/jobs/:id` | web/admin | api | `InferenceJobView`，包含阶段、尝试、固化参数、任务所用 LoRA 的标题、类型、权重与封面地址、产物哈希与字节数、计费镜像、主站图库发布状态和等待执行时的队列估算；普通用户只读取自己的任务 |
| `GET /v1/inference/jobs/:id/loras/:versionId/cover` | web/admin | api | 经任务归属鉴权读取该任务实际选用 LoRA 的首张示例封面；即使 LoRA 后续下架，历史任务仍可审计展示 |
| `GET /internal/gallery-publications/:externalTaskId/loras/:versionId/cover` | 主站 backend | api | 校验 `x-local-platform-token`、正式图库发布终态和任务 LoRA 快照后读取首张示例封面；用于主站图库封面代理，不开放对象存储地址 |
| `GET /internal/gallery-publications/:externalTaskId/loras` | 主站 backend | api | 校验服务凭证和正式图库发布终态，按任务固化版本 ID 返回对应 LoRA 当前条目 ID、实时标题与类型，并返回任务独立保存的用户负面提示词；标题编辑后主站图库详情无需改写历史任务即可刷新 |
| `POST /v1/inference/jobs/:id/cancel` | web | api | `InferenceJobCancelRequest`，只取消尚未运行任务并释放资金预留；若该任务仍是所属身份最后一次提交，则在同一事务中清除该身份的本地模型提交冷却 |
| `DELETE /v1/inference/jobs/:id` | web | api | 删除已结束推理记录；已发布作品先同步删除主站正式图库，余额、计费和产物审计不删除 |
| `GET /v1/artifacts/:id/content` | web/admin | api | 经会话鉴权读取所属任务的对象存储产物 |
| `GET /v1/loras` | web/admin | api | 已上传有效模型文件且当前身份可访问的 LoRA 列表 |
| `GET /v1/lora-library` | web/admin | api | 返回公开 LoRA 和当前用户自己的私有 LoRA；`mine=1` 仅返回本人条目，私有条目不向其他用户外显；仓库不再区分草稿与发布状态 |
| `GET /v1/lora-library/:id` | web/admin | api | 按 LoRA 条目 ID 或任务固化的 LoRA 版本 ID 读取唯一详情；公开条目可由其他用户查看，私有条目仅作者和管理员可读；详情附带最近引用该 LoRA 且已发布到主站图库的公开任务卡片，不外显私密任务 |
| `GET /v1/lora-library/:id/download` | web/admin | api | 登录用户流式下载可访问 LoRA 的最新有效 safetensors 文件；公开条目允许下载，私有条目仅作者和管理员可下载，不暴露对象存储键 |
| `POST /v1/lora-library` | web | api | 创建默认可用的当前用户 LoRA 并固化公开/私有选择；自定义主模型系列会持久化为全局筛选项 |
| `PATCH /v1/lora-library/:id` | web | api | 作者修改标题、描述、类型、主模型系列、触发词和公开/私有范围；不覆盖有效模型版本 |
| `POST/GET/PUT /v1/lora-library/:id/uploads[/:uploadId]` | web | api | 创建、查询并按服务端偏移续传 LoRA 文件；单片最多 4MB，偏移和临时文件持久化，刷新或网络中断后可继续 |
| `POST /v1/lora-library/:id/uploads/:uploadId/complete` | web | api | 校验完整 safetensors 文件、字节数和 SHA-256 后流式写入独立对象存储并创建版本 |
| `PUT /v1/lora-library/:id/file` | 受控客户端 | api | 小文件直传兼容入口，仍执行相同 safetensors、大小和 SHA-256 校验 |
| `POST /v1/lora-library/:id/examples` | web | api | 作者为 LoRA 上传最多 8 张示例图，服务端统一转为高质量 WebP 后写入独立对象存储 |
| `DELETE /v1/lora-library/:id` | web | api | 删除当前作者 LoRA 后立即从仓库、生成选择和示例访问中下架；历史任务、训练产物、计费和产物保持可追溯 |
| `DELETE /v1/lora-library/:id/examples/:exampleId` | web | api | 作者可删除任意示例图；没有示例图时仓库使用默认封面 |
| `DELETE /v1/lora-library/:id/uploads/:uploadId` | web | api | 取消当前用户的未完成上传会话并清理受控临时文件 |
| `GET /v1/lora-library/examples/:id/content` | web/admin | api | 登录用户读取公开 LoRA 示例图；私有示例图仅作者和管理员可读，并使用私有缓存策略 |
| `POST/GET /v1/training/datasets` | web/admin | api | 创建和读取当前身份训练数据集；管理员可使用 `scope=all` 查看全局资产 |
| `POST /v1/training/datasets/:id/assets` | web | api | 上传训练图片，服务端统一方向、色彩空间与 WebP 编码后写入独立对象存储并记录 SHA-256 |
| `PATCH/DELETE /v1/training/datasets/:id/assets/:assetId` | web | api | 编辑单图 Caption 或删除未被训练任务引用的数据集图片和对象 |
| `PATCH /v1/training/datasets/:id/trigger-words` | main-web/web | api | 独立更新数据集触发词，不改写自动打标、人工编辑或用户确认的图片 Caption；正式训练时由 Worker 仅在 Runtime 请求中补充缺失触发词 |
| `GET /v1/training/datasets/:id/trigger-words/summary` | main-web/web | api | 返回每张图片 Caption 的精确公共标签、同义归一化稳定共识标签、用户触发词及最终并集，不修改训练集数据 |
| `GET /v1/training/datasets/:id/archive` | main-web/web | api | 鉴权后流式导出当前训练集 ZIP；每张 WebP 图片都配套一个同名 UTF-8 `.txt` Caption，任一对象读取失败时终止整个归档而不静默跳图 |
| `POST /v1/training/datasets/:id/caption-jobs` | web | api/training-worker | 持久化创建角色、画风或概念自动打标任务；Worker 逐图读取独立对象并写入英文 Caption |
| `POST /v1/training/datasets/:id/caption-jobs/:jobId/confirm` | web | api | 校验图片快照与全部 Caption 后由用户确认；图片变化会把旧确认标为失效 |
| `POST /v1/training/quotes` | web | api | 使用真实图片数量、轮次、重复、分辨率、Rank 等参数计算资金预留数量与动态价格 |
| `DELETE /v1/training/datasets/:id` | web | api | 归档没有训练任务的数据集并清理其独立对象；已用于训练的数据集保持不可变 |
| `POST/GET /v1/training/jobs[/:id]` | web/admin | api | 创建、列表和读取 `TrainingJobView`；创建时复算动态计价单位并完成主站资金预留，再进入训练队列；等待执行的任务批量返回全局训练队列位置、前方任务数、队列任务总数及预计等待/执行/完成秒数 |
| `POST /v1/training/jobs/:id/cancel` | web | api | 取消尚未运行的训练任务，原分账释放主站资金预留 |
| `DELETE /v1/training/jobs/:id` | web | api | 删除已结束训练记录；只软删除用户可见记录，保留训练产物、LoRA、钱包与计费审计 |
| `POST /v1/training/jobs` | training-worker | GPU training-runtime | 以训练尝试 ID 幂等提交；Runtime 单卡串行排队，不把繁忙状态写成任务失败 |
| `GET /v1/training/jobs/:id` | training-worker | GPU training-runtime | 读取持久化训练状态；响应截断时 Worker 保持同一尝试、资金预留和租约重连 |
| `GET /v1/training/jobs/:id/output` | training-worker | GPU training-runtime | 使用标准单段 `Range: bytes=start-end` 分片读取训练产物；返回 `206`、`Accept-Ranges`、`Content-Range`、分片长度与整体 SHA-256，Worker 仅重传失败分片并在完成后校验总长度和 SHA-256 |
| `POST /v1/training/jobs/:id/cancel` | training-worker | GPU training-runtime | 幂等取消排队中或运行中的训练，排队线程与子进程同步退出 |
| `GET /v1/admin/runtime` | admin | api | 主站管理员读取真实 GPU 心跳、显存、活动租约、模型、工作流和队列状态，不返回服务 token 或对象存储密钥 |
| `PATCH /v1/admin/runtime-config` | admin | api | 更新全平台用户任务提交冷却秒数，允许 0–3600 秒，默认 180 秒；0 表示关闭，变更后按用户最后一次成功提交时间立即重新计算 |
| `PATCH /v1/admin/models/:id` | admin | api | 更新模型展示、启停、最大边、模型级尝试次数和不可变价格版本；运行中任务存在时禁止停用 |
| `PATCH /v1/admin/workflows/:id` | admin | api | 启停不可变工作流版本；有活动任务时禁止停用，启用模型必须至少保留一个活动工作流 |
| `PATCH /v1/admin/gpu-hosts/:id` | admin | api | 管理员启停 GPU 主机；停用后调度器不再分配新租约，运行中租约继续安全收尾 |
| `GET /internal/bot/catalog` | 主站 backend | api | 使用固定服务凭证读取 Bot 可选本地模型，不返回 Runtime、对象存储或主站凭证 |
| `POST /internal/bot/jobs` | 主站 backend | api | 以 QQ 身份创建单图持久化任务；与网页端共用独立身份级提交冷却和 HTTP 429 语义；模型启用提示增强时在独立任务内默认异步执行一次，再按 QQ 可访问钱包预留并调度 GPU |
| `GET /internal/bot/jobs?ids=` | 主站 backend | api | 批量读取 Bot 本地任务状态；成功图片只返回已发布到主站正式图库的媒体地址 |
| `GET /internal/artifacts/:id/content` | 主站 backend | api | 使用 `x-local-platform-token` 读取已成功、已提交计费任务的产物；主站必须再次校验 SHA-256 和字节数 |

### ComfyUI LoRA 断点同步

- 调用方：`inference-worker`；提供方：GPU ComfyUI 自定义节点。
- `GET /aiimage/loras/:fileName` 保留为已安装文件的大小与 SHA-256 查询；`PUT /aiimage/loras/:fileName` 保留完整文件上传兼容能力。
- `GET /aiimage/loras/:fileName/upload` 查询固定 SHA 临时文件的真实接收偏移；`PUT` 按该偏移追加单个分片；`POST` 在完整 SHA-256、总大小和 safetensors 结构校验后原子安装；`DELETE` 清理未完成分片。
- 断点接口统一校验 `x-service-token`、`x-aiimage-sha256`、`x-aiimage-total-bytes`，分片追加额外校验 `x-aiimage-offset`。成功响应使用 `{ ok: true, data }`；偏移冲突返回 HTTP 409 和真实偏移，Worker 必须重新查询后续传，不得从头覆盖。
- Worker 从独立对象存储按 4 MiB Range 读取并上传，单片使用有上限的超时、重试与偏移复核；Runtime 任务只能在完整文件原子安装成功后提交到 ComfyUI。

用户端入口支持 `GET /local-model/?tab=create|jobs|loras|training`，LoRA 详情使用 `tab=loras&lora=:id` 并支持浏览器前进后退；主站历史 `/loras` 入口使用完整页面跳转到 `tab=loras`，不会重新进入主站旧写链路。

### 用户提交冷却语义

- 冷却只限制同一用户创建新推理任务，不暂停 GPU，不延迟已经入队的任务；一个任务结束后 scheduler 立即领取下一条已有任务。
- 冷却时间从任务与计费镜像在同一事务内成功创建时开始计算；请求校验失败、事务回滚和相同幂等键重放不消耗新的冷却窗口。
- Web 与 Bot 都按独立平台 `ExternalIdentity` 隔离计算，避免单个身份短时间灌入大量任务长期占据 FIFO 队列。
- 管理员修改全局秒数后，API 使用用户最后一次成功提交时间重新计算剩余时间；无需批量改写历史任务或冷却记录。

### 健康响应语义

- `/health` 只表示进程存活，始终返回 `ServiceHealthView`。
- `/ready` 逐项执行真实依赖检查；全部通过返回 HTTP `200`，任一失败返回 HTTP `503`。
- `/v1/system/overview` 聚合 API 与五个兄弟服务的就绪视图；兄弟服务不可达时保留对应失败原因，不填充模拟状态。

### 生产服务依赖

| 服务 | 就绪依赖 |
|---|---|
| `api` | 独立数据库、Redis、对象存储、主站集成配置 |
| `scheduler` | 独立数据库、Redis |
| `inference-worker` | 独立数据库、Redis |
| `training-worker` | 独立数据库、Redis |
| `artifact-service` | 独立数据库、对象存储 |
| `gpu-agent` | 服务 token、ComfyUI `/system_stats` |

## 主站内部集成

| 接口 | 调用方 | 提供方 | 语义 |
|---|---|---|---|
| `PUT /internal/integrations/local-model/prices` | api/部署脚本 | 主站 backend | 发布不可变价格版本，同产品旧版本停用但保留 |
| `POST /internal/integrations/local-model/billing/reservations` | api | 主站 backend | 按产品、版本和数量由主站计算金额并预留 |
| `POST /internal/integrations/local-model/billing/reservations/:id/commit` | inference-worker | 主站 backend | 成功任务幂等提交预留 |
| `POST /internal/integrations/local-model/billing/reservations/:id/release` | api/inference-worker | 主站 backend | 失败或取消任务按固化分账幂等退款 |
| `POST /internal/integrations/local-model/generations/:externalTaskId/publish` | inference-worker | 主站 backend | 主站校验已提交计费记录，从独立内部产物端点流式复制原图并幂等创建正式图库记录 |
| `DELETE /internal/integrations/local-model/generations/:externalTaskId` | api | 主站 backend | 独立平台删除已发布推理记录时，原子删除主站正式图库任务、媒体参数快照和发布镜像；保留主站计费审计 |
| `DELETE /internal/gallery-publications/:externalTaskId` | 主站 backend | api | 主站图库删除时，独立平台以服务凭证软删除同一已结束推理记录；不反向调用主站，避免循环 |

推理队列使用 Redis 列表 `drawhime:inference:ready`，载荷只含 `jobId`；任务请求、价格、身份和状态均以独立数据库为准，Worker 不信任队列附加字段。

主站已发布 LoRA 由部署脚本通过只读迁移端点拉取；模型文件和示例图落入独立 MinIO 前必须重新计算 SHA-256，数据库只登记实际校验值。

推理任务只在 `publishToGallery=true` 时创建 `GalleryPublicationMirror`。发布失败不回滚已经成功的生成和计费提交，由 Worker 按镜像状态自动补偿；主站未确认媒体落盘前，独立平台不得把发布状态写为 `PUBLISHED`。

GPU Agent 每 10 秒把 ComfyUI `system_stats` 的真实设备和显存写入独立数据库。Scheduler 只向 45 秒内有新鲜心跳且未停用的空闲 GPU 分配租约；Worker 接受租约后才能开始无产物任务，成功、失败、重试和进程恢复都会幂等释放租约。

## 生产闭环状态

- SSO、身份会话撤销、主站钱包预留/提交/释放、正式图库发布、GPU 心跳与租约、推理恢复、LoRA 仓库和训练 Runtime 均已落地并完成生产验证。
- `POST /v1/training/jobs`、`GET /v1/training/jobs/:id` 与 `POST /v1/training/jobs/:id/cancel` 使用独立服务 token 调用 GPU training-runtime；数据集逐图校验 SHA-256，输出经受保护端点下载并直接登记为可用 LoRA。
- 未登记的写接口不注册路由，调用方不会得到伪成功响应。
