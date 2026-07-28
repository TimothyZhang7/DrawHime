/** 本文件提供用户端工具中心公开配置接口，工具开关和默认参数由后台配置驱动。 */
import type { IncomingMessage } from 'node:http';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { ApiErrorCode, type ImageReverseMode, type ImageReverseWd14HealthResponse, type ImageUpscaleHealthResponse, type ImageUpscaleJobCancelResponse, type ImageUpscaleJobCreateResponse, type ImageUpscaleJobDetailResponse, type ImageUpscaleJobListResponse, type ImageUpscaleRunOptions, type ImageUpscaleRunResponse, type ToolConfigView, type ToolId, type ToolUsageOverviewResponse, type ToolUsageRecordRequest, type ToolsConfigResponse } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { cacheToolsConfig } from '../../shared/cache/cache-policies.js';
import { setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { logger } from '../../shared/logger.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { parseEnabledReverseLanguages, parseEnabledReverseModes, type ImageReversePublicDefaults } from './image-reverse-options.js';
import { BinaryBodyTooLargeError, readBinaryBody } from './binary-request-body.js';
import { createImageReverseRoutes, readImageReverseConfig } from './image-reverse-routes.js';
import { ImageReverseWd14Service } from './image-reverse-wd14-service.js';
import { ImageUpscaleError, ImageUpscaleService, parseUpscaleModels, parseUpscaleOutputFormat, parseUpscaleOutputFormats, parseUpscaleResponseTransport, parseUpscaleScale, parseUpscaleScales, resolveLocalGpuResultDownloadUrl, type ImageUpscaleRuntimeConfig } from './image-upscale-service.js';
import { ImageUpscaleLibraryService } from './image-upscale-library-service.js';
import { ImageUpscaleJobService } from './image-upscale-job-service.js';
import { ImageUpscaleQueueFullError, ImageUpscaleQueueService, ImageUpscaleQueueTimeoutError } from './image-upscale-queue-service.js';
import { ImageUpscaleSourceStorageError } from './image-upscale-source-storage.js';

const prisma = getPrismaClient();
const imageUpscaleService = new ImageUpscaleService();
const imageUpscaleLibraryService = new ImageUpscaleLibraryService();
const imageUpscaleQueueService = new ImageUpscaleQueueService();
const imageUpscaleJobService = new ImageUpscaleJobService(imageUpscaleQueueService, imageUpscaleService, imageUpscaleLibraryService);
const imageReverseWd14Service = new ImageReverseWd14Service();
/** 图片放大当前生产默认模型；后台配置缺失时仍保持当前模型为默认。 */
const DEFAULT_IMAGE_UPSCALE_MODEL = 'RealESRGAN_x4plus_anime_6B';
/** 图片放大当前生产可选模型白名单；只登记 GPU 服务器已经存在或可真实下载加载的模型。 */
const DEFAULT_IMAGE_UPSCALE_ALLOWED_MODELS = 'RealESRGAN_x4plus_anime_6B,realesr-animevideov3,realesr-general-x4v3,realesr-general-wdn-x4v3,RealESRGAN_x2plus,RealESRGAN_x4plus,RealESRNet_x4plus';
const TOOL_DEFINITIONS: Array<{ id: ToolId; title: string }> = [
  { id: 'image-splitter', title: '图片拆分' },
  { id: 'image-converter', title: '格式转换与压缩' },
  { id: 'image-scrambler', title: '图片混淆' },
  { id: 'image-wobble', title: '局部抖动' },
  { id: 'image-reverse', title: '图片反推' },
  { id: 'image-upscale', title: '图片放大' },
];

/** 注册工具公开配置路由。 */
export function createToolRoutes(): Route[] {
  imageUpscaleJobService.startRecovery(readImageUpscaleConfig, () => incrementToolUsage('image-upscale').catch(() => undefined));
  return [
    { method: 'GET', path: '/api/tools/config', handle: getToolsConfig },
    { method: 'POST', path: '/api/tools/usage', handle: recordToolUsage },
    { method: 'GET', path: '/admin/tools/usage', handle: getAdminToolUsage },
    { method: 'GET', path: '/admin/tools/image-upscale/health', handle: getAdminImageUpscaleHealth },
    { method: 'GET', path: '/admin/tools/image-reverse/wd14/health', handle: getAdminImageReverseWd14Health },
    ...createImageReverseRoutes({ onSucceeded: () => incrementToolUsage('image-reverse').catch(() => undefined) }),
    { method: 'POST', path: '/api/tools/image-upscale/run', handle: runImageUpscale },
    { method: 'POST', path: '/internal/tools/image-upscale/run', handle: runImageUpscaleInternal },
    { method: 'POST', path: '/api/tools/image-upscale/jobs', handle: createImageUpscaleJob },
    { method: 'GET', path: '/api/tools/image-upscale/jobs', handle: listImageUpscaleJobs },
    { method: 'POST', path: '/api/tools/image-upscale/jobs/:jobId/cancel', handle: cancelImageUpscaleJob },
    { method: 'GET', path: '/api/tools/image-upscale/jobs/:jobId/source', handle: serveImageUpscaleJobSource },
    { method: 'GET', path: '/api/tools/image-upscale/jobs/:jobId', handle: getImageUpscaleJob },
  ];
}

/** 返回前台工具中心可用的工具配置。 */
async function getToolsConfig(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const cached = await cacheToolsConfig(async () => {
    const rows = await prisma.systemConfig.findMany({
      where: {
        key: {
          in: [
            'tools_image_splitter_enabled',
            'tools_image_splitter_default_rows',
            'tools_image_splitter_default_cols',
            'tools_image_splitter_max_rows',
            'tools_image_splitter_max_cols',
            'tools_image_splitter_max_file_size_mb',
            'tools_image_converter_enabled',
            'tools_image_converter_max_file_size_mb',
            'tools_image_converter_max_batch_count',
            'tools_image_converter_default_format',
            'tools_image_converter_default_quality',
            'tools_image_scrambler_enabled',
            'tools_image_scrambler_max_file_size_mb',
            'tools_image_wobble_enabled',
            'tools_image_wobble_max_file_size_mb',
            'tools_image_reverse_enabled',
            'tools_image_reverse_max_file_size_mb',
            'tools_image_reverse_model',
            'tools_image_reverse_timeout_sec',
            'tools_image_reverse_max_output_chars',
            'tools_image_reverse_default_mode',
            'tools_image_reverse_default_language',
            'tools_image_reverse_default_prompt_language',
            'tools_image_reverse_enabled_modes',
            'tools_image_reverse_enabled_languages',
            'tools_image_reverse_wd14_enabled',
            'tools_image_reverse_wd14_base_url',
            'tools_image_reverse_wd14_api_key',
            'tools_image_upscale_enabled',
            'tools_image_upscale_model',
            'tools_image_upscale_allowed_models',
            'tools_image_upscale_max_file_size_mb',
            'tools_image_upscale_timeout_sec',
            'tools_image_upscale_allowed_scales',
            'tools_image_upscale_default_scale',
            'tools_image_upscale_max_output_pixels',
          ],
        },
      },
      select: { key: true, value: true },
    });
    return buildToolsConfig(Object.fromEntries(rows.map((row) => [row.key, row.value])));
  });
  setBackendCacheHeader(res, cached.status);
  const data = cached.value;
  const payload: ToolsConfigResponse = { tools: data };
  return sendJson(res, 200, { ok: true, data: payload });
}

/** 依据后台配置组装用户端工具配置。 */
function buildToolsConfig(config: Record<string, string>): ToolConfigView[] {
  return [
    {
      id: 'image-splitter',
      title: '图片拆分',
      enabled: config.tools_image_splitter_enabled !== 'false',
      defaultRows: clampInt(config.tools_image_splitter_default_rows, 3, 1, 12),
      defaultCols: clampInt(config.tools_image_splitter_default_cols, 3, 1, 12),
      maxRows: clampInt(config.tools_image_splitter_max_rows, 12, 1, 24),
      maxCols: clampInt(config.tools_image_splitter_max_cols, 12, 1, 24),
      maxFileSizeMb: clampInt(config.tools_image_splitter_max_file_size_mb, 30, 1, 200),
    },
    {
      id: 'image-converter',
      title: '格式转换与压缩',
      enabled: config.tools_image_converter_enabled !== 'false',
      maxFileSizeMb: clampInt(config.tools_image_converter_max_file_size_mb, 30, 1, 200),
      convertMaxBatchCount: clampInt(config.tools_image_converter_max_batch_count, 20, 1, 50),
      convertDefaultFormat: normalizeConvertFormat(config.tools_image_converter_default_format),
      convertDefaultQuality: clampInt(config.tools_image_converter_default_quality, 82, 1, 100),
    },
    {
      id: 'image-scrambler',
      title: '图片混淆',
      enabled: config.tools_image_scrambler_enabled !== 'false',
      maxFileSizeMb: clampInt(config.tools_image_scrambler_max_file_size_mb, 30, 1, 200),
    },
    {
      id: 'image-wobble',
      title: '局部抖动',
      enabled: config.tools_image_wobble_enabled !== 'false',
      maxFileSizeMb: clampInt(config.tools_image_wobble_max_file_size_mb, 30, 1, 200),
    },
    {
      id: 'image-reverse',
      title: '图片反推',
      enabled: config.tools_image_reverse_enabled === 'true',
      maxFileSizeMb: clampInt(config.tools_image_reverse_max_file_size_mb, 20, 1, 100),
      reverseModel: String(config.tools_image_reverse_model ?? 'gpt-5.6-sol').trim() || 'gpt-5.6-sol',
      reverseTimeoutSec: clampInt(config.tools_image_reverse_timeout_sec, 300, 5, 600),
      reverseMaxOutputChars: clampInt(config.tools_image_reverse_max_output_chars, 6000, 500, 20000),
      reverseDefaultMode: readReverseModeValue(config.tools_image_reverse_default_mode, 'description'),
      reverseDefaultLanguage: readReverseLanguageValue(config.tools_image_reverse_default_language, 'zh'),
      reverseDefaultPromptLanguage: String(config.tools_image_reverse_default_prompt_language ?? 'auto').trim() as ToolConfigView['reverseDefaultPromptLanguage'],
      reverseEnabledModes: parseEnabledReverseModes(config.tools_image_reverse_enabled_modes),
      reverseEnabledLanguages: parseEnabledReverseLanguages(config.tools_image_reverse_enabled_languages),
      reverseHybridAvailable: config.tools_image_reverse_wd14_enabled === 'true'
        && Boolean(String(config.tools_image_reverse_wd14_base_url ?? '').trim())
        && Boolean(String(config.tools_image_reverse_wd14_api_key ?? '').trim()),
    },
    {
      id: 'image-upscale',
      title: '图片放大',
      enabled: config.tools_image_upscale_enabled === 'true',
      maxFileSizeMb: clampInt(config.tools_image_upscale_max_file_size_mb, 30, 1, 200),
      upscaleModel: String(config.tools_image_upscale_model ?? DEFAULT_IMAGE_UPSCALE_MODEL).trim() || DEFAULT_IMAGE_UPSCALE_MODEL,
      upscaleAllowedModels: parseUpscaleModels(config.tools_image_upscale_allowed_models ?? DEFAULT_IMAGE_UPSCALE_ALLOWED_MODELS, String(config.tools_image_upscale_model ?? DEFAULT_IMAGE_UPSCALE_MODEL).trim() || DEFAULT_IMAGE_UPSCALE_MODEL),
      upscaleDefaultScale: parseUpscaleScale(config.tools_image_upscale_default_scale, 2),
      upscaleAllowedScales: parseUpscaleScales(config.tools_image_upscale_allowed_scales),
      upscaleTimeoutSec: clampInt(config.tools_image_upscale_timeout_sec, 120, 10, 600),
      upscaleOutputFormat: 'webp',
      upscaleAllowedOutputFormats: ['webp'],
      upscaleMaxOutputPixels: clampInt(config.tools_image_upscale_max_output_pixels, 64_000_000, 4_000_000, 160_000_000),
    },
  ];
}

/** 用户端图片放大接口：必须登录，默认只返回结果；用户明确选择保存时才写入我的图片。 */
async function runImageUpscale(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  return runImageUpscaleWithConfig(req, res, userId);
}

/** Bot 内部图片放大接口：使用 service token，只返回放大结果，不保存图库、不触碰钱包。 */
async function runImageUpscaleInternal(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务令牌无效' });
  return runImageUpscaleWithConfig(req, res);
}

/** 执行图片放大的公共流程；外层负责鉴权，传入 userId 时才允许保存到当前用户图库。 */
async function runImageUpscaleWithConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0], userId?: number) {
  const config = await readImageUpscaleConfig();
  const mimeType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  try {
    const rawOptions = readUpscaleOptions(req, config);
    // 内部 Bot 命令只做即时工具调用；即使请求头被误传 saveToLibrary，也不能写入任意用户图库。
    const options = userId ? rawOptions : { ...rawOptions, saveToLibrary: false, isPrivate: undefined };
    const buffer = await readBinaryBody(req, config.maxFileSizeMb * 1024 * 1024);
    const queued = await imageUpscaleQueueService.run(
      () => imageUpscaleService.upscale(buffer, mimeType, config, options),
      { maxConcurrency: config.maxConcurrency, maxPending: config.queueMaxPending, maxWaitMs: config.queueMaxWaitMs },
    );
    const result = queued.result;
    result.queueWaitMs = queued.waitMs;
    if (userId && options.saveToLibrary) {
      if (result.image.base64) {
        const outputBuffer = Buffer.from(result.image.base64, 'base64');
        result.savedTask = await imageUpscaleLibraryService.saveResult({
          userId,
          result,
          imageBuffer: outputBuffer,
          mimeType: result.image.mimeType,
          sourceImageBuffer: buffer,
          sourceMimeType: mimeType,
          isPrivate: options.isPrivate,
        });
      } else if (result.image.url) {
        // GPU 本机暂存链路先把 URL 返回给用户，主站保存图库在后台执行，避免阻塞预览。
        const libraryImageUrl = config.responseTransport === 'local'
          ? resolveLocalGpuResultDownloadUrl(result.image.url, config.baseUrl)
          : result.image.url;
        void imageUpscaleLibraryService.saveResultFromUrl({
          userId,
          result,
          imageUrl: libraryImageUrl,
          mimeType: result.image.mimeType,
          sourceImageBuffer: buffer,
          sourceMimeType: mimeType,
          isPrivate: options.isPrivate,
        }).catch((error) => logger.warn({ error: error instanceof Error ? error.message : String(error) }, '图片放大同步接口后台保存图库失败'));
      } else {
        throw new ImageUpscaleError('upstream_invalid', '图片放大结果缺少可保存的图片内容', 502);
      }
    }
    await incrementToolUsage('image-upscale').catch(() => undefined);
    const payload: ImageUpscaleRunResponse = result;
    return sendJson(res, 200, { ok: true, data: payload });
  } catch (error) {
    return sendImageUpscaleError(res, error);
  }
}

