/**
 * 本文件注册管理后台全部路由：仪表盘、用户管理、站点管理、AI 配置。
 * 所有接口需要 admin JWT。
 */
import type { IncomingMessage } from 'node:http';
import {
  ApiErrorCode,
  type AdminStorageOverviewResponse,
  type MediaStorageStatsResponse,
  type StorageCleanupLastStatus,
  type StorageCleanupStats,
} from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { invalidateSiteCacheTags, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheAdminServiceHealth, cacheAdminStats, cacheAdminTrends } from '../../shared/cache/cache-policies.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { AdminStatsService } from './admin-stats-service.js';
import { AdminUserService } from './admin-user-service.js';
import { AdminSitesService, AdminError } from './admin-sites-service.js';

const statsService = new AdminStatsService();
const userService = new AdminUserService();
const sitesService = new AdminSitesService();

export function createAdminRoutes(): Route[] {
  return [
    // 仪表盘
    { method: 'GET', path: '/admin/stats', handle: getStats },
    { method: 'GET', path: '/admin/stats/trends', handle: getTrends },
    { method: 'GET', path: '/admin/health/services', handle: getServicesHealth },
    { method: 'GET', path: '/admin/storage/overview', handle: getStorageOverview },
    // 用户管理
    { method: 'GET', path: '/admin/users', handle: listUsers },
    { method: 'GET', path: '/admin/users/:id', handle: getUserDetail },
    { method: 'PUT', path: '/admin/users/:id', handle: updateUser },
    { method: 'PUT', path: '/admin/users/:id/role', handle: updateUserRole },
    { method: 'DELETE', path: '/admin/users/:id', handle: deleteUser },
    // 站点管理
    { method: 'GET', path: '/admin/sites', handle: listSites },
    { method: 'POST', path: '/admin/sites', handle: createSite },
    { method: 'GET', path: '/admin/sites/:id', handle: getSite },
    { method: 'PUT', path: '/admin/sites/:id', handle: updateSite },
    { method: 'DELETE', path: '/admin/sites/:id', handle: deleteSite },
    { method: 'POST', path: '/admin/sites/:id/toggle', handle: toggleSite },
    { method: 'POST', path: '/admin/sites/:id/reset-failures', handle: resetSiteFailures },
  ];
}

// === 仪表盘 ===
async function getStats(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  // 仪表盘入口会被后台页面频繁并发读取，短缓存只影响展示延迟，不参与任何写入判断。
  const cached = await cacheAdminStats(() => statsService.getStats());
  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: cached.value });
}

async function getTrends(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const days = Math.min(Number(url.searchParams.get('days') ?? '7'), 30);
  // 趋势聚合按桶扫描任务表，缓存后能明显降低后台多入口切换时的数据库压力。
  const cached = await cacheAdminTrends(days, () => statsService.getTrends(days));
  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: cached.value });
}

/** 后台存储面板聚合接口；只读代理 media-service 和 ops-worker，不向浏览器暴露服务间 token。 */
async function getStorageOverview(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const [media, ops] = await Promise.all([
    probeMediaStorageStats(),
    probeOpsStorageStats(),
  ]);
  const data: AdminStorageOverviewResponse = {
    checkedAt: new Date().toISOString(),
    media,
    ops,
  };
  return sendJson(res, 200, { ok: true, data });
}

// === 用户管理 ===
async function listUsers(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const data = await userService.listUsers({
    page: Number(url.searchParams.get('page') ?? '1'),
    pageSize: Number(url.searchParams.get('pageSize') ?? '20'),
    search: url.searchParams.get('search') ?? undefined,
    role: url.searchParams.get('role') ?? undefined,
    bound: url.searchParams.get('bound') ?? undefined,
  });
  return sendJson(res, 200, { ok: true, data });
}

async function getUserDetail(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const userId = Number(params?.id ?? '0');
  const user = await userService.getUserDetail(userId);
  if (!user) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
  return sendJson(res, 200, { ok: true, data: user });
}

/** 通用更新用户信息（邮箱、用户名、已验证状态）。 */
async function updateUser(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const admin = authenticateAdmin(req);
  if (!admin) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const userId = Number(params?.id ?? '0');
  if (!userId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '用户 ID 不正确' });
  const body = await readJsonBody<{ email?: string; username?: string; emailVerified?: boolean }>(req);
  try {
    const data = await userService.updateUser(userId, body);
    return sendJson(res, 200, { ok: true, data });
  } catch (error) {
    return sendAdminError(res, error);
  }
}

async function updateUserRole(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const admin = authenticateAdmin(req);
  if (!admin) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const userId = Number(params?.id ?? '0');
  if (userId === admin.sub) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '不能修改自己的角色' });
  const body = await readJsonBody<{ role?: string }>(req);
  if (body.role !== 'admin' && body.role !== 'user') {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '角色只能为 admin 或 user' });
  }
  const data = await userService.updateRole(userId, body.role);
  return sendJson(res, 200, { ok: true, data });
}

