/**
 * 本文件注册站点批量操作路由：批量启停、批量重置失败、模型选项聚合。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { Prisma } from '@prisma/client';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

const prisma = getPrismaClient();

export function createAdminSitesBatchRoutes(): Route[] {
  return [
    { method: 'POST', path: '/admin/sites/batch-toggle', handle: batchToggle },
    { method: 'POST', path: '/admin/sites/reset-all-failures', handle: resetAllFailures },
    { method: 'POST', path: '/admin/sites/:id/set-default-model', handle: setDefaultModel },
    { method: 'GET', path: '/admin/sites/runtime-stats', handle: runtimeStats },
    // 内部接口：绘图 Worker 记录站点故障/成功，使用服务间 token 鉴权
    { method: 'POST', path: '/internal/sites/:id/record-failure', handle: recordSiteFailure },
    { method: 'POST', path: '/internal/sites/:id/reset-failure', handle: resetSiteFailure },
  ];
}

/** 批量启停站点。 */
async function batchToggle(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const body = await readJsonBody<{ siteIds: number[]; isEnabled: boolean }>(req);
  if (!Array.isArray(body.siteIds) || body.siteIds.length === 0) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请提供站点 ID 列表' });
  }
  const result = await prisma.apiSite.updateMany({
    where: { id: { in: body.siteIds } },
    data: { isEnabled: body.isEnabled },
  });
  return sendJson(res, 200, { ok: true, data: { updated: result.count, isEnabled: body.isEnabled } });
}

/** 批量重置所有站点失败计数。 */
async function resetAllFailures(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const result = await prisma.apiSite.updateMany({
    data: { consecutiveFailures: 0, failedCount: 0, autoDisabledUntil: null, autoDisabledReason: null },
  });
  return sendJson(res, 200, { ok: true, data: { reset: result.count } });
}

/** 设置某站点的默认模型。 */
async function setDefaultModel(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const siteId = Number(params?.id ?? '0');
  const body = await readJsonBody<{ model: string }>(req);
  if (!body.model?.trim()) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '模型名不能为空' });
  await prisma.apiSite.update({ where: { id: siteId }, data: { model: body.model.trim() } });
  return sendJson(res, 200, { ok: true, data: { siteId, model: body.model.trim(), updated: true } });
}

/** 站点运行统计（24h 调用/成功率/延迟/连续失败）。 */
async function runtimeStats(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const sites = await prisma.apiSite.findMany({ select: { id: true, name: true, isEnabled: true, consecutiveFailures: true, totalCalls: true, successCount: true, avgLatencyMs: true, autoDisabledUntil: true, autoDisabledReason: true } });
  const recentTasks = await prisma.generationTask.findMany({
    where: { createdAt: { gte: dayAgo } },
    select: { status: true },
  });
  const total24h = recentTasks.length;
  const success24h = recentTasks.filter((t) => t.status === 'success').length;

  return sendJson(res, 200, {
    ok: true,
    data: {
      sites: sites.map((s) => ({
        id: s.id, name: s.name, isEnabled: s.isEnabled,
        consecutiveFailures: s.consecutiveFailures,
        totalCalls: s.totalCalls, successCount: s.successCount,
        avgLatencyMs: s.avgLatencyMs,
        autoDisabledUntil: s.autoDisabledUntil ? formatChinaDateTime(s.autoDisabledUntil) : null,
        autoDisabledReason: s.autoDisabledReason,
      })),
      summary: { total24h, success24h, successRate: total24h > 0 ? ((success24h / total24h) * 100).toFixed(1) + '%' : 'N/A' },
    },
  });
}

