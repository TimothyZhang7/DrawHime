/** 本文件定义绘图任务、子任务和服务间生成接口契约，规范来源：standards/interfaces/drawing.md。 */
import type { DrawingAspectRatio } from './drawing-aspect-ratio-contracts.js';

/** 绘图调用来源用于区分 Web 用户和 Bot 命令入口。 */
export type DrawingSource = 'web' | 'bot';

/** 生成模式用于区分图片与视频的文生、参考图生成链路。 */
export type DrawingMode = 'text-to-image' | 'image-to-image' | 'text-to-video' | 'image-to-video';

/** 视频生成分辨率，必须使用 Grok 视频端点真实支持的档位。 */
export type DrawingVideoResolution = '480p' | '720p' | '1080p';

/** 任务结果媒体类型，历史图片任务缺省时仍按 image 兼容。 */
export type DrawingResultMediaType = 'image' | 'video';

/** 用户在一次生成中选择的单个 LoRA；当前工作流按稳定顺序只叠加一个用户 LoRA。 */
export type GenerationLoraSelection = {
  /** LoRA 仓库已发布条目 ID。 */
  id: number;
  /** 模型与文本编码器共同使用的强度，范围 0-2。 */
  strength: number;
};

/** backend 校验并固化的 LoRA 文件快照；跨服务链路不得再信任浏览器提交的元数据。 */
export type DrawingLoraSnapshot = GenerationLoraSelection & {
  /** 任务详情展示标题。 */
  title: string;
  /** LoRA 训练所用主模型系列。 */
  baseModel: string;
  /** backend 已验证文件大小。 */
  sizeBytes: number;
  /** backend 已验证文件 SHA-256。 */
  sha256: string;
  /** GPU 端按内容哈希生成的安全文件名。 */
  gpuFileName: string;
};

/** 绘图状态用于跨服务轮询、恢复和结果展示；deferred 表示批次内等待释放，不会被 Worker 直接消费。 */
export type DrawingStatus = 'deferred' | 'queued' | 'running' | 'finalizing' | 'success' | 'failed';

/** 多图批次状态用于表达一次提交下多张单图任务的整体生命周期。 */
export type GenerationBatchStatus = 'queued' | 'running' | 'stopping' | 'success' | 'partial_success' | 'failed';

/** 绘图子任务状态用于表达主任务下每个调度、重试或上游尝试的生命周期。 */
export type GenerationSubTaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'skipped';

/** 绘图子任务类型用于区分调度、同站重试、换站重试和上游尝试。 */
export type GenerationSubTaskKind =
  | 'request_received'
  | 'prompt_assist'
  | 'dispatch'
  | 'same_site_retry'
  | 'site_switch'
  | 'upstream_attempt'
  | 'image_saved'
  | 'video_saved'
  | 'result_ready'
  | 'result_delivered'
  | 'finalize';

/** 绘图重试下一步动作，必须和 retryInfo 约束保持一致。 */
export type GenerationRetryNextAction = 'stop' | 'switch_site' | 'same_site';

/** 用户创建生成主任务的请求体；一次用户提交只能创建一个主任务。 */
export type GenerationCreateRequest = {
  /** 调用方可传入幂等请求 ID；未传时 backend 会生成稳定 ID。 */
  clientRequestId?: string;
  /** 文生图或图生图模式。 */
  mode: DrawingMode;
  /** 用户实际提交的提示词。 */
  prompt: string;
  /** 可选模板 ID，后续模板权限校验必须基于该字段。 */
  templateId?: number;
  /** 图生图参考图 URL 列表，当前阶段只保存任务输入，不做图片处理。 */
  sourceImageUrls?: string[];
  /** 图生图参考图原始字节数列表；Web 端用于单任务总参考图大小校验，顺序必须与 sourceImageUrls 对齐。 */
  sourceImageSizes?: number[];
  /** 用户本次任务是否默认私密。 */
  isPrivate?: boolean;
  /** 用户指定的模型。 */
  model?: string;
  /** 生成尺寸。 */
  size?: string;
  /** 用户选择的统一画幅比例；显式比例由 Worker 按站点协议转换。 */
  aspectRatio?: DrawingAspectRatio;
  /** 生成质量。 */
  quality?: string;
  /** 视频时长，单位秒；只用于视频模式。 */
  duration?: number;
  /** 视频分辨率；只用于视频模式。 */
  resolution?: DrawingVideoResolution;
  /** 是否在视频任务创建前使用反推模型重新设计分镜提示词；缺省时按模型默认开启。 */
  storyboardDesign?: boolean;
  /** 是否对文生图提示词执行 AI 增强；可不带参考图，开启该能力的模型默认启用。 */
  referencePromptAssist?: boolean;
  /** 本次提交要生成的图片张数；缺省或 1 时保持单任务链路。 */
  count?: number;
  /** 本次生成使用的单个已发布 LoRA；backend 会校验兼容性并固化文件快照。 */
  lora?: GenerationLoraSelection;
};

