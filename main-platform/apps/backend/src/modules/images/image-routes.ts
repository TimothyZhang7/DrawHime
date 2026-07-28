/**
 * 本文件注册图片服务路由：图片文件响应、QQ 图片代理、生成记录管理。
 * 图片文件通过 media-service 返回，backend 负责权限校验。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { JsonBodyTooLargeError, readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { invalidateGalleryCache, invalidateTaskCache } from '../../shared/cache/cache-service.js';

const prisma = getPrismaClient();
const MEDIA_URL = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
/** 图片文件名反查缓存：缩略图/原图文件名不可变，缓存可减少图库高频访问时的 system_configs 字符串扫描。 */
const IMAGE_CONFIG_LOOKUP_TTL_MS = Number(process.env.IMAGE_CONFIG_LOOKUP_TTL_MS ?? String(10 * 60 * 1000));
/** 未命中缓存时间较短，避免新任务刚写入配置前的临时未命中长期影响缩略图兜底。 */
const IMAGE_CONFIG_LOOKUP_MISS_TTL_MS = Number(process.env.IMAGE_CONFIG_LOOKUP_MISS_TTL_MS ?? '30000');
/** 单张参考图原始上传上限；大图会交给 media-service 压缩成任务输入版，不能在 backend 预先按 3MB 拦截。 */
const MAX_REFERENCE_SOURCE_UPLOAD_BYTES = Number(process.env.REFERENCE_SOURCE_UPLOAD_MAX_BYTES ?? String(20 * 1024 * 1024));
/** 单张二进制转 base64 约膨胀 4/3，JSON 体上限额外预留 1MB 包装空间。 */
const MAX_REFERENCE_UPLOAD_BODY_BYTES = Math.ceil(MAX_REFERENCE_SOURCE_UPLOAD_BYTES * 4 / 3) + 1024 * 1024;
/** 参考图任务输入版上限；超过该值由 media-service 压缩到 3MB 内再进入绘图任务。 */
const REFERENCE_TASK_INPUT_MAX_BYTES = Number(process.env.REFERENCE_TASK_INPUT_MAX_BYTES ?? String(3 * 1024 * 1024));
/** 参考图转 PNG 可能包含一次安全缩放；超时需覆盖受控短队列，但不能无限等待拥塞任务。 */
const REFERENCE_MEDIA_UPLOAD_TIMEOUT_MS = Number(process.env.REFERENCE_MEDIA_UPLOAD_TIMEOUT_MS ?? '60000');
const imageConfigLookupCache = new Map<string, { expiresAt: number; value?: { imageFilename?: string; thumbnailFilename?: string } }>();

/** 创建图片相关路由，所有图片外显都必须经过 backend 权限和兜底处理。 */
export function createImageRoutes(): Route[] {
  return [
    // 图片文件响应（通过 media-service 代理）
    { method: 'GET', path: '/images/:filename', handle: serveImage },
    // QQ 图片外链代理
    { method: 'GET', path: '/images/proxy', handle: proxyImage },
    // 用户预上传参考图（提交生成任务前先上传，避免 base64 塞在 JSON body）
    { method: 'POST', path: '/api/upload-reference', handle: uploadReference },
  ];
}

/** 返回图片文件（当前默认只读本地媒体目录，缩略图缺失时反查原图兜底）。 */
async function serveImage(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  // 部分路由匹配会把查询串带入 :filename；图片读取前必须剥离，保证 cache-buster 不被误判为非法文件名。
  const filename = normalizeRouteImageFilename(params?.filename ?? '');
  const isThumb = new URL(req.url ?? '/', 'http://localhost').searchParams.get('thumb') === '1';

  try {
    if (!isSafeImageFilename(filename)) {
      sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '图片文件名不合法' });
      return;
    }

    const candidateFilenames = await buildImageCandidateFilenames(filename, isThumb);
    // 关键分支：图片只从本地媒体目录读取，禁止任何对象存储回源。
    // 视频流可能明显大于图片，读取超时必须覆盖完整代理过程，避免播放到 1 秒时被 AbortSignal 中断。
    const mediaTimeoutMs = filename.toLowerCase().endsWith('.mp4') ? 120_000 : 1000;
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const imageRes = await fetchFirstAvailableMediaFile(candidateFilenames, mediaTimeoutMs, rangeHeader);
    if (imageRes.status === 416) {
      res.writeHead(416, {
        ...(imageRes.headers.get('content-range') ? { 'Content-Range': imageRes.headers.get('content-range')! } : {}),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    if (!imageRes.ok) { sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '媒体不存在' }); return; }

    const contentType = imageRes.headers.get('content-type') ?? 'image/png';
    const contentLength = imageRes.headers.get('content-length');
    const contentRange = imageRes.headers.get('content-range');
    const acceptRanges = imageRes.headers.get('accept-ranges');
    res.writeHead(imageRes.status === 206 ? 206 : 200, {
      'Content-Type': contentType,
      ...(contentLength ? { 'Content-Length': contentLength } : {}),
      ...(contentRange ? { 'Content-Range': contentRange } : {}),
      ...(acceptRanges ? { 'Accept-Ranges': acceptRanges } : {}),
      // 图片文件名带随机后缀，内容不可变；长缓存能显著减少图库和 Bot 重复访问带来的 backend/media 压力。
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    const reader = imageRes.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => res.once('drain', resolve));
          }
        }
      }
      finally { reader.releaseLock(); }
    }
    res.end();
  } catch {
    // 图片流可能已经写出响应头；异常兜底时不能再次发送 JSON 响应，避免生产日志出现 headers sent。
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '图片不存在' });
    return;
  }
}

