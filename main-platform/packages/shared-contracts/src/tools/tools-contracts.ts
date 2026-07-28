/** 本文件定义用户端工具中心的跨程序契约，供 backend、前台和后台共用。 */

/** 已登记的用户端工具 ID；后续新增工具必须先扩展此联合类型。 */
export type ToolId = 'image-splitter' | 'image-converter' | 'image-scrambler' | 'image-wobble' | 'image-reverse' | 'image-upscale' | 'lora-captioning';

/** 单个工具的公开配置视图。 */
export interface ToolConfigView {
  /** 工具稳定 ID。 */
  id: ToolId;
  /** 用户可见名称。 */
  title: string;
  /** 工具是否在用户端开放。 */
  enabled: boolean;
  /** 默认拆分行数；非图片拆分工具可忽略。 */
  defaultRows?: number;
  /** 默认拆分列数；非图片拆分工具可忽略。 */
  defaultCols?: number;
  /** 最大拆分行数；非图片拆分工具可忽略。 */
  maxRows?: number;
  /** 最大拆分列数；非图片拆分工具可忽略。 */
  maxCols?: number;
  /** 最大上传文件大小，单位 MB。 */
  maxFileSizeMb?: number;
  /** 格式转换与压缩工具的默认输出格式。 */
  convertDefaultFormat?: 'webp' | 'jpeg' | 'png';
  /** 格式转换与压缩工具的默认有损编码质量，范围 1-100。 */
  convertDefaultQuality?: number;
  /** 格式转换与压缩工具单批最大图片数。 */
  convertMaxBatchCount?: number;
  /** 图片反推使用的识图模型名称；只暴露模型名，不暴露 API 地址或密钥。 */
  reverseModel?: string;
  /** 图片反推请求超时时间，单位秒。 */
  reverseTimeoutSec?: number;
  /** 图片反推结果最大输出字符数。 */
  reverseMaxOutputChars?: number;
  /** 图片反推默认模式。 */
  reverseDefaultMode?: ImageReverseMode;
  /** 图片反推默认输出语言。 */
  reverseDefaultLanguage?: ImageReverseLanguage;
  /** 图片反推默认 Prompt 语言。 */
  reverseDefaultPromptLanguage?: ImageReversePromptLanguage;
  /** 用户端开放的图片反推模式。 */
  reverseEnabledModes?: ImageReverseMode[];
  /** 用户端开放的图片反推语言。 */
  reverseEnabledLanguages?: ImageReverseLanguage[];
  /** WD14 Provider 配置完整时允许用户在标签模式选择混合证据。 */
  reverseHybridAvailable?: boolean;
  /** 图片放大当前公开展示的模型名称。 */
  upscaleModel?: string;
  /** 图片放大允许选择的模型名称列表；为空时只使用默认模型。 */
  upscaleAllowedModels?: string[];
  /** 图片放大默认倍率。 */
  upscaleDefaultScale?: ImageUpscaleScale;
  /** 图片放大允许选择的倍率列表。 */
  upscaleAllowedScales?: ImageUpscaleScale[];
  /** 图片放大请求超时时间，单位秒。 */
  upscaleTimeoutSec?: number;
  /** 图片放大固定输出格式；当前生产只返回 WebP。 */
  upscaleOutputFormat?: ImageUpscaleOutputFormat;
  /** 图片放大固定格式列表；仅为旧客户端兼容，不再作为用户可选项。 */
  upscaleAllowedOutputFormats?: ImageUpscaleOutputFormat[];
  /** 图片放大最大输出像素数；前端用于提前禁用会超限的倍率。 */
  upscaleMaxOutputPixels?: number;
}

/** 工具配置公开响应。 */
export interface ToolsConfigResponse {
  /** 当前用户端可识别的全部工具配置。 */
  tools: ToolConfigView[];
}

/** 用户端工具调用计数请求；本地浏览器工具成功执行后用该结构上报。 */
export interface ToolUsageRecordRequest {
  /** 被调用的工具稳定 ID。 */
  toolId: ToolId;
}

/** 管理后台单个工具调用统计。 */
export interface ToolUsageView {
  /** 工具稳定 ID。 */
  id: ToolId;
  /** 用户可见名称。 */
  title: string;
  /** 历史累计调用次数。 */
  totalCount: number;
  /** 中国时区当日调用次数。 */
  todayCount: number;
  /** 最近一次成功调用时间，ISO 字符串；没有调用时为空。 */
  lastUsedAt: string | null;
}

/** 管理后台工具调用统计响应。 */
export interface ToolUsageOverviewResponse {
  /** 中国时区统计日期，格式 YYYY-MM-DD。 */
  date: string;
  /** 每个工具的调用统计。 */
  tools: ToolUsageView[];
}

