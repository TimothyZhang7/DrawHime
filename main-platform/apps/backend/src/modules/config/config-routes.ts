/**
 * 本文件注册系统配置管理路由：批量读写、单项删除、AI 绘图配置。
 * 管理接口需要 admin JWT。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type DrawingModelListResponse, type DrawingPublicConfigResponse, type DrawingRuntimeConfigResponse, type MediaRuntimeConfigResponse } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { invalidateConfigCacheTags, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheAiImageConfig, cacheConfigAll, cacheConfigItem, cacheDrawingRuntimeConfig, cachePublicDrawingConfig } from '../../shared/cache/cache-policies.js';
import { CONFIG_KEYS, invalidateConfigCache } from '../../shared/config/config-service.js';
import {
  applyDrawingModelSettings,
  DRAWING_MODEL_SETTINGS_KEY,
  normalizeDrawingModelSettings,
  parseDrawingModelSettings,
  pickDefaultModel,
} from '../generations/model-settings-service.js';

const prisma = getPrismaClient();

/** Worker/Bot 运行时只需要这些配置键，不能读取整张 system_configs。 */
const DRAWING_RUNTIME_CONFIG_KEYS = [
  'drawing_site_request_retries',
  'drawing_retry_scope',
  'drawing_site_selection_mode',
  'drawing_retry_ignore_errors',
  'drawing_retry_notify_enabled',
  'drawing_bot_submitted_refs_enabled',
  'drawing_bot_failed_refs_enabled',
  'drawing_site_request_delay_ms',
  'drawing_auto_disable_threshold',
  'drawing_auto_disable_minutes',
  'drawing_default_size',
  'drawing_default_quality',
  'drawing_default_model',
  'drawing_default_moderation',
  'drawing_cooldown_seconds',
  'drawing_max_prompt_length',
  'drawing_block_during_generation',
  'drawing_request_timeout_ms',
  'free_balance_daily',
  'worker_poll_interval_ms',
  'worker_stale_task_minutes',
  'site_default_timeout_sec',
  'site_default_max_concurrency',
  'bot_cmd_prefix',
  'drawing_multi_enabled',
  'drawing_multi_count_max',
  'drawing_multi_concurrency',
  'drawing_multi_stop_after_consecutive_failures',
] as const;

/** 管理配置页只返回真实配置键，避免扫描 system_configs 中的任务元数据和运行流水键。 */
const CONFIG_MANAGEMENT_KEYS = [...new Set([
  ...Object.values(CONFIG_KEYS).map((item) => item.key),
  ...DRAWING_RUNTIME_CONFIG_KEYS,
  DRAWING_MODEL_SETTINGS_KEY,
  'bot_cmd_prefix',
  'bot_command_configs',
  'site_title',
  'site_background_enabled',
  'gallery_auto_tag_enabled',
  'gallery_auto_tag_private_enabled',
  'gallery_auto_tag_base_url',
  'gallery_auto_tag_api_key',
  'gallery_auto_tag_model',
  'gallery_auto_tag_timeout_sec',
  'gallery_auto_tag_max_tags',
  'gallery_auto_tag_max_attempts',
  'gallery_auto_tag_min_confidence',
  'gallery_auto_tag_system_prompt',
  'template_ai_enabled',
  'template_ai_base_url',
  'template_ai_api_key',
  'template_ai_model',
  'template_ai_temperature',
  'template_ai_timeout_ms',
  'template_ai_system_prompt',
  'workbench_ai_enabled',
  'workbench_ai_base_url',
  'workbench_ai_api_key',
  'workbench_ai_model',
  'workbench_ai_temperature',
  'workbench_ai_timeout_ms',
  'workbench_ai_system_prompt',
  'workbench_ai_max_output_chars',
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
  'referral_enabled',
  'referral_inviter_reward_paid',
  'referral_invitee_reward_paid',
  'referral_max_single_reward_paid',
  'referral_invite_url_template',
])] as const;