/** 从本地媒体目录读取第一个可用图片文件，候选顺序由调用方保证。 */
async function fetchFirstAvailableMediaFile(filenames: string[], timeoutMs: number, rangeHeader?: string): Promise<Response> {
  let lastRes: Response | undefined;
  for (const item of filenames) {
    try {
      const imageRes = await fetchMediaFile(item, timeoutMs, rangeHeader);
      if (imageRes.ok || imageRes.status === 416) return imageRes;
      lastRes = imageRes;
    } catch {
      // 单个候选读超时或连接失败时继续尝试其他候选，避免缩略图临时异常拖垮原图兜底。
    }
  }
  return lastRes ?? new Response(null, { status: 404 });
}

/** 构造图片读取候选：缩略图缺失时回退原图，避免图库区域因 404 塌陷。 */
async function buildImageCandidateFilenames(filename: string, isThumb: boolean): Promise<string[]> {
  const candidates: string[] = [];
  if (isThumb) {
    const actualThumbnail = await resolveThumbnailFilenameByImageFilename(filename);
    if (actualThumbnail) candidates.push(actualThumbnail);
    if (!filename.startsWith('thumb_')) candidates.push(`thumb_${filename}`);
    candidates.push(filename);
  } else {
    candidates.push(filename);
    if (filename.startsWith('thumb_')) {
      const original = await resolveImageFilenameByThumbnailFilename(filename);
      if (original) candidates.push(original);
    }
  }
  return uniqueImageFilenames(candidates);
}

/** 通过原图文件名反查真实缩略图文件名；兼容缩略图文件名为随机 thumb_xxx 的新链路。 */
async function resolveThumbnailFilenameByImageFilename(imageFilename: string): Promise<string | undefined> {
  const record = await findTaskImageConfigByFilename(imageFilename);
  return record?.imageFilename === imageFilename && isSafeImageFilename(record.thumbnailFilename ?? '') ? record.thumbnailFilename : undefined;
}

/** 通过缩略图文件名反查原图文件名；用于缩略图对象丢失时仍能展示原图。 */
async function resolveImageFilenameByThumbnailFilename(thumbnailFilename: string): Promise<string | undefined> {
  const record = await findTaskImageConfigByFilename(thumbnailFilename);
  return record?.thumbnailFilename === thumbnailFilename && isSafeImageFilename(record.imageFilename ?? '') ? record.imageFilename : undefined;
}

/** 从任务图片配置中查找包含指定文件名的记录，并做 JSON 精确匹配。 */
async function findTaskImageConfigByFilename(filename: string): Promise<{ imageFilename?: string; thumbnailFilename?: string } | undefined> {
  if (!isSafeImageFilename(filename)) return undefined;
  const cached = readImageConfigLookupCache(filename);
  if (cached.hit) return cached.value;

  const rows = await prisma.systemConfig.findMany({
    where: {
      key: { startsWith: 'task_image_' },
      value: { contains: filename },
    },
    select: { value: true },
    take: 5,
  });
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as { imageFilename?: unknown; thumbnailFilename?: unknown };
      const imageFilename = typeof parsed.imageFilename === 'string' ? parsed.imageFilename : undefined;
      const thumbnailFilename = typeof parsed.thumbnailFilename === 'string' ? parsed.thumbnailFilename : undefined;
      if (imageFilename === filename || thumbnailFilename === filename) {
        const value = { imageFilename, thumbnailFilename };
        writeImageConfigLookupCache(filename, value, IMAGE_CONFIG_LOOKUP_TTL_MS);
        return value;
      }
    } catch {
      // 单条历史配置损坏时跳过，不能影响其他图片正常读取。
    }
  }
  writeImageConfigLookupCache(filename, undefined, IMAGE_CONFIG_LOOKUP_MISS_TTL_MS);
  return undefined;
}

