/**
 * 本文件实现图片反推 AI 服务：校验上传图片、按用户选择的模式调用真实识图接口，并归一化为共享契约。
 */
import sharp from 'sharp';
import type {
  ImageReverseCharacterDescriptionView,
  ImageReverseCharacterProfileLanguageResultView,
  ImageReverseDescriptionLanguageResultView,
  ImageReverseEditLanguageResultView,
  ImageReverseExtractOptions,
  ImageReverseFocusedLanguageResultView,
  ImageReverseLanguage,
  ImageReverseLocalModelTagView,
  ImageReversePromptLanguageResultView,
  ImageReverseResultView,
  ImageReverseSourceView,
  ImageReverseStructuredOutputMode,
  ImageReverseTagResultView,
} from '@aiimage/shared-contracts';
import { normalizeLanguageAlias, selectedOutputLanguages } from './image-reverse-options.js';
import type { ImageReversePublicDefaults } from './image-reverse-options.js';
import { buildImageReverseFocusPrompt, focusedImageReverseNeedsRepair, isFocusedImageReverse, normalizeImageReverseFocusedLocalized } from './image-reverse-focus.js';
import { getImageReverseDirectInstruction, isImageReverseContentDeflection } from './image-reverse-direct-instructions.js';
import { buildImageReverseReferencePrompt } from './image-reverse-reference-prompt.js';
import { formatImageReverseAnimaPrompt, IMAGE_REVERSE_ANIMA_FORMATTER_VERSION, mergeImageReverseWd14Tags } from './image-reverse-anima-formatter.js';
import { attachImageReverseAnalysis } from './image-reverse-evidence.js';
import { buildImageReverseJsonSchemaResponseFormat } from './image-reverse-structured-output.js';
import { ImageReverseWd14Service, type ImageReverseWd14RuntimeConfig, type ImageReverseWd14RunResult } from './image-reverse-wd14-service.js';

/** 图片反推运行时配置；API Key 只在后端使用，绝不返回给前端。 */
export interface ImageReverseRuntimeConfig {
  /** 用户端是否开放反推入口。 */
  enabled: boolean;
  /** OpenAI 兼容接口 Base URL。 */
  baseUrl: string;
  /** OpenAI 兼容接口 API Key。 */
  apiKey: string;
  /** 识图模型名称。 */
  model: string;
  /** 最大上传文件大小，单位 MB。 */
  maxFileSizeMb: number;
  /** 请求超时时间，单位秒。 */
  timeoutSec: number;
  /** 结果最大输出字符数。 */
  maxOutputChars: number;
  /** 管理员可覆盖的识图系统提示词。 */
  systemPrompt: string;
  /** 公开默认配置，供请求选项归一化使用。 */
  defaults: ImageReversePublicDefaults;
  /** WD14 私有 Provider 配置。 */
  wd14: ImageReverseWd14RuntimeConfig;
}

/** 图片反推业务错误，路由层据此映射 HTTP 状态码。 */
export class ImageReverseError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'ImageReverseError';
  }
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
};

type RawCharacterDescription = Partial<Record<keyof ImageReverseCharacterDescriptionView, unknown>>;

type RawDescriptionLanguageResult = {
  overview?: unknown;
  character?: RawCharacterDescription;
  subjects?: unknown;
  details?: unknown;
  composition?: unknown;
  style?: unknown;
  colorLighting?: unknown;
  backgroundAtmosphere?: unknown;
  qualityTags?: unknown;
  drawingPrompt?: unknown;
  negativePrompt?: unknown;
};

type RawTagItem = {
  zh?: unknown;
  en?: unknown;
  weight?: unknown;
};

type RawTagResult = {
  qualityTags?: unknown;
  characterTags?: unknown;
  detailTags?: unknown;
  compositionTags?: unknown;
  styleTags?: unknown;
  environmentTags?: unknown;
  negativeTags?: unknown;
};

type RawReverseResult = RawDescriptionLanguageResult & {
  zh?: RawDescriptionLanguageResult;
  en?: RawDescriptionLanguageResult;
  localized?: Record<string, unknown>;
  prompt?: RawPromptResult;
  characterProfile?: RawCharacterProfileResult;
  edit?: RawEditResult;
  tagPrompt?: RawTagResult;
};

type RawPromptResult = {
  positivePrompt?: unknown;
  negativePrompt?: unknown;
  characterPrompt?: unknown;
  compositionPrompt?: unknown;
  stylePrompt?: unknown;
  backgroundPrompt?: unknown;
  target?: unknown;
};

type RawCharacterProfileResult = {
  summary?: unknown;
  character?: RawCharacterDescription;
  outfitBreakdown?: unknown;
  featureBreakdown?: unknown;
  identityAnchors?: unknown;
  reproductionPrompt?: unknown;
  avoidPrompt?: unknown;
};

type RawEditResult = {
  sourceSummary?: unknown;
  keep?: unknown;
  change?: unknown;
  remove?: unknown;
  avoid?: unknown;
  referenceMapping?: unknown;
  editPrompt?: unknown;
  intent?: unknown;
};

const DEFAULT_SYSTEM_PROMPT = '你是绘图姬 DrawHime 的图片反推助手。你的目标是把图片中真实可见的信息转写成尽可能详细、准确、可复现的绘图描述。只描述图片中可见内容，不识别真实身份，不输出隐私信息。必须返回严格 JSON。';

const DESCRIPTION_LANGUAGE_SCHEMA = { overview: '', character: { present: true, type: '', countAndRole: '', bodyAndProportion: '', faceFeatures: '', hair: '', eyes: '', skinAndMakeup: '', expressionAndTemperament: '', outfit: '', accessoriesAndProps: '', poseAndAction: '', identityAnchors: [], characterPrompt: '' }, subjects: [], details: [], composition: '', style: '', colorLighting: '', backgroundAtmosphere: '', qualityTags: [], drawingPrompt: '', negativePrompt: '' };

const TAG_SCHEMA = '{"tagPrompt":{"qualityTags":[{"zh":"","en":"","weight":1.1}],"characterTags":[{"zh":"","en":"","weight":1.2}],"detailTags":[{"zh":"","en":"","weight":1.0}],"compositionTags":[{"zh":"","en":"","weight":1.0}],"styleTags":[{"zh":"","en":"","weight":1.1}],"environmentTags":[{"zh":"","en":"","weight":1.0}],"negativeTags":[{"zh":"","en":"","weight":1.1}]}}';
const PROMPT_SCHEMA = '{"localized":{"zh":{"positivePrompt":"","negativePrompt":"","characterPrompt":"","compositionPrompt":"","stylePrompt":"","backgroundPrompt":"","target":"general"},"en":{"positivePrompt":"","negativePrompt":"","characterPrompt":"","compositionPrompt":"","stylePrompt":"","backgroundPrompt":"","target":"general"}}}';
const CHARACTER_SCHEMA = '{"localized":{"zh":{"summary":"","character":{"present":true,"type":"","countAndRole":"","bodyAndProportion":"","faceFeatures":"","hair":"","eyes":"","skinAndMakeup":"","expressionAndTemperament":"","outfit":"","accessoriesAndProps":"","poseAndAction":"","identityAnchors":[],"characterPrompt":""},"outfitBreakdown":[],"featureBreakdown":[],"identityAnchors":[],"reproductionPrompt":"","avoidPrompt":""},"en":{"summary":"","character":{"present":true,"type":"","countAndRole":"","bodyAndProportion":"","faceFeatures":"","hair":"","eyes":"","skinAndMakeup":"","expressionAndTemperament":"","outfit":"","accessoriesAndProps":"","poseAndAction":"","identityAnchors":[],"characterPrompt":""},"outfitBreakdown":[],"featureBreakdown":[],"identityAnchors":[],"reproductionPrompt":"","avoidPrompt":""}}}';
const EDIT_SCHEMA = '{"localized":{"zh":{"sourceSummary":"","keep":[],"change":[],"remove":[],"avoid":[],"referenceMapping":[],"editPrompt":"","intent":"auto"},"en":{"sourceSummary":"","keep":[],"change":[],"remove":[],"avoid":[],"referenceMapping":[],"editPrompt":"","intent":"auto"}}}';