/** 多图批次视图；批次只做调度聚合，每张图片仍由单个 GenerationTask 承载。 */
export type GenerationBatchView = {
  /** 批次 ID。 */
  id: string;
  /** 批次级幂等键。 */
  clientRequestId: string;
  /** 批次状态。 */
  status: GenerationBatchStatus;
  /** 调用来源。 */
  source: DrawingSource;
  /** 批次总张数。 */
  count: number;
  /** 同一批次最多并发释放的子任务数。 */
  concurrency: number;
  /** 连续失败达到该阈值后停止未开始子任务。 */
  stopAfterConsecutiveFailures: number;
  /** 已成功张数。 */
  successCount: number;
  /** 已失败张数。 */
  failedCount: number;
  /** 创建时间。 */
  createdAt: string;
  /** 更新时间。 */
  updatedAt: string;
};

/** 生成子任务视图，前端、后台和 Bot 都只能依赖该结构解释重试过程。 */
export type GenerationSubTaskView = {
  /** 子任务 ID，由 backend 生成。 */
  id: string;
  /** 所属主任务 ID。 */
  taskId: string;
  /** 主任务内递增序号，用于按真实发生顺序展示。 */
  sequence: number;
  /** 子任务类型。 */
  kind: GenerationSubTaskKind;
  /** 子任务状态。 */
  status: GenerationSubTaskStatus;
  /** 任务级尝试序号，从 1 开始；非尝试类子任务可为空。 */
  attemptNo?: number;
  /** 本次尝试使用的站点 ID。 */
  siteId?: number;
  /** 本次尝试使用的站点名称。 */
  siteName?: string;
  /** 本次尝试使用的模型。 */
  model?: string;
  /** 失败后是否允许继续重试。 */
  retryable?: boolean;
  /** 失败后的下一步动作。 */
  nextAction?: GenerationRetryNextAction;
  /** 子任务耗时毫秒。 */
  latencyMs?: number;
  /** 清洗后的中文错误。 */
  error?: string;
  /** 子任务创建时间。 */
  createdAt: string;
  /** 子任务开始时间。 */
  startedAt?: string;
  /** 子任务结束时间。 */
  finishedAt?: string;
};

/** 生成主任务视图；主任务代表用户的一次提交，子任务代表后端处理过程。 */
export type GenerationTaskView = {
  /** 主任务 ID。 */
  id: string;
  /** 用户提交幂等键，重复提交时返回同一个主任务。 */
  clientRequestId: string;
  /** 多图批次 ID；单图任务为空。 */
  batchId?: string;
  /** 多图批次内序号，从 1 开始。 */
  batchIndex?: number;
  /** 多图批次总张数。 */
  batchTotal?: number;
  /** 当前主任务状态。 */
  status: DrawingStatus;
  /** 调用来源。 */
  source: DrawingSource;
  /** 绘图模式。 */
  mode: DrawingMode;
  /** 用户提交提示词。 */
  prompt: string;
  /** 任务关联 QQ 号；未绑定 QQ 的 Web 任务为空。 */
  qqNumber?: string;
  /** Web 用户 ID；Bot 任务可为空。 */
  userId?: number;
  /** 模板 ID。 */
  templateId?: number;
  /** 参考图 URL 列表。 */
  sourceImageUrls?: string[];
  /** 是否私密。 */
  isPrivate: boolean;
  /** 清洗后的主任务错误。 */
  error?: string;
  /** 面向用户展示的最终失败短原因，由 backend 根据主任务和子任务真实错误归纳。 */
  failureSummary?: string;
  /** 创建时间。 */
  createdAt: string;
  /** 更新时间。 */
  updatedAt: string;
  /** 主任务开始处理时间。 */
  startedAt?: string;
  /** 主任务结束时间。 */
  finishedAt?: string;
  /** 当前任务最多上游尝试次数，用于前端按真实配置展示进度点。 */
  maxAttempts?: number;
  /** 挂在主任务下的调度、重试和尝试子任务。 */
  subTasks: GenerationSubTaskView[];
  /** 成功后的原图 URL；由 backend 查询任务状态时按真实 task_image 配置附加。 */
  imageUrl?: string;
  /** 成功后的缩略图 URL；由 backend 查询任务状态时按真实 task_image 配置附加。 */
  thumbnailUrl?: string;
  /** 成功结果媒体类型；历史图片任务可缺省。 */
  mediaType?: DrawingResultMediaType;
  /** 成功后的视频 URL；只在视频结果落盘后返回。 */
  videoUrl?: string;
  /** 视频结果时长，单位秒。 */
  duration?: number;
  /** 视频结果分辨率档位。 */
  resolution?: DrawingVideoResolution;
  /** 视频结果画幅比例。 */
  aspectRatio?: DrawingAspectRatio;
};

