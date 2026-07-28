# API 摘要

字段级契约以 `standards/interfaces/README.md` 和 `packages/shared-contracts` 为准。工作流和本地模型推理已下线，不再提供用户、后台或服务间可调用接口；`/workflow`、`/api/workflows` 在 OpenResty 层返回 `404`。

## 通用响应

```json
{ "ok": true, "data": {} }
{ "ok": false, "code": "bad_request", "message": "请求不合法" }
```

## 公开接口

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/verify-email`
- `POST /auth/bind-email`
- `DELETE /auth/email`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`
- `GET /gallery`
- `GET /api/gallery`（支持 `search/mode/i2iKind/sort/tag/tags/tagMatch/page/pageSize`；`i2iKind=describe|replace` 用于图生图描述生成/替换生成细分筛选，`tag` 为旧版单标签，`tags` 可配合 `tagMatch=any|all` 做多标签范围筛选）
- `GET /api/gallery/tags/popular`
- `GET /images/:filename`
- `GET /images/:filename/detail`
- `POST /images/:filename/view`
- `GET /api/tools/config`
- `POST /api/tools/usage`
- `GET /api/leaderboards/users/tasks`
- `GET /api/users/:id/public-profile`
- `GET /api/appearance`（返回后台全站背景图开关和当前背景图片 URL；全局关闭时前端不得加载图片）

`GET /api/tools/config` 包含单一 `image-converter` 工具配置，公开后台设置的启用状态、单文件大小、单批数量、默认输出格式和默认质量。用户端在 `/tools/image-converter` 同时完成格式转换与图片压缩，支持 PNG、JPEG、WebP 输出、等比最长边缩放以及 JPEG/WebP 目标体积搜索；原图和结果只存在于浏览器内，不上传 backend、不写图库。整批至少一张成功后，前端通过 `POST /api/tools/usage` 仅上报一次工具 ID 聚合计数。

## 用户接口

- `GET /auth/me`
- `POST /auth/change-password`
- `GET /api/users/profile`
- `PUT /api/users/profile`
- `GET /api/users/avatar/:filename`
- `POST /api/users/me/avatar`
- `DELETE /api/users/me/avatar`
- `GET /api/users/me/appearance`
- `PATCH /api/users/me/appearance`
- `PATCH /users/me/privacy`
- `POST /qq/generate-key`
- `GET /qq/status`
- `DELETE /qq/unbind`
- `POST /api/generate`
- `POST /api/upload-reference`
- `POST /api/generate/recover`
- `POST /api/generate/retry`
- `GET /api/drawing/config`（公开返回后台当前多图开关、最大张数和 `drawing_max_prompt_length`；生成页与工作台据此设置提示词计数和输入上限，backend 仍执行最终长度校验）
- `GET /api/user-model-pref`（返回当前用户已保存的绘图模型；没有有效偏好时回退最近一次网页绘图任务模型）
- `POST /api/user-model-pref`（保存当前用户选择且仍启用的真实绘图模型）
- `GET /api/generations/cooldown`

`POST /api/generate` 支持图片模式 `text-to-image/image-to-image` 和视频模式 `text-to-video/image-to-video`。视频任务固定 `count=1`，必须传 `duration`（1-15 秒）、`resolution`（480p/720p/1080p）和 Grok 视频支持的七种显式 `aspectRatio`；参考图视频最多 8 张。视频可传 `storyboardDesign`，在模型允许时默认开启：backend 复用图片反推工具配置的真实端点与模型分析原提示词、视频参数和参考图，再重新设计最终视频分镜提示词，不复用反推页面绘图 Prompt。Grok 视频端点不支持 `prompt_cache_key`，即使同一站点的图片端点开启渠道亲和，Worker 也不会将该字段发送到 `/videos/generations`。成功任务通过 `mediaType=video`、`videoUrl` 返回 MP4；media-service 保存视频时同步生成首帧 WebP 封面，图库默认只加载封面，支持悬浮后按需加载并静音循环播放视频，视频详情页继续使用带控件播放器。

主站普通生成接口不再接收新的 ComfyUI/Anima 本地模型任务，也不再在生成页提供 LoRA 选择。本地推理、LoRA 选择和训练由 `/local-model/` 独立平台创建任务；主站只通过受保护集成接口权威管理账号、钱包预留和正式图库发布。历史任务中的 LoRA 快照继续只读展示。

删除主站图库任务时，backend 会识别已发布的本地模型任务并先调用独立平台的受保护删除回调；回调失败则主站不执行单边删除。独立平台用户删除已结束的推理任务时反向调用主站 `DELETE /internal/integrations/local-model/generations/:externalTaskId`，主站原子删除正式图库任务、图片/参数快照和发布镜像，但始终保留钱包预留、分账与计费审计。
- `GET /api/workbench/conversations`
- `POST /api/workbench/conversations`
- `GET /api/workbench/conversations/:id`
- `DELETE /api/workbench/conversations/:id`
- `POST /api/workbench/conversations/:id/messages`
- `POST /api/workbench/conversations/:id/messages/stream`
- `POST /api/workbench/conversations/:id/messages/:messageId/retry/stream`
- `POST /api/workbench/conversations/:id/messages/:messageId/decision`
- `POST /api/workbench/attachments`
- `GET /api/workbench/attachments/:id`
- `GET /generations`
- `GET /generations/tasks`
- `PATCH /generations/privacy`
- `DELETE /generations`
- `GET /templates`
- `POST /templates/ai/convert`
- `POST /templates`
- `GET /templates/:id`
- `PUT /templates/:id`
- `DELETE /templates/:id`
- `POST /templates/:id/favorite`
- `DELETE /templates/:id/favorite`
- `POST /wsproxy/create-endpoint`
- `GET /wsproxy/my-endpoint`
- `GET /api/wallet/status`
- `GET /api/wallet/ledger`
- `GET /recharge/shop`
- `POST /recharge/redeem`
- `GET /api/referrals/me`
- `POST /api/referrals/apply`
- `POST /api/tools/image-reverse/extract`
- `POST /api/tools/image-reverse/jobs`
- `GET /api/tools/image-reverse/jobs`
- `GET /api/tools/image-reverse/jobs/:jobId`
- `GET /api/tools/image-reverse/jobs/:jobId/source`
- `POST /api/tools/image-upscale/run`
- `POST /api/tools/image-upscale/jobs`
- `GET /api/tools/image-upscale/jobs`
- `GET /api/tools/image-upscale/jobs/:jobId`
- `GET /api/tools/image-upscale/jobs/:jobId/source`
- `POST /api/tools/image-upscale/jobs/:jobId/cancel`

