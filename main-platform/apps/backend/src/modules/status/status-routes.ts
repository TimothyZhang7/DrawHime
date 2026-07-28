/** 本文件注册公开状态页路由，所有数据均来自真实健康检查和数据库聚合，不返回伪造统计。 */
import type { IncomingMessage } from 'node:http';
import { sendJson, type Route } from '@aiimage/core-utils';
import { Prisma } from '@prisma/client';
import type {
  PublicBotSummary,
  PublicPlatformSummary,
  PublicServiceHealthView,
  PublicSiteRuntimeView,
  PublicSourceSummary,
  PublicStatusRange,
  PublicStatusResponse,
  PublicTaskStatusSummary,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cachePublicStatus } from '../../shared/cache/cache-policies.js';

const prisma = getPrismaClient();

/** 创建公开状态页路由。 */
export function createStatusRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/status', handle: getPublicStatus },
  ];
}

/** 读取公开状态页数据，统计口径必须保持可审计：健康来自 /health，业务统计来自数据库聚合。 */
async function getPublicStatus(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const range = normalizeRange(url.searchParams.get('range'));
  const cached = await cachePublicStatus(range, () => buildPublicStatus(range));
  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: cached.value });
}

/** 构建公开状态页响应体。 */
async function buildPublicStatus(range: PublicStatusRange): Promise<PublicStatusResponse> {
  const since = new Date(Date.now() - rangeToMs(range));
  const [services, tasks, sources, sites, bots, platform] = await Promise.all([
    collectServiceHealth(),
    collectTaskSummary(since),
    collectSourceSummary(since),
    collectSiteRuntime(since),
    collectBotSummary(),
    collectPlatformSummary(),
  ]);

  return {
    range,
    since: since.toISOString(),
    generatedAt: new Date().toISOString(),
    services,
    tasks,
    sources,
    sites,
    bots,
    platform,
  };
}

/** 聚合内部服务健康状态，backend 自身使用当前进程数据，其余服务走内部 /health。 */
async function collectServiceHealth(): Promise<PublicServiceHealthView[]> {
  const services = [
    { name: 'backend', label: '后端', url: null },
    { name: 'drawing-service', label: '绘图调度', url: `${process.env.DRAWING_SERVICE_URL ?? 'http://localhost:3005'}/health` },
    { name: 'drawing-worker', label: '绘图 Worker', url: `${process.env.DRAWING_WORKER_URL ?? 'http://localhost:3012'}/health` },
    { name: 'media-service', label: '媒体存储', url: `${process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013'}/health` },
    { name: 'bot-service', label: 'Bot 服务', url: `${process.env.BOT_SERVICE_URL ?? 'http://localhost:3004'}/health` },
    { name: 'bot-renderer', label: '卡片渲染', url: `${process.env.BOT_RENDERER_URL ?? 'http://localhost:3014'}/health` },
    { name: 'wsproxy-service', label: 'WS 代理', url: `${process.env.WSPROXY_SERVICE_URL ?? 'http://localhost:3011'}/health` },
    { name: 'notification-worker', label: '邮件通知', url: `${process.env.NOTIFICATION_WORKER_URL ?? 'http://localhost:3015'}/health` },
    { name: 'ops-worker', label: '运维 Worker', url: `${process.env.OPS_WORKER_URL ?? 'http://localhost:3016'}/health` },
  ];

  return Promise.all(services.map(async (service): Promise<PublicServiceHealthView> => {
    if (!service.url) {
      return {
        name: service.name,
        label: service.label,
        ok: true,
        statusCode: 200,
        version: '3.0.0',
        uptimeSec: Math.floor(process.uptime()),
        latencyMs: 0,
        error: null,
      };
    }
    return probeService(service.name, service.label, service.url);
  }));
}

/** 探测单个内部服务健康状态。 */
async function probeService(name: string, label: string, url: string): Promise<PublicServiceHealthView> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; uptimeSec?: number; version?: string };
    return {
      name,
      label,
      ok: response.ok && body.ok === true,
      statusCode: response.status,
      version: body.version ?? '',
      uptimeSec: Number(body.uptimeSec ?? 0),
      latencyMs: Date.now() - startedAt,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      name,
      label,
      ok: false,
      statusCode: null,
      version: '',
      uptimeSec: 0,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : '探活失败',
    };
  }
}