export function createConfigRoutes(): Route[] {
  return [
    { method: 'GET', path: '/admin/config', handle: getConfigs },
    { method: 'PUT', path: '/admin/config', handle: setConfigs },
    { method: 'GET', path: '/admin/config/:key', handle: getConfig },
    { method: 'PUT', path: '/admin/config/:key', handle: setConfig },
    { method: 'DELETE', path: '/admin/config/:key', handle: deleteConfig },
    { method: 'GET', path: '/admin/ai-image/config', handle: getAiImageConfig },
    { method: 'PUT', path: '/admin/ai-image/config', handle: setAiImageConfig },
    { method: 'GET', path: '/admin/drawing/model-settings', handle: getDrawingModelSettings },
    { method: 'PUT', path: '/admin/drawing/model-settings', handle: setDrawingModelSettings },
    { method: 'GET', path: '/api/drawing/config', handle: getPublicDrawingConfig },
    /** 内部接口：Worker 和 Bot 读取运行时绘图配置，服务间 token 鉴权 */
    { method: 'GET', path: '/internal/drawing-config', handle: getDrawingWorkerConfig },
    /** 内部接口：media-service 读取缩略图和图片限制配置，服务间 token 鉴权 */
    { method: 'GET', path: '/internal/media-config', handle: getMediaRuntimeConfig },
  ];
}

/** 管理端读取独立模型设置；已无站点的历史模型也必须保留展示。 */
async function getDrawingModelSettings(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  try {
    const [modelResponse, rows] = await Promise.all([
      fetchRawDrawingModels(),
      prisma.systemConfig.findMany({
        where: { key: { in: [DRAWING_MODEL_SETTINGS_KEY, 'drawing_default_model', 'drawing_price_per_gen', ...REFERENCE_PROMPT_ASSIST_CONFIG_KEYS, ...REFERENCE_PROMPT_ASSIST_FALLBACK_KEYS] } },
        select: { key: true, value: true },
      }),
    ]);
    const map = new Map(rows.map((item) => [item.key, item.value]));
    const fallbackPrice = Number(map.get('drawing_price_per_gen') ?? '0.05');
    const data = applyDrawingModelSettings(
      modelResponse,
      parseDrawingModelSettings(map.get(DRAWING_MODEL_SETTINGS_KEY), fallbackPrice),
      map.get('drawing_default_model'),
      { includeUnavailableSettings: true, fallbackPrice },
    );
    return sendJson(res, 200, { ok: true, data: { ...data, referencePromptAssistConfig: buildReferencePromptAssistAdminConfig(map) } });
  } catch (error) {
    return sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: error instanceof Error ? error.message : '绘图服务不可用' });
  }
}

