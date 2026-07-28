/** 本文件负责图片反推的同步兼容接口与用户端异步任务接口。 */
import type { IncomingMessage } from 'node:http';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import {
  ApiErrorCode,
  type ImageReverseExtractOptions,
  type ImageReverseExtractResponse,
  type ImageReverseJobCreateResponse,
  type ImageReverseJobDetailResponse,
  type ImageReverseJobListResponse,
  type ImageReverseMode,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { BinaryBodyTooLargeError, readBinaryBody } from './binary-request-body.js';
import { ImageReverseJobQueueError, ImageReverseJobService } from './image-reverse-job-service.js';
import { ImageReverseSourceStorageError } from './image-reverse-source-storage.js';
import { buildLegacyImageReverseOptions, normalizeImageReverseOptions, parseEnabledReverseLanguages, parseEnabledReverseModes, type ImageReversePublicDefaults } from './image-reverse-options.js';
import { ImageReverseError, ImageReverseService, type ImageReverseRuntimeConfig } from './image-reverse-service.js';

const prisma = getPrismaClient();
const imageReverseService = new ImageReverseService();
const imageReverseJobService = new ImageReverseJobService(imageReverseService);

/** 图片反推路由成功回调依赖。 */
export interface ImageReverseRouteDependencies {
  /** 每次真实反推成功后执行，用于更新聚合调用统计。 */
  onSucceeded: () => Promise<void> | void;
}

/** 注册图片反推同步兼容入口和用户端异步任务入口。 */
export function createImageReverseRoutes(dependencies: ImageReverseRouteDependencies): Route[] {
  imageReverseJobService.startRecovery(readImageReverseConfig, dependencies.onSucceeded);
  return [
    { method: 'POST', path: '/api/tools/image-reverse/extract', handle: (req, res) => extractImageReverse(req, res, dependencies) },
    { method: 'POST', path: '/internal/tools/image-reverse/extract', handle: (req, res) => extractImageReverseInternal(req, res, dependencies) },
    { method: 'POST', path: '/api/tools/image-reverse/jobs', handle: (req, res) => createImageReverseJob(req, res, dependencies) },
    { method: 'GET', path: '/api/tools/image-reverse/jobs', handle: listImageReverseJobs },
    { method: 'GET', path: '/api/tools/image-reverse/jobs/:jobId/source', handle: serveImageReverseJobSource },
    { method: 'GET', path: '/api/tools/image-reverse/jobs/:jobId', handle: getImageReverseJob },
  ];
}

/** 用户端同步兼容接口；新版网页使用异步任务接口避免长连接中断。 */
async function extractImageReverse(req: IncomingMessage, res: Parameters<typeof sendJson>[0], dependencies: ImageReverseRouteDependencies) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  return extractImageReverseWithConfig(req, res, dependencies);
}

/** Bot 内部图片反推接口：使用 service token，供 QQ 命令复用真实反推链路。 */
async function extractImageReverseInternal(req: IncomingMessage, res: Parameters<typeof sendJson>[0], dependencies: ImageReverseRouteDependencies) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务令牌无效' });
  return extractImageReverseWithConfig(req, res, dependencies);
}

/** 执行同步图片反推公共流程；仅为旧客户端和内部 Bot 保留。 */
async function extractImageReverseWithConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0], dependencies: ImageReverseRouteDependencies) {
  const config = await readImageReverseConfig();
  const mimeType = readMimeType(req);
  try {
    const options = readReverseOptions(req, config);
    const buffer = await readBinaryBody(req, config.maxFileSizeMb * 1024 * 1024);
    const result = await imageReverseService.extract(buffer, mimeType, config, options);
    await dependencies.onSucceeded();
    const payload: ImageReverseExtractResponse = { result };
    return sendJson(res, 200, { ok: true, data: payload });
  } catch (error) {
    return sendImageReverseError(res, error);
  }
}

/** 创建图片反推异步任务：上传结束后立即返回任务 ID，识图在 backend 队列中继续执行。 */
async function createImageReverseJob(req: IncomingMessage, res: Parameters<typeof sendJson>[0], dependencies: ImageReverseRouteDependencies) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const config = await readImageReverseConfig();
  try {
    const options = readReverseOptions(req, config);
    const buffer = await readBinaryBody(req, config.maxFileSizeMb * 1024 * 1024);
    const job = await imageReverseJobService.submit({
      userId,
      imageBuffer: buffer,
      mimeType: readMimeType(req),
      sourceFileName: readSourceFileName(req),
      config,
      options,
      onSucceeded: dependencies.onSucceeded,
    });
    const payload: ImageReverseJobCreateResponse = { job };
    return sendJson(res, 202, { ok: true, data: payload });
  } catch (error) {
    return sendImageReverseError(res, error);
  }
}

