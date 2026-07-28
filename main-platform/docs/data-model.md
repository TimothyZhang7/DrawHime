# 数据模型摘要

权威来源是 `apps/backend/prisma/schema.prisma`。本文只记录当前模型分组和业务含义。

## 用户与认证

- `users.site_background_enabled` 保存当前 Web 用户是否显示后台全站背景图，默认开启；后台全局关闭时该偏好只保留、不生效。

- `User`：网页用户、邮箱、密码哈希、角色、默认图片隐私、Web 自定义头像本地文件名。Web 头像只保存 `avatar_filename` 短文件名，文件位于 backend 本地头像目录，不进入 media-service 图片链路；前端外显头像按“网页头像 > 已绑定 QQ 头像 > 用户名首字符”解析，QQ 头像只作为展示回退，不写入 Web 头像字段。
- `EmailVerification`：邮箱验证 token 哈希。
- `PasswordReset`：密码重置 token 哈希。
- `UserInviteCode`：用户唯一邀请码，充值页和邀请链接展示使用。
- `UserReferral`：用户邀请关系，每个被邀请用户只能绑定一次邀请人；邮箱验证后幂等发放双方 Web 钱包付费余额奖励。

## QQ 与余额

- `QqBinding`：用户和 QQ 号绑定关系。
- `QqQuota`：QQ 号维度余额权威表。
- `QqImagePrivacyPref`：QQ 用户默认图片隐私。
- `UserModelPref`：用户或 QQ 的默认模型偏好。

## 绘图任务

- `GenerationTask`：用户一次提交对应一个主任务。
- `GenerationSubTask`：调度、上游尝试、重试、收尾等时间线。
- 图片或视频文件名等结果字段通过 `SystemConfig.task_image_<taskId>` 与任务回写链路关联；视频值显式保存 `mediaType=video/videoFilename/duration/resolution/aspectRatio`，不复用图片文件名字段。
- `WorkbenchConversation`：网页导航工作台多对话窗口，每个窗口保存默认模型、张数、隐私状态和最后消息摘要，供用户切换上下文。
- `WorkbenchMessage`：工作台持久化消息，保存用户原始消息、assistant 模型回复、错误摘要、消息模式、附件 ID、工具调用和关联任务/批次 ID；服务重启后仍可恢复上下文。
- `WorkbenchAttachment`：工作台图片附件元数据。图片文件先落 backend 本地私有目录，数据库只保存短文件名、MIME、尺寸和所属用户，不把 base64 写入消息表。
- `ImageReverseJob`：图片反推持久化任务。保存所属用户、模式、模型、完整提取选项、私有源图/预览短文件名、进度、结果摘要、轻量分析摘要、完整结构化结果和错误；轻量分析摘要独立保存实际管线、Provider 状态和证据计数，历史列表不读取大型结果 JSON。源图先落 `/v3/local/image-reverse-sources`，再创建数据库记录，刷新页面或服务重启后可恢复。

## 图库与互动

- `ImageView`：图片浏览 IP 去重。
- `ImageLike`：用户点赞去重。
- `GalleryTag`：图库中文标签字典。标签只描述最终图片可见内容，不替换原始提示词；同名标签首次创建时生成固定浅色配色，全站复用。
- `GenerationTaskTag`：生成任务与标签关联。`weight` 是标签在当前图片上的展示排序权重，`confidence` 是 AI 判断可信度；标签写入不影响余额、扣费、任务状态或图片文件。
- `GalleryTaggingJob`：图库自动打标队列。任务成功后只异步入队，由后台 worker 调用视觉模型处理；AI 失败或配置缺失只影响标题和标签，不阻塞绘图成功。
- `SystemConfig.task_gallery_title_<taskId>`：图库 AI 封面短标题。标题由最终图片和提示词汇总生成，只用于封面展示，不替换 `GenerationTask.prompt`；多图批次复用固有顺序图一标题。

## 模板