## 参考图上传接口

`POST /api/upload-reference` 必须使用用户 JWT。接口支持 PNG、JPEG/JPG/JFIF、WebP、GIF、AVIF、TIFF/TIF、SVG 的二进制直传，也保留旧 JSON base64 请求体；backend 只负责鉴权、读取最多 20MB 的原始参考图并转发 media-service。media-service 按真实文件签名和 Sharp 解码结果校验内容，应用 EXIF 方向，GIF 只取首帧，SVG/AVIF/TIFF 栅格化，随后把所有参考图统一转换为 `image/png`、`.png` 文件并压到 3MB 任务输入上限内。响应包含 `filename`、`url`、`size`、`originalSize`、`compressed` 和 `mimeType`，其中 `mimeType` 固定为 `image/png`。最终生成原图仍走 `img_` 链路独立保存，不受参考图转换影响。

## LoRA 仓库接口

`GET /api/loras` 浏览公开已发布 LoRA，支持 `search/model/type/page/pageSize`；登录用户使用 `mine=1` 查看自己的草稿和发布记录。`model` 只保存和筛选 Anima、Krea2 等主模型系列，不再使用具体 checkpoint 文件名。`GET /api/loras/models` 返回全局主模型词表，默认 `anima`，系统预置 `anima/krea2`；用户在上传时填写的新系列会与草稿同事务持久化，供全站后续选择。

主站 LoRA 仓库已进入历史只读：公开列表、历史示例图和 `GET /api/loras/:id/download` 继续可读，保证旧页面链接和历史任务可审计；草稿、分片上传、文件上传、示例图上传、发布与删除端点统一返回 HTTP `410` 和 `local_model_platform_required`。新 LoRA 资产通过 `/local-model/?tab=loras` 管理，训练通过 `/local-model/?tab=training` 管理。

## 图片反推接口

异步反推任务的完整结果继续保存在任务详情接口中；历史列表只返回独立的轻量分析摘要，包含实际证据管线、Provider 状态、证据/告警/冲突数量及 Anima Prompt 是否可用，不读取或传输完整结果 JSON。新版分析结果同时保存证据来源计数和高影响互斥项冲突；冲突只提示用户核对，不在缺少确定依据时改写最终 Prompt。标签结果中的 Anima Prompt 可写入浏览器一次性绘图草稿后进入生成页，生成页只预填文本，不重新识图、不自动提交或扣费。

`POST /api/tools/image-reverse/jobs` 必须使用用户 JWT，接收 `Content-Type: image/*` 的单张二进制图片，通过 `x-aiimage-reverse-options` 传递 `ImageReverseExtractOptions` JSON，并可用 `x-aiimage-file-name` 传递 URL 编码后的原始文件名。backend 校验图片后先把原图和 WebP 预览原子写入 `/v3/local/image-reverse-sources` 私有目录，再创建 `image_reverse_jobs` 数据库记录，最后进入最多 4 个并发、16 个等待任务的识图队列；任一步失败都会回滚刚写入的孤儿文件。成功返回 `202` 和 `ImageReverseJobCreateResponse`。

`GET /api/tools/image-reverse/jobs` 返回当前用户最近 50 条 `ImageReverseJobListResponse`，列表包含源图元数据、提取选项、状态、进度和结果摘要，不携带完整结果 JSON；`GET /api/tools/image-reverse/jobs/:jobId` 返回 `ImageReverseJobDetailResponse` 和成功任务的完整结构化结果；`GET /api/tools/image-reverse/jobs/:jobId/source` 鉴权输出私有原图，带 `preview=1` 时输出轻量 WebP 预览。Web 反推页普通进入时只自动恢复最新未完成任务，不再读取旧版 IndexedDB 大图或自动打开最近完成记录；通过 `/reverse?job=任务ID` 打开历史时只下载轻量预览，完整结果仍从数据库恢复。`/reverse/history` 展示历史记录。backend 重启时会从数据库读取 `queued/running` 任务、私有源图和提取选项重新排队，不重复创建记录。`POST /api/tools/image-reverse/extract` 继续作为旧客户端同步兼容入口，Bot 仍使用内部同步入口。

backend 校验真实图片内容后调用后台配置的 OpenAI 兼容识图模型，详细度固定为最高档，只返回用户本次选择的模式结果：描述模式返回结构化多语言描述；Prompt 模式返回正向、反向、角色、构图、风格和背景 Prompt；角色模式返回角色卡、局部特征、不可丢失锚点和复现 Prompt；标签模式返回本地模型英文标签、权重和中英文对照；编辑模式返回保持项、修改项、禁止项、多参考图关系和图生图编辑 Prompt。描述模式的提示词栏面向“不定数量角色参考图 + 提示词”：backend 忽略上游 drawingPrompt 中可能夹带的原角色描述，只从结构化结果的姿势动作、非角色细节、构图镜头、背景、光影和画风确定性重组 `drawingPrompt`；多张参考图展示同一角色时作为不同角度和细节证据合并，只生成一个受参考图控制的主体角色实例，明确展示不同主体角色时分别保持身份且不融合；反推场景中明确描述的陪伴生物、环境角色和物件仍按原场景保留。描述模式的 `negativePrompt` 是自然语言“参考图使用规则 / 生成约束”，明确参考图外观优先、参考图张数不等于主体角色数量以及结构、画质和身份漂移限制。网页和 Bot 都不会再次拼接原角色 `characterPrompt`、身份锚点或具体外观值，因此全部新参考图共同作为主体角色身份、脸、发型、眼睛、体型、服装、配饰和道具的唯一来源。各模式互斥，不在一次响应中混合其他模式字段。生产默认使用已真实验证的 `gpt-5.6-sol` 与 `medium` 推理强度，并把 `MDX-Tom/gpt-5.6-instruct` v5 的直答策略收敛为图片视觉转写专用系统指令；成人、暴力、医疗、争议主题等画面继续按相同 JSON 契约中性、准确地描述。上游若返回内容偏离或错误结构，backend 会重新独立观察原图一次，第二次仍缺少当前模式字段时返回明确上游错误，不生成假描述。单次上游请求默认超时为 `300` 秒且后台可在 `5-600` 秒内配置。持久化源图仅供所属用户通过鉴权接口读取，不进入图库、不公开展示、不扣费；API Base URL、API Key 和系统提示词只保存在后台配置中，不返回给浏览器。