/** 管理端保存独立模型设置；同时维护旧 drawing_default_model，保证未升级链路仍可回退。 */
async function setDrawingModelSettings(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const body = await readJsonBody<{ models?: unknown[]; defaultModel?: string; referencePromptAssistConfig?: Record<string, unknown> }>(req);
  const [rawModels, rows] = await Promise.all([
    fetchRawDrawingModels(),
    prisma.systemConfig.findMany({
      where: { key: { in: [DRAWING_MODEL_SETTINGS_KEY, 'drawing_price_per_gen', ...REFERENCE_PROMPT_ASSIST_CONFIG_KEYS, ...REFERENCE_PROMPT_ASSIST_FALLBACK_KEYS] } },
      select: { key: true, value: true },
    }),
  ]);
  const values = new Map(rows.map((item) => [item.key, item.value]));
  const fallbackPrice = Number(values.get('drawing_price_per_gen') ?? '0.05');
  const existingSettings = parseDrawingModelSettings(values.get(DRAWING_MODEL_SETTINGS_KEY), fallbackPrice);
  // 已无站点的历史模型仍允许保存；只拒绝从未登记过的任意伪造模型名。
  const allowed = new Set([...rawModels.models.map((item) => item.name), ...existingSettings.models.map((item) => item.name)]);
  const normalized = normalizeDrawingModelSettings(body.models ?? [], fallbackPrice)
    .filter((item) => allowed.has(item.name))
    // 请求模型名也必须来自站点或既有设置，避免任意字符串进入 Worker 调度映射。
    .map((item) => ({ ...item, requestModelNames: item.requestModelNames.filter((name) => allowed.has(name)) }));

  const requestedDefault = String(body.defaultModel ?? '').trim();
  let defaultAssigned = false;
  const models = normalized.map((item) => {
    const isDefault = !defaultAssigned && ((requestedDefault && item.name === requestedDefault) || item.isDefault);
    if (isDefault) defaultAssigned = true;
    return { ...item, isDefault };
  });
  const defaultModel = pickDefaultModel(
    rawModels.models,
    { models },
    requestedDefault || undefined,
  );
  const finalModels = models.map((item) => ({ ...item, isDefault: Boolean(defaultModel && item.name === defaultModel) }));

  const configWrites = buildReferencePromptAssistConfigWrites(body.referencePromptAssistConfig, values);
  await prisma.$transaction([
    prisma.systemConfig.upsert({
      where: { key: DRAWING_MODEL_SETTINGS_KEY },
      update: { value: JSON.stringify({ models: finalModels }) },
      create: { key: DRAWING_MODEL_SETTINGS_KEY, value: JSON.stringify({ models: finalModels }) },
    }),
    prisma.systemConfig.upsert({
      where: { key: 'drawing_default_model' },
      update: { value: defaultModel ?? '' },
      create: { key: 'drawing_default_model', value: defaultModel ?? '' },
    }),
    ...configWrites.map(({ key, value }) => prisma.systemConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    })),
  ]);
  // 模型设置影响前台/Bot 外显顺序、别名解析和默认模型，保存后必须同时清理配置和模型缓存。
  invalidateConfigCache();
  invalidateConfigCacheTags();
  const configMap = new Map(values);
  for (const item of configWrites) configMap.set(item.key, item.value);
  return sendJson(res, 200, { ok: true, data: { models: finalModels, defaultModel, referencePromptAssistConfig: buildReferencePromptAssistAdminConfig(configMap) } });
}

/** 参考图提示增强专用外部 AI 配置键；密钥只返回是否已配置。 */
const REFERENCE_PROMPT_ASSIST_CONFIG_KEYS = [
  'drawing_reference_prompt_assist_base_url',
  'drawing_reference_prompt_assist_api_key',
  'drawing_reference_prompt_assist_model',
  'drawing_reference_prompt_assist_timeout_sec',
  'drawing_reference_prompt_assist_max_file_size_mb',
  'drawing_reference_prompt_assist_max_output_chars',
] as const;

/** 专用配置尚未填写时读取现有反推端点作为迁移期真实兜底。 */
const REFERENCE_PROMPT_ASSIST_FALLBACK_KEYS = [
  'tools_image_reverse_base_url',
  'tools_image_reverse_api_key',
  'tools_image_reverse_model',
] as const;

/** 构建管理端安全配置视图，不回传 API Key 明文。 */
function buildReferencePromptAssistAdminConfig(values: Map<string, string>) {
  return {
    baseUrl: String(values.get('drawing_reference_prompt_assist_base_url') ?? '').trim() || String(values.get('tools_image_reverse_base_url') ?? '').trim(),
    apiKeyConfigured: Boolean(values.get('drawing_reference_prompt_assist_api_key')?.trim() || values.get('tools_image_reverse_api_key')?.trim()),
    model: String(values.get('drawing_reference_prompt_assist_model') ?? '').trim() || String(values.get('tools_image_reverse_model') ?? 'gpt-5.6-sol'),
    timeoutSec: clampConfigInteger(values.get('drawing_reference_prompt_assist_timeout_sec'), 90, 10, 90),
    maxFileSizeMb: clampConfigInteger(values.get('drawing_reference_prompt_assist_max_file_size_mb'), 20, 1, 100),
    maxOutputChars: clampConfigInteger(values.get('drawing_reference_prompt_assist_max_output_chars'), 5000, 500, 50_000),
  };
}