/** 创建生成主任务响应体。 */
export type GenerationCreateResponse = {
  /** 创建或幂等命中的主任务。 */
  task: GenerationTaskView;
  /** 多图提交时返回批次摘要。 */
  batch?: GenerationBatchView;
  /** 多图提交时返回批次下全部任务，单图可为空。 */
  tasks?: GenerationTaskView[];
};

/** 当前登录用户的绘图冷却状态；前端用于禁用提交按钮，真实限制仍由创建任务链路兜底。 */
export type GenerationCooldownResponse = {
  /** 后台配置的冷却总秒数。 */
  cooldownSeconds: number;
  /** 当前剩余冷却秒数，0 表示可提交。 */
  remainingSeconds: number;
  /** 最近一次任务 ID；没有历史任务时为空。 */
  lastTaskId: string | null;
};

/** 按 clientRequestId 恢复主任务的请求体。 */
export type GenerationRecoverRequest = {
  /** 用户提交幂等键。 */
  clientRequestId: string;
};

/** 主任务恢复响应体；未找到时由接口返回 not_found。 */
export type GenerationRecoverResponse = {
  /** 恢复出的主任务。 */
  task: GenerationTaskView;
  /** 多图提交恢复时返回批次摘要。 */
  batch?: GenerationBatchView;
  /** 多图提交恢复时返回批次下全部任务，单图可为空。 */
  tasks?: GenerationTaskView[];
};

/** Web 用户按历史任务重新提交的请求体；任务 ID 必须属于当前登录用户。 */
export type GenerationRetryRequest = {
  /** 要作为参数来源的历史任务 ID。 */
  taskId: string;
};

/** Web 用户按历史任务重新提交后的响应体。 */
export type GenerationRetryResponse = {
  /** 新创建的主任务。 */
  task: GenerationTaskView;
  /** 参数来源任务 ID，便于前端提示用户本次来源。 */
  sourceTaskId: string;
};

/** Bot 创建绘图任务请求；QQ 号和投递目标只能来自真实 OneBot 事件。 */
export type BotGenerationCreateRequest = {
  /** 触发命令的 QQ 号。 */
  qqNumber: string;
  /** 用户实际提交的提示词。 */
  prompt: string;
  /** 绘图模式；缺省时 backend 按文生图处理。 */
  mode?: DrawingMode;
  /** Bot 连接 selfId，用于恢复投递到正确账号。 */
  botSelfId?: string | number;
  /** 原消息投递目标，用于服务重启后回到原群聊或私聊。 */
  deliveryTarget?: BotDeliveryTarget;
  /** 用户偏好模型。 */
  preferredModel?: string;
  /** 图生图参考图 URL 列表。 */
  sourceImageUrls?: string[];
  /** 本次提交要生成的图片张数。 */
  count?: number;
  /** 视频时长，单位秒；视频模型必填。 */
  duration?: number;
  /** 视频分辨率档位；视频模型必填。 */
  resolution?: DrawingVideoResolution;
  /** 统一画幅比例；视频模型必须使用支持的显式比例。 */
  aspectRatio?: DrawingAspectRatio;
  /** 是否在提交视频前执行分镜设计；Bot 视频任务默认传 true。 */
  storyboardDesign?: boolean;
  /** 是否启用文生图 AI 提示增强；开启该能力的模型在 Bot 端默认启用，可不带参考图。 */
  referencePromptAssist?: boolean;
};