/** 聚合主任务真实状态分布；失败数只统计 status=failed。 */
async function collectTaskSummary(since: Date): Promise<PublicTaskStatusSummary> {
  const rows = await prisma.generationTask.groupBy({
    by: ['status'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  const counts = new Map(rows.map((row) => [row.status, row._count._all]));
  const success = counts.get('success') ?? 0;
  const failed = counts.get('failed') ?? 0;
  const terminalTotal = success + failed;
  return {
    total: rows.reduce((sum, row) => sum + row._count._all, 0),
    queued: counts.get('queued') ?? 0,
    running: counts.get('running') ?? 0,
    finalizing: counts.get('finalizing') ?? 0,
    success,
    failed,
    terminalTotal,
    successRate: terminalTotal > 0 ? roundPercent(success, terminalTotal) : null,
  };
}

/** 按来源聚合任务状态，帮助判断 Web/Bot 侧是否异常。 */
async function collectSourceSummary(since: Date): Promise<PublicSourceSummary[]> {
  const rows = await prisma.generationTask.groupBy({
    by: ['source', 'status'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  const map = new Map<string, PublicSourceSummary>();
  for (const row of rows) {
    const item = map.get(row.source) ?? { source: row.source, total: 0, success: 0, failed: 0 };
    item.total += row._count._all;
    if (row.status === 'success') item.success += row._count._all;
    if (row.status === 'failed') item.failed += row._count._all;
    map.set(row.source, item);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/** 聚合站点当前配置和所选时间范围内真实上游尝试统计。 */
async function collectSiteRuntime(since: Date): Promise<PublicSiteRuntimeView[]> {
  const now = new Date();
  const [sites, attempts] = await Promise.all([
    prisma.apiSite.findMany({
      orderBy: [{ isEnabled: 'desc' }, { weight: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        isEnabled: true,
        weight: true,
        maxConcurrency: true,
        consecutiveFailures: true,
        totalCalls: true,
        successCount: true,
        avgLatencyMs: true,
        autoDisabledUntil: true,
        autoDisabledReason: true,
      },
    }),
    prisma.generationSubTask.groupBy({
      by: ['siteId', 'status'],
      // 只统计真实上游尝试状态；skipped 是 Worker 并发占位被覆盖后的内部状态，不能算入公开尝试数或运行中。
      where: { kind: 'upstream_attempt', createdAt: { gte: since }, siteId: { not: null }, status: { in: ['queued', 'running', 'success', 'failed'] } },
      _count: { _all: true },
      _avg: { latencyMs: true },
    }),
  ]);

  const stats = new Map<number, { attempts: number; success: number; failed: number; active: number; latencySum: number; latencyCount: number }>();
  for (const row of attempts) {
    if (row.siteId === null) continue;
    const item = stats.get(row.siteId) ?? { attempts: 0, success: 0, failed: 0, active: 0, latencySum: 0, latencyCount: 0 };
    item.attempts += row._count._all;
    if (row.status === 'success') item.success += row._count._all;
    else if (row.status === 'failed') item.failed += row._count._all;
    else if (row.status === 'queued' || row.status === 'running') item.active += row._count._all;
    if (row._avg.latencyMs !== null) {
      item.latencySum += row._avg.latencyMs * row._count._all;
      item.latencyCount += row._count._all;
    }
    stats.set(row.siteId, item);
  }

  return sites.map((site) => {
    const item = stats.get(site.id) ?? { attempts: 0, success: 0, failed: 0, active: 0, latencySum: 0, latencyCount: 0 };
    const activeAutoDisabledUntil = site.autoDisabledUntil && site.autoDisabledUntil > now ? site.autoDisabledUntil : null;
    return {
      id: site.id,
      name: site.name,
      isEnabled: site.isEnabled,
      weight: site.weight,
      maxConcurrency: site.maxConcurrency,
      consecutiveFailures: site.consecutiveFailures,
      // 过期的自动禁用时间只保留为历史字段，不应让公开状态页继续显示“自动禁用中”。
      autoDisabledUntil: activeAutoDisabledUntil?.toISOString() ?? null,
      autoDisabledReason: activeAutoDisabledUntil ? site.autoDisabledReason : null,
      lifetimeCalls: site.totalCalls,
      lifetimeSuccess: site.successCount,
      lifetimeAvgLatencyMs: site.avgLatencyMs,
      attempts: item.attempts,
      success: item.success,
      failed: item.failed,
      active: item.active,
      // 站点成功率只用终态上游尝试计算，避免 queued/running 被当成失败压低公开健康度。
      successRate: item.success + item.failed > 0 ? roundPercent(item.success, item.success + item.failed) : null,
      avgLatencyMs: item.latencyCount > 0 ? Math.round(item.latencySum / item.latencyCount) : null,
    };
  });
}

/** 聚合 Bot 连接状态。 */
async function collectBotSummary(): Promise<PublicBotSummary> {
  const [total, online, banned] = await Promise.all([
    prisma.botConnection.count(),
    prisma.botConnection.count({ where: { status: 'online' } }),
    prisma.botConnection.count({ where: { banned: true } }),
  ]);
  return { total, online, offline: Math.max(0, total - online), banned };
}

/** 聚合公开平台数据。 */
async function collectPlatformSummary(): Promise<PublicPlatformSummary> {
  const [users, verifiedUsers, publicImages, enabledSites] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { emailVerified: true } }),
    countPublicGalleryImages(),
    // “可用站点”必须排除仍处于自动禁用窗口内的站点，否则状态页会高估可调度容量。
    prisma.apiSite.count({ where: { isEnabled: true, OR: [{ autoDisabledUntil: null }, { autoDisabledUntil: { lte: new Date() } }] } }),
  ]);
  return { users, verifiedUsers, publicImages, enabledSites };
}

/** 按图库真实可见口径统计公开作品；当前生产图片统一从本地媒体目录读取。 */
async function countPublicGalleryImages(): Promise<number> {
  const rows = await prisma.$queryRaw<{ total: bigint | number }[]>(Prisma.sql`
    SELECT COUNT(*) AS total
    FROM generation_tasks t
    WHERE t.status = 'success'
      AND t.is_private = false
      AND EXISTS (
        SELECT 1 FROM system_configs c
        WHERE c.\`key\` = CONCAT('task_image_', t.id)
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.value, '$.imageFilename')), '') <> ''
      )
  `);
  return Number(rows[0]?.total ?? 0);
}

/** 规范化统计范围。 */
function normalizeRange(value: string | null): PublicStatusRange {
  if (value === '1h' || value === '7d') return value;
  return '24h';
}

/** 将状态页时间范围转换为毫秒。 */
function rangeToMs(range: PublicStatusRange): number {
  if (range === '1h') return 60 * 60 * 1000;
  if (range === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

/** 返回一位小数百分比。 */
function roundPercent(part: number, total: number): number {
  return Math.round((part / total) * 1000) / 10;
}