/** 列出当前用户近期图片反推历史，列表不携带完整结果 JSON。 */
async function listImageReverseJobs(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const payload: ImageReverseJobListResponse = { jobs: await imageReverseJobService.listJobs(userId) };
  return sendJson(res, 200, { ok: true, data: payload });
}

/** 查询当前登录用户自己的图片反推任务，浏览器通过短轮询取得终态。 */
async function getImageReverseJob(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const jobId = String(params?.jobId ?? '').trim();
  if (!jobId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '任务 ID 不正确' });
  const job = await imageReverseJobService.getJob(userId, jobId);
  if (!job) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '任务不存在' });
  const payload: ImageReverseJobDetailResponse = { job };
  return sendJson(res, 200, { ok: true, data: payload });
}

/** 鉴权输出历史任务的私有源图或轻量预览，不暴露本地文件路径。 */
async function serveImageReverseJobSource(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const jobId = String(params?.jobId ?? '').trim();
  if (!jobId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '任务 ID 不正确' });
  const preview = new URL(req.url ?? '/', 'http://localhost').searchParams.get('preview') === '1';
  const served = await imageReverseJobService.serveSource(userId, jobId, preview, res);
  if (!served) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '源图不存在' });
}

/** 统一映射同步接口和异步创建接口的图片反推错误。 */
function sendImageReverseError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof BinaryBodyTooLargeError) {
    return sendJson(res, 413, { ok: false, code: ApiErrorCode.BadRequest, message: `图片大小不能超过 ${Math.round(error.limitBytes / 1024 / 1024)}MB` });
  }
  if (error instanceof ImageReverseJobQueueError) {
    return sendJson(res, 429, { ok: false, code: ApiErrorCode.RateLimited, message: error.message });
  }
  if (error instanceof ImageReverseSourceStorageError) {
    const code = error.status >= 500 ? ApiErrorCode.InternalError : ApiErrorCode.BadRequest;
    return sendJson(res, error.status, { ok: false, code, message: error.message });
  }
  if (error instanceof ImageReverseError) {
    const code = error.status === 403 ? ApiErrorCode.Forbidden : error.status >= 500 ? ApiErrorCode.InternalError : ApiErrorCode.BadRequest;
    return sendJson(res, error.status, { ok: false, code, message: error.message });
  }
  const message = error instanceof Error ? error.message : '图片反推失败';
  return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message });
}

/** 从请求头读取完整反推选项；旧客户端只传 mode 时自动补齐默认配置。 */
function readReverseOptions(req: IncomingMessage, config: ImageReverseRuntimeConfig): ImageReverseExtractOptions {
  const raw = req.headers['x-aiimage-reverse-options'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text) {
    try {
      return normalizeImageReverseOptions(JSON.parse(text), config.defaults);
    } catch {
      throw new ImageReverseError('invalid_options', '图片反推选项格式不正确', 400);
    }
  }
  return buildLegacyImageReverseOptions(readReverseMode(req.headers['x-aiimage-reverse-mode']), config.defaults);
}

