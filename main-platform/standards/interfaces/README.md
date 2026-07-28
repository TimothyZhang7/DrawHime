# 接口类型登记

本文件是当前接口类型登记表。字段细节以 `packages/shared-contracts/src` 和实现代码为准；新增接口前必须先更新本表。

工作流已下线，`packages/shared-contracts` 不再导出相关契约，业务程序不得新增或恢复相关跨程序接口。

独立本地模型平台属于新建的独立子系统，可以在 `apps/local-model-platform/` 内新增跨程序接口，但新增前仍必须先在本文件登记，再落到 `packages/shared-contracts`。

## 已落地导出

| 分组 | 共享包路径 | 内容 |
|---|---|---|
| common | `common/*` | API 响应、错误码、分页、健康检查 |
| status | `common/status-contracts.ts` | 公开服务状态页、任务状态分布、站点运行统计、Bot 和平台概览 |
| auth | `auth/*` | 用户、会话、认证上下文 |
| users | `users/user-avatar-contracts.ts`, `users/user-appearance-contracts.ts`, `users/user-profile-contracts.ts`, `users/user-public-profile-contracts.ts`, `users/user-privacy-contracts.ts` | Web 用户资料读取和用户名修改、Web 用户本地头像上传/删除响应、全站背景图与用户显示偏好，Web 用户公开主页，Web/Bot 两端默认图片隐私偏好查询和更新 |
| tools | `tools/tools-contracts.ts` | 用户端工具入口、启用状态、工具默认参数配置和图片反推结果 |
| LoRA 打标工具 | `tools/lora-captioning-contracts.ts` | 主站工具页通过同源 `/local-model-api` 身份交换访问独立平台训练集、图片、全量或单图自动打标、标签保存、确认、翻译结果、训练集 ZIP 与触发词规则；触发词独立持久化且不改写用户确认 Caption，训练提交时仅在 Runtime 请求中补充缺失触发词；汇总同时返回精确公共标签、同义归一化稳定共识标签与用户触发词并集 |
| lora | `lora/lora-contracts.ts` | LoRA 仓库列表、用户上传草稿、示例图、模型选项、发布和下载状态 |
| bot | `bot/bot-command-contracts.ts` | Bot 命令触发词、卡片类型和图片/文字返回格式配置 |
| drawing | `drawing/drawing-contracts.ts`, `drawing/drawing-model-contracts.ts`, `drawing/site-model-contracts.ts` | 绘图提交、接收、任务响应、模型列表、模型能力和站点模型参考图能力 |
| gallery | `gallery/gallery-contracts.ts` | 图库列表、图片详情、多图批次子页面、浏览记录、用户图库批量下载请求和临时 zip 下载响应；单图由前端直接下载原图 |
| leaderboard | `leaderboard/leaderboard-contracts.ts` | 用户任务排行榜、时间范围、按来源拆分统计 |
| media | `media/media-contracts.ts` | media-service 内部运行时配置 |
| ops | `ops/ops-contracts.ts` | 本地媒体目录统计、后台存储巡检 |
| qq | `qq/qq-binding-contracts.ts` | QQ 绑定与余额查询 |
| recharge | `recharge/recharge-contracts.ts` | 卡密兑换、Bot 按 QQ 兑换 |
| referral | `referral/referral-contracts.ts` | 用户邀请码、邀请关系、邮箱验证后双方付费余额奖励 |
| template | `templates/template-contracts.ts` | 模板 CRUD、收藏、AI 普通提示词转模板草稿 |
| wallet | `wallet/wallet-contracts.ts` | Web/QQ 独立钱包状态、绑定共享余额摘要 |
| workbench | `workbench/workbench-contracts.ts` | 网页导航工作台会话、消息、附件、多模态交流和对话式绘图工具调用 |
| wsproxy | `wsproxy/*` | OneBot 事件、wsproxy 端点、内部 OneBot API 代调 |
| local-model-platform | `local-model/*` | 独立本地模型平台的模型注册、主机、Provider、训练、生成、资产扫描和资产契约 |
| local-model-platform config | `local-model/*` | 独立本地模型平台的扫描根目录、目录映射、本地运行器配置、配置持久化与默认值 |
| local-model-platform validation | `local-model/*` | 独立本地模型平台的资产就绪摘要、生成提交前校验和 LoRA 训练提交前校验；缺模型或未配置真实执行器时必须返回失败响应，不得创建假任务 |
| local-model-platform runs | `local-model/*` | 独立本地模型平台的生成任务和 LoRA 训练任务本地队列；创建前必须通过真实资产与运行器校验，worker 可消费队列并按真实脚本退出码写回状态，不伪造成功结果 |
| local-platform integration | `integration/local-platform-integration-contracts.ts` | 主站 JWT 到独立平台会话的服务端交换；主站只返回身份摘要，不下发密码、JWT 密钥或余额副本 |

### 独立本地模型记录删除同步

- 调用方：主站 backend 与独立本地模型平台 API。
- 主站用户删除：`DELETE /api/generations` 发现 `LocalPlatformGalleryPublication.mainTaskId` 后，以 `x-local-platform-token` 调用独立平台 `DELETE /internal/gallery-publications/:externalTaskId`；独立平台将已结束推理任务软删除，失败时主站不删除单边图库记录。
- 独立平台用户删除：`DELETE /v1/inference/jobs/:id` 先以服务凭证调用主站 `DELETE /internal/integrations/local-model/generations/:externalTaskId`，主站删除正式图库任务、媒体参数快照与发布镜像，再隐藏独立平台任务。
- 成功响应：`{ ok: true, data: { externalTaskId, deleted } }`；所有路径保留余额、钱包预留、分账、训练和 LoRA 审计。

## 待补齐或需核对

| 分组 | 需要的契约 |
|---|---|
| admin | 仪表盘、用户、站点、配置 |
| gallery | 点赞状态切换响应 |
| recharge | 批次、余额、管理总览 |
| media | `POST /media/upload`、`POST /media/generate-thumbnail`、`GET /media/files/:filename`、`GET /media/local-files`、`GET /media/storage-stats` |

## 命名规则

- 请求类型以 `Request` 结尾。
- 响应类型以 `Response` 结尾。
- 页面/列表对象以 `View` 结尾。
- 内部事件以 `Event` 或 `Payload` 结尾。
- 所有时间字段使用 ISO 字符串。
- 金额字段对外优先使用字符串，避免浮点误差。

## API 响应规则

```ts
type ApiDataResponse<T> = { ok: true; data: T };
type ApiErrorResponse = { ok: false; code: string; message: string };
```

业务代码不得本地重复定义跨程序 DTO。

## 近期补充

- legacy-local-exit：`GET /api/drawing/models` 不再返回 `apiMode=comfyui_generation` 的模型；`POST /api/generate` 与 `POST /internal/bot/generate` 在创建任务、扣费前校验模型仍属于主站启用目录。主站 LoRA 列表、示例图和下载继续只读服务历史资产，草稿、上传、发布、删除端点固定返回 HTTP `410` 与 `code=local_model_platform_required`；新的本地推理和 LoRA 写入统一进入独立平台。
- local-platform/auth：`POST /internal/integrations/local-model/auth/exchange` 同时校验用户 JWT 与 `x-local-platform-token` 服务凭证，返回 `LocalPlatformIdentityExchangeResponse`。独立平台使用该身份摘要创建自己的短期会话；接口不返回主站 JWT、密码哈希、余额或钱包流水。
- local-platform/billing：`PUT /internal/integrations/local-model/prices` 发布 `image` 或 `training_job` 主站价格镜像；`POST /internal/integrations/local-model/billing/reservations` 按镜像价格预留身份钱包；`POST /internal/integrations/local-model/billing/reservations/:id/commit|release` 幂等提交或原路释放。请求不接受直接扣款金额，余额最终写入和分账均在主站事务内完成。
- local-platform/migration：`GET /internal/integrations/local-model/migration/snapshot` 只读导出已发布 LoRA 元数据；`GET /internal/integrations/local-model/migration/loras/:id/file` 与 `/examples/:id` 按固化 SHA-256 流式导出文件。全部端点校验 `x-local-platform-token`，不导出密码、余额、卡密或其他用户私有数据。
- local-platform/gallery：`POST /internal/integrations/local-model/generations/:externalTaskId/publish` 仅在对应主站资金预留已经提交后发布正式图库记录；请求分别携带最终正面提示词与可空的用户负面提示词，主站将两者独立固化到任务参数快照。主站从独立平台固定内部地址的 `GET /internal/artifacts/:artifactId/content` 流式读取产物并校验 SHA-256 与字节数，再经 media-service 保存原图和缩略图；`externalTaskId + sha256` 与幂等键均唯一，失败不得创建空图库任务。
- local-platform/bot：`GET /internal/bot/local-models`、`POST /internal/bot/local-generate` 由 bot-service 经 backend 调用；backend 再使用独立平台服务凭证访问 `GET /internal/bot/catalog`、`POST /internal/bot/jobs` 与 `GET /internal/bot/jobs`。QQ 身份只以 `walletOwnerType=qq` 进入主站钱包预留，独立平台负责任务、GPU 与产物，主站负责 QQ 可访问钱包和正式图库。

