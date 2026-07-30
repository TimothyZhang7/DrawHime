/**
 * 本文件集中定义本地模型平台跨程序使用的请求、响应和事件契约。
 * 所有契约同时提供 Zod 运行时校验与 TypeScript 静态类型。
 */
import { z } from "zod";
export * from "./training-trigger-words.js";

/** 统一成功响应。 */
export const successResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ ok: z.literal(true), data });

/** 统一失败响应。 */
export const errorResponseSchema = z.object({
  ok: z.literal(false),
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.unknown()).optional(),
});

/** 服务依赖状态。 */
export const dependencyStatusSchema = z.object({
  name: z.string().min(1),
  ready: z.boolean(),
  latencyMs: z.number().int().nonnegative().nullable(),
  message: z.string().min(1),
});

/** 服务存活状态。 */
export const serviceHealthViewSchema = z.object({
  service: z.string().min(1),
  status: z.literal("alive"),
  version: z.string().min(1),
  timestamp: z.string().datetime(),
  uptimeSeconds: z.number().nonnegative(),
});

/** 服务就绪状态。 */
export const serviceReadinessViewSchema = z.object({
  service: z.string().min(1),
  ready: z.boolean(),
  timestamp: z.string().datetime(),
  dependencies: z.array(dependencyStatusSchema),
});

/** 平台控制面总览。 */
export const platformOverviewViewSchema = z.object({
  platform: z.literal("drawhime-local-platform"),
  phase: z.enum(["foundation", "integration", "runtime"]),
  ready: z.boolean(),
  generatedAt: z.string().datetime(),
  services: z.array(serviceReadinessViewSchema),
  capabilities: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      status: z.enum(["available", "dependency_required", "planned"]),
      message: z.string().min(1),
    }),
  ),
});

/** 主站 SSO 身份视图。 */
export const externalIdentityViewSchema = z.object({
  id: z.string().min(1),
  issuer: z.string().url(),
  subject: z.string().min(1),
  displayName: z.string().min(1),
  avatarUrl: z.string().min(1).nullable(),
  roles: z.array(z.string().min(1)),
  lastAuthenticatedAt: z.string().datetime(),
});

/** 主站身份交换返回的最小身份摘要。 */
export const mainIdentityExchangeViewSchema = z.object({
  issuer: z.string().url(),
  subject: z.string().min(1),
  displayName: z.string().min(1),
  avatarUrl: z.string().min(1).nullable(),
  roles: z.array(z.enum(["user", "admin"])).min(1),
  emailVerified: z.boolean(),
  issuedAt: z.string().datetime(),
});

/** 独立平台浏览器会话视图。 */
export const localPlatformSessionViewSchema = z.object({
  identity: mainIdentityExchangeViewSchema.omit({ issuedAt: true }),
  sessionToken: z.string().min(32),
  expiresAt: z.string().datetime(),
});

/** 桌面端发起浏览器设备授权的请求。 */
export const desktopAuthorizationStartRequestSchema = z.object({
  deviceName: z.string().trim().min(1).max(80),
});

/** 桌面端设备授权创建结果；deviceCode 只返回给发起设备。 */
export const desktopAuthorizationRequestViewSchema = z.object({
  deviceCode: z.string().min(32),
  userCode: z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}$/),
  verificationUrl: z.string().url(),
  expiresAt: z.string().datetime(),
  intervalSeconds: z.number().int().min(2).max(30),
});

/** 桌面端使用设备密钥轮询授权状态。 */
export const desktopAuthorizationPollRequestSchema = z.object({
  deviceCode: z.string().min(32).max(256),
});

/** 浏览器已登录用户确认设备授权的请求。 */
export const desktopAuthorizationApproveRequestSchema = z.object({
  userCode: z.string().trim().min(8).max(9),
});

/** 设备授权轮询结果；会话只在授权完成后返回。 */
export const desktopAuthorizationPollViewSchema = z.object({
  status: z.enum(["pending", "authorized"]),
  intervalSeconds: z.number().int().min(2).max(30),
  session: localPlatformSessionViewSchema.nullable(),
});

/** 浏览器确认设备授权后的公开摘要。 */
export const desktopAuthorizationApprovalViewSchema = z.object({
  userCode: z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}$/),
  deviceName: z.string().min(1).max(80),
  approvedAt: z.string().datetime(),
});

/** 桌面核心向 WebView 返回的账号状态，不包含会话密钥。 */
export const desktopAccountViewSchema = z.object({
  status: z.enum(["signed_out", "connected", "offline", "expired"]),
  identity: mainIdentityExchangeViewSchema.omit({ issuedAt: true }).nullable(),
  expiresAt: z.string().datetime().nullable(),
  message: z.string().min(1),
});

/** 主站授权码交换请求。 */
export const mainSessionExchangeRequestSchema = z.object({
  code: z.string().min(16),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.string().url(),
});

/** 主站授权码交换响应。 */
export const mainSessionExchangeResponseSchema = z.object({
  identity: externalIdentityViewSchema,
  sessionToken: z.string().min(32),
  expiresAt: z.string().datetime(),
});

/** 钱包预留创建请求。 */
export const billingReservationCreateRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(191),
  jobId: z.string().min(1),
  walletOwnerType: z.enum(["user", "qq"]),
  userSubject: z.string().min(1),
  productCode: z.string().min(2).max(128),
  pricingVersion: z.number().int().positive(),
  quantity: z.number().int().min(1).max(32),
});

/** 钱包预留镜像视图。 */
export const billingReservationViewSchema = z.object({
  reservationId: z.string().min(1),
  externalTaskId: z.string().min(1),
  status: z.enum(["reserved", "committed", "released"]),
  productCode: z.string().min(1),
  pricingVersion: z.number().int().positive(),
  quantity: z.number().positive(),
  reservedAmount: z.string().regex(/^\d+\.\d{2}$/),
  freeUsed: z.string().regex(/^\d+\.\d{2}$/),
  paidUsed: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.literal("CNY"),
  expiresAt: z.string().datetime().optional(),
});

/** 钱包预留提交或释放请求。 */
export const billingReservationFinalizeRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(191),
  reservationId: z.string().min(1),
  jobId: z.string().min(1),
  reason: z.string().min(1).max(500).optional(),
});

/** 正式图库发布请求。 */
export const galleryPublicationCreateRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(191),
  jobId: z.string().min(1),
  artifactId: z.string().min(1),
  walletOwnerType: z.enum(["user", "qq"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string().min(1),
  byteSize: z.number().int().positive(),
  isPrivate: z.boolean(),
  effectivePrompt: z.string().min(1),
  negativePrompt: z.string().max(100000).nullable().optional(),
  userSubject: z.string().regex(/^\d+$/),
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  modelDisplayName: z.string().min(1).max(191),
  parameters: z.record(z.unknown()),
});

/** 正式图库发布镜像视图。 */
export const galleryPublicationViewSchema = z.object({
  publicationId: z.string().min(1),
  externalTaskId: z.string().min(1),
  status: z.enum(["pending", "publishing", "published", "failed"]),
  mainGalleryItemId: z.string().nullable(),
  mediaUrl: z.string().min(1).nullable(),
});

/** 主站正式图库删除后的同步结果。 */
export const galleryPublicationRemovalViewSchema = z.object({
  externalTaskId: z.string().min(1),
  deleted: z.boolean(),
});

/** 推理任务创建请求。 */
export const inferenceJobCreateRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(191),
  modelVersionId: z.string().min(1),
  workflowVersionId: z.string().min(1),
  prompt: z.string().min(1).max(100000),
  /** 是否在独立任务内执行一次 Anima AI 提示增强。 */
  promptEnhancement: z.boolean().optional().default(false),
  negativePrompt: z.string().max(100000).nullable().optional(),
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  batchSize: z.number().int().min(1).max(16),
  seed: z.number().int().nonnegative().nullable(),
  /** 单任务最多四个 LoRA，且同一版本不得重复叠加。 */
  loraVersionIds: z.array(z.string().min(1)).max(4).refine((items) => new Set(items).size === items.length, "同一 LoRA 不能重复选择"),
  /** 用户按 LoRA 单独设置的叠加强度，键必须属于本次选择的版本 ID。 */
  loraStrengths: z.record(z.number().min(0).max(1.5)).optional().default({}),
  sourceArtifactIds: z.array(z.string().min(1)).max(16),
  publishToGallery: z.boolean(),
  isPrivate: z.boolean(),
});

