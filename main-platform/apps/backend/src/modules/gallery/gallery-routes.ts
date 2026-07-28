/**
 * 本文件注册图库浏览、图片详情、浏览记录和点赞路由。
 * 图库浏览公开访问，点赞需要用户 JWT。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type GalleryImageToImageKind, type GalleryListRequest, type GalleryLocalModelLoraMetadataView, type GalleryTagMatchMode } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { GalleryService, GalleryError } from './gallery-service.js';
import { GalleryTagService } from './gallery-tag-service.js';
import { invalidateImageCache, setBackendCacheHeader, setGalleryCacheInvalidationHandler } from '../../shared/cache/cache-service.js';
import { cacheGalleryList, cacheGalleryPopularTags, cacheImageDetail } from '../../shared/cache/cache-policies.js';

const galleryService = new GalleryService();
const galleryTagService = new GalleryTagService();
const LOCAL_MODEL_LORA_COVER_MAX_BYTES = 15 * 1024 * 1024;
const GALLERY_WARMUP_DELAY_MS = Math.max(500, Number(process.env.BACKEND_GALLERY_WARMUP_DELAY_MS ?? '1500') || 1500);
const GALLERY_WARMUP_MIN_INTERVAL_MS = Math.max(5000, Number(process.env.BACKEND_GALLERY_WARMUP_MIN_INTERVAL_MS ?? '15000') || 15000);
let galleryWarmupTimer: ReturnType<typeof setTimeout> | undefined;
let lastGalleryWarmupStartedAt = 0;

/** 注册公开图库缓存补热；启动和 gallery tag 主动失效后都会低优先级补热。 */
export function registerPublicGalleryCacheWarmup(): void {
  setGalleryCacheInvalidationHandler(() => schedulePublicGalleryCacheWarmup('invalidation'));
  schedulePublicGalleryCacheWarmup('startup');
}

/** 节流调度公开图库补热；任务高峰期多次失效会合并，避免反复打数据库。 */
export function schedulePublicGalleryCacheWarmup(reason: 'startup' | 'invalidation' = 'startup'): void {
  if (process.env.BACKEND_GALLERY_WARMUP_DISABLED === 'true' || galleryWarmupTimer) return;
  const elapsed = Date.now() - lastGalleryWarmupStartedAt;
  const delayMs = Math.max(GALLERY_WARMUP_DELAY_MS, GALLERY_WARMUP_MIN_INTERVAL_MS - elapsed);
  galleryWarmupTimer = setTimeout(() => {
    galleryWarmupTimer = undefined;
    lastGalleryWarmupStartedAt = Date.now();
    void warmupPublicGalleryCache(reason).catch((error) => {
      console.error('[gallery] 缓存补热异常', error instanceof Error ? error.message : String(error));
    });
  }, delayMs);
  galleryWarmupTimer.unref?.();
}

/** 预热公开图库首屏缓存；只读取公开图库和热门标签，不写业务数据。 */
export async function warmupPublicGalleryCache(reason: 'startup' | 'invalidation' = 'startup'): Promise<void> {
  const startedAt = Date.now();
  // 预热参数必须和 /api/gallery?page=1&pageSize=24 路由归一化后的 query 完全一致，否则缓存 key 不会命中。
  const query: GalleryListRequest = {
    sort: 'latest',
    mode: undefined,
    i2iKind: undefined,
    source: undefined,
    search: undefined,
    tag: undefined,
    tags: undefined,
    tagMatch: 'any',
    templateId: undefined,
    page: 1,
    pageSize: 24,
  };
  const [galleryResult, tagsResult] = await Promise.allSettled([
    cacheGalleryList(query, () => galleryService.browse(query)),
    cacheGalleryPopularTags(24, () => galleryTagService.listPopularTags(24)),
  ]);
  const galleryStatus = galleryResult.status === 'fulfilled' ? galleryResult.value.status : 'failed';
  const tagsStatus = tagsResult.status === 'fulfilled' ? tagsResult.value.status : 'failed';
  if (galleryResult.status === 'rejected') console.error('[gallery] 首屏缓存预热失败', galleryResult.reason);
  if (tagsResult.status === 'rejected') console.error('[gallery] 热门标签缓存预热失败', tagsResult.reason);
  console.log(`[gallery] 公开图库缓存补热完成 reason=${reason} gallery=${galleryStatus} tags=${tagsStatus} cost=${Date.now() - startedAt}ms`);
}