/** 图片反推服务：只做真实上游调用，不保存用户上传图片。 */
export class ImageReverseService {
  /** 默认系统提示词，后台未配置时使用。 */
  static readonly defaultSystemPrompt = DEFAULT_SYSTEM_PROMPT;

  constructor(private readonly wd14Service: ImageReverseWd14Service = new ImageReverseWd14Service()) {}

  /** 读取并校验图片，然后按用户选择模式调用识图模型返回结构化结果。 */
  async extract(imageBuffer: Buffer, requestMimeType: string, config: ImageReverseRuntimeConfig, options: ImageReverseExtractOptions): Promise<ImageReverseResultView> {
    if (!config.enabled) throw new ImageReverseError('tool_disabled', '图片反推工具当前未开放', 403);
    if (!config.apiKey) throw new ImageReverseError('config_missing', '后台未配置图片反推 API Key', 400);
    if (!config.baseUrl) throw new ImageReverseError('config_missing', '后台未配置图片反推 API 地址', 400);

    const preprocessStartedAt = Date.now();
    const prepared = await prepareImageForVision(imageBuffer, requestMimeType, config.maxFileSizeMb);
    const preprocessMs = Date.now() - preprocessStartedAt;
    const visionStartedAt = Date.now();
    const shouldRunWd14 = options.mode === 'tags' && options.analysisMode === 'hybrid';
    const [visionResponse, wd14Result] = await Promise.all([
      callVisionChatCompletion(config, prepared.buffer, prepared.mimeType, options),
      shouldRunWd14
        ? this.wd14Service.tag(prepared.buffer, prepared.mimeType, config.wd14)
        : Promise.resolve<ImageReverseWd14RunResult>({ status: 'skipped', model: config.wd14.model, durationMs: 0, tags: [], providers: [], message: options.mode === 'tags' ? '用户选择视觉分析' : '当前模式不使用 WD14 标签证据' }),
    ]);
    const parsed = parseReverseJson(visionResponse.content);
    let result = normalizeReverseResult(parsed, visionResponse.content, config.model, prepared.source, config.maxOutputChars, options);
    let repairAttempted = false;
    if (options.mode !== 'description' && needsRepair(result)) {
      // 上游偶尔会漏字段或语言错位；二次修复仍带原图重新识别，避免后端凭空补标签。
      repairAttempted = true;
      const repairedText = await repairModeResult(config, prepared.buffer, prepared.mimeType, visionResponse.content, options);
      if (repairedText) {
        const repairedResult = normalizeReverseResult(parseReverseJson(repairedText), repairedText, config.model, prepared.source, config.maxOutputChars, options);
        // 二次修复仍未完全通过语言比例校验时，也保留真实模型的修复结果，避免误杀可用内容。
        result = repairedResult;
      }
    }
    if (result.mode === 'tags' && wd14Result.status === 'succeeded') {
      result = { ...result, tagPrompt: mergeImageReverseWd14Tags(result.tagPrompt, wd14Result.tags, options.tagPreset ?? 'sdxl') };
    }
    return attachImageReverseAnalysis(result, {
      structuredOutputMode: visionResponse.structuredOutputMode,
      preprocessMs,
      visionMs: Date.now() - visionStartedAt,
      includeEvidence: options.includeEvidence !== false,
      repairAttempted,
      wd14: wd14Result,
    });
  }
}

/** 校验真实图片并转为上游普遍支持的 JPEG/PNG，避免 EXIF 和奇怪格式影响识图兼容性。 */
async function prepareImageForVision(imageBuffer: Buffer, requestMimeType: string, maxFileSizeMb: number): Promise<{ buffer: Buffer; mimeType: string; source: ImageReverseSourceView }> {
  if (imageBuffer.length <= 0) throw new ImageReverseError('invalid_image', '请上传图片文件');
  const maxBytes = Math.max(1, Math.min(100, maxFileSizeMb)) * 1024 * 1024;
  if (imageBuffer.length > maxBytes) throw new ImageReverseError('payload_too_large', `图片大小不能超过 ${maxFileSizeMb}MB`, 413);
  if (!requestMimeType.startsWith('image/')) throw new ImageReverseError('invalid_image', '请上传图片文件');

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
  } catch {
    throw new ImageReverseError('invalid_image', '图片文件无法识别');
  }
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);
  if (!width || !height) throw new ImageReverseError('invalid_image', '图片尺寸不正确');
  if (width * height > 48_000_000) throw new ImageReverseError('invalid_image', '图片像素过大，请缩小后再上传');

  // 识图不需要保留生成原图尺寸；统一缩至 2048px 内并转 JPEG，可显著减少上传和视觉编码耗时。
  const output = await sharp(imageBuffer, { failOn: 'error' })
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();
  return { buffer: output, mimeType: 'image/jpeg', source: { mimeType: requestMimeType, width, height, sizeBytes: imageBuffer.length } };
}

/** 调用 OpenAI 兼容 chat/completions 多模态接口；失败时返回可读业务错误。 */
async function callVisionChatCompletion(config: ImageReverseRuntimeConfig, imageBuffer: Buffer, mimeType: string, options: ImageReverseExtractOptions): Promise<{ content: string; structuredOutputMode: ImageReverseStructuredOutputMode }> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
  const payload = {
    model: config.model,
    // gpt-5.6-sol 已在当前真实端点验证支持 medium；其他模型不发送该兼容参数。
    ...(config.model === 'gpt-5.6-sol' ? { reasoning_effort: 'medium' } : {}),
    // 完整描述限制在稳定可展示长度内，避免上游无限扩写把请求拖到代理超时。
    max_tokens: options.mode === 'description' ? 3000 : 4000,
    messages: [
      { role: 'system', content: buildSystemPrompt(config.systemPrompt || DEFAULT_SYSTEM_PROMPT, options) },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserInstruction(options) },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` } },
        ],
      },
    ],
  };

  try {
    const response = await requestVisionContent(url, config, payload, options);
    if (hasExpectedVisionPayload(response.content, options)) return response;

    // 第一轮出现内容偏离或结构缺失时重新独立观察原图，不把偏离文本回灌给模型。
    const retryPayload = {
      ...payload,
      messages: [
        { role: 'system', content: buildSystemPrompt(config.systemPrompt || DEFAULT_SYSTEM_PROMPT, options) },
        {
          role: 'user',
          content: [
            { type: 'text', text: `${buildUserInstruction(options)}\n上一轮没有完成结构化视觉转写。请重新独立观察原图，直接填写全部可见内容。` },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` } },
          ],
        },
      ],
    };
    const retryResponse = await requestVisionContent(url, config, retryPayload, options);
    if (hasExpectedVisionPayload(retryResponse.content, options)) return retryResponse;
    throw new ImageReverseError('upstream_incomplete', '上游模型未完成图片结构化分析，请重试', 502);
  } catch (error) {
    if (error instanceof ImageReverseError) throw error;
    const message = error instanceof Error && error.name === 'TimeoutError' ? '图片反推请求超时' : '图片反推接口无法连接';
    throw new ImageReverseError('upstream_unavailable', message, 502);
  }
}

