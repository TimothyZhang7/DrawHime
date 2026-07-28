/**
 * 本文件注册按 QQ 号查询生成任务和站点配置的内部接口。
 */
import type { IncomingMessage } from 'node:http';
import {
  ApiErrorCode,
  normalizeDrawingModelType,
  resolveMaxReferenceImages,
  resolveReferenceImageField,
  resolveReferenceImageOverflowStrategy,
  supportsCombinedReferenceImage,
  type ApiSiteModelOption,
  type ApiSiteRuntimeConfig,
  type BotGenerationTaskListItem,
  type DrawingStatus,
} from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { buildRequestModelCanonicalMap, DRAWING_MODEL_SETTINGS_KEY, parseDrawingModelSettings } from './model-settings-service.js';

const prisma = getPrismaClient();

/** 注册所有 QQ 相关内部路由。 */
export function createGenerationQqRoutes(): Route[] {
  return [
    { method: 'GET', path: '/internal/generations/by-qq/:qqNumber', handle: listByQq },
    { method: 'GET', path: '/internal/generations/recent', handle: listRecent },
    { method: 'GET', path: '/internal/drawing-stats', handle: drawingStats },
    { method: 'GET', path: '/internal/sites/config', handle: getSitesConfig },
  ];
}

/** 按 QQ 号查询最近生成任务（Bot /任务 命令使用）。支持 ?status=success|failed|running 筛选。 */
async function listByQq(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const qqStr = params?.qqNumber ?? '';
  if (!/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const statusFilter = url.searchParams.get('status') ?? undefined;
  const qqNumber = BigInt(qqStr);
  const where: any = { qqNumber };
  if (statusFilter && ['success','failed','running','finalizing'].includes(statusFilter)) {
    // Bot 的“运行中”直觉上包含收尾投递中的任务。
    where.status = statusFilter === 'running' ? { in: ['running', 'finalizing'] } : statusFilter;
  }
  const [tasks, total] = await Promise.all([
    findBotTaskListItems(where, 20),
    prisma.generationTask.count({ where }),
  ]);
  return sendJson(res, 200, {
    ok: true,
    data: {
      items: tasks.map(toBotTaskListItem),
      total,
    },
  });
}

/** 管理员查全部用户最近任务（Bot /任务 all 命令使用）。支持 ?status=success|failed|running 筛选。 */
async function listRecent(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const statusFilter = url.searchParams.get('status') ?? undefined;
  const where: any = {};
  if (statusFilter && ['success','failed','running','finalizing'].includes(statusFilter)) {
    // 最近任务筛选同样把 finalizing 归到运行中，避免 Bot 任务列表漏掉正在投递最终图的任务。
    where.status = statusFilter === 'running' ? { in: ['running', 'finalizing'] } : statusFilter;
  }
  const [tasks, total] = await Promise.all([
    findBotTaskListItems(where, 30),
    prisma.generationTask.count({ where }),
  ]);
  return sendJson(res, 200, {
    ok: true,
    data: { items: tasks.map(toBotTaskListItem), total },
  });
}

/** 绘图统计 + 最近错误日志（Bot /info 命令使用）。 */
async function drawingStats(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(_req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [failed24h, recentErrors] = await Promise.all([
      prisma.generationTask.count({ where: { status: 'failed', createdAt: { gte: dayAgo } } }),
      prisma.generationTask.findMany({
        where: { status: 'failed' }, orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, prompt: true, error: true, createdAt: true },
      }),
    ]);
    return sendJson(res, 200, { ok: true, data: {
      failedTasks24h: failed24h,
      recentErrors: recentErrors.map(e => ({ prompt: e.prompt.slice(0, 80), error: e.error?.slice(0, 200) ?? '未知错误', createdAt: formatChinaDateTime(e.createdAt) })),
    }});
  } catch (e) { return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: (e as Error).message }); }
}