/** 推理与训练任务共用的队列位置和耗时估算。 */
export const jobQueueEstimateViewSchema = z.object({
  /** 当前任务在包含运行中任务的队列位置，从 1 开始。 */
  position: z.number().int().positive(),
  /** 当前任务前方尚未完成的任务数量。 */
  ahead: z.number().int().nonnegative(),
  /** 当前队列中等待执行的任务总数，包含当前任务但不包含运行中任务。 */
  total: z.number().int().positive(),
  /** 从现在到预计开始执行的秒数。 */
  estimatedWaitSeconds: z.number().int().nonnegative(),
  /** 当前任务自身预计占用 Runtime 的秒数。 */
  estimatedRunSeconds: z.number().int().positive(),
  /** 从现在到当前任务预计完成的总秒数。 */
  estimatedCompletionSeconds: z.number().int().positive(),
});

/** 推理任务视图。 */
export const inferenceJobViewSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  status: z.enum(["queued", "reserving", "ready", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number().min(0).max(100),
  effectivePrompt: z.string().nullable(),
  requestedPrompt: z.string(),
  negativePrompt: z.string().nullable(),
  modelDisplayName: z.string(),
  parameters: z.record(z.unknown()),
  /** 只在任务尚未开始 Runtime 执行且确实位于队列时返回。 */
  queue: jobQueueEstimateViewSchema.nullable(),
  /** 任务创建时固化的 LoRA 选择及其可审计封面。 */
  loras: z.array(z.object({
    loraVersionId: z.string(),
    title: z.string(),
    type: z.enum(["style", "character", "concept", "clothing", "pose", "other"]),
    strength: z.number().min(0).max(1.5),
    cover: z.object({
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      contentUrl: z.string(),
    }).nullable(),
  })),
  artifacts: z.array(z.object({
    id: z.string(),
    mimeType: z.string(),
    /** 产物内容哈希，用于核对独立对象与主站正式图库是否一致。 */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** 产物真实字节数使用字符串，避免 JSON 数字精度影响审计。 */
    byteSize: z.string().regex(/^\d+$/),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    contentUrl: z.string(),
  })),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  attempts: z.array(z.object({
    id: z.string(),
    attemptNumber: z.number().int().positive(),
    status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    runtimeJobId: z.string().nullable(),
    requestJson: z.record(z.unknown()).nullable(),
    responseJson: z.record(z.unknown()).nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })),
  stages: z.array(z.object({
    id: z.string(),
    sequence: z.number().int().nonnegative(),
    stageType: z.string(),
    status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    inputJson: z.record(z.unknown()).nullable(),
    outputJson: z.record(z.unknown()).nullable(),
    errorMessage: z.string().nullable(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })),
  billing: z.object({
    status: z.enum(["pending", "reserved", "committed", "released", "failed"]),
    amount: z.string().regex(/^\d+\.\d{2}$/),
    currency: z.string().length(3),
  }).nullable(),
  /** 选择发布到主站图库时的持久化同步终态；未选择发布时为空。 */
  publication: z.object({
    status: z.enum(["pending", "publishing", "published", "failed"]),
    mainGalleryItemId: z.string().nullable(),
    mediaUrl: z.string().nullable(),
    errorMessage: z.string().nullable(),
  }).nullable(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 用户端可选择的本地模型视图。 */
export const inferenceModelViewSchema = z.object({
  modelVersionId: z.string(),
  workflowVersionId: z.string(),
  family: z.string(),
  version: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  productCode: z.string(),
  pricingVersion: z.number().int().positive(),
  priceCny: z.string(),
  defaultParameters: z.record(z.unknown()),
});

/** Bot 经主站提交的本地单图任务请求。 */
export const localBotInferenceJobCreateRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(191),
  qqNumber: z.string().regex(/^[1-9][0-9]{4,19}$/),
  displayName: z.string().trim().min(1).max(191),
  modelVersionId: z.string().min(1),
  workflowVersionId: z.string().min(1),
  prompt: z.string().min(1).max(100000),
  negativePrompt: z.string().max(100000).nullable().optional(),
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  seed: z.number().int().nonnegative().nullable().optional(),
  loraVersionIds: z.array(z.string().min(1)).max(4),
  isPrivate: z.boolean(),
});

/** Bot 轮询的本地任务状态，媒体 URL 仅来自主站正式图库。 */
export const localBotInferenceJobViewSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "success", "failed"]),
  progress: z.number().min(0).max(100),
  imageUrl: z.string().optional(),
  error: z.string().optional(),
  model: z.string(),
  maxAttempts: z.number().int().min(1).max(10),
  subTasks: z.array(z.object({ kind: z.string(), status: z.string(), attemptNo: z.number().int().optional(), siteName: z.string().optional(), model: z.string().optional(), error: z.string().optional(), latencyMs: z.number().int().nonnegative().optional() })),
});

/** 用户生成时可选择且已经上传有效模型文件的 LoRA。 */
export const inferenceLoraViewSchema = z.object({
  loraVersionId: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.enum(["style", "character", "concept", "clothing", "pose", "other"]),
  modelFamily: z.string(),
  fileName: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  triggerWords: z.array(z.string()),
  privacy: z.enum(["public", "private"]),
});

/** 正式图库按任务版本 ID 读取的实时 LoRA 元数据。 */
export const galleryLoraMetadataViewSchema = z.object({
  loraVersionId: z.string(),
  loraEntryId: z.string(),
  title: z.string(),
  type: z.enum(["style", "character", "concept", "clothing", "pose", "other"]),
});

/** LoRA 仓库条目创建请求。 */
export const loraLibraryCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(191),
  description: z.string().trim().min(1).max(10000),
  type: z.enum(["style", "character", "concept", "clothing", "pose", "other"]),
  modelFamily: z.string().trim().min(1).max(100),
  triggerWords: z.array(z.string().trim().min(1).max(100)).max(32),
  isPrivate: z.boolean().default(false),
});

/** LoRA 作者在详情页可修改的元数据与外显范围。 */
export const loraLibraryUpdateRequestSchema = z.object({
  title: z.string().trim().min(1).max(191),
  description: z.string().trim().min(1).max(10000),
  type: z.enum(["style", "character", "concept", "clothing", "pose", "other"]),
  modelFamily: z.string().trim().min(1).max(100),
  triggerWords: z.array(z.string().trim().min(1).max(100)).max(32),
  isPrivate: z.boolean(),
});

/** LoRA 仓库条目视图。 */
export const loraLibraryEntryViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.enum(["style", "character", "concept", "clothing", "pose", "other"]),
  modelFamily: z.string(),
  modelFamilyName: z.string(),
  triggerWords: z.array(z.string()),
  ownerDisplayName: z.string(),
  privacy: z.enum(["public", "private"]),
  isOwner: z.boolean(),
  version: z.object({ id: z.string(), fileName: z.string(), sha256: z.string(), byteSize: z.number().int().positive() }).nullable(),
  examples: z.array(z.object({ id: z.string(), width: z.number().int().nullable(), height: z.number().int().nullable(), contentUrl: z.string() })),
  /** 最近引用该 LoRA 且已经公开发布到主站图库的任务。 */
  referenceTasks: z.array(z.object({
    id: z.string(),
    prompt: z.string(),
    modelDisplayName: z.string(),
    ownerDisplayName: z.string(),
    imageUrl: z.string(),
    galleryItemId: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    createdAt: z.string().datetime(),
  })).max(12),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 管理员按当前真实 Anima Runtime 格式登记底模。 */
export const modelLibraryCreateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(191),
  description: z.string().trim().min(1).max(10000),
  familyName: z.string().trim().min(1).max(100),
  modelFileName: z.string().trim().regex(/^[a-zA-Z0-9._-]+\.safetensors$/),
  modelSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  modelByteSize: z.number().int().positive(),
  sourceUrls: z.array(z.string().url().max(1000)).max(8).default([]),
  sourceUrl: z.string().url().max(1000).nullable().optional(),
  usageGuide: z.string().trim().min(1).max(20000),
  steps: z.number().int().min(1).max(50),
  cfg: z.number().min(0.1).max(20),
  sampler: z.enum(["er_sde", "euler", "euler_ancestral"]),
  scheduler: z.enum(["simple", "normal"]),
  samplingMaxEdge: z.number().int().min(512).max(1536),
  qualityPrefix: z.string().trim().min(1).max(2000),
  defaultNegativePrompt: z.string().trim().max(5000),
  productCode: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/),
  pricingVersion: z.number().int().positive(),
  priceCny: z.string().regex(/^\d{1,6}\.\d{2}$/),
  visible: z.boolean(),
});