/** 图片放大 GPU 健康检查响应；只给管理后台使用，不包含密钥。 */
export interface ImageUpscaleHealthResponse {
  /** 工具是否已启用。 */
  enabled: boolean;
  /** GPU 服务地址是否已配置。 */
  baseUrlConfigured: boolean;
  /** GPU 服务密钥是否已配置。 */
  apiKeyConfigured: boolean;
  /** 当前默认模型。 */
  model: string;
  /** 当前允许模型。 */
  allowedModels: string[];
  /** backend 调用 GPU 时使用的结果返回链路。 */
  responseTransport: ImageUpscaleResponseTransport;
  /** backend 进程内队列快照。 */
  queue: {
    /** 正在执行的请求数。 */
    active: number;
    /** 等待中的请求数。 */
    pending: number;
    /** 最早等待请求已经排队的毫秒数；没有等待请求时为 0。 */
    oldestPendingMs: number;
    /** 后台配置的最大并发。 */
    maxConcurrency: number;
    /** 后台配置的最大等待数。 */
    maxPending: number;
    /** 后台配置的最大排队等待毫秒数。 */
    maxWaitMs: number;
  };
  /** GPU 服务探测结果。 */
  upstream: {
    /** GPU 服务健康接口是否成功。 */
    ok: boolean;
    /** HTTP 状态码。 */
    statusCode?: number;
    /** 服务返回的推理设备。 */
    device?: string;
    /** 是否启用 CUDA。 */
    cuda?: boolean;
    /** GPU 服务当前发现的模型列表。 */
    models?: string[];
    /** GPU 服务代码层支持的真实模型名称列表。 */
    availableModels?: string[];
    /** GPU 服务模型目录中已经存在且大小可信的权重模型列表。 */
    weightFiles?: string[];
    /** GPU 服务运行时最多保留的已加载模型数量，用于控制显存常驻。 */
    modelCacheLimit?: number;
    /** 检查时间。 */
    checkedAt: string;
    /** 失败原因。 */
    error?: string;
  };
}

/** 图片放大支持的倍率；后台可限制用户可选范围。 */
export type ImageUpscaleScale = 2 | 3 | 4;

/** 图片放大输出格式；当前生产固定为 WebP，旧客户端传 PNG 也会被后端强制归一。 */
export type ImageUpscaleOutputFormat = 'webp';

/** 图片放大 GPU 结果返回链路；binary 直回图片，s3 上传对象存储，local 写入 GPU 本机临时目录后返回 URL。 */
export type ImageUpscaleResponseTransport = 'binary' | 's3' | 'local';

/** 图片放大请求选项。 */
export interface ImageUpscaleRunOptions {
  /** 放大倍率。 */
  scale: ImageUpscaleScale;
  /** 可选模型名；为空时后端使用后台默认模型。 */
  model?: string;
  /** 输出格式；当前后端固定为 webp，客户端传值只保留兼容。 */
  outputFormat?: ImageUpscaleOutputFormat;
  /** 是否把放大结果保存为当前用户的图片记录；不传时只返回结果，不写图库。 */
  saveToLibrary?: boolean;
  /** 保存到图片记录时的隐私状态；不传时使用用户默认隐私设置。 */
  isPrivate?: boolean;
}

/** 图片放大源图安全元数据。 */
export interface ImageUpscaleSourceView {
  /** 后端识别出的 MIME 类型。 */
  mimeType: string;
  /** 原图宽度，单位像素。 */
  width: number;
  /** 原图高度，单位像素。 */
  height: number;
  /** 原始上传字节数。 */
  sizeBytes: number;
}

/** 图片放大输出图片视图。 */
export interface ImageUpscaleOutputView {
  /** 输出 MIME 类型。 */
  mimeType: string;
  /** 输出图片 base64，不含 data URL 前缀；binary 链路或保存图库时返回。 */
  base64?: string;
  /** 输出图片公开地址；S3 或 GPU 本机暂存链路且无需同步下载二进制时返回。 */
  url?: string;
  /** 建议下载文件名。 */
  filename: string;
  /** 输出图片字节数。 */
  sizeBytes: number;
  /** 输出宽度，单位像素。 */
  width: number;
  /** 输出高度，单位像素。 */
  height: number;
}

/** 图片放大保存到我的图片后的任务摘要。 */
export interface ImageUpscaleSavedTaskView {
  /** 新创建的生成任务 ID。 */
  id: string;
  /** 任务详情页路径。 */
  detailPath: string;
  /** 公开图库详情页路径；私密图片仅当前用户可通过详情入口查看。 */
  imageDetailPath: string;
  /** 最终原图站内 URL。 */
  imageUrl: string;
  /** 缩略图站内 URL。 */
  thumbnailUrl?: string;
  /** 保存时使用的隐私状态。 */
  isPrivate: boolean;
  /** 保存完成时间，ISO 字符串。 */
  savedAt: string;
}