新版反推任务优先使用严格 `json_schema` 约束上游字段，兼容端点不支持时依次降级到 `json_object` 和提示词 JSON，并把实际层级写入 `result.analysis`。用户端默认开启“保存分析证据”，可在提交前关闭；开启时任务结果持久化 Provider、处理阶段、分类证据、来源和告警，关闭时仍保留阶段审计但不保存逐条证据。历史任务重新打开后可继续筛选证据或复制审计 JSON。标签模式新增 `anima` 目标格式，backend 按角色、细节、构图、环境、画风和质量顺序确定性生成无权重单行 `animaPrompt`，该格式化不会再次调用识图模型。

标签模式支持 `analysisMode=vision-only|hybrid`。`hybrid` 仅在后台 WD14 配置完整时生效，backend 会并行调用视觉模型和受保护的 GPU `POST /v1/tag`，将 WD EVA02 Large v3 的 general/character 标签及模型原生置信度合并到标签结果和 Anima Prompt。WD14 Provider 超时、未配置或异常时，本次任务自动保留视觉结果并在 `result.analysis.providers/stages/warnings` 中记录降级，不重复调用视觉模型。`GET /api/tools/config` 通过 `reverseHybridAvailable` 告知用户端是否展示混合模式，不返回 Provider 地址、密钥或阈值。`GET /admin/tools/image-reverse/wd14/health` 使用管理员 JWT，返回配置完整度、模型与标签文件、Session、ONNX Runtime 版本和 Execution Provider，不返回密钥。

## 图片放大接口

`POST /api/tools/image-upscale/run` 必须使用用户 JWT。接口接收 `Content-Type: image/*` 的单张二进制图片，通过 `x-aiimage-upscale-options` 传递 `ImageUpscaleRunOptions`，包含倍率、模型名，以及可选的 `saveToLibrary`。图片放大输出格式固定为 `webp`，旧客户端或旧后台配置传入 `png` 时也会由 backend 强制归一为 `webp`；用户端不再提供返回格式选择。用户端可选模型来自后台 `tools_image_upscale_allowed_models` 白名单，公开工具配置同时返回 `upscaleMaxOutputPixels` 供前端提前禁用会超限的倍率；backend 会再次按白名单和最大输出像素归一化校验，非法值不会透传 GPU 服务。backend 校验真实图片内容、输入大小和输出像素上限后进入进程内 FIFO 队列，再调用私有 GPU 超分服务；队列并发由后台 `tools_image_upscale_max_concurrency` 控制，等待队列由 `tools_image_upscale_queue_max_pending` 控制，单个请求最大排队时间由 `tools_image_upscale_queue_timeout_sec` 控制，队列满或等待超时时返回 `429`。成功响应包含 `queueWaitMs`，用于区分排队耗时和 GPU 实际耗时。GPU 结果链路支持 `binary`、`s3` 和 `local`：`s3` 由 GPU 上传对象存储后返回公开 URL，`local` 由 GPU 写入本机临时目录后返回公开 URL，`binary` 由 GPU 直回图片二进制；默认不保存上传图、不写图库、不扣费。用户显式传 `saveToLibrary=true` 时，`binary/s3` 链路仍同步保存放大后的最终图和缩略图，`local` 链路会先返回 GPU 暂存 URL 供用户预览，再由 backend 后台异步下载该结果并保存到主站 media-service 和图库记录；该保存动作仍不写钱包、不扣费、不绕过图库权限。

异步图片放大任务使用 `POST /api/tools/image-upscale/jobs` 创建，`GET /api/tools/image-upscale/jobs` 和 `GET /api/tools/image-upscale/jobs/:jobId` 查询当前用户自己的近期持久化任务。backend 会先把上传源图和 WebP 预览原子写入 `/v3/local/image-upscale-sources`，再把安全短文件名、源图元数据、任务选项和状态写入 `image_upscale_jobs`，最后启动 GPU 队列；数据库创建失败会回滚刚写入的私有文件。成功状态、结果 URL/元数据、错误摘要和后台保存图库后的 `savedTask` 都会写回数据库，因此刷新页面、更换设备或 backend 重启后仍能查看历史；重启前处于 `queued/running` 的新任务会从数据库和私有源图重新排队。`GET /api/tools/image-upscale/jobs/:jobId/source` 使用用户 JWT，仅向任务所属用户输出私有源图，`preview=1` 输出轻量预览。成功结果会返回 `timings`，用于区分排队、GPU 响应头、结果下载、对象存储上传或本机暂存写入、后端元数据识别和 base64 整理耗时。`s3/local` 链路成功结果优先返回 `image.url`，`binary` 链路返回 `image.base64`。当 `local` 链路同时要求 `saveToLibrary=true` 时，任务会先进入成功状态并显示 GPU 暂存 URL，backend 后台异步保存图库，保存成功后补写 `savedTask`，保存失败只记录任务错误摘要，不覆盖已可访问的暂存结果。`POST /api/tools/image-upscale/jobs/:jobId/cancel` 只能结束当前用户自己的任务，后续结果不会覆盖取消状态或进入图库。

