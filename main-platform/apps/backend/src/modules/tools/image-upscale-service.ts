/** 本文件实现图片放大后端服务：校验用户图片并调用私有 GPU 超分服务。 */
import http from 'node:http';
import https from 'node:https';
import sharp from 'sharp';
import type {
  ImageUpscaleOutputFormat,
  ImageUpscaleResponseTransport,
  ImageUpscaleRunOptions,
  ImageUpscaleRunResponse,
  ImageUpscaleScale,
  ImageUpscaleSourceView,
  ImageUpscaleTimingView,
} from '@aiimage/shared-contracts';
import { logger } from '../../shared/logger.js';

/** 图片放大运行时配置；服务地址和密钥只允许后端读取。 */
export interface ImageUpscaleRuntimeConfig {
  /** 用户端是否开放图片放大入口。 */
  enabled: boolean;
  /** GPU 超分服务 Base URL。 */
  baseUrl: string;
  /** GPU 超分服务 API Key。 */
  apiKey: string;
  /** 默认超分模型名称。 */
  model: string;
  /** 允许用户选择的 GPU 模型名称。 */
  allowedModels: string[];
  /** 最大上传文件大小，单位 MB。 */
  maxFileSizeMb: number;
  /** 请求超时时间，单位秒。 */
  timeoutSec: number;
  /** 后台允许的放大倍率。 */
  allowedScales: ImageUpscaleScale[];
  /** 默认放大倍率。 */
  defaultScale: ImageUpscaleScale;
  /** 固定输出格式；生产只允许 WebP，旧后台配置不再影响返回格式。 */
  outputFormat: ImageUpscaleOutputFormat;
  /** 固定格式列表；仅保留给旧配置响应兼容。 */
  allowedOutputFormats: ImageUpscaleOutputFormat[];
  /** 允许的最大输出像素数，防止 GPU 服务被超大图拖死。 */
  maxOutputPixels: number;
  /** backend 同时转发到 GPU 服务的最大请求数。 */
  maxConcurrency: number;
  /** 超过并发时允许等待的最大请求数。 */
  queueMaxPending: number;
  /** 超过并发时单个请求允许等待的最大毫秒数。 */
  queueMaxWaitMs: number;
  /** GPU 结果返回链路；binary 直回图片，s3 上传对象存储，local 写入 GPU 本机暂存后返回 URL。 */
  responseTransport: ImageUpscaleResponseTransport;
}

/** GPU 服务实际需要的参数；保存图库等浏览器选项不能透传给上游。 */
type ImageUpscaleGpuRequestOptions = {
  /** 放大倍率。 */
  scale: ImageUpscaleScale;
  /** GPU 服务使用的模型。 */
  model: string;
  /** 输出格式；后端会强制归一为 webp。 */
  outputFormat: ImageUpscaleOutputFormat;
  /** 返回链路。 */
  responseTransport: ImageUpscaleResponseTransport;
  /** 是否必须拿到图片二进制；保存图库时需要二进制写入 media-service。 */
  requireBinary: boolean;
};

type ImageUpscaleS3Payload = {
  /** GPU 服务是否成功写入远端或本机暂存。 */
  ok?: boolean;
  /** 结果存储模式。 */
  storage?: string;
  /** 后端可直接读取的公开 URL。 */
  url?: string;
  /** 返回图片 MIME。 */
  mimeType?: string;
  /** GPU 实际使用模型。 */
  model?: string;
  /** 输出图片字节数。 */
  sizeBytes?: number;
  /** 输出宽度，单位像素。 */
  width?: number;
  /** 输出高度，单位像素。 */
  height?: number;
  /** GPU 推理和编码耗时。 */
  elapsedMs?: number;
  /** GPU 上传对象存储耗时。 */
  s3UploadMs?: number;
  /** GPU 写入本机暂存目录耗时。 */
  localWriteMs?: number;
};

/** 图片放大内部追踪选项；只用于 backend 任务进度和生产排障，不进入公开 API 契约。 */
export interface ImageUpscaleTraceOptions {
  /** 当前任务 ID 或请求 ID。 */
  traceId?: string;
  /** 外部取消信号；用户手动结束或任务硬超时时会中断 HTTP 读取。 */
  signal?: AbortSignal;
  /** 阶段变化回调，用于异步任务把真实阶段展示给用户。 */
  onStage?: (text: string) => void;
}

