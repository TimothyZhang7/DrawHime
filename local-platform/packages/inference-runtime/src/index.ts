/**
 * 本文件实现已在主站生产验证的 Anima ComfyUI 工作流、尺寸约束、提交、轮询和产物下载。
 */
const ANIMA_MAX_EDGE = 1536;
const SIZE_ALIGNMENT = 8;
const TURBO_LORA = "anima-turbo-lora-v0.2.safetensors";
const HIGHRES_LORA = "anima-highres-aesthetic-boost.safetensors";
const HIGHRES_STRENGTH = 0.8;
const QUALITY_PREFIX = "masterpiece, best quality, score_7";
const DEFAULT_NEGATIVE = "worst quality, low quality, score_1, score_2, score_3, artist name, blurry, distorted, bad anatomy, malformed hands, extra fingers";
const BASE_MODELS = new Set(["anima-base-v1.0.safetensors", "anima_basev10.safetensors"]);
const SUPPORTED_SAMPLERS = new Set(["er_sde", "euler", "euler_ancestral"]);
const SUPPORTED_SCHEDULERS = new Set(["simple", "normal"]);

/** Anima 生成请求。 */
export interface AnimaGenerationInput {
  baseUrl: string;
  modelFileName: string;
  prompt: string;
  negativePrompt?: string | null;
  width: number;
  height: number;
  seed?: number | null;
  clientId: string;
  loras?: Array<{ fileName: string; strength: number }>;
  /** 模型目录固化的采样步数。 */
  steps?: number;
  /** 模型目录固化的提示词引导强度。 */
  cfg?: number;
  /** 经目录白名单校验的 ComfyUI 采样器。 */
  samplerName?: string;
  /** 经目录白名单校验的 ComfyUI 调度器。 */
  scheduler?: string;
  /** 对应底模官方建议的纯质量标签，不包含主体内容。 */
  qualityPrefix?: string;
  /** 用户未填写负面提示词时使用的底模默认值。 */
  defaultNegativePrompt?: string;
  /** 是否叠加平台高分辨率美学 LoRA；完整微调底模默认关闭以保留自身风格。 */
  systemHighresLoraEnabled?: boolean;
  /** 扩散采样最长边；可低于最终输出边长以控制单图耗时。 */
  samplingMaxEdge?: number;
  /** 工作流内部最终输出宽度；仅由 Runtime 在尺寸归一化后写入。 */
  outputWidth?: number;
  /** 工作流内部最终输出高度；仅由 Runtime 在尺寸归一化后写入。 */
  outputHeight?: number;
  /** ComfyUI 接受任务后立即持久化 Runtime ID，供重启恢复取消旧队列项。 */
  onSubmitted?: (promptId: string, requestJson: Record<string, unknown>) => Promise<void>;
}

/** Anima 二进制生成结果。 */
export interface AnimaGenerationResult {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  runtimeJobId: string;
  requestJson: Record<string, unknown>;
  responseJson: Record<string, unknown>;
}

/** 调用真实 ComfyUI；生成阶段不设置整体超时，短 HTTP 请求仅在网络错误时重试。 */
export async function generateAnimaImage(input: AnimaGenerationInput): Promise<AnimaGenerationResult> {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const [width, height] = fitSize(input.width, input.height);
  const [samplingWidth, samplingHeight] = fitSizeWithin(width, height, normalizeSamplingMaxEdge(input.samplingMaxEdge));
  const prompt = buildAnimaWorkflow({ ...input, width: samplingWidth, height: samplingHeight, outputWidth: width, outputHeight: height });
  // 独立平台已经完成钱包预留和 GPU 租约，进入 ComfyUI 时放到受控队列前部，避免旧直连链路积压使已计费任务长期停留在运行中。
  const requestJson = { prompt, client_id: input.clientId, front: true };
  const submitted = await fetchWithRetry(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestJson),
  });
  const submission = await readJson<Record<string, unknown>>(submitted, 1024 * 1024);
  const promptId = typeof submission.prompt_id === "string" ? submission.prompt_id : "";
  if (!submitted.ok || !promptId) throw new Error(`ComfyUI 提交失败：HTTP ${submitted.status}`);
  await input.onSubmitted?.(promptId, requestJson);

  for (;;) {
    await sleep(1000);
    const historyResponse = await fetchWithRetry(`${baseUrl}/history/${encodeURIComponent(promptId)}`);
    const history = await readJson<Record<string, ComfyHistoryItem>>(historyResponse, 4 * 1024 * 1024);
    const item = history[promptId];
    if (!item) continue;
    const image = item.outputs?.["11"]?.images?.[0];
    if (image) {
      const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
      const downloaded = await fetchWithRetry(`${baseUrl}/view?${query}`);
      if (!downloaded.ok) throw new Error(`ComfyUI 结果下载失败：HTTP ${downloaded.status}`);
      const buffer = await readBuffer(downloaded, 80 * 1024 * 1024);
      return {
        buffer,
        mimeType: downloaded.headers.get("content-type")?.split(";", 1)[0] || "image/webp",
        width,
        height,
        runtimeJobId: promptId,
        requestJson,
        responseJson: { promptId, image, samplingWidth, samplingHeight, outputWidth: width, outputHeight: height },
      };
    }
    if (item.status?.status_str === "error") throw new Error("ComfyUI 工作流执行失败");
  }
}

