/**
 * 本文件封装调用上游绘图 API 的 HTTP 客户端。
 * 支持 OpenAI Images、BFL input_image JSON、Grok JSON edits、SSE 和直接二进制返回。
 *
 * 上游错误必须清洗脱敏后再返回给调用方，原始错误保存在 rawError 中供管理排障。
 * API Key 只在本模块读取，不向调用方或日志暴露。
 */
import type { ApiSiteConfig, SiteSelectionResult } from '../site-selection/site-selection-types.js';
import type { DrawingAspectRatio, DrawingLoraSnapshot, ReferenceImageField, ReferenceImageOverflowStrategy } from '@aiimage/shared-contracts';
import sharp from 'sharp';
import { downloadImageWithLimit } from '../media/media-upload-client.js';
import { UpstreamApiCallError, type UpstreamApiError } from './upstream-error.js';
import { isContentPolicyBlockedText, isPlainTextResponseRetryable, looksLikeWrongFormatMessage, sanitizeRawError, toChineseError } from './upstream-error-utils.js';
import { fetchSourceImage, MAX_IMAGE_DOWNLOAD_BYTES, mimeToExt } from './upstream-image-utils.js';
import { withBflImageReferenceInstruction, withImageReferenceInstruction, withXaiImageReferenceInstruction } from './reference-prompt-instruction.js';
import { resolveJsonAspectRatio, resolveOpenAiImageSize } from './image-output-parameters.js';
import { ensureComfyLoraAvailable } from './comfy-lora-sync-client.js';

/** BFL Kontext 站点未配置有效超时时使用的协议兜底。 */
const BFL_IMAGE_GENERATION_TIMEOUT_MS = 600_000;

/** Geek2API Grok 站点未配置有效超时时使用的协议兜底。 */
const GROK_IMAGE_EDIT_TIMEOUT_MS = 300_000;

/** 普通 OpenAI Images 站点和全局值均无效时使用的最终兜底。 */
const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = 300_000;

/** ComfyUI Anima 输出按用户画幅计算，最长边固定为 1536 像素，兼顾质量、显存和五分钟时限。 */
const COMFY_ANIMA_MAX_EDGE = 1536;

/** ComfyUI 潜空间尺寸按 8 像素对齐。 */
const COMFY_SIZE_ALIGNMENT = 8;

/** Anima 官方新版 Turbo LoRA，基于 Base v1.0 提升速度并保留更自然的细节。 */
const COMFY_ANIMA_TURBO_LORA = 'anima-turbo-lora-v0.2.safetensors';

/** Anima 高分辨率美学 LoRA，增强 1536 像素输出稳定性和默认完成度。 */
const COMFY_ANIMA_HIGHRES_LORA = 'anima-highres-aesthetic-boost.safetensors';

/** 官方 Turbo 模型与 LoRA 均推荐 CFG 1；实测 8 步在速度、结构和细节之间最稳定。 */
const COMFY_ANIMA_TURBO_STEPS = 8;

/** 高分辨率美学 LoRA 使用适中权重，避免满权重放大人体比例和服装偏移。 */
const COMFY_ANIMA_HIGHRES_STRENGTH = 0.8;

/** Anima 官方推荐的基础质量标签，避免依赖提示增强是否主动添加质量前缀。 */
const COMFY_ANIMA_QUALITY_PREFIX = 'masterpiece, best quality, score_7';

/** Anima 官方基础负面标签，并补充常见结构缺陷。 */
const COMFY_ANIMA_NEGATIVE_PROMPT = 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, distorted, bad anatomy, malformed hands, extra fingers';

/** GPU 端已验证的 WebP 保存格式；由 ComfyUI 直接编码，避免把 PNG 回传到 Worker 后再二次转码。 */
const COMFY_ANIMA_OUTPUT_FORMAT = 'WEBP';

/** 使用最高 WebP 质量压缩，优先保留生成图的细节，同时显著降低跨服务器传输体积。 */
const COMFY_ANIMA_OUTPUT_WEBP_QUALITY = 100;

/** Anima Base 模型名称集合；只有 Base 模型叠加 Turbo LoRA，避免完整 Turbo 模型重复加速导致画面失真。 */
const COMFY_ANIMA_BASE_MODELS = new Set([
  'anima-base-v1.0.safetensors',
  'anima_baseV10.safetensors',
]);

/** ComfyUI 轮询和产物下载都是短请求，单次网络抖动由独立短超时和重试处理。 */
const COMFY_HTTP_REQUEST_TIMEOUT_MS = 30_000;

/** ComfyUI 历史和产物短请求重试次数；不改变模型生成超时。 */
const COMFY_HTTP_REQUEST_ATTEMPTS = 3;

/** Geek2API/xAI 实测单次 Grok JSON edits 最多接受 3 个图片对象。 */
const GROK_NATIVE_REFERENCE_LIMIT = 3;

/** GPT Image 兼容上游要求 Auto 推导出的宽高均为 16 像素倍数。 */
const GPT_IMAGE_SIZE_ALIGNMENT = 16;

/** Grok JSON edits 使用的独立参考图对象。 */
type GrokReferenceImage = { type: 'image_url'; url: string };

/** 上游 API 调用请求上下文，包含站点、模型和生成参数。 */
export type UpstreamGenerateRequest = {
  /** 提示词。 */
  prompt: string;
  /** 绘图模式。 */
  mode: 'text-to-image' | 'image-to-image';
  /** 参考图 URL 列表（图生图模式使用）。 */
  sourceImageUrls?: string[];
  /** 原始参考图 URL（用于 Bot 首次使用 QQ 原图的场景）。 */
  originalSourceImageUrls?: string[];
  /** 生成尺寸。 */
  size?: string;
  /** 统一画幅比例；由当前站点协议转换为 size 或 aspect_ratio。 */
  aspectRatio?: DrawingAspectRatio;
  /** 质量参数。 */
  quality?: string;
  /** 审核参数。 */
  moderation?: string;
  /** 生成张数。 */
  n?: number;
  /** 按用户身份生成的稳定渠道亲和键。 */
  promptCacheKey: string;
  /** backend 已校验并固化的用户 LoRA 文件快照。 */
  lora?: DrawingLoraSnapshot;
};