/** 规范化管理端提交的专用配置；API Key 留空时保留生产现值。 */
function buildReferencePromptAssistConfigWrites(raw: Record<string, unknown> | undefined, existing: Map<string, string>) {
  if (!raw) return [];
  const writes = [
    { key: 'drawing_reference_prompt_assist_base_url', value: String(raw.baseUrl ?? '').trim().replace(/\/+$/, '') },
    { key: 'drawing_reference_prompt_assist_model', value: String(raw.model ?? 'gpt-5.6-sol').trim() || 'gpt-5.6-sol' },
    { key: 'drawing_reference_prompt_assist_timeout_sec', value: String(clampConfigInteger(raw.timeoutSec, 90, 10, 90)) },
    { key: 'drawing_reference_prompt_assist_max_file_size_mb', value: String(clampConfigInteger(raw.maxFileSizeMb, 20, 1, 100)) },
    { key: 'drawing_reference_prompt_assist_max_output_chars', value: String(clampConfigInteger(raw.maxOutputChars, 5000, 500, 50_000)) },
  ];
  const apiKey = String(raw.apiKey ?? '').trim();
  if (apiKey) writes.push({ key: 'drawing_reference_prompt_assist_api_key', value: apiKey });
  else if (!existing.has('drawing_reference_prompt_assist_api_key')) {
    // 新配置没有密钥时不创建空密钥记录，后端会明确提示配置不完整。
  }
  return writes;
}

/** 读取有界整数配置，避免异常管理端输入扩大同步请求范围。 */
function clampConfigInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** 从 drawing-service 读取真实可用模型列表，管理端只在此基础上做外显配置。 */
async function fetchRawDrawingModels() {
  const drawingUrl = process.env.DRAWING_SERVICE_URL ?? 'http://localhost:3005';
  const response = await fetch(`${drawingUrl}/api/drawing/models`, { signal: AbortSignal.timeout(5000) });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; data?: unknown; message?: string };
  if (!response.ok || body.ok !== true || !body.data || !Array.isArray((body.data as { models?: unknown }).models)) {
    throw new Error(body.message ?? `绘图服务返回 HTTP ${response.status}`);
  }
  return body.data as DrawingModelListResponse;
}

/** 用户端读取绘图公开配置；只暴露交互所需限制，不返回管理端敏感项。 */
async function getPublicDrawingConfig(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const cached = await cachePublicDrawingConfig(async (): Promise<DrawingPublicConfigResponse> => {
    const configs = await prisma.systemConfig.findMany({
      where: { key: { in: ['drawing_multi_enabled', 'drawing_multi_count_max', 'drawing_max_prompt_length'] } },
      select: { key: true, value: true },
    });
    const map = new Map(configs.map((item) => [item.key, item.value]));
    return {
      multiEnabled: map.get('drawing_multi_enabled') !== 'false',
      multiCountMax: Math.min(Math.max(Number(map.get('drawing_multi_count_max') ?? '4') || 4, 1), 20),
      maxPromptLength: Math.min(Math.max(Number(map.get('drawing_max_prompt_length') ?? '5000') || 5000, 100), 50000),
    };
  });
  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: cached.value });
}

/** 批量读取系统配置。 */
async function getConfigs(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const cached = await cacheConfigAll(async () => {
    const configs = await prisma.systemConfig.findMany({
      where: { key: { in: [...CONFIG_MANAGEMENT_KEYS] } },
    });
    const result: Record<string, string> = {};
    for (const c of configs) result[c.key] = c.value;
    return result;
  });
  setBackendCacheHeader(res, cached.status);
  const result = cached.value;
  return sendJson(res, 200, { ok: true, data: result });
}