/** 请求一次结构化识图；第三方端点不支持 response_format 时自动按原载荷重试。 */
async function requestVisionContent(url: string, config: ImageReverseRuntimeConfig, payload: unknown, options: ImageReverseExtractOptions): Promise<{ content: string; structuredOutputMode: ImageReverseStructuredOutputMode }> {
  const basePayload = payload as Record<string, unknown>;
  const strictFormat = buildImageReverseJsonSchemaResponseFormat(`image_reverse_${options.mode}`, buildStructuredOutputExample(options));
  const strictResponse = await sendChatCompletionRequest(url, config, { ...basePayload, response_format: strictFormat });
  const strictText = await strictResponse.text();
  if (strictResponse.ok) return { content: readVisionResponseContent(strictText), structuredOutputMode: 'json-schema' };
  if (!shouldFallbackStructuredOutput(strictResponse.status, strictText)) {
    throw new ImageReverseError('upstream_failed', buildUpstreamErrorMessage(strictResponse.status, strictText), strictResponse.status >= 500 ? 502 : 400);
  }

  const jsonObjectResponse = await sendChatCompletionRequest(url, config, { ...basePayload, response_format: { type: 'json_object' } });
  const jsonObjectText = await jsonObjectResponse.text();
  if (jsonObjectResponse.ok) return { content: readVisionResponseContent(jsonObjectText), structuredOutputMode: 'json-object' };
  if (!shouldRetryWithoutJsonObject(jsonObjectText)) {
    throw new ImageReverseError('upstream_failed', buildUpstreamErrorMessage(jsonObjectResponse.status, jsonObjectText), jsonObjectResponse.status >= 500 ? 502 : 400);
  }

  const plainResponse = await sendChatCompletionRequest(url, config, basePayload);
  const plainText = await plainResponse.text();
  if (plainResponse.ok) return { content: readVisionResponseContent(plainText), structuredOutputMode: 'prompt-json' };
  throw new ImageReverseError('upstream_failed', buildUpstreamErrorMessage(plainResponse.status, plainText), plainResponse.status >= 500 ? 502 : 400);
}

/** 校验上游是否真正返回当前模式的结构化内容，偏离任务或只返回错误对象时触发重新识图。 */
function hasExpectedVisionPayload(content: string, options: ImageReverseExtractOptions): boolean {
  if (isImageReverseContentDeflection(content)) return false;
  const raw = parseReverseJson(content);
  const candidates: unknown[] = [raw, raw.zh, raw.en, raw.prompt, raw.characterProfile, raw.edit, raw.tagPrompt];
  candidates.push(...Object.values(raw));
  const localized = readObject(raw.localized);
  if (localized) candidates.push(...Object.values(localized));
  const expectedKeys = options.mode === 'tags'
    ? ['qualityTags', 'characterTags', 'detailTags', 'styleTags']
    : options.mode === 'prompt'
      ? ['positivePrompt', 'negativePrompt', 'characterPrompt', 'stylePrompt']
      : options.mode === 'character'
        ? ['summary', 'character', 'identityAnchors', 'reproductionPrompt']
        : options.mode === 'edit'
          ? ['sourceSummary', 'keep', 'change', 'editPrompt']
          : ['overview', 'character', 'subjects', 'details', 'style', 'drawingPrompt'];
  return candidates.some((candidate) => countOwnKeys(candidate, expectedKeys) >= 2);
}

/** 统计候选对象自身包含的当前模式字段数，错误对象不会被当作有效结果。 */
function countOwnKeys(value: unknown, keys: string[]): number {
  const record = readObject(value);
  return record ? keys.filter((key) => Object.prototype.hasOwnProperty.call(record, key)).length : 0;
}