/** 图片放大链路耗时明细；用于区分 GPU 推理、网络传输和后端整理耗时。 */
export interface ImageUpscaleTimingView {
  /** 后端校验和规整源图耗时，单位毫秒。 */
  prepareMs: number;
  /** backend 发起请求到收到 GPU 响应头耗时，单位毫秒。 */
  upstreamHeadersMs: number;
  /** backend 读取 GPU 返回图片二进制耗时，单位毫秒。 */
  upstreamDownloadMs: number;
  /** GPU 服务通过响应头上报的推理和编码耗时，单位毫秒；缺失时为空。 */
  upstreamReportedMs?: number;
  /** GPU 服务上报的对象存储上传或本机暂存写入耗时，单位毫秒；binary 链路为空。 */
  upstreamStorageUploadMs?: number;
  /** 后端读取输出图片元数据耗时，单位毫秒。 */
  metadataMs: number;
  /** 后端把输出图转换为 base64 耗时，单位毫秒。 */
  base64Ms: number;
  /** 后端从接到任务到整理出结果的总耗时，单位毫秒。 */
  totalMs: number;
}

/** 图片放大接口响应。 */
export interface ImageUpscaleRunResponse {
  /** 源图元数据。 */
  source: ImageUpscaleSourceView;
  /** 输出图片。 */
  image: ImageUpscaleOutputView;
  /** 实际使用倍率。 */
  scale: ImageUpscaleScale;
  /** 实际使用模型。 */
  model: string;
  /** 后端调用 GPU 服务耗时，单位毫秒。 */
  elapsedMs: number;
  /** 放大链路阶段耗时明细；老客户端可忽略该字段。 */
  timings?: ImageUpscaleTimingView;
  /** 在 backend 进程内队列等待的耗时，单位毫秒。 */
  queueWaitMs?: number;
  /** 处理完成时间，ISO 字符串。 */
  processedAt: string;
  /** 当请求 saveToLibrary=true 时返回保存后的任务摘要。 */
  savedTask?: ImageUpscaleSavedTaskView;
}

/** 图片放大异步任务状态。 */
export type ImageUpscaleJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** 图片放大异步任务视图；用于前端刷新后恢复进度和结果。 */
export interface ImageUpscaleJobView {
  /** 图片放大持久化任务 ID。 */
  id: string;
  /** 当前登录用户 ID；仅用于前端本地排障展示，不授权跨用户访问。 */
  userId: number;
  /** 任务状态。 */
  status: ImageUpscaleJobStatus;
  /** 进度百分比，0-100。 */
  progress: number;
  /** 用户可见进度文本。 */
  progressText: string;
  /** 上传源文件名。 */
  sourceFileName: string;
  /** 后端识别出的源图 MIME；迁移前历史任务可能缺失。 */
  sourceMimeType?: string;
  /** 上传源文件大小。 */
  sourceSizeBytes: number;
  /** 源图宽度；迁移前历史任务可能缺失。 */
  sourceWidth?: number;
  /** 源图高度；迁移前历史任务可能缺失。 */
  sourceHeight?: number;
  /** 当前用户私有源图鉴权地址；仅新持久化任务提供。 */
  sourceUrl?: string;
  /** 当前用户私有轻量预览鉴权地址；历史页按需读取。 */
  previewUrl?: string;
  /** 请求倍率。 */
  scale: ImageUpscaleScale;
  /** 请求模型。 */
  model: string;
  /** 请求输出格式。 */
  outputFormat: ImageUpscaleOutputFormat;
  /** 是否请求保存到图库。 */
  saveToLibrary: boolean;
  /** 创建时间，ISO 字符串。 */
  createdAt: string;
  /** 更新时间，ISO 字符串。 */
  updatedAt: string;
  /** 开始 GPU 处理时间，ISO 字符串。 */
  startedAt?: string;
  /** 完成时间，ISO 字符串。 */
  finishedAt?: string;
  /** 成功时返回完整结果；列表接口为减小响应体默认不携带。 */
  result?: ImageUpscaleRunResponse;
  /** 失败时返回错误文案。 */
  error?: string;
}

/** 图片放大异步任务创建响应。 */
export interface ImageUpscaleJobCreateResponse {
  /** 已创建的任务。 */
  job: ImageUpscaleJobView;
}

/** 图片放大异步任务详情响应。 */
export interface ImageUpscaleJobDetailResponse {
  /** 当前任务。 */
  job: ImageUpscaleJobView;
}

/** 图片放大异步任务手动结束响应。 */
export interface ImageUpscaleJobCancelResponse {
  /** 已结束或已经终态的任务。 */
  job: ImageUpscaleJobView;
}

/** 图片放大异步任务列表响应。 */
export interface ImageUpscaleJobListResponse {
  /** 当前用户数据库中持久保存的近期任务。 */
  jobs: ImageUpscaleJobView[];
}

/** 图片反推结果中单张上传图片的安全元数据。 */
export interface ImageReverseSourceView {
  /** 后端识别出的 MIME 类型。 */
  mimeType: string;
  /** 原图宽度，单位像素。 */
  width: number;
  /** 原图高度，单位像素。 */
  height: number;
  /** 原始上传字节数。 */
  sizeBytes: number;
}