/** 读取图片配置反查缓存，过期项惰性清理，避免长期运行时无限增长。 */
function readImageConfigLookupCache(filename: string): { hit: true; value?: { imageFilename?: string; thumbnailFilename?: string } } | { hit: false } {
  const item = imageConfigLookupCache.get(filename);
  if (!item) return { hit: false };
  if (item.expiresAt <= Date.now()) {
    imageConfigLookupCache.delete(filename);
    return { hit: false };
  }
  return { hit: true, value: item.value };
}

/** 写入图片配置反查缓存；达到上限时批量清理旧项，减少图库缩略图高频访问造成的 DB 扫描。 */
function writeImageConfigLookupCache(filename: string, value: { imageFilename?: string; thumbnailFilename?: string } | undefined, ttlMs: number): void {
  if (ttlMs <= 0) return;
  imageConfigLookupCache.set(filename, { value, expiresAt: Date.now() + ttlMs });
  if (imageConfigLookupCache.size <= 5000) return;
  const now = Date.now();
  for (const [key, item] of imageConfigLookupCache) {
    if (item.expiresAt <= now || imageConfigLookupCache.size > 4000) imageConfigLookupCache.delete(key);
  }
}

/** 图片短文件名只允许安全字符，避免数据库反查和 media 请求被路径穿越污染。 */
function isSafeImageFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}

/** 去重并过滤非法短文件名，保持候选读取顺序稳定。 */
function uniqueImageFilenames(filenames: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const filename of filenames) {
    if (!isSafeImageFilename(filename) || seen.has(filename)) continue;
    seen.add(filename);
    result.push(filename);
  }
  return result;
}

/** 从 media-service 本地链路读取文件。 */
async function fetchMediaFile(filename: string, timeoutMs: number, rangeHeader?: string) {
  return fetch(`${MEDIA_URL}/media/files/${encodeURIComponent(filename)}`, {
    headers: rangeHeader ? { Range: rangeHeader } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 用户预上传参考图：二进制或兼容 base64 → media-service → 返回短文件名。
 *  提交生成任务时只需传文件名，避免生成接口携带大段图片数据。 */
async function uploadReference(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });

  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType.startsWith('image/')) {
    try {
      const imageBuffer = await readBinaryBody(req, MAX_REFERENCE_SOURCE_UPLOAD_BYTES);
      if (imageBuffer.length === 0) {
        return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少图片数据' });
      }
      return await forwardReferenceUploadToMedia(res, imageBuffer, contentType);
    } catch (error) {
      if (error instanceof BinaryBodyTooLargeError) {
        return sendJson(res, 413, { ok: false, code: ApiErrorCode.BadRequest, message: '原始参考图不能超过 20MB' });
      }
      throw error;
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, MAX_REFERENCE_UPLOAD_BODY_BYTES) as Record<string, unknown>;
  } catch (error) {
    // 用户上传超限属于可预期的 413 校验失败，不能抛到全局错误日志里污染 backend error。
    if (error instanceof JsonBodyTooLargeError) {
      return sendJson(res, 413, { ok: false, code: ApiErrorCode.BadRequest, message: '原始参考图不能超过 20MB' });
    }
    throw error;
  }
  const fileData = String(body.fileData ?? '');
  const mimeType = String(body.mimeType ?? 'image/png');

  if (!fileData) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少图片数据' });
  }
  if (estimateBase64Bytes(fileData) > MAX_REFERENCE_SOURCE_UPLOAD_BYTES) {
    return sendJson(res, 413, { ok: false, code: ApiErrorCode.BadRequest, message: '原始参考图不能超过 20MB' });
  }

  const base64Data = fileData.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  return await forwardReferenceUploadToMedia(res, Buffer.from(base64Data, 'base64'), mimeType);
}