`local + saveToLibrary` 的后台保存会把浏览器使用的公网暂存 URL 转换为 backend 到 GPU 服务的同路径直连地址，再复用 Node 原生 IPv4 下载器执行受限重试，避免公网反代限速和 undici 连接超时；下载过程限制响应体大小，同一放大任务使用确定性图库任务 ID，网络中断后的重复保存不会生成重复作品。

## 管理接口

- `/admin/stats`
- `/admin/users`
- `/admin/generations`
- `/admin/sites`
- `/admin/ai-image/config`
- `/admin/recharge/*`
- `/admin/referrals/*`
- `/admin/bot/*`
- `/admin/config`
- `/admin/tools/usage`
- `/admin/tools/image-upscale/health`
- `/admin/gallery-tags/overview`
- `/admin/gallery-tags/run`
- `GET /admin/drawing/model-settings`
- `PUT /admin/drawing/model-settings`
- `/admin/command-configs`
- `/admin/storage/overview`

管理接口必须使用 admin JWT。管理后台不再显示工作流和本地模型推理入口。

`POST /admin/appearance/background` 使用图片二进制上传全站背景图，backend 校验并压缩为 WebP 后先原子落盘，再更新 `system_configs.site_background_filename`；数据库写入失败时回滚新文件。`DELETE /admin/appearance/background` 清除当前背景文件。全局启用状态由 `system_configs.site_background_enabled` 管理，用户个人开关保存在 `users.site_background_enabled`，两者同时开启时前端才显示背景。

`GET /admin/generations/:id` 在代表任务和批次 `tasks[]` 中返回 `requestParams` 规范化请求对象，管理后台以格式化 JSON 完整展示并支持复制。该对象合并任务表与创建事务内的 `task_generation_params_*` 调度快照，并包含按任务身份推导的 `promptCacheKey`；不包含鉴权头、站点 API Key、用户明文身份或钱包信息。历史任务缺少尺寸和质量快照时使用后台当前默认值兼容展示。

API 站点编辑默认不渲染 API Key 输入框，只有管理员点击“替换 API Key”后才允许手工输入并发送新值；输入框声明禁止密码管理器自动填充。`PUT /admin/sites/:id` 收到缺失或空白 `apiKey` 时必须保留数据库现有密钥，不能因普通保存或浏览器填充行为清空生产凭证。

API 站点可独立配置 `sendResponseFormat`。开启时 OpenAI Images 文生图按站点 `responseFormat` 发送 `response_format`；关闭时请求体完全省略该字段，用于兼容拒绝 `response_format: "auto"` 的上游。数据库迁移对既有站点默认开启，不改变其他站点当前行为。

API 站点可独立配置 `sendPromptCacheKey`。开启后 Worker 对 Web 用户或 Bot QQ 身份生成不含明文标识的稳定 `prompt_cache_key`，同一用户跨任务、同站重试和换站重试保持一致，用于支持 NewAPI 渠道亲和；无用户身份的内部任务按 `clientRequestId` 兜底。该开关对既有站点默认关闭。NewAPI 端必须另外配置覆盖实际 `/v1/images/generations`、`/v1/images/edits` 或视频路径的渠道亲和规则，并把键来源设为请求中的 `prompt_cache_key`。

## 管理后台工具统计接口

`GET /admin/tools/usage` 必须使用 admin JWT。backend 从 `system_configs` 聚合返回每个用户端工具的累计调用、当天调用和最近调用时间，只返回聚合计数，不返回用户、IP、上传图片或工具参数。

`GET /admin/tools/image-upscale/health` 必须使用 admin JWT。backend 读取图片放大私有配置，探测 GPU 服务 `/health`，并返回启用状态、密钥是否已配置、默认模型、允许模型、GPU 结果返回链路、GPU 设备/CUDA/模型列表和 backend 进程内队列快照；GPU 模型列表会区分代码支持的 `availableModels`、已落盘权重 `weightFiles` 和运行时已加载缓存 `models`，并返回 `modelCacheLimit` 表示 GPU 运行时最多保留的已加载模型数量，避免多模型切换时把未加载缓存误判为缺模型或让显存常驻持续升高。队列快照包含当前执行数、等待数、最老等待耗时、并发上限、等待队列上限和排队超时上限。响应不包含 API Key 明文，不包含 GPU 服务器的对象存储密钥。

Bot 命令链路支持协议端自身消息触发。NapCat/OneBot 上报 `post_type=message_sent` 时，wsproxy 将事件规范化为带 `self_triggered=true` 的标准消息，Bot 自己发送且不带 `reply` 段的独立显式命令继续进入现有命令路由；自身普通输出和命令回执保持静默，避免递归触发。群内其他在线 Bot 收到该消息时保持静默，发送命令的 Bot 自己处理；自触发私聊保存原接收方并把即时回复、任务结果继续发送到原私聊。自触发身份固定使用当前 `self_id`，继续执行 QQ 钱包、绑定、余额、管理员白名单、任务扣费、并发、去重和错误处理规则。