/** 创建图片放大异步任务：提交后立即返回任务 ID，backend 进程继续执行 GPU 队列。 */
async function createImageUpscaleJob(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const config = await readImageUpscaleConfig();
  const mimeType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  try {
    const options = readUpscaleOptions(req, config);
    const buffer = await readBinaryBody(req, config.maxFileSizeMb * 1024 * 1024);
    const job = await imageUpscaleJobService.submit({
      userId,
      sourceFileName: readUpscaleSourceFileName(req),
      sourceSizeBytes: buffer.length,
      imageBuffer: buffer,
      mimeType,
      config,
      options,
      queue: { maxConcurrency: config.maxConcurrency, maxPending: config.queueMaxPending, maxWaitMs: config.queueMaxWaitMs },
      onSucceeded: () => incrementToolUsage('image-upscale').catch(() => undefined),
    });
    const payload: ImageUpscaleJobCreateResponse = { job };
    return sendJson(res, 202, { ok: true, data: payload });
  } catch (error) {
    return sendImageUpscaleError(res, error);
  }
}

/** 列出当前用户近期图片放大任务，用于页面刷新后恢复历史状态。 */
async function listImageUpscaleJobs(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const payload: ImageUpscaleJobListResponse = { jobs: await imageUpscaleJobService.listJobs(userId) };
  return sendJson(res, 200, { ok: true, data: payload });
}