/** 构建 Anima Base + Turbo LoRA + 高分辨率美学 LoRA 的生产工作流。 */
export function buildAnimaWorkflow(input: AnimaGenerationInput): Record<string, unknown> {
  const normalizedModel = input.modelFileName.toLowerCase();
  const isBaseModel = BASE_MODELS.has(normalizedModel);
  const isPremergedTurbo = normalizedModel.includes("turbo");
  const modelInput: [string, number] = isBaseModel ? ["4", 0] : ["1", 0];
  const clipInput: [string, number] = isBaseModel ? ["4", 1] : ["2", 0];
  const systemHighresLoraEnabled = input.systemHighresLoraEnabled !== false;
  let activeModelInput: [string, number] = systemHighresLoraEnabled ? ["5", 0] : modelInput;
  let activeClipInput: [string, number] = systemHighresLoraEnabled ? ["5", 1] : clipInput;
  // 正面和负面文本在工作流构建时即分离，禁止通过字符串拼接形成单一 conditioning。
  const positivePrompt = withQualityPrefix(input.prompt, input.qualityPrefix);
  const negativePrompt = input.negativePrompt?.trim() || input.defaultNegativePrompt?.trim() || DEFAULT_NEGATIVE;
  const outputWidth = normalizeOutputDimension(input.outputWidth, input.width);
  const outputHeight = normalizeOutputDimension(input.outputHeight, input.height);
  const shouldScaleOutput = outputWidth !== input.width || outputHeight !== input.height;
  const prompt: Record<string, unknown> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: input.modelFileName, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_06b_base.safetensors", type: "stable_diffusion", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "8": { class_type: "EmptyLatentImage", inputs: { width: input.width, height: input.height, batch_size: 1 } },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
    "11": { class_type: "DapaoSafeSaveImage", inputs: { "🖼️ 图像": shouldScaleOutput ? ["90", 0] : ["10", 0], "📄 文件名前缀": `local_${input.clientId}`, "💾 格式": "WEBP", "📉 质量": 100, "😶‍🌫️ 移除元数据": true } },
  };
  // 完整微调底模在较小潜空间采样后使用 Lanczos 恢复用户选择的输出尺寸，避免高分辨率采样阻塞队列十余分钟。
  if (shouldScaleOutput) prompt["90"] = { class_type: "ImageScale", inputs: { image: ["10", 0], upscale_method: "lanczos", width: outputWidth, height: outputHeight, crop: "disabled" } };
  if (isBaseModel) prompt["4"] = { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["2", 0], lora_name: TURBO_LORA, strength_model: 1, strength_clip: 1 } };
  if (systemHighresLoraEnabled) prompt["5"] = { class_type: "LoraLoader", inputs: { model: modelInput, clip: clipInput, lora_name: HIGHRES_LORA, strength_model: HIGHRES_STRENGTH, strength_clip: HIGHRES_STRENGTH } };
  for (const [index, lora] of (input.loras ?? []).entries()) {
    const nodeId = String(12 + index);
    prompt[nodeId] = { class_type: "LoraLoader", inputs: { model: activeModelInput, clip: activeClipInput, lora_name: lora.fileName, strength_model: lora.strength, strength_clip: lora.strength } };
    activeModelInput = [nodeId, 0];
    activeClipInput = [nodeId, 1];
  }
  prompt["6"] = { class_type: "CLIPTextEncode", inputs: { text: positivePrompt, clip: activeClipInput } };
  prompt["7"] = { class_type: "CLIPTextEncode", inputs: { text: negativePrompt, clip: activeClipInput } };
  prompt["9"] = { class_type: "KSampler", inputs: { model: activeModelInput, seed: normalizeSeed(input.seed), steps: normalizeSteps(input.steps, isPremergedTurbo ? 10 : 8), cfg: normalizeCfg(input.cfg), sampler_name: normalizeSampler(input.samplerName), scheduler: normalizeScheduler(input.scheduler), positive: ["6", 0], negative: ["7", 0], latent_image: ["8", 0], denoise: 1 } };
  return prompt;
}