/** 批量保存系统配置。 */
async function setConfigs(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const body = await readJsonBody<Record<string, string>>(req);
  const entries = Object.entries(body).filter(([, v]) => typeof v === 'string');
  for (const [key, value] of entries) {
    await prisma.systemConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
  // 配置写入成功后清理通用缓存和既有配置服务缓存，保证 Bot/Worker 下次轮询拿到最新值。
  invalidateConfigCache();
  invalidateConfigCacheTags();
  return sendJson(res, 200, { ok: true, data: { saved: entries.length } });
}

/** 读取单项系统配置。 */
async function getConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const key = params?.key ?? '';
  const cached = await cacheConfigItem(key, () => prisma.systemConfig.findUnique({ where: { key }, select: { key: true, value: true } }));
  setBackendCacheHeader(res, cached.status);
  const row = cached.value;
  if (!row) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '配置项不存在' });
  return sendJson(res, 200, { ok: true, data: { key: row.key, value: row.value } });
}

/** 写入单项系统配置。 */
async function setConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const key = params?.key ?? '';
  const body = await readJsonBody<{ value?: string }>(req);
  if (typeof body.value !== 'string') return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少 value 字段' });
  await prisma.systemConfig.upsert({ where: { key }, update: { value: body.value }, create: { key, value: body.value } });
  invalidateConfigCache();
  invalidateConfigCacheTags();
  return sendJson(res, 200, { ok: true, data: { key, value: body.value, saved: true } });
}

/** 删除单项系统配置。 */
async function deleteConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const key = params?.key ?? '';
  await prisma.systemConfig.deleteMany({ where: { key } });
  invalidateConfigCache();
  invalidateConfigCacheTags();
  return sendJson(res, 200, { ok: true, data: { deleted: true } });
}

/** 读取 AI 绘图全局配置。 */
async function getAiImageConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const cached = await cacheAiImageConfig(async () => {
    const entries = await prisma.systemConfig.findMany({
      where: { key: { startsWith: 'drawing_' } },
    });
    const config: Record<string, string> = {};
    for (const e of entries) config[e.key] = e.value;
    return config;
  });
  setBackendCacheHeader(res, cached.status);
  const config = cached.value;
  return sendJson(res, 200, {
    ok: true,
    data: {
      retryScope: config.drawing_retry_scope ?? 'all_enabled',
      siteSelectionMode: config.drawing_site_selection_mode ?? 'random',
      retryIgnoreErrors: config.drawing_retry_ignore_errors === 'true',
      botSubmittedRefsEnabled: config.drawing_bot_submitted_refs_enabled === 'true',
      botFailedRefsEnabled: config.drawing_bot_failed_refs_enabled !== 'false',
      autoDisableFailureThreshold: Number(config.drawing_auto_disable_threshold ?? '5'),
      autoDisableMinutes: Number(config.drawing_auto_disable_minutes ?? '60'),
      defaultSize: config.drawing_default_size ?? '1024x1024',
      defaultQuality: config.drawing_default_quality ?? 'standard',
      defaultModeration: config.drawing_default_moderation ?? 'auto',
      defaultModel: config.drawing_default_model ?? '',
      cooldownSeconds: Number(config.drawing_cooldown_seconds ?? '90'),
      blockDuringGeneration: config.drawing_block_during_generation !== 'false',
      maxPromptLength: Number(config.drawing_max_prompt_length ?? '5000'),
      multiEnabled: config.drawing_multi_enabled !== 'false',
      multiCountMax: Number(config.drawing_multi_count_max ?? '4'),
      multiConcurrency: Number(config.drawing_multi_concurrency ?? '2'),
      multiStopAfterConsecutiveFailures: Number(config.drawing_multi_stop_after_consecutive_failures ?? '2'),
    },
  });
}