/** 图片反推结果支持的标准展示语言。 */
export type ImageReverseLanguage = 'zh' | 'en' | 'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR' | 'zh-TW';

/** 图片反推结果语言输出形态。 */
export type ImageReverseLanguageMode = 'single' | 'bilingual' | 'multilingual';

/** 图片反推 Prompt 语言；auto 由后端按模式选择最佳语言。 */
export type ImageReversePromptLanguage = 'auto' | ImageReverseLanguage | 'bilingual';

/** 图片反推提取模式；提取前由用户选择，后端只返回所选模式结果。 */
export type ImageReverseMode = 'description' | 'prompt' | 'character' | 'tags' | 'edit';

/** 图片反推单项提取范围；all 仅用于兼容旧客户端的综合描述。 */
export type ImageReverseFocus = 'all' | 'overall' | 'subject' | 'character' | 'pose' | 'outfit' | 'composition' | 'style' | 'lighting' | 'background';

/** 图片反推详细度；当前生产固定使用 forensic，字段仅保留给旧客户端兼容。 */
export type ImageReverseDetailLevel = 'brief' | 'standard' | 'detailed' | 'forensic';

/** 图片反推标签目标格式。 */
export type ImageReverseTagPreset = 'sdxl' | 'nai' | 'sd15' | 'comfyui' | 'anima';

/** 图片反推标签权重格式。 */
export type ImageReverseTagWeightMode = 'none' | 'important' | 'all';

/** 图片反推标签密度。 */
export type ImageReverseTagDensity = 'compact' | 'standard' | 'rich';

/** 图片反推证据模式；hybrid 在标签模式并且后台 WD14 可用时生效。 */
export type ImageReverseAnalysisMode = 'vision-only' | 'hybrid';

/** 图片反推 Prompt 目标模型类型。 */
export type ImageReversePromptTarget = 'general' | 'gpt-image' | 'gemini-image' | 'sdxl';

/** 图片反推编辑用途。 */
export type ImageReverseEditIntent = 'auto' | 'character-replace' | 'style-transfer' | 'outfit-replace' | 'background-replace' | 'composition-redraw' | 'multi-reference';

/** 图片反推语言选项；界面语言不在这里，这里只控制模型输出。 */
export interface ImageReverseLanguageOptions {
  /** 输出语言模式：单语言、双语或多语言。 */
  resultLanguageMode: ImageReverseLanguageMode;
  /** 主输出语言。 */
  primaryLanguage: ImageReverseLanguage;
  /** 双语模式下的第二语言。 */
  secondaryLanguage?: ImageReverseLanguage;
  /** 多语言模式下的额外语言，后端会按后台上限裁剪。 */
  extraLanguages?: ImageReverseLanguage[];
  /** Prompt 字段使用的语言。 */
  promptLanguage: ImageReversePromptLanguage;
}

/** 图片反推输出项开关，由前端或 Bot 传入，后端按模式解释。 */
export interface ImageReverseExtractOptions {
  /** 用户选择的反推模式。 */
  mode: ImageReverseMode;
  /** 多语言输出选项。 */
  language: ImageReverseLanguageOptions;
  /** 详细度；后端会强制归一化为 forensic。 */
  detailLevel: ImageReverseDetailLevel;
  /** 当前模式要输出的区域 key；为空时使用后端默认区域。 */
  sections: string[];
  /** 描述模式的单项提取范围；前端必须明确选择，旧客户端缺失时按 all 处理。 */
  focus?: ImageReverseFocus;
  /** 标签模式目标格式。 */
  tagPreset?: ImageReverseTagPreset;
  /** 标签权重策略。 */
  tagWeightMode?: ImageReverseTagWeightMode;
  /** 标签密度。 */
  tagDensity?: ImageReverseTagDensity;
  /** Prompt 模式目标模型。 */
  promptTarget?: ImageReversePromptTarget;
  /** 角色模式是否强调强一致性复刻。 */
  characterConsistency?: 'standard' | 'strict';
  /** 编辑模式用途。 */
  editIntent?: ImageReverseEditIntent;
  /** 是否在任务结果中保存并展示结构化分析证据；默认开启。 */
  includeEvidence?: boolean;
  /** 本次请求选择的证据管线。 */
  analysisMode?: ImageReverseAnalysisMode;
}

/** 图片反推单项提取的单语言结果；字段只承载当前范围，避免混入其他视觉维度。 */
export interface ImageReverseFocusedLanguageResultView {
  /** 当前单项范围。 */
  focus: Exclude<ImageReverseFocus, 'all'>;
  /** 对当前范围的完整摘要。 */
  summary: string;
  /** 当前范围内逐条可见事实。 */
  observations: string[];
  /** 只包含当前范围信息的绘图提示词片段。 */
  promptFragment: string;
}

