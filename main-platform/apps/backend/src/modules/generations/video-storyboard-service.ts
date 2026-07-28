/** 本文件负责复用图片反推工具的真实多模态端点，为视频任务重新设计分镜提示词。 */
import type { PrismaClient } from '@prisma/client';

type VideoStoryboardInput = {
  /** 用户原始提示词，模型必须基于其意图重新设计而不是简单扩写。 */
  prompt: string;
  /** 站内或外部参考图，顺序具有业务语义。 */
  sourceImageUrls: string[];
  /** 视频时长，单位秒。 */
  duration: number;
  /** 视频画幅。 */
  aspectRatio: string;
  /** 视频分辨率档位。 */
  resolution: string;
  /** 最终提示词字符上限，必须服从后台绘图配置。 */
  maxPromptLength: number;
};

type VideoStoryboardRuntimeConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSec: number;
  maxFileSizeMb: number;
};

type ChatCompletionBody = {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: string };
};

/** 视频分镜业务错误；调用方必须在扣费和建任务前返回，不得静默退回原提示词。 */
export class VideoStoryboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoStoryboardError';
  }
}

/** 视频分镜服务只调用真实反推端点，不保存图片、不创建反推历史任务。 */
export class VideoStoryboardService {
  constructor(private readonly prisma: PrismaClient) {}

  /** 分析提示词、视频参数和全部参考图，返回重新设计后的单一视频生成提示词。 */
  async redesign(input: VideoStoryboardInput): Promise<string> {
    const config = await this.readRuntimeConfig();
    assertRuntimeConfig(config);
    const imageParts = await Promise.all(input.sourceImageUrls.slice(0, 8).map((url, index) => buildImagePart(url, index, config)));
    const payload = {
      model: config.model,
      ...(config.model === 'gpt-5.6-sol' ? { reasoning_effort: 'medium' } : {}),
      max_tokens: 1800,
      messages: [
        { role: 'system', content: buildStoryboardSystemPrompt() },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildStoryboardUserPrompt(input) },
            ...imageParts.flat(),
          ],
        },
      ],
    };
    const content = await requestStoryboardCompletion(config, payload);
    const prompt = parseStoryboardPrompt(content);
    return fitPromptLength(prompt, input.maxPromptLength);
  }

  /** 读取图片反推工具的端点、密钥和模型配置；不读取反推系统提示词。 */
  private async readRuntimeConfig(): Promise<VideoStoryboardRuntimeConfig> {
    const keys = [
      'tools_image_reverse_enabled',
      'tools_image_reverse_base_url',
      'tools_image_reverse_api_key',
      'tools_image_reverse_model',
      'tools_image_reverse_timeout_sec',
      'tools_image_reverse_max_file_size_mb',
    ];
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: keys } },
      select: { key: true, value: true },
    });
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      enabled: values.tools_image_reverse_enabled === 'true',
      baseUrl: String(values.tools_image_reverse_base_url ?? '').trim(),
      apiKey: String(values.tools_image_reverse_api_key ?? '').trim(),
      model: String(values.tools_image_reverse_model ?? 'gpt-5.6-sol').trim() || 'gpt-5.6-sol',
      // 生成提交必须在反向代理请求窗口内完成；反推页面自身的长超时不直接照搬到同步分镜。
      timeoutSec: clampInteger(values.tools_image_reverse_timeout_sec, 60, 10, 75),
      maxFileSizeMb: clampInteger(values.tools_image_reverse_max_file_size_mb, 20, 1, 100),
    };
  }
}

