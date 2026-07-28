/**
 * 本文件负责 Grok 视频任务提交、状态轮询、参考图公网 URL 归一化和 MP4 下载。
 * 视频调用严格使用站点配置的超时与密钥，不把内部文件名或带用户信息的 URL 发送给上游。
 */
import type { DrawingAspectRatio, DrawingVideoResolution } from '@aiimage/shared-contracts';
import type { ApiSiteConfig } from '../site-selection/site-selection-types.js';
import { UpstreamApiCallError } from '../image-api/upstream-error.js';
import { sanitizeRawError, toChineseError } from '../image-api/upstream-error-utils.js';

/** 单个视频结果在 Worker 内存中的真实二进制表示。 */
export type UpstreamVideoResult = {
  /** 下载完成的 MP4 字节。 */
  videoBuffer: Buffer;
  /** 当前只接受 video/mp4。 */
  mimeType: 'video/mp4';
  /** 从提交到下载完成的总耗时。 */
  latencyMs: number;
  /** 上游视频请求 ID。 */
  requestId: string;
};

/** Grok 视频生成请求。 */
export type UpstreamVideoRequest = {
  /** 视频提示词。 */
  prompt: string;
  /** 文生视频或参考图视频。 */
  mode: 'text-to-video' | 'image-to-video';
  /** 站内短文件名或无用户信息的 HTTPS URL。 */
  sourceImageUrls?: string[];
  /** 视频时长，单位秒。 */
  duration: number;
  /** 视频画幅。 */
  aspectRatio: DrawingAspectRatio;
  /** 视频分辨率。 */
  resolution: DrawingVideoResolution;
};

/** 视频下载最大 100MB，和 media-service 原样写入上限保持一致。 */
const MAX_VIDEO_DOWNLOAD_BYTES = Number(process.env.VIDEO_DOWNLOAD_MAX_BYTES ?? String(100 * 1024 * 1024));
/** 视频状态轮询间隔；默认 2 秒，避免对上游造成高频压力。 */
const VIDEO_POLL_INTERVAL_MS = Math.max(500, Number(process.env.VIDEO_POLL_INTERVAL_MS ?? '2000'));

/** 调用 Grok 视频正式接口，轮询完成后从 content 端点下载 MP4。 */
export async function callUpstreamVideoApi(
  site: ApiSiteConfig,
  model: string,
  request: UpstreamVideoRequest,
  globalTimeoutMs?: number,
): Promise<UpstreamVideoResult> {
  const startedAt = Date.now();
  const timeoutMs = resolveVideoTimeoutMs(site.timeoutSec, globalTimeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const imageUrls = await normalizeReferenceImageUrls(request.sourceImageUrls ?? []);
    if (request.mode === 'image-to-video' && imageUrls.length === 0) {
      throw new UpstreamApiCallError('参考图视频至少需要 1 张参考图', 'grok_video_generation: missing reference image', false, 400);
    }
    if (imageUrls.length > 8) {
      throw new UpstreamApiCallError('视频模型最多接收 8 张参考图', `grok_video_generation: ${imageUrls.length} references exceed 8`, false, 400);
    }

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      duration: request.duration,
      aspect_ratio: request.aspectRatio,
      resolution: request.resolution,
    };
    if (imageUrls.length === 1) body.image = { url: imageUrls[0] };
    if (imageUrls.length > 1) body.images = imageUrls.map((url) => ({ url }));
    // Grok 视频接口仅接受模型、提示词、时长、画幅、分辨率和参考图；即使站点图片接口开启渠道亲和，也不能向此端点发送 prompt_cache_key。

    const baseUrl = site.baseUrl.replace(/\/+$/, '');
    const createResponse = await fetch(`${baseUrl}/videos/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${site.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const createBody = await readJsonResponse(createResponse);
    if (!createResponse.ok) throw buildVideoHttpError(createResponse, createBody, '视频任务提交失败');
    const requestId = readString(createBody, ['request_id', 'id', 'video_id']);
    if (!requestId) {
      throw new UpstreamApiCallError('上游未返回视频任务 ID', sanitizeRawError(JSON.stringify(createBody)), true, 502);
    }

    await waitForVideoCompletion(baseUrl, site.apiKey, requestId, controller.signal);
    const videoBuffer = await downloadVideoContent(baseUrl, site.apiKey, requestId, controller.signal);
    return { videoBuffer, mimeType: 'video/mp4', latencyMs: Date.now() - startedAt, requestId };
  } catch (error) {
    if (error instanceof UpstreamApiCallError) throw error;
    if (isAbortError(error)) {
      throw new UpstreamApiCallError('上游视频生成超时', `video_timeout_after_${timeoutMs}ms`, true, 504);
    }
    const raw = error instanceof Error ? error.message : String(error);
    throw new UpstreamApiCallError(toChineseError(raw, raw), sanitizeRawError(raw), true);
  } finally {
    clearTimeout(timer);
  }
}

/** 站点超时是权威值；缺失时使用全局值，最终兜底 180 秒。 */
export function resolveVideoTimeoutMs(siteTimeoutSec: number, globalTimeoutMs?: number): number {
  const siteMs = Number(siteTimeoutSec) * 1000;
  if (Number.isFinite(siteMs) && siteMs > 0) return Math.max(1000, Math.round(siteMs));
  const globalMs = Number(globalTimeoutMs);
  return Number.isFinite(globalMs) && globalMs > 0 ? Math.max(1000, Math.round(globalMs)) : 180_000;
}

/** 轮询 GET /videos/{request_id}，只在上游明确完成后进入下载。 */
async function waitForVideoCompletion(baseUrl: string, apiKey: string, requestId: string, signal: AbortSignal): Promise<void> {
  while (true) {
    await sleepWithSignal(VIDEO_POLL_INTERVAL_MS, signal);
    const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    const body = await readJsonResponse(response);
    if (!response.ok) throw buildVideoHttpError(response, body, '视频任务状态查询失败');
    const status = (readString(body, ['status', 'state']) ?? '').toLowerCase();
    // grok2api 当前正式响应使用 done；同时保留常见完成态，避免上游已产出视频但 Worker 持续轮询到超时。
    if (['completed', 'succeeded', 'success', 'ready', 'done'].includes(status)) return;
    if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(status)) {
      const message = readString(body, ['error', 'message', 'detail']) ?? '上游视频生成失败';
      const errorCode = readVideoErrorCode(body);
      // internal_error、结果 URL 丢失和服务拥塞属于上游临时故障，必须允许任务级重试或换站。
      const nonRetryable = ['invalid_request', 'content_policy', 'content_filter', 'safety_rejected', 'unsupported_parameter'].includes(errorCode);
      const retryable = !nonRetryable && status !== 'cancelled' && status !== 'canceled';
      throw new UpstreamApiCallError(
        toChineseError(message, message, retryable ? 502 : 422),
        sanitizeRawError(JSON.stringify(body)),
        retryable,
        retryable ? 502 : 422,
      );
    }
  }
}

/** 从 /content 下载 MP4，并同时校验响应头、大小和 ftyp 魔数。 */
async function downloadVideoContent(baseUrl: string, apiKey: string, requestId: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(requestId)}/content`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) {
    const body = await readJsonResponse(response);
    throw buildVideoHttpError(response, body, '视频文件下载失败');
  }
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > MAX_VIDEO_DOWNLOAD_BYTES) {
    throw new UpstreamApiCallError('上游视频文件超过下载上限', `video_content_length=${declaredSize}`, false, 413);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length <= 0 || buffer.length > MAX_VIDEO_DOWNLOAD_BYTES) {
    throw new UpstreamApiCallError('上游视频文件大小不正确', `video_size=${buffer.length}`, false, 502);
  }
  if (buffer.length < 12 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new UpstreamApiCallError('上游未返回有效 MP4 视频', sanitizeRawError(buffer.subarray(0, 256).toString('utf8')), true, 502);
  }
  return buffer;
}