/** 上游 API 成功响应，包含图片数据和元信息。 */
export type UpstreamImageResult = {
  /** 图片二进制缓冲区。 */
  imageBuffer: Buffer;
  /** 图片 MIME 类型。 */
  mimeType: string;
  /** 上游响应耗时毫秒。 */
  latencyMs: number;
  /** 上游返回的原始格式类型。 */
  format: 'base64' | 'url' | 'binary' | 'sse' | 'chat_image';
};

/**
 * 调用上游绘图 API 生成图片。
 * 根据站点配置自动选择请求格式（JSON/multipart）和响应解析方式。
 */
export async function callUpstreamImageApi(
  site: ApiSiteConfig,
  model: string,
  request: UpstreamGenerateRequest,
  globalTimeoutMs?: number,
  apiMode?: SiteSelectionResult['apiMode'],
  referenceImageField?: ReferenceImageField,
  maxReferenceImages?: number,
  referenceImageOverflowStrategy?: ReferenceImageOverflowStrategy,
): Promise<UpstreamImageResult> {
  const startTime = Date.now();
  const controller = new AbortController();
  // 站点超时是管理员针对真实上游配置的权威值，不能再被全局 125 秒或协议默认值截断。
  const timeoutMs = resolveUpstreamTimeoutMs(site.timeoutSec, globalTimeoutMs, apiMode);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (apiMode === 'comfyui_generation') return await callComfyUiGeneration(site, model, request, controller.signal, startTime);
    if (apiMode === 'bfl_image_generation' && request.mode === 'image-to-image') {
      return await callBflImageGeneration(site, model, request, controller.signal, startTime, maxReferenceImages, referenceImageOverflowStrategy);
    }
    if (apiMode === 'grok_image_edit_json' && request.mode === 'image-to-image') {
      return await callGrokImageEditJson(site, model, request, controller.signal, startTime, maxReferenceImages);
    }
    if (request.mode === 'image-to-image') {
      return await callImageToImage(site, model, request, controller.signal, startTime, referenceImageField, maxReferenceImages, referenceImageOverflowStrategy);
    }
    return await callTextToImage(site, model, request, controller.signal, startTime, apiMode);
  } catch (error) {
    if (isAbortError(error)) {
      // AbortController 只由本项目的上游请求超时触发；对用户展示为上游超时，而不是原始 “operation aborted”。
      throw new UpstreamApiCallError(
        '上游请求超时',
        `client_timeout_after_${timeoutMs}ms`,
        true,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 使用已验证的 Anima 文生图图，把 ComfyUI 的提交、轮询和产物下载封装为普通站点返回。 */
async function callComfyUiGeneration(site: ApiSiteConfig, model: string, request: UpstreamGenerateRequest, signal: AbortSignal, startTime: number): Promise<UpstreamImageResult> {
  if (request.mode !== 'text-to-image') throw new UpstreamApiCallError('当前 ComfyUI 模型只支持文生图', 'comfyui_generation: image-to-image unsupported', false);
  const [width, height] = resolveComfySize(request.size, request.aspectRatio);
  const positivePrompt = withComfyAnimaQualityPrefix(request.prompt);
  const loraFileName = request.lora ? await ensureComfyLoraAvailable(site.baseUrl, request.lora, signal) : undefined;
  const prompt = buildComfyAnimaWorkflow(model, positivePrompt, request.promptCacheKey, width, height, request.lora, loraFileName);
  const submitted = await fetchComfyUiWithRetry(`${site.baseUrl}/prompt`, signal, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: request.promptCacheKey }),
  });
  const submissionBody = await readResponseTextWithLimit(submitted, 64 * 1024);
  const submission = parseComfyUiJson<{ prompt_id?: string }>(submissionBody);
  if (!submitted.ok || !submission.prompt_id) throw new UpstreamApiCallError('ComfyUI 提交失败', sanitizeRawError(submissionBody), true, submitted.status);
  while (!signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const historyResponse = await fetchComfyUiWithRetry(`${site.baseUrl}/history/${encodeURIComponent(submission.prompt_id)}`, signal);
    const history = parseComfyUiJson<Record<string, {
      status?: { status_str?: string };
      outputs?: { '11'?: { images?: Array<{ filename: string; subfolder?: string; type?: string }> } };
    }>>(await readResponseTextWithLimit(historyResponse, 1024 * 1024));
    const item = history[submission.prompt_id];
    if (!item) continue;
    const image = item.outputs?.['11']?.images?.[0];
    if (image) {
      const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
      const response = await fetchComfyUiWithRetry(`${site.baseUrl}/view?${query}`, signal);
      if (!response.ok) throw new UpstreamApiCallError('ComfyUI 结果下载失败', `comfyui_view_http_${response.status}`, true, response.status);
      const imageBuffer = await readResponseBufferWithLimit(response, MAX_IMAGE_DOWNLOAD_BYTES);
      return { imageBuffer, mimeType: response.headers.get('content-type')?.split(';', 1)[0] || 'image/png', latencyMs: Date.now() - startTime, format: 'binary' };
    }
    if (item.status?.status_str === 'error') throw new UpstreamApiCallError('ComfyUI 生成失败', 'comfyui_execution_error', false);
  }
  throw new UpstreamApiCallError('ComfyUI 请求超时', 'comfyui_generation_aborted', true);
}