/** 读取当前用户单个图片放大任务；跨用户任务不会返回，避免泄露图片结果。 */
async function getImageUpscaleJob(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const jobId = String(params?.jobId ?? '').trim();
  if (!jobId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '任务 ID 不正确' });
  const job = await imageUpscaleJobService.getJob(userId, jobId);
  if (!job) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '任务不存在或已过期' });
  const payload: ImageUpscaleJobDetailResponse = { job };
  return sendJson(res, 200, { ok: true, data: payload });
}

/** 鉴权输出图片放大历史任务的私有源图或轻量预览。 */
async function serveImageUpscaleJobSource(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const jobId = String(params?.jobId ?? '').trim();
  if (!jobId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '任务 ID 不正确' });
  const preview = new URL(req.url ?? '/', 'http://localhost').searchParams.get('preview') === '1';
  const served = await imageUpscaleJobService.serveSource(userId, jobId, preview, res);
  if (!served) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '源图不存在' });
}

/** 手动结束当前用户自己的图片放大任务；不删除历史，不触碰钱包和图库数据。 */
async function cancelImageUpscaleJob(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const jobId = String(params?.jobId ?? '').trim();
  if (!jobId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '任务 ID 不正确' });
  const job = await imageUpscaleJobService.cancelJob(userId, jobId);
  if (!job) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '任务不存在或已过期' });
  const payload: ImageUpscaleJobCancelResponse = { job };
  return sendJson(res, 200, { ok: true, data: payload });
}