/** 将站内参考图转换为生产 HTTPS 地址，外部地址必须无 username/password。 */
async function normalizeReferenceImageUrls(values: string[]): Promise<string[]> {
  const publicBase = resolvePublicMediaBaseUrl();
  return values.map((value, index) => {
    const trimmed = value.trim();
    const filename = extractSafeMediaFilename(trimmed);
    const resolved = filename ? new URL(`/images/${encodeURIComponent(filename)}`, publicBase) : new URL(trimmed);
    if (resolved.protocol !== 'https:' || resolved.username || resolved.password) {
      throw new UpstreamApiCallError(`第 ${index + 1} 张参考图必须使用无用户信息的 HTTPS URL`, `invalid_video_reference_url_${index + 1}`, false, 400);
    }
    return resolved.toString();
  });
}

/** 读取 Worker 对外媒体基址；生产兜底使用主站真实 HTTPS 域名。 */
function resolvePublicMediaBaseUrl(): URL {
  const raw = (process.env.PUBLIC_MEDIA_BASE_URL || process.env.APP_BASE_URL || 'https://www.xanime.ink').trim();
  const parsed = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new UpstreamApiCallError('视频参考图公网地址配置不正确', 'PUBLIC_MEDIA_BASE_URL must be credential-free HTTPS', false, 500);
  }
  return parsed;
}

/** 兼容纯短文件名、/images/name、/api/images/name 和站内完整 URL。 */
function extractSafeMediaFilename(value: string): string {
  let candidate = value.split(/[?#]/, 1)[0] ?? '';
  if (candidate.startsWith('/images/')) candidate = candidate.slice('/images/'.length);
  else if (candidate.startsWith('/api/images/')) candidate = candidate.slice('/api/images/'.length);
  else if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.pathname.startsWith('/images/')) candidate = parsed.pathname.slice('/images/'.length);
      else if (parsed.pathname.startsWith('/api/images/')) candidate = parsed.pathname.slice('/api/images/'.length);
      else return '';
    } catch { return ''; }
  }
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(candidate) && !candidate.includes('..') ? candidate : '';
}

/** 读取 JSON 响应；非 JSON 内容仍保留短文本供脱敏错误诊断。 */
async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { return { message: text.slice(0, 2000) }; }
}

/** 从顶层或 data/result/video 对象读取字符串字段，兼容常见 OpenAI 代理包装。 */
function readString(body: Record<string, unknown>, keys: string[]): string | undefined {
  const candidates: unknown[] = [body, body.data, body.result, body.video];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const message = (value as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) return message.trim();
      }
    }
  }
  return undefined;
}

/** 读取顶层或 error 对象的错误码，用于区分参数失败和可重试内部故障。 */
function readVideoErrorCode(body: Record<string, unknown>): string {
  const direct = body.code;
  if (typeof direct === 'string') return direct.trim().toLowerCase();
  const error = body.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code.trim().toLowerCase();
  }
  return '';
}

/** 将视频端点 HTTP 错误转换为统一可重试错误。 */
function buildVideoHttpError(response: Response, body: Record<string, unknown>, fallback: string): UpstreamApiCallError {
  const raw = sanitizeRawError(JSON.stringify(body));
  const message = readString(body, ['message', 'error', 'detail']) ?? fallback;
  const retryable = response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500;
  return new UpstreamApiCallError(toChineseError(message, fallback, response.status), raw, retryable, response.status);
}

/** 支持 AbortSignal 的轮询等待，任务超时后立即结束等待。 */
function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 判断 fetch/定时器是否因 AbortController 结束。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));
}