/** Bot 按 QQ 最近任务重新提交的请求体；QQ 号只能来自 OneBot 事件。 */
export type BotGenerationRetryRequest = {
  /** 触发命令的 QQ 号。 */
  qqNumber: string;
  /** Bot 连接 selfId，用于恢复投递到正确账号。 */
  botSelfId?: string | number;
  /** 原消息投递目标，用于服务重启后回到原群聊或私聊。 */
  deliveryTarget?: BotDeliveryTarget;
};

/** Bot 复投成功后的提交回执字段，与 Bot 绘图提交卡片保持一致。 */
export type BotGenerationRetryResponse = {
  /** 是否已被 backend 接收。 */
  accepted: true;
  /** 新任务 ID。 */
  taskId: string;
  /** 多图批次 ID。 */
  batchId?: string;
  /** 多图批次总数。 */
  batchTotal?: number;
  /** 多图批次内所有任务 ID。 */
  taskIds?: string[];
  /** 新任务幂等键。 */
  clientRequestId: string;
  /** 新任务状态。 */
  status: DrawingStatus;
  /** 是否扣费。 */
  charged: boolean;
  /** 扣费来源。 */
  chargedSource: string;
  /** 扣费金额。 */
  chargedAmount: string;
  /** 剩余付费余额。 */
  paidBalance: string;
  /** 剩余免费余额。 */
  freeBalance: string;
  /** 绘图模式。 */
  mode: DrawingMode;
  /** 历史任务提示词摘要。 */
  prompt: string;
  /** 使用的模型。 */
  preferredModel?: string;
  /** 当前模型在新任务创建时固化的最大上游尝试次数。 */
  maxAttempts?: number;
  /** 视频时长，单位秒。 */
  duration?: number;
  /** 视频分辨率档位。 */
  resolution?: DrawingVideoResolution;
  /** 视频画幅比例。 */
  aspectRatio?: DrawingAspectRatio;
  /** 参考图数量。 */
  imageCount: number;
  /** 任务隐私状态。 */
  isPrivate: boolean;
  /** 触发 QQ。 */
  qqNumber: string;
  /** 绑定网页用户名。 */
  bindingUsername?: string | null;
  /** 绑定网页用户 ID。 */
  bindingUserId?: number | null;
  /** 参数来源任务 ID。 */
  sourceTaskId: string;
  /** 新任务继续使用的参考图 URL，用于 Bot 后续结果/失败卡片展示。 */
  sourceImageUrls: string[];
};

/** Bot 批次最终回执里的单张图片结果；只暴露 Bot 汇总消息需要的真实字段。 */
export type BotBatchResultTaskView = {
  /** 主任务 ID。 */
  id: string;
  /** 多图批次内序号，从 1 开始。 */
  batchIndex: number;
  /** 当前任务状态。 */
  status: DrawingStatus;
  /** 成功后的原图站内 URL。 */
  imageUrl?: string;
  /** 最近一次真实上游成功站点。 */
  siteName?: string;
  /** 最近一次真实上游模型。 */
  model?: string;
  /** 清洗后的失败原因。 */
  error?: string;
  /** 任务创建时间。 */
  createdAt: string;
  /** 任务完成时间。 */
  finishedAt?: string;
};

/** Bot 最终回执投递目标；用于 bot-service 重启且 pending 文件丢失后仍回到原群聊或私聊。 */
export type BotDeliveryTarget =
  | {
      /** 原始消息来自群聊。 */
      type: 'group';
      /** 群号，使用字符串避免大整数精度问题。 */
      groupId: string;
      /** 原命令触发用户 QQ；原消息被撤回导致引用失败时用于 @ 该用户。 */
      userId?: string;
      /** 原消息 ID，存在时最终回执会带引用。 */
      messageId?: number;
    }
  | {
      /** 原始消息来自私聊。 */
      type: 'private';
      /** 用户 QQ，使用字符串避免大整数精度问题。 */
      userId: string;
      /** 原消息 ID，存在时最终回执会带引用。 */
      messageId?: number;
    };