/** 记录浏览器本地工具的一次成功调用；登录态可带 JWT，匿名也允许上报，不写用户隐私。 */
async function recordToolUsage(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const body = await readJsonBody<ToolUsageRecordRequest>(req);
  const toolId = normalizeToolId(body.toolId);
  if (!toolId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '工具 ID 不正确' });
  if (toolId === 'image-reverse' || toolId === 'image-upscale') {
    // 图片反推和图片放大由真实后端成功响应处计数，避免客户端重复上报放大调用量。
    return sendJson(res, 200, { ok: true, data: { counted: false } });
  }
  await incrementToolUsage(toolId);
  return sendJson(res, 200, { ok: true, data: { counted: true } });
}

/** 统一映射图片放大错误，保持同步接口和异步创建接口的错误响应一致。 */
function sendImageUpscaleError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof ImageUpscaleSourceStorageError) {
    const code = error.status >= 500 ? ApiErrorCode.InternalError : ApiErrorCode.BadRequest;
    return sendJson(res, error.status, { ok: false, code, message: error.message });
  }
  if (error instanceof ImageUpscaleError) {
    const code = error.status === 413 ? ApiErrorCode.BadRequest : error.status === 403 ? ApiErrorCode.Forbidden : error.status >= 500 ? ApiErrorCode.InternalError : ApiErrorCode.BadRequest;
    return sendJson(res, error.status, { ok: false, code, message: error.message });
  }
  if (error instanceof ImageUpscaleQueueFullError) {
    return sendJson(res, 429, { ok: false, code: ApiErrorCode.RateLimited, message: error.message });
  }
  if (error instanceof ImageUpscaleQueueTimeoutError) {
    return sendJson(res, 429, { ok: false, code: ApiErrorCode.RateLimited, message: error.message });
  }
  if (error instanceof BinaryBodyTooLargeError) {
    return sendJson(res, 413, { ok: false, code: ApiErrorCode.BadRequest, message: `图片大小不能超过 ${Math.round(error.limitBytes / 1024 / 1024)}MB` });
  }
  const message = error instanceof Error ? error.message : '图片放大失败';
  return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message });
}

