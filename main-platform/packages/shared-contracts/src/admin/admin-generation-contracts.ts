/** 本文件定义管理后台生成记录相关跨端契约，供 backend 与 admin-portal 共享。 */
import type { DrawingLoraSnapshot, GenerationSubTaskView } from '../drawing/drawing-contracts.js';
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';

/** 管理后台生成记录详情中的单图预览项。 */
export type AdminGenerationImageView = {
  /** 真实单图任务 ID。 */
  id: string;
  /** 批次内序号，从 1 开始。 */
  batchIndex?: number | null;
  /** 批次总张数。 */
  batchTotal?: number | null;
  /** 原图站内地址。 */
  imageUrl?: string | null;
  /** 缩略图站内地址。 */
  thumbnailUrl?: string | null;
  /** 视频结果站内地址。 */
  videoUrl?: string | null;
  /** 结果媒体类型。 */
  mediaType?: 'image' | 'video' | null;
  /** 视频时长，单位秒。 */
  duration?: number | null;
  /** 视频分辨率档位。 */
  resolution?: string | null;
  /** 视频画幅比例。 */
  aspectRatio?: string | null;
  /** 单图状态。 */
  status?: string;
};

/** 管理后台详情中的子任务视图；比公共子任务多返回已脱敏的上游原始错误。 */
export type AdminGenerationSubTaskView = GenerationSubTaskView & {
  /** 已脱敏的上游原始错误，仅管理后台可见。 */
  upstreamRawError?: string | null;
};

/** 管理后台展示的规范化任务请求参数；不包含鉴权头、站点密钥或余额信息。 */
export type AdminGenerationRequestParamsView = {
  /** 真实任务 ID。 */
  taskId: string;
  /** 调用方幂等请求 ID。 */
  clientRequestId: string;
  /** 按来源身份生成的稳定渠道亲和键。 */
  promptCacheKey: string;
  /** 批次 ID；单任务为空。 */
  batchId: string | null;
  /** 调用来源。 */
  source: string;
  /** 生成模式。 */
  mode: string;
  /** 完整提示词。 */
  prompt: string;
  /** 外部 AI 生成并实际发送给文生图上游的提示词；参考图为可选输入。 */
  effectivePrompt: string | null;
  /** 是否使用 AI 提示增强。 */
  referencePromptAssist: boolean;
  /** 模板 ID。 */
  templateId: number | null;
  /** 完整参考图 URL 列表。 */
  sourceImageUrls: string[];
  /** 创建请求记录的参考图字节数；历史任务缺失时为空。 */
  sourceImageSizes: number[] | null;
  /** 是否私密。 */
  isPrivate: boolean;
  /** 本次提交生成数量。 */
  count: number;
  /** 真实调度模型。 */
  model: string | null;
  /** 解析默认值后的尺寸参数。 */
  size: string;
  /** 统一画幅参数。 */
  aspectRatio: string | null;
  /** 解析默认值后的质量参数。 */
  quality: string;
  /** 视频时长；图片任务为空。 */
  duration: number | null;
  /** 视频分辨率；图片任务为空。 */
  resolution: string | null;
  /** 是否应用视频分镜设计。 */
  storyboardDesign: boolean;
  /** 模型级最大上游调用次数。 */
  maxAttempts: number;
  /** backend 校验并固化的 LoRA 文件快照；未选择时为空。 */
  lora: DrawingLoraSnapshot | null;
  /** 最近一次真实上游尝试的 HTTP 请求；仅在可由任务快照确定性还原时返回。 */
  upstreamRequest: AdminGenerationUpstreamRequestView | null;
};

/** 管理后台展示的已脱敏上游 HTTP 请求，不包含 Authorization。 */
export type AdminGenerationUpstreamRequestView = {
  /** 尝试序号。 */
  attemptNo: number;
  /** 站点 ID。 */
  siteId: number;
  /** 站点名称。 */
  siteName: string;
  /** 真实模型 ID。 */
  model: string;
  /** 站点模型协议格式。 */
  apiMode: string;
  /** HTTP 方法。 */
  method: 'POST';
  /** 完整上游 URL。 */
  url: string;
  /** Content-Type。 */
  contentType: string;
  /** 站点请求超时毫秒。 */
  timeoutMs: number;
  /** 实际发送的 JSON 请求体。 */
  body: Record<string, unknown>;
};