async function deleteUser(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const admin = authenticateAdmin(req);
  if (!admin) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const userId = Number(params?.id ?? '0');
  if (userId === admin.sub) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '不能删除自己' });
  await userService.deleteUser(userId);
  return sendJson(res, 200, { ok: true, data: { deleted: true } });
}

// === 站点管理 ===
async function listSites(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const data = await sitesService.listSites();
  return sendJson(res, 200, { ok: true, data });
}

async function createSite(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const body = await readJsonBody<Record<string, unknown>>(req);
  try {
    const data = await sitesService.createSite(body as Parameters<typeof sitesService.createSite>[0]);
    // 站点模型配置会影响用户端可选模型和 worker 候选，写入成功后必须立即失效缓存。
    invalidateSiteCacheTags();
    return sendJson(res, 201, { ok: true, data });
  } catch (error) { return sendAdminError(res, error); }
}

async function getSite(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const siteId = Number(params?.id ?? '0');
  try {
    const data = await sitesService.getSite(siteId);
    return sendJson(res, 200, { ok: true, data });
  } catch (error) { return sendAdminError(res, error); }
}

async function updateSite(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const siteId = Number(params?.id ?? '0');
  const body = await readJsonBody<Record<string, unknown>>(req);
  try {
    const data = await sitesService.updateSite(siteId, body as Parameters<typeof sitesService.updateSite>[1]);
    // 站点模型配置会影响用户端可选模型和 worker 候选，写入成功后必须立即失效缓存。
    invalidateSiteCacheTags();
    return sendJson(res, 200, { ok: true, data });
  } catch (error) { return sendAdminError(res, error); }
}

async function deleteSite(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  try {
    await sitesService.deleteSite(Number(params?.id ?? '0'));
    // 删除站点只刷新模型可用性；独立模型名称、价格和外显配置由模型设置永久保留。
    invalidateSiteCacheTags();
    return sendJson(res, 200, { ok: true, data: { deleted: true } });
  } catch (error) { return sendAdminError(res, error); }
}

async function toggleSite(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const body = await readJsonBody<{ isEnabled?: boolean }>(req);
  const data = await sitesService.toggleSite(Number(params?.id ?? '0'), body.isEnabled ?? true);
  // 启停站点会改变可用模型集合，必须清理站点缓存。
  invalidateSiteCacheTags();
  return sendJson(res, 200, { ok: true, data });
}

async function resetSiteFailures(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const data = await sitesService.resetFailures(Number(params?.id ?? '0'));
  // 自动禁用状态清零后站点可用性可能变化，清理站点缓存。
  invalidateSiteCacheTags();
  return sendJson(res, 200, { ok: true, data });
}

/** 聚合所有 服务健康状态。 */
async function getServicesHealth(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(_req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const cached = await cacheAdminServiceHealth(async () => {
    const services = [
      { name: 'drawing-service', url: `${process.env.DRAWING_SERVICE_URL ?? 'http://localhost:3005'}/health` },
      { name: 'drawing-worker', url: `${process.env.DRAWING_WORKER_URL ?? 'http://localhost:3012'}/health` },
      { name: 'media-service', url: `${process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013'}/health` },
      { name: 'bot-service', url: `${process.env.BOT_SERVICE_URL ?? 'http://localhost:3004'}/health` },
      { name: 'bot-renderer', url: `${process.env.BOT_RENDERER_URL ?? 'http://localhost:3014'}/health` },
      { name: 'wsproxy-service', url: `${process.env.WSPROXY_SERVICE_URL ?? 'http://localhost:3011'}/health` },
      { name: 'notification-worker', url: `${process.env.NOTIFICATION_WORKER_URL ?? 'http://localhost:3015'}/health` },
      { name: 'ops-worker', url: `${process.env.OPS_WORKER_URL ?? 'http://localhost:3016'}/health` },
    ];
    const results = await Promise.all(services.map(async s => {
      try {
        const r = await fetch(s.url, { signal: AbortSignal.timeout(3000) });
        const d = await r.json().catch(() => ({})) as { ok?: boolean; uptimeSec?: number };
        return { name: s.name, ok: d.ok === true, uptimeSec: d.uptimeSec ?? 0 };
      } catch { return { name: s.name, ok: false, uptimeSec: 0 }; }
    }));
    return { services: results };
  });
  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: cached.value });
}

/** 读取 media-service 的真实存储统计；失败时保留错误状态，页面可展示具体异常。 */
async function probeMediaStorageStats(): Promise<AdminStorageOverviewResponse['media']> {
  const startedAt = Date.now();
  try {
    const url = `${process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013'}/media/storage-stats`;
    const response = await fetch(url, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; data?: MediaStorageStatsResponse; message?: string };
    if (!response.ok || body.ok !== true || !body.data) {
      return {
        healthy: false,
        statusCode: response.status,
        latencyMs: Date.now() - startedAt,
        error: body.message ?? `media-service 返回 HTTP ${response.status}`,
        stats: null,
      };
    }
    return {
      healthy: true,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      error: null,
      stats: body.data,
    };
  } catch (error) {
    return {
      healthy: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'media-service 存储统计读取失败',
      stats: null,
    };
  }
}