/** 保持画幅并把最长边收敛到 1536，所有维度按潜空间要求对齐到 8。 */
export function fitSize(width: number, height: number): [number, number] {
  return fitSizeWithin(width, height, ANIMA_MAX_EDGE);
}

/** 保持画幅并把尺寸限制在给定最长边，最终维度始终按潜空间要求对齐。 */
function fitSizeWithin(width: number, height: number, maxEdge: number): [number, number] {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : ANIMA_MAX_EDGE;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : ANIMA_MAX_EDGE;
  const scale = Math.min(1, maxEdge / Math.max(safeWidth, safeHeight));
  return [alignDimension(safeWidth * scale, maxEdge), alignDimension(safeHeight * scale, maxEdge)];
}

/** 补齐官方质量标签且不重复用户已有标签。 */
function withQualityPrefix(value: string, configuredPrefix?: string): string {
  const prompt = value.trim();
  const lower = prompt.toLowerCase();
  const qualityPrefix = configuredPrefix?.trim() || QUALITY_PREFIX;
  const missing = qualityPrefix.split(",").map((item) => item.trim()).filter((item) => item && !lower.includes(item.toLowerCase()));
  return [...missing, prompt].filter(Boolean).join(", ");
}

/** 将模型目录步数限制在生产验证范围。 */
function normalizeSteps(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 50 ? Number(value) : fallback;
}

/** 将 CFG 限制在 ComfyUI 稳定范围。 */
function normalizeCfg(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0.1 && Number(value) <= 20 ? Number(value) : 1;
}

/** 只允许已经验证的采样器名称进入工作流。 */
function normalizeSampler(value: string | undefined): string {
  return value && SUPPORTED_SAMPLERS.has(value) ? value : "er_sde";
}

/** 只允许已经验证的调度器名称进入工作流。 */
function normalizeScheduler(value: string | undefined): string {
  return value && SUPPORTED_SCHEDULERS.has(value) ? value : "simple";
}

/** 将模型级采样边长限制在兼顾质量和吞吐的有效范围。 */
function normalizeSamplingMaxEdge(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) >= 512 && Number(value) <= ANIMA_MAX_EDGE ? Number(value) : ANIMA_MAX_EDGE;
}

/** 归一化最终输出维度，禁止内部调用绕过平台最大边长。 */
function normalizeOutputDimension(value: number | undefined, fallback: number): number {
  const candidate = Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
  return alignDimension(candidate, ANIMA_MAX_EDGE);
}

/** 归一化随机种子到 ComfyUI 可稳定表示的正整数范围。 */
function normalizeSeed(seed?: number | null): number {
  if (Number.isSafeInteger(seed) && Number(seed) >= 0) return Number(seed);
  return Math.floor(Math.random() * 2_147_483_647);
}

/** 维度对齐并限制最小潜空间尺寸。 */
function alignDimension(value: number, maxEdge: number): number {
  return Math.max(64, Math.min(maxEdge, Math.round(value / SIZE_ALIGNMENT) * SIZE_ALIGNMENT));
}

/** ComfyUI 历史响应的最小结构。 */
interface ComfyHistoryItem {
  status?: { status_str?: string };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
}

/** 短 HTTP 请求网络失败时最多重试三次，不限制模型执行总时长。 */
async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 500);
    }
  }
  throw lastError;
}

/** 有上限读取 JSON，防止异常历史响应占满 Worker 内存。 */
async function readJson<T>(response: Response, maxBytes: number): Promise<T> {
  const raw = (await readBuffer(response, maxBytes)).toString("utf8");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`ComfyUI 返回的 JSON 格式异常：HTTP ${response.status}`);
  }
}

/** 有上限读取二进制响应。 */
async function readBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("ComfyUI 响应超过大小限制");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error("ComfyUI 响应超过大小限制");
  return buffer;
}

/** 轮询等待。 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