/** 内部接口：返回所有站点配置（含 API Key，由 drawing-service 使用）。 */
async function getSitesConfig(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const [sites, settingsRow] = await Promise.all([
    prisma.apiSite.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.systemConfig.findUnique({ where: { key: DRAWING_MODEL_SETTINGS_KEY }, select: { value: true } }),
  ]);
  const canonicalMap = buildRequestModelCanonicalMap(parseDrawingModelSettings(settingsRow?.value));
  // 内部站点配置按共享契约组装，防止 backend 与绘图程序字段理解不一致。
  const runtimeSites: ApiSiteRuntimeConfig[] = sites.map((s) => ({
    id: s.id,
    name: s.name,
    apiKey: s.apiKey,
    baseUrl: s.baseUrl,
    model: s.model,
    weight: s.weight,
    isEnabled: s.isEnabled,
    timeoutSec: s.timeoutSec,
    responseFormat: s.responseFormat,
    sendResponseFormat: s.sendResponseFormat,
    sendPromptCacheKey: s.sendPromptCacheKey,
    autoSizeFromReference: s.autoSizeFromReference,
    maxConcurrency: s.maxConcurrency,
    consecutiveFailures: s.consecutiveFailures,
    autoDisabledUntil: s.autoDisabledUntil ? formatChinaDateTime(s.autoDisabledUntil) : null,
    autoDisabledReason: s.autoDisabledReason,
    modelOptions: normalizeSiteModelOptions(s.modelOptions, s.model).map((option) => {
      const canonicalName = canonicalMap.get(option.name);
      return canonicalName && canonicalName !== option.name ? { ...option, canonicalName } : option;
    }),
  }));
  return sendJson(res, 200, {
    ok: true,
    data: {
      sites: runtimeSites,
    },
  });
}

/** 规范化内部站点模型配置，兼容旧后台保存的 image/text 字段，避免 worker 匹配失败。 */
function normalizeSiteModelOptions(raw: string | null, defaultModel: string): ApiSiteModelOption[] {
  let parsed: unknown = [];
  if (typeof raw === 'string' && raw.trim()) {
    try { parsed = JSON.parse(raw); } catch { parsed = []; }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    const name = defaultModel.trim();
    if (!name) return [];
    const fallback: ApiSiteModelOption = {
      name,
      type: normalizeDrawingModelType(undefined, name),
      apiMode: normalizeModelApiMode(undefined, name),
      enabled: true,
    };
    return [{
      ...fallback,
      maxReferenceImages: resolveMaxReferenceImages(fallback),
      referenceImageField: resolveReferenceImageField(fallback),
      referenceImageOverflowStrategy: resolveReferenceImageOverflowStrategy({
        maxReferenceImages: resolveMaxReferenceImages(fallback),
      }),
    }];
  }
  const options: ApiSiteModelOption[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? '').trim();
    if (!name) continue;
    const normalized: Record<string, unknown> = {
      ...record,
      name,
      type: normalizeDrawingModelType(record.type, name),
      apiMode: normalizeModelApiMode(record.apiMode, name),
      enabled: record.enabled !== false,
    };
    // 内部接口始终返回解析后的能力，worker 不需要依赖数据库是否已补齐新字段。
    const capabilityOption = normalized as ApiSiteModelOption;
    normalized.maxReferenceImages = resolveMaxReferenceImages(capabilityOption);
    normalized.referenceImageField = resolveReferenceImageField(capabilityOption);
    normalized.referenceImageOverflowStrategy = supportsCombinedReferenceImage(capabilityOption.apiMode)
      ? resolveReferenceImageOverflowStrategy({
        maxReferenceImages: normalized.maxReferenceImages as number,
        referenceImageOverflowStrategy: capabilityOption.referenceImageOverflowStrategy,
      })
      : 'reject';
    // 内部站点配置只暴露真实模型能力；外显名和别名统一由模型设置接口提供。
    delete normalized.label;
    options.push(normalized as ApiSiteModelOption);
  }
  return options;
}