/** 构造不同模式的系统提示词，确保每次只输出一种结果。 */
function buildSystemPrompt(basePrompt: string, options: ImageReverseExtractOptions): string {
  const languageLine = buildLanguagePromptLine(options);
  const focused = isFocusedImageReverse(options);
  const observationRules = focused
    ? [
        '准确性优先：只记录当前单项范围内看得清的事实；不确定的内容用“疑似/可能/不明显”表达，不得用其他视觉维度补足上下文。',
        '每条内容都必须能归入当前单项范围；无法归入时直接省略，不得写空泛评价。',
      ]
    : [
        '必须先完整观察再组织 JSON：从全局画面到主体，再到五官/服装/道具/背景/光影/材质/风格/镜头逐项拆解。',
        '准确性优先：看得清的内容要具体，颜色、形状、相对位置、数量、材质、纹理、姿态、遮挡关系和画面边缘信息都要写；看不清或无法确定的内容用“疑似/可能/不明显”表达，不要编造。',
        '细节密度要求：尽量避免“好看、精致、复杂、丰富”等空泛词，改写成可画出来的具体元素；不要只给短句或关键词。',
        '空间关系要求：说明主体在画面中的位置、朝向、视线、肢体动作、与其他物体的前后/左右/上下关系，以及背景层次。',
        '风格要求：区分摄影、插画、二次元、3D、写实、厚涂、赛璐璐、模型渲染、截图等，并描述线条、笔触、质感、景深和后期效果。',
      ];
  const common = [
    basePrompt,
    getImageReverseDirectInstruction(),
    '只描述图片中可见内容，不识别真实身份，不输出隐私信息。',
    ...observationRules,
    '必须返回严格 JSON，不要 Markdown，不要代码块，不要解释 JSON 之外的文本。',
    `输出语言要求：${languageLine}`,
    `详细度：${options.detailLevel}；输出区域：${options.sections.join(', ')}；每个非数组文本字段都应尽量写成完整描述，不要只写一个词。`,
  ];
  if (options.mode === 'description') {
    if (focused) return [...common, ...buildImageReverseFocusPrompt(options)].join('\n');
    return [
      ...common,
      '当前是描述模式。只能返回描述模式 JSON，禁止返回 tagPrompt、prompt、characterProfile 或 edit 字段。',
      '一次请求必须返回全部分类，不要让用户再次选择局部范围。',
      '去重是硬要求：同一条可见事实只能归属一个描述字段，禁止在 overview、subjects、details、character、composition、style、colorLighting、backgroundAtmosphere 之间改写后重复。',
      '字段边界：overview 只用一至两句概括画面类型、核心事件和整体氛围，不枚举局部细节；subjects 只列主体类别、数量和主次关系，不写外观、服装或姿势。',
      'character 内部也必须唯一归属：bodyAndProportion 只写体态，faceFeatures/hair/eyes/skinAndMakeup 各写对应外观，outfit 只写服装，accessoriesAndProps 只写随身配饰道具，poseAndAction 只写姿势动作，禁止跨字段复述。',
      'details 只写不属于角色字段和背景字段的前景物件、表面纹理、图案、材质与可见符号；composition 只写镜头、裁切、视角、透视和主体位置；style 只写媒介、线条与渲染技法；colorLighting 只写色彩和光源阴影；backgroundAtmosphere 只写环境、空间层次和天气氛围。',
      '画风还原必须尽可能具体准确：style 要分别判断摄影/插画/二次元/3D 等媒介，描述线条粗细与颜色、勾线边缘、上色分区、渐变方式、笔触、渲染层次、材质表现、细节密度、景深、颗粒、辉光和后期质感；禁止只写“二次元、精致、唯美”等泛词。',
      '准确性高于丰富度：只写原图可见证据，不把推测当事实，不虚构画师、作品、角色身份或不可见结构；无法确认时明确使用“疑似、可能、不明显”。中英文必须表达完全相同的事实、数量、颜色、位置和不确定性。',
      'identityAnchors 和 qualityTags 只服务于原图描述，不得写入 drawingPrompt 或 negativePrompt。',
      'drawingPrompt 固定用于“不定数量角色参考图 + 提示词”的角色迁移：全部新参考图共同作为角色身份和外观的唯一来源；提示词只能迁移原图的姿势动作、非角色物件、构图镜头、背景、色彩光影和画风。',
      '参考图数量不等于主体角色数量：多张图展示同一角色时只能作为多视角和细节证据，不得要求复制多个主体；明确展示不同角色时分别保持身份，禁止角色融合。反推场景中明确可见的陪伴生物、环境角色和物件继续作为场景内容描述，不受主体参考图数量规则影响。',
      'drawingPrompt 禁止出现原图角色的性别呈现、物种、年龄感、脸型五官、发型发色、瞳色、肤色、体型、服装、配饰、身份锚点或其他具体角色特征；不得要求替换、修改或重新设计新参考图角色。',
      'negativePrompt 在描述模式中表示自然语言“参考图使用规则 / 生成约束”，必须明确同角色多图不复制、参考图外观优先、不同角色不融合，并补充结构错误、画质问题和角色漂移等通用限制；禁止用原图角色的具体特征作为约束。',
      `严格 JSON 结构：${buildDescriptionSchema(options)}`,
    ].join('\n');
  }
  if (options.mode === 'prompt') {
    return [
      ...common,
      `当前是 Prompt 模式。目标模型：${options.promptTarget ?? 'general'}。只能返回 prompt JSON。`,
      'positivePrompt 要可直接复制生成图，按“主体/角色细节/服装道具/姿势表情/构图镜头/场景背景/光影色彩/画风质量”的顺序组织。',
      'characterPrompt 必须聚焦角色复现，compositionPrompt 必须描述镜头裁切、视角、主体位置和空间关系，stylePrompt 必须描述媒介、线条、渲染、质感，backgroundPrompt 必须描述环境层次。',
      'negativePrompt 写真实会破坏该图效果的避免项，包括画质、结构、光影、风格跑偏和多余元素。',
      `严格 JSON 结构：${PROMPT_SCHEMA}`,
    ].join('\n');
  }
  if (options.mode === 'character') {
    return [
      ...common,
      `当前是角色复刻模式。一致性：${options.characterConsistency ?? 'standard'}。只能返回 characterProfile JSON。`,
      '必须把角色拆成可复刻档案：头身比例、体型轮廓、脸型、眉眼鼻口、瞳色瞳形、发型发色、刘海/鬓角/发尾、肤色妆容、表情气质、服装版型、材质、图案、配饰、道具、姿势和不可丢失特征。',
      'identityAnchors 必须写最能保持角色一致性的锚点，优先选择形状、颜色、位置和组合关系明确的特征，不写泛泛的“漂亮/可爱”。',
      'outfitBreakdown 和 featureBreakdown 要拆到局部层级；reproductionPrompt 要能尽量复现同一角色；avoidPrompt 写防止发型、脸、服饰和体态跑偏的约束。',
      `严格 JSON 结构：${CHARACTER_SCHEMA}`,
    ].join('\n');
  }
  if (options.mode === 'edit') {
    return [
      ...common,
      `当前是图生图编辑模式。编辑用途：${options.editIntent ?? 'auto'}。只能返回 edit JSON。`,
      '必须区分 keep/change/remove/avoid：keep 写需要保留的构图、姿势、脸部方向、光影、背景和风格；change 写可改动目标；remove 写需要去除的具体物件或特征；avoid 写防止结构和风格跑偏的限制。',
      'referenceMapping 用于说明参考图之间的角色、姿势、背景、风格或服装关系；只有单图时也要说明当前图作为主参考的作用。',
      'editPrompt 要能直接复制到图生图提示词，明确“保留什么、替换什么、不要改变什么”，并尽量使用可执行的视觉描述。',
      `严格 JSON 结构：${EDIT_SCHEMA}`,
    ].join('\n');
  }
  return [
    ...common,
    `当前是标签模式。目标格式：${options.tagPreset ?? 'sdxl'}；权重策略：${options.tagWeightMode ?? 'important'}；标签密度：${options.tagDensity ?? 'standard'}。`,
    '只能返回标签模式 JSON，禁止返回描述模式字段。所有 en 标签必须是 Stable Diffusion、NAI、ComfyUI 常用英文标签。',
    '标签必须来自图片可见内容，按质量、角色、局部细节、构图、风格、环境和负向项分类；英文标签用小写英文短标签或常见下划线标签，不要写完整英文句子。',
    'characterTags 必须尽可能详细，覆盖角色类型、人数、发型发色、眼睛、表情、肤色、体型、服装、配饰、姿势和关键识别点；detailTags 补充材质、图案、小物件、纹理、光影细节。',
    'compositionTags 写视角、镜头距离、裁切、主体位置和景深；styleTags 写画风、媒介、渲染和质感；environmentTags 写场景、背景层次、天气/室内外和氛围。',
    '权重策略：角色关键特征 1.15-1.45，画风和质量 1.05-1.30，普通细节 0.90-1.10，避免滥用超过 1.5。',
    `严格 JSON 结构：${TAG_SCHEMA}`,
  ].join('\n');
}

/** 构造用户消息，进一步约束所选模式。 */
function buildUserInstruction(options: ImageReverseExtractOptions): string {
  const focused = isFocusedImageReverse(options);
  return [
    `请按 ${options.mode} 模式反推这张图片。`,
    `输出选项 JSON：${JSON.stringify(options)}`,
    focused ? `只提取 ${options.focus} 单项；范围外内容必须完全省略。` : '请像给画师和绘图模型写设定一样观察：先确定全局场景，再逐项记录主体、角色、服装、姿态、构图、背景、光影、材质、画风和可复现锚点。',
    '所有语言必须描述同一张图片的同一事实，不允许不同语言编造不同内容；不确定的细节要标注不确定，不要省略整块信息。',
    '只返回与当前模式匹配的严格 JSON。',
  ].join('\n');
}

/** 多语言约束写入系统提示词，避免模型把英文整段塞进中文字段。 */
function buildLanguagePromptLine(options: ImageReverseExtractOptions): string {
  const languages = selectedOutputLanguages(options);
  return [
    `需要输出语言：${languages.join(', ')}`,
    'zh/zh-CN 使用简体中文；en/en-US 使用英文；ja-JP 使用日文；ko-KR 使用韩文；zh-TW 使用繁体中文。',
    '不要在中文字段输出整段英文，不要在英文字段输出中文。',
    `Prompt 语言：${options.language.promptLanguage}`,
  ].join(' ');
}

/** 按本次实际语言生成描述 schema，避免默认中英双份输出导致响应时间翻倍。 */
function buildDescriptionSchema(options: ImageReverseExtractOptions): string {
  return JSON.stringify(Object.fromEntries(selectedOutputLanguages(options).map((language) => [normalizeLanguageAlias(language), DESCRIPTION_LANGUAGE_SCHEMA])));
}