/** 图片反推描述模式的角色细节；用于尽量复原图中角色。 */
export interface ImageReverseCharacterDescriptionView {
  /** 是否存在明确角色。 */
  present: boolean;
  /** 角色类型，例如二次元少女、写实男性、动物角色、机甲角色等。 */
  type: string;
  /** 角色数量和主次关系。 */
  countAndRole: string;
  /** 体型、年龄感、身高比例和轮廓。 */
  bodyAndProportion: string;
  /** 脸型、五官、眼睛、眉毛、鼻口等面部特征。 */
  faceFeatures: string;
  /** 发型、发色、刘海、发量、发饰和头部轮廓。 */
  hair: string;
  /** 眼睛颜色、形状、瞳孔、高光和眼神。 */
  eyes: string;
  /** 肤色、皮肤质感、妆容、红晕和特殊标记。 */
  skinAndMakeup: string;
  /** 表情、情绪和角色气质。 */
  expressionAndTemperament: string;
  /** 服装款式、颜色、材质、层次、褶皱和穿着方式。 */
  outfit: string;
  /** 配饰、道具、头饰、饰品、纹身、翅膀、尾巴等辨识点。 */
  accessoriesAndProps: string;
  /** 姿势、动作、手势、视线方向和身体朝向。 */
  poseAndAction: string;
  /** 最影响角色一致性的不可丢失特征。 */
  identityAnchors: string[];
  /** 专门用于复现同一角色的长文本提示词。 */
  characterPrompt: string;
}

/** 图片反推描述模式单语言结构化结果；字段来自真实 AI 识图响应的 JSON 解析。 */
export interface ImageReverseDescriptionLanguageResultView {
  /** 图片整体概述。 */
  overview: string;
  /** 角色细节；无角色时 present=false，其他字段描述为空。 */
  character: ImageReverseCharacterDescriptionView;
  /** 主体、角色或物体信息。 */
  subjects: string[];
  /** 角色、物件、材质和细节信息。 */
  details: string[];
  /** 构图、镜头和视角描述。 */
  composition: string;
  /** 画风、媒介和渲染方式描述。 */
  style: string;
  /** 色彩与光影描述。 */
  colorLighting: string;
  /** 背景与氛围描述。 */
  backgroundAtmosphere: string;
  /** 可直接复用的质量标签。 */
  qualityTags: string[];
  /** 搭配不定数量新角色参考图使用的角色保留迁移提示词；同角色多图只作多视角证据，不按图片数量复制角色。 */
  drawingPrompt: string;
  /** 描述参考图合并规则、角色数量语义、角色保留要求和通用结构限制的自然语言生成约束。 */
  negativePrompt: string;
}

/** 图片反推 Prompt 模式单语言结果。 */
export interface ImageReversePromptLanguageResultView {
  /** 可直接复制到绘图入口的完整正向提示词。 */
  positivePrompt: string;
  /** 反向提示词或避免项。 */
  negativePrompt: string;
  /** 单独角色段，便于和其他构图/风格组合。 */
  characterPrompt: string;
  /** 单独构图段。 */
  compositionPrompt: string;
  /** 单独风格段。 */
  stylePrompt: string;
  /** 单独背景与光影段。 */
  backgroundPrompt: string;
  /** 当前 Prompt 面向的目标模型类型。 */
  target: ImageReversePromptTarget;
}

/** 图片反推角色复刻单语言结果。 */
export interface ImageReverseCharacterProfileLanguageResultView {
  /** 角色卡摘要。 */
  summary: string;
  /** 结构化角色细节。 */
  character: ImageReverseCharacterDescriptionView;
  /** 服装材质和配色细节。 */
  outfitBreakdown: string[];
  /** 脸部、发型、眼睛等局部特征拆分。 */
  featureBreakdown: string[];
  /** 必须保留的角色锚点。 */
  identityAnchors: string[];
  /** 用于复刻同一角色的长 Prompt。 */
  reproductionPrompt: string;
  /** 避免跑偏的反向约束。 */
  avoidPrompt: string;
}

/** 图片反推本地模型标签项；英文标签用于真实复制，中文只做对照说明。 */
export interface ImageReverseLocalModelTagView {
  /** 标签中文含义或说明。 */
  zh: string;
  /** 本地模型可直接使用的英文标签。 */
  en: string;
  /** 标签权重，常规范围 0.1-2.0。 */
  weight: number;
}

/** 图片反推标签模式结果；适配 Stable Diffusion、NAI、ComfyUI 等逗号分隔标签 prompt。 */
export interface ImageReverseTagResultView {
  /** 画质与通用增强标签。 */
  qualityTags: ImageReverseLocalModelTagView[];
  /** 角色标签，重点描述图中角色特征，尽量足够复现同一角色。 */
  characterTags: ImageReverseLocalModelTagView[];
  /** 服装、配饰、道具等细节标签。 */
  detailTags: ImageReverseLocalModelTagView[];
  /** 构图、镜头、动作和视角标签。 */
  compositionTags: ImageReverseLocalModelTagView[];
  /** 画风、媒介、渲染和艺术方向标签。 */
  styleTags: ImageReverseLocalModelTagView[];
  /** 背景、环境、氛围和光影标签。 */
  environmentTags: ImageReverseLocalModelTagView[];
  /** 负向标签明细，按推荐使用顺序排列。 */
  negativeTags: ImageReverseLocalModelTagView[];
  /** 不带权重的正向标签 prompt。 */
  positivePrompt: string;
  /** 带权重的正向标签 prompt，格式为 `(tag:1.10)`。 */
  positivePromptWithWeights: string;
  /** 不带权重的负向标签 prompt。 */
  negativePrompt: string;
  /** 带权重的负向标签 prompt，格式为 `(tag:1.10)`。 */
  negativePromptWithWeights: string;
  /** 按 Anima 槽位顺序确定性整理的无权重单行提示词。 */
  animaPrompt?: string;
  /** 生成 Anima 提示词的后端格式器版本。 */
  formatterVersion?: string;
}

