/**
 * 本文件注册 media-service 的本地媒体接口。
 *
 * 当前生产存储链路只有本地文件系统：上传写入本地、读取只读本地、缩略图写入本地。
 * 不再注册对象存储归档、远端回源或“已归档副本删除”接口，避免任何 S3/OSS 回退路径。
 */
import { ApiErrorCode, type MediaStorageStatsResponse } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, createHealthRoutes, type Route } from '@aiimage/core-utils';
import { createStorageService, isLocalStore, type IStorageService } from '../file-store/storage-factory.js';
import { ThumbnailService } from '../thumbnail/thumbnail-service.js';
import { compressImageToLimit, normalizeReferenceImageToPngLimit, normalizeUploadImageBuffer } from '../reference-assets/reference-image-compression-service.js';
import { getMediaRuntimeConfig } from '../config/media-runtime-config.js';
import type { IncomingMessage } from 'node:http';
import { VideoPosterService } from '../video/video-poster-service.js';

/** 创建 media-service 的所有 HTTP 路由。 */
export function createMediaRoutes(): Route[] {
  const store = createStorageService();
  const thumbnailService = new ThumbnailService(store as IStorageService);
  const videoPosterService = new VideoPosterService();

  return [
    ...createHealthRoutes({ service: 'media-service', version: '3.0.0' }),

    /**
     * POST /media/upload
     * 上传图片数据，返回短文件名和站内访问 URL。生成原图不压缩；ref_ 参考图默认压缩到 3MB 内。
     */
    {
      method: 'POST',
      path: '/media/upload',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const uploadAbortController = new AbortController();
        // backend 或 Bot 超时断开后取消尚未开始的排队转码，原图片仍保留在调用端并可继续重试。
        const abortQueuedUpload = () => {
          if (!res.writableEnded) uploadAbortController.abort();
        };
        res.once('close', abortQueuedUpload);
        try {
          const mediaConfig = await getMediaRuntimeConfig();
          const uploadInput = await readUploadImageInput(req, mediaConfig.imageMaxFileSizeBytes);
          if (uploadInput.buffer.length === 0) {
            return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少图片数据' });
          }
          const isReferenceImage = uploadInput.prefix.startsWith('ref_');
          // 关键分支：所有 ref_ 参考图固定转为 PNG；img_ 最终原图继续保持原有格式和字节策略。
          const maxBytes = uploadInput.maxBytes ?? (isReferenceImage ? mediaConfig.referenceTaskInputMaxBytes : undefined);
          const prepared = isReferenceImage
            ? await normalizeReferenceImageToPngLimit(uploadInput.buffer, {
              maxBytes: maxBytes ?? mediaConfig.referenceTaskInputMaxBytes,
              mimeType: uploadInput.mimeType,
              priority: 'interactive',
              maxResolution: mediaConfig.imageMaxResolution,
              signal: uploadAbortController.signal,
            })
            : maxBytes
            ? await compressImageToLimit(uploadInput.buffer, {
              maxBytes,
              mimeType: uploadInput.mimeType,
              priority: 'interactive',
              maxResolution: mediaConfig.imageMaxResolution,
            })
            : await (async () => {
              const normalizedInput = await normalizeUploadImageBuffer(uploadInput.buffer, uploadInput.mimeType, {
                maxResolution: mediaConfig.imageMaxResolution,
              });
              return {
                buffer: normalizedInput.buffer,
                mimeType: normalizedInput.mimeType,
                originalSize: normalizedInput.originalSize,
                outputSize: normalizedInput.buffer.length,
                compressed: normalizedInput.converted,
              };
            })();

          const filename = await store.writeImage(prepared.buffer, prepared.mimeType, uploadInput.prefix, {
            maxFileSizeBytes: mediaConfig.imageMaxFileSizeBytes,
          });
          return sendJson(res, 200, {
            ok: true,
            data: {
              filename,
              url: `/api/images/${filename}`,
              size: prepared.outputSize,
              originalSize: prepared.originalSize,
              compressed: prepared.compressed,
              mimeType: prepared.mimeType,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '图片上传失败';
          if (message === '请求体过大' || message.includes('文件大小超过限制')) {
            return sendJson(res, 413, { ok: false, code: ApiErrorCode.BadRequest, message });
          }
          if (message.includes('图片格式') || message.includes('分辨率过大') || message.includes('不支持')) {
            return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message });
          }
          if (message.includes('图片处理队列繁忙')) {
            return sendJson(res, 429, { ok: false, code: ApiErrorCode.RateLimited, message });
          }
          return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message });
        } finally {
          res.off('close', abortQueuedUpload);
        }
      },
    },

    /**
     * POST /media/upload-video
     * 原样保存 Worker 下载的 MP4，并同步生成首帧 WebP 封面供图库静态加载。
     */
    {
      method: 'POST',
      path: '/media/upload-video',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        try {
          const mediaConfig = await getMediaRuntimeConfig();
          const maxBytes = normalizeVideoMaxBytes(process.env.MEDIA_VIDEO_MAX_FILE_SIZE_BYTES);
          const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
          if (contentType !== 'video/mp4') {
            return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '视频只支持 MP4 格式' });
          }
          const buffer = await readBinaryBody(req, maxBytes);
          if (!isMp4Buffer(buffer)) {
            return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'MP4 文件内容不正确' });
          }
          const poster = await videoPosterService.generate(buffer);
          const filename = await store.writeMedia(buffer, 'video/mp4', 'video_', { maxFileSizeBytes: maxBytes });
          let thumbnailFilename = '';
          try {
            // 视频和封面必须成对落盘；封面写入失败时回滚刚写入的视频，避免成功响应缺少静态封面。
            thumbnailFilename = await store.writeImage(poster.buffer, poster.mimeType, 'poster_', { maxFileSizeBytes: mediaConfig.imageMaxFileSizeBytes });
          } catch (error) {
            await store.deleteFile(filename);
            throw error;
          }
          return sendJson(res, 200, {
            ok: true,
            data: {
              filename,
              url: `/api/images/${filename}`,
              thumbnailFilename,
              thumbnailUrl: `/api/images/${thumbnailFilename}`,
              size: buffer.length,
              mimeType: 'video/mp4',
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '视频上传失败';
          const status = message === '请求体过大' || message.includes('文件大小超过限制') ? 413 : 500;
          return sendJson(res, status, { ok: false, code: status === 413 ? ApiErrorCode.BadRequest : ApiErrorCode.InternalError, message });
        }
      },
    },

    /**
     * POST /media/generate-thumbnail
     * 为已有本地原图生成中压缩缩略图，结果仍写入本地媒体目录。
     */
    {
      method: 'POST',
      path: '/media/generate-thumbnail',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        try {
          const body = await readJsonBody(req);
          const sourceFilename = String(body.sourceFilename ?? '');
          if (!isSafeMediaFilename(sourceFilename)) {
            return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '源文件名不合法' });
          }
          const mediaConfig = await getMediaRuntimeConfig();
          const result = await thumbnailService.generateThumbnail(sourceFilename, {
            // 缩略图参数优先使用调用方显式值；未传时使用后台系统配置。
            width: Number(body.width) || mediaConfig.thumbnailWidth,
            height: Number(body.height) || undefined,
            quality: Number(body.quality) || mediaConfig.thumbnailQuality,
            maxFileSizeBytes: mediaConfig.imageMaxFileSizeBytes,
          });
          return sendJson(res, 200, { ok: true, data: result });
        } catch (error) {
          const message = error instanceof Error ? error.message : '缩略图生成失败';
          return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message });
        }
      },
    },

    /**
     * GET /media/files/:filename
     * 返回本地媒体文件流。MP4 支持单段 Range，source=s3 属于旧对象存储参数，当前直接拒绝。
     */
    {
      method: 'GET',
      path: '/media/files/:filename',
      handle: async (req, res, params) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.searchParams.get('source') === 's3') {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '当前仅支持本地媒体读取' });
        }
        const filename = String(params?.filename ?? '').split(/[?#]/, 1)[0] ?? '';
        try {
          if (!isSafeMediaFilename(filename)) {
            return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '文件名不合法' });
          }
          const metadata = await store.readFileMetadata(filename);
          const rangeResult = parseMediaByteRange(req.headers.range, metadata.size);
          if (rangeResult === 'invalid') {
            res.writeHead(416, {
              'Content-Range': `bytes */${metadata.size}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-store',
            });
            res.end();
            return;
          }
          const image = await store.readImage(filename, rangeResult ?? undefined);
          const contentLength = rangeResult ? rangeResult.end - rangeResult.start + 1 : image.size;
          res.writeHead(rangeResult ? 206 : 200, {
            'Content-Type': image.contentType ?? inferMimeType(filename),
            'Content-Length': contentLength,
            'Accept-Ranges': 'bytes',
            ...(rangeResult ? { 'Content-Range': `bytes ${rangeResult.start}-${rangeResult.end}/${image.size}` } : {}),
            'Cache-Control': 'public, max-age=31536000, immutable',
          });
          image.stream.pipe(res);
          return;
        } catch {
          return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '文件不存在' });
        }
      },
    },

    /**
     * GET /media/local-files
     * 列出当前本地存在的安全媒体短文件名，只允许服务间调用。
     */
    {
      method: 'GET',
      path: '/media/local-files',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') ?? '1000')));
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));
        const prefixes = (url.searchParams.get('prefixes') ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        if (!isLocalStore(store)) {
          return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: '本地存储未初始化' });
        }
        const data = await store.listLocalFilenames(limit, offset, prefixes);
        return sendJson(res, 200, { ok: true, data });
      },
    },

    /**
     * GET /media/storage-stats
     * 返回本地媒体目录统计和磁盘占用，只读元数据，不读取图片内容。
     */
    {
      method: 'GET',
      path: '/media/storage-stats',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        if (!isLocalStore(store)) {
          return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: '本地存储未初始化' });
        }
        const localStats = await store.getLocalStorageStats();
        const data: MediaStorageStatsResponse = {
          driver: 'local',
          checkedAt: new Date().toISOString(),
          ...localStats,
        };
        return sendJson(res, 200, { ok: true, data });
      },
    },
  ];
}

/** 解析浏览器单段字节范围；不支持多段范围，越界或语法错误统一返回 invalid。 */
function parseMediaByteRange(value: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!value) return null;
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || size <= 0) return 'invalid';
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return 'invalid';
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return 'invalid';
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** 校验服务间 token；仅显式开发或测试环境允许缺省调试。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

/** 读取 JSON 请求体；上传接口必须传入较大的上限，普通接口使用默认上限。 */
async function readJsonBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += buffer.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

/** media 上传入口规范化后的图片输入。 */
type UploadImageInput = {
  /** 图片二进制。 */
  buffer: Buffer;
  /** 输入 MIME。 */
  mimeType: string;
  /** 写入短文件名前缀。 */
  prefix: string;
  /** 可选压缩上限。 */
  maxBytes?: number;
};

/** 读取 /media/upload 请求；支持二进制直传和 JSON base64，两者统一成 Buffer。 */
async function readUploadImageInput(req: IncomingMessage, maxFileSizeBytes: number): Promise<UploadImageInput> {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType.startsWith('image/')) {
    return {
      buffer: await readBinaryBody(req, maxFileSizeBytes),
      mimeType: contentType,
      prefix: readSafePrefixHeader(req.headers['x-aiimage-prefix']),
      maxBytes: readOptionalPositiveInteger(req.headers['x-aiimage-max-bytes']),
    };
  }

  // JSON base64 会膨胀约 4/3，按后台 image_max_file_size_mb 动态计算请求体上限。
  const body = await readJsonBody(req, Math.ceil(maxFileSizeBytes * 4 / 3) + 1024 * 1024);
  const fileData = String(body.fileData ?? '');
  const base64Data = fileData.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  return {
    buffer: Buffer.from(base64Data, 'base64'),
    mimeType: String(body.mimeType ?? 'image/png'),
    prefix: String(body.prefix ?? 'img_'),
    maxBytes: readOptionalPositiveInteger(body.maxBytes),
  };
}

/** 读取二进制请求体；服务间图片直传仍受 media 总上传上限保护。 */
async function readBinaryBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += buffer.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 服务间前缀只能使用短安全前缀，避免通过 header 污染文件名生成规则。 */
function readSafePrefixHeader(value: unknown): string {
  const prefix = String(value ?? 'img_').trim();
  return /^[a-zA-Z0-9_-]{1,24}$/.test(prefix) ? prefix : 'img_';
}

/** 读取可选正整数配置；非法值返回 undefined，让调用方使用业务默认值。 */
function readOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** media-service 所有文件名必须是短文件名，避免路径穿越。 */
function isSafeMediaFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}

/** 根据短文件名推断 MIME，作为本地文件元数据缺失时的兜底。 */
function inferMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || filename.startsWith('thumb_')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  return 'image/png';
}

/** 视频上限默认 100MB，并限制在 1-100MB，避免异常环境值绕过内存保护。 */
function normalizeVideoMaxBytes(value: unknown): number {
  const parsed = Number(value ?? 100 * 1024 * 1024);
  if (!Number.isFinite(parsed)) return 100 * 1024 * 1024;
  return Math.min(100 * 1024 * 1024, Math.max(1024 * 1024, Math.trunc(parsed)));
}

/** MP4 的 ftyp box 位于文件开头，校验魔数避免把任意响应保存为视频。 */
function isMp4Buffer(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
}