/** 管理员编辑底模仓库展示信息。 */
export const modelLibraryUpdateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(191),
  description: z.string().trim().min(1).max(10000),
  sourceUrls: z.array(z.string().url().max(1000)).max(8).default([]),
  sourceUrl: z.string().url().max(1000).nullable().optional(),
  usageGuide: z.string().trim().min(1).max(20000),
  visible: z.boolean(),
});

/** 用户可浏览的底模仓库条目。 */
export const modelLibraryEntryViewSchema = z.object({
  id: z.string(), displayName: z.string(), description: z.string(), family: z.string(), familyName: z.string(), modelFileName: z.string(), runtimeFormat: z.string(), sourceUrl: z.string().nullable(), sourceLinks: z.array(z.object({ label: z.string(), url: z.string().url() })).max(8), usageGuide: z.string(), visible: z.boolean(), isAdmin: z.boolean(), priceCny: z.string(),
  parameters: z.object({ steps: z.number(), cfg: z.number(), sampler: z.string(), scheduler: z.string(), samplingMaxEdge: z.number(), maxEdge: z.number() }),
  examples: z.array(z.object({ id: z.string(), width: z.number().int().nullable(), height: z.number().int().nullable(), prompt: z.string().nullable(), contentUrl: z.string() })),
  referenceTasks: z.array(z.object({ id: z.string(), prompt: z.string(), imageUrl: z.string(), galleryItemId: z.string(), createdAt: z.string().datetime() })).max(12),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});

/** LoRA 分片上传会话创建请求。 */
export const loraUploadSessionCreateRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  totalBytes: z.number().int().positive().max(512 * 1024 * 1024),
});

/** LoRA 分片上传会话视图。 */
export const loraUploadSessionViewSchema = z.object({
  id: z.string(),
  loraEntryId: z.string(),
  fileName: z.string(),
  totalBytes: z.number().int().positive(),
  receivedBytes: z.number().int().nonnegative(),
  chunkSizeBytes: z.number().int().positive(),
  status: z.enum(["uploading", "completed", "cancelled"]),
  expiresAt: z.string().datetime(),
});

/** 推理任务取消请求。 */
export const inferenceJobCancelRequestSchema = z.object({
  reason: z.string().min(1).max(500),
});

/** 推理记录删除结果。 */
export const inferenceJobRemovalViewSchema = z.object({
  id: z.string().min(1),
  deleted: z.boolean(),
});

/** GPU Agent 心跳请求。 */
export const gpuAgentHeartbeatRequestSchema = z.object({
  hostId: z.string().min(1),
  agentVersion: z.string().min(1),
  timestamp: z.string().datetime(),
  devices: z.array(
    z.object({
      deviceKey: z.string().min(1),
      name: z.string().min(1),
      totalVramBytes: z.number().int().positive(),
      freeVramBytes: z.number().int().nonnegative(),
      utilizationPercent: z.number().min(0).max(100),
      temperatureCelsius: z.number().nullable(),
    }),
  ),
});

/** GPU 租约视图。 */
export const gpuLeaseViewSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  gpuDeviceId: z.string().min(1),
  status: z.enum(["offered", "accepted", "running", "released", "expired"]),
  leaseToken: z.string().min(32),
  expiresAt: z.string().datetime(),
});

/** 用户可调且会真实传入训练 Runtime 的参数。 */
export const trainingParametersSchema = z.object({
  rank: z.number().int().min(8).max(64),
  alpha: z.number().int().min(1).max(64),
  epochs: z.number().int().min(1).max(20),
  repeats: z.number().int().min(1).max(50),
  resolution: z.number().int().min(512).max(1536).refine((value) => value % 64 === 0, "训练分辨率必须是 64 的倍数"),
  learningRate: z.number().min(0.000001).max(0.01),
  lrScheduler: z.enum(["constant", "cosine", "cosine_with_restarts"]),
  warmupRatio: z.number().min(0).max(0.2),
  gradientAccumulationSteps: z.number().int().min(1).max(4),
  captionDropoutRate: z.number().min(0).max(0.3),
  shuffleCaption: z.boolean(),
  keepTokens: z.number().int().min(0).max(10),
  seed: z.number().int().min(0).max(2147483647),
  maxAttempts: z.number().int().min(1).max(3),
  samplePrompt: z.string().max(10000),
});

/** 训练任务创建请求。 */
export const trainingJobCreateRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(191),
  datasetId: z.string().min(1),
  baseModelVersionId: z.string().min(1),
  title: z.string().min(1).max(200),
  triggerWords: z.array(z.string().min(1)).min(1).max(32),
  parameters: trainingParametersSchema,
});

/** 训练动态价格试算请求。 */
export const trainingPriceQuoteRequestSchema = z.object({
  datasetId: z.string().min(1),
  baseModelVersionId: z.string().min(1),
  parameters: trainingParametersSchema,
});

/** 训练动态价格试算结果。 */
export const trainingPriceQuoteViewSchema = z.object({
  assetCount: z.number().int().min(5).max(200),
  imagePasses: z.number().int().positive(),
  estimatedOptimizerSteps: z.number().int().positive(),
  priceUnits: z.number().int().min(1).max(32),
  baseUnitPrice: z.string().regex(/^\d+\.\d{2}$/),
  estimatedPrice: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.literal("CNY"),
});

/** 训练数据集创建请求。 */
export const trainingDatasetCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(191),
  description: z.string().trim().max(10000).nullable().optional(),
});

/** 自动打标任务创建请求。 */
export const trainingCaptionJobCreateRequestSchema = z.object({ mode: z.enum(["character", "style", "concept"]) });

/** 数据集最近一次自动打标与确认阶段。 */
export const trainingCaptionStageViewSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(["dataset", "asset"]),
  assetId: z.string().nullable(),
  mode: z.enum(["character", "style", "concept"]),
  status: z.enum(["queued", "running", "awaiting_confirmation", "confirmed", "failed", "stale"]),
  progress: z.number().min(0).max(100),
  totalAssets: z.number().int().nonnegative(),
  completedAssets: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
  confirmedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 单个训练数据集视图。 */
export const trainingDatasetViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  triggerWords: z.array(z.string().min(1).max(200)).max(100),
  status: z.enum(["active", "disabled", "archived"]),
  ownerDisplayName: z.string(),
  assets: z.array(z.object({
    id: z.string(),
    artifactId: z.string(),
    caption: z.string().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    contentUrl: z.string(),
    captionStage: trainingCaptionStageViewSchema.nullable(),
    createdAt: z.string().datetime(),
  })),
  trainingJobCount: z.number().int().nonnegative(),
  captionStage: trainingCaptionStageViewSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 训练数据集 Caption 更新请求。 */
export const trainingDatasetAssetUpdateRequestSchema = z.object({ caption: z.string().trim().max(10000).nullable() });

/** 训练集触发词更新请求，空数组表示移除自动注入规则。 */
export const trainingDatasetTriggerWordsUpdateRequestSchema = z.object({ triggerWords: z.array(z.string().trim().max(200)).max(100) });

/** 训练集触发词汇总结果，包含精确交集与同义归一化后的稳定共识标签。 */
export const trainingDatasetTriggerSummaryViewSchema = z.object({
  triggerWords: z.array(z.string()).max(100),
  commonTags: z.array(z.string()).max(10000),
  consensusTags: z.array(z.string()).max(10000),
  summaryTags: z.array(z.string()).max(10000),
});

/** 训练集图片与同名标签压缩包的固定响应类型。 */
export const trainingDatasetArchiveMimeType = "application/zip" as const;

/** LoRA 打标工具批量翻译英文标签的请求。 */
export const trainingTagTranslationRequestSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
});