/** 分镜提示词独立于反推页面 schema，只输出视频模型需要的时间线和运动设计。 */
function buildStoryboardSystemPrompt(): string {
  return [
    '你是视频生成分镜导演。你的任务是重新设计一条可直接提交给视频生成模型的最终提示词。',
    '必须同时理解用户原始意图、全部参考图的可见主体与画风、视频时长、画幅和分辨率。',
    '禁止调用或复用图片反推页面的 drawingPrompt、positivePrompt、negativePrompt 或其他绘图 Prompt；必须从视觉事实和用户目标重新组织视频语言。',
    '最终视频提示词必须明确时间推进或镜头段落、镜头运动、主体动作、表情与物理连续性、背景运动、光影变化、参考图身份与服饰保持项，以及禁止突变、闪烁、形变、额外肢体和无关主体。',
    '短视频应控制镜头数量，避免在有限时长内塞入过多切镜；优先连续、可执行、稳定的运镜和动作。',
    '不得改变用户明确指定的角色、动作、场景、风格或镜头目标；参考图之间有不同主体时必须按输入顺序说明各自用途。',
    '只返回严格 JSON，不要 Markdown，不要解释。结构：{"videoPrompt":"重新设计后的完整视频提示词"}。',
  ].join('\n');
}

/** 把真实任务参数写入分镜请求，避免模型自行猜测时长和画幅。 */
function buildStoryboardUserPrompt(input: VideoStoryboardInput): string {
  return [
    `用户原始提示词：${input.prompt.trim()}`,
    `视频规格：${input.duration} 秒，画幅 ${input.aspectRatio}，分辨率 ${input.resolution}。`,
    `参考图数量：${input.sourceImageUrls.length}。${input.sourceImageUrls.length > 0 ? '参考图按随后出现顺序编号，必须逐张观察并保持主体一致性。' : '本任务没有参考图，请仅依据文本设计。'}`,
    `最终 videoPrompt 不得超过 ${Math.max(100, input.maxPromptLength)} 个字符；直接给出可执行的完整分镜提示词。`,
  ].join('\n');
}

/** 为单张参考图构建编号文本和 OpenAI 兼容 image_url 内容。 */
async function buildImagePart(url: string, index: number, config: VideoStoryboardRuntimeConfig): Promise<Array<Record<string, unknown>>> {
  const imageUrl = await resolveStoryboardImageUrl(url, config);
  return [
    { type: 'text', text: `参考图 ${index + 1}：` },
    { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
  ];
}

/** 站内参考图读取真实媒体内容转 data URL；外部 HTTPS 和合法 data URL 原样交给多模态端点。 */
async function resolveStoryboardImageUrl(value: string, config: VideoStoryboardRuntimeConfig): Promise<string> {
  const source = value.trim();
  if (/^data:image\//i.test(source)) return source;
  if (/^https:\/\//i.test(source)) return source;
  const filename = extractStationFilename(source);
  if (!filename) throw new VideoStoryboardError('分镜设计读取参考图失败，请重新上传参考图');
  const mediaBaseUrl = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
  let response: Response;
  try {
    response = await fetch(`${mediaBaseUrl}/media/files/${encodeURIComponent(filename)}`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new VideoStoryboardError('分镜设计读取参考图超时，请重新提交');
  }
  if (!response.ok) throw new VideoStoryboardError('分镜设计读取参考图失败，请重新上传参考图');
  const mimeType = String(response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (!mimeType?.startsWith('image/')) throw new VideoStoryboardError('分镜设计读取到的参考文件不是图片');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length <= 0 || buffer.length > config.maxFileSizeMb * 1024 * 1024) {
    throw new VideoStoryboardError(`分镜设计参考图不能超过 ${config.maxFileSizeMb}MB`);
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/** 请求反推配置的 OpenAI 兼容端点；不支持 JSON mode 时仅移除该兼容参数重试。 */
async function requestStoryboardCompletion(config: VideoStoryboardRuntimeConfig, payload: Record<string, unknown>): Promise<string> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
  const first = await sendStoryboardRequest(url, config, { ...payload, response_format: { type: 'json_object' } });
  const firstText = await first.text();
  if (first.ok) return readChatContent(firstText);
  if (isResponseFormatUnsupported(firstText)) {
    const retry = await sendStoryboardRequest(url, config, payload);
    const retryText = await retry.text();
    if (retry.ok) return readChatContent(retryText);
  }
  throw new VideoStoryboardError('分镜设计上游调用失败，请稍后重试');
}

/** 发送一次真实分镜请求，超时上限独立限制为 75 秒，避免占住生成提交连接。 */
async function sendStoryboardRequest(url: string, config: VideoStoryboardRuntimeConfig, payload: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutSec * 1000),
    });
  } catch {
    throw new VideoStoryboardError('分镜设计请求超时，请稍后重试');
  }
}

/** 从 OpenAI 兼容响应读取文本内容，兼容字符串和文本分片数组。 */
function readChatContent(text: string): string {
  let body: ChatCompletionBody;
  try {
    body = JSON.parse(text) as ChatCompletionBody;
  } catch {
    throw new VideoStoryboardError('分镜设计上游返回格式不正确');
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const merged = content.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const textPart = (item as { text?: unknown }).text;
      return typeof textPart === 'string' ? [textPart] : [];
    }).join('\n').trim();
    if (merged) return merged;
  }
  throw new VideoStoryboardError('分镜设计上游未返回提示词');
}