type ImageUpscaleGpuResponse = {
  /** GPU 返回的图片二进制；S3 直链展示时可以为空。 */
  buffer?: Buffer;
  /** S3 直链展示地址；只在对象存储链路下返回给前端。 */
  url?: string;
  /** GPU 返回的 MIME 类型。 */
  mimeType: string;
  /** GPU 实际使用模型。 */
  model: string;
  /** backend 到 GPU 的响应头耗时。 */
  headersMs: number;
  /** backend 读取 GPU 返回体耗时。 */
  downloadMs: number;
  /** GPU 服务响应头上报的推理和编码耗时。 */
  reportedMs?: number;
  /** GPU 服务响应上报的对象存储上传或本机暂存耗时。 */
  storageUploadMs?: number;
  /** GPU 或 backend 推断的输出宽度。 */
  width?: number;
  /** GPU 或 backend 推断的输出高度。 */
  height?: number;
  /** GPU 上报的输出字节数。 */
  sizeBytes?: number;
};

/** 图片放大业务错误，路由层据此映射 HTTP 状态码。 */
export class ImageUpscaleError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'ImageUpscaleError';
  }
}

/** 图片放大服务：只透传到真实 GPU 服务，不保存用户上传图片。 */
export class ImageUpscaleService {
  /** 校验图片和参数后调用 GPU 超分服务。 */
  async upscale(imageBuffer: Buffer, requestMimeType: string, config: ImageUpscaleRuntimeConfig, options: ImageUpscaleRunOptions, trace: ImageUpscaleTraceOptions = {}): Promise<ImageUpscaleRunResponse> {
    if (!config.enabled) throw new ImageUpscaleError('tool_disabled', '图片放大工具当前未开放', 403);
    if (!config.baseUrl) throw new ImageUpscaleError('config_missing', '后台未配置图片放大服务地址', 400);
    if (!config.apiKey) throw new ImageUpscaleError('config_missing', '后台未配置图片放大服务密钥', 400);

    const totalStartedAt = Date.now();
    const scale = normalizeScale(options.scale, config);
    const model = normalizeModel(options.model, config);
    const outputFormat = normalizeOutputFormat(options.outputFormat, config);
    trace.onStage?.('正在校验图片');
    const prepareStartedAt = Date.now();
    const prepared = await prepareImageForUpscale(imageBuffer, requestMimeType, config.maxFileSizeMb, scale, config.maxOutputPixels);
    const prepareMs = Date.now() - prepareStartedAt;
    trace.onStage?.('正在上传到 GPU');
    const output = await callUpscaleService(config, prepared.buffer, prepared.mimeType, { scale, model, outputFormat, responseTransport: config.responseTransport, requireBinary: shouldRequireBinary(config.responseTransport, options.saveToLibrary === true) }, trace);
    let outputMeta = { width: output.width ?? prepared.source.width * scale, height: output.height ?? prepared.source.height * scale };
    let metadataMs = 0;
    if (output.buffer) {
      trace.onStage?.('正在识别放大结果');
      const metadataStartedAt = Date.now();
      outputMeta = await readOutputMetadata(output.buffer);
      metadataMs = Date.now() - metadataStartedAt;
    }
    trace.onStage?.('正在整理放大结果');
    const base64StartedAt = Date.now();
    const base64 = output.buffer?.toString('base64');
    const base64Ms = Date.now() - base64StartedAt;
    const elapsedMs = Date.now() - totalStartedAt;
    const timings: ImageUpscaleTimingView = {
      prepareMs,
      upstreamHeadersMs: output.headersMs,
      upstreamDownloadMs: output.downloadMs,
      upstreamReportedMs: output.reportedMs,
      upstreamStorageUploadMs: output.storageUploadMs,
      metadataMs,
      base64Ms,
      totalMs: elapsedMs,
    };
    logger.info({
      traceId: trace.traceId,
      scale,
      model: output.model || model,
      outputFormat,
      prepareMs,
      upstreamHeadersMs: output.headersMs,
      upstreamDownloadMs: output.downloadMs,
      upstreamReportedMs: output.reportedMs,
      upstreamStorageUploadMs: output.storageUploadMs,
      metadataMs,
      base64Ms,
      totalMs: elapsedMs,
      outputBytes: output.buffer?.length ?? output.sizeBytes,
      remoteUrl: output.url ? true : undefined,
    }, '图片放大链路耗时');
    return {
      source: prepared.source,
      image: {
        mimeType: output.mimeType,
        base64,
        url: output.url,
        filename: buildFilename(output.mimeType, scale),
        sizeBytes: output.buffer?.length ?? output.sizeBytes ?? 0,
        width: outputMeta.width,
        height: outputMeta.height,
      },
      scale,
      model: output.model || model,
      elapsedMs,
      timings,
      processedAt: new Date().toISOString(),
    };
  }
}