/** Bot 批次最终回执查询响应；bot-service 只在 terminal=true 且抢占发送锁后给用户发一次汇总消息。 */
export type BotBatchResultResponse = {
  /** 批次 ID，也是多图图库详情入口 ID。 */
  batchId: string;
  /** 批次是否全部进入终态。 */
  terminal: boolean;
  /** 批次最终消息是否已经发送过。 */
  notificationSent: boolean;
  /** 批次状态。 */
  status: GenerationBatchStatus;
  /** 触发 QQ。 */
  qqNumber: string;
  /** 原 Bot selfId，用于服务重启后仍能投递到正确连接。 */
  botSelfId?: string;
  /** 原消息投递目标；缺失时兼容旧任务，bot-service 会退回私聊恢复。 */
  deliveryTarget?: BotDeliveryTarget;
  /** 提示词摘要。 */
  prompt: string;
  /** 绘图模式。 */
  mode: DrawingMode;
  /** 参考图数量。 */
  sourceImageCount: number;
  /** 批次总任务数。 */
  totalCount: number;
  /** 成功图片数。 */
  successCount: number;
  /** 失败任务数。 */
  failedCount: number;
  /** 批次创建时间。 */
  createdAt: string;
  /** 批次完成时间。 */
  finishedAt?: string;
  /** 最新 QQ 免费余额。 */
  freeBalance: string;
  /** 最新 QQ 付费余额。 */
  paidBalance: string;
  /** 按批次序号排序的任务结果。 */
  tasks: BotBatchResultTaskView[];
};

/** Bot 未发送终态批次恢复响应；用于 bot-service 重启后补发丢失的多图最终汇总。 */
export type BotPendingBatchResultsResponse = {
  /** 最近已经终态但尚未标记最终回执已发送的 Bot 批次。 */
  batches: BotBatchResultResponse[];
};

/** Bot 单任务媒体恢复项；用于 bot-service 重启后补发已保存但未确认送达的图片或视频。 */
export type BotFinalizingTaskRecoveryItem = {
  /** 主任务 ID。 */
  taskId: string;
  /** 触发 QQ。 */
  qqNumber: string;
  /** 提示词摘要。 */
  prompt: string;
  /** 绘图模式。 */
  mode: DrawingMode;
  /** 多图批次 ID；单图为空。 */
  batchId?: string;
  /** 多图批次总数；单图为空。 */
  batchTotal?: number;
  /** 最终媒体类型；历史图片任务按 image 兼容。 */
  mediaType?: DrawingResultMediaType;
  /** 成功原图站内 URL；视频任务为空字符串。 */
  imageUrl: string;
  /** 成功视频站内 URL。 */
  videoUrl?: string;
  /** 视频时长，单位秒。 */
  duration?: number;
  /** 视频分辨率。 */
  resolution?: DrawingVideoResolution;
  /** 视频画幅。 */
  aspectRatio?: DrawingAspectRatio;
  /** 原 Bot selfId。 */
  botSelfId?: string;
  /** 原群聊/私聊投递目标。 */
  deliveryTarget?: BotDeliveryTarget;
  /** 任务更新时间。 */
  updatedAt: string;
};

/** Bot 未确认投递的单任务媒体恢复响应。 */
export type BotFinalizingTaskRecoveryResponse = {
  /** 需要 bot-service 补发并确认 delivered 的图片或视频任务。 */
  tasks: BotFinalizingTaskRecoveryItem[];
};

/** Bot 批次最终回执发送锁响应；用于避免多个轮询周期或多进程重复发送同一批次结果。 */
export type BotBatchNotificationClaimResponse = {
  /** 本次是否抢占到发送权。 */
  claimed: boolean;
  /** 批次最终消息是否已确认发送。 */
  sent: boolean;
  /** 已存在发送锁时的过期时间。 */
  expiresAt?: string;
};

/** Bot 批次最终回执已发送标记响应；写入成功后同一批次不再重复推送。 */
export type BotBatchNotificationSentResponse = {
  /** 批次 ID。 */
  batchId: string;
  /** 是否已标记为发送完成。 */
  sent: true;
};