/** 更新 AI 绘图全局配置。 */
async function setAiImageConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const body = await readJsonBody<Record<string, unknown>>(req);
  const entries: [string, string][] = [];
  if (typeof body.retryScope === 'string') entries.push(['drawing_retry_scope', body.retryScope]);
  if (typeof body.siteSelectionMode === 'string') entries.push(['drawing_site_selection_mode', body.siteSelectionMode]);
  if (typeof body.retryIgnoreErrors === 'boolean') entries.push(['drawing_retry_ignore_errors', String(body.retryIgnoreErrors)]);
  if (typeof body.botSubmittedRefsEnabled === 'boolean') entries.push(['drawing_bot_submitted_refs_enabled', String(body.botSubmittedRefsEnabled)]);
  if (typeof body.botFailedRefsEnabled === 'boolean') entries.push(['drawing_bot_failed_refs_enabled', String(body.botFailedRefsEnabled)]);
  if (typeof body.autoDisableFailureThreshold === 'number') entries.push(['drawing_auto_disable_threshold', String(body.autoDisableFailureThreshold)]);
  if (typeof body.autoDisableMinutes === 'number') entries.push(['drawing_auto_disable_minutes', String(body.autoDisableMinutes)]);
  if (typeof body.defaultSize === 'string') entries.push(['drawing_default_size', body.defaultSize]);
  if (typeof body.defaultQuality === 'string') entries.push(['drawing_default_quality', body.defaultQuality]);
  if (typeof body.defaultModeration === 'string') entries.push(['drawing_default_moderation', body.defaultModeration]);
  if (typeof body.defaultModel === 'string') entries.push(['drawing_default_model', body.defaultModel]);
  if (typeof body.cooldownSeconds === 'number') entries.push(['drawing_cooldown_seconds', String(body.cooldownSeconds)]);
  if (typeof body.blockDuringGeneration === 'boolean') entries.push(['drawing_block_during_generation', String(body.blockDuringGeneration)]);
  if (typeof body.maxPromptLength === 'number') entries.push(['drawing_max_prompt_length', String(body.maxPromptLength)]);
  if (typeof body.multiEnabled === 'boolean') entries.push(['drawing_multi_enabled', String(body.multiEnabled)]);
  if (typeof body.multiCountMax === 'number') entries.push(['drawing_multi_count_max', String(body.multiCountMax)]);
  if (typeof body.multiConcurrency === 'number') entries.push(['drawing_multi_concurrency', String(body.multiConcurrency)]);
  if (typeof body.multiStopAfterConsecutiveFailures === 'number') entries.push(['drawing_multi_stop_after_consecutive_failures', String(body.multiStopAfterConsecutiveFailures)]);

  for (const [key, value] of entries) {
    await prisma.systemConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  invalidateConfigCache();
  invalidateConfigCacheTags();
  return sendJson(res, 200, { ok: true, data: { saved: entries.length } });
}