/** 管理后台详情中的单图任务视图；用于批次详情页的选项卡切换。 */
export type AdminGenerationTaskDetailView = {
  /** 真实单图任务 ID。 */
  id: string;
  /** 批次内序号，从 1 开始。 */
  batchIndex?: number | null;
  /** 批次总张数。 */
  batchTotal?: number | null;
  /** 单图状态。 */
  status: string;
  /** 调用来源。 */
  source: string;
  /** 绘图模式。 */
  mode: string;
  /** 提示词。 */
  prompt: string;
  /** QQ 号。 */
  qqNumber: string | null;
  /** 所属用户 ID。 */
  userId: number | null;
  /** 模板 ID。 */
  templateId?: number | null;
  /** 参考图 URL 列表。 */
  sourceImageUrls?: string[] | null;
  /** 是否私密。 */
  isPrivate: boolean;
  /** 错误信息。 */
  error?: string | null;
  /** 原图地址。 */
  imageUrl?: string | null;
  /** 缩略图地址。 */
  thumbnailUrl?: string | null;
  /** 视频结果站内地址。 */
  videoUrl?: string | null;
  /** 结果媒体类型。 */
  mediaType?: 'image' | 'video' | null;
  /** 视频时长，单位秒。 */
  duration?: number | null;
  /** 视频分辨率档位。 */
  resolution?: string | null;
  /** 视频画幅比例。 */
  aspectRatio?: string | null;
  /** 最近一次成功或失败上游尝试的模型。 */
  model?: string | null;
  /** 最近一次成功或失败上游尝试的站点。 */
  siteName?: string | null;
  /** 去重后的站点列表。 */
  sitesUsed?: string[];
  /** 真实上游尝试次数。 */
  attempts: number;
  /** 真实失败尝试次数。 */
  failedCount: number;
  /** 子任务数量。 */
  subTaskCount: number;
  /** 创建时间。 */
  createdAt: string;
  /** 开始时间。 */
  startedAt?: string | null;
  /** 完成时间。 */
  finishedAt?: string | null;
  /** 单图的完整子任务时间线。 */
  subTasks: AdminGenerationSubTaskView[];
  /** 该真实单图任务的完整规范化请求参数。 */
  requestParams: AdminGenerationRequestParamsView;
};

/** 管理后台生成记录列表项；n>1 时按批次聚合展示。 */
export type AdminGenerationListItemView = {
  /** 外显任务 ID；多图批次时为 batchId，单图时为真实任务 ID。 */
  id: string;
  /** 真实单图任务 ID；多图批次时用于后台详情和管理操作。 */
  taskId: string;
  /** 多图批次 ID；单图时为空。 */
  batchId?: string | null;
  /** 批次总张数；单图时为 1。 */
  batchTotal: number;
  /** 批次中当前可见的真实任务数。 */
  batchCount: number;
  /** 幂等请求键。 */
  clientRequestId: string;
  /** 所属用户 ID。 */
  userId: number | null;
  /** 调用来源。 */
  source: string;
  /** 绘图模式。 */
  mode: string;
  /** 提示词。 */
  prompt: string;
  /** QQ 号。 */
  qqNumber: string | null;
  /** 任务状态。 */
  status: string;
  /** 错误信息。 */
  error?: string | null;
  /** 是否私密。 */
  isPrivate: boolean;
  /** 结果图。 */
  imageUrl?: string | null;
  /** 结果缩略图。 */
  thumbnailUrl?: string | null;
  /** 视频结果站内地址。 */
  videoUrl?: string | null;
  /** 结果媒体类型。 */
  mediaType?: 'image' | 'video' | null;
  /** 视频时长，单位秒。 */
  duration?: number | null;
  /** 视频分辨率档位。 */
  resolution?: string | null;
  /** 视频画幅比例。 */
  aspectRatio?: string | null;
  /** 最后一次成功或失败上游尝试使用的模型。 */
  model?: string | null;
  /** 最后一次成功或失败上游尝试使用的站点。 */
  siteName?: string | null;
  /** 去重后的站点列表。 */
  sitesUsed?: string[];
  /** 真实上游尝试次数。 */
  attempts: number;
  /** 真实失败尝试次数。 */
  failedCount: number;
  /** 子任务数量。 */
  subTaskCount: number;
  /** 创建时间。 */
  createdAt: string;
  /** 开始时间。 */
  startedAt?: string | null;
  /** 完成时间。 */
  finishedAt?: string | null;
};

/** 管理后台生成记录详情；包含批次内全部真实子图和子任务时间线。 */
export type AdminGenerationDetailView = AdminGenerationListItemView & {
  /** 模板 ID。 */
  templateId?: number | null;
  /** 参考图 URL 列表。 */
  sourceImageUrls?: string[] | null;
  /** 批次内可见最终图。 */
  images?: AdminGenerationImageView[];
  /** 批次内全部真实单图任务。 */
  tasks: AdminGenerationTaskDetailView[];
  /** 主任务下的完整子任务时间线。 */
  subTasks: AdminGenerationSubTaskView[];
  /** 当前代表任务的完整规范化请求参数。 */
  requestParams: AdminGenerationRequestParamsView;
};

/** 管理后台生成记录列表响应。 */
export type AdminGenerationListResponse = {
  items: AdminGenerationListItemView[];
  total: number;
  page: number;
  pageSize: number;
};

/** 管理后台生成记录详情端点契约。 */
export type AdminGenerationDetailEndpoint = ApiEndpointContract<
  undefined,
  ApiDataResponse<AdminGenerationDetailView>
>;