具备文生图能力的 `text_to_image` 或 `universal` 模型可在独立模型设置中开启 `referencePromptAssistEnabled`，该模型级开关默认关闭。模型开启后 Web 与 Bot 默认执行“AI 提示增强”，Web 用户可在本次生成前显式关闭；`POST /api/generate` 通过 `referencePromptAssist=true|false` 固化本次选择。该链路接受 0-4 张参考图：无图时在不改变主体、数量、关系和动作的前提下扩写构图、背景、光影、材质和画风；有图时把全部参考图和用户提示词交给 backend 的专用多模态接口，实际绘图上游保持 `text-to-image` 且不接收图片。人物数量以用户原始提示词为准：没有明确要求两名或多名人物时，增强只提取一个主体身份，画面边缘或局部可见的发丝、手臂、衣物、肩背、倒影和裁切轮廓只作为构图证据，不得创建第二角色、人物关系或互动；屏幕、海报、相框、镜面、玩偶和雕像只作为构图元素，同一角色设定页的多姿态不得拆成多人。参考图转写必须核对主体、外观、服装配饰、动作、构图裁切、背景物件、光源方向、材质和画风，只写可见事实；不确定文字和被遮挡细节不得猜测。每次用户提交最多执行一个提示增强阶段，`N>1` 批次全部任务和绘图上游重试复用同一个 `effectivePrompt`；历史复投直接使用已固化提示词，不再次调用。再次提交以 `用户生成要求：` 开头的历史增强结果时，backend 只恢复其最前面的真实用户要求并重新分析当前图片，不得把旧的外观、构图、背景、画风和尺度段再次嵌套。首轮已返回完整分段提示词时不因本地画风关键词差异重复请求上游，避免第二次同步调用把可用结果拖成超时；只有成人尺度发生实质偏移时才执行同阶段内的纠偏。上游快速返回 408/429/5xx 或空响应时只在同一总超时预算内重试一次，不延长同步等待窗口。成功任务时间线包含一个 `prompt_assist` 步骤，任务、图库和 `task_generation_params_<taskId>` 的 `prompt`/`effectivePrompt` 保存实际提交提示词。增强结果必须包含独立的“画风与渲染”段：用户已指定画风时保留用户意图；有参考图且未指定画风时以参考图1为主风格，无参考图时选择与题材一致的明确方案，均需具体描述媒介成像、线条边缘、上色塑形、笔触材质、细节虚实和光学后期。明确成年角色的成人向/NSFW 请求保留裸体、乳房和乳头可见、亲密互动及成人氛围；backend 对有图视觉转写和无图增强结果统一执行确定性尺度归一，只收敛外阴、外生殖器及其解剖细节的直接呈现和特写，通过局部姿势、适度服饰/配饰、前景元素或构图控制下半身可见范围，不扩大成整体穿衣或遮挡乳头。增强失败不创建任务、不扣费。后台模型设置接口同时维护专用 Base URL、API Key、模型、10-90 秒同步超时、单图大小和输出长度；读取响应只返回 `apiKeyConfigured`，不返回密钥明文。

AI 提示增强的最终 `effectivePrompt` 始终描述一张完整目标图像。多张输入只在分析阶段作为视觉证据融合，不得在最终提示词中输出图号、逐图说明、原图/参考图对照或分栏方案；未指定画风时，第一张主参考图是唯一画风来源，其他图片只能补充角色、构图或物件事实。`gpt-5.6-sol` 在该链路固定使用 `reasoning_effort=xhigh`，以提高视觉细节和画风指纹的判断准确性。

“脱掉衣服、去掉衣物、移除服装、不穿衣服、脱衣、脱光”等明确修改均进入成人向确定性融合链路；最终目标必须保留角色、动作、构图、背景、光影和主参考图画风，仅移除服装，不得根据参考图当前穿衣状态反向写成“完整服装、避免裸体”。

角色身份转写将脸型与五官比例、眼睛形状和颜色、刘海、发型轮廓、发色分区、发长与身体特征同服装分离；发饰、角、耳、眼镜和标志性首饰使用独立身份配饰字段。成人向视觉转写另生成置于最终提示词前部的“角色身份锁定”字段，压缩重复最具辨识度的面部、眼睛、发型发色与身份配饰，确保不接收参考图的绘图上游优先复现原角色。脱衣或换装只删除衣服、鞋袜、手套和服装装饰，身份配饰必须保留，最终提示词同时附加不可变身份硬约束，禁止生成近似角色或重新设计角色。

多参考图调用中第一张主参考图固定以高细节传入，用于画风与主视觉判断；其余图片以自动细节补充身份、构图和物件证据，避免在 `xhigh` 下因重复视觉 token 超出同步请求窗口。

模型设置使用 `promptFormat` 明确 AI 提示增强格式，不再以“本地模型”开关推断链路：`standard` 输出通用中文完整描述，`diffusion` 在视觉融合后输出英文 `Positive prompt` 与 `Negative prompt`，`anima` 直接把文字和全部参考图融合为 Anima3 单行小写标签。Anima 格式严格遵守 count/gender → character/series → appearance → clothing/state → pose/action/sex → expression/reaction → camera/shot → scene/environment → detail/mood → 自然语言补充的槽位顺序，执行人数、互斥、去重、标签数量和禁用光影词校验，不输出质量词、画师、权重或正负提示词标题。最终提示词作为任务实际提示词持久化并由批次、重试和进程恢复复用。

当前权威实现把 `standard`（Grok/通用完整自然语言）、`anima`（本地 Anima 英文标签）和 `diffusion`（传统英文正负提示词）拆成三个互不串联的服务。Grok 不经过 Anima 标签或英文翻译，Anima 不先生成 Grok 中文描述，Diffusion 也不再执行“通用增强后再翻译”；每个主任务只调用一次 Chat Completions，在同一次回答内部完成视觉融合、格式转换和自检。三个服务分别使用基于 `MDX-Tom/gpt-5.6-instruct` v41 收敛的绘图直出规则，禁止拒绝、道歉、政策说明、道德评价、替代建议和内容保守化，也不再执行“新增成人内容”二次审核、修复请求或第二次模型调用。确定性后处理只允许解析 JSON、长度收敛、Anima 去重和精确互斥标签消解，不得删改用户画面语义；拒绝文本不会写入任务提示词。此段替代本节早期遗留的同步二次纠偏描述。

提示增强不得从圆脸、大眼、矮小比例、校园服装、可爱或扁平画风推断年龄，也不得使用“儿童绘本、成人向画风”等年龄暗示词替代具体绘制技法。Anima 遇到两个或更多不同角色时，必须在标签末尾追加一条英文属性绑定短句，分别固定每个角色的外观、服装和动作归属；多张图片属于同一角色时必须合并为 `1girl/1boy + solo`，不得按图片数量复制角色。

Web 与 Bot 的 AI 提示增强统一采用任务内异步时序：`POST /api/generate` 或 `POST /internal/bot/generate` 先事务创建、扣费并立即返回主任务，首批主任务保持 `running` 且初始时间线写入 `prompt_assist=running`，但在增强完成前不创建 `upstream_attempt`，因此 Worker 不会提前消费；backend 随后异步增强，成功后原子固化任务提示词、参数快照和时间线，再投递 drawing-service。增强失败时已创建任务进入失败状态并通过既有分账事务原路退款。网页刷新和 QQ 任务轮询都直接恢复已存在的任务，不依赖请求连接继续等待增强响应；backend 启动时会恢复仍为 `prompt_assist=running` 且从未进入 `dispatch` 的持久化任务，进程重启不会遗留永久等待任务。