export function createGalleryRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/gallery', handle: browseGallery },
    { method: 'GET', path: '/api/gallery/tags/popular', handle: popularGalleryTags },
    { method: 'GET', path: '/api/images/:filename/detail', handle: imageDetail },
    { method: 'GET', path: '/api/images/:filename/loras', handle: localModelLoraMetadata },
    { method: 'GET', path: '/api/images/:filename/loras/:versionId/cover', handle: localModelLoraCover },
    { method: 'POST', path: '/api/images/:filename/view', handle: recordView },
    { method: 'POST', path: '/api/images/:filename/like', handle: toggleLike },
    { method: 'DELETE', path: '/api/images/:filename/like', handle: toggleLike },
  ];
}

/** 实时读取任务所用 LoRA 的当前标题和类型，历史版本 ID 与权重仍由主站详情契约固化。 */
async function localModelLoraMetadata(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const filename = params?.filename ?? '';
  if (!filename) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少图片标识' });
  try {
    const target = await galleryService.resolveLocalModelLoras(filename, authenticateUser(req));
    const result = await fetchLocalModelLoraMetadata(target.externalTaskId);
    const selectedIds = new Set(target.localModel.loras.map((lora) => lora.loraVersionId));
    // 独立平台只能更新已固化版本的展示字段，额外版本不能进入主站图库响应。
    const loras = result.loras.filter((lora) => selectedIds.has(lora.loraVersionId));
    res.setHeader('cache-control', 'private, no-store');
    return sendJson(res, 200, { ok: true, data: { loras, negativePrompt: result.negativePrompt } });
  } catch (error) {
    if (error instanceof GalleryError) {
      const status = error.kind === 'forbidden' ? 403 : 404;
      return sendJson(res, status, { ok: false, code: status === 403 ? ApiErrorCode.Forbidden : ApiErrorCode.NotFound, message: error.message });
    }
    return sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: 'LoRA 实时信息读取失败' });
  }
}