/** 记录站点故障：递增连续失败次数，达到阈值自动禁用。Worker 内部调用。 */
async function recordSiteFailure(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const siteId = Number(params?.id ?? '0');
  if (!siteId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '站点 ID 不正确' });
  const body = await readJsonBody<{ error?: string; latencyMs?: number }>(req);

  // 从 DB 配置读取（与 admin 面板同步），env 仅兜底；threshold=0 永不自动禁用。
  const { threshold, disableMinutes } = await readAutoDisableConfig();
  const disableUntil = new Date(Date.now() + disableMinutes * 60 * 1000);
  const disableReason = (body.error ?? '连续失败自动禁用').slice(0, 500);

  const affected = await prisma.$executeRaw(Prisma.sql`
    UPDATE api_sites
    SET
      total_calls = total_calls + 1,
      failed_count = failed_count + 1,
      auto_disabled_until = CASE
        WHEN ${threshold} > 0 AND consecutive_failures + 1 >= ${threshold} THEN ${disableUntil}
        ELSE auto_disabled_until
      END,
      auto_disabled_reason = CASE
        WHEN ${threshold} > 0 AND consecutive_failures + 1 >= ${threshold} THEN ${disableReason}
        ELSE auto_disabled_reason
      END,
      consecutive_failures = consecutive_failures + 1
    WHERE id = ${siteId}
  `);
  if (affected === 0) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '站点不存在' });

  const site = await prisma.apiSite.findUnique({ where: { id: siteId }, select: { consecutiveFailures: true, autoDisabledUntil: true } });
  const autoDisabled = Boolean(site?.autoDisabledUntil && site.autoDisabledUntil > new Date());
  return sendJson(res, 200, { ok: true, data: { siteId, consecutiveFailures: site?.consecutiveFailures ?? 0, autoDisabled } });
}

/** 站点成功后重置故障计数。Worker 内部调用。 */
async function resetSiteFailure(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const siteId = Number(params?.id ?? '0');
  if (!siteId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '站点 ID 不正确' });
  const body = await readJsonBody<{ latencyMs?: number }>(req);
  const rawLatencyMs = Number(body.latencyMs ?? 0);
  const latencyMs = Number.isFinite(rawLatencyMs) ? Math.max(0, Math.round(rawLatencyMs)) : 0;

  // 成功回写使用单条 SQL 原子更新计数和平均延迟，避免 Worker 并发成功时先读后写覆盖彼此。
  const affected = await prisma.$executeRaw(Prisma.sql`
    UPDATE api_sites
    SET
      avg_latency_ms = CASE
        WHEN ${latencyMs} > 0 THEN ROUND(((COALESCE(avg_latency_ms, 0) * COALESCE(success_count, 0)) + ${latencyMs}) / (COALESCE(success_count, 0) + 1))
        ELSE avg_latency_ms
      END,
      total_calls = total_calls + 1,
      success_count = success_count + 1,
      consecutive_failures = 0,
      failed_count = 0,
      auto_disabled_until = NULL,
      auto_disabled_reason = NULL
    WHERE id = ${siteId}
  `);
  if (affected === 0) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '站点不存在' });

  return sendJson(res, 200, { ok: true, data: { siteId, reset: true } });
}

/** 读取自动禁用配置；异常值回退为安全默认，避免配置脏值导致所有站点被误禁用。 */
async function readAutoDisableConfig(): Promise<{ threshold: number; disableMinutes: number }> {
  const [thresholdRow, minutesRow] = await Promise.all([
    prisma.systemConfig.findUnique({ where: { key: 'drawing_auto_disable_threshold' }, select: { value: true } }),
    prisma.systemConfig.findUnique({ where: { key: 'drawing_auto_disable_minutes' }, select: { value: true } }),
  ]);
  return {
    threshold: readNonNegativeNumber(thresholdRow?.value ?? process.env.DRAWING_AUTO_DISABLE_THRESHOLD, 5),
    disableMinutes: Math.max(1, readNonNegativeNumber(minutesRow?.value ?? process.env.DRAWING_AUTO_DISABLE_MINUTES, 60)),
  };
}

/** 解析非负数字配置；NaN、负数和无穷值都按默认值处理。 */
function readNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    const payload = verifyAccessToken(token);
    return payload.role === 'admin' ? payload : undefined;
  } catch { return undefined; }
}

function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** 校验服务间 token；仅显式开发或测试环境允许缺省调试。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}