## 管理后台图库标签接口

`GET /admin/gallery-tags/overview` 必须使用 admin JWT。backend 返回图库标签总数、任务标签关联数、公开成功图片已打标和待打标数量、自动打标队列分状态计数、最近打标任务、公开热门标签和配置摘要。配置摘要不返回 API Key 明文，只返回是否已配置，并返回 `gallery_auto_tag_max_attempts` 对应的标签生成失败最大尝试次数。

`POST /admin/gallery-tags/run?limit=3` 必须使用 admin JWT。该接口复用真实图库自动打标服务处理少量 pending/failed 任务，`limit` 限制在 1-10；多图批次只处理固有顺序的图一标题和标签，其他同批最终图不单独调用视觉模型；只写 AI 标题配置、`gallery_tags`、`generation_task_tags` 和 `gallery_tagging_jobs`，不修改余额、任务主状态、图片文件或图库隐私。AI 标题由最终图片和提示词汇总成短标题，只用于图库封面展示，不替换原始提示词；标签由最终图片和提示词共同判断，尽量覆盖主体、特征、场景、风格、构图和氛围等简短中文标签。

## 绘图模型设置接口

`GET /admin/drawing/model-settings` 必须使用 admin JWT。backend 从 drawing-service 读取当前真实启用站点模型，再合并 `system_configs.drawing_model_settings`，返回与 `/api/drawing/models` 相同的 `{ models, defaultModel }` 结构。该接口不允许手工伪造不存在于站点配置中的模型。

`PUT /admin/drawing/model-settings` 必须使用 admin JWT。请求体为 `{ defaultModel, models: [{ name, requestModelNames, label, aliases, weight, price, type, maxAttempts, storyboardDesignEnabled, isDefault }] }`，其中 `name` 是已登记的统一主模型名，`requestModelNames` 只能填写已由站点登记、且与主模型能力和计费相同的其他真实上游模型 ID；同组模型在用户端只返回一项，Worker 调用时仍发送命中站点配置的真实模型 ID。`maxAttempts` 限制为 1-10 且表示每个任务最多调用上游的总次数，`1` 表示失败后不重试；`storyboardDesignEnabled` 只对视频模型生效，历史视频模型缺省时默认开启。backend 保存模型价格、能力类型、尝试次数、视频分镜开关、外显名、输入别名、等价请求模型名、外显权重和默认模型，同时同步旧 `drawing_default_model` 作为兼容兜底，并清理前台、Bot 和模型列表缓存。

QQ Bot 端 `/模型` 强制读取当前模型外显顺序并返回 `序号-外显名 -别名`；`/模型 序号` 通过内部接口按 QQ 号持久化首选模型。`/绘图` 支持 `m序号` 临时指定本次模型，支持与 `n数量` 任意前后顺序组合，例如 `/绘图 m1 n2 提示词`、`/绘图 n2 m1 提示词`，参数会按最新 `/api/drawing/models` 序号解析为真实 `preferredModel` 和 `count` 后提交 backend；未带 `m序号` 时读取该 QQ 已保存的首选模型。Bot 提交回执、最终回执、重试卡片、失败卡片和任务列表只展示模型外显名；外显名缺失时取第一个别名，最后才兜底真实模型 ID。

Bot 和 Web 的单图、多图任务都必须在创建任务的同一数据库事务中写入 `task_generation_params_<taskId>` 调度快照，至少包含 `{ model, size, quality, maxAttempts }`。drawing-service 直推和 drawing-worker 轮询兜底都必须使用同一快照中的模型与尝试上限，避免提交回执、进度展示和实际上游执行口径不一致。

上游任务级重试对 429/502/503/504 使用至少 5 秒起步的指数退避，并优先遵守响应头 `Retry-After`；不得在同一秒连续耗尽全部尝试。其他可重试错误使用后台同站重试等待配置作为基础间隔，最终失败继续沿用事务化原路退款。

## 导航工作台接口

