/** 本文件定义管理后台图库标签与自动打标排障契约，供 backend 与 admin-portal 共享。 */
import type { GalleryPopularTagView } from '../gallery/gallery-contracts.js';

/** 图库自动打标任务状态。 */
export type GalleryTaggingJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

/** 管理后台图库打标配置摘要；敏感凭证只返回是否已配置。 */
export type AdminGalleryTaggingConfigView = {
  /** 自动打标是否启用。 */
  enabled: boolean;
  /** 是否允许把私密图发送给外部打标模型。 */
  includePrivate: boolean;
  /** 当前使用的 OpenAI 兼容模型名。 */
  model: string;
  /** API Base URL 是否已配置。 */
  hasBaseUrl: boolean;
  /** API Key 是否已配置；不得返回明文。 */
  hasApiKey: boolean;
  /** 未配置独立打标项时是否复用图片反推配置。 */
  usesImageReverseFallback: boolean;
  /** 单次上游超时秒数。 */
  timeoutSec: number;
  /** 单图最大标签数量。 */
  maxTags: number;
  /** 标签最小置信度阈值。 */
  minConfidence: number;
  /** AI 标签生成失败后的最大尝试次数。 */
  maxAttempts: number;
};

/** 管理后台图库打标队列状态计数。 */
export type AdminGalleryTaggingStatusCountView = {
  /** 队列状态。 */
  status: GalleryTaggingJobStatus;
  /** 对应状态的任务数。 */
  count: number;
};

/** 管理后台最近图库打标任务。 */
export type AdminGalleryTaggingJobView = {
  /** 打标 job ID。 */
  id: number;
  /** 关联生成任务 ID。 */
  taskId: string;
  /** 当前打标状态。 */
  status: GalleryTaggingJobStatus;
  /** 已尝试次数。 */
  attemptCount: number;
  /** 使用模型。 */
  model: string | null;
  /** 最近错误或跳过原因。 */
  error: string | null;
  /** 创建时间。 */
  createdAt: string;
  /** 更新时间。 */
  updatedAt: string;
  /** 开始时间。 */
  startedAt: string | null;
  /** 完成时间。 */
  finishedAt: string | null;
};

/** 管理后台图库标签概览响应。 */
export type AdminGalleryTagOverviewResponse = {
  /** 当前未禁用标签总数。 */
  tagCount: number;
  /** 任务与标签关联总数。 */
  taskTagCount: number;
  /** 公开成功且已打标图片数量。 */
  publicTaggedTaskCount: number;
  /** 公开成功且有最终图但尚无标签的图片数量。 */
  publicUntaggedTaskCount: number;
  /** 打标队列总任务数。 */
  jobCount: number;
  /** 打标队列分状态计数。 */
  jobsByStatus: AdminGalleryTaggingStatusCountView[];
  /** 最近 10 条打标任务。 */
  latestJobs: AdminGalleryTaggingJobView[];
  /** 当前打标配置摘要。 */
  config: AdminGalleryTaggingConfigView;
  /** 公开图库热门标签。 */
  popularTags: GalleryPopularTagView[];
};

/** 管理后台手动触发打标响应。 */
export type AdminGalleryTaggingRunResponse = {
  /** 本轮实际处理数量。 */
  processed: number;
  /** 本轮成功数量。 */
  succeeded: number;
  /** 本轮失败数量。 */
  failed: number;
  /** 本轮跳过数量。 */
  skipped: number;
};