/** 构建 Anima ComfyUI 工作流；Base 使用 Turbo LoRA，完整 Turbo 模型只叠加高分辨率美学 LoRA。 */
function buildComfyAnimaWorkflow(model: string, positivePrompt: string, promptCacheKey: string, width: number, height: number, userLora?: DrawingLoraSnapshot, userLoraFileName?: string): Record<string, unknown> {
  const isBaseModel = COMFY_ANIMA_BASE_MODELS.has(model.toLowerCase());
  const isPremergedTurboModel = model.toLowerCase().includes('turbo');
  const samplingSteps = isPremergedTurboModel ? 10 : COMFY_ANIMA_TURBO_STEPS;
  const turboModelInput: [string, number] = isBaseModel ? ['4', 0] : ['1', 0];
  const turboClipInput: [string, number] = isBaseModel ? ['4', 1] : ['2', 0];
  const hasUserLora = Boolean(userLora && userLoraFileName);
  const activeModelInput: [string, number] = hasUserLora ? ['12', 0] : ['5', 0];
  const activeClipInput: [string, number] = hasUserLora ? ['12', 1] : ['5', 1];
  const prompt: Record<string, unknown> = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    // 高分辨率美学 LoRA 接在 Turbo 后，同时作用于模型和文本编码器，保证 1.5K 输出结构与风格一致。
    '5': { class_type: 'LoraLoader', inputs: { model: turboModelInput, clip: turboClipInput, lora_name: COMFY_ANIMA_HIGHRES_LORA, strength_model: COMFY_ANIMA_HIGHRES_STRENGTH, strength_clip: COMFY_ANIMA_HIGHRES_STRENGTH } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: positivePrompt, clip: activeClipInput } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: COMFY_ANIMA_NEGATIVE_PROMPT, clip: activeClipInput } },
    '8': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    // Turbo LoRA 官方推荐 CFG 1；实测 er_sde + simple 在 8 步下比旧 Restart 10 步更快且不会出现纯色或高对比纹理噪声。
    '9': { class_type: 'KSampler', inputs: { model: activeModelInput, seed: Math.floor(Math.random() * 2_147_483_647), steps: samplingSteps, cfg: 1, sampler_name: 'er_sde', scheduler: 'simple', positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0], denoise: 1 } },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
    // GPU 的安全保存节点直接输出高质量 WebP；history/view 仍沿用同一节点号，Worker 会按响应 MIME 原样上传媒体服务。
    '11': {
      class_type: 'DapaoSafeSaveImage',
      inputs: {
        '🖼️ 图像': ['10', 0],
        '📄 文件名前缀': `aiimage_${promptCacheKey}`,
        '💾 格式': COMFY_ANIMA_OUTPUT_FORMAT,
        '📉 质量': COMFY_ANIMA_OUTPUT_WEBP_QUALITY,
        '😶‍🌫️ 移除元数据': true,
      },
    },
  };
  if (isBaseModel) {
    // Anima 使用 Qwen 文本编码器；实测套用 SD 系列的 CLIP -2 会导致纯色和纹理噪声，因此保持模型原生完整层。
    prompt['4'] = { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['2', 0], lora_name: COMFY_ANIMA_TURBO_LORA, strength_model: 1, strength_clip: 1 } };
  }
  if (userLora && userLoraFileName) {
    // 用户 LoRA 固定接在系统 Turbo 与美学 LoRA 之后，同时作用于模型和 Qwen 文本编码器。
    prompt['12'] = { class_type: 'LoraLoader', inputs: { model: ['5', 0], clip: ['5', 1], lora_name: userLoraFileName, strength_model: userLora.strength, strength_clip: userLora.strength } };
  }
  return prompt;
}

/** ComfyUI 短请求使用独立超时并重试网络抖动，外层站点 signal 仍控制整个生成流程。 */
async function fetchComfyUiWithRetry(url: string, outerSignal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= COMFY_HTTP_REQUEST_ATTEMPTS; attempt += 1) {
    if (outerSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    const controller = new AbortController();
    const abortFromOuter = () => controller.abort();
    outerSignal.addEventListener('abort', abortFromOuter, { once: true });
    const timeout = setTimeout(() => controller.abort(), COMFY_HTTP_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (outerSignal.aborted) throw error;
      lastError = error;
      if (attempt < COMFY_HTTP_REQUEST_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    } finally {
      clearTimeout(timeout);
      outerSignal.removeEventListener('abort', abortFromOuter);
    }
  }
  throw lastError;
}

/** 解析 ComfyUI JSON；空响应或偶发错误页按空对象处理，由调用点输出稳定错误。 */
function parseComfyUiJson<T extends object>(raw: string): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as T : {} as T;
  } catch {
    return {} as T;
  }
}

/** 限制 ComfyUI JSON 文本体积，避免异常上游响应占用过多 Worker 内存。 */
async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  return (await readResponseBufferWithLimit(response, maxBytes)).toString('utf8');
}

/** 为 Anima 请求补充官方质量标签；已包含时不重复追加，保持图库中的实际用户提示词不变。 */
function withComfyAnimaQualityPrefix(prompt: string): string {
  const normalizedPrompt = prompt.trim();
  const lowerPrompt = normalizedPrompt.toLowerCase();
  const missingQualityTags = COMFY_ANIMA_QUALITY_PREFIX
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => !lowerPrompt.includes(tag));
  return [...missingQualityTags, normalizedPrompt].filter(Boolean).join(', ');
}

/** 把用户选择的尺寸或画幅转换为 ComfyUI 最大 1.5K、8 像素对齐的实际像素尺寸。 */
function resolveComfySize(size: string | undefined, aspectRatio: DrawingAspectRatio | undefined): [number, number] {
  if (/^\d+x\d+$/.test(size ?? '')) {
    const [requestedWidth, requestedHeight] = (size as string).split('x').map(Number);
    return fitComfySizeToMaxEdge(requestedWidth, requestedHeight);
  }
  const [horizontal, vertical] = (aspectRatio && aspectRatio !== 'auto' ? aspectRatio : '1:1').split(':').map(Number);
  return horizontal >= vertical
    ? [COMFY_ANIMA_MAX_EDGE, alignComfyDimension(COMFY_ANIMA_MAX_EDGE * vertical / horizontal)]
    : [alignComfyDimension(COMFY_ANIMA_MAX_EDGE * horizontal / vertical), COMFY_ANIMA_MAX_EDGE];
}