- drawing：`DrawingStatus` 增加 `finalizing`，表示生成原图已经本地保存且网页可读取，但 Bot 最终图片仍在投递确认中。
- worker/internal：最终生成图通过 `POST /internal/worker/report-image-saved` 回写 `task_image_*` 本地配置；生成原图不压缩，缩略图由 media-service 生成中压缩本地文件。
- worker/internal：`POST /internal/worker/report-ref-images` 兼容旧 `{ filenames }`，新增可选 `statuses`。backend 将 `generation_tasks.source_image_urls` 更新为 `/images/<filename>`，并把 `task_ref_images_<taskId>` 写成本地状态对象。
- media/internal：`GET /media/local-files` 返回当前本地实际存在的安全短文件名；`GET /media/storage-stats` 返回本地目录占用。media-service 不再注册远端上传、远端清理或远端副本删除接口。
- media/internal：`POST /media/upload` 支持图片二进制直传和旧版 JSON base64；二进制直传通过 `Content-Type: image/*`、`x-aiimage-prefix`、`x-aiimage-max-bytes` 传递前缀和压缩上限，旧版 JSON 可选 `maxBytes`。`ref_` 参考图接收 PNG、JPEG/JFIF、WebP、GIF、AVIF、TIFF、SVG，按真实文件签名与 Sharp 解码双重校验，自动应用 EXIF 方向、动图只取首帧，并统一输出 `image/png`、`.png` 和 3MB 内任务输入版；`img_` 最终生成原图不得传 `maxBytes`，media-service 必须保持原图字节不压缩。
- media/internal：`GET /internal/media-config` 返回 `MediaRuntimeConfigResponse`，media-service 使用后台 `thumbnail_width`、`thumbnail_quality`、`image_max_file_size_mb`、`image_max_resolution` 作为缩略图和本地写入限制，环境变量只作为读取失败兜底。
- admin/storage：`GET /admin/storage/overview` 返回 `AdminStorageOverviewResponse`，必须使用 admin JWT。backend 代理 media-service `/media/storage-stats` 和 ops-worker `/worker/status`，聚合本地媒体目录占用、磁盘容量、清理统计和错误摘要。
- ops/internal：`GET/POST /internal/ops/protected-media-files?completedGraceMinutes=30`，ops-worker 查询仍被 queued/running/finalizing 或近期完成任务引用的媒体短文件名；本地文件是唯一副本，`deletableArchivedFilenames` 固定为空。
- status：`GET /api/status?range=1h|24h|7d` 返回 `PublicStatusResponse`；公开状态页只使用服务 `/health` 探活和数据库聚合真实数据，失败数只统计主任务 `status=failed`。
- gallery：`GET /api/images/:filename/detail` 返回作者展示字段，不返回邮箱、余额、权限以外的私有资料。
- gallery/local-model：图库列表与 `GET /api/images/:filename/detail` 对独立本地模型作品返回可选 `localModel` 快照，包含任务固化的模型外显名以及 LoRA 版本 ID、标题、类型、权重、主站封面代理地址和基于版本 ID 的唯一详情地址；普通主站绘图不返回该字段，历史作品展示不跟随 LoRA 后续改名或下架变化。
- gallery/local-model-cover：`GET /api/images/:filename/loras/:versionId/cover` 先校验图库可见性和任务固化的 LoRA 版本，再以服务凭证读取独立平台 `GET /internal/gallery-publications/:externalTaskId/loras/:versionId/cover`，只代理真实图片字节，不向浏览器暴露服务凭证或对象存储地址。
- gallery/local-model-live：`GET /api/images/:filename/loras` 校验图库可见性后代理独立平台任务 LoRA 实时元数据和任务独立保存的用户负面提示词；版本 ID 和任务权重保持历史固化，标题与类型读取当前 LoRA 条目，响应禁止共享缓存。
- gallery：`GET /api/gallery?search=` 支持聚合搜索，动态接口仍返回 `{ ok: true, data }`。
- gallery：`GET /api/gallery` 返回 `GalleryListResponse`。单图项目 `galleryKind=image`，多图批次聚合为一个 `galleryKind=batch` 项目；顶层 `id` 是图库入口 ID，`taskId` 是代表单图任务 ID，`images` 返回卡片预览用最终图资产。
- gallery：`GET /api/images/:filename/detail` 返回 `GalleryImageDetailView`。`:filename` 可为任务 ID、批次 ID、原图文件名或缩略图文件名；当任务属于 `batchTotal>1` 时详情会返回同批次所有当前访问者可见的成功最终图，并用 `selectedImageId` 标识默认选中图。
- gallery：`GalleryItemView` 和 `GalleryImageAssetView` 返回 AI 封面短标题 `title` 与中文标签 `tags`，标题由最终图片和提示词汇总生成，只用于封面展示，不替换原始提示词；标签只描述最终图片可见内容，并参考提示词补足主体、特征、场景、风格、构图和氛围等短标签；多图批次只读取固有顺序图一的标题与标签并复用到同批最终图，不逐张图片生成或查询独立标签；`weight` 决定前端展示顺序，颜色由后端首次创建标签时写入 `gallery_tags` 并保持同名标签全站一致。`GET /api/gallery?tag=标签名或slug` 兼容旧版单标签筛选，`GET /api/gallery?tags=标签1,标签2&tagMatch=any|all` 支持多标签任一命中或全部包含筛选，`GET /api/gallery?mode=image-to-image&i2iKind=describe|replace` 支持图生图描述生成/替换生成细分筛选，`search=` 同时匹配提示词和标签中文名。
- gallery：`GET /api/gallery/tags/popular?limit=24` 返回 `GalleryPopularTagsResponse`，只统计公开、成功、已有图片配置且标签未禁用的图库代表任务；多图批次只按图一计数，`count` 是公开使用数，不能包含私密图标签。
- gallery/internal：`POST /internal/gallery/tagging/run?limit=3` 使用 service token，供 ops-worker 处理图库自动打标队列。多图批次只处理固有顺序图一，历史队列中的同批非图一任务会被跳过；该接口只写 AI 标题配置、`gallery_tags`、`generation_task_tags` 和 `gallery_tagging_jobs`，不修改余额、任务主状态、图片文件或图库隐私。
- gallery：`POST /api/images/:filename/view` 记录图片浏览，响应使用 `GalleryImageViewResponse`。
- gallery：`POST /api/gallery/bulk-downloads` 接收 `GalleryBulkDownloadRequest`，仅在至少 2 张时打包当前登录用户自己的成功图片，返回 3 小时内可下载的临时 zip 地址。
- leaderboard：`GET /api/leaderboards/users/tasks?kind=most_tasks&range=24h|7d|30d|all&limit=50` 返回 `UserTaskLeaderboardResponse`；公开排行榜只统计 `generation_tasks` 主任务。
- users/public-profile：`GET /api/users/:id/public-profile?page=&pageSize=` 返回 `UserPublicProfileResponse`。该接口公开访问，只返回用户公开资料和公开作品分页。
- users/profile：`GET /api/users/profile` 返回当前登录用户资料页数据；`PUT /api/users/profile` 接收 `UpdateUserProfileRequest` 修改当前登录用户的公开用户名，成功后返回最新 `AuthUser`，并清理用户态缓存。
- users/avatar：`POST /api/users/me/avatar` 使用用户 JWT 接收单张最大 5MB 的 PNG/JPEG/WebP 二进制图片，backend 压缩裁剪为本地 WebP，响应 `UserAvatarUploadResponse`。
- users/appearance：`GET /api/appearance` 公开返回 `SiteAppearanceView`；`GET/PATCH /api/users/me/appearance` 使用用户 JWT 读取或修改当前用户的背景图显示偏好。`POST /admin/appearance/background` 使用 admin JWT 接收单张 PNG/JPEG/WebP 二进制图片，backend 压缩为本地 WebP 后原子更新 `site_background_filename`，再删除旧文件；`DELETE /admin/appearance/background` 只删除当前背景文件和文件名配置。全局 `site_background_enabled=false` 时所有用户都不加载背景图，开启时仍尊重用户个人开关。
- auth/email：`POST /auth/bind-email` 接收 `{ email }`，仅允许未验证或未绑定邮箱的登录用户绑定新邮箱并发送验证邮件；`DELETE /auth/email` 仅允许未验证邮箱解绑，backend 将邮箱改为内部占位邮箱并失效旧验证/重置 token，不影响余额、QQ 绑定、任务或邀请关系。`AuthUser.emailBound=false` 时 `email` 对外为空字符串。
- wallet：`GET /wallet/status`，登录 Web 用户查询 user 钱包和已绑定 QQ 钱包的可访问余额；未绑定 QQ 也必须返回 user 钱包余额。
- wallet：`GET /api/wallet/ledger?page=&pageSize=&type=&balanceKind=&source=&dateFrom=&dateTo=`，登录 Web 用户查询自己可访问钱包流水分页，覆盖免费余额和付费余额的收入、扣费、退款、后台调整和邀请奖励；返回每条记录后的免费/付费余额，不返回卡密明文、哈希或不可访问钱包。
- recharge：Web 卡密兑换入账 user 钱包，不再要求 QQ 绑定；Bot 卡密兑换入账 QQ 钱包。
- referral：`GET /api/referrals/me` 返回当前用户的邀请码、邀请链接、奖励配置和邀请统计；`POST /api/referrals/apply` 允许登录用户使用他人邀请码。
- wsproxy/internal：`POST /internal/send-action` 用于 bot-service 按 `selfId` 直推 OneBot action，必须等待 OneBot action response 且状态为 `ok` 才视为投递成功。
- wsproxy/internal：`POST /internal/call-api` 使用 `WsproxyCallApiRequest` 和 `WsproxyCallApiResponse`，供 bot-service 按 `selfId` 代调真实 OneBot API。
- bot/internal：`POST /internal/bot/tasks/:taskId/delivered`，Bot 成功发送最终结果后回调 backend，由 backend 将任务置为 `success`。
- bot/internal：`GET /internal/bot/batches/:batchId/result` 返回 Bot 多图批次最终回执数据；仅当 `terminal=true` 时允许 bot-service 汇总发送，详情入口使用 `/image/:batchId`。
- bot/internal：`GET /internal/bot/pending-batches` 返回 `BotPendingBatchResultsResponse`，用于 bot-service 重启或 pending 文件丢失后补发已经终态但尚未标记发送的多图批次最终汇总；`BotBatchResultResponse.deliveryTarget` 记录原群聊/私聊目标，新任务必须优先按该目标恢复，缺失时才退回 QQ 私聊。
- bot/internal：`BotDeliveryTarget` 的群聊目标包含 `groupId/messageId/userId`；最终回执必须先引用原消息，若协议端明确提示原消息不存在或已撤回，bot-service 才把 `reply` 段替换为 `at userId` 重发，避免用户撤回命令后最终图片丢失。
- bot/internal：`GET /internal/bot/finalizing-tasks` 返回 `BotFinalizingTaskRecoveryResponse`，用于 bot-service 轮询恢复已保存原图但尚未确认 delivered 的单任务；响应携带 `deliveryTarget`，新任务必须优先按原群聊/私聊目标补发。
- bot/internal：`POST /internal/bot/batches/:batchId/notification-claim` 抢占批次最终回执发送锁；`POST /internal/bot/batches/:batchId/notification-sent` 在 OneBot ACK 成功或 ACK 不确定但不可重发时标记已处理，避免同一批次重复刷图。
- bot/internal：`GET /internal/generations/by-qq/:qqNumber`、`GET /internal/generations/recent` 返回 `BotGenerationTaskListResponse`，用于 QQ Bot `#任务` 卡片。
- drawing：`DrawingStatus` 增加 `deferred`，仅表示多图批次内等待 backend 释放的单图任务，drawing-service、worker 和外部状态更新接口不得直接写入该状态。
- drawing：`POST /api/generate` 的 `GenerationCreateRequest.count` 表示本次提交生成张数；后端按 `drawing_multi_enabled`、`drawing_multi_count_max` 强校验，`count<=1` 保持单图链路。
- drawing/lora：`POST /api/generate` 可传单个 `GenerationLoraSelection={id,strength}`；浏览器只提交已发布 LoRA ID 与 `0..2` 强度，backend 必须校验模型提示词格式、主模型系列和真实文件后，把标题、SHA-256、GPU 安全文件名及大小固化为 `DrawingLoraSnapshot`。该快照随 `DrawingGenerateRequest` 跨服务传递并供刷新、批量、重试和 Worker 轮询复用；Worker 只通过受保护内部下载接口和 ComfyUI 鉴权同步接口传输文件，校验 SHA-256 后再把 LoRA 节点接入工作流。
- drawing/video：`POST /api/generate` 的 `GenerationCreateRequest` 同时支持 `text-to-video`、`image-to-video`，视频任务固定单结果，使用 `duration=1..15`、`resolution=480p|720p|1080p` 和 Grok 视频七种画幅；可选 `storyboardDesign` 在所选模型允许时默认开启，backend 使用图片反推工具配置的真实 OpenAI 兼容端点和模型，同时分析原提示词、视频参数与全部参考图，重新生成包含时间线、镜头运动、主体动作和连续性约束的视频提示词，不复用图片反推页面的绘图 Prompt。`GenerationTaskView` 通过 `mediaType=video` 与 `videoUrl` 返回结果，不把视频伪装成图片。公开成功视频与图片共用图库入口，但 `GalleryItemView/GalleryImageAssetView` 必须通过 `mediaType/videoUrl/duration/resolution/aspectRatio` 明确表达视频，前端使用 `<video>` 播放，不把 MP4 交给 `<img>` 或图片灯箱。
- drawing/video/internal：backend 向 drawing-service/worker 透传 `DrawingGenerateRequest.duration/resolution`；worker 对 `grok_video_generation` 站点调用 `POST /v1/videos/generations`、轮询 `GET /v1/videos/{request_id}` 并从 `/content` 下载 MP4。`POST /media/upload-video` 原子保存 MP4 与 FFmpeg 首帧 WebP 封面，响应返回 `filename/thumbnailFilename`；worker 再通过 `POST /internal/worker/report-video` 提交 `videoFilename/thumbnailFilename`，backend 将二者持久化到同一 `task_image_*` 快照。
- admin/generations：`GET /admin/generations/:id` 的代表任务和 `tasks[]` 必须返回 `requestParams`，完整包含任务 ID、幂等 ID、来源、模式、完整提示词、参考图、隐私、生成数量、模型、尺寸、画幅、质量、视频参数、分镜开关和模型级尝试次数；该对象仅用于管理员排障，不返回鉴权头、站点 API Key、钱包或余额信息。新任务的尺寸、质量、数量和参考图字节数必须在创建事务内写入 `task_generation_params_*`，历史缺失尺寸和质量时后台按当前兼容默认值展示。
- drawing/sites：内部 `ApiSiteRuntimeConfig.sendResponseFormat` 表示站点是否向 OpenAI Images 文生图请求发送 `response_format`；关闭时 Worker 必须完全省略该字段，不能发送 `auto`、空字符串或 `null`。既有站点迁移默认开启，保持原调用行为。
- drawing/sites：内部 `ApiSiteRuntimeConfig.sendPromptCacheKey` 表示站点是否发送 `prompt_cache_key`。开启时 Worker 使用 `source + Web userId/QQ` 生成稳定 SHA-256 摘要键，同一身份的任务、换站和同站重试必须保持同一键，且不能把原始用户 ID、QQ 或 API Key 写入上游请求；无身份任务才按 `clientRequestId` 兜底。JSON 图片、Grok/BFL、视频请求写入同名 JSON 字段，OpenAI multipart edits 写入同名表单字段。既有站点迁移默认关闭；上游 NewAPI 仍需配置匹配实际图片或视频路径、并从 `prompt_cache_key` 取值的渠道亲和规则。
- media/video：浏览器访问 `/images/*.mp4` 时 backend 必须把单段 `Range` 请求透传到 media-service；media-service 返回 `206/Content-Range/Accept-Ranges/Content-Length`，非法或越界范围返回 `416`。网页视频地址追加稳定视频查询标识以避开升级前已缓存的无 Range 旧响应。
- drawing：`POST /api/generate`、backend 到 drawing-service/worker 的生成请求统一使用可选 `aspectRatio` 表达画幅比例，允许 `auto/1:1/4:5/5:4/3:4/4:3/2:3/3:2/9:16/16:9/9:21/21:9`。`auto` 保持后台默认 `size` 与站点首图尺寸兼容逻辑。站点模型用 `aspectRatioSupport=all/gpt_image/square_only/auto_only` 声明上游实测能力，模型列表聚合可选比例，Worker 必须排除不支持当前显式比例的候选。Worker 以 `aspectRatio` 为优先语义：普通 OpenAI Images 模型转换为 `size=宽x高`，仅支持官方固定尺寸的 `gpt-image*` 模型按方向发送 `1024x1024/1536x1024/1024x1536` 基础尺寸，BFL 与 Grok JSON 格式转换为 `aspect_ratio=宽:高`，不得把某个供应商字段直接作为浏览器请求契约。Worker 必须原样保存上游返回图片，不得为了满足目标尺寸额外放大、裁切或把约 1K 图片标记为 4K；显式比例与上游原图偏差超过 2% 时按上游失败换站，不得交付错误画幅。任务调度参数快照必须保存该字段，轮询恢复、批次延迟释放和复投不得丢失用户选择。
- drawing：`GenerationBatchView` 表示一次多图提交的批次摘要，包含 `id/clientRequestId/status/source/count/concurrency/stopAfterConsecutiveFailures/successCount/failedCount/createdAt/updatedAt`；每张最终图仍由独立 `GenerationTaskView` 表示。
- drawing：`GenerationTaskView` 增加 `batchId/batchIndex/batchTotal`，用于 Web、Bot 和后台识别同批次任务顺序，不改变单图任务语义。
- drawing：`GenerationCreateResponse` 和 `GenerationRecoverResponse` 在多图提交或恢复时返回 `batch` 与 `tasks`；单图响应仍只要求 `task`。
- admin：`GET /admin/generations` 返回 `AdminGenerationListResponse`，多图任务按批次聚合展示；`GET /admin/generations/:id` 返回 `AdminGenerationDetailView`，批次 ID 会展开为同批次真实单图明细；`PATCH /admin/generations/:id/privacy` 和 `DELETE /admin/generations/:id` 必须同时支持批次 ID 与单图 ID。
- admin/gallery-tags：`GET /admin/gallery-tags/overview` 返回 `AdminGalleryTagOverviewResponse`，必须使用 admin JWT。backend 只返回标签统计、公开图库打标覆盖率、队列状态、最近 job 错误摘要和打标配置摘要，API Key 只返回是否已配置；`config.maxAttempts` 来自 `gallery_auto_tag_max_attempts`，控制失败 job 的最大自动重试次数。`POST /admin/gallery-tags/run?limit=3` 返回 `AdminGalleryTaggingRunResponse`，必须使用 admin JWT，并复用真实 `GalleryTaggingService.processPending`；该入口只写 `gallery_tags`、`generation_task_tags` 和 `gallery_tagging_jobs`，不修改余额、任务主状态、图片文件或图库隐私。
- drawing：`GET /api/drawing/config` 返回用户端公开绘图限制，当前包含 `multiEnabled/multiCountMax/maxPromptLength`，不暴露内部 token、站点、价格或重试细节。
- drawing：`GET /api/drawing/models` 返回 `DrawingModelListResponse`，每个 `DrawingModelOptionView` 包含 `name/requestModelNames/label/aliases/weight/price/maxAttempts/storyboardDesignEnabled/isDefault/type/capabilities/sites/enabled/recommended/description/provider`；`name` 是用户选择和任务快照使用的统一主模型名，`requestModelNames` 是能力、价格和外显相同但不同站点要求的等价上游请求模型名。Backend 必须把同组模型聚合成单个用户选项，内部站点配置为真实请求模型派生 `canonicalName`，Worker 按 `name/canonicalName` 匹配候选并继续使用站点真实 `name` 调用上游。`label/aliases/weight/price/maxAttempts/storyboardDesignEnabled/isDefault` 来自后台独立模型设置，其中 `maxAttempts=1..10` 表示该模型每个任务最多调用上游的总次数，`1` 表示失败后不再尝试，`storyboardDesignEnabled` 只对视频模型生效且历史视频模型缺省时默认开启；用户前台、管理后台任务展示和 Bot 回执展示主模型及真实尝试模型时统一优先使用 `label`，缺失时使用第一个 `aliases`，最后才兜底 `name`；每个站点模型必须独立设置 `apiMode`，当前允许 `openai_images`（OpenAI 格式）、`bfl_image_generation`（BFL 格式）、`grok_image_edit_json`（Grok 图片格式）和 `grok_video_generation`（Grok 视频格式）四种生产协议。BFL 图生图向 `/images/generations` 发送无 data URI 前缀的 JSON `input_image`；Grok 图生图向 `/images/edits` 发送 JSON，单参考图使用互斥的 `image: { type: "image_url", url }`，多参考图使用 `images: [{ type: "image_url", url }]`，每个 `url` 必须是完整 data URI，不得合并、截断或改写真实模型 ID。
- Bot 自触发事件：wsproxy 接受 OneBot/NapCat 扩展 `post_type=message_sent`，在投递 bot-service 前规范化为标准 `post_type=message`，并写入 `self_triggered=true`；`user_id` 规范化为当前 `self_id`，私聊原目标另存 `target_user_id`，用于把回复继续发送到原会话。只有不带 `reply` 段的独立消息、明确命令前缀和已登记命令进入现有路由，普通自身输出与命令回执保持静默；群内其他在线 Bot 发出的命令由对应发送 Bot 自己处理，当前连接不得抢占。自触发继续沿用现有钱包、绑定、管理员权限、去重、限流和任务扣费规则。
- drawing/internal：admin 站点模型配置与 `GET /internal/sites/config` 使用共享 `ApiSiteRuntimeConfig`、`ApiSiteRuntimeConfigResponse` 和 `ApiSiteModelOption`；站点级 `autoSizeFromReference=false|true` 只控制 OpenAI Images 图生图在任务 `size=auto` 时原样发送 `auto`，或改传第一张参考图经 EXIF 方向修正、宽高分别向下对齐到 16 像素倍数后的 `宽x高`，显式尺寸和文生图不得改写。`maxReferenceImages=0..8` 是后台每个模型独立设置的业务参考图数量，`referenceImageField=image|image[]` 只用于 OpenAI Images multipart 字段，`referenceImageOverflowStrategy=reject|combine` 明确超限处理。worker 不得静默截断：只有明确配置可合并的单图 OpenAI/BFL 模型允许把全部参考图等比合并成网格图，其余超限模型必须跳过；Grok 单次 JSON edits 原生最多发送 3 个图片对象，配置数量超过 3 时必须使用不拼图的分阶段编辑，每阶段把已有合照与最多两张新增参考图作为独立图片对象发送，最终结果必须保留前序人物并加入新增人物；超过模型配置数量仍明确拒绝。历史未知格式按 OpenAI 格式兼容解析。
- drawing/reference-prompt-assist：独立模型设置的 `referencePromptAssistEnabled` 允许具备文生图能力的 `text_to_image` 和 `universal` 模型开启，默认值为 `false`。模型开启后 Web 与 Bot 默认执行 AI 提示增强，Web 创建请求必须显式传 `referencePromptAssist=true|false` 以允许用户关闭；其他用户入口缺省时由 backend 按模型开关开启，Bot 内部入口同样以显式 `false` 作为关闭信号。该模式接受 0-4 张参考图：无图时只扩写用户文本，有图时把全部图片与提示词交给专用 OpenAI 兼容多模态配置，专用配置为空时兼容复用已配置的图片反推端点。人物数量由用户原始提示词决定；未明确请求两名或多名人物时，backend 和视觉模型只能提取一个主体角色，边缘、裁切、遮挡或局部可见的发丝、手臂、衣物、肩背、倒影和轮廓只可作为主体构图证据，不得生成角色 B、第二角色、人物关系或互动描述；屏幕、海报、相框、镜面、玩偶和雕像不得计入现实角色，同一角色设定页的多姿态不得拆成多人。转写必须核对主体、外观、服装配饰、动作、构图裁切、背景物件、光源方向、材质和画风，只写可见事实，不确定文字、被遮挡细节、真实身份、来源、画师、软件和模型不得猜测。backend 必须在扣费和建任务前完成一个提示增强阶段，把结果固化为 `effectivePrompt`；同一次提交的 `N>1` 任务、drawing-service/worker 上游重试均复用该结果，历史复投也只复用快照，不得再次执行增强阶段。再次提交以 `用户生成要求：` 开头的历史增强结果时必须只恢复最前面的真实用户要求，禁止把旧分段嵌套进新结果。首轮完整结果不得只因本地画风关键词差异触发第二次上游请求；只有成人尺度发生实质偏移时才允许在同一阶段内纠偏。上游快速返回 408/429/5xx 或空响应时只允许在同一总超时预算内重试一次，不得延长同步等待窗口。成功任务时间线必须且只能包含一个 `prompt_assist` 审计步骤；批次各真实主任务记录同一次调用的时间和耗时。任务表、图库和 `task_generation_params_<taskId>` 均保存实际提交的增强提示词，参考图继续保留用于详情展示，drawing-service/worker 只收到增强提示词且不收到参考图。最终提示词必须含“画风与渲染”段及至少四类具体技法证据；有图且用户未指定画风时以参考图1为全局主风格，无图时选择与用户题材一致的明确方案，不得使用泛化标签代替。明确成年角色的成人向/NSFW 请求保留裸体、乳房与乳头可见、亲密互动和成人氛围；最终 `effectivePrompt` 必须经过 backend 的确定性尺度归一，外阴、外生殖器及其解剖细节不得直接呈现、不得特写或成为视觉焦点，只允许通过局部姿势、适度服饰/配饰、前景元素或构图控制下半身可见范围，不得扩大成遮挡乳头、整体穿衣或非成人化。专用同步超时范围为 10-90 秒；增强失败不得建任务、扣费或静默退回原提示词。
- drawing/reference-prompt-assist-submission：Web 与 Bot 的当前权威时序均为先事务创建任务并扣费，再立即返回 `running`，本条替代前述同步建任务时序。初始时间线必须持久化唯一的 `prompt_assist=running`，增强期间不得投递 drawing-service 或创建上游尝试；增强成功后原子固化 `effectivePrompt` 并投递，失败后将任务置为失败并通过任务分账幂等退款。`N>1` 批次只运行一次共享增强，backend 重启必须恢复尚无 `dispatch` 的进行中增强任务。
- drawing/reference-prompt-assist-output：最终 `effectivePrompt` 只能描述一张完整目标图像；多张输入图片仅是内部融合证据，禁止输出图号、逐图说明、原图/参考图对照、分栏方案或不同输入图的独立画面。未指定画风时，第一张主参考图是唯一画风来源，其他图片只能补充与主目标不冲突的角色、构图或物件事实。`gpt-5.6-sol` 调用固定传 `reasoning_effort=xhigh`，以提高视觉识别与画风指纹准确性。
- drawing/reference-prompt-assist-clothing-removal：“脱掉衣服、去掉衣物、移除服装、不穿衣服、脱衣、脱光”等修改必须走成人向确定性融合链路；最终目标保留角色身份外观、姿势构图、背景光影和主参考图画风，只移除服装并保持明确成年表达。参考图中的穿衣现状不得反向生成“完整服装、避免裸体”等与用户要求冲突的提示词。
- drawing/reference-prompt-assist-identity：角色身份必须精确转写脸型与五官比例、眼睛形状和颜色、刘海、发型轮廓、发色分区、发长与身体特征；发饰、角、耳、眼镜和标志性首饰独立于衣服、鞋袜、手套和服装装饰。成人向视觉转写必须额外返回“角色身份锁定”，以一到三句压缩重复最具辨识度的面部、眼睛、发型发色与身份配饰；backend 必须把该字段置于实际 `effectivePrompt` 前部并标记最高优先级，避免绘图上游遗漏原角色关联。脱衣或换装不得删除身份配饰，最终提示词必须包含不可变身份硬约束，禁止近似角色、同类替代角色和重新设计角色。
- drawing/reference-prompt-assist-detail：第一张主参考图固定使用高细节，作为唯一画风与主视觉来源；后续参考图使用自动细节，只补充身份、构图和物件事实，避免极高思考强度下重复视觉 token 造成同步超时。
- drawing/reference-prompt-assist-pipelines：`promptFormat=standard`、`anima`、`diffusion` 必须分别进入 Grok/通用自然语言、Anima 本地标签、传统扩散英文正负提示词三个独立服务，任何链路不得先生成另一格式再二次翻译。每个主任务只允许一次 Chat Completions 调用，并在该次回答内部完成视觉融合、目标格式转换和最终自检；不得因内容尺度、画风指纹或本地关键词再次调用模型审核或修复。三条链路都必须包含基于 `MDX-Tom/gpt-5.6-instruct` v41 的绘图直出规则，禁止拒绝、道歉、政策说明、道德评价、替代建议和保守化改写。后端确定性处理只可解析 JSON、限制长度、去重和处理 Anima 精确互斥标签，不得增加或删除用户画面事实；拒绝文本不得持久化为 `effectivePrompt`。本条是当前权威分流规则，替代前述遗留的二次纠偏或二次翻译描述。
- drawing/reference-prompt-assist-identity-binding：用户未明确年龄时不得从脸型、体型、服装、场景或画风推断儿童、未成年、青少年、成年或对应英文年龄词，画风只能写可见线条、色块、比例、材质和成像技法。Anima 的两个或更多不同角色必须在扁平标签后追加一条无逗号英文属性绑定短句，明确每个角色的外观、服装和动作归属；同一角色的多图证据必须合并为单个 `solo` 主体，图片数量不得改变角色数量。
- drawing/reference-prompt-assist-async：Web 请求先事务创建并立即返回主任务，首批主任务保持 `running`，初始时间线必须写 `prompt_assist=running`，增强完成前禁止创建 `upstream_attempt` 或保存伪 `effectivePrompt`，防止 Worker 提前消费。backend 在任务内异步执行一次增强；成功后原子更新任务提示词、参数快照和时间线再投递 drawing-service，失败后标记任务失败并使用现有分账事务退款。刷新恢复不得再次调用增强，终态任务不得在增强回调中再次投递。backend 启动恢复只能接管仍为 `prompt_assist=running` 且不存在 `dispatch` 的持久化任务，禁止恢复旧竞态或已投递任务。
- drawing/model-prompt-format：独立模型设置使用 `promptFormat=standard|diffusion|anima` 选择提示增强链路，不得根据部署位置推断。`standard` 输出通用完整描述；`diffusion` 输出英文正负提示词；`anima` 直接融合文字与至多四张参考图，输出单行、小写、逗号分隔的 Anima 标签，严格执行槽位顺序、人数一致、互斥去重、标签数量和禁止质量词/画师/光影色调/权重规则。任务参数快照必须保存创建时格式，Bot、Web、批次、重试和进程恢复必须复用同一格式与最终提示词。
- drawing/retry：任务级可重试上游错误不得在同一秒耗尽全部尝试。worker 对 429/502/503/504 使用至少 5 秒起步的指数退避，对其他可重试错误使用后台 `siteRequestDelayMs` 作为基础等待；上游返回 `Retry-After` 时取建议值与本地退避的较大值，单次等待最多 10 分钟。等待前后的任务仍必须通过内部状态检查，已终止任务不得继续调用上游。
- drawing/timeout：Worker 调用上游时以当前站点 `timeoutSec` 为权威超时，OpenAI、BFL 和 Grok 格式均不得再被全局 `requestTimeoutMs` 截短或被协议默认值延长；只有站点超时缺失、非有限数或小于等于 0 时，才允许使用全局值和协议兜底。
- admin：`GET/PUT /admin/drawing/model-settings` 使用 admin JWT，独立维护主模型名、等价请求模型名、类型、单次价格、上游最大尝试次数、视频分镜开关、外显名、输入别名、外显权重和默认模型；同一个真实请求模型名只能归属一个主模型，被归并的旧模型行不再单独外显或维护重复价格。站点新增模型时只登记尚未被主模型或等价请求名覆盖的模型，不覆盖已有价格、尝试次数和分镜开关，站点移除或删除后模型设置必须保留并以 `enabled=false/sites=[]` 返回管理端。用户端 `/api/drawing/models` 只返回当前仍有可用站点的合并模型。Web、Bot 首次生成、批量生成、偏好恢复和复投统一解析为主模型后按模型设置价格扣费，并在创建任务事务内把主模型 `maxAttempts` 固化到 `task_generation_params_<taskId>`；历史 `drawing_price_per_gen` 只作为未登记模型的价格兜底，并同步旧 `drawing_default_model` 保持默认模型兼容。
- drawing/internal：backend 向 drawing-service/worker 传递必填 `DrawingGenerateRequest.maxAttempts=1..10`，Worker 只使用任务创建时固化的模型尝试上限，不读取运行时全局次数；旧任务快照缺失时按 `3` 次兼容。`GET /internal/drawing-config` 返回 `DrawingRuntimeConfigResponse`，供 drawing-worker 和 bot-service 读取其余运行时配置，不再返回全局 `retryCount`；响应包含 `multiEnabled/multiCountMax/multiConcurrency/multiStopAfterConsecutiveFailures` 作为多图生成统一口径。
- bot/internal：`POST /internal/bot/generate` 使用 `BotGenerationCreateRequest`，请求体包含可选 `count/preferredModel/deliveryTarget/storyboardDesign`；QQ 视频任务默认传 `storyboardDesign=true`，最终是否执行仍以后端视频模型开关为准。QQ 命令 `/绘图 m1 n3 提示词` 或 `/绘图 n3 m1 提示词` 由 bot-service 按当前 `/api/drawing/models` 外显顺序强制刷新解析，`m序号` 只影响本次任务的 `preferredModel`，`n数量` 仍按后台配置限制张数、并发和连续失败停止阈值，并保存原群聊/私聊目标用于重启恢复最终回执。
- bot/video：Bot `/模型` 与 `m序号` 同时包含图片和视频模型；选中视频模型时 `/绘图` 按有无参考图提交 `text-to-video/image-to-video`，固定单结果，并支持 `d1..15`、`r480p|720p|1080p`、`a1:1|16:9|9:16|4:3|3:4|3:2|2:3` 参数，默认 `d5 r720p a16:9`。成功后优先发送 OneBot `video` 段，协议端不接收时回退详情链接；Bot 视频复投继续沿用历史任务的视频参数快照。图片和视频最终消息送达或文本兜底送达后都必须通过 `/internal/bot/tasks/:taskId/delivered` 幂等写入 `result_delivered`；`GET /internal/bot/finalizing-tasks` 同时恢复图片 finalizing 和尚无投递记录的成功视频，返回 `mediaType/imageUrl/videoUrl/duration/resolution/aspectRatio`，避免 Bot 本地 pending 文件损坏后永久丢失视频回执。
- bot：`/模型` 返回按当前模型外显权重排序的 `序号-外显名 -别名` 列表；`/模型 序号` 通过 `POST /internal/user-model-pref/:qqNumber` 将该 QQ 的首选模型持久化为对应真实模型 ID，绘图命令未带 `m序号` 时通过 `GET /internal/user-model-pref/:qqNumber` 读取该首选模型；提交回执、最终回执、重试卡片、失败卡片、任务列表和站点状态卡片只展示外显模型名，不把真实模型 ID 直接作为用户可见名称。
- users：`GET /api/user-model-pref` 使用用户 JWT，返回 `UserModelPreferenceResponse`；优先读取用户显式保存且仍启用的模型，缺失或失效时从该用户最新网页绘图任务的调度快照恢复模型，并用 `source=preference|last_task|none` 标明来源。`POST /api/user-model-pref` 使用 `UpdateUserModelPreferenceRequest` 保存当前仍启用的真实模型 ID；生成页点击模型时同时写浏览器本地记忆和该接口，刷新后优先恢复账号偏好或上一个任务模型。Web 单图任务或多图批次创建事务必须同步保存本次真实模型，确保浏览器在任务响应期间断开后仍能恢复最后任务模型。
- bot/internal：`GET /internal/bot/admin-config` 返回 `BotAdminRuntimeConfig`，包含 QQ 端管理员白名单；`POST /internal/balance/adjust` 除 service token 外必须带 `operatorQqNumber`，backend 会校验该 QQ 是否在白名单或已绑定 Web 管理员账号，避免 Bot 端漏判导致余额调整越权。
- bot：`/提取 [描述|tag]` 使用绘图命令同一套 QQ 图片提取链路读取首张图片，不创建任务、不扣费、不返回提交成功提示；成功时只返回图片反推结果，失败时返回明确失败原因。
- bot/internal：`BotGenerationRetryResponse` 增加 `batchId/batchTotal/taskIds`，多图提交回执和复投可返回同批次全部任务 ID；单图可不返回这些字段。
- drawing：`POST /api/generate/retry` 按当前登录 Web 用户的历史任务 ID 重新提交新任务；`POST /internal/bot/generate/retry-latest` 使用 `BotGenerationRetryRequest`，按 OneBot 事件 QQ 号取最近一次任务重新提交，并保存 `deliveryTarget`。两者只复用历史任务参数，新任务仍重新扣费、限流并走真实 drawing-service 调度。
- drawing：`GET /api/generations/cooldown` 使用用户 JWT，返回 `GenerationCooldownResponse`，只读当前登录用户最近一次任务和后台 `drawing_cooldown_seconds`，用于用户端和工作台在冷却期禁用提交按钮；真实冷却仍由创建任务链路再次校验。
- drawing：`GET /api/drawing/config` 返回共享契约 `DrawingPublicConfigResponse`，其中 `maxPromptLength` 直接读取后台 `drawing_max_prompt_length`。生成页和工作台必须在配置返回后使用该值设置计数、输入上限和提交前校验；配置加载期间不设置浏览器固定长度上限，backend 继续执行最终校验，任何页面都不得按前端常量截断提示词。
- tools：`GET /api/tools/config` 返回 `ToolConfigView[]`，包含 `image-splitter`、`image-converter`、`image-scrambler`、`image-wobble`、`image-reverse` 和 `image-upscale` 工具配置；前端用后台配置控制入口、最大文件大小和公开默认参数。`image-converter` 公开 `convertDefaultFormat`、`convertDefaultQuality`、`convertMaxBatchCount`，用于同一页面内的批量格式转换、尺寸缩放和体积压缩。`POST /api/tools/usage` 接收 `ToolUsageRecordRequest`，仅用于浏览器本地工具成功执行后的聚合计数，不上传图片或任务参数；`GET /admin/tools/usage` 返回 `ToolUsageOverviewResponse`，必须使用 admin JWT。图片转换压缩、图片混淆/解混淆和局部抖动都只在浏览器本地处理，不上传图片、遮罩或导出文件，不写入图库。
- 图片反推描述模式：`ImageReverseDescriptionLanguageResultView.drawingPrompt` 固定表示“角色参考图保留迁移提示词”，调用方可搭配不定数量的新角色参考图使用；该字段只迁移反推原图的姿势动作、非角色细节、构图镜头、背景、光影和画风，不携带反推原图角色的脸、发型、眼睛、肤色、体型、服装、配饰、身份或其他外观值。多张参考图展示同一角色时视为多角度和细节证据，只生成一个受参考图控制的主体角色实例，不按图片数量复制；明确展示不同主体角色时分别保持身份，禁止融合；反推场景中明确列出的陪伴生物、环境角色和场景物件仍保留，不受主体参考图数量规则影响。`negativePrompt` 在描述模式中承载自然语言“参考图使用规则 / 生成约束”，而非裸露的负向关键词列表，明确参考图外观优先、主体角色数量语义、同角色多图合并方式、不同角色分离方式以及结构和画质限制。描述栏仍完整返回原图角色客观特征，提示词栏不得再次拼接 `characterPrompt`、`identityAnchors` 或角色质量标签。backend 读取描述模式历史记录时也按同一规则重建返回视图中的两项提示词，但保留数据库原始识图 JSON 作为历史事实。
- tools：`GET /admin/tools/image-upscale/health` 使用 admin JWT，返回 `ImageUpscaleHealthResponse`。backend 只返回启用状态、是否配置 Base URL/API Key、默认模型、允许模型、GPU 结果返回链路、GPU `/health` 状态和进程内队列快照；GPU 模型状态区分代码支持的 `availableModels`、已落盘权重 `weightFiles` 和运行时已加载缓存 `models`，并返回 `modelCacheLimit` 说明最多常驻几个已加载模型，避免刚重启时误判模型缺失或多模型切换持续堆高显存。队列快照包含当前执行数、等待数、最老等待耗时、并发上限、等待队列上限和排队超时上限，不返回 API Key 明文，也不返回 GPU 服务器对象存储密钥。
- tools：`POST /api/tools/image-reverse/jobs` 使用用户 JWT，接收单张 `Content-Type: image/*` 二进制图片，通过 `x-aiimage-reverse-options` 传递共享契约 `ImageReverseExtractOptions`，可用 `x-aiimage-file-name` 传原始文件名，成功返回 `202` 和 `ImageReverseJobCreateResponse`。backend 必须先把原图和 WebP 预览原子写入 `/v3/local/image-reverse-sources`，再创建 `image_reverse_jobs`，最后进入最多 4 个并发、16 个等待任务的队列；数据库创建失败必须回滚私有文件，同一用户最多保留 2 个未完成任务。`GET /api/tools/image-reverse/jobs` 返回最近 50 条不含完整结果 JSON 的 `ImageReverseJobListResponse`；`GET /api/tools/image-reverse/jobs/:jobId` 返回所属用户自己的 `ImageReverseJobDetailResponse`；`GET /api/tools/image-reverse/jobs/:jobId/source` 鉴权输出私有原图，`preview=1` 输出轻量预览。Web 普通进入反推页时只恢复最新未完成任务，不读取旧版 IndexedDB 大图或自动打开最近完成记录；`/reverse?job=任务ID` 打开历史时只读取轻量预览和数据库结果，`/reverse/history` 展示历史。backend 重启时必须使用持久化源图、模型和选项重新排队旧 `queued/running` 任务。源图不进入图库、不公开展示、不扣费；`POST /api/tools/image-reverse/extract` 保留为同步兼容入口。
- tools：图片反推支持 `description/prompt/character/tags/edit` 五种互斥模式、多语言、输出区域、标签格式、权重策略、Prompt 目标和编辑用途；Web 描述模式固定一次返回中英文两套整体、主体、角色、物件、构图、风格、色彩光影、背景和绘图提示词全部分类，不提供语言选择。各描述字段必须按职责唯一归属同一条可见事实，中英文必须表达相同事实，backend 会移除数组中的完全重复项。识图输入统一缩至 2048px 内并使用高质量 4:4:4 JPEG，描述模式最多请求 3000 个输出 token，且只在上游出现内容偏离或当前模式结构缺失时重新独立观察原图一次。生产默认识图模型使用已通过真实图片与 `reasoning_effort=medium` 验证的 `gpt-5.6-sol`；系统提示词使用 `MDX-Tom/gpt-5.6-instruct` v5 直答策略的图片转写专用版本，对成人、暴力、医疗、争议主题等可见内容继续执行中性、准确的同结构描述，后台仍可显式配置其他真实可用模型。单次上游请求超时默认 `300` 秒，可配置范围为 `5-600` 秒。短期客户端曾使用的 `ImageReverseFocus` 单项范围和 `ImageReverseFocusedLanguageResultView` 只保留兼容读取，新 Web 请求固定使用 `focus=all`。详细度不再开放配置，backend 固定最高详细度 `forensic`；旧 `x-aiimage-reverse-mode` 仍兼容。`ImageReverseResultView` 是判别联合类型：描述模式返回中英文完整结构化描述；Prompt 模式返回可直接绘图的提示词包；角色模式返回角色卡和复现 Prompt；标签模式返回本地模型英文标签和权重 Prompt；编辑模式返回保持项、修改项、禁止项、多参考图关系和图生图编辑 Prompt。新版结果可携带 `ImageReverseAnalysisView`，保存结构化输出兼容层级、Provider、阶段、证据来源、来源计数、互斥证据冲突和告警；`includeEvidence=false` 时不保存逐条证据，但仍保存阶段审计、来源计数与冲突摘要。上游优先使用严格 `json_schema`，不兼容时按 `json_object`、提示词 JSON 顺序降级并在分析视图标记。标签格式新增 `anima`，由 backend 按固定槽位确定性生成无权重单行 `animaPrompt`，不再次调用模型；结果页可把已持久化的 `animaPrompt` 写入一次性生成草稿并跳转绘图页，不重新识图、不自动提交或扣费。标签模式可传 `analysisMode=vision-only|hybrid`；后台配置完整时 `hybrid` 并行调用视觉模型和真实 WD14 GPU Provider，保留 `category/confidence/source` 并确定性合并 Prompt，Provider 失败只降级当前任务且必须写入审计。历史列表通过 `ImageReverseJobAnalysisSummaryView` 返回独立轻量摘要，不读取或下发完整 `resultJson`；摘要包含实际管线、Provider 状态、证据/告警/冲突数量及 Anima Prompt 可用性。`GET /api/tools/config` 只返回 `reverseHybridAvailable` 布尔值；`GET /admin/tools/image-reverse/wd14/health` 只返回配置完整度和模型健康，不返回密钥。API Base URL、API Key、系统提示词仅从后台 `system_configs.tools_image_reverse_*` 读取，不下发前端。
- tools：`POST /internal/tools/image-reverse/extract` 使用 service token，复用 `ImageReverseExtractResponse`、`ImageReverseExtractOptions` 和旧 mode 兼容语义，供 bot-service 在 QQ `/提取` 命令中提交首张图片二进制；该内部入口同样不保存上传图、不写图库、不扣费。
- tools：`POST /api/tools/image-upscale/run` 使用用户 JWT，接收单张 `Content-Type: image/*` 二进制图片，通过 `x-aiimage-upscale-options` 传递 `ImageUpscaleRunOptions`。`GET /api/tools/config` 会返回图片放大默认模型、允许模型、固定输出格式 `webp`、允许倍率和最大输出像素 `upscaleMaxOutputPixels`；backend 会按后台白名单再次归一化模型和倍率，并强制校验最大输出像素，非法值不会透传 GPU 服务。图片放大结果不再提供可选返回格式，`ImageUpscaleOutputFormat` 固定为 `webp`，旧客户端或旧后台配置传入 `png` 时也必须由 backend 强制归一为 `webp`。backend 校验真实图片内容、限制输入像素和输出像素后，先进入进程内 FIFO 队列，再调用后台配置的 GPU 超分服务，返回 `ImageUpscaleRunResponse`，其中 `image` 支持 `base64` 或 `url` 双形态，并包含 `queueWaitMs` 用于区分排队耗时和 GPU 推理耗时；队列满或排队超过 `tools_image_upscale_queue_timeout_sec` 时返回 `429`。GPU 结果链路由私有配置 `tools_image_upscale_response_transport=binary|s3|local` 控制；`s3` 时只有 GPU 服务使用对象存储凭证上传结果，backend 只读取 GPU 返回的 HTTPS 结果 URL，不保存对象存储凭证；`local` 时 GPU 写入本机临时目录并返回暂存 URL，backend 不同步中转大图。默认不保存上传图、不写图库、不扣费；仅当 `saveToLibrary=true` 时，`binary/s3` 链路会同步把放大后的结果图通过 media-service 保存为 `img_` 原图和 `thumb_` 缩略图，`local` 链路会先返回暂存 URL，再由 backend 后台异步下载并保存到图库，仍不扣费。GPU 服务 Base URL、API Key、默认模型、并发、队列上限和结果链路只保存在后台配置中，不返回给浏览器。
- tools/internal：`POST /internal/tools/image-upscale/run` 使用 service token，复用 `ImageUpscaleRunOptions` 和 `ImageUpscaleRunResponse`，供 bot-service 在 QQ `/放大 [2|3|4]` 命令中提交引用或同消息的首张图片二进制。Bot 支持 `/放大4`、`/放大 4x`、`/放大 4倍` 等紧凑倍率写法，并先返回开始回执，最终图由后台主动推送回原会话。内部入口同样走真实图片校验、倍率/模型白名单、输出像素上限、backend 队列和 GPU 服务；无论请求头是否误传 `saveToLibrary`，backend 都强制不保存图库、不写钱包、不扣费。
- tools：`POST /api/tools/image-upscale/jobs` 使用用户 JWT，接收单张 `Content-Type: image/*` 二进制图片，通过 `x-aiimage-upscale-options` 传递 `ImageUpscaleRunOptions`，可选 `x-aiimage-file-name` 传递 URL 编码后的源文件名；成功返回 `202` 和 `ImageUpscaleJobCreateResponse`。backend 必须先把原图和 WebP 预览原子写入 `/v3/local/image-upscale-sources`，再创建 `image_upscale_jobs`，数据库创建失败必须回滚私有文件，最后进入现有 GPU 队列。`GET /api/tools/image-upscale/jobs` 返回当前用户最近 50 条 `ImageUpscaleJobListResponse`，列表包含状态、进度、源图元数据、私有源图/预览鉴权地址、模型、倍率和入图库选项，不返回历史结果 base64；`GET /api/tools/image-upscale/jobs/:jobId` 返回所属用户自己的 `ImageUpscaleJobDetailResponse`；`GET /api/tools/image-upscale/jobs/:jobId/source` 鉴权输出私有原图，`preview=1` 输出轻量预览。Web 刷新后从数据库恢复任务，`/upscale/history` 展示历史，`/tools/image-upscale?job=任务ID` 打开任意记录。backend 重启时使用持久化源图、模型、倍率、隐私和入图库选项重新排队旧 `queued/running` 任务。`ImageUpscaleRunResponse.image` 支持 `base64` 或 `url` 双形态，`timings` 返回源图准备、GPU 响应头、结果下载、存储上传、输出元数据和总耗时。`POST /api/tools/image-upscale/jobs/:jobId/cancel` 返回 `ImageUpscaleJobCancelResponse`，仅允许当前用户结束自己的任务；已进入 GPU 的请求只中断 backend 等待，后续结果不保存图库、不计成功调用、不覆盖取消状态。私有源图只用于任务恢复和历史预览，不进入图库、不扣费；只有 `saveToLibrary=true` 时继续沿用现有图片放大保存链路保存放大结果，其中 `local` 链路先显示 GPU 暂存 URL，后台保存成功后补写 `savedTask`。
- workbench：`GET /api/workbench/conversations`、`POST /api/workbench/conversations`、`GET /api/workbench/conversations/:id`、`DELETE /api/workbench/conversations/:id`、`POST /api/workbench/conversations/:id/messages`、`POST /api/workbench/conversations/:id/messages/stream`、`POST /api/workbench/conversations/:id/messages/:messageId/retry/stream`、`POST /api/workbench/conversations/:id/messages/:messageId/decision`、`POST /api/workbench/attachments` 和 `GET /api/workbench/attachments/:id` 使用用户 JWT，并复用 `WorkbenchConversationListResponse`、`WorkbenchConversationDeleteResponse`、`WorkbenchConversationDetailResponse`、`WorkbenchSendMessageResponse`、`WorkbenchDrawingDecisionRequest`、`WorkbenchDrawingDecisionResponse`、`WorkbenchStreamEvent`、`WorkbenchAttachmentUploadResponse`。`WorkbenchMessageView.agentRunId/agentRunStatus/agentElapsedMs` 来自持久化 `workbench_agent_runs`，backend 会把 assistant 消息关联到前一条用户消息的最新 Agent Run，`agentElapsedMs` 按 0.1 秒精度归一化，刷新后仍可恢复终态耗时。`/messages/stream` 的 SSE 事件包含 `run_started/status/tool_start/tool_result/delta/done/error`：每条用户消息会创建持久化 Agent Run，阶段记录写入 `workbench_agent_runs` 和 `workbench_agent_steps`，只保存阶段摘要，不保存模型隐藏推理；`run_started` 用于前端绑定本次运行，并返回本轮持久化 assistant pending 消息 ID，前端必须用它合并临时“正在思考”气泡，刷新或重新拉取会话时仍从 `workbench_messages` 恢复执行中消息；`status` 展示上下文整理、AI 规划、路由和文本流等待点，`tool_start/tool_result` 展示真实工具开始和结果，普通文本回复在 AI 选择 `respond_without_tool` 后通过 `delta` 逐段返回上游文本。`/messages/:messageId/retry/stream` 只允许重试当前用户自己的失败 assistant 消息，backend 会找到该失败消息前一条用户消息并原位覆盖这条 assistant 消息，不新增用户消息、不删除历史消息、不修改余额或真实生成任务。backend 将会话和消息写入 `workbench_conversations`、`workbench_messages`，图片附件写入 backend 本地私有目录和 `workbench_attachments`，支持用户切换不同上下文窗口。删除会话仅删除当前用户自己的工作台上下文、消息和附件记录，并清理安全短文件名附件文件，不删除真实生成任务、图库图片、余额或钱包流水。工作台按 AI Agent 设计，发送消息后由后台 `workbench_ai_*` 独立配置的真实 OpenAI 兼容 `chat/completions` 使用 tools/function calling 在 `submit_image_generation_task`、`inspect_generation_task`、`respond_without_tool` 中自主三选一，不复用图片反推或其他工具的模型配置、系统提示词或开关；图片输入分两阶段处理：先给 AI 一个不含二进制的当前和历史附件索引，让 AI 选择本轮需要读取的图片，再只把选中图片内容传给多模态路由/回复，不一次性传全部上下文图片。用户只说“重新生成、再生成一次、再来一张、换一张”时，backend 会强制清空历史图片选择并让 Agent 沿用最近文字主题生成新的文生图方案；只有用户明确说基于、参考、优化、重绘或修改上一张图时，才允许带历史结果图进入图生图。若上游不支持 tools 或没有返回有效工具调用，仍继续由同一 AI 使用 JSON mode 输出路由结果，不使用本地正则或关键词规则判断；明确生成图片或用户对上文最终绘图方案说确认生成、开始吧、可以、OK 等承接确认时，Agent 调用 `submit_image_generation_task` 生成 2-4 个待确认绘图方案，不直接扣费、不直接创建任务；AI 选择图生图时，backend 会把 AI 选中的当前或历史工作台附件转存到 media-service `ref_` 参考图链路，并把 `mode/sourceImageUrls/sourceImageSizes` 保存到 `WorkbenchToolCallView`，确认后使用这些持久化字段提交真实 `image-to-image` 任务。用户选择具体 `optionId` 并允许后，backend 才使用该方案完整 Prompt 调用真实 `GenerationsService.createTask`，不绕过鉴权、余额、限流、模型校验、参考图存在性校验、扣费或错误处理；用户要求查看任务状态、详情或失败原因且有任务 ID 时，Agent 调用 `inspect_generation_task`，只读取当前用户自己的 `GenerationsService.findTasks` 结果，不修改余额或任务。AI 选择 `respond_without_tool` 时才进入普通文本回复。工具调用记录支持 `image_generation` 和 `generation_lookup` 两类，成功消息记录模型名、工具调用原因、模式、参考图、任务或批次 ID，失败消息记录错误摘要，服务重启后上下文和历史工具结果仍可读取。前端工作台使用 `/api/generations/tasks` 轮询当前窗口关联任务，只展示当前登录用户自己的真实任务状态和结果缩略图，任务全部终态后停止轮询。绘图建议确认接口负责最终提交，拒绝不创建任务；多方案必须选择 `optionId`，旧单 Prompt 建议允许后才提交同一份 Prompt。

