/** 本文件定义绘图模型列表和站点模型选项契约，保证前台、后台、drawing-service 和 worker 对模型能力的理解一致。 */
import type { DrawingAspectRatio } from './drawing-aspect-ratio-contracts.js';

/** 生成模型类型；video 用于文生视频和参考图视频，text 不参与媒体生成调度。 */
export type DrawingModelType = 'universal' | 'text_to_image' | 'image_to_image' | 'video' | 'text';

/** 模型提示词格式决定 AI 提示增强的最终组织方式，不再用部署位置推断。 */
export type DrawingPromptFormat = 'standard' | 'diffusion' | 'anima';

/** 模型能力声明，用于前端按当前模式筛选可用模型。 */
export type DrawingModelCapabilities = {
  /** 是否支持文生图。 */
  textToImage: boolean;
  /** 是否支持图生图。 */
  imageToImage: boolean;
  /** 是否支持文本或多模态文本任务。 */
  text: boolean;
  /** 是否支持文生视频。 */
  textToVideo: boolean;
  /** 是否支持参考图视频。 */
  imageToVideo: boolean;
};

/** 用户端和后台共用的模型列表项，只暴露站点名称，不暴露密钥和内部地址。 */
export type DrawingModelOptionView = {
  /** 用户选择和任务快照使用的统一主模型名。 */
  name: string;
  /** 面向用户展示的短名称；优先使用后台模型设置，未配置时使用内置模型元数据。 */
  label?: string;
  /** 用户可输入的模型别名；提交前必须解析成 name 对应的统一主模型名。 */
  aliases?: string[];
  /** 与主模型等价的上游请求模型名；只用于站点调度和真实尝试模型展示映射。 */
  requestModelNames?: string[];
  /** 外显排序权重，数值越大越靠前；只影响网页和 Bot 展示顺序，不参与站点调度权重。 */
  weight?: number;
  /** 单次生成价格（元），由独立模型配置维护。 */
  price?: number;
  /** 每个任务最多调用上游的总次数；1 表示失败后不再尝试。 */
  maxAttempts?: number;
  /** 视频任务是否允许使用反推模型进行分镜设计；非视频模型始终为 false。 */
  storyboardDesignEnabled?: boolean;
  /** 文生图模型是否允许通过外部 AI 增强提示词；参考图为可选输入。 */
  referencePromptAssistEnabled?: boolean;
  /** AI 提示增强输出格式：Grok/通用自然语言、传统扩散正负提示词或独立 Anima 标签协议。 */
  promptFormat?: DrawingPromptFormat;
  /** 是否作为用户不指定模型时的默认模型。 */
  isDefault?: boolean;
  /** 规范化后的模型类型。 */
  type: DrawingModelType;
  /** 由类型和已知模型元数据推导出的能力。 */
  capabilities: DrawingModelCapabilities;
  /** 声明该模型的启用站点名称。 */
  sites: string[];
  /** 聚合后是否可用于当前生产链路。 */
  enabled: boolean;
  /** 至少一个启用站点原生支持的画幅比例；始终包含 auto。 */
  supportedAspectRatios?: DrawingAspectRatio[];
  /** 是否推荐作为默认生成模型。 */
  recommended?: boolean;
  /** 模型说明，用于 title 或后台提示。 */
  description?: string;
  /** 供应商标识，仅用于展示和排障。 */
  provider?: string;
};

/** 绘图模型列表响应；models 保留真实 name 字段，外显配置由 label/aliases/weight/isDefault 承载。 */
export type DrawingModelListResponse = {
  /** 聚合后的可用模型列表。 */
  models: DrawingModelOptionView[];
  /** 推荐默认模型，前端首次加载时优先选中。 */
  defaultModel?: string;
};

/** 已知模型元数据，用于给 Gemini 新模型提供稳定展示和默认能力。 */
const KNOWN_MODEL_METADATA: Record<string, Pick<DrawingModelOptionView, 'label' | 'description' | 'provider' | 'recommended' | 'type'>> = {
  'gemini-3.1-flash-image': {
    label: 'Nano Banana 2',
    description: 'Gemini 3.1 Flash Image，适用于图像生成和编辑。',
    provider: 'google',
    recommended: true,
    type: 'universal',
  },
  'gemini-3.5-flash': {
    label: 'Gemini 3.5 Flash',
    description: 'Gemini 3.5 Flash 文本/多模态模型，不直接参与当前图片生成端点。',
    provider: 'google',
    type: 'text',
  },
};

/** 读取已知模型展示元数据；未知模型保持原样展示，避免伪造能力。 */
export function getKnownDrawingModelMetadata(name: string) {
  return KNOWN_MODEL_METADATA[name.trim()];
}

/** 规范化站点模型类型，兼容旧后台曾写入的 image/text 字段。 */
export function normalizeDrawingModelType(value: unknown, modelName?: string): DrawingModelType {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === 'text_to_image' || raw === 'image_to_image' || raw === 'universal' || raw === 'video' || raw === 'text') return raw;
  if (raw === 'image') return 'universal';
  const metadataType = modelName ? getKnownDrawingModelMetadata(modelName)?.type : undefined;
  return metadataType ?? 'universal';
}

/** 根据规范化类型推导图片和文本能力，worker 会再次按类型兜底校验。 */
export function getDrawingModelCapabilities(type: DrawingModelType): DrawingModelCapabilities {
  return {
    textToImage: type === 'universal' || type === 'text_to_image',
    imageToImage: type === 'universal' || type === 'image_to_image',
    text: type === 'text',
    textToVideo: type === 'video',
    imageToVideo: type === 'video',
  };
}