/** 主任务列表响应体，列表接口必须分页。 */
export type GenerationListResponse = {
  /** 当前页任务。 */
  items: GenerationTaskView[];
  /** 当前页数量。 */
  total: number;
  /** 当前页码。 */
  page: number;
  /** 每页数量。 */
  pageSize: number;
};

/** 批量查询任务状态响应体，用于前端轮询进行中任务。 */
export type GenerationTasksResponse = {
  /** 请求命中的任务列表。 */
  tasks: GenerationTaskView[];
};

/** Bot 任务列表单项；只承载数据库真实任务和子任务聚合字段，不允许 renderer 伪造状态。 */
export type BotGenerationTaskListItem = {
  /** 主任务 ID。 */
  id: string;
  /** 当前任务状态。 */
  status: DrawingStatus;
  /** 用户提交的提示词短文本。 */
  prompt: string;
  /** 绘图模式。 */
  mode: DrawingMode;
  /** 最近一次上游尝试模型。 */
  model?: string;
  /** 最近一次上游尝试站点。 */
  siteName?: string;
  /** 创建时间，ISO 字符串。 */
  createdAt: string;
  /** 开始时间，ISO 字符串。 */
  startedAt?: string;
  /** 完成时间，ISO 字符串。 */
  finishedAt?: string;
  /** 真实耗时毫秒，优先来自上游尝试 latencyMs，缺失时由开始/完成时间计算。 */
  latencyMs?: number;
  /** 上游尝试次数。 */
  attemptCount: number;
  /** 失败的上游尝试次数。 */
  failedAttemptCount: number;
  /** 重试次数，等于尝试次数减一，下限为 0。 */
  retryCount: number;
  /** 参考图数量。 */
  imageCount: number;
  /** 是否发生扣费。 */
  charged: boolean;
  /** 扣费金额。 */
  chargedAmount?: string;
  /** 清洗后的错误摘要。 */
  error?: string;
};

/** Bot 任务列表响应；用于 `#任务` 图片卡片和文本降级。 */
export type BotGenerationTaskListResponse = {
  /** 当前筛选下的最近任务。 */
  items: BotGenerationTaskListItem[];
  /** 当前筛选总数；内部接口最多返回最近若干条，但总数用于卡片摘要。 */
  total: number;
};

/** Bot 统计时间窗口的任务聚合，用于 `/统计` 卡片展示总量、今日和近 7 日。 */
export type BotGenerationStatsBucket = {
  /** 时间窗口标签，例如 total、today、7d。 */
  key: 'total' | 'today' | '7d';
  /** 用户可读名称。 */
  label: string;
  /** 总任务数。 */
  total: number;
  /** 成功任务数。 */
  success: number;
  /** 失败任务数。 */
  failed: number;
  /** 排队、运行和收尾中的任务数。 */
  active: number;
  /** 成功率百分比，保留一位小数。 */
  successRate: number;
  /** 图生图任务数。 */
  imageToImage: number;
  /** 文生图任务数。 */
  textToImage: number;
  /** 真实上游尝试次数。 */
  attempts: number;
  /** 上游失败尝试次数。 */
  failedAttempts: number;
  /** 平均耗时毫秒，只统计有开始和完成时间的终态任务。 */
  avgLatencyMs?: number;
  /** 扣费金额合计，字符串保留两位小数。 */
  chargedAmount: string;
};

/** Bot 统计排行榜用户项，头像 URL 由 QQ 号派生，不依赖第三方存储。 */
export type BotGenerationStatsRankItem = {
  /** 排名，从 1 开始。 */
  rank: number;
  /** QQ 号；无 QQ 的 Web 任务不进入 Bot 排行。 */
  qqNumber: string;
  /** QQ 头像 URL。 */
  avatarUrl: string;
  /** 总任务数。 */
  total: number;
  /** 成功任务数。 */
  success: number;
  /** 失败任务数。 */
  failed: number;
  /** 成功率百分比，保留一位小数。 */
  successRate: number;
  /** 今日任务数。 */
  todayTotal: number;
  /** 最近一次任务创建时间。 */
  lastTaskAt?: string;
};