/** 构造当前模式的完整示例，供严格 JSON Schema 从同一业务字段源生成。 */
function buildStructuredOutputExample(options: ImageReverseExtractOptions): Record<string, unknown> {
  if (isFocusedImageReverse(options)) {
    return {
      localized: Object.fromEntries(selectedOutputLanguages(options).map((language) => [normalizeLanguageAlias(language), {
        summary: '',
        observations: [],
        promptFragment: '',
        focus: options.focus,
      }])),
    };
  }
  if (options.mode === 'description') {
    return Object.fromEntries(selectedOutputLanguages(options).map((language) => [normalizeLanguageAlias(language), DESCRIPTION_LANGUAGE_SCHEMA]));
  }
  if (options.mode === 'prompt') return JSON.parse(PROMPT_SCHEMA) as Record<string, unknown>;
  if (options.mode === 'character') return JSON.parse(CHARACTER_SCHEMA) as Record<string, unknown>;
  if (options.mode === 'edit') return JSON.parse(EDIT_SCHEMA) as Record<string, unknown>;
  return JSON.parse(TAG_SCHEMA) as Record<string, unknown>;
}

/** 发送 OpenAI 兼容请求；必要时由调用方降级重试。 */
async function sendChatCompletionRequest(url: string, config: ImageReverseRuntimeConfig, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Math.max(5, config.timeoutSec) * 1000),
  });
}

/** 解析识图接口响应正文。 */
function readVisionResponseContent(text: string): string {
  let body: ChatCompletionResponse;
  try {
    body = JSON.parse(text) as ChatCompletionResponse;
  } catch {
    throw new ImageReverseError('upstream_invalid', '图片反推接口返回不是合法 JSON', 502);
  }
  const content = readChatContent(body);
  if (!content) throw new ImageReverseError('upstream_empty', '图片反推接口未返回内容', 502);
  return content;
}

/** 判断第三方 OpenAI 兼容接口是否不支持 response_format。 */
function shouldRetryWithoutJsonObject(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return lower.includes('response_format') || lower.includes('json_object') || lower.includes('unsupported parameter');
}

/** 严格 schema 在兼容端点被拒绝时才降级，鉴权和服务端错误保持原错误语义。 */
function shouldFallbackStructuredOutput(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes('response_format')
    || lower.includes('json_schema')
    || lower.includes('structured output')
    || lower.includes('unsupported')
    || lower.includes('unknown parameter')
    || lower.includes('invalid parameter')
    || lower.includes('invalid schema');
}

/** 检查结果是否需要真实模型二次规范化。 */
function needsRepair(result: ImageReverseResultView): boolean {
  if (result.mode === 'tags') {
    // 简单图标、风景或无人物画面本就可能没有角色标签，不能为了固定数量触发二次识图并诱导补写不可见内容。
    const visibleTagCount = result.tagPrompt.characterTags.length
      + result.tagPrompt.detailTags.length
      + result.tagPrompt.compositionTags.length
      + result.tagPrompt.styleTags.length
      + result.tagPrompt.environmentTags.length;
    return visibleTagCount === 0;
  }
  if (result.mode === 'prompt') {
    return !result.positivePrompt || result.positivePrompt.length < 160 || !result.compositionPrompt || !result.stylePrompt;
  }
  if (result.mode === 'character') {
    return !result.reproductionPrompt || result.reproductionPrompt.length < 140 || result.identityAnchors.length < 5 || result.featureBreakdown.length < 6;
  }
  if (result.mode === 'edit') {
    return !result.editPrompt || result.editPrompt.length < 120 || result.keep.length + result.change.length + result.avoid.length < 6;
  }
  if (result.focus && result.focus !== 'all') return focusedImageReverseNeedsRepair(result.focused);
  const language = normalizeLanguageAlias(result.options.language.primaryLanguage);
  const primary = result.localized[language];
  if (!primary?.overview || !primary.drawingPrompt) return true;
  if (language === 'zh' && !isMostlyChineseDescription(primary)) return true;
  if (language === 'en' && !isMostlyEnglishDescription(primary)) return true;
  return primary.subjects.length < 1;
}

/** 使用真实模型重新观察图片并修正当前模式 JSON，避免只做格式清洗导致细节继续缺失。 */
async function repairModeResult(config: ImageReverseRuntimeConfig, imageBuffer: Buffer, mimeType: string, rawText: string, options: ImageReverseExtractOptions): Promise<string | undefined> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, options) },
      {
        role: 'user',
        content: [
          { type: 'text', text: '语言校验规则：各语言对象必须使用对应语言；如果原始结果语言错位，请重新翻译并补齐，不要照抄错位语言。' },
          { type: 'text', text: isFocusedImageReverse(options) ? `第一轮 ${options.focus} 单项结果不够完整。请重新观察图片，只补齐这个范围，继续排除所有其他范围。` : '第一轮结果不够完整。请重新观察图片本身并补齐缺失分类；每条事实只能写入最匹配的一个描述字段，禁止为了补齐而在多个分类中重复。' },
          { type: 'text', text: `下面是第一轮原始结果，只能作为参考。请以图片可见内容为准，输出当前模式的严格 JSON，只返回 JSON。\n\n${rawText.slice(0, 16000)}` },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  };
  try {
    const response = await sendChatCompletionRequest(url, config, payload);
    const text = await response.text();
    if (response.ok) return readVisionResponseContent(text);
    if (shouldRetryWithoutJsonObject(text)) {
      const retryResponse = await sendChatCompletionRequest(url, config, { ...payload, response_format: undefined });
      const retryText = await retryResponse.text();
      if (retryResponse.ok) return readVisionResponseContent(retryText);
    }
  } catch {
    // 二次规范化只是质量兜底，失败时保留第一次真实识图结果。
  }
  return undefined;
}

/** 读取不同兼容接口返回的 message.content。 */
function readChatContent(body: ChatCompletionResponse): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((item) => item.text ?? '').join('\n').trim();
  return '';
}

/** 尽量解析 AI JSON，兼容模型包裹代码块或在前后添加少量文本。 */
function parseReverseJson(content: string): RawReverseResult {
  const trimmed = content.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidate = extractJsonObject(withoutFence);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as RawReverseResult;
  } catch {
    return {};
  }
}

/** 从文本中截取第一个完整 JSON 对象。 */
function extractJsonObject(value: string): string {
  const start = value.indexOf('{');
  if (start < 0) return value;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  const end = value.lastIndexOf('}');
  return end > start ? value.slice(start, end + 1) : value;
}