/** 保持显式宽高比例，并把超过 1.5K 的长边等比收敛到 1536。 */
function fitComfySizeToMaxEdge(width: number, height: number): [number, number] {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : COMFY_ANIMA_MAX_EDGE;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : COMFY_ANIMA_MAX_EDGE;
  const scale = Math.min(1, COMFY_ANIMA_MAX_EDGE / Math.max(safeWidth, safeHeight));
  return [alignComfyDimension(safeWidth * scale), alignComfyDimension(safeHeight * scale)];
}

/** 对齐 ComfyUI 潜空间尺寸，同时避免极端画幅产生零尺寸。 */
function alignComfyDimension(value: number): number {
  return Math.max(64, Math.min(COMFY_ANIMA_MAX_EDGE, Math.round(value / COMFY_SIZE_ALIGNMENT) * COMFY_SIZE_ALIGNMENT));
}

/** 解析上游超时：有效站点秒数始终优先，全局和协议值只在站点值非法时兜底。 */
export function resolveUpstreamTimeoutMs(
  siteTimeoutSec: number,
  globalTimeoutMs?: number,
  apiMode?: SiteSelectionResult['apiMode'],
): number {
  const normalizedSiteTimeoutSec = Number(siteTimeoutSec);
  if (Number.isFinite(normalizedSiteTimeoutSec) && normalizedSiteTimeoutSec > 0) {
    return Math.max(1000, Math.round(normalizedSiteTimeoutSec * 1000));
  }
  const normalizedGlobalTimeoutMs = Number(globalTimeoutMs);
  const globalFallback = Number.isFinite(normalizedGlobalTimeoutMs) && normalizedGlobalTimeoutMs > 0
    ? Math.round(normalizedGlobalTimeoutMs)
    : DEFAULT_IMAGE_REQUEST_TIMEOUT_MS;
  if (apiMode === 'bfl_image_generation') return Math.max(globalFallback, BFL_IMAGE_GENERATION_TIMEOUT_MS);
  if (apiMode === 'grok_image_edit_json') return Math.max(globalFallback, GROK_IMAGE_EDIT_TIMEOUT_MS);
  return Math.max(1000, globalFallback);
}

/**
 * Grok 参考图编辑：POST JSON 到 /images/edits。
 * 单次最多原生发送 3 张；更多参考图按模型配置分阶段加入，不拼图、不截断。
 */
async function callGrokImageEditJson(
  site: ApiSiteConfig,
  model: string,
  request: UpstreamGenerateRequest,
  signal: AbortSignal,
  startTime: number,
  maxReferenceImages?: number,
): Promise<UpstreamImageResult> {
  const sourceImages = request.sourceImageUrls ?? [];
  if (sourceImages.length === 0) {
    throw new UpstreamApiCallError('图生图至少需要 1 张参考图', 'grok_image_edit_json: empty image-to-image request', false);
  }
  const effectiveLimit = Math.min(8, Math.max(1, maxReferenceImages ?? 4));
  if (sourceImages.length > effectiveLimit) {
    throw new UpstreamApiCallError(
      `当前 Grok 格式最多接收 ${effectiveLimit} 张参考图`,
      `grok_image_edit_json: ${sourceImages.length} reference images exceed limit ${effectiveLimit}`,
      false,
    );
  }
  const images: GrokReferenceImage[] = [];
  for (const imageUrl of sourceImages) {
    const { buffer, contentType } = await fetchSourceImage(imageUrl);
    // Geek2API 实测只识别 type/url 对象；image_url/detail 会被接受但不会把参考图上传到 Grok。
    images.push({ type: 'image_url', url: `data:${contentType};base64,${buffer.toString('base64')}` });
  }
  if (images.length <= GROK_NATIVE_REFERENCE_LIMIT) {
    return callGrokJsonEditRequest(
      site,
      model,
      withXaiImageReferenceInstruction(request.prompt, sourceImages.length),
      images,
      request.aspectRatio,
      request.promptCacheKey,
      signal,
      startTime,
    );
  }

  // Grok 单次拒绝 4 张以上图片；先处理前两张，后续每阶段把已有结果与最多两张新图独立发送。
  let processedCount = 2;
  let stageResult = await callGrokJsonEditRequest(
    site,
    model,
    buildGrokInitialStagePrompt(request.prompt, images.length),
    images.slice(0, processedCount),
    request.aspectRatio,
    request.promptCacheKey,
    signal,
    Date.now(),
  );
  while (processedCount < images.length) {
    const additions = images.slice(processedCount, processedCount + GROK_NATIVE_REFERENCE_LIMIT - 1);
    const nextCount = processedCount + additions.length;
    const accumulatedImage: GrokReferenceImage = {
      type: 'image_url',
      url: `data:${stageResult.mimeType};base64,${stageResult.imageBuffer.toString('base64')}`,
    };
    stageResult = await callGrokJsonEditRequest(
      site,
      model,
      buildGrokContinuationPrompt(request.prompt, processedCount, additions.length, nextCount),
      [accumulatedImage, ...additions],
      request.aspectRatio,
      request.promptCacheKey,
      signal,
      Date.now(),
    );
    processedCount = nextCount;
  }
  return { ...stageResult, latencyMs: Date.now() - startTime };
}

