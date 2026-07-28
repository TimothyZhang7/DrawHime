/**
 * 本文件定义后台、backend 与 drawing-worker 共用的站点模型能力配置。
 * 参考图能力必须显式表达，不能通过静默截断来兼容只支持单图的上游模型。
 */

/** 站点模型调用协议。 */
export type SiteModelApiMode = 'openai_images' | 'bfl_image_generation' | 'grok_image_edit_json' | 'grok_video_generation' | 'comfyui_generation';

/** 站点模型业务类型。 */
export type SiteModelType = 'text_to_image' | 'image_to_image' | 'universal' | 'video' | 'text';

/** OpenAI Images 图生图 multipart 参考图字段名。 */
export type ReferenceImageField = 'image' | 'image[]';

/** 上游参考图超过原生上限时的处理策略。 */
export type ReferenceImageOverflowStrategy = 'reject' | 'combine';

/** 站点模型支持的画幅比例集合预设。 */
export type SiteModelAspectRatioSupport = 'all' | 'gpt_image' | 'grok_video' | 'square_only' | 'auto_only';

/** 单站点模型配置契约。 */
export type ApiSiteModelOption = {
  /** 上游真实模型 ID。 */
  name: string;
  /** 后台模型设置映射出的统一模型名；仅在内部运行时配置中派生。 */
  canonicalName?: string;
  /** 模型支持的绘图类型。 */
  type: SiteModelType;
  /** 上游调用协议。 */
  apiMode?: SiteModelApiMode;
  /** 最大参考图数量；0 表示不支持参考图，当前业务上限为 8。 */
  maxReferenceImages?: number;
  /** OpenAI Images multipart 参考图字段策略。 */
  referenceImageField?: ReferenceImageField;
  /** 超过原生上限时拒绝任务或把全部参考图合并成一张网格图。 */
  referenceImageOverflowStrategy?: ReferenceImageOverflowStrategy;
  /** 上游真实支持的画幅比例预设；用于前端选项和 Worker 候选筛选。 */
  aspectRatioSupport?: SiteModelAspectRatioSupport;
  /** 每小时可用开始分钟。 */
  availableMinuteStart?: number;
  /** 每小时可用结束分钟。 */
  availableMinuteEnd?: number;
  /** 模型是否启用。 */
  enabled: boolean;
};

/** Backend 向绘图服务和 Worker 返回的站点运行时配置。 */
export type ApiSiteRuntimeConfig = {
  /** 站点数据库 ID。 */
  id: number;
  /** 站点名称。 */
  name: string;
  /** 上游 API 基础地址。 */
  baseUrl: string;
  /** 上游 API 密钥，只允许在内部服务间传递。 */
  apiKey: string;
  /** 站点默认模型。 */
  model: string;
  /** 调度权重。 */
  weight: number;
  /** 站点是否启用。 */
  isEnabled: boolean;
  /** 单次上游请求超时秒数。 */
  timeoutSec: number;
  /** 上游响应格式配置。 */
  responseFormat: string;
  /** 是否向上游发送 response_format 参数。 */
  sendResponseFormat: boolean;
  /** 是否向上游发送稳定的 prompt_cache_key 渠道亲和键。 */
  sendPromptCacheKey: boolean;
  /** Auto 尺寸是否改传第一张参考图的实际宽高。 */
  autoSizeFromReference: boolean;
  /** 每分钟并发上限。 */
  maxConcurrency: number;
  /** 连续失败次数。 */
  consecutiveFailures: number;
  /** 自动停用截止时间。 */
  autoDisabledUntil: string | null;
  /** 自动停用原因。 */
  autoDisabledReason: string | null;
  /** 站点真实模型能力列表。 */
  modelOptions: ApiSiteModelOption[];
};

/** 内部站点运行时配置成功响应。 */
export type ApiSiteRuntimeConfigResponse = {
  ok: true;
  data: { sites: ApiSiteRuntimeConfig[] };
};