/** 管理后台读取工具调用统计；只返回聚合计数，不返回用户、IP 或上传图片信息。 */
async function getAdminToolUsage(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const date = formatChinaDateKey(new Date());
  const keys = TOOL_DEFINITIONS.flatMap((tool) => [
    usageTotalKey(tool.id),
    usageTodayKey(tool.id, date),
    usageLastUsedKey(tool.id),
  ]);
  const rows = await prisma.systemConfig.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const data: ToolUsageOverviewResponse = {
    date,
    tools: TOOL_DEFINITIONS.map((tool) => ({
      id: tool.id,
      title: tool.title,
      totalCount: parseCount(map.get(usageTotalKey(tool.id))),
      todayCount: parseCount(map.get(usageTodayKey(tool.id, date))),
      lastUsedAt: normalizeIsoTime(map.get(usageLastUsedKey(tool.id))),
    })),
  };
  return sendJson(res, 200, { ok: true, data });
}

/** 管理后台读取图片放大 GPU 健康；只返回状态和模型列表，不返回密钥。 */
async function getAdminImageUpscaleHealth(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const config = await readImageUpscaleConfig();
  const queue = imageUpscaleQueueService.getSnapshot();
  const upstream = await probeImageUpscaleHealth(config);
  const data: ImageUpscaleHealthResponse = {
    enabled: config.enabled,
    baseUrlConfigured: Boolean(config.baseUrl),
    apiKeyConfigured: Boolean(config.apiKey),
    model: config.model,
    allowedModels: config.allowedModels,
    responseTransport: config.responseTransport,
    queue: {
      active: queue.active,
      pending: queue.pending,
      oldestPendingMs: queue.oldestPendingMs,
      maxConcurrency: config.maxConcurrency,
      maxPending: config.queueMaxPending,
      maxWaitMs: config.queueMaxWaitMs,
    },
    upstream,
  };
  return sendJson(res, 200, { ok: true, data });
}