/** 校验真实图片并规整为 GPU 服务稳定可读的 PNG/JPEG。 */
async function prepareImageForUpscale(imageBuffer: Buffer, requestMimeType: string, maxFileSizeMb: number, scale: ImageUpscaleScale, maxOutputPixels: number): Promise<{ buffer: Buffer; mimeType: string; source: ImageUpscaleSourceView }> {
  if (imageBuffer.length <= 0) throw new ImageUpscaleError('invalid_image', '请上传图片文件');
  const maxBytes = Math.max(1, Math.min(200, maxFileSizeMb)) * 1024 * 1024;
  if (imageBuffer.length > maxBytes) throw new ImageUpscaleError('payload_too_large', `图片大小不能超过 ${maxFileSizeMb}MB`, 413);
  if (!requestMimeType.startsWith('image/')) throw new ImageUpscaleError('invalid_image', '请上传图片文件');

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(imageBuffer, { failOn: 'error', limitInputPixels: 64_000_000 }).metadata();
  } catch {
    throw new ImageUpscaleError('invalid_image', '图片文件无法识别');
  }
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);
  if (!width || !height) throw new ImageUpscaleError('invalid_image', '图片尺寸不正确');
  if (width * height > 32_000_000) throw new ImageUpscaleError('invalid_image', '源图像素过大，请缩小后再上传');
  if (width * height * scale * scale > maxOutputPixels) {
    throw new ImageUpscaleError('output_too_large', `当前倍率输出像素过大，请降低倍率或缩小源图`, 400);
  }

  const normalizedMime = metadata.format === 'png' ? 'image/png' : 'image/jpeg';
  const pipeline = sharp(imageBuffer, { failOn: 'error', limitInputPixels: 64_000_000 }).rotate();
  const output = normalizedMime === 'image/png'
    ? await pipeline.png({ compressionLevel: 6 }).toBuffer()
    : await pipeline.jpeg({ quality: 94, mozjpeg: true }).toBuffer();
  return { buffer: output, mimeType: normalizedMime, source: { mimeType: normalizedMime, width, height, sizeBytes: imageBuffer.length } };
}