/** 解析模型默认参考图上限，兼容尚未补充新字段的历史生产配置。 */
export function resolveMaxReferenceImages(option: Pick<ApiSiteModelOption, 'name' | 'type' | 'apiMode' | 'maxReferenceImages'>): number {
  if (Number.isInteger(option.maxReferenceImages)) {
    return Math.min(8, Math.max(0, Number(option.maxReferenceImages)));
  }
  if (option.type === 'text' || option.type === 'text_to_image') return 0;
  if (option.type === 'video' || option.apiMode === 'grok_video_generation') return 8;
  if (option.apiMode === 'grok_image_edit_json') return 4;
  return option.name.toLowerCase().includes('gpt-image') ? 8 : 1;
}

/** 解析 OpenAI Images 默认字段；历史 GPT Image 配置继续使用数组字段。 */
export function resolveReferenceImageField(option: Pick<ApiSiteModelOption, 'name' | 'referenceImageField'>): ReferenceImageField {
  if (option.referenceImageField === 'image' || option.referenceImageField === 'image[]') return option.referenceImageField;
  return option.name.toLowerCase().includes('gpt-image') ? 'image[]' : 'image';
}

/** 解析参考图超限策略；仅单图模型默认合并，多图模型默认拒绝超限。 */
export function resolveReferenceImageOverflowStrategy(
  option: Pick<ApiSiteModelOption, 'maxReferenceImages' | 'referenceImageOverflowStrategy'>,
): ReferenceImageOverflowStrategy {
  if (option.referenceImageOverflowStrategy === 'combine' || option.referenceImageOverflowStrategy === 'reject') {
    return option.referenceImageOverflowStrategy;
  }
  return option.maxReferenceImages === 1 ? 'combine' : 'reject';
}

/** 判断当前协议能否把多张参考图合并后作为单个图片字段发送。 */
export function supportsCombinedReferenceImage(apiMode: SiteModelApiMode | undefined): boolean {
  return apiMode === 'openai_images' || apiMode === 'bfl_image_generation';
}

/** 解析画幅比例能力；历史 GPT Image 配置按官方三种原生画幅兼容，其余模型默认支持全部比例。 */
export function resolveAspectRatioSupport(
  option: Pick<ApiSiteModelOption, 'name' | 'apiMode' | 'aspectRatioSupport'>,
): SiteModelAspectRatioSupport {
  if (option.aspectRatioSupport === 'all'
    || option.aspectRatioSupport === 'gpt_image'
    || option.aspectRatioSupport === 'grok_video'
    || option.aspectRatioSupport === 'square_only'
    || option.aspectRatioSupport === 'auto_only') {
    return option.aspectRatioSupport;
  }
  if (option.apiMode === 'grok_video_generation') return 'grok_video';
  return option.apiMode === 'openai_images' && option.name.toLowerCase().includes('gpt-image')
    ? 'gpt_image'
    : 'all';
}

/** 判断站点模型能否原生处理指定画幅；auto 始终允许并保持上游默认行为。 */
export function supportsDrawingAspectRatio(
  option: Pick<ApiSiteModelOption, 'name' | 'apiMode' | 'aspectRatioSupport'>,
  aspectRatio: import('./drawing-aspect-ratio-contracts.js').DrawingAspectRatio | undefined,
): boolean {
  if (!aspectRatio || aspectRatio === 'auto') return true;
  const support = resolveAspectRatioSupport(option);
  if (support === 'all') return true;
  if (support === 'auto_only') return false;
  if (support === 'square_only') return aspectRatio === '1:1';
  if (support === 'grok_video') return ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].includes(aspectRatio);
  return aspectRatio === '1:1' || aspectRatio === '2:3' || aspectRatio === '3:2';
}

/** 返回用户端可选画幅列表，避免展示当前模型没有任何可用站点支持的比例。 */
export function resolveSupportedDrawingAspectRatios(
  option: Pick<ApiSiteModelOption, 'name' | 'apiMode' | 'aspectRatioSupport'>,
): import('./drawing-aspect-ratio-contracts.js').DrawingAspectRatio[] {
  const values: import('./drawing-aspect-ratio-contracts.js').DrawingAspectRatio[] = [
    'auto', '1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '9:21', '21:9',
  ];
  if (resolveAspectRatioSupport(option) === 'grok_video') {
    return ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
  }
  return values.filter((value) => supportsDrawingAspectRatio(option, value));
}