/** 将 AI 输出归一化为所选模式的前端稳定字段。 */
function normalizeReverseResult(raw: RawReverseResult, rawText: string, model: string, source: ImageReverseSourceView, maxOutputChars: number, options: ImageReverseExtractOptions): ImageReverseResultView {
  const limit = Math.max(500, Math.min(20000, maxOutputChars));
  const base = { rawText: clampText(rawText, Math.max(limit, 4000), ''), model, source, extractedAt: new Date().toISOString(), options };
  if (options.mode === 'tags') return { ...base, mode: options.mode, tagPrompt: normalizeTagPrompt(raw.tagPrompt ?? raw, options) };
  if (options.mode === 'prompt') {
    const localized = normalizeLocalizedPromptResult(raw, limit, options);
    const primary = localized[normalizeLanguageAlias(options.language.primaryLanguage)] ?? firstValue(localized) ?? emptyPromptResult(options);
    return { ...base, ...primary, mode: options.mode, localized };
  }
  if (options.mode === 'character') {
    const localized = normalizeLocalizedCharacterResult(raw, limit, options);
    const primary = localized[normalizeLanguageAlias(options.language.primaryLanguage)] ?? firstValue(localized) ?? emptyCharacterProfile('zh', limit);
    return { ...base, ...primary, mode: options.mode, localized };
  }
  if (options.mode === 'edit') {
    const localized = normalizeLocalizedEditResult(raw, limit, options);
    const primary = localized[normalizeLanguageAlias(options.language.primaryLanguage)] ?? firstValue(localized) ?? emptyEditResult(options);
    return { ...base, ...primary, mode: options.mode, localized };
  }
  if (isFocusedImageReverse(options)) {
    const focusedLocalized = normalizeImageReverseFocusedLocalized(raw, options, limit);
    const focused = focusedLocalized[normalizeLanguageAlias(options.language.primaryLanguage)] ?? firstValue(focusedLocalized) ?? emptyFocusedResult(options.focus);
    return {
      ...base,
      ...emptyDescriptionLanguageResult(),
      mode: options.mode,
      focus: options.focus,
      focused,
      focusedLocalized,
      localized: {},
    };
  }
  const localized = normalizeLocalizedDescriptionResult(raw, limit, options);
  const primaryLanguage = normalizeLanguageAlias(options.language.primaryLanguage);
  const primary = localized[primaryLanguage] ?? firstValue(localized) ?? normalizeDescriptionLanguageResult(raw, limit, primaryLanguage);
  return { ...base, ...primary, mode: options.mode, focus: 'all', localized };
}

/** 构造单项提取空结果；只保持契约稳定，不回填综合内容。 */
function emptyFocusedResult(focus: ImageReverseFocusedLanguageResultView['focus']): ImageReverseFocusedLanguageResultView {
  return { focus, summary: '', observations: [], promptFragment: '' };
}

/** 构造描述模式空壳；单项结果只使用 focused 字段，旧综合字段必须保持为空。 */
function emptyDescriptionLanguageResult(): ImageReverseDescriptionLanguageResultView {
  return {
    overview: '',
    character: {
      present: false,
      type: '',
      countAndRole: '',
      bodyAndProportion: '',
      faceFeatures: '',
      hair: '',
      eyes: '',
      skinAndMakeup: '',
      expressionAndTemperament: '',
      outfit: '',
      accessoriesAndProps: '',
      poseAndAction: '',
      identityAnchors: [],
      characterPrompt: '',
    },
    subjects: [],
    details: [],
    composition: '',
    style: '',
    colorLighting: '',
    backgroundAtmosphere: '',
    qualityTags: [],
    drawingPrompt: '',
    negativePrompt: '',
  };
}

/** 归一化描述模式多语言结果。 */
function normalizeLocalizedDescriptionResult(raw: RawReverseResult, limit: number, options: ImageReverseExtractOptions) {
  const result: Record<string, ImageReverseDescriptionLanguageResultView> = {};
  for (const language of selectedOutputLanguages(options)) {
    const normalized = normalizeLanguageAlias(language);
    result[normalized] = normalizeDescriptionLanguageResult(readLocalizedObject(raw, normalized), limit, normalized);
  }
  return result;
}

/** 归一化 Prompt 模式多语言结果。 */
function normalizeLocalizedPromptResult(raw: RawReverseResult, limit: number, options: ImageReverseExtractOptions): Record<string, ImageReversePromptLanguageResultView> {
  const result: Record<string, ImageReversePromptLanguageResultView> = {};
  for (const language of selectedOutputLanguages(options)) {
    const normalized = normalizeLanguageAlias(language);
    result[normalized] = normalizePromptResult(readLocalizedObject(raw, normalized) ?? readObject(raw.prompt), limit, options);
  }
  return result;
}

/** 归一化角色模式多语言结果。 */
function normalizeLocalizedCharacterResult(raw: RawReverseResult, limit: number, options: ImageReverseExtractOptions): Record<string, ImageReverseCharacterProfileLanguageResultView> {
  const result: Record<string, ImageReverseCharacterProfileLanguageResultView> = {};
  for (const language of selectedOutputLanguages(options)) {
    const normalized = normalizeLanguageAlias(language);
    result[normalized] = normalizeCharacterProfileResult(readLocalizedObject(raw, normalized) ?? readObject(raw.characterProfile), limit, normalized);
  }
  return result;
}

/** 归一化编辑模式多语言结果。 */
function normalizeLocalizedEditResult(raw: RawReverseResult, limit: number, options: ImageReverseExtractOptions): Record<string, ImageReverseEditLanguageResultView> {
  const result: Record<string, ImageReverseEditLanguageResultView> = {};
  for (const language of selectedOutputLanguages(options)) {
    const normalized = normalizeLanguageAlias(language);
    result[normalized] = normalizeEditResult(readLocalizedObject(raw, normalized) ?? readObject(raw.edit), limit, options);
  }
  return result;
}

/** 归一化描述模式单语言结果。 */
function normalizeDescriptionLanguageResult(raw: RawDescriptionLanguageResult | undefined, limit: number, language: ImageReverseLanguage): ImageReverseDescriptionLanguageResultView {
  const source = raw ?? {};
  const overviewFallback = language === 'zh' ? '未返回概述' : '';
  const normalized = dedupeDescriptionResult({
    overview: clampText(readString(source.overview), limit, overviewFallback),
    character: normalizeCharacter(source.character, limit, language),
    subjects: readStringArray(source.subjects, 20, 300),
    details: readStringArray(source.details, 36, 320),
    composition: clampText(readString(source.composition), limit, ''),
    style: clampText(readString(source.style), limit, ''),
    colorLighting: clampText(readString(source.colorLighting), limit, ''),
    backgroundAtmosphere: clampText(readString(source.backgroundAtmosphere), limit, ''),
    qualityTags: readStringArray(source.qualityTags, 40, 100),
    // 描述栏保留模型识别事实；提示词由后端从安全字段确定性重组，忽略上游可能夹带的原角色特征。
    drawingPrompt: '',
    negativePrompt: '',
  });
  return { ...normalized, ...buildImageReverseReferencePrompt(normalized, language, limit) };
}

/** 清理描述结果中的数组重复项；语义字段边界由提示词约束，这里再兜底移除完全重复文本。 */
function dedupeDescriptionResult(result: ImageReverseDescriptionLanguageResultView): ImageReverseDescriptionLanguageResultView {
  const subjects = uniqueNormalizedText(result.subjects);
  const subjectKeys = new Set(subjects.map(normalizeTextKey));
  return {
    ...result,
    subjects,
    details: uniqueNormalizedText(result.details).filter((item) => !subjectKeys.has(normalizeTextKey(item))),
    qualityTags: uniqueNormalizedText(result.qualityTags),
    character: {
      ...result.character,
      identityAnchors: uniqueNormalizedText(result.character.identityAnchors),
    },
  };
}