/** Bot `/统计` 内部接口响应；scope=mine 展示当前 QQ，scope=all 展示全局和排行。 */
export type BotGenerationStatsResponse = {
  /** 统计范围。 */
  scope: 'mine' | 'all';
  /** 当前 QQ，scope=mine 时存在。 */
  qqNumber?: string;
  /** 数据生成时间。 */
  generatedAt: string;
  /** 总量、今日和近 7 日聚合。 */
  buckets: BotGenerationStatsBucket[];
  /** 全局排行，scope=all 时返回前 10。 */
  ranking?: BotGenerationStatsRankItem[];
};

/** drawing-service 记录主任务子任务的内部请求体。 */
export type GenerationAppendSubTaskRequest = {
  /** 所属主任务 ID。 */
  taskId: string;
  /** 子任务类型。 */
  kind: GenerationSubTaskKind;
  /** 子任务状态。 */
  status: GenerationSubTaskStatus;
  /** 任务级尝试序号。 */
  attemptNo?: number;
  /** 站点 ID。 */
  siteId?: number;
  /** 站点名称。 */
  siteName?: string;
  /** 模型名称。 */
  model?: string;
  /** 是否可重试。 */
  retryable?: boolean;
  /** 下一步重试动作。 */
  nextAction?: GenerationRetryNextAction;
  /** 耗时毫秒。 */
  latencyMs?: number;
  /** 清洗后的中文错误。 */
  error?: string;
  /** 脱敏后的原始错误，仅管理排障使用。 */
  rawError?: string;
  /** 子任务开始时间。 */
  startedAt?: string;
  /** 子任务结束时间。 */
  finishedAt?: string;
};

/** drawing-service 更新主任务状态的内部请求体。 */
export type GenerationUpdateTaskStatusRequest = {
  /** 主任务 ID。 */
  taskId: string;
  /** 新状态。 */
  status: DrawingStatus;
  /** 清洗后的主任务错误。 */
  error?: string;
};

/** 内部子任务写入响应体。 */
export type GenerationAppendSubTaskResponse = {
  /** 写入后的子任务视图。 */
  subTask: GenerationSubTaskView;
};

/** 内部主任务状态更新响应体。 */
export type GenerationUpdateTaskStatusResponse = {
  /** 更新后的主任务视图。 */
  task: GenerationTaskView;
};

/** 绘图生成请求必须包含主任务 ID 和幂等请求 ID；QQ 号仅 Bot 或已绑定 Web 任务携带。 */
export type DrawingGenerateRequest = {
  /** backend 已创建的主任务 ID。 */
  taskId: string;
  /** 调用方生成的幂等请求 ID。 */
  clientRequestId: string;
  /** 调用来源。 */
  source: DrawingSource;
  /** 绘图模式。 */
  mode: DrawingMode;
  /** 用户提示词。 */
  prompt: string;
  /** 任务关联 QQ 号；未绑定 QQ 的 Web 任务为空。 */
  qqNumber?: string;
  /** Web 用户 ID。 */
  userId?: number;
  /** 模板 ID。 */
  templateId?: number;
  /** 图生图参考图 URL。 */
  sourceImageUrls?: string[];
  /** 本次任务是否私密。 */
  isPrivate?: boolean;
  /** 是否异步提交，当前默认 true。 */
  asyncSubmit?: boolean;
  /** 用户偏好模型，空则由站点选择逻辑自动匹配。 */
  preferredModel?: string;
  /** 任务创建时固化的模型级最大上游尝试次数，范围 1-10。 */
  maxAttempts: number;
  /** 生成尺寸（auto/1024x1024/1792x1024/1024x1792）。 */
  size?: string;
  /** 统一画幅比例；显式比例优先于历史 size，并由 Worker 转换为真实上游字段。 */
  aspectRatio?: DrawingAspectRatio;
  /** 生成质量（auto/standard/hd）。 */
  quality?: string;
  /** 视频时长，单位秒。 */
  duration?: number;
  /** 视频分辨率档位。 */
  resolution?: DrawingVideoResolution;
  /** backend 校验并固化的 LoRA 文件快照；只允许兼容的 ComfyUI 图片任务携带。 */
  lora?: DrawingLoraSnapshot;
};