/** Worker 和 Bot 读取运行时绘图配置：从 system_configs 读取，带默认值兜底。 */
async function getDrawingWorkerConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const cached = await cacheDrawingRuntimeConfig(async () => {
    const configs = await prisma.systemConfig.findMany({
      where: { key: { in: [...DRAWING_RUNTIME_CONFIG_KEYS] } },
      select: { key: true, value: true },
    });
    const c: Record<string, string> = {};
    for (const item of configs) c[item.key] = item.value;
    const data: DrawingRuntimeConfigResponse = {
      // 同站请求级重试次数（独立于换站次数，避免一个值控两个维度）
      siteRequestRetries: Number(c.drawing_site_request_retries ?? '1'),
      retryScope: (c.drawing_retry_scope ?? 'all_enabled') as 'single_site' | 'all_enabled',
      siteSelectionMode: (c.drawing_site_selection_mode ?? 'random') as 'weighted' | 'random',
      ignoreErrors: c.drawing_retry_ignore_errors === 'true',
      retryNotifyEnabled: c.drawing_retry_notify_enabled !== 'false', // 默认开启
      // Bot 提交卡和最终失败卡默认展示参考图；关闭后仍保留参考图数量，只跳过图片解码渲染。
      botSubmittedRefsEnabled: c.drawing_bot_submitted_refs_enabled === 'true',
      botFailedRefsEnabled: c.drawing_bot_failed_refs_enabled !== 'false',
      siteRequestDelayMs: Number(c.drawing_site_request_delay_ms ?? '2000'),
      // 站点管理
      autoDisableThreshold: Number(c.drawing_auto_disable_threshold ?? '5'),
      autoDisableMinutes: Number(c.drawing_auto_disable_minutes ?? '60'),
      // 生成参数（默认值与 admin 表单一致：auto）
      defaultSize: c.drawing_default_size ?? 'auto',
      defaultQuality: c.drawing_default_quality ?? 'auto',
      defaultModel: c.drawing_default_model ?? '',
      defaultModeration: c.drawing_default_moderation ?? 'auto',
      cooldownSeconds: Number(c.drawing_cooldown_seconds ?? '90'),
      maxPromptLength: Number(c.drawing_max_prompt_length ?? '5000'),
      blockDuringGeneration: c.drawing_block_during_generation !== 'false',
      // 上游请求超时；模型价格由独立模型配置读取，不再下发全局单价。
      requestTimeoutMs: Number(c.drawing_request_timeout_ms ?? '30000'),
      freeBalanceDaily: Number(c.free_balance_daily ?? '1.2'),
      // Worker 运维
      pollIntervalMs: Number(c.worker_poll_interval_ms ?? '2000'),
      staleTaskMinutes: Number(c.worker_stale_task_minutes ?? '30'),
      // 站点默认值
      siteDefaultTimeoutSec: Number(c.site_default_timeout_sec ?? '300'),
      siteDefaultMaxConcurrency: Number(c.site_default_max_concurrency ?? '10'),
      // Bot 命令前缀（唯一配置入口，DB system_configs.bot_cmd_prefix）
      botCmdPrefix: c.bot_cmd_prefix ?? '#',
      // 多图生成配置由 backend 统一下发，Web、Bot 和 Worker 使用同一口径。
      multiEnabled: c.drawing_multi_enabled !== 'false',
      multiCountMax: Math.min(Math.max(Number(c.drawing_multi_count_max ?? '4') || 4, 1), 20),
      multiConcurrency: Math.min(Math.max(Number(c.drawing_multi_concurrency ?? '2') || 2, 1), 20),
      multiStopAfterConsecutiveFailures: Math.min(Math.max(Number(c.drawing_multi_stop_after_consecutive_failures ?? '2') || 2, 1), 20),
    };
    return data;
  });
  setBackendCacheHeader(res, cached.status);
  const data = cached.value;
  return sendJson(res, 200, { ok: true, data });
}

/** media-service 读取运行时媒体配置：后台 system_configs 优先，保证媒体配置保存后真实生效。 */
async function getMediaRuntimeConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const configs = await prisma.systemConfig.findMany({
    where: { key: { in: ['thumbnail_width', 'thumbnail_quality', 'image_max_file_size_mb', 'image_max_resolution'] } },
    select: { key: true, value: true },
  });
  const c = new Map(configs.map((item) => [item.key, item.value]));
  const imageMaxFileSizeMb = clampNumber(c.get('image_max_file_size_mb'), 20, 1, 100);
  const data: MediaRuntimeConfigResponse = {
    thumbnailWidth: Math.round(clampNumber(c.get('thumbnail_width'), 400, 64, 2048)),
    thumbnailQuality: Math.round(clampNumber(c.get('thumbnail_quality'), 80, 30, 95)),
    imageMaxFileSizeBytes: Math.round(imageMaxFileSizeMb * 1024 * 1024),
    imageMaxResolution: Math.round(clampNumber(c.get('image_max_resolution'), 8192, 512, 16384)),
    referenceTaskInputMaxBytes: Number(process.env.REFERENCE_TASK_INPUT_MAX_BYTES ?? String(3 * 1024 * 1024)),
  };
  return sendJson(res, 200, { ok: true, data });
}

/** 读取数值配置并限制范围，避免后台误填影响 media-service 稳定性。 */
function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/** 校验服务间 token */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}

function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    const payload = verifyAccessToken(token);
    return payload.role === 'admin' ? payload : undefined;
  } catch { return undefined; }
}