function uniqueNormalizedText(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeTextKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTextKey(value: string): string {
  return value.toLowerCase().replace(/[\s，。；、,.!！?？:：'"“”‘’()（）\-_]/g, '');
}

/** 归一化 Prompt 模式结果，字段缺失时用同一真实文本兜底，不编造图片内容。 */
function normalizePromptResult(raw: RawPromptResult | RawDescriptionLanguageResult | undefined, limit: number, options: ImageReverseExtractOptions): ImageReversePromptLanguageResultView {
  const source = raw ?? {};
  return {
    positivePrompt: clampText(readString((source as RawPromptResult).positivePrompt), limit, ''),
    negativePrompt: clampText(readString((source as RawPromptResult).negativePrompt), limit, ''),
    characterPrompt: clampText(readString((source as RawPromptResult).characterPrompt), limit, ''),
    compositionPrompt: clampText(readString((source as RawPromptResult).compositionPrompt), limit, ''),
    stylePrompt: clampText(readString((source as RawPromptResult).stylePrompt), limit, ''),
    backgroundPrompt: clampText(readString((source as RawPromptResult).backgroundPrompt), limit, ''),
    target: options.promptTarget ?? 'general',
  };
}

/** 归一化角色复刻模式结果。 */
function normalizeCharacterProfileResult(raw: RawCharacterProfileResult | RawDescriptionLanguageResult | undefined, limit: number, language: ImageReverseLanguage): ImageReverseCharacterProfileLanguageResultView {
  const source = raw ?? {};
  const character = normalizeCharacter((source as RawCharacterProfileResult).character, limit, language);
  const anchors = readStringArray((source as RawCharacterProfileResult).identityAnchors, 24, 180);
  return {
    summary: clampText(readString((source as RawCharacterProfileResult).summary), limit, ''),
    character,
    outfitBreakdown: readStringArray((source as RawCharacterProfileResult).outfitBreakdown, 32, 240),
    featureBreakdown: readStringArray((source as RawCharacterProfileResult).featureBreakdown, 40, 240),
    identityAnchors: anchors.length ? anchors : character.identityAnchors,
    reproductionPrompt: clampText(readString((source as RawCharacterProfileResult).reproductionPrompt) || character.characterPrompt, limit, ''),
    avoidPrompt: clampText(readString((source as RawCharacterProfileResult).avoidPrompt), limit, ''),
  };
}

/** 归一化图生图编辑模式结果。 */
function normalizeEditResult(raw: RawEditResult | RawDescriptionLanguageResult | undefined, limit: number, options: ImageReverseExtractOptions): ImageReverseEditLanguageResultView {
  const source = raw ?? {};
  return {
    sourceSummary: clampText(readString((source as RawEditResult).sourceSummary), limit, ''),
    keep: readStringArray((source as RawEditResult).keep, 32, 240),
    change: readStringArray((source as RawEditResult).change, 32, 240),
    remove: readStringArray((source as RawEditResult).remove, 24, 200),
    avoid: readStringArray((source as RawEditResult).avoid, 32, 200),
    referenceMapping: readStringArray((source as RawEditResult).referenceMapping, 16, 260),
    editPrompt: clampText(readString((source as RawEditResult).editPrompt), limit, ''),
    intent: options.editIntent ?? 'auto',
  };
}

/** Prompt 模式空结果，只有在上游完全漏字段时用于保持响应结构稳定。 */
function emptyPromptResult(options: ImageReverseExtractOptions): ImageReversePromptLanguageResultView {
  return { positivePrompt: '', negativePrompt: '', characterPrompt: '', compositionPrompt: '', stylePrompt: '', backgroundPrompt: '', target: options.promptTarget ?? 'general' };
}

/** 角色模式空结果。 */
function emptyCharacterProfile(language: ImageReverseLanguage, limit: number): ImageReverseCharacterProfileLanguageResultView {
  return { summary: '', character: normalizeCharacter(undefined, limit, language), outfitBreakdown: [], featureBreakdown: [], identityAnchors: [], reproductionPrompt: '', avoidPrompt: '' };
}

/** 编辑模式空结果。 */
function emptyEditResult(options: ImageReverseExtractOptions): ImageReverseEditLanguageResultView {
  return { sourceSummary: '', keep: [], change: [], remove: [], avoid: [], referenceMapping: [], editPrompt: '', intent: options.editIntent ?? 'auto' };
}

/** 归一化角色描述，确保字段稳定。 */
function normalizeCharacter(raw: RawCharacterDescription | undefined, limit: number, language: ImageReverseLanguage): ImageReverseCharacterDescriptionView {
  const source = raw ?? {};
  const empty = language === 'zh' ? '' : '';
  return {
    present: source.present !== false,
    type: clampText(readString(source.type), 160, empty),
    countAndRole: clampText(readString(source.countAndRole), 260, empty),
    bodyAndProportion: clampText(readString(source.bodyAndProportion), limit, empty),
    faceFeatures: clampText(readString(source.faceFeatures), limit, empty),
    hair: clampText(readString(source.hair), limit, empty),
    eyes: clampText(readString(source.eyes), limit, empty),
    skinAndMakeup: clampText(readString(source.skinAndMakeup), limit, empty),
    expressionAndTemperament: clampText(readString(source.expressionAndTemperament), limit, empty),
    outfit: clampText(readString(source.outfit), limit, empty),
    accessoriesAndProps: clampText(readString(source.accessoriesAndProps), limit, empty),
    poseAndAction: clampText(readString(source.poseAndAction), limit, empty),
    identityAnchors: readStringArray(source.identityAnchors, 20, 180),
    characterPrompt: clampText(readString(source.characterPrompt), limit, empty),
  };
}

/** 归一化本地模型标签模式，确保最终 prompt 是稳定的英文逗号分隔标签。 */
function normalizeTagPrompt(raw: RawTagResult | undefined, options: ImageReverseExtractOptions): ImageReverseTagResultView {
  const dense = options.tagDensity === 'rich' ? 1.35 : options.tagDensity === 'compact' ? 0.7 : 1;
  const qualityTags = normalizeTagItems(raw?.qualityTags, defaultTags(['masterpiece', 'best quality', 'highres', 'detailed'], 1.1), Math.round(24 * dense));
  const characterTags = normalizeTagItems(raw?.characterTags, [], Math.round(80 * dense));
  const detailTags = normalizeTagItems(raw?.detailTags, [], Math.round(60 * dense));
  const compositionTags = normalizeTagItems(raw?.compositionTags, [], Math.round(32 * dense));
  const styleTags = normalizeTagItems(raw?.styleTags, [], Math.round(36 * dense));
  const environmentTags = normalizeTagItems(raw?.environmentTags, [], Math.round(36 * dense));
  const negativeTags = normalizeTagItems(raw?.negativeTags, defaultTags(['low quality', 'blurry', 'bad anatomy', 'bad proportions', 'deformed face', 'extra limbs', 'text', 'watermark'], 1.1), Math.round(40 * dense));
  const positiveTags = [...qualityTags, ...characterTags, ...detailTags, ...compositionTags, ...styleTags, ...environmentTags];
  const animaPrompt = formatImageReverseAnimaPrompt({ characterTags, detailTags, compositionTags, environmentTags, styleTags, qualityTags });
  const useAnimaFormat = options.tagPreset === 'anima';
  return {
    qualityTags,
    characterTags,
    detailTags,
    compositionTags,
    styleTags,
    environmentTags,
    negativeTags,
    positivePrompt: useAnimaFormat ? animaPrompt : joinTags(positiveTags, false),
    positivePromptWithWeights: useAnimaFormat ? animaPrompt : joinTags(positiveTags, options.tagWeightMode !== 'none'),
    negativePrompt: joinTags(negativeTags, false),
    negativePromptWithWeights: joinTags(negativeTags, options.tagWeightMode !== 'none'),
    animaPrompt,
    formatterVersion: IMAGE_REVERSE_ANIMA_FORMATTER_VERSION,
  };
}

/** 读取并清洗标签项。 */
function normalizeTagItems(value: unknown, fallback: ImageReverseLocalModelTagView[], maxItems: number): ImageReverseLocalModelTagView[] {
  const rawItems = Array.isArray(value) ? value : [];
  const parsed = rawItems.map((item) => normalizeTagItem(item)).filter((item): item is ImageReverseLocalModelTagView => Boolean(item));
  const source = parsed.length ? parsed : fallback;
  const seen = new Set<string>();
  return source.slice(0, maxItems).filter((item) => {
    const key = item.en.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 归一化单个标签项，避免中文或长句混入本地模型 prompt。 */
function normalizeTagItem(value: unknown): ImageReverseLocalModelTagView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as RawTagItem;
  const en = normalizeLocalModelTag(readString(raw.en));
  if (!en) return undefined;
  return { zh: clampText(readString(raw.zh), 100, en), en, weight: clampWeight(raw.weight) };
}

/** 创建默认标签列表。 */
function defaultTags(values: string[], weight: number): ImageReverseLocalModelTagView[] {
  return values.map((value) => ({ zh: value, en: normalizeLocalModelTag(value), weight })).filter((item) => Boolean(item.en));
}

/** 清洗为本地模型标签：小写、短语化、移除标点，空格转下划线。 */
function normalizeLocalModelTag(value: string): string {
  const cleaned = value.trim().toLowerCase()
    .replace(/[(){}[\]"'`]/g, '')
    .replace(/[:：]/g, ' ')
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned || hasCjkText(cleaned) || cleaned.length > 90) return '';
  return cleaned;
}

/** 标签权重限制在本地模型常用安全区间。 */
function clampWeight(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '1'));
  if (!Number.isFinite(parsed)) return 1;
  return Math.round(Math.min(2, Math.max(0.1, parsed)) * 100) / 100;
}

/** 拼接本地模型 prompt；带权重时仅对非 1.0 权重标签加 `(tag:1.10)`。 */
function joinTags(tags: ImageReverseLocalModelTagView[], withWeights: boolean): string {
  return tags.map((tag) => {
    if (!withWeights || Math.abs(tag.weight - 1) < 0.01) return tag.en;
    return `(${tag.en}:${tag.weight.toFixed(2)})`;
  }).join(', ');
}

/** 读取对象字段。 */
function readObject<T extends Record<string, unknown> = RawDescriptionLanguageResult>(value: unknown): T | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as T;
}

/** 按标准语言和旧 zh/en 兼容键读取局部结果对象。 */
function readLocalizedObject<T extends Record<string, unknown> = RawDescriptionLanguageResult>(raw: RawReverseResult, language: ImageReverseLanguage): T | undefined {
  const localized = readObject<Record<string, unknown>>(raw.localized);
  const keys = language === 'zh' || language === 'zh-CN'
    ? ['zh', 'zh-CN']
    : language === 'en' || language === 'en-US'
    ? ['en', 'en-US']
    : [language];
  for (const key of keys) {
    const direct = readObject<T>((raw as Record<string, unknown>)[key]);
    if (direct) return direct;
    const nested = readObject<T>(localized?.[key]);
    if (nested) return nested;
  }
  return undefined;
}

/** 读取对象第一项，用于主语言缺失时兜底展示真实模型返回。 */
function firstValue<T>(record: Record<string, T>): T | undefined {
  return Object.values(record)[0];
}

/** 读取字符串字段。 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 读取字符串数组，兼容模型返回单个字符串。 */
function readStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[，,\n]/) : [];
  return raw.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, maxItems).map((item) => item.slice(0, maxLength));
}