- `Template`：用户模板、变量默认值、封面图、公开状态。
- `TemplateFavorite`：模板收藏。
- `LoraRepositoryItem`：用户 LoRA 仓库条目。保存风格、角色、概念、服装、姿势、物体、调节器或其他内容类型，主模型只保存 Anima、Krea2 等系列名；先创建私有草稿，再分片上传 `.safetensors` 和示例图，文件齐全后发布；数据库只保存安全短文件名、原文件名、大小和 SHA-256，不保存模型二进制。
- `LoraBaseModel`：LoRA 主模型全局词表。系统预置 `anima/krea2`，用户填写的新系列与草稿同事务写入，创建者删除后系列记录仍保留并继续供全站筛选。
- `LoraExampleImage`：LoRA 多示例图。上传图片统一转成最长边 1800px 的高质量 WebP，每个条目最多 8 张，发布后通过独立公开地址读取。

## 站点与配置

- `ApiSite`：绘图上游站点、模型、权重、并发、熔断状态；`autoSizeFromReference` 默认关闭，开启后只让 OpenAI 图生图的 `size=auto` 改传第一张参考图向下对齐到 16 像素倍数的宽高。
- `SystemConfig.drawing_model_settings`：独立模型注册与定价，保存模型 ID、类型、单次价格、外显名、别名、权重和默认状态；删除站点或从站点移除模型不得删除该配置。
- `SystemConfig`：其他全局配置；历史 `drawing_price_per_gen` 只作为尚未登记模型的价格兜底，不再是管理端定价入口。
- `SystemConfig.tools_usage_total_*` / `tools_usage_daily_*` / `tools_usage_last_*`：用户端工具调用聚合计数。只记录工具维度的累计、当日和最近调用时间，不保存用户、IP、上传图片或工具参数。
- `ImageUpscaleJob`：图片放大工具的异步任务持久化记录。保存所属用户、任务状态、私有源图/预览短文件名、源图元数据、模型倍率、隐私和入图库选项、结果 URL/元数据、错误摘要及保存到图库后的任务摘要；源图文件位于 `/v3/local/image-upscale-sources`，服务重启后排队或运行任务可使用原任务 ID 重新排队。
- `ModuleConfig`：模块化配置。

## 本地模型

- `LocalPlatformPriceVersion`：独立本地模型平台发布到主站的不可变价格版本；主站只按该表计算任务预留金额，不接受独立平台传入金额。
- `LocalPlatformBillingReservation` / `LocalPlatformBillingAllocation`：独立平台任务资金预留与固化钱包分账；任务成功只提交终态，失败或取消时严格按原分账退款。

- `LocalInferenceHost`：GPU 主机或推理宿主配置、健康摘要、并发和是否接收新任务。
- `LocalModelProvider`：ComfyUI 等 Provider 配置、超时、上传/输出策略和私有配置引用。
- `LocalModel`：本地模型业务注册项、能力、可见范围、尺寸/步数/CFG 上限和价格权重。
- `LocalModelFile`：模型文件同步摘要，只保存路径、大小、哈希和最后发现时间，不移动或删除真实模型文件。
- `LocalNodeCatalog`：Provider 节点目录快照、输入输出 schema、危险级别和可见范围。
- `LocalWorkflowTemplate` / `LocalWorkflowTemplateVersion`：后台本地模型模板及版本化 Provider runtime JSON。
- `LocalRun` / `LocalRunNode` / `LocalRunArtifact`：本地推理运行、节点进度和产物审计记录。

## 充值

- `RechargeBatch`：卡密批次。
- `RechargeCard`：卡密哈希、额度、兑换状态。

## Bot 与 wsproxy

- `BotConnection`：Bot 在线状态、selfId、绑定用户、封禁信息。
- `WsProxyEndpoint`：动态 WebSocket 端点和 token 哈希。

## 强约束

- 不使用旧库结构。
- 余额按 QQ 号归属。
- 卡密和 token 只保存哈希。
- 余额扣减、退款、卡密兑换、QQ 绑定必须事务化或幂等。