/** 图片反推结构化输出实际使用的兼容层级。 */
export type ImageReverseStructuredOutputMode = 'json-schema' | 'json-object' | 'prompt-json';

/** 图片反推证据来源；后续 WD14 和可信元数据接入时沿用同一契约。 */
export type ImageReverseEvidenceSource = 'vision' | 'derived' | 'wd14' | 'metadata' | 'user';

/** 图片反推证据分类；用于前端筛选和目标模型格式化。 */
export type ImageReverseEvidenceCategory =
  | 'subject'
  | 'character'
  | 'outfit'
  | 'action'
  | 'expression'
  | 'composition'
  | 'style'
  | 'lighting'
  | 'background'
  | 'detail'
  | 'quality'
  | 'negative';

/** 图片反推单条可追溯证据。 */
export interface ImageReverseEvidenceItemView {
  /** 本次结果内稳定的证据编号。 */
  id: string;
  /** 证据所属视觉分类。 */
  category: ImageReverseEvidenceCategory;
  /** 可供用户核对的真实识图文本或标签。 */
  text: string;
  /** 证据来源。 */
  source: ImageReverseEvidenceSource;
  /** Provider 原生置信度；没有统计分数时保持为空，不能用标签权重冒充。 */
  confidence?: number;
  /** 多角色场景中的角色索引；全局证据保持为空。 */
  characterIndex?: number;
  /** 证据文本语言。 */
  language?: ImageReverseLanguage;
}

/** 图片反推单个证据来源的轻量统计。 */
export interface ImageReverseEvidenceSourceSummaryView {
  /** 证据来源。 */
  source: ImageReverseEvidenceSource;
  /** 用户可见来源名称。 */
  label: string;
  /** 该来源提供的去重证据数量。 */
  count: number;
  /** 具有 Provider 原生置信度的证据数量。 */
  confidenceCount: number;
}

/** 图片反推互斥证据中的一个候选值。 */
export interface ImageReverseEvidenceConflictValueView {
  /** 互斥组内的标准值名称。 */
  label: string;
  /** 触发该值的原始证据文本。 */
  text: string;
  /** 原始证据来源。 */
  source: ImageReverseEvidenceSource;
  /** Provider 原生置信度。 */
  confidence?: number;
}

/** 图片反推高影响互斥证据冲突；只用于核对，不在依据不足时自动改写 Prompt。 */
export interface ImageReverseEvidenceConflictView {
  /** 本次结果内稳定的冲突编号。 */
  id: string;
  /** 冲突所属证据分类。 */
  category: ImageReverseEvidenceCategory;
  /** 用户可见冲突名称。 */
  label: string;
  /** 同一互斥组内同时出现的候选值。 */
  values: ImageReverseEvidenceConflictValueView[];
  /** 后端采用的处理说明。 */
  resolution: string;
  /** 存在确定性优先级时选中的证据；未选中时保持为空。 */
  selectedText?: string;
}

/** 图片反推 Provider 执行记录。 */
export interface ImageReverseProviderRunView {
  /** Provider 稳定 ID。 */
  provider: 'vision' | 'wd14' | 'metadata';
  /** 用户可见 Provider 名称。 */
  label: string;
  /** 实际模型或数据源版本。 */
  model?: string;
  /** 本阶段执行状态。 */
  status: 'succeeded' | 'skipped' | 'failed';
  /** 阶段耗时，单位毫秒。 */
  durationMs?: number;
  /** 跳过或失败原因；只保存已脱敏摘要。 */
  message?: string;
}

/** 图片反推处理阶段记录。 */
export interface ImageReverseAnalysisStageView {
  /** 阶段稳定 ID。 */
  id: 'preprocess' | 'vision_evidence' | 'tag_evidence' | 'merge' | 'format' | 'persist';
  /** 用户可见阶段名称。 */
  label: string;
  /** 阶段状态。 */
  status: 'succeeded' | 'skipped' | 'failed';
  /** 阶段耗时，单位毫秒。 */
  durationMs?: number;
  /** 阶段说明。 */
  message?: string;
}