/** 调用私有 GPU 服务，失败时把上游错误转换为用户可读文案。 */
async function callUpscaleService(
  config: ImageUpscaleRuntimeConfig,
  imageBuffer: Buffer,
  mimeType: string,
  options: ImageUpscaleGpuRequestOptions,
  trace: ImageUpscaleTraceOptions,
): Promise<ImageUpscaleGpuResponse> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/v1/upscale`;
  const controller = new AbortController();
  const timeoutMs = Math.max(5, config.timeoutSec) * 1000;
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  try {
    if (trace.signal?.aborted) throw new ImageUpscaleError('request_cancelled', '图片放大任务已结束', 409);
    trace.signal?.addEventListener('abort', abortFromParent, { once: true });
    const form = new FormData();
    const fileBytes = imageBuffer.buffer.slice(imageBuffer.byteOffset, imageBuffer.byteOffset + imageBuffer.byteLength) as ArrayBuffer;
    form.set('file', new Blob([fileBytes], { type: mimeType }), mimeType === 'image/png' ? 'source.png' : 'source.jpg');
    form.set('scale', String(options.scale));
    form.set('model', options.model);
    form.set('output_format', options.outputFormat);
    form.set('response_mode', options.responseTransport);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': config.apiKey },
      body: form,
      signal: controller.signal,
    });
    const headersMs = Date.now() - startedAt;
    const contentType = String(response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() || 'image/png';
    const model = String(response.headers.get('x-upscale-model') ?? options.model).trim() || options.model;
    const contentLength = Number.parseInt(String(response.headers.get('content-length') ?? '0'), 10) || undefined;
    const reportedMs = Number.parseInt(String(response.headers.get('x-upscale-elapsed-ms') ?? ''), 10);
    logger.info({
      traceId: trace.traceId,
      statusCode: response.status,
      contentType,
      contentLength,
      headersMs,
      upstreamReportedMs: Number.isFinite(reportedMs) ? reportedMs : undefined,
      model,
    }, '图片放大 GPU 响应头已收到');
    trace.onStage?.('正在接收放大结果');
    const bodyStartedAt = Date.now();
    const body = Buffer.from(await response.arrayBuffer());
    let downloadMs = Date.now() - bodyStartedAt;
    logger.info({
      traceId: trace.traceId,
      statusCode: response.status,
      bytes: body.length,
      downloadMs,
      totalMs: Date.now() - startedAt,
    }, '图片放大 GPU 响应体已读取');
    if (!response.ok) throw new ImageUpscaleError('upstream_failed', readUpstreamError(response.status, contentType, body), response.status >= 500 ? 502 : 400);
    if (contentType.includes('application/json')) {
      return await readStoredGpuResponse(body, model, headersMs, reportedMs, downloadMs, options, trace);
    }
    if (!contentType.startsWith('image/')) throw new ImageUpscaleError('upstream_invalid', '图片放大服务返回了非图片内容', 502);
    return { buffer: body, mimeType: contentType, model, headersMs, downloadMs, reportedMs: Number.isFinite(reportedMs) ? reportedMs : undefined };
  } catch (error) {
    if (error instanceof ImageUpscaleError) throw error;
    const message = error instanceof Error && error.name === 'AbortError' ? '图片放大请求超时' : '图片放大服务无法连接';
    throw new ImageUpscaleError('upstream_unavailable', message, 502);
  } finally {
    trace.signal?.removeEventListener('abort', abortFromParent);
    clearTimeout(timeout);
  }
}

/** 读取 GPU 返回的 JSON，并按需要下载对象存储或本机暂存图片；凭证只存在 GPU 服务器。 */
async function readStoredGpuResponse(
  body: Buffer,
  fallbackModel: string,
  headersMs: number,
  reportedMs: number,
  jsonReadMs: number,
  options: ImageUpscaleGpuRequestOptions,
  trace: ImageUpscaleTraceOptions,
): Promise<ImageUpscaleGpuResponse> {
  let payload: ImageUpscaleS3Payload;
  try {
    payload = JSON.parse(body.toString('utf8')) as ImageUpscaleS3Payload;
  } catch {
    throw new ImageUpscaleError('upstream_invalid', '图片放大服务返回的 S3 信息无法解析', 502);
  }
  const storage = typeof payload.storage === 'string' ? payload.storage.trim().toLowerCase() : '';
  if (payload.ok !== true || (storage !== 's3' && storage !== 'local') || !payload.url) {
    throw new ImageUpscaleError('upstream_invalid', '图片放大服务返回的暂存信息不完整', 502);
  }
  const url = normalizeGpuResultUrl(payload.url, storage);
  const outputContentType = String(payload.mimeType ?? '').split(';', 1)[0]?.trim().toLowerCase() || `image/${options.outputFormat}`;
  const payloadReportedMs = Number(payload.elapsedMs);
  const storageUploadMs = storage === 'local' ? Number(payload.localWriteMs) : Number(payload.s3UploadMs);
  const baseResponse = {
    mimeType: outputContentType,
    model: typeof payload.model === 'string' && payload.model ? payload.model : fallbackModel,
    headersMs,
    reportedMs: Number.isFinite(payloadReportedMs) ? payloadReportedMs : Number.isFinite(reportedMs) ? reportedMs : undefined,
    storageUploadMs: Number.isFinite(storageUploadMs) ? storageUploadMs : undefined,
    width: Number.isFinite(Number(payload.width)) && Number(payload.width) > 0 ? Number(payload.width) : undefined,
    height: Number.isFinite(Number(payload.height)) && Number(payload.height) > 0 ? Number(payload.height) : undefined,
    sizeBytes: Number.isFinite(Number(payload.sizeBytes)) && Number(payload.sizeBytes) >= 0 ? Number(payload.sizeBytes) : undefined,
  };
  if (!options.requireBinary) {
    logger.info({
      traceId: trace.traceId,
      storage,
      contentType: outputContentType,
      bytes: payload.sizeBytes,
      storageUploadMs: Number.isFinite(storageUploadMs) ? storageUploadMs : undefined,
      remoteUrl: true,
    }, '图片放大暂存结果使用直链返回');
    return {
      ...baseResponse,
      url,
      downloadMs: jsonReadMs,
    };
  }
  trace.onStage?.('正在从暂存地址接收放大结果');
  const downloadStartedAt = Date.now();
  const downloaded = await downloadGpuResultUrl(url, { signal: trace.signal });
  const downloadedContentType = String(downloaded.contentType ?? payload.mimeType ?? '').split(';', 1)[0]?.trim().toLowerCase() || outputContentType;
  const outputBuffer = downloaded.buffer;
  const downloadMs = Date.now() - downloadStartedAt;
  logger.info({
    traceId: trace.traceId,
    storage,
    statusCode: downloaded.statusCode,
    contentType: downloadedContentType,
    bytes: outputBuffer.length,
    remoteDownloadMs: downloadMs,
    storageUploadMs: Number.isFinite(storageUploadMs) ? storageUploadMs : undefined,
  }, '图片放大暂存结果已读取');
  if (downloaded.statusCode < 200 || downloaded.statusCode >= 300) throw new ImageUpscaleError('upstream_failed', `图片放大结果暂存读取失败：HTTP ${downloaded.statusCode}`, 502);
  if (!downloadedContentType.startsWith('image/')) throw new ImageUpscaleError('upstream_invalid', '暂存地址返回了非图片内容', 502);
  return {
    ...baseResponse,
    buffer: outputBuffer,
    mimeType: downloadedContentType,
    downloadMs: jsonReadMs + downloadMs,
  };
}

/** Node 原生图片下载选项；用于限制超时和响应体大小。 */
export type ImageUpscaleRemoteDownloadOptions = {
  /** 上层任务取消信号。 */
  signal?: AbortSignal;
  /** 最大响应字节数，避免异常暂存地址耗尽内存。 */
  maxBytes?: number;
  /** 无数据活动超时毫秒数。 */
  timeoutMs?: number;
};

/** 使用 Node 原生 HTTP(S) 读取远端结果，避开 undici 对部分存储域名的连接超时问题。 */
export function downloadGpuResultUrl(url: string, options: ImageUpscaleRemoteDownloadOptions = {}): Promise<{ statusCode: number; contentType: string; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const maxBytes = Math.max(1, options.maxBytes ?? 220 * 1024 * 1024);
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 60_000);
    const request = client.get(url, { family: 4, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      const contentLength = Number.parseInt(String(response.headers['content-length'] ?? '0'), 10);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.destroy(new ImageUpscaleError('upstream_invalid', '图片放大结果超过允许保存大小', 413));
        return;
      }
      response.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.length;
        if (receivedBytes > maxBytes) {
          response.destroy(new ImageUpscaleError('upstream_invalid', '图片放大结果超过允许保存大小', 413));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? ''),
          buffer: Buffer.concat(chunks),
        });
      });
      response.on('error', reject);
    });
    const abort = () => {
      request.destroy(new ImageUpscaleError('request_cancelled', '图片放大任务已结束', 409));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    request.on('timeout', () => {
      request.destroy(new ImageUpscaleError('upstream_unavailable', '图片放大结果暂存读取超时', 502));
    });
    request.on('error', (error) => {
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    request.on('close', () => {
      options.signal?.removeEventListener('abort', abort);
    });
  });
}

/** 读取输出图尺寸，确保 GPU 服务没有返回损坏图片。 */
async function readOutputMetadata(buffer: Buffer): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: 256_000_000 }).metadata();
    const width = Number(metadata.width ?? 0);
    const height = Number(metadata.height ?? 0);
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // 上游返回损坏图片时统一在下方抛业务错误。
  }
  throw new ImageUpscaleError('upstream_invalid', '图片放大服务返回的图片无法识别', 502);
}

/** 把后台倍率配置收敛到安全范围。 */
export function parseUpscaleScales(value: string | undefined): ImageUpscaleScale[] {
  const scales = String(value ?? '2,4')
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item): item is ImageUpscaleScale => item === 2 || item === 3 || item === 4);
  return Array.from(new Set(scales)).sort((a, b) => a - b);
}

/** 读取后台默认倍率，非法时回退允许列表第一项。 */
export function parseUpscaleScale(value: string | undefined, fallback: ImageUpscaleScale): ImageUpscaleScale {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return parsed === 2 || parsed === 3 || parsed === 4 ? parsed : fallback;
}

/** 读取后台输出格式；当前生产固定 WebP，旧 PNG 配置会被忽略。 */
export function parseUpscaleOutputFormat(_value: string | undefined): ImageUpscaleOutputFormat {
  return 'webp';
}

/** 解析后台配置的可选输出格式白名单；当前生产固定 WebP，不再提供格式选择。 */
export function parseUpscaleOutputFormats(_value: string | undefined): ImageUpscaleOutputFormat[] {
  return ['webp'];
}

/** 解析后台配置的模型白名单；模型名只允许常见文件/模型 ID 字符。 */
export function parseUpscaleModels(value: string | undefined, fallback: string): string[] {
  const models = String(value ?? fallback)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^[a-zA-Z0-9._:-]{1,128}$/.test(item));
  return Array.from(new Set(models.length > 0 ? models : [fallback]));
}

function normalizeScale(value: unknown, config: ImageUpscaleRuntimeConfig): ImageUpscaleScale {
  const scale = parseUpscaleScale(String(value ?? ''), config.defaultScale);
  return config.allowedScales.includes(scale) ? scale : config.defaultScale;
}

function normalizeModel(value: unknown, config: ImageUpscaleRuntimeConfig): string {
  const requested = typeof value === 'string' ? value.trim() : '';
  const fallback = config.allowedModels.includes(config.model) ? config.model : (config.allowedModels[0] ?? config.model);
  return requested && config.allowedModels.includes(requested) ? requested : fallback;
}

function normalizeOutputFormat(_value: unknown, _config: ImageUpscaleRuntimeConfig): ImageUpscaleOutputFormat {
  // 输出格式属于跨 GPU/浏览器/图库链路约束，必须在后端强制为 WebP，不能信任旧客户端或旧后台配置。
  return 'webp';
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function normalizeGpuResultUrl(value: string, storage: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(storage === 'local' && url.protocol === 'http:')) throw new ImageUpscaleError('upstream_invalid', '图片放大结果 URL 协议不安全', 502);
  if (url.href.length > 2048) throw new ImageUpscaleError('upstream_invalid', '图片放大结果 URL 过长', 502);
  return url.href;
}

/** 把 local 暂存公网地址转换为 backend 到 GPU 的直连下载地址；仅保留受控文件路径。 */
export function resolveLocalGpuResultDownloadUrl(publicUrl: string, gpuBaseUrl: string): string {
  const publicParsed = new URL(publicUrl);
  if (!publicParsed.pathname.startsWith('/v1/upscale-files/')) {
    throw new ImageUpscaleError('upstream_invalid', '图片放大暂存地址路径不正确', 502);
  }
  const gpuBase = new URL(normalizeBaseUrl(gpuBaseUrl));
  if (gpuBase.protocol !== 'http:' && gpuBase.protocol !== 'https:') {
    throw new ImageUpscaleError('upstream_invalid', '图片放大服务地址协议不正确', 502);
  }
  return `${gpuBase.protocol}//${gpuBase.host}${publicParsed.pathname}${publicParsed.search}`;
}