`GET /api/workbench/conversations`、`POST /api/workbench/conversations`、`GET /api/workbench/conversations/:id`、`DELETE /api/workbench/conversations/:id`、`POST /api/workbench/conversations/:id/messages`、`POST /api/workbench/conversations/:id/messages/stream`、`POST /api/workbench/conversations/:id/messages/:messageId/decision`、`POST /api/workbench/attachments` 和 `GET /api/workbench/attachments/:id` 必须使用用户 JWT。工作台会话和消息写入 `workbench_conversations`、`workbench_messages`，附件图片写入 backend 本地私有目录和 `workbench_attachments`，用于保存网页多上下文窗口，backend 或浏览器刷新后仍可恢复。删除会话只允许删除当前用户自己的工作台上下文窗口，会级联删除该窗口的工作台消息和附件记录，并安全清理附件本地文件；不会删除已经创建的真实生成任务、图库图片、余额或钱包流水。工作台按 AI Agent 设计：发送消息后 backend 只调用后台 `workbench_ai_*` 独立配置的真实 OpenAI 兼容 `chat/completions`，由模型使用 tools/function calling 在 `submit_image_generation_task`、`inspect_generation_task`、`respond_without_tool` 中自主三选一，不复用图片反推或其他工具的模型配置、系统提示词或开关；若本轮或历史上下文存在图片，backend 会先给 AI 一个只含图片 ID、来源、时间和文字摘要的索引，让 AI 选择本轮真正需要读取的少量图片，后续路由和普通回复只把被选图片内容作为多模态输入，不会一次性上传所有上下文图片。用户只说“重新生成、再生成一次、再来一张、换一张”时，backend 会强制清空历史图片选择并让 Agent 沿用最近文字主题生成新的文生图方案；只有用户明确说基于、参考、优化、重绘或修改上一张图时，才允许带历史结果图进入图生图。若上游不支持 tools 或没有返回有效工具调用，仍继续由同一 AI 使用 JSON mode 输出路由结果，不使用本地正则或关键词规则判断。明确生成图片或用户对上文最终绘图方案说确认生成、开始吧、可以、OK 等承接确认时，Agent 通过 `submit_image_generation_task` 生成 2-4 个待确认绘图方案，前端展示方案标题、说明、模式、参考图和完整 Prompt；所有候选 Prompt 必须符合 [工作台绘图提示词规范](workbench-prompt-guidelines.md)，独立完整地覆盖主体、场景、构图、风格、光影、细节、质量和约束，禁止使用同上、省略、确认流程、余额或任务说明作为真实绘图 Prompt；AI 选择图生图时，backend 会把 AI 选中的当前或历史工作台附件转存到 media-service `ref_` 参考图链路，并把 `mode/sourceImageUrls/sourceImageSizes` 保存到工具调用 JSON 中，确保刷新后仍能确认提交。只有用户在 `POST /api/workbench/conversations/:id/messages/:messageId/decision` 中选择具体 `optionId` 并允许后，backend 才调用真实 `GenerationsService.createTask` 提交文生图或图生图任务，继续沿用现有鉴权、余额、限流、模型校验、参考图存在性校验、扣费和绘图调度链路；用户要求查看任务详情、进度或失败原因且提供任务 ID 时，Agent 通过 `inspect_generation_task` 调用当前用户自己的任务查询工具读取 `GenerationsService.findTasks` 结果；AI 选择 `respond_without_tool` 时才进入普通文本回复。每条 assistant 消息会记录工具类型、工具调用原因、模式、参考图、完整 Prompt、任务 ID、模型、张数、隐私和错误摘要。绘图建议确认接口负责最终提交，拒绝不扣费、不创建任务；多方案必须选择 `optionId`，旧单 Prompt 建议允许后才提交同一份 Prompt。前端工作台会收集当前窗口消息关联的任务或批次 ID，使用 `/api/generations/tasks` 轮询当前登录用户自己的任务状态，在消息内展示排队、运行、收尾、失败和成功结果缩略图；同批任务全部终态后停止轮询，不新增写入、不绕过任务权限。

`POST /api/workbench/conversations/:id/messages/stream` 使用 `text/event-stream` 返回 `run_started/status/tool_start/tool_result/delta/done/error` 事件：每条用户消息会创建一个持久化 Agent Run，并把接收消息、整理上下文、AI 规划/路由、工具执行和流式回复等阶段写入 `workbench_agent_runs`、`workbench_agent_steps`，这些记录只保存阶段摘要，不保存模型隐藏推理。`run_started` 用于让前端立即绑定本次运行；`status` 用于展示连接建立、上下文整理、规划、AI 路由、上游文本流等等待点；`tool_start/tool_result` 用于展示绘图方案生成或任务查询工具的开始和结果；普通文本回复在 AI 选择 `respond_without_tool` 后通过 `delta` 逐段返回上游模型文本；工具调用可没有 `delta`，直接在 `done` 中返回已持久化会话详情，生成工具成功时返回待确认方案且 `generation` 为空，用户确认后才由确认接口返回真实 `generation`。

工作台消息视图中的 `agentRunId/agentRunStatus/agentElapsedMs` 来自持久化 `workbench_agent_runs`。后端会把 assistant 消息关联到其前一条用户消息的最新 Agent Run，`agentElapsedMs` 按 0.1 秒精度归一化，终态刷新页面后仍可恢复；运行中的临时前端耗时仅用于即时反馈，最终以 `done` 返回的持久化耗时为准。

`POST /api/workbench/conversations/:id/messages/:messageId/retry/stream` 使用同一组 SSE 事件，只允许重试当前用户自己的失败 assistant 消息。backend 会定位该失败消息前一条用户消息，重置并覆盖这条失败 assistant 消息后重新执行 Agent；该入口不新增用户消息、不删除上下文、不扣费，只有重试后用户再次确认绘图方案时才进入真实生成扣费链路。

## 服务间接口

- `POST /api/drawing/generate`
- `GET /api/drawing/models`：返回 `{ ok: true, data: { models, defaultModel } }`。`models[]` 使用共享契约 `DrawingModelOptionView`，包含统一主模型名、等价请求模型名、外显名、输入别名、外显权重、模型价格、模型级最大尝试次数、视频分镜开关、默认标记、类型、图片/文本能力、合并后的启用站点和推荐标记；`name` 是用户选择和任务快照使用的主模型名，`requestModelNames` 是仅供站点调度映射的等价真实模型 ID。用户前台、管理后台任务展示和 Bot 回执展示主模型及真实尝试模型时统一使用同一 `label`，缺失时用 `aliases[0]`，最后才兜底 `name`。API 站点管理继续按站点保存真实上游模型 ID，每个模型独立选择格式和参考图数量；图片字段与超限策略继续由对应格式的真实默认值管理。
- `GET /api/drawing/site-info`
- `GET /api/drawing/site-stats`
- `POST /internal/generations/sub-tasks`
- `POST /internal/generations/status`
- `GET /internal/worker/pending-tasks`
- `POST /internal/worker/claim-task`
- `POST /internal/worker/finalize-task`
- `POST /internal/worker/report-image-saved`
- `POST /internal/worker/report-ref-images`
- `POST /internal/onebot/events`
- `GET /internal/bot/batches/:batchId/result`
- `POST /internal/bot/batches/:batchId/notification-claim`
- `POST /internal/bot/batches/:batchId/notification-sent`