/** 返回 WD14 Provider 健康状态；配置密钥只以是否已配置的布尔值展示。 */
async function getAdminImageReverseWd14Health(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const config = await readImageReverseConfig();
  const data: ImageReverseWd14HealthResponse = await imageReverseWd14Service.health(config.wd14);
  return sendJson(res, 200, { ok: true, data });
}

/** 原子累加工具调用计数；计数失败不能影响工具主流程。 */
async function incrementToolUsage(toolId: ToolId): Promise<void> {
  const now = new Date();
  const date = formatChinaDateKey(now);
  const totalKey = usageTotalKey(toolId);
  const todayKey = usageTodayKey(toolId, date);
  const lastUsedKey = usageLastUsedKey(toolId);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO system_configs (\`key\`, value, updated_at)
      VALUES (${totalKey}, '1', NOW(3))
      ON DUPLICATE KEY UPDATE value = CAST(CAST(value AS UNSIGNED) + 1 AS CHAR), updated_at = NOW(3)
    `;
    await tx.$executeRaw`
      INSERT INTO system_configs (\`key\`, value, updated_at)
      VALUES (${todayKey}, '1', NOW(3))
      ON DUPLICATE KEY UPDATE value = CAST(CAST(value AS UNSIGNED) + 1 AS CHAR), updated_at = NOW(3)
    `;
    await tx.systemConfig.upsert({
      where: { key: lastUsedKey },
      update: { value: now.toISOString() },
      create: { key: lastUsedKey, value: now.toISOString() },
    });
  });
}