function readUpstreamError(status: number, contentType: string, body: Buffer): string {
  const text = body.toString('utf8').slice(0, 500);
  if (contentType.includes('application/json')) {
    try {
      const data = JSON.parse(text) as { detail?: unknown; message?: unknown };
      const message = String(data.detail ?? data.message ?? '').trim();
      if (message) return message;
    } catch {
      // JSON 解析失败时回退到状态码文案。
    }
  }
  return text.trim() || `图片放大服务返回异常：${status}`;
}

function buildFilename(mimeType: string, scale: ImageUpscaleScale): string {
  const ext = mimeType.includes('webp') ? 'webp' : mimeType.includes('jpeg') ? 'jpg' : 'png';
  return `upscaled-${scale}x.${ext}`;
}

/** 解析图片放大返回链路，非法值回退本机二进制直回。 */
export function parseUpscaleResponseTransport(value: string | undefined): ImageUpscaleResponseTransport {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 's3') return 's3';
  if (normalized === 'local') return 'local';
  return 'binary';
}

/** 保存图库在 binary/s3 下需要同步二进制；local 链路改由后台异步保存，先把 GPU 暂存 URL 返回给用户。 */
function shouldRequireBinary(transport: ImageUpscaleResponseTransport, saveToLibrary: boolean): boolean {
  return saveToLibrary && transport !== 'local';
}