## 已下线接口

以下工作流和本地模型推理入口不再登记契约，也不得恢复为生产调用链路：

- `/workflow`
- `/api/workflows`
- `/api/workflow-local-tasks`
- `/admin/workflow/*`
- `/admin/local-inference/*`
- `/internal/workflow-config`
- `/internal/workflow/ops-status`
- `/internal/local/*`
- `/internal/local-inference/*`
- `/internal/ops/repair-stale-local-runs`
- `/worker/run-local-inference-health`
- `/worker/run-local-run-stale-repair`

## LoRA 仓库接口

- `GET /api/loras` 返回公开已发布 LoRA；登录用户传 `mine=1` 时返回自己的草稿和已发布记录，`model` 只按 Anima、Krea2 等主模型系列筛选，`type` 按风格、角色、概念、服装、姿势、物体、调节器或其他分类筛选。`GET /api/loras/models` 返回持久化全局主模型词表，系统预置 `anima` 和 `krea2`。
- `POST /api/loras` 使用用户 JWT 创建草稿并保存标题、描述、LoRA 类型和主模型系列。用户填写的新主模型系列与草稿在同一数据库事务写入全局词表，后续所有用户都可在上传下拉和仓库筛选中选择。网页上传使用 `POST /api/loras/:id/uploads` 创建模型或示例图上传会话、`PUT /api/loras/:id/uploads/:uploadId` 按服务端声明的片大小顺序上传、`GET /api/loras/:id/uploads/:uploadId` 在网络响应丢失时读取服务端真实偏移、`POST /api/loras/:id/uploads/:uploadId/complete` 校验总大小并完成落盘；每片保持在反向代理小请求体限制内，上传会话绑定作者和草稿，禁止跨用户、跨条目复用。`DELETE /api/loras/:id/uploads/:uploadId` 取消未完成会话。
- `PUT /api/loras/:id/file` 和 `POST /api/loras/:id/examples` 保留给受控直连客户端；模型文件仍为流式写入，示例图最多 8 张。`POST /api/loras/:id/publish` 仅在模型文件和至少一张示例图都存在时发布。
- `GET /api/loras/examples/:exampleId` 公开输出已发布条目的 WebP 示例图；`GET /api/loras/:id/download` 支持 HTTP Range 流式下载已发布 LoRA 并递增下载量；`DELETE /api/loras/:id` 仅允许作者删除并清理安全文件名及未完成上传。草稿、模型原文件名、哈希和存储路径不得暴露给其他用户。
- `GET /internal/loras/:id/file?sha256=...` 只接受服务间 token，并且只有请求 SHA-256 与已发布条目一致时才流式输出模型文件；该接口不增加公开下载量，也不返回 backend 本地路径。