/** 解析严格 JSON；端点偶尔附加代码围栏时只剥离围栏，不接受缺失 videoPrompt 的结果。 */
function parseStoryboardPrompt(content: string): string {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new VideoStoryboardError('分镜设计结果缺少视频提示词');
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { videoPrompt?: unknown };
    const prompt = typeof parsed.videoPrompt === 'string' ? parsed.videoPrompt.trim() : '';
    if (prompt.length < 20) throw new VideoStoryboardError('分镜设计结果过短，请重新提交');
    return prompt;
  } catch (error) {
    if (error instanceof VideoStoryboardError) throw error;
    throw new VideoStoryboardError('分镜设计结果格式不正确，请重新提交');
  }
}

/** 在后台提示词上限内尽量按完整句截断，避免上游超长输出绕过创建校验。 */
function fitPromptLength(prompt: string, maxLength: number): string {
  const limit = Math.max(100, Math.min(50_000, Math.trunc(maxLength) || 5000));
  if (prompt.length <= limit) return prompt;
  const prefix = prompt.slice(0, limit);
  const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('.'), prefix.lastIndexOf('；'), prefix.lastIndexOf(';'));
  return (boundary >= Math.floor(limit * 0.7) ? prefix.slice(0, boundary + 1) : prefix).trim();
}

/** 校验分镜所需的反推运行时配置，不允许用空配置伪造成功。 */
function assertRuntimeConfig(config: VideoStoryboardRuntimeConfig): void {
  if (!config.enabled) throw new VideoStoryboardError('图片反推服务未开启，当前模型的分镜设计不可用');
  if (!config.baseUrl || !config.apiKey || !config.model) throw new VideoStoryboardError('图片反推 API 配置不完整，当前模型的分镜设计不可用');
}

/** 从站内图片路径提取安全短文件名。 */
function extractStationFilename(value: string): string | undefined {
  const clean = value.split(/[?#]/, 1)[0]?.trim() ?? '';
  const raw = clean.startsWith('/images/')
    ? clean.slice('/images/'.length)
    : clean.startsWith('/api/images/')
      ? clean.slice('/api/images/'.length)
      : clean.includes('/')
        ? ''
        : clean;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* 非法编码会在文件名正则处拒绝。 */ }
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(decoded) && !decoded.includes('..') ? decoded : undefined;
}

/** 归一化 OpenAI 兼容 API Base URL，兼容后台填写到 /v1 或根路径。 */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
}

/** 判断端点是否仅因不支持 response_format 而失败。 */
function isResponseFormatUnsupported(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('response_format') || lower.includes('json_object') || lower.includes('unsupported parameter');
}

/** 读取有界整数配置。 */
function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