/** 校验图片放大内部入口的服务 token；仅显式开发或测试环境允许缺省调试。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}

/** 从请求头读取图片放大选项，非法 JSON 直接返回业务错误。 */
function readUpscaleOptions(req: IncomingMessage, config: ImageUpscaleRuntimeConfig): ImageUpscaleRunOptions {
  const raw = req.headers['x-aiimage-upscale-options'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (!text) return { scale: config.defaultScale, model: config.model, outputFormat: 'webp' };
  try {
    const parsed = JSON.parse(text) as Partial<ImageUpscaleRunOptions>;
    return {
      scale: parseUpscaleScale(String(parsed.scale ?? ''), config.defaultScale),
      model: typeof parsed.model === 'string' ? parsed.model : config.model,
      // 输出格式已经收口为 WebP，旧客户端传 PNG 时也在这里强制归一。
      outputFormat: 'webp',
      saveToLibrary: parsed.saveToLibrary === true,
      isPrivate: typeof parsed.isPrivate === 'boolean' ? parsed.isPrivate : undefined,
    };
  } catch {
    throw new ImageUpscaleError('invalid_options', '图片放大选项格式不正确', 400);
  }
}

/** 从请求头读取上传文件名；仅用于任务历史展示，截断并清理控制字符避免污染日志和页面。 */
function readUpscaleSourceFileName(req: IncomingMessage): string {
  const raw = Array.isArray(req.headers['x-aiimage-file-name']) ? req.headers['x-aiimage-file-name'][0] : req.headers['x-aiimage-file-name'];
  const value = String(raw ?? '').trim();
  if (!value) return 'image';
  try {
    return decodeURIComponent(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'image';
  } catch {
    return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'image';
  }
}

/** 读取图片放大私有运行时配置；GPU 服务密钥不进入公开配置接口。 */
async function readImageUpscaleConfig(): Promise<ImageUpscaleRuntimeConfig> {
  const keys = [
    'tools_image_upscale_enabled',
    'tools_image_upscale_base_url',
    'tools_image_upscale_api_key',
    'tools_image_upscale_model',
    'tools_image_upscale_allowed_models',
    'tools_image_upscale_max_file_size_mb',
    'tools_image_upscale_timeout_sec',
    'tools_image_upscale_allowed_scales',
    'tools_image_upscale_default_scale',
    'tools_image_upscale_max_output_pixels',
    'tools_image_upscale_max_concurrency',
    'tools_image_upscale_queue_max_pending',
    'tools_image_upscale_queue_timeout_sec',
    'tools_image_upscale_response_transport',
  ];
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const allowedScales = parseUpscaleScales(config.tools_image_upscale_allowed_scales);
  const defaultScale = parseUpscaleScale(config.tools_image_upscale_default_scale, allowedScales[0] ?? 2);
  const defaultModel = String(config.tools_image_upscale_model ?? DEFAULT_IMAGE_UPSCALE_MODEL).trim() || DEFAULT_IMAGE_UPSCALE_MODEL;
  const allowedModels = parseUpscaleModels(config.tools_image_upscale_allowed_models ?? DEFAULT_IMAGE_UPSCALE_ALLOWED_MODELS, defaultModel);
  return {
    enabled: config.tools_image_upscale_enabled === 'true',
    baseUrl: String(config.tools_image_upscale_base_url ?? '').trim(),
    apiKey: String(config.tools_image_upscale_api_key ?? '').trim(),
    model: allowedModels.includes(defaultModel) ? defaultModel : (allowedModels[0] ?? defaultModel),
    allowedModels,
    maxFileSizeMb: clampInt(config.tools_image_upscale_max_file_size_mb, 30, 1, 200),
    timeoutSec: clampInt(config.tools_image_upscale_timeout_sec, 120, 10, 600),
    allowedScales,
    defaultScale: allowedScales.includes(defaultScale) ? defaultScale : (allowedScales[0] ?? 2),
    outputFormat: parseUpscaleOutputFormat(undefined),
    allowedOutputFormats: parseUpscaleOutputFormats(undefined),
    maxOutputPixels: clampInt(config.tools_image_upscale_max_output_pixels, 64_000_000, 4_000_000, 160_000_000),
    maxConcurrency: clampInt(config.tools_image_upscale_max_concurrency, 1, 1, 8),
    queueMaxPending: clampInt(config.tools_image_upscale_queue_max_pending, 8, 0, 200),
    queueMaxWaitMs: clampInt(config.tools_image_upscale_queue_timeout_sec, 30, 1, 600) * 1000,
    responseTransport: parseUpscaleResponseTransport(config.tools_image_upscale_response_transport),
  };
}

/** 用户鉴权：服务端图片工具必须登录，避免开放接口被匿名刷上游资源。 */
function authenticateUser(req: IncomingMessage): number | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token).sub; } catch { return undefined; }
}