/** 规范化模型调用协议；明确保留代理专用协议，避免后台保存后 worker 回退到错误端点。 */
function normalizeModelApiMode(value: unknown, _modelName: string): ApiSiteModelOption['apiMode'] {
  if (value === 'openai_images' || value === 'bfl_image_generation' || value === 'grok_image_edit_json' || value === 'grok_video_generation' || value === 'comfyui_generation') return value;
  // 内部配置遇到已废弃格式时按 OpenAI 格式兼容，确保协议集合与后台保存规则一致。
  return 'openai_images';
}

function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** Bot #任务列表只查询真实数据库字段，并在 backend 内聚合耗时、站点、模型和尝试次数。 */
function findBotTaskListItems(where: Record<string, unknown>, take: number) {
  return prisma.generationTask.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      status: true,
      prompt: true,
      mode: true,
      sourceImageUrls: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      error: true,
      chargedAmount: true,
      subTasks: {
        orderBy: { sequence: 'asc' },
        select: {
          kind: true,
          status: true,
          siteName: true,
          model: true,
          latencyMs: true,
          startedAt: true,
          finishedAt: true,
        },
      },
    },
  });
}

type BotTaskListRecord = Awaited<ReturnType<typeof findBotTaskListItems>>[number];

/** 将任务和子任务压缩为 QQ 图片卡片所需的简短真实摘要。 */
function toBotTaskListItem(task: BotTaskListRecord): BotGenerationTaskListItem {
  const attempts = task.subTasks.filter((item) => item.kind === 'upstream_attempt' && isRealUpstreamAttempt(item));
  const failedAttemptCount = attempts.filter((item) => item.status === 'failed').length;
  const lastAttempt = [...attempts].reverse().find((item) => item.siteName || item.model || item.latencyMs != null);
  const latencyMs = lastAttempt?.latencyMs ?? calculateElapsedMs(task.startedAt, task.finishedAt);
  const sourceImageUrls = Array.isArray(task.sourceImageUrls)
    ? task.sourceImageUrls.filter((item): item is string => typeof item === 'string')
    : [];
  const isFailed = task.status === 'failed';
  // 失败任务会在最终状态写入时按分账原路退款，Bot 任务菜单展示可用费用口径，不显示历史扣费额。
  const chargedAmount = isFailed ? '0.00' : task.chargedAmount ?? '0.00';
  return {
    id: task.id,
    status: task.status as DrawingStatus,
    prompt: task.prompt.slice(0, 160),
    mode: task.mode as BotGenerationTaskListItem['mode'],
    model: lastAttempt?.model ?? undefined,
    siteName: lastAttempt?.siteName ?? undefined,
    createdAt: formatChinaDateTime(task.createdAt),
    startedAt: task.startedAt ? formatChinaDateTime(task.startedAt) : undefined,
    finishedAt: task.finishedAt ? formatChinaDateTime(task.finishedAt) : undefined,
    latencyMs,
    attemptCount: attempts.length,
    failedAttemptCount,
    retryCount: Math.max(0, attempts.length - 1),
    imageCount: sourceImageUrls.length,
    charged: Number(chargedAmount) > 0,
    chargedAmount,
    error: task.error?.slice(0, 160),
  };
}

/** Bot 任务菜单只统计真实上游调用，过滤等待分配、覆盖占位和未发起的 queued 记录。 */
function isRealUpstreamAttempt(item: BotTaskListRecord['subTasks'][number]): boolean {
  if (item.status === 'queued') return false;
  if (item.status === 'skipped') return false;
  if (item.status === 'covered') return false;
  return Boolean(item.siteName || item.model || item.latencyMs != null || item.startedAt || item.finishedAt);
}

/** 任务未写入 latencyMs 时，用主任务开始/完成时间计算真实总耗时。 */
function calculateElapsedMs(startedAt?: Date | null, finishedAt?: Date | null): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const ms = finishedAt.getTime() - startedAt.getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