/** LoRA 打标工具的中英文标签对照结果。 */
export const trainingTagTranslationViewSchema = z.object({
  translations: z.array(z.object({
    tag: z.string().min(1),
    translated: z.string().min(1),
    color: z.string().regex(/^#[a-f0-9]{6}$/i),
    source: z.enum(["common", "ai"]),
  })).max(200),
});

/** 桌面端作品上传到网页图库时可选择的隐私权限。 */
export const desktopGalleryPrivacySchema = z.enum(["public", "private"]);

/** 桌面端本机环境的统一可用状态。 */
export const desktopEnvironmentStatusSchema = z.enum(["ready", "installable", "blocked", "degraded"]);

/** 桌面端启动、复检和任务提交前使用的本机环境报告。 */
export const desktopEnvironmentReportSchema = z.object({
  status: desktopEnvironmentStatusSchema,
  checkedAt: z.string().datetime(),
  os: z.object({ name: z.string(), version: z.string(), build: z.number().int().nonnegative().nullable(), arch: z.string(), supported: z.boolean() }),
  cpu: z.object({ name: z.string(), logicalCores: z.number().int().positive() }),
  memory: z.object({ totalBytes: z.number().int().nonnegative(), availableBytes: z.number().int().nonnegative(), virtualTotalBytes: z.number().int().nonnegative() }),
  gpus: z.array(z.object({ index: z.number().int().nonnegative(), uuid: z.string(), name: z.string(), vendor: z.string(), memoryTotalBytes: z.number().int().nonnegative(), memoryFreeBytes: z.number().int().nonnegative(), driverVersion: z.string(), computeCapability: z.string().nullable(), temperatureCelsius: z.number().nullable(), utilizationPercent: z.number().nullable() })),
  disks: z.array(z.object({ name: z.string(), fileSystem: z.string(), totalBytes: z.number().int().nonnegative(), availableBytes: z.number().int().nonnegative() })),
  runtime: z.object({ installed: z.boolean(), status: z.enum(["not_installed", "installed_unverified", "ready", "broken"]), rootPath: z.string() }),
  capabilities: z.object({ inference: z.boolean(), training: z.boolean(), captioning: z.boolean(), modelManagement: z.literal(true) }),
  issues: z.array(z.object({ code: z.string(), severity: z.enum(["info", "warning", "critical"]), title: z.string(), message: z.string(), action: z.string() })),
});

/** 桌面端保存在本机 SQLite 中的用户设置。 */
export const desktopSettingsSchema = z.object({
  themeMode: z.enum(["system", "dark", "light"]),
  dependencySource: z.enum(["auto", "official", "mirror"]),
  defaultPrivacy: desktopGalleryPrivacySchema,
  /** 登录账号后是否把新完成的本机图片自动同步到网页图库。 */
  autoUpload: z.boolean(),
  modelRoot: z.string().min(1),
  outputRoot: z.string().min(1),
  runtimeRoot: z.string().min(1),
  uploadConcurrency: z.number().int().min(1).max(4),
  wifiOnly: z.boolean(),
  bandwidthLimitKib: z.number().int().positive().nullable(),
});

/** 桌面端设置更新请求与持久化视图使用同一受控字段集合。 */
export const desktopSettingsUpdateSchema = desktopSettingsSchema;

/** 桌面 AI 辅助设置只返回凭据是否存在，密钥正文始终留在 Windows Credential Manager。 */
export const desktopAiSettingsSchema = z.object({
  enabled: z.boolean(),
  endpointType: z.enum(["openai_chat", "openai_responses"]),
  baseUrl: z.string(),
  model: z.string(),
  apiKeyConfigured: z.boolean(),
});

/** 保存 AI 辅助设置时，空密钥表示保留现有凭据，显式清除字段用于删除凭据。 */
export const desktopAiSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  endpointType: desktopAiSettingsSchema.shape.endpointType,
  baseUrl: z.string().trim().max(2048),
  model: z.string().trim().max(191),
  apiKey: z.string().trim().max(4096).nullable(),
  clearApiKey: z.boolean(),
});

/** AI 辅助分析使用本机受控图片路径与固定用途，不把任意上游请求结构交给页面。 */
export const desktopAiAnalyzeInputSchema = z.object({
  imagePath: z.string().min(1),
  purpose: z.enum(["caption", "reverse"]),
  userInstruction: z.string().trim().max(4000).nullable(),
});

/** AI 辅助返回可直接用于 Caption 或生成提示词的文本。 */
export const desktopAiAnalyzeViewSchema = z.object({
  purpose: desktopAiAnalyzeInputSchema.shape.purpose,
  text: z.string().min(1),
});

/** 桌面端资源文件的官方或主站镜像来源。 */
export const desktopResourceSourceSchema = z.object({
  kind: z.enum(["official", "mirror"]),
  url: z.string().url(),
});

/** 桌面签名资源类型，应用更新与普通依赖共用该稳定枚举。 */
export const desktopResourceKindSchema = z.enum(["runtime", "model", "lora", "captioner", "trainer", "application"]);

/** 把严格三段版本转换为可比较元组，资源签名前拒绝含糊版本。 */
function desktopSemanticVersion(value: string): [number, number, number] | null {
  const parts = value.split(".").map(Number);
  return parts.length === 3 && parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? [parts[0]!, parts[1]!, parts[2]!] : null;
}

/** 签名模型资源用于把同组文件组合成一个可用底模。 */
export const desktopResourceModelRegistrationSchema = z.object({
  groupId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,127}$/),
  displayName: z.string().min(1).max(191),
  family: z.string().min(1).max(100),
  workflowKind: z.enum(["checkpoint", "anima"]),
  role: z.enum(["primary", "text_encoder", "vae"]),
});

/** 签名清单内单个可安装资源的不可变描述。 */
export const desktopResourceManifestItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,127}$/),
  kind: desktopResourceKindSchema,
  version: z.string().min(1).max(100),
  os: z.literal("windows"),
  arch: z.enum(["x86_64", "aarch64"]),
  fileName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,254}$/),
  byteSize: z.number().int().positive(),
  installedSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  archive: z.enum(["raw", "zip", "7z"]),
  rootDirectory: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).nullable(),
  /** 原始模型文件只允许写入 ComfyUI 已登记的固定类别目录。 */
  installDirectory: z.enum(["checkpoints", "diffusion_models", "text_encoders", "vae", "loras"]).nullable().optional(),
  /** 同组资源全部安装后用于自动登记本地底模的签名元数据。 */
  modelRegistration: desktopResourceModelRegistrationSchema.nullable().optional(),
  /** application 资源专用的更新说明和最低可直接升级版本。 */
  applicationUpdate: z.object({
    minimumVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    releaseNotes: z.string().max(20000),
    mandatory: z.boolean(),
  }).nullable().optional(),
  required: z.boolean(),
  sources: z.array(desktopResourceSourceSchema).min(1).max(8),
}).superRefine((item, context) => {
  if (new Set(item.sources.map((source) => source.url)).size !== item.sources.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "同一资源的官方与镜像来源地址不得重复" });
  }
  const isApplication = item.kind === "application";
  if (isApplication && (item.archive !== "raw" || !item.fileName.toLowerCase().endsWith(".exe") || !item.applicationUpdate)) {
    context.addIssue({ code: "custom", path: ["applicationUpdate"], message: "application 资源必须是带更新元数据的原始 NSIS EXE" });
  }
  if (!isApplication && item.applicationUpdate) {
    context.addIssue({ code: "custom", path: ["applicationUpdate"], message: "非 application 资源不得声明软件更新元数据" });
  }
  if (isApplication && item.applicationUpdate) {
    const target = desktopSemanticVersion(item.version);
    const minimum = desktopSemanticVersion(item.applicationUpdate.minimumVersion);
    if (!target || !minimum || minimum[0] > target[0] || (minimum[0] === target[0] && minimum[1] > target[1]) || (minimum[0] === target[0] && minimum[1] === target[1] && minimum[2] > target[2])) {
      context.addIssue({ code: "custom", path: ["version"], message: "应用目标版本必须是三段版本且不低于最低升级版本" });
    }
  }
});

/** 服务端签名前的资源清单载荷。 */
export const desktopResourceManifestPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(["stable", "beta"]),
  generatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  resources: z.array(desktopResourceManifestItemSchema).max(500),
});

/** 服务端返回的 Ed25519 签名信封，签名目标是 payload 原始字节。 */
export const desktopResourceManifestEnvelopeSchema = z.object({
  keyId: z.string().min(1).max(100),
  payload: z.string().min(2).max(5 * 1024 * 1024),
  signature: z.string().min(80).max(200),
});