/** 读取 ops-worker 最近清理统计；只取存储相关字段，避免后台页面依赖整个 worker 内部状态。 */
async function probeOpsStorageStats(): Promise<AdminStorageOverviewResponse['ops']> {
  const startedAt = Date.now();
  try {
    const url = `${process.env.OPS_WORKER_URL ?? 'http://localhost:3016'}/worker/status`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; data?: Partial<StorageCleanupStats>; message?: string };
    if (!response.ok || body.ok !== true || !body.data) {
      return {
        healthy: false,
        statusCode: response.status,
        latencyMs: Date.now() - startedAt,
        error: body.message ?? `ops-worker 返回 HTTP ${response.status}`,
        cleanup: null,
      };
    }
    return {
      healthy: true,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      error: null,
      cleanup: normalizeStorageCleanupStats(body.data),
    };
  } catch (error) {
    return {
      healthy: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'ops-worker 状态读取失败',
      cleanup: null,
    };
  }
}

/** 归一化 ops-worker 清理字段，防止未部署旧字段导致前端出现 undefined。 */
function normalizeStorageCleanupStats(value: Partial<StorageCleanupStats>): StorageCleanupStats {
  return {
    mediaCacheCleanupRuns: Number(value.mediaCacheCleanupRuns ?? 0),
    mediaCacheCleanupFailed: Number(value.mediaCacheCleanupFailed ?? 0),
    mediaCacheCleanupSkipped: Number(value.mediaCacheCleanupSkipped ?? 0),
    mediaCacheProtectedFiles: Number(value.mediaCacheProtectedFiles ?? 0),
    mediaCacheCleanupDeleted: Number(value.mediaCacheCleanupDeleted ?? 0),
    mediaReferenceCleanupDeleted: Number(value.mediaReferenceCleanupDeleted ?? 0),
    mediaArchivedLocalDeleted: Number(value.mediaArchivedLocalDeleted ?? 0),
    mediaCacheArchiveRuns: Number(value.mediaCacheArchiveRuns ?? 0),
    mediaCacheArchiveArchived: Number(value.mediaCacheArchiveArchived ?? 0),
    mediaCacheArchiveFailed: Number(value.mediaCacheArchiveFailed ?? 0),
    mediaCacheArchiveSkipped: Number(value.mediaCacheArchiveSkipped ?? 0),
    mediaReferenceCleanupSkippedUnarchived: Number(value.mediaReferenceCleanupSkippedUnarchived ?? 0),
    mediaCacheCleanupLastError: typeof value.mediaCacheCleanupLastError === 'string' ? value.mediaCacheCleanupLastError : null,
    mediaCacheCleanupLastRunAt: typeof value.mediaCacheCleanupLastRunAt === 'string' ? value.mediaCacheCleanupLastRunAt : null,
    mediaCacheCleanupLastStatus: normalizeCleanupLastStatus(value.mediaCacheCleanupLastStatus),
    mediaCacheCleanupLastDurationMs: Number(value.mediaCacheCleanupLastDurationMs ?? 0),
    mediaCacheCleanupLastDeleted: Number(value.mediaCacheCleanupLastDeleted ?? 0),
    mediaReferenceCleanupLastDeleted: Number(value.mediaReferenceCleanupLastDeleted ?? 0),
    mediaReferenceCleanupLastSkippedUnarchived: Number(value.mediaReferenceCleanupLastSkippedUnarchived ?? 0),
    mediaCacheArchiveLastArchived: Number(value.mediaCacheArchiveLastArchived ?? 0),
    mediaCacheArchiveLastFailed: Number(value.mediaCacheArchiveLastFailed ?? 0),
    mediaCacheArchiveLastSkipped: Number(value.mediaCacheArchiveLastSkipped ?? 0),
    mediaCacheCleanupLastCacheDeleted: Number(value.mediaCacheCleanupLastCacheDeleted ?? 0),
    mediaArchivedLocalLastDeleted: Number(value.mediaArchivedLocalLastDeleted ?? 0),
  };
}

/** 归一化最近一轮清理状态，兼容尚未重启的旧 ops-worker。 */
function normalizeCleanupLastStatus(value: unknown): StorageCleanupLastStatus {
  return value === 'success' || value === 'partial' || value === 'skipped' || value === 'failed' || value === 'never' ? value : 'never';
}

function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    const payload = verifyAccessToken(token);
    return payload.role === 'admin' ? payload : undefined;
  } catch { return undefined; }
}

function sendAdminError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof AdminError) {
    const status = error.kind === 'not_found' ? 404 : error.kind === 'forbidden' ? 403 : 400;
    return sendJson(res, status, { ok: false, code: ApiErrorCode.NotFound, message: error.message });
  }
  throw error;
}