Bot 图片和视频最终媒体投递都通过 `POST /internal/bot/tasks/:taskId/delivered` 幂等记录 `result_delivered`。`GET /internal/bot/finalizing-tasks` 除恢复等待确认的图片外，也返回已经成功但尚无投递记录的视频及其真实媒体规格，供 bot-service 在本地 pending 文件丢失或服务重启后按原会话补发。
- `POST /internal/wsproxy/claim-endpoint`
- `POST /internal/wsproxy/mark-bot-seen`
- `POST /internal/qq/verify-binding`
- `POST /internal/qq/balance`
- `GET /internal/drawing-config`
- `GET/POST /internal/ops/protected-media-files`
- `POST /internal/tools/image-reverse/extract`：Bot service 使用 `x-service-token` 调用的图片反推入口，请求体和 `x-aiimage-reverse-mode` 与用户端反推接口一致，不保存图片、不扣费。
- `POST /internal/tools/image-upscale/run`：Bot service 使用 `x-service-token` 调用的图片放大入口，请求体和 `x-aiimage-upscale-options` 与用户端同步放大接口一致；内部入口强制不保存图库、不写钱包、不扣费，供 QQ `/放大 [2|3|4]` 对引用或同消息首张图片进行放大。Bot 命令会先返回“已开始”回执，再由后台主动推送最终放大图，避免 GPU 耗时占满 OneBot 事件等待窗口。

服务间写接口必须带 `x-service-token`，本地开发可按环境变量策略放宽。

## 下线接口

以下入口已从源码、前后台页面和部署脚本移除：

- `/workflow`
- `/api/workflows`
- `/admin/workflow/*`
- `/api/workflow-local-tasks`
- `/admin/local-inference/*`
- `/internal/local/*`
- `/internal/local-inference/*`
- `/internal/ops/repair-stale-local-runs`
- `/worker/run-local-inference-health`
- `/worker/run-local-run-stale-repair`

这些入口不得在新功能中复用；如误请求，应返回 `404` 或未注册路由错误，不应落入鉴权、扣费、任务、图库或媒体链路。

## 排行榜接口

`GET /api/leaderboards/users/tasks` 返回公开用户任务排行榜。当前 `kind=most_tasks` 表示最多调用，`range` 支持 `24h`、`7d`、`30d`、`all`，默认 24 小时；`limit` 默认 50，最大 100。统计只读取 `generation_tasks` 主任务，不读取子任务或上游尝试。Web 用户任务和该用户已绑定 QQ 的 Bot 任务会合并为同一个网页账号；未绑定网页账号的 Bot QQ 会作为 Bot 用户单独上榜。响应展示昵称、账号类型、展示头像 URL、总任务、成功、失败、非终态和按真实来源拆分的调用次数；未绑定 QQ 的 `accountKey` 使用哈希，不返回邮箱或余额。

## 用户头像接口

Web 用户头像由 backend 独立管理，只保存在生产本地 `USER_AVATAR_STORAGE_PATH`（默认 `/v3/local/user-avatars`），不进入 media-service 的生成图/参考图链路。`GET /auth/me` 与 `GET /api/users/profile` 返回 `avatarUrl`；前端外显头像按“网页头像 > 已绑定 QQ 头像 > 用户名首字符”解析。QQ 头像只作为展示回退，不写入 `users.avatar_filename`。

## 用户资料接口

`GET /api/users/profile` 返回当前登录用户自己的资料页数据。`PUT /api/users/profile` 接收 `{ username }` 修改当前登录用户的站内公开用户名，规则与注册一致：2-32 位中英文、数字或下划线；backend 会校验唯一性，成功后返回最新 `AuthUser` 并清理用户资料缓存。

## 邮箱绑定接口

`POST /auth/bind-email` 只允许已登录且邮箱未验证或未绑定的用户提交 `{ email }`，backend 校验邮箱唯一性后写入新邮箱、失效旧验证/重置 token 并发送新的验证邮件。`DELETE /auth/email` 只允许未验证邮箱解绑；解绑后数据库写入内部占位邮箱以满足唯一必填约束，对外 `AuthUser.emailBound=false` 且 `email=""`。已验证邮箱不能直接解绑或换绑，避免绕过账号安全和密码找回边界。

## 用户公开主页接口

`GET /api/users/:id/public-profile?page=&pageSize=` 返回指定 Web 用户的公开主页。`:id` 是固定数字用户 ID，前端公开路径为 `/users/:id`。接口只返回用户名、展示头像、创建时间、公开成功图片统计和公开成功图片分页，不返回邮箱、余额、角色、权限或完整 QQ 号。公开作品只统计 `generation_tasks.user_id=:id`、`status=success`、`is_private=false` 且存在 `task_image_*` 真实图片配置的主任务。

## 模板 AI 接口

`GET /api/templates` 使用用户 JWT，支持 `my=true`、`favorite=true`、`source=copies`、`search`、`page`、`pageSize`。收藏筛选在服务端数据库分页前执行，响应中的 `total` 始终对应当前筛选条件。

`POST /api/templates/ai/convert` 使用用户 JWT，接收 `{ prompt }`。backend 从后台 `template_ai_*` 配置读取启用状态、OpenAI 兼容 API Base URL、API Key、模型、温度、超时和系统提示词，调用真实 `chat/completions` 后校验输出。该接口只生成草稿，不创建模板、不扣费、不写图库。

## 邀请奖励接口

邀请奖励由 backend 负责最终写入。`GET /api/referrals/me` 返回当前用户的邀请码、邀请链接、奖励配置、自己的被邀请状态和邀请统计；接口会懒生成邀请码。`POST /api/referrals/apply` 允许已登录用户在充值页使用他人邀请码，每个用户只能使用一次，不能使用自己的邀请码；邮箱已验证时同事务立即给双方 Web 用户钱包写入付费余额奖励，否则保持 `pending_email`，等待邮箱验证。

## 钱包流水接口

`GET /api/wallet/status` 返回当前登录 Web 用户自己的网页钱包和已绑定 QQ 钱包的可访问余额。`GET /api/wallet/ledger?page=&pageSize=&type=&balanceKind=&source=&dateFrom=&dateTo=` 返回同一组可访问钱包的流水分页，包含免费余额和付费余额的每日发放/重置、卡密充值、生成扣费、失败退款、后台调整和邀请奖励；每条流水返回写入后的免费/付费余额。接口不返回卡密明文、哈希、其他用户钱包或未绑定 QQ 钱包记录。