/** drawing-service 接收生成主任务后的响应，不伪造尚未生成的图片结果。 */
export type DrawingGenerateAcceptedResponse = {
  /** 是否已被 drawing-service 接收。 */
  accepted: true;
  /** 主任务 ID。 */
  taskId: string;
  /** 幂等请求 ID。 */
  clientRequestId: string;
  /** 接收后的主任务状态。 */
  status: DrawingStatus;
  /** drawing-service 写入的调度子任务。 */
  subTask?: GenerationSubTaskView;
};

/** 兼容后续同步成功场景的绘图生成响应，只暴露清洗后的结果字段。 */
export type DrawingGenerateResultResponse = {
  /** 主任务 ID。 */
  id: string;
  /** 当前任务状态。 */
  status: DrawingStatus;
  /** 成功后的图片 URL。 */
  imageUrl?: string;
  /** 成功后的缩略图 URL。 */
  thumbnailUrl?: string;
  /** 成功结果媒体类型。 */
  mediaType?: DrawingResultMediaType;
  /** 成功后的视频 URL。 */
  videoUrl?: string;
  /** 失败时的清洗后错误。 */
  error?: string;
};

/** drawing-service 生成接口响应联合类型。 */
export type DrawingGenerateResponse = DrawingGenerateAcceptedResponse | DrawingGenerateResultResponse;

/** 用户端公开绘图配置响应体，供生成页和工作台共享后台交互限制。 */
export type DrawingPublicConfigResponse = {
  /** 是否开放单次多图生成。 */
  multiEnabled: boolean;
  /** 单次多图最大数量。 */
  multiCountMax: number;
  /** 后台当前生效的提示词最大字符数。 */
  maxPromptLength: number;
};

/** 绘图运行时配置响应体，供 backend、drawing-worker 和 bot-service 共享读取口径。 */
export type DrawingRuntimeConfigResponse = {
  /** 同站请求级重试次数。 */
  siteRequestRetries: number;
  /** 换站重试范围。 */
  retryScope: 'single_site' | 'all_enabled';
  /** 站点选择策略。 */
  siteSelectionMode: 'weighted' | 'random';
  /** 是否忽略不可重试错误继续换站。 */
  ignoreErrors: boolean;
  /** Bot 是否发送重试通知卡片。 */
  retryNotifyEnabled: boolean;
  /** Bot 提交卡片是否展示参考图；关闭可减少截图解码成本。 */
  botSubmittedRefsEnabled: boolean;
  /** Bot 最终失败卡片是否展示参考图；关闭可减少失败通知渲染耗时。 */
  botFailedRefsEnabled: boolean;
  /** 同站请求间隔毫秒。 */
  siteRequestDelayMs: number;
  /** 站点连续失败自动禁用阈值。 */
  autoDisableThreshold: number;
  /** 站点自动禁用冷却分钟数。 */
  autoDisableMinutes: number;
  /** 默认生成尺寸。 */
  defaultSize: string;
  /** 默认生成质量。 */
  defaultQuality: string;
  /** 默认模型。 */
  defaultModel: string;
  /** 默认审核等级。 */
  defaultModeration: string;
  /** Bot 绘图命令冷却秒数。 */
  cooldownSeconds: number;
  /** 最大提示词长度。 */
  maxPromptLength: number;
  /** 是否阻塞同身份生成中再次提交。 */
  blockDuringGeneration: boolean;
  /** 单次上游请求超时毫秒。 */
  requestTimeoutMs: number;
  /** 每日免费余额总额。 */
  freeBalanceDaily: number;
  /** Worker 轮询间隔毫秒。 */
  pollIntervalMs: number;
  /** 任务超时判定分钟数。 */
  staleTaskMinutes: number;
  /** 站点默认超时秒数。 */
  siteDefaultTimeoutSec: number;
  /** 站点默认最大并发。 */
  siteDefaultMaxConcurrency: number;
  /** Bot 命令前缀。 */
  botCmdPrefix: string;
  /** 是否允许一次提交生成多张。 */
  multiEnabled: boolean;
  /** 单次提交最多生成张数。 */
  multiCountMax: number;
  /** 多图批次内最大并发数。 */
  multiConcurrency: number;
  /** 批次连续失败停止阈值。 */
  multiStopAfterConsecutiveFailures: number;
};