/** 读取图片反推私有运行时配置；密钥和 Base URL 不进入公开工具配置接口。 */
export async function readImageReverseConfig(): Promise<ImageReverseRuntimeConfig> {
  const keys = [
    'tools_image_reverse_enabled',
    'tools_image_reverse_base_url',
    'tools_image_reverse_api_key',
    'tools_image_reverse_model',
    'tools_image_reverse_max_file_size_mb',
    'tools_image_reverse_timeout_sec',
    'tools_image_reverse_max_output_chars',
    'tools_image_reverse_system_prompt',
    'tools_image_reverse_default_mode',
    'tools_image_reverse_default_language',
    'tools_image_reverse_default_prompt_language',
    'tools_image_reverse_enabled_modes',
    'tools_image_reverse_enabled_languages',
    'tools_image_reverse_wd14_enabled',
    'tools_image_reverse_wd14_base_url',
    'tools_image_reverse_wd14_api_key',
    'tools_image_reverse_wd14_model',
    'tools_image_reverse_wd14_timeout_sec',
    'tools_image_reverse_wd14_general_threshold',
    'tools_image_reverse_wd14_character_threshold',
    'tools_image_reverse_wd14_max_tags',
  ];
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const wd14 = {
    enabled: config.tools_image_reverse_wd14_enabled === 'true',
    baseUrl: String(config.tools_image_reverse_wd14_base_url ?? '').trim(),
    apiKey: String(config.tools_image_reverse_wd14_api_key ?? '').trim(),
    model: String(config.tools_image_reverse_wd14_model ?? 'wd-eva02-large-tagger-v3').trim() || 'wd-eva02-large-tagger-v3',
    timeoutSec: clampInt(config.tools_image_reverse_wd14_timeout_sec, 120, 5, 600),
    generalThreshold: clampFloat(config.tools_image_reverse_wd14_general_threshold, 0.35, 0.01, 1),
    characterThreshold: clampFloat(config.tools_image_reverse_wd14_character_threshold, 0.85, 0.01, 1),
    maxTags: clampInt(config.tools_image_reverse_wd14_max_tags, 300, 1, 500),
  };
  return {
    enabled: config.tools_image_reverse_enabled === 'true',
    baseUrl: String(config.tools_image_reverse_base_url ?? '').trim(),
    apiKey: String(config.tools_image_reverse_api_key ?? '').trim(),
    model: String(config.tools_image_reverse_model ?? 'gpt-5.6-sol').trim() || 'gpt-5.6-sol',
    maxFileSizeMb: clampInt(config.tools_image_reverse_max_file_size_mb, 20, 1, 100),
    timeoutSec: clampInt(config.tools_image_reverse_timeout_sec, 300, 5, 600),
    maxOutputChars: clampInt(config.tools_image_reverse_max_output_chars, 6000, 500, 20000),
    systemPrompt: String(config.tools_image_reverse_system_prompt ?? ImageReverseService.defaultSystemPrompt).trim() || ImageReverseService.defaultSystemPrompt,
    defaults: {
      defaultMode: readReverseModeValue(config.tools_image_reverse_default_mode, 'description'),
      defaultLanguage: readReverseLanguageValue(config.tools_image_reverse_default_language, 'zh'),
      defaultPromptLanguage: String(config.tools_image_reverse_default_prompt_language ?? 'auto').trim() as ImageReversePublicDefaults['defaultPromptLanguage'],
      enabledModes: parseEnabledReverseModes(config.tools_image_reverse_enabled_modes),
      enabledLanguages: parseEnabledReverseLanguages(config.tools_image_reverse_enabled_languages),
      hybridAvailable: wd14.enabled && Boolean(wd14.baseUrl && wd14.apiKey),
    },
    wd14,
  };
}

/** 用户鉴权：反推不扣费，但必须登录，避免开放接口被匿名刷上游额度。 */
function authenticateUser(req: IncomingMessage): number | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token).sub; } catch { return undefined; }
}

/** 校验服务间 token；仅显式开发或测试环境允许缺省调试。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}

function readMimeType(req: IncomingMessage): string {
  return String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** 从请求头读取用户原始文件名；值只用于历史展示，业务服务还会再次清理。 */
function readSourceFileName(req: IncomingMessage): string {
  const raw = Array.isArray(req.headers['x-aiimage-file-name']) ? req.headers['x-aiimage-file-name'][0] : req.headers['x-aiimage-file-name'];
  const value = String(raw ?? '').trim();
  if (!value) return 'image';
  try { return decodeURIComponent(value); } catch { return value; }
}

function readReverseMode(value: IncomingMessage['headers'][string]): ImageReverseMode {
  const raw = Array.isArray(value) ? value[0] : value;
  const mode = String(raw ?? '').trim();
  if (mode === 'prompt' || mode === 'character' || mode === 'tags' || mode === 'edit') return mode;
  return 'description';
}

function readReverseModeValue(value: string | undefined, fallback: ImageReverseMode): ImageReverseMode {
  const text = String(value ?? '').trim();
  if (text === 'prompt' || text === 'character' || text === 'tags' || text === 'edit') return text;
  return fallback;
}

function readReverseLanguageValue(value: string | undefined, fallback: ImageReversePublicDefaults['defaultLanguage']): ImageReversePublicDefaults['defaultLanguage'] {
  const text = String(value ?? '').trim();
  if (text === 'zh' || text === 'en' || text === 'zh-CN' || text === 'en-US' || text === 'ja-JP' || text === 'ko-KR' || text === 'zh-TW') return text;
  return fallback;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampFloat(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(value ?? '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