/** 使用服务凭证读取独立平台实时 LoRA 元数据，并严格校验响应结构。 */
async function fetchLocalModelLoraMetadata(externalTaskId: string): Promise<{ loras: GalleryLocalModelLoraMetadataView[]; negativePrompt: string | null }> {
  const baseUrl = process.env.LOCAL_PLATFORM_INTERNAL_URL?.trim() || 'http://127.0.0.1:7102';
  const token = process.env.LOCAL_PLATFORM_INTEGRATION_TOKEN?.trim();
  if (!token) throw new Error('本地模型平台 LoRA 元数据集成尚未配置');
  const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/internal/gallery-publications/${encodeURIComponent(externalTaskId)}/loras`, {
    headers: { 'x-local-platform-token': token },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await upstream.json().catch(() => null) as { ok?: boolean; data?: { loras?: unknown[]; negativePrompt?: unknown } } | null;
  if (!upstream.ok || payload?.ok !== true || !Array.isArray(payload.data?.loras)) throw new Error('独立平台 LoRA 元数据响应不正确');
  const rawNegativePrompt = payload.data.negativePrompt;
  if (rawNegativePrompt !== null && typeof rawNegativePrompt !== 'string') throw new Error('独立平台负面提示词响应不正确');
  const negativePrompt = rawNegativePrompt?.trim() || null;
  if (negativePrompt && negativePrompt.length > 100000) throw new Error('独立平台负面提示词长度不正确');
  const loras = payload.data.loras.flatMap((value): GalleryLocalModelLoraMetadataView[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const loraVersionId = typeof item.loraVersionId === 'string' ? item.loraVersionId : '';
    const loraEntryId = typeof item.loraEntryId === 'string' ? item.loraEntryId : '';
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 191) : '';
    const type = normalizeLiveLoraType(item.type);
    return loraVersionId && loraEntryId && title ? [{ loraVersionId, loraEntryId, title, type }] : [];
  });
  return { loras, negativePrompt };
}

/** 归一化独立平台实时 LoRA 类型。 */
function normalizeLiveLoraType(value: unknown): GalleryLocalModelLoraMetadataView['type'] {
  if (value === 'style' || value === 'character' || value === 'concept' || value === 'clothing'
    || value === 'pose' || value === 'object' || value === 'slider' || value === 'other') return value;
  return 'other';
}

/** 代理独立平台的真实 LoRA 封面，同时执行主站图库可见性校验。 */
async function localModelLoraCover(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const filename = params?.filename ?? '';
  const versionId = params?.versionId ?? '';
  if (!filename || !/^[a-zA-Z0-9_-]{8,191}$/.test(versionId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'LoRA 封面参数不正确' });
  try {
    const target = await galleryService.resolveLocalModelLoraCover(filename, versionId, authenticateUser(req));
    const baseUrl = process.env.LOCAL_PLATFORM_INTERNAL_URL?.trim() || 'http://127.0.0.1:7102';
    const token = process.env.LOCAL_PLATFORM_INTEGRATION_TOKEN?.trim();
    if (!token) return sendJson(res, 503, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: '本地模型平台封面集成尚未配置' });
    const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/internal/gallery-publications/${encodeURIComponent(target.externalTaskId)}/loras/${encodeURIComponent(versionId)}/cover`, {
      headers: { 'x-local-platform-token': token },
      signal: AbortSignal.timeout(30000),
    });
    if (!upstream.ok) return sendJson(res, upstream.status === 404 ? 404 : 502, { ok: false, code: upstream.status === 404 ? ApiErrorCode.NotFound : ApiErrorCode.ServiceUnavailable, message: 'LoRA 封面读取失败' });
    const contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
    const declaredLength = Number(upstream.headers.get('content-length') || 0);
    if (!contentType.startsWith('image/') || declaredLength > LOCAL_MODEL_LORA_COVER_MAX_BYTES) {
      return sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: 'LoRA 封面响应不正确' });
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length === 0 || body.length > LOCAL_MODEL_LORA_COVER_MAX_BYTES) return sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: 'LoRA 封面响应不正确' });
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(body.length),
      'cache-control': target.isPrivate ? 'private, no-store' : 'public, max-age=3600',
    });
    res.end(body);
  } catch (error) {
    if (error instanceof GalleryError) {
      const status = error.kind === 'forbidden' ? 403 : 404;
      return sendJson(res, status, { ok: false, code: status === 403 ? ApiErrorCode.Forbidden : ApiErrorCode.NotFound, message: error.message });
    }
    return sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: 'LoRA 封面读取失败' });
  }
}

async function browseGallery(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
  const query: GalleryListRequest = {
    sort: parseGallerySort(url.searchParams.get('sort')),
    mode: url.searchParams.get('mode') ?? undefined,
    i2iKind: parseGalleryImageToImageKind(url.searchParams.get('i2iKind')),
    source: url.searchParams.get('source') ?? undefined,
    search: url.searchParams.get('search') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    tags: parseGalleryTags(url.searchParams),
    tagMatch: parseGalleryTagMatch(url.searchParams.get('tagMatch')),
    templateId: Number(url.searchParams.get('templateId')) || undefined,
    page: Number(url.searchParams.get('page') ?? '1'),
    pageSize,
  };
  // 公开图库基础列表不含用户私有字段，按查询参数共享缓存；登录用户点赞态在缓存命中后轻量补齐。
  const cached = await cacheGalleryList(query, () => galleryService.browse(query));
  setBackendCacheHeader(res, cached.status);
  const data = await galleryService.applyCurrentUserLikes(cached.value, userId);
  const effectivePageSize = data.pageSize ?? pageSize;
  const totalPages = data.total ? Math.ceil(data.total / effectivePageSize) : 1;
  return sendJson(res, 200, { ok: true, data: { ...data, totalPages } });
}