/** 图片反推分析审计视图；随任务结果持久化，刷新后可继续查看。 */
export interface ImageReverseAnalysisView {
  /** 本次实际执行的证据管线。 */
  pipeline: 'vision-only' | 'hybrid';
  /** 上游实际采用的结构化输出能力。 */
  structuredOutputMode: ImageReverseStructuredOutputMode;
  /** 后端证据归一化与格式器版本。 */
  formatterVersion: string;
  /** Provider 执行记录。 */
  providers: ImageReverseProviderRunView[];
  /** 可恢复的任务阶段。 */
  stages: ImageReverseAnalysisStageView[];
  /** 用户选择保存时返回的结构化证据。 */
  evidence: ImageReverseEvidenceItemView[];
  /** 各证据来源的去重数量；旧历史结果允许缺失。 */
  sourceSummary?: ImageReverseEvidenceSourceSummaryView[];
  /** 高影响互斥项冲突；旧历史结果允许缺失。 */
  conflicts?: ImageReverseEvidenceConflictView[];
  /** 兼容降级、不确定性和冲突提示。 */
  warnings: string[];
}

/** 管理后台 WD14 Provider 健康检查响应，不返回内部密钥。 */
export interface ImageReverseWd14HealthResponse {
  /** 后台是否开启 WD14。 */
  enabled: boolean;
  /** Provider 地址是否已配置。 */
  baseUrlConfigured: boolean;
  /** Provider 密钥是否已配置。 */
  apiKeyConfigured: boolean;
  /** 配置的模型名称。 */
  model: string;
  /** general 标签阈值。 */
  generalThreshold: number;
  /** character 标签阈值。 */
  characterThreshold: number;
  /** 上游健康状态。 */
  upstream: {
    /** 健康接口是否成功。 */
    ok: boolean;
    /** HTTP 状态码。 */
    statusCode?: number;
    /** 模型权重是否已经落盘。 */
    modelReady?: boolean;
    /** 标签表是否已经落盘。 */
    tagsReady?: boolean;
    /** ONNX Session 是否已经加载。 */
    loaded?: boolean;
    /** 实际激活的 Execution Provider。 */
    activeProviders?: string[];
    /** ONNX Runtime 可用 Provider。 */
    availableProviders?: string[];
    /** ONNX Runtime 版本。 */
    runtimeVersion?: string;
    /** 检查时间。 */
    checkedAt: string;
    /** 已脱敏错误。 */
    error?: string;
  };
}

/** 图片反推编辑模式单语言结果。 */
export interface ImageReverseEditLanguageResultView {
  /** 源图内容摘要。 */
  sourceSummary: string;
  /** 生成时必须保持的内容。 */
  keep: string[];
  /** 生成时允许或需要改变的内容。 */
  change: string[];
  /** 需要移除的内容。 */
  remove: string[];
  /** 禁止出现或禁止改变的内容。 */
  avoid: string[];
  /** 多参考图关系说明。 */
  referenceMapping: string[];
  /** 最终可复制的图生图编辑 Prompt。 */
  editPrompt: string;
  /** 编辑用途。 */
  intent: ImageReverseEditIntent;
}

/** 图片反推结果公共字段。 */
export interface ImageReverseBaseResultView {
  /** 用户本次选择的提取模式。 */
  mode: ImageReverseMode;
  /** AI 原始文本，便于前端在解析不完整时仍可展示真实返回。 */
  rawText: string;
  /** 实际调用的识图模型。 */
  model: string;
  /** 上传图片的安全元数据。 */
  source: ImageReverseSourceView;
  /** 提取完成时间，ISO 字符串。 */
  extractedAt: string;
  /** 本次请求实际使用的输出选项。 */
  options: ImageReverseExtractOptions;
  /** 新版任务的结构化证据与阶段审计；旧历史记录允许缺失。 */
  analysis?: ImageReverseAnalysisView;
}

/** 图片反推描述模式结果。 */
export interface ImageReverseDescriptionResultView extends ImageReverseBaseResultView, ImageReverseDescriptionLanguageResultView {
  mode: 'description';
  /** 实际提取范围；旧结果缺失时视为 all。 */
  focus?: ImageReverseFocus;
  /** 单项提取的主语言结果；综合描述时为空。 */
  focused?: ImageReverseFocusedLanguageResultView;
  /** 单项提取的多语言结果；综合描述时为空。 */
  focusedLocalized?: Partial<Record<ImageReverseLanguage, ImageReverseFocusedLanguageResultView>>;
  /** 标准多语言反推结果。 */
  localized: Partial<Record<ImageReverseLanguage, ImageReverseDescriptionLanguageResultView>>
    & { zh?: ImageReverseDescriptionLanguageResultView; en?: ImageReverseDescriptionLanguageResultView };
}

/** 图片反推 Prompt 模式结果。 */
export interface ImageReversePromptResultView extends ImageReverseBaseResultView, ImageReversePromptLanguageResultView {
  mode: 'prompt';
  /** 标准多语言 Prompt 结果。 */
  localized: Partial<Record<ImageReverseLanguage, ImageReversePromptLanguageResultView>>;
}

