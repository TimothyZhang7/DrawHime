/**
 * 本文件定义主站与独立本地模型平台之间的身份交换契约，不包含密码和余额副本。
 */
import type { ApiErrorResponse } from '../common/api-error.js';
import type { UserRole } from '../auth/auth-context.js';

/** 主站签发给独立平台的用户身份摘要。 */
export interface LocalPlatformIdentityView {
  issuer: string;
  subject: string;
  displayName: string;
  avatarUrl: string | null;
  roles: UserRole[];
  emailVerified: boolean;
  issuedAt: string;
}

/** 主站身份交换响应。 */
export type LocalPlatformIdentityExchangeResponse =
  | { ok: true; data: LocalPlatformIdentityView }
  | ApiErrorResponse;

/** 独立平台计费与图库归属的主站身份类型。 */
export type LocalPlatformWalletOwnerType = 'user' | 'qq';

/** 独立平台发布到主站的价格版本。 */
export interface LocalPlatformPricePublishRequest {
  productCode: string;
  pricingVersion: number;
  unitPrice: string;
  billingUnit: 'image' | 'training_job';
  currency: 'CNY';
}

/** 主站权威价格镜像视图。 */
export interface LocalPlatformPriceVersionView extends LocalPlatformPricePublishRequest {
  active: boolean;
}

/** 独立平台创建钱包预留的请求；金额由主站按价格镜像计算。 */
export interface LocalPlatformBillingReservationCreateRequest {
  externalTaskId: string;
  idempotencyKey: string;
  walletOwnerType: LocalPlatformWalletOwnerType;
  userSubject: string;
  productCode: string;
  pricingVersion: number;
  quantity: number;
}

/** 钱包预留提交或释放请求。 */
export interface LocalPlatformBillingReservationFinalizeRequest {
  idempotencyKey: string;
  reason?: string;
}

/** 主站钱包预留视图，不暴露具体钱包 ID。 */
export interface LocalPlatformBillingReservationView {
  reservationId: string;
  externalTaskId: string;
  status: 'reserved' | 'committed' | 'released';
  productCode: string;
  pricingVersion: number;
  quantity: number;
  reservedAmount: string;
  freeUsed: string;
  paidUsed: string;
  currency: 'CNY';
  expiresAt?: string;
}

/** 价格发布响应。 */
export type LocalPlatformPricePublishResponse =
  | { ok: true; data: LocalPlatformPriceVersionView }
  | ApiErrorResponse;

/** 钱包预留响应。 */
export type LocalPlatformBillingReservationResponse =
  | { ok: true; data: LocalPlatformBillingReservationView }
  | ApiErrorResponse;

/** 独立平台迁移使用的已发布 LoRA 示例图摘要。 */
export interface LocalPlatformMigrationLoraExampleView {
  id: number;
  width: number;
  height: number;
  sizeBytes: number;
  sortOrder: number;
}

/** 独立平台迁移使用的已发布 LoRA 摘要，不包含文件路径和其他用户私有字段。 */
export interface LocalPlatformMigrationLoraView {
  id: number;
  owner: {
    subject: string;
    displayName: string;
    emailVerified: boolean;
  };
  title: string;
  description: string;
  baseModel: string;
  loraType: string;
  originalFileName: string;
  fileSizeBytes: number;
  sha256: string;
  publishedAt: string;
  examples: LocalPlatformMigrationLoraExampleView[];
}

/** 主站本地资产只读迁移快照。 */
export interface LocalPlatformMigrationSnapshotView {
  issuer: string;
  generatedAt: string;
  loras: LocalPlatformMigrationLoraView[];
}

/** 主站本地资产迁移快照响应。 */
export type LocalPlatformMigrationSnapshotResponse =
  | { ok: true; data: LocalPlatformMigrationSnapshotView }
  | ApiErrorResponse;

/** 独立平台向主站发布正式图库记录的请求。 */
export interface LocalPlatformGalleryPublicationRequest {
  idempotencyKey: string;
  artifactId: string;
  walletOwnerType: LocalPlatformWalletOwnerType;
  userSubject: string;
  sha256: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteSize: number;
  width: number;
  height: number;
  isPrivate: boolean;
  effectivePrompt: string;
  /** 独立提交给 Runtime 负面 conditioning 的提示词。 */
  negativePrompt?: string | null;
  modelDisplayName: string;
  parameters: Record<string, unknown>;
}

/** 主站正式图库发布结果，不包含主站内部媒体文件名。 */
export interface LocalPlatformGalleryPublicationView {
  publicationId: string;
  externalTaskId: string;
  status: 'pending' | 'publishing' | 'published' | 'failed';
  mainGalleryItemId: string | null;
  mediaUrl: string | null;
}

/** 主站正式图库发布响应。 */
export type LocalPlatformGalleryPublicationResponse =
  | { ok: true; data: LocalPlatformGalleryPublicationView }
  | ApiErrorResponse;

/** 主站删除正式图库记录后的同步结果，用于让独立平台隐藏对应任务记录。 */
export interface LocalPlatformGalleryRemovalView {
  externalTaskId: string;
  deleted: boolean;
}

/** 主站正式图库删除响应。 */
export type LocalPlatformGalleryRemovalResponse =
  | { ok: true; data: LocalPlatformGalleryRemovalView }
  | ApiErrorResponse;

/** Bot 可选择的独立平台本地模型。 */
export interface LocalPlatformBotModelView {
  modelVersionId: string;
  workflowVersionId: string;
  family: string;
  displayName: string;
  description: string | null;
  priceCny: string;
  defaultParameters: Record<string, unknown>;
}

/** Bot 通过主站提交的独立平台任务请求。 */
export interface LocalPlatformBotJobCreateRequest {
  idempotencyKey: string;
  qqNumber: string;
  displayName: string;
  modelVersionId: string;
  workflowVersionId: string;
  prompt: string;
  negativePrompt?: string | null;
  width: number;
  height: number;
  seed?: number | null;
  loraVersionIds: string[];
  isPrivate: boolean;
}

/** Bot 轮询使用的独立任务快照，图片地址只指向已发布的主站媒体。 */
export interface LocalPlatformBotJobView {
  id: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  progress: number;
  imageUrl?: string;
  error?: string;
  model: string;
  maxAttempts: number;
  subTasks: Array<{ kind: string; status: string; attemptNo?: number; siteName?: string; model?: string; error?: string; latencyMs?: number }>;
}

/** 独立平台 Bot 模型目录响应。 */
export type LocalPlatformBotCatalogResponse =
  | { ok: true; data: { models: LocalPlatformBotModelView[] } }
  | ApiErrorResponse;

/** 独立平台 Bot 任务创建响应。 */
export type LocalPlatformBotJobCreateResponse =
  | { ok: true; data: { job: LocalPlatformBotJobView; chargedAmount: string } }
  | ApiErrorResponse;

/** 独立平台 Bot 任务查询响应。 */
export type LocalPlatformBotJobListResponse =
  | { ok: true; data: { jobs: LocalPlatformBotJobView[] } }
  | ApiErrorResponse;