/** 管理后台鉴权：工具统计属于运营数据，必须使用 admin JWT。 */
function authenticateAdmin(req: IncomingMessage): number | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    const payload = verifyAccessToken(token);
    return payload.role === 'admin' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/** 标准化工具 ID，防止任意 key 写入 system_configs。 */
function normalizeToolId(value: unknown): ToolId | null {
  return value === 'image-splitter' || value === 'image-converter' || value === 'image-scrambler' || value === 'image-wobble' || value === 'image-reverse' || value === 'image-upscale' ? value : null;
}

/** 标准化格式转换工具默认格式，配置异常时使用体积和兼容性均衡的 WebP。 */
function normalizeConvertFormat(value: unknown): NonNullable<ToolConfigView['convertDefaultFormat']> {
  return value === 'jpeg' || value === 'png' || value === 'webp' ? value : 'webp';
}

function usageTotalKey(toolId: ToolId): string {
  return `tools_usage_total_${toolId}`;
}

function usageTodayKey(toolId: ToolId, date: string): string {
  return `tools_usage_daily_${date}_${toolId}`;
}

function usageLastUsedKey(toolId: ToolId): string {
  return `tools_usage_last_${toolId}`;
}

/** 按中国时区生成日期键，后台“今日调用”与运营视角保持一致。 */
function formatChinaDateKey(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeIsoTime(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** 探测 GPU 服务健康接口；失败只进入 health 响应，不抛出影响管理后台页面。 */
async function probeImageUpscaleHealth(config: ImageUpscaleRuntimeConfig): Promise<ImageUpscaleHealthResponse['upstream']> {
  const checkedAt = new Date().toISOString();
  if (!config.baseUrl) return { ok: false, checkedAt, error: '未配置 GPU 服务地址' };
  try {
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      ok: response.ok && body.ok === true,
      statusCode: response.status,
      device: typeof body.device === 'string' ? body.device : undefined,
      cuda: typeof body.cuda === 'boolean' ? body.cuda : undefined,
      models: Array.isArray(body.models) ? body.models.filter((item): item is string => typeof item === 'string') : undefined,
      availableModels: Array.isArray(body.availableModels) ? body.availableModels.filter((item): item is string => typeof item === 'string') : undefined,
      weightFiles: Array.isArray(body.weightFiles) ? body.weightFiles.filter((item): item is string => typeof item === 'string') : undefined,
      modelCacheLimit: typeof body.modelCacheLimit === 'number' && Number.isFinite(body.modelCacheLimit) ? body.modelCacheLimit : undefined,
      checkedAt,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GPU 服务不可达';
    return { ok: false, checkedAt, error: message };
  }
}

/** 收敛 Base URL，避免拼接健康接口时产生双斜杠。 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/** 将配置字符串安全转为整数，避免后台误填导致工具页崩溃。 */
function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 读取后台配置里的默认反推模式。 */
function readReverseModeValue(value: string | undefined, fallback: ImageReverseMode): ImageReverseMode {
  const text = String(value ?? '').trim();
  if (text === 'prompt' || text === 'character' || text === 'tags' || text === 'edit') return text;
  return fallback;
}

/** 读取后台配置里的默认语言；旧 zh/en 和标准语言都允许。 */
function readReverseLanguageValue(value: string | undefined, fallback: ImageReversePublicDefaults['defaultLanguage']): ImageReversePublicDefaults['defaultLanguage'] {
  const text = String(value ?? '').trim();
  if (text === 'zh' || text === 'en' || text === 'zh-CN' || text === 'en-US' || text === 'ja-JP' || text === 'ko-KR' || text === 'zh-TW') return text;
  return fallback;
}