/** 桌面端验签并结合本地文件状态后的资源目录。 */
export const desktopResourceCatalogViewSchema = z.object({
  configured: z.boolean(),
  keyId: z.string().nullable(),
  generatedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  message: z.string(),
  resources: z.array(z.object({
    id: z.string(),
    kind: desktopResourceKindSchema,
    version: z.string(),
    fileName: z.string(),
    byteSize: z.number().int().positive(),
    installedSize: z.number().int().positive(),
    sha256: z.string(),
    required: z.boolean(),
    downloaded: z.boolean(),
    installed: z.boolean(),
    installPath: z.string().nullable(),
    sourceKinds: z.array(desktopResourceSourceSchema.shape.kind),
    /** 底模资源用于在仓库页合并同组文件并提供一键安装。 */
    modelRegistration: desktopResourceModelRegistrationSchema.nullable().optional(),
  })),
});

/** 桌面端资源断点下载状态和进度事件。 */
export const desktopResourceDownloadViewSchema = z.object({
  resourceId: z.string(),
  status: z.enum(["queued", "downloading", "paused", "verifying", "downloaded", "failed"]),
  sourceKind: desktopResourceSourceSchema.shape.kind.nullable(),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  bytesPerSecond: z.number().int().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
  switchReason: z.string().nullable(),
  targetPath: z.string().nullable(),
  error: z.string().nullable(),
});

/** 桌面端资源从已验证缓存到正式目录的安装状态。 */
export const desktopResourceInstallViewSchema = z.object({
  resourceId: z.string(),
  status: z.enum(["verifying", "installing", "switching", "installed", "rolled_back", "failed"]),
  progress: z.number().min(0).max(100),
  installPath: z.string().nullable(),
  rollbackPath: z.string().nullable(),
  error: z.string().nullable(),
});

/** 桌面端受控 ComfyUI 子进程的实时生命周期状态。 */
export const desktopRuntimeStatusViewSchema = z.object({
  status: z.enum(["stopped", "starting", "ready", "stopping", "failed"]),
  pid: z.number().int().positive().nullable(),
  port: z.number().int().min(1024).max(65535).nullable(),
  startedAt: z.string().datetime().nullable(),
  checkedAt: z.string().datetime(),
  logPath: z.string().nullable(),
  error: z.string().nullable(),
});

/** 桌面端导入并持久登记的本地底模。 */
export const desktopLocalModelViewSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
  family: z.string().min(1),
  workflowKind: z.enum(["checkpoint", "anima"]),
  modelFileName: z.string().min(1),
  modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive(),
  textEncoderFileName: z.string().nullable(),
  vaeFileName: z.string().nullable(),
  available: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 桌面端从用户已有文件导入底模的请求。 */
export const desktopLocalModelImportInputSchema = z.object({
  displayName: z.string().trim().min(1).max(191),
  family: z.string().trim().min(1).max(100),
  workflowKind: desktopLocalModelViewSchema.shape.workflowKind,
  modelSourcePath: z.string().min(1),
  textEncoderSourcePath: z.string().min(1).nullable(),
  vaeSourcePath: z.string().min(1).nullable(),
});

/** 桌面端本机 LoRA 的可用视图。 */
export const desktopLocalLoraViewSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  type: z.enum(["style", "character", "concept", "clothing", "pose", "other"]),
  fileName: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive(),
  triggerWords: z.array(z.string().min(1)).max(50),
  available: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 桌面端导入 LoRA 的用户输入。 */
export const desktopLocalLoraImportInputSchema = z.object({
  title: z.string().trim().min(1).max(191),
  type: desktopLocalLoraViewSchema.shape.type,
  sourcePath: z.string().min(1),
  triggerWords: z.array(z.string().trim().min(1).max(100)).max(50),
});

/** 桌面端展示的当前账号网站 LoRA 目录，不包含对象存储键。 */
export const desktopWebsiteLoraViewSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  type: desktopLocalLoraViewSchema.shape.type,
  modelFamily: z.string(),
  modelFamilyName: z.string(),
  triggerWords: z.array(z.string()),
  ownerDisplayName: z.string(),
  privacy: desktopGalleryPrivacySchema,
  isOwner: z.boolean(),
  versionId: z.string().uuid(),
  fileName: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive(),
  installed: z.boolean(),
  /** 已由桌面核心鉴权下载到应用数据目录的封面文件。 */
  coverPath: z.string().nullable(),
  /** 已逐张容错缓存的全部示例图片，第一张同时作为封面。 */
  examplePaths: z.array(z.string()),
});

/** 桌面端展示的网站底模仓库条目，封面只返回本机缓存路径。 */
export const desktopWebsiteModelViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  family: z.string(),
  familyName: z.string(),
  modelFileName: z.string(),
  runtimeFormat: z.string(),
  usageGuide: z.string(),
  sourceLinks: z.array(z.object({ label: z.string(), url: z.string().url() })).max(8),
  parameters: z.object({ steps: z.number(), cfg: z.number(), sampler: z.string(), scheduler: z.string(), samplingMaxEdge: z.number(), maxEdge: z.number() }),
  coverPath: z.string().nullable(),
  /** 已逐张容错缓存的全部示例图片，详情页按原始顺序展示。 */
  examplePaths: z.array(z.string()),
});