/** 把已校验的参考图二进制转发给 media-service 保存，返回统一的用户上传响应。 */
async function forwardReferenceUploadToMedia(res: Parameters<typeof sendJson>[0], imageBuffer: Buffer, mimeType: string) {
  try {
    const uploadRes = await fetch(`${MEDIA_URL}/media/upload`, {
      method: 'POST',
      headers: {
        'content-type': normalizeUploadMimeType(mimeType),
        'x-service-token': process.env.WS_PROXY_TOKEN?.trim() ?? '',
        'x-aiimage-prefix': 'ref_',
        'x-aiimage-max-bytes': String(REFERENCE_TASK_INPUT_MAX_BYTES),
      },
      // 关键分支：backend 到 media 使用二进制直传，避免 base64 JSON 在服务间再次膨胀和解析。
      body: new Uint8Array(imageBuffer),
      signal: AbortSignal.timeout(REFERENCE_MEDIA_UPLOAD_TIMEOUT_MS),
    });
    const uploadData = await uploadRes.json().catch(() => ({})) as {
      ok?: boolean;
      message?: string;
      data?: { filename: string; url: string; size?: number; originalSize?: number; compressed?: boolean; mimeType?: string };
    };
    if (!uploadData.ok || !uploadData.data?.filename) {
      const isClientError = uploadRes.status >= 400 && uploadRes.status < 500;
      return sendJson(res, isClientError ? uploadRes.status : 500, {
        ok: false,
        code: uploadRes.status === 429 ? ApiErrorCode.RateLimited : isClientError ? ApiErrorCode.BadRequest : ApiErrorCode.InternalError,
        message: uploadData.message || '图片上传失败',
      });
    }
    return sendJson(res, 200, {
      ok: true,
      data: {
        filename: uploadData.data.filename,
        url: `/images/${uploadData.data.filename}`,
        size: uploadData.data.size,
        originalSize: uploadData.data.originalSize,
        compressed: uploadData.data.compressed,
        mimeType: uploadData.data.mimeType,
      },
    });
  } catch {
    return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: '图片上传服务不可用' });
  }
}

/** 二进制请求体超过路由声明上限时抛出，用于返回稳定 413。 */
class BinaryBodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super('请求体过大');
    this.name = 'BinaryBodyTooLargeError';
  }
}

/** 读取二进制图片请求体；这里限制原始上传大小，任务输入 3MB 上限由 media-service 压缩后保证。 */
async function readBinaryBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += buffer.length;
    if (size > limitBytes) throw new BinaryBodyTooLargeError(limitBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 保留参考图支持的真实 MIME；非法或空值兜底为 PNG，最终仍由 media-service 按内容校验并转码。 */
function normalizeUploadMimeType(value: string): string {
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'image/jpeg';
  if (['image/png', 'image/webp', 'image/gif', 'image/avif', 'image/tiff', 'image/svg+xml'].includes(mimeType)) return mimeType;
  return 'image/png';
}

/** 估算 base64 解码后的字节数，用于在转发 media-service 前做一致的 20MB 校验。 */
function estimateBase64Bytes(value: string): number {
  const base64 = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

/** QQ 图片外链代理：只允许 qq.com/qpic.cn/gtimg.com 白名单域名。 */
async function proxyImage(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const url = new URL(req.url ?? '/', 'http://localhost').searchParams.get('url');
  if (!url) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少图片 URL 参数' });

  // 白名单校验
  let parsed: URL;
  try { parsed = new URL(url); } catch { return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'URL 格式不正确' }); }
  const allowedHosts = ['qq.com', 'qpic.cn', 'gtimg.com'];
  // 图片代理只允许 QQ 图片域名本身或其子域，避免 evilqq.com 这类后缀绕过。
  if (!allowedHosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '图片来源不在白名单内' });
  }

  try {
    const imageRes = await fetch(url, {
      headers: { 'Referer': 'https://qun.qq.com/' },
      signal: AbortSignal.timeout(15000),
    });
    if (!imageRes.ok) {
      return sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: '获取 QQ 图片失败' });
    }
    const buffer = Buffer.from(await imageRes.arrayBuffer());
    const contentType = imageRes.headers.get('content-type') ?? 'image/jpeg';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(buffer);
  } catch {
    return sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: 'QQ 图片代理失败' });
  }
}

/** 校验用户 JWT，返回用户 id。 */
function authenticateUser(req: IncomingMessage): number | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token).sub; } catch { return undefined; }
}

function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    const payload = verifyAccessToken(token);
    return payload.role === 'admin' ? payload : undefined;
  } catch { return undefined; }
}

/** 标准化路由参数中的图片短文件名，兼容带查询串的图片访问请求。 */
function normalizeRouteImageFilename(value: string): string {
  return value.trim().split(/[?#]/, 1)[0] ?? '';
}