/** 限制文本长度，空值使用兜底文案。 */
function clampText(value: string, maxLength: number, fallback: string): string {
  const text = value.trim();
  return (text || fallback).slice(0, maxLength);
}

/** 校验中文描述整体语言，避免模型只在概述给中文、其他字段大量返回英文。 */
function isMostlyChineseDescription(result: ImageReverseDescriptionLanguageResultView): boolean {
  const texts = collectDescriptionTexts(result);
  if (!texts.length) return false;
  if (!hasCjkText(result.overview) || !hasCjkText(result.drawingPrompt)) return false;
  const joined = texts.join('\n');
  const cjkCount = countCjkChars(joined);
  const latinWordCount = countLatinWords(joined);
  const latinLetterCount = countLatinLetters(joined);
  return cjkCount >= 12 && !(latinWordCount >= 8 && latinLetterCount > cjkCount * 0.8);
}

/** 校验英文描述整体语言，避免英文区域混入中文导致双语结果错位。 */
function isMostlyEnglishDescription(result: ImageReverseDescriptionLanguageResultView): boolean {
  const texts = collectDescriptionTexts(result);
  if (!texts.length) return false;
  const joined = texts.join('\n');
  return countCjkChars(joined) <= 4 && countLatinWords(joined) >= 8;
}

/** 汇总描述模式所有可见文本字段，作为语言一致性校验输入。 */
function collectDescriptionTexts(result: ImageReverseDescriptionLanguageResultView): string[] {
  return [
    result.overview,
    ...collectCharacterTexts(result.character),
    ...result.subjects,
    ...result.details,
    result.composition,
    result.style,
    result.colorLighting,
    result.backgroundAtmosphere,
    ...result.qualityTags,
    result.drawingPrompt,
    result.negativePrompt,
  ].map((item) => item.trim()).filter(Boolean);
}

/** 汇总角色描述字段，确保中文角色细节也参与语言检查。 */
function collectCharacterTexts(character: ImageReverseCharacterDescriptionView): string[] {
  return [
    character.type,
    character.countAndRole,
    character.bodyAndProportion,
    character.faceFeatures,
    character.hair,
    character.eyes,
    character.skinAndMakeup,
    character.expressionAndTemperament,
    character.outfit,
    character.accessoriesAndProps,
    character.poseAndAction,
    ...character.identityAnchors,
    character.characterPrompt,
  ];
}

/** 统计中日韩字符数量，用于判断中文结果是否足够中文化。 */
function countCjkChars(value: string): number {
  return value.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
}

/** 统计英文单词数量，少量专有名词不算语言错位，大段英文会触发修复。 */
function countLatinWords(value: string): number {
  return value.match(/[A-Za-z][A-Za-z'-]{2,}/g)?.length ?? 0;
}

/** 统计英文字母数量，用于和中文字符数量做比例判断。 */
function countLatinLetters(value: string): number {
  return value.match(/[A-Za-z]/g)?.length ?? 0;
}

/** 标准化 Base URL，允许管理员填 /v1 或带尾斜杠。 */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** 粗略判断文本是否包含中文、日文或韩文字符。 */
function hasCjkText(value: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(value);
}

/** 提取上游错误摘要，不暴露请求密钥或完整 HTML。 */
function buildUpstreamErrorMessage(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return `图片反推接口调用失败：HTTP ${status}`;
  try {
    const body = JSON.parse(trimmed) as { error?: { message?: string }; message?: string };
    const message = body.error?.message || body.message;
    if (message) return `图片反推接口调用失败：${message.slice(0, 180)}`;
  } catch {
    // 非 JSON 错误直接截断展示，避免泄露过长 HTML。
  }
  return `图片反推接口调用失败：HTTP ${status} ${trimmed.slice(0, 120)}`;
}