/** 网站 LoRA 断点下载、校验和安装进度。 */
export const desktopWebsiteLoraInstallProgressSchema = z.object({
  loraId: z.string().uuid(),
  status: z.enum(["downloading", "verifying", "installing", "installed", "failed"]),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  bytesPerSecond: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

/** 桌面软件更新检查、暂存、应用和回滚状态。 */
export const desktopSoftwareUpdateViewSchema = z.object({
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  status: z.enum(["unavailable", "up_to_date", "available", "downloading", "downloaded", "staged", "applying", "failed"]),
  mandatory: z.boolean(),
  releaseNotes: z.string().nullable(),
  byteSize: z.number().int().nonnegative(),
  downloadedBytes: z.number().int().nonnegative(),
  rollbackVersion: z.string().nullable(),
  error: z.string().nullable(),
});

/** 离线更新要求同时提供安装包和签名信封。 */
export const desktopOfflineUpdateImportInputSchema = z.object({ installerPath: z.string().min(1), envelopePath: z.string().min(1) });

/** 桌面端本地训练集及逐图 Caption 视图。 */
export const desktopTrainingDatasetViewSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(191),
  type: z.enum(["character", "style", "concept"]),
  triggerWords: z.array(z.string().min(1).max(100)).max(50),
  status: z.enum(["draft", "review_ready", "confirmed"]),
  assets: z.array(z.object({
    id: z.string().uuid(),
    fileName: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    available: z.boolean(),
    caption: z.string().nullable(),
    captionSource: z.enum(["auto", "manual"]).nullable(),
    confirmed: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 桌面端创建本地训练集的输入。 */
export const desktopTrainingDatasetCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(191),
  type: desktopTrainingDatasetViewSchema.shape.type,
  triggerWords: z.array(z.string().trim().min(1).max(100)).max(50),
});

/** 桌面端向训练集批量导入图片的输入。 */
export const desktopTrainingImagesAddInputSchema = z.object({
  datasetId: z.string().uuid(),
  sourcePaths: z.array(z.string().min(1)).min(1).max(200),
});

/** 桌面端保存单张训练图片 Caption 的输入。 */
export const desktopTrainingCaptionUpdateInputSchema = z.object({
  datasetId: z.string().uuid(),
  assetId: z.string().uuid(),
  caption: z.string().trim().max(10000).nullable(),
});

/** 桌面端训练集 ID 输入，供确认等幂等命令使用。 */
export const desktopTrainingDatasetIdInputSchema = z.object({ datasetId: z.string().uuid() });

/** 桌面端离线自动打标任务的创建参数。 */
export const desktopCaptionJobCreateInputSchema = z.object({
  datasetId: z.string().uuid(),
  assetId: z.string().uuid().nullable(),
  generalThreshold: z.number().min(0.05).max(0.95),
  characterThreshold: z.number().min(0.05).max(0.99),
  includeCharacterTags: z.boolean(),
});

/** 桌面端离线自动打标任务中的逐图状态。 */
export const desktopCaptionJobItemViewSchema = z.object({
  assetId: z.string().uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed", "skipped", "cancelled"]),
  caption: z.string().nullable(),
  error: z.string().nullable(),
});

/** 桌面端持久化离线自动打标任务视图。 */
export const desktopCaptionJobViewSchema = z.object({
  id: z.string().uuid(),
  datasetId: z.string().uuid(),
  assetId: z.string().uuid().nullable(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number().int().min(0).max(100),
  totalAssets: z.number().int().nonnegative(),
  processedAssets: z.number().int().nonnegative(),
  succeededAssets: z.number().int().nonnegative(),
  failedAssets: z.number().int().nonnegative(),
  skippedAssets: z.number().int().nonnegative(),
  generalThreshold: z.number().min(0.05).max(0.95),
  characterThreshold: z.number().min(0.05).max(0.99),
  includeCharacterTags: z.boolean(),
  error: z.string().nullable(),
  items: z.array(desktopCaptionJobItemViewSchema).max(200),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

/** 桌面端真实 LoRA 训练任务固化的用户参数。 */
export const desktopTrainingParametersSchema = z.object({
  rank: z.number().int().min(8).max(64),
  alpha: z.number().int().min(1).max(64),
  epochs: z.number().int().min(1).max(20),
  repeats: z.number().int().min(1).max(50),
  resolution: z.number().int().min(512).max(1536).refine((value) => value % 64 === 0, "训练分辨率必须是 64 的倍数"),
  learningRate: z.number().min(0.000001).max(0.01),
  lrScheduler: z.enum(["constant", "cosine", "cosine_with_restarts"]),
  warmupRatio: z.number().min(0).max(0.2),
  gradientAccumulationSteps: z.number().int().min(1).max(4),
  captionDropoutRate: z.number().min(0).max(0.3),
  shuffleCaption: z.boolean(),
  keepTokens: z.number().int().min(0).max(10),
  seed: z.number().int().min(0).max(2147483647),
});

/** 桌面端创建真实 LoRA 训练任务的输入。 */
export const desktopTrainingJobCreateInputSchema = z.object({
  datasetId: z.string().uuid(),
  modelId: z.string().uuid(),
  title: z.string().trim().min(1).max(191),
  parameters: desktopTrainingParametersSchema,
});

/** 桌面端训练尝试的持久化视图。 */
export const desktopTrainingAttemptViewSchema = z.object({
  id: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  status: z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]),
  error: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

/** 显存不足时返回的确定性降档建议。 */
export const desktopTrainingSuggestionViewSchema = z.object({
  message: z.string().min(1),
  resolution: z.number().int().min(512).max(1536).nullable(),
  rank: z.number().int().min(8).max(64).nullable(),
});

/** SQLite 作为事实源的桌面端 LoRA 训练任务。 */
export const desktopTrainingJobViewSchema = z.object({
  id: z.string().uuid(),
  datasetId: z.string().uuid(),
  datasetTitle: z.string().min(1),
  title: z.string().min(1),
  type: z.enum(["character", "style", "concept"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number().int().min(0).max(100),
  queuePosition: z.number().int().nonnegative(),
  currentEpoch: z.number().int().nonnegative(),
  totalEpochs: z.number().int().positive(),
  modelId: z.string().uuid(),
  modelDisplayName: z.string().min(1),
  triggerWords: z.array(z.string().min(1)).max(50),
  assetCount: z.number().int().min(5).max(200),
  parameters: desktopTrainingParametersSchema,
  attempts: z.array(desktopTrainingAttemptViewSchema).max(10),
  outputLoraId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  suggestion: desktopTrainingSuggestionViewSchema.nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

/** 本地生成质量预设；custom 表示用户已手动调整专业参数。 */
export const desktopGenerationQualityPresetSchema = z.enum(["fast", "quality", "extreme", "custom"]);

/** ComfyUI 官方 ImageScale 节点支持的输出缩放算法。 */
export const desktopGenerationUpscaleMethodSchema = z.enum(["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]);

/** 单个本地任务的 LoRA 选择以及模型、文本编码器独立强度。 */
export const desktopLocalLoraSelectionSchema = z.object({
  id: z.string().uuid(),
  strength: z.number().min(-2).max(2),
  clipStrength: z.number().min(-2).max(2),
});

/** 桌面端本地生成任务创建参数。 */
export const desktopLocalJobCreateInputSchema = z.object({
  modelId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(100000),
  negativePrompt: z.string().max(100000).nullable(),
  width: z.number().int().min(64).max(2048),
  height: z.number().int().min(64).max(2048),
  qualityPreset: desktopGenerationQualityPresetSchema,
  steps: z.number().int().min(1).max(80),
  cfg: z.number().min(0.1).max(20),
  samplerName: z.enum(["er_sde", "euler", "euler_ancestral"]),
  schedulerName: z.enum(["normal", "simple"]),
  samplingMaxEdge: z.number().int().min(512).max(2048),
  samplingPixelBudget: z.number().int().min(262144).max(4194304),
  aspectStepThreshold: z.number().min(1).max(4),
  aspectAdjustedSteps: z.number().int().min(1).max(80),
  upscaleMethod: desktopGenerationUpscaleMethodSchema,
  qualityPromptEnabled: z.boolean(),
  defaultNegativeEnabled: z.boolean(),
  seed: z.number().int().min(0).max(2147483647).nullable(),
  loras: z.array(desktopLocalLoraSelectionSchema).max(4).refine((items) => new Set(items.map((item) => item.id)).size === items.length, "同一 LoRA 不能重复选择"),
  privacy: desktopGalleryPrivacySchema,
});

/** 桌面端本地生成任务和产物的持久视图。 */
export const desktopLocalJobViewSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number().min(0).max(100),
  prompt: z.string(),
  negativePrompt: z.string().nullable(),
  modelId: z.string().uuid(),
  modelDisplayName: z.string(),
  modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
  parameters: z.object({
    width: z.number().int(),
    height: z.number().int(),
    qualityPreset: desktopGenerationQualityPresetSchema,
    steps: z.number().int(),
    cfg: z.number(),
    samplerName: z.string(),
    schedulerName: z.string(),
    samplingMaxEdge: z.number().int(),
    samplingPixelBudget: z.number().int(),
    aspectStepThreshold: z.number(),
    aspectAdjustedSteps: z.number().int(),
    upscaleMethod: desktopGenerationUpscaleMethodSchema,
    qualityPromptEnabled: z.boolean(),
    qualityPrefix: z.string().nullable(),
    defaultNegativeEnabled: z.boolean(),
    defaultNegativePrompt: z.string().nullable(),
    seed: z.number().int(),
  }),
  privacy: desktopGalleryPrivacySchema,
  runtimePromptId: z.string().nullable(),
  error: z.string().nullable(),
  loras: z.array(z.object({ id: z.string().uuid(), title: z.string(), type: desktopLocalLoraViewSchema.shape.type, fileName: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), strength: z.number().min(-2).max(2), clipStrength: z.number().min(-2).max(2), triggerWords: z.array(z.string()) })),
  attempts: z.array(z.object({ id: z.string().uuid(), attemptNumber: z.number().int().positive(), status: z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]), runtimePromptId: z.string().nullable(), error: z.string().nullable(), startedAt: z.string().datetime(), completedAt: z.string().datetime().nullable() })),
  artifact: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().positive(), mimeType: z.string(), width: z.number().int().positive(), height: z.number().int().positive() }).nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

/** 桌面端本地图库同步队列条目。 */
export const desktopGallerySyncItemSchema = z.object({
  id: z.string().uuid(),
  localTaskId: z.string().min(1),
  artifactPath: z.string().min(1),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  privacy: desktopGalleryPrivacySchema,
  status: z.enum(["queued", "waiting_network", "waiting_auth", "uploading", "committing", "synced", "privacy_pending", "paused", "failed_retryable", "failed_final", "remote_deleted"]),
  uploadedBytes: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  galleryItemId: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 桌面端创建图库分片上传会话时固化的真实产物与任务快照。 */
export const desktopGalleryUploadCreateRequestSchema = z.object({
  localTaskId: z.string().uuid(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  byteSize: z.number().int().positive().max(100 * 1024 * 1024),
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  privacy: desktopGalleryPrivacySchema,
  effectivePrompt: z.string().min(1).max(100000),
  negativePrompt: z.string().max(100000).nullable().optional(),
  modelDisplayName: z.string().min(1).max(191),
  parameters: z.record(z.unknown()),
});

/** 桌面图库上传会话视图，不暴露对象存储键或临时文件路径。 */
export const desktopGalleryUploadViewSchema = z.object({
  id: z.string().uuid(),
  localTaskId: z.string().uuid(),
  status: z.enum(["uploading", "ready", "publishing", "published", "failed_retryable", "remote_deleted"]),
  totalBytes: z.number().int().positive(),
  receivedBytes: z.number().int().nonnegative(),
  chunkSizeBytes: z.number().int().positive(),
  privacy: desktopGalleryPrivacySchema,
  mainGalleryItemId: z.string().nullable(),
  mediaUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  expiresAt: z.string().datetime(),
});

/** 桌面端首次加载时一次返回环境、设置和待同步数量。 */
export const desktopBootstrapViewSchema = z.object({
  environment: desktopEnvironmentReportSchema,
  settings: desktopSettingsSchema,
  runtime: desktopRuntimeStatusViewSchema,
  pendingGallerySyncCount: z.number().int().nonnegative(),
});

/** 训练任务视图。 */
export const trainingJobViewSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(["queued", "reserving", "ready", "running", "evaluating", "succeeded", "failed", "cancelled"]),
  progress: z.number().min(0).max(100),
  datasetId: z.string(),
  datasetTitle: z.string(),
  baseModelVersionId: z.string(),
  baseModelDisplayName: z.string(),
  parameters: z.record(z.unknown()),
  /** 只在任务尚未开始训练 Runtime 且确实位于队列时返回。 */
  queue: jobQueueEstimateViewSchema.nullable(),
  outputLoraVersionId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  attempts: z.array(z.object({
    id: z.string(), attemptNumber: z.number().int().positive(), status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]), runtimeJobId: z.string().nullable(), metrics: z.record(z.unknown()).nullable(), errorMessage: z.string().nullable(), startedAt: z.string().datetime().nullable(), completedAt: z.string().datetime().nullable(),
  })),
  billing: z.object({ status: z.enum(["pending", "reserved", "committed", "released", "failed"]), amount: z.string(), currency: z.string() }).nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 训练记录删除结果。 */
export const trainingJobRemovalViewSchema = z.object({
  id: z.string().min(1),
  deleted: z.boolean(),
});

/** GPU 训练 Runtime 提交请求。 */
export const trainingRuntimeSubmitRequestSchema = z.object({
  jobId: z.string().uuid(),
  baseModelFile: z.string().min(1),
  textEncoderFile: z.string().min(1),
  vaeFile: z.string().min(1),
  outputName: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  dataset: z.array(z.object({ url: z.string().url(), caption: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(5).max(200),
  parameters: trainingParametersSchema.omit({ maxAttempts: true }),
});

/** GPU 训练 Runtime 状态视图。 */
export const trainingRuntimeJobViewSchema = z.object({
  jobId: z.string().uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number().min(0).max(100),
  pid: z.number().int().positive().nullable(),
  currentEpoch: z.number().int().nonnegative(),
  totalEpochs: z.number().int().positive(),
  metrics: z.record(z.unknown()),
  errorMessage: z.string().nullable(),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  outputBytes: z.number().int().positive().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 管理端模型配置更新请求。 */
export const adminModelUpdateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(191),
  description: z.string().trim().max(10000).nullable(),
  active: z.boolean(),
  maxEdge: z.number().int().min(512).max(2048),
  maxAttempts: z.number().int().min(1).max(10),
  productCode: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/),
  pricingVersion: z.number().int().positive(),
  priceCny: z.string().regex(/^\d{1,6}\.\d{2}$/),
  trainingProductCode: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/),
  trainingPricingVersion: z.number().int().positive(),
  trainingPriceCny: z.string().regex(/^\d{1,6}\.\d{2}$/),
  /** 是否允许用户为该模型启用独立 Anima 提示增强。 */
  promptEnhancementEnabled: z.boolean(),
});

/** 管理端全局运行配置更新请求。 */
export const adminRuntimeConfigUpdateRequestSchema = z.object({
  /** 同一独立身份两次成功创建推理任务之间的最短秒数，0 表示关闭。 */
  inferenceSubmissionCooldownSeconds: z.number().int().min(0).max(3600),
});

/** 管理端 GPU 主机启停请求。 */
export const adminGpuHostUpdateRequestSchema = z.object({ active: z.boolean() });

/** 管理端不可变工作流版本启停请求。 */
export const adminWorkflowUpdateRequestSchema = z.object({ active: z.boolean() });

/** 管理端真实运行资产总览。 */
export const adminRuntimeOverviewViewSchema = z.object({
  generatedAt: z.string().datetime(),
  settings: z.object({ inferenceSubmissionCooldownSeconds: z.number().int().min(0).max(3600) }),
  queue: z.object({ reserving: z.number().int(), ready: z.number().int(), running: z.number().int(), failed: z.number().int(), succeeded: z.number().int() }),
  trainingQueue: z.object({ reserving: z.number().int(), ready: z.number().int(), running: z.number().int(), evaluating: z.number().int(), failed: z.number().int(), succeeded: z.number().int() }),
  gpuHosts: z.array(z.object({
    id: z.string(), agentKey: z.string(), displayName: z.string(), active: z.boolean(), agentVersion: z.string().nullable(), lastHeartbeatAt: z.string().datetime().nullable(),
    devices: z.array(z.object({ id: z.string(), name: z.string(), totalVramBytes: z.number(), freeVramBytes: z.number().nullable(), utilizationPercent: z.number().nullable(), temperatureCelsius: z.number().nullable(), activeLeaseJobId: z.string().nullable(), activeTrainingJobId: z.string().nullable(), lastHeartbeatAt: z.string().datetime().nullable() })),
  })),
  models: z.array(z.object({
    id: z.string(), family: z.string(), version: z.string(), displayName: z.string(), description: z.string().nullable(), active: z.boolean(), defaultParameters: z.record(z.unknown()),
    workflows: z.array(z.object({ id: z.string(), name: z.string(), version: z.number().int(), active: z.boolean(), sha256: z.string(), runtimeType: z.string() })),
  })),
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type ServiceHealthView = z.infer<typeof serviceHealthViewSchema>;
export type ServiceReadinessView = z.infer<typeof serviceReadinessViewSchema>;
export type PlatformOverviewView = z.infer<typeof platformOverviewViewSchema>;
export type ExternalIdentityView = z.infer<typeof externalIdentityViewSchema>;
export type MainIdentityExchangeView = z.infer<typeof mainIdentityExchangeViewSchema>;
export type LocalPlatformSessionView = z.infer<typeof localPlatformSessionViewSchema>;
export type DesktopAuthorizationStartRequest = z.infer<typeof desktopAuthorizationStartRequestSchema>;
export type DesktopAuthorizationRequestView = z.infer<typeof desktopAuthorizationRequestViewSchema>;
export type DesktopAuthorizationPollRequest = z.infer<typeof desktopAuthorizationPollRequestSchema>;
export type DesktopAuthorizationApproveRequest = z.infer<typeof desktopAuthorizationApproveRequestSchema>;
export type DesktopAuthorizationPollView = z.infer<typeof desktopAuthorizationPollViewSchema>;
export type DesktopAuthorizationApprovalView = z.infer<typeof desktopAuthorizationApprovalViewSchema>;
export type DesktopAccountView = z.infer<typeof desktopAccountViewSchema>;
export type DesktopGalleryUploadCreateRequest = z.infer<typeof desktopGalleryUploadCreateRequestSchema>;
export type DesktopGalleryUploadView = z.infer<typeof desktopGalleryUploadViewSchema>;
export type DesktopWebsiteLoraView = z.infer<typeof desktopWebsiteLoraViewSchema>;
export type DesktopWebsiteLoraInstallProgress = z.infer<typeof desktopWebsiteLoraInstallProgressSchema>;
export type DesktopWebsiteModelView = z.infer<typeof desktopWebsiteModelViewSchema>;
export type DesktopSoftwareUpdateView = z.infer<typeof desktopSoftwareUpdateViewSchema>;
export type DesktopOfflineUpdateImportInput = z.infer<typeof desktopOfflineUpdateImportInputSchema>;
export type MainSessionExchangeRequest = z.infer<typeof mainSessionExchangeRequestSchema>;
export type MainSessionExchangeResponse = z.infer<typeof mainSessionExchangeResponseSchema>;
export type BillingReservationCreateRequest = z.infer<typeof billingReservationCreateRequestSchema>;
export type BillingReservationView = z.infer<typeof billingReservationViewSchema>;
export type BillingReservationFinalizeRequest = z.infer<typeof billingReservationFinalizeRequestSchema>;
export type GalleryPublicationCreateRequest = z.infer<typeof galleryPublicationCreateRequestSchema>;
export type GalleryPublicationView = z.infer<typeof galleryPublicationViewSchema>;
export type GalleryPublicationRemovalView = z.infer<typeof galleryPublicationRemovalViewSchema>;
export type InferenceJobCreateRequest = z.infer<typeof inferenceJobCreateRequestSchema>;
export type JobQueueEstimateView = z.infer<typeof jobQueueEstimateViewSchema>;
export type InferenceJobView = z.infer<typeof inferenceJobViewSchema>;
export type InferenceModelView = z.infer<typeof inferenceModelViewSchema>;
export type LocalBotInferenceJobCreateRequest = z.infer<typeof localBotInferenceJobCreateRequestSchema>;
export type LocalBotInferenceJobView = z.infer<typeof localBotInferenceJobViewSchema>;
export type InferenceLoraView = z.infer<typeof inferenceLoraViewSchema>;
export type GalleryLoraMetadataView = z.infer<typeof galleryLoraMetadataViewSchema>;
export type LoraLibraryCreateRequest = z.infer<typeof loraLibraryCreateRequestSchema>;
export type LoraLibraryUpdateRequest = z.infer<typeof loraLibraryUpdateRequestSchema>;
export type LoraLibraryEntryView = z.infer<typeof loraLibraryEntryViewSchema>;
export type ModelLibraryCreateRequest = z.infer<typeof modelLibraryCreateRequestSchema>;
export type ModelLibraryUpdateRequest = z.infer<typeof modelLibraryUpdateRequestSchema>;
export type ModelLibraryEntryView = z.infer<typeof modelLibraryEntryViewSchema>;
export type LoraUploadSessionCreateRequest = z.infer<typeof loraUploadSessionCreateRequestSchema>;
export type LoraUploadSessionView = z.infer<typeof loraUploadSessionViewSchema>;
export type InferenceJobCancelRequest = z.infer<typeof inferenceJobCancelRequestSchema>;
export type InferenceJobRemovalView = z.infer<typeof inferenceJobRemovalViewSchema>;
export type GpuAgentHeartbeatRequest = z.infer<typeof gpuAgentHeartbeatRequestSchema>;
export type GpuLeaseView = z.infer<typeof gpuLeaseViewSchema>;
export type TrainingJobCreateRequest = z.infer<typeof trainingJobCreateRequestSchema>;
export type TrainingJobView = z.infer<typeof trainingJobViewSchema>;
export type TrainingJobRemovalView = z.infer<typeof trainingJobRemovalViewSchema>;
export type TrainingParameters = z.infer<typeof trainingParametersSchema>;
export type TrainingPriceQuoteRequest = z.infer<typeof trainingPriceQuoteRequestSchema>;
export type TrainingPriceQuoteView = z.infer<typeof trainingPriceQuoteViewSchema>;
export type TrainingDatasetCreateRequest = z.infer<typeof trainingDatasetCreateRequestSchema>;
export type TrainingDatasetView = z.infer<typeof trainingDatasetViewSchema>;
export type TrainingTagTranslationRequest = z.infer<typeof trainingTagTranslationRequestSchema>;
export type TrainingTagTranslationView = z.infer<typeof trainingTagTranslationViewSchema>;
export type TrainingDatasetAssetUpdateRequest = z.infer<typeof trainingDatasetAssetUpdateRequestSchema>;
export type TrainingDatasetTriggerWordsUpdateRequest = z.infer<typeof trainingDatasetTriggerWordsUpdateRequestSchema>;
export type TrainingDatasetTriggerSummaryView = z.infer<typeof trainingDatasetTriggerSummaryViewSchema>;
export type TrainingCaptionJobCreateRequest = z.infer<typeof trainingCaptionJobCreateRequestSchema>;
export type TrainingCaptionStageView = z.infer<typeof trainingCaptionStageViewSchema>;
export type TrainingRuntimeSubmitRequest = z.infer<typeof trainingRuntimeSubmitRequestSchema>;
export type TrainingRuntimeJobView = z.infer<typeof trainingRuntimeJobViewSchema>;
export type DesktopGalleryPrivacy = z.infer<typeof desktopGalleryPrivacySchema>;
export type DesktopEnvironmentReport = z.infer<typeof desktopEnvironmentReportSchema>;
export type DesktopSettings = z.infer<typeof desktopSettingsSchema>;
export type DesktopSettingsUpdate = z.infer<typeof desktopSettingsUpdateSchema>;
export type DesktopAiSettings = z.infer<typeof desktopAiSettingsSchema>;
export type DesktopAiSettingsUpdate = z.infer<typeof desktopAiSettingsUpdateSchema>;
export type DesktopAiAnalyzeInput = z.infer<typeof desktopAiAnalyzeInputSchema>;
export type DesktopAiAnalyzeView = z.infer<typeof desktopAiAnalyzeViewSchema>;
export type DesktopResourceSource = z.infer<typeof desktopResourceSourceSchema>;
export type DesktopResourceManifestItem = z.infer<typeof desktopResourceManifestItemSchema>;
export type DesktopResourceManifestPayload = z.infer<typeof desktopResourceManifestPayloadSchema>;
export type DesktopResourceManifestEnvelope = z.infer<typeof desktopResourceManifestEnvelopeSchema>;
export type DesktopResourceCatalogView = z.infer<typeof desktopResourceCatalogViewSchema>;
export type DesktopResourceDownloadView = z.infer<typeof desktopResourceDownloadViewSchema>;
export type DesktopResourceInstallView = z.infer<typeof desktopResourceInstallViewSchema>;
export type DesktopRuntimeStatusView = z.infer<typeof desktopRuntimeStatusViewSchema>;
export type DesktopLocalModelView = z.infer<typeof desktopLocalModelViewSchema>;
export type DesktopLocalModelImportInput = z.infer<typeof desktopLocalModelImportInputSchema>;
export type DesktopLocalLoraView = z.infer<typeof desktopLocalLoraViewSchema>;
export type DesktopLocalLoraImportInput = z.infer<typeof desktopLocalLoraImportInputSchema>;
export type DesktopLocalLoraSelection = z.infer<typeof desktopLocalLoraSelectionSchema>;
export type DesktopTrainingDatasetView = z.infer<typeof desktopTrainingDatasetViewSchema>;
export type DesktopTrainingDatasetCreateInput = z.infer<typeof desktopTrainingDatasetCreateInputSchema>;
export type DesktopTrainingImagesAddInput = z.infer<typeof desktopTrainingImagesAddInputSchema>;
export type DesktopTrainingCaptionUpdateInput = z.infer<typeof desktopTrainingCaptionUpdateInputSchema>;
export type DesktopTrainingDatasetIdInput = z.infer<typeof desktopTrainingDatasetIdInputSchema>;
export type DesktopCaptionJobCreateInput = z.infer<typeof desktopCaptionJobCreateInputSchema>;
export type DesktopCaptionJobItemView = z.infer<typeof desktopCaptionJobItemViewSchema>;
export type DesktopCaptionJobView = z.infer<typeof desktopCaptionJobViewSchema>;
export type DesktopTrainingParameters = z.infer<typeof desktopTrainingParametersSchema>;
export type DesktopTrainingJobCreateInput = z.infer<typeof desktopTrainingJobCreateInputSchema>;
export type DesktopTrainingAttemptView = z.infer<typeof desktopTrainingAttemptViewSchema>;
export type DesktopTrainingSuggestionView = z.infer<typeof desktopTrainingSuggestionViewSchema>;
export type DesktopTrainingJobView = z.infer<typeof desktopTrainingJobViewSchema>;
export type DesktopLocalJobCreateInput = z.infer<typeof desktopLocalJobCreateInputSchema>;
export type DesktopLocalJobView = z.infer<typeof desktopLocalJobViewSchema>;
export type DesktopGallerySyncItem = z.infer<typeof desktopGallerySyncItemSchema>;
export type DesktopBootstrapView = z.infer<typeof desktopBootstrapViewSchema>;
export type AdminModelUpdateRequest = z.infer<typeof adminModelUpdateRequestSchema>;
export type AdminRuntimeConfigUpdateRequest = z.infer<typeof adminRuntimeConfigUpdateRequestSchema>;
export type AdminGpuHostUpdateRequest = z.infer<typeof adminGpuHostUpdateRequestSchema>;
export type AdminWorkflowUpdateRequest = z.infer<typeof adminWorkflowUpdateRequestSchema>;
export type AdminRuntimeOverviewView = z.infer<typeof adminRuntimeOverviewViewSchema>;