/** 图片反推角色复刻模式结果。 */
export interface ImageReverseCharacterResultView extends ImageReverseBaseResultView, ImageReverseCharacterProfileLanguageResultView {
  mode: 'character';
  /** 标准多语言角色卡结果。 */
  localized: Partial<Record<ImageReverseLanguage, ImageReverseCharacterProfileLanguageResultView>>;
}

/** 图片反推标签模式结果。 */
export interface ImageReverseTagPromptResultView extends ImageReverseBaseResultView {
  mode: 'tags';
  /** 面向本地模型的标签提示词，英文标签可直接复制使用，中文用于对照。 */
  tagPrompt: ImageReverseTagResultView;
}

/** 图片反推图生图编辑模式结果。 */
export interface ImageReverseEditResultView extends ImageReverseBaseResultView, ImageReverseEditLanguageResultView {
  mode: 'edit';
  /** 标准多语言编辑结果。 */
  localized: Partial<Record<ImageReverseLanguage, ImageReverseEditLanguageResultView>>;
}

/** 图片反推结构化结果；后端只返回用户提取前选择的模式。 */
export type ImageReverseResultView =
  | ImageReverseDescriptionResultView
  | ImageReversePromptResultView
  | ImageReverseCharacterResultView
  | ImageReverseTagPromptResultView
  | ImageReverseEditResultView;

/** 图片反推接口响应。 */
export interface ImageReverseExtractResponse {
  /** 本次反推的结构化结果。 */
  result: ImageReverseResultView;
}

/** 图片反推异步任务状态。 */
export type ImageReverseJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** 图片反推历史列表使用的轻量分析摘要，不包含完整结果或逐条证据。 */
export interface ImageReverseJobAnalysisSummaryView {
  /** 本次实际执行的证据管线。 */
  pipeline: 'vision-only' | 'hybrid';
  /** 实际结构化输出能力。 */
  structuredOutputMode: ImageReverseStructuredOutputMode;
  /** Provider 的轻量执行状态。 */
  providers: Array<Pick<ImageReverseProviderRunView, 'provider' | 'label' | 'status'>>;
  /** 全部去重证据数量，关闭逐条证据保存时仍保留计数。 */
  evidenceCount: number;
  /** 告警数量。 */
  warningCount: number;
  /** 互斥证据冲突数量。 */
  conflictCount: number;
  /** 结果是否已有可直接复用的 Anima Prompt。 */
  animaPromptAvailable: boolean;
}

/** 图片反推持久化任务视图；浏览器通过列表和详情接口恢复进度与历史结果。 */
export interface ImageReverseJobView {
  /** 持久化任务 ID。 */
  id: string;
  /** 当前任务状态。 */
  status: ImageReverseJobStatus;
  /** 估算进度百分比，范围 0-100。 */
  progress: number;
  /** 用户可见进度文本。 */
  progressText: string;
  /** 本次反推模式。 */
  mode: ImageReverseMode;
  /** 本次实际使用的识图模型。 */
  model: string;
  /** 本次完整提取选项。 */
  options: ImageReverseExtractOptions;
  /** 上传时的源文件名。 */
  sourceFileName: string;
  /** 源图 MIME 类型。 */
  sourceMimeType: string;
  /** 源图字节数。 */
  sourceSizeBytes: number;
  /** 源图宽度。 */
  sourceWidth: number;
  /** 源图高度。 */
  sourceHeight: number;
  /** 当前用户鉴权读取源图的 API 路径。 */
  sourceUrl: string;
  /** 当前用户鉴权读取源图预览的 API 路径。 */
  previewUrl: string;
  /** 历史列表使用的结果摘要。 */
  resultSummary?: string;
  /** 历史列表使用的轻量分析摘要；旧记录或未完成任务允许缺失。 */
  analysisSummary?: ImageReverseJobAnalysisSummaryView;
  /** 创建时间，ISO 字符串。 */
  createdAt: string;
  /** 更新时间，ISO 字符串。 */
  updatedAt: string;
  /** 开始识图时间，ISO 字符串。 */
  startedAt?: string;
  /** 完成时间，ISO 字符串。 */
  finishedAt?: string;
  /** 成功时返回完整结构化结果。 */
  result?: ImageReverseResultView;
  /** 失败时返回用户可见错误。 */
  error?: string;
}

/** 图片反推异步任务创建响应。 */
export interface ImageReverseJobCreateResponse {
  /** 已创建并进入后端处理队列的任务。 */
  job: ImageReverseJobView;
}

/** 图片反推异步任务详情响应。 */
export interface ImageReverseJobDetailResponse {
  /** 当前登录用户可访问的任务。 */
  job: ImageReverseJobView;
}

/** 图片反推历史任务列表响应。 */
export interface ImageReverseJobListResponse {
  /** 当前用户近期任务，按创建时间倒序；列表不携带完整结果 JSON。 */
  jobs: ImageReverseJobView[];
}