/** 归一化图库排序参数，非法值回退最新，避免无效 query 扰乱缓存 key。 */
function parseGallerySort(value: string | null): GalleryListRequest['sort'] {
  if (value === 'popular' || value === 'random' || value === 'hot') return value;
  return 'latest';
}

/** 读取多标签 query；同时兼容 tags=甲,乙 和重复 tags=甲&tags=乙。 */
function parseGalleryTags(params: URLSearchParams): string[] | undefined {
  const tags = params.getAll('tags')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

/** 归一化标签匹配范围，默认任一标签命中。 */
function parseGalleryTagMatch(value: string | null): GalleryTagMatchMode {
  return value === 'all' ? 'all' : 'any';
}

/** 归一化图生图细分筛选，非法值不参与查询。 */
function parseGalleryImageToImageKind(value: string | null): GalleryImageToImageKind | undefined {
  if (value === 'describe' || value === 'replace') return value;
  return undefined;
}

async function popularGalleryTags(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '24') || 24, 1), 500);
  // 热门标签只来自公开图库，不包含私密任务；缓存随 gallery tag 失效。
  const cached = await cacheGalleryPopularTags(limit, () => galleryTagService.listPopularTags(limit));
  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: { tags: cached.value } });
}

async function imageDetail(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  const filename = params?.filename;
  if (!filename) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少图片标识' });
  try {
    const cached = await cacheImageDetail(filename, userId, () => galleryService.getImageDetail(filename, userId));
    setBackendCacheHeader(res, cached.status);
    const data = cached.value;
    return sendJson(res, 200, { ok: true, data });
  } catch (error) {
    if (error instanceof GalleryError) {
      const status = error.kind === 'not_found' ? 404 : error.kind === 'forbidden' ? 403 : 400;
      return sendJson(res, status, { ok: false, code: ApiErrorCode.NotFound, message: error.message });
    }
    throw error;
  }
}

async function recordView(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const identifier = params?.filename ?? '';
  const taskId = await galleryService.resolveTaskIdFromIdentifier(identifier);
  if (!taskId) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '图片不存在' });
  const ip = resolveViewerIp(req);
  const data = await galleryService.recordView(taskId, ip);
  invalidateImageCache(taskId);
  if (identifier !== taskId) invalidateImageCache(identifier);
  // 浏览量是弱实时互动数据，详情页需要立即刷新；图库列表缓存保持稳定命中，避免每次看图都拖慢公开图库首屏。
  return sendJson(res, 200, { ok: true, data });
}

async function toggleLike(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const identifier = params?.filename ?? '';
  if (!identifier) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少图片标识' });
  const taskId = await galleryService.resolveTaskIdFromIdentifier(identifier);
  if (!taskId) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '图片不存在' });
  try {
    const data = await galleryService.toggleLike(taskId, userId);
    // 点赞写入必须立即落库；图库列表中的 likeCount 允许随短 TTL/stale 延迟刷新，避免每次点赞打穿全站图库首屏缓存。
    invalidateImageCache(taskId);
    if (identifier !== taskId) invalidateImageCache(identifier);
    return sendJson(res, 200, { ok: true, data });
  } catch (error) {
    if (error instanceof GalleryError) {
      return sendJson(res, 429, { ok: false, code: ApiErrorCode.RateLimited, message: error.message });
    }
    throw error;
  }
}

function authenticateUser(req: IncomingMessage) {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token).sub; } catch { return undefined; }
}

/** 解析浏览者 IP；反向代理可能传入逗号分隔链路，入库前必须截取首个地址以匹配 image_views 字段长度。 */
function resolveViewerIp(req: IncomingMessage): string {
  const forwarded = firstHeaderValue(req.headers['cf-connecting-ip'])
    ?? firstHeaderValue(req.headers['x-real-ip'])
    ?? firstHeaderValue(req.headers['x-forwarded-for'])
    ?? req.socket.remoteAddress
    ?? '0.0.0.0';
  const first = String(forwarded).split(',')[0]?.trim() || '0.0.0.0';
  return first.length <= 45 ? first : first.slice(0, 45);
}

/** 读取可能为数组的代理头首值，避免数组字符串化后污染 IP 去重键。 */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