/** 调用单次 Grok JSON edits；单图 image 与多图 images 必须互斥。 */
async function callGrokJsonEditRequest(
  site: ApiSiteConfig,
  model: string,
  prompt: string,
  images: GrokReferenceImage[],
  aspectRatio: DrawingAspectRatio | undefined,
  promptCacheKey: string,
  signal: AbortSignal,
  startTime: number,
): Promise<UpstreamImageResult> {
  const body: Record<string, unknown> = { model, prompt };
  const upstreamAspectRatio = resolveJsonAspectRatio({ aspectRatio });
  if (upstreamAspectRatio) body.aspect_ratio = upstreamAspectRatio;
  if (site.sendPromptCacheKey) body.prompt_cache_key = promptCacheKey;
  // Geek2API 会把同时出现的 image/images 解释为冲突字段，因此必须按数量二选一。
  if (images.length === 1) body.image = images[0];
  else body.images = images;
  const response = await fetch(`${site.baseUrl}/images/edits`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${site.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  return parseUpstreamResponse(response, startTime);
}

/** 构造 Grok 多阶段第一步提示词，明确前两张都必须进入可继续编辑的中间结果。 */
function buildGrokInitialStagePrompt(prompt: string, totalCount: number): string {
  return `${prompt}\n这是 ${totalCount} 张参考图的分阶段编辑。先同时整合当前两张参考图，每张图都是一个独立参考来源，必须完整保留各自的关键主体、身份、外观、服装与构图特征，不得融合、替换或遗漏。若两张图各包含一名人物或角色，中间结果必须清楚呈现两名独立人物或角色；结果还会继续加入其余参考图。`;
}

/** 构造 Grok 多阶段后续提示词，要求保留累计结果并加入本阶段全部独立参考图。 */
function buildGrokContinuationPrompt(prompt: string, existingCount: number, additionCount: number, nextCount: number): string {
  return `${prompt}\n参考图1是已经完整包含前 ${existingCount} 张原始参考图的累计结果，必须原样保留其中每个已有独立主体及其关键特征，后续参考图不得替换、遮盖或删除已有主体。其余 ${additionCount} 张参考图各自是一个新增的独立参考来源，必须全部加入且不得相互融合。本阶段结果必须完整体现累计 ${nextCount} 张原始参考图；如果每张原始图各包含一名人物或角色，最终必须清楚呈现恰好 ${nextCount} 名独立人物或角色。`;
}

/**
 * BFL Kontext 兼容图生图：POST JSON 到 /images/generations。
 * input_image 必须是无 data URI 前缀的原始 base64，不能发送 OpenAI multipart。
 */
async function callBflImageGeneration(
  site: ApiSiteConfig,
  model: string,
  request: UpstreamGenerateRequest,
  signal: AbortSignal,
  startTime: number,
  maxReferenceImages?: number,
  overflowStrategy?: ReferenceImageOverflowStrategy,
): Promise<UpstreamImageResult> {
  const sourceImages = request.sourceImageUrls ?? [];
  const prepared = await prepareSingleInputImage(sourceImages, maxReferenceImages, overflowStrategy);
  const body: Record<string, unknown> = {
    model,
    prompt: buildBflReferenceAwarePrompt(request.prompt, sourceImages.length, prepared.combined),
    input_image: prepared.buffer.toString('base64'),
  };
  const upstreamAspectRatio = resolveJsonAspectRatio(request);
  if (upstreamAspectRatio) body.aspect_ratio = upstreamAspectRatio;
  if (site.sendPromptCacheKey) body.prompt_cache_key = request.promptCacheKey;
  const response = await fetch(`${site.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${site.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  return parseUpstreamResponse(response, startTime);
}

/** 构造 BFL Kontext 编辑提示词；单图短提示必须默认保留原主体身份。 */
function buildBflReferenceAwarePrompt(prompt: string, sourceImageCount: number, combined: boolean): string {
  const instructedPrompt = withBflImageReferenceInstruction(prompt, sourceImageCount);
  return combined
    ? `${instructedPrompt}\n全部参考图已按从左到右、从上到下的顺序合并在一张网格图中，每个网格区域对应一张独立参考图。`
    : instructedPrompt;
}

/**
 * 文生图调用：POST JSON 到 /images/generations。
 * 支持 b64_json、url、纯文本 URL 和 SSE 等响应格式。
 */
async function callTextToImage(
  site: ApiSiteConfig,
  model: string,
  request: UpstreamGenerateRequest,
  signal: AbortSignal,
  startTime: number,
  apiMode?: SiteSelectionResult['apiMode'],
): Promise<UpstreamImageResult> {
  const isGptModel = model.toLowerCase().includes('gpt-image') || model.toLowerCase().includes('dall-e');
  const responseFormat = site.responseFormat === 'auto'
    ? (isGptModel ? 'auto' : 'b64_json')
    : site.responseFormat;

  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    n: request.n ?? 1,
  };
  // 某些 OpenAI 兼容站点会拒绝 response_format=auto；站点关闭开关时必须完全省略该字段。
  if (site.sendResponseFormat !== false) body.response_format = responseFormat;
  if (site.sendPromptCacheKey) body.prompt_cache_key = request.promptCacheKey;
  const jsonAspectRatio = resolveJsonAspectRatio(request);
  const usesJsonAspectRatio = apiMode === 'bfl_image_generation' || apiMode === 'grok_image_edit_json';
  if (usesJsonAspectRatio) {
    if (jsonAspectRatio) body.aspect_ratio = jsonAspectRatio;
    if (request.quality && request.quality !== 'auto') body.quality = request.quality;
  } else if (isGptModel) {
    const upstreamSize = resolveOpenAiImageSize(request, model);
    if (upstreamSize) body.size = upstreamSize;
    if (request.quality) body.quality = request.quality;
    if (request.moderation) body.moderation = request.moderation;
    body.output_format = 'png';
  } else {
    const upstreamSize = resolveOpenAiImageSize(request, model);
    if (upstreamSize && upstreamSize !== 'auto') body.size = upstreamSize;
    if (request.quality && request.quality !== 'auto') body.quality = request.quality;
  }

  const response = await fetch(`${site.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${site.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  return parseUpstreamResponse(response, startTime);
}

/**
 * 图生图调用：POST multipart/form-data 到 /images/edits。
 * multipart 字段优先使用站点模型显式配置，历史配置才按 GPT Image 名称兼容。
 */
async function callImageToImage(
  site: ApiSiteConfig,
  model: string,
  request: UpstreamGenerateRequest,
  signal: AbortSignal,
  startTime: number,
  configuredField?: ReferenceImageField,
  maxReferenceImages?: number,
  overflowStrategy?: ReferenceImageOverflowStrategy,
): Promise<UpstreamImageResult> {
  const formData = new FormData();
  formData.append('model', model);
  if (request.n) formData.append('n', String(request.n));
  // 部分 OpenAI 兼容代理拒绝 size=auto；站点显式开启后改传首图方向修正且按 16 像素对齐的尺寸。
  const upstreamSize = await resolveOpenAiEditSize(request, model, site.autoSizeFromReference);
  if (upstreamSize) formData.append('size', upstreamSize);
  if (request.quality) formData.append('quality', request.quality);
  // multipart 端点也保留同名字段，兼容能从表单读取渠道亲和键的上游网关。
  if (site.sendPromptCacheKey) formData.append('prompt_cache_key', request.promptCacheKey);

  const isGptModel = model.toLowerCase().includes('gpt-image');
  const fieldName = configuredField ?? (isGptModel ? 'image[]' : 'image');

  // 下载/解码参考图并附加到表单（base64 data URL → Buffer → Blob → FormData）
  const sourceImages = request.sourceImageUrls ?? [];
  if (sourceImages.length === 0) {
    throw new UpstreamApiCallError(
      '图生图至少需要 1 张参考图',
      'sourceImages: empty image-to-image request',
      false,
    );
  }
  const shouldCombine = sourceImages.length > 1 && maxReferenceImages === 1 && overflowStrategy === 'combine';
  // Geek2API Grok 单图必须走 edits；补充直接编辑语义，避免把短提示词解释成全新文生图主题。
  const prompt = model.toLowerCase().startsWith('grok-imagine-image')
    ? withXaiImageReferenceInstruction(request.prompt, sourceImages.length)
    : buildReferenceAwarePrompt(request.prompt, sourceImages.length, shouldCombine);
  formData.append('prompt', prompt);
  let attachedCount = 0;
  const failedIndexes: number[] = [];
  if (shouldCombine) {
    try {
      const combined = await combineReferenceImages(sourceImages);
      const blob = new Blob([new Uint8Array(combined)], { type: 'image/png' });
      formData.append(fieldName, blob, 'references-combined.png');
      attachedCount = 1;
    } catch (error) {
      throw new UpstreamApiCallError(
        '多张参考图合并失败，请检查图片格式',
        `sourceImages: combine failed: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
  }
  for (const [index, imageUrl] of shouldCombine ? [] : sourceImages.entries()) {
    try {
      const { buffer, contentType } = await fetchSourceImage(imageUrl);
      // 使用匹配实际格式的扩展名（.png/.jpg/.webp），确保外部 API 正确识别。
      const ext = mimeToExt(contentType);
      const filename = buildReferenceUploadFilename(index, ext);
      // 构造 Blob：Buffer → Uint8Array → Blob（零拷贝，数据无损）
      const blob = new Blob([new Uint8Array(buffer)], { type: contentType });
      formData.append(fieldName, blob, filename);
      attachedCount++;
    } catch (err) {
      // 图生图必须完整携带用户提交的全部参考图；任何一张失败都不能降级为少图生成。
      failedIndexes.push(index + 1);
      console.warn(`[upstream] 参考图附加失败: 第 ${index + 1} 张 ${err instanceof Error ? err.message : err}`);
    }
  }
  if (failedIndexes.length > 0) {
    throw new UpstreamApiCallError(
      `参考图读取失败：第 ${failedIndexes.join('、')} 张`,
      `sourceImages: failed to attach indexes ${failedIndexes.join(',')}`,
      false,
    );
  }
  // 图生图模式下至少需要一张参考图成功
  if (attachedCount === 0 && sourceImages.length > 0) {
    throw new UpstreamApiCallError(
      `所有参考图（${sourceImages.length} 张）均无法附加，请检查图片格式`,
      'sourceImages: all failed to attach',
      false,
    );
  }

  const response = await fetch(`${site.baseUrl}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${site.apiKey}` },
    body: formData,
    signal,
  });

  return parseUpstreamResponse(response, startTime);
}

/** 解析 OpenAI edits 的尺寸；Auto 推导值向下对齐到 16 倍数，避免代理拒绝非对齐宽高。 */
async function resolveOpenAiEditSize(request: UpstreamGenerateRequest, model: string, autoSizeFromReference: boolean): Promise<string | undefined> {
  const explicitSize = resolveOpenAiImageSize(request, model);
  if (request.aspectRatio && request.aspectRatio !== 'auto') return explicitSize;
  if (!autoSizeFromReference || request.size !== 'auto') return explicitSize;
  const firstSourceImage = request.sourceImageUrls?.[0];
  if (!firstSourceImage) {
    throw new UpstreamApiCallError('无法读取第一张参考图尺寸', 'auto_size_from_reference: source image is missing', false);
  }
  try {
    const { buffer } = await fetchSourceImage(firstSourceImage);
    const metadata = await sharp(buffer).metadata();
    const width = metadata.autoOrient.width;
    const height = metadata.autoOrient.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`invalid dimensions ${width}x${height}`);
    }
    return `${alignImageDimension(width)}x${alignImageDimension(height)}`;
  } catch (error) {
    throw new UpstreamApiCallError(
      '无法读取第一张参考图尺寸',
      `auto_size_from_reference: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

/** 将参考图单边尺寸向下对齐到 16 像素倍数，避免放大输出并保证最小有效尺寸。 */
function alignImageDimension(value: number): number {
  return Math.max(GPT_IMAGE_SIZE_ALIGNMENT, Math.floor(value / GPT_IMAGE_SIZE_ALIGNMENT) * GPT_IMAGE_SIZE_ALIGNMENT);
}

/** 为只接受一个 JSON 图片字段的上游准备单图；配置允许时把多图完整合并，不做截断。 */
async function prepareSingleInputImage(
  sourceImageUrls: string[],
  maxReferenceImages?: number,
  overflowStrategy?: ReferenceImageOverflowStrategy,
): Promise<{ buffer: Buffer; combined: boolean }> {
  if (sourceImageUrls.length === 0) {
    throw new UpstreamApiCallError('图生图至少需要 1 张参考图', 'sourceImages: empty single-input request', false);
  }
  if (sourceImageUrls.length === 1) {
    const { buffer } = await fetchSourceImage(sourceImageUrls[0]);
    return { buffer, combined: false };
  }
  if (maxReferenceImages === 1 && overflowStrategy === 'combine') {
    return { buffer: await combineReferenceImages(sourceImageUrls), combined: true };
  }
  throw new UpstreamApiCallError(
    `当前模型最多接收 ${Math.max(1, maxReferenceImages ?? 1)} 张参考图`,
    `sourceImages: ${sourceImageUrls.length} exceeds single-input capability`,
    false,
  );
}

/** 构造带参考图完整性说明的提示词；合并网格时补充稳定的区域顺序。 */
function buildReferenceAwarePrompt(prompt: string, sourceImageCount: number, combined: boolean): string {
  const instructedPrompt = withImageReferenceInstruction(prompt, sourceImageCount);
  return combined
    ? `${instructedPrompt}\n全部参考图已按从左到右、从上到下的顺序合并在一张网格图中，每个网格区域对应一张独立参考图。`
    : instructedPrompt;
}

/** 把单图上游无法原生接收的多张参考图等比排入 1024 像素网格，不裁剪任何图片内容。 */
async function combineReferenceImages(sourceImageUrls: string[]): Promise<Buffer> {
  const columns = Math.ceil(Math.sqrt(sourceImageUrls.length));
  const rows = Math.ceil(sourceImageUrls.length / columns);
  const cellWidth = Math.floor(1024 / columns);
  const cellHeight = Math.floor(1024 / rows);
  const composites: sharp.OverlayOptions[] = [];
  for (const [index, imageUrl] of sourceImageUrls.entries()) {
    const { buffer } = await fetchSourceImage(imageUrl);
    const resized = await sharp(buffer)
      .rotate()
      .resize(cellWidth, cellHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png()
      .toBuffer();
    composites.push({
      input: resized,
      left: (index % columns) * cellWidth,
      top: Math.floor(index / columns) * cellHeight,
    });
  }
  return sharp({
    create: { width: cellWidth * columns, height: cellHeight * rows, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(composites).png().toBuffer();
}

/** 构造传给上游的参考图文件名；多参考图必须唯一，避免兼容代理按文件名覆盖同名 multipart 文件。 */
function buildReferenceUploadFilename(index: number, ext: string): string {
  const safeIndex = Math.max(1, Math.trunc(index) + 1);
  const safeExt = /^\.[a-z0-9]{2,5}$/i.test(ext) ? ext.toLowerCase() : '.png';
  return `reference-${safeIndex}${safeExt}`;
}

/**
 * 统一解析上游响应，支持 JSON（b64_json/url/纯文本 URL）、SSE 流和 image/* 二进制。
 * 响应中无图片但有错误字段时抛出 UpstreamApiError。
 */
async function parseUpstreamResponse(response: Response, startTime: number): Promise<UpstreamImageResult> {
  const contentType = response.headers.get('content-type') ?? '';
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  const latencyMs = Date.now() - startTime;

  // 直接返回二进制图片
  if (contentType.startsWith('image/')) {
    const buffer = await readResponseBufferWithLimit(response, MAX_IMAGE_DOWNLOAD_BYTES);
    return { imageBuffer: buffer, mimeType: contentType, latencyMs, format: 'binary' };
  }

  const text = await response.text();

  // SSE 流式响应 — 提取 data: 行中的 b64_json 或 url
  if (text.includes('data:')) {
    return await parseSseResponse(text, latencyMs);
  }

  // JSON 响应
  try {
    const json = JSON.parse(text) as Record<string, unknown>;

    // 检查是否有错误信息
    if (!response.ok || json.error) {
      throw buildUpstreamError(json, response.status, retryAfterMs);
    }

    // 尝试提取 b64_json
    const images = extractAllImages(json);
    if (images.length > 0 && images[0].imageBuffer) {
      return { ...images[0], latencyMs, format: 'base64' };
    }

    // 尝试提取 URL
    const url = extractAnyUrl(json);
    if (url) {
      const image = await downloadImageWithLimit({
        url,
        maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
        timeoutMs: 120_000,
      });
      const imageBuffer = image.buffer;
      const imageContentType = image.mimeType;
      return { imageBuffer, mimeType: imageContentType, latencyMs, format: 'url' };
    }

    throw new Error('上游响应中未找到图片数据');
  } catch (error) {
    if (error instanceof UpstreamApiCallError) throw error;
    console.error(`[upstream] resp err status=${response.status} ct=${contentType} preview=${text.slice(0,500).replace(/\\n/g,' ')}`);
    throw new UpstreamApiCallError(
      toChineseError(text, error instanceof Error ? error.message : '未知错误', response.status),
      sanitizeRawError(text),
      isPlainTextResponseRetryable(text, response.status),
      response.status,
      retryAfterMs,
    );
  }
}

/** 从 JSON 中提取 base64 图片数据，支持 OpenAI 和第三方代理等多种格式。 */
function extractAllImages(json: Record<string, unknown>): { imageBuffer: Buffer; mimeType: string }[] {
  // 1. 标准 OpenAI: data[].b64_json
  const data = json.data;
  if (Array.isArray(data)) {
    const results = data
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => {
        const b64 = item.b64_json ?? item.base64;
        if (typeof b64 === 'string' && b64.length > 50) {
          return { imageBuffer: Buffer.from(b64, 'base64'), mimeType: 'image/png' };
        }
        return null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    if (results.length > 0) return results;
  }

  // 2. 第三方代理: images[]、result[]、output[] 或 outputs[]
  for (const key of ['images', 'result', 'output', 'outputs']) {
    const arr = json[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const o = item as Record<string, unknown>;
          const b64 = o.b64_json ?? o.base64 ?? o.image_data;
          if (typeof b64 === 'string' && b64.length > 50) {
            return [{ imageBuffer: Buffer.from(b64, 'base64'), mimeType: 'image/png' }];
          }
        }
      }
    }
  }

  // 4. 顶层 base64 字符串
  const topB64 = json.b64_json ?? json.base64 ?? json.image_data;
  if (typeof topB64 === 'string' && topB64.length > 50) {
    return [{ imageBuffer: Buffer.from(topB64, 'base64'), mimeType: 'image/png' }];
  }

  return [];
}

/** 从 JSON 中提取图片 URL，支持多种字段名和嵌套结构。 */
function extractAnyUrl(json: Record<string, unknown>): string | null {
  // 1. 标准 OpenAI: data[].url
  const data = json.data;
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
    const item = data[0] as Record<string, unknown>;
    const url = item.url ?? item.image_url ?? item.image ?? item.link;
    if (typeof url === 'string' && url.length > 5) return url;
  }

  // 2. 代理/第三方: images[].url 或 result[].url
  for (const key of ['images', 'result', 'outputs']) {
    const arr = json[key];
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
      const url = (arr[0] as Record<string, unknown>).url ?? (arr[0] as Record<string, unknown>).image_url;
      if (typeof url === 'string' && url.length > 5) return url;
    }
  }

  // 3. 顶层 url
  const topUrl = json.url ?? json.image_url ?? json.image;
  if (typeof topUrl === 'string' && topUrl.length > 5) return topUrl;

  return null;
}

/** 解析 SSE 流式响应，提取 data: 行中的 b64_json。 */
async function parseSseResponse(text: string, latencyMs: number): Promise<UpstreamImageResult> {
  const lines = text.split('\n');
  const dataLines = lines.filter((line) => line.startsWith('data:') && line.length > 5);
  for (const line of dataLines) {
    const jsonStr = line.slice(5).trim();
    if (jsonStr === '[DONE]') continue;
    try {
      const json = JSON.parse(jsonStr) as Record<string, unknown>;
      const data = json.data;
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
        const item = data[0] as Record<string, unknown>;
        // b64_json 格式
        if (typeof item.b64_json === 'string') {
          return { imageBuffer: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png', latencyMs, format: 'sse' };
        }
        // url 格式 — 下载后转 buffer
        if (typeof item.url === 'string') {
          const image = await downloadImageWithLimit({
            url: item.url,
            maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
            timeoutMs: 60_000,
          });
          const buf = image.buffer;
          const mime = image.mimeType;
          return { imageBuffer: buf, mimeType: mime, latencyMs, format: 'sse' };
        }
      }
    } catch {
      continue;
    }
  }
  throw new Error('SSE 响应中未找到图片数据');
}

/** 构建上游错误对象，对原始响应做脱敏处理。 */
export function buildUpstreamError(json: Record<string, unknown>, statusCode: number, retryAfterMs?: number): UpstreamApiCallError {
  const errorObj = json.error as Record<string, unknown> | undefined;
  // 尝试提取真实错误信息（上游 API 有时只回显请求体，不含 error 字段）
  const rawMessage = errorObj?.message ?? json.message ?? json.detail ?? json.last_error ?? '';
  if (typeof rawMessage === 'string' && looksLikeWrongFormatMessage(rawMessage)) {
    return new UpstreamApiCallError(
      '上游返回结果格式错误',
      sanitizeRawError(JSON.stringify(json)),
      statusCode >= 500 || statusCode === 429,
      statusCode,
      retryAfterMs,
    );
  }
  // 若消息像是回显的请求体（含 prompt 等字段），不展示原始 JSON
  const message = rawMessage
    ? String(rawMessage)
    : (json.prompt ? `上游 API 拒绝了请求（HTTP ${statusCode}，可能是内容审核拦截）` : `上游 API 返回错误（HTTP ${statusCode}）`);
  if (isContentPolicyBlockedText(message) || isContentPolicyBlockedText(JSON.stringify(json))) {
    return new UpstreamApiCallError(
      '上游内容审核拦截，请调整提示词或参考图后重试',
      sanitizeRawError(JSON.stringify(json)),
      false,
      statusCode,
      retryAfterMs,
    );
  }
  const retryable = statusCode >= 500 || statusCode === 429;
  return new UpstreamApiCallError(
    message,
    sanitizeRawError(JSON.stringify(json)),
    retryable,
    statusCode,
    retryAfterMs,
  );
}

/** 解析 Retry-After 秒数或 HTTP 日期，并限制异常大值避免任务无限挂起。 */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(10 * 60_000, Math.ceil(seconds * 1000));
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(10 * 60_000, Math.max(0, timestamp - Date.now()));
}

/** 判断 fetch 是否由本项目 AbortController 超时中断。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'AbortError'
      || error.message.toLowerCase().includes('operation was aborted')
      || error.message.toLowerCase().includes('abort'));
}

/** 读取图片响应体前先检查 Content-Length，读取后再次检查真实字节数。 */
async function readResponseBufferWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > maxBytes) throw new Error(`图片超过下载上限：${declaredLength}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length <= 0 || buffer.length > maxBytes) throw new Error(`图片超过下载上限：${buffer.length}`);
  return buffer;
}

export { UpstreamApiCallError, type UpstreamApiError } from './upstream-error.js';
export { isPlainTextResponseRetryable, sanitizeRawError, toChineseError } from './upstream-error-utils.js';
