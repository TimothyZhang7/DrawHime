/**
 * 本文件注册管理后台图库标签路由。
 *
 * 职责：
 * - 只向管理员暴露图库标签统计、打标队列和配置摘要。
 * - 允许管理员小批量触发真实自动打标服务，不向浏览器暴露服务间 token 或 API Key。
 */
import type { IncomingMessage } from 'node:http';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ApiErrorCode,
  type AdminGalleryTagOverviewResponse,
  type AdminGalleryTaggingConfigView,
  type AdminGalleryTaggingJobView,
  type AdminGalleryTaggingRunResponse,
  type GalleryTaggingJobStatus,
} from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { GalleryTagService } from '../gallery/gallery-tag-service.js';
import { GalleryTaggingService } from '../gallery/gallery-tagging-service.js';

const prisma: PrismaClient = getPrismaClient();
const galleryTagService = new GalleryTagService();
const taggingService = new GalleryTaggingService();

/** 创建管理后台图库标签路由。 */
export function createAdminGalleryTagRoutes(): Route[] {
  return [
    { method: 'GET', path: '/admin/gallery-tags/overview', handle: getOverview },
    { method: 'POST', path: '/admin/gallery-tags/run', handle: runTagging },
  ];
}

/** 读取图库标签、打标队列和配置状态；该接口只读业务数据，不修改生成任务或余额。 */
async function getOverview(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const [
    tagCount,
    taskTagCount,
    publicTaggedTaskCount,
    publicUntaggedTaskCount,
    jobCount,
    jobsByStatus,
    latestJobs,
    config,
    popularTags,
  ] = await Promise.all([
    prisma.galleryTag.count({ where: { disabled: false } }),
    prisma.generationTaskTag.count(),
    countPublicTaggedTasks(),
    countPublicUntaggedTasks(),
    prisma.galleryTaggingJob.count(),
    countJobsByStatus(),
    listLatestJobs(),
    readTaggingConfigSummary(),
    galleryTagService.listPopularTags(24),
  ]);
  const data: AdminGalleryTagOverviewResponse = {
    tagCount,
    taskTagCount,
    publicTaggedTaskCount,
    publicUntaggedTaskCount,
    jobCount,
    jobsByStatus,
    latestJobs,
    config,
    popularTags,
  };
  return sendJson(res, 200, { ok: true, data });
}

/** 管理员手动处理少量待打标任务；仍走真实打标服务，不绕过配置、隐私和失败重试逻辑。 */
async function runTagging(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = clampInt(url.searchParams.get('limit'), 3, 1, 10);
  const data: AdminGalleryTaggingRunResponse = await taggingService.processPending(limit);
  return sendJson(res, 200, { ok: true, data });
}

/** 统计公开成功且已打标的图库代表图数量；多图批次只按图一计数，避免覆盖率被同批多图放大。 */
async function countPublicTaggedTasks(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number }>>(Prisma.sql`
    SELECT COUNT(DISTINCT t.id) AS count
    FROM generation_tasks t
    INNER JOIN generation_task_tags gtt ON gtt.task_id = t.id
    INNER JOIN gallery_tags gt ON gt.id = gtt.tag_id
    WHERE t.status = 'success'
      AND t.is_private = false
      AND gt.disabled = false
      AND EXISTS (
        SELECT 1 FROM system_configs c
        WHERE c.\`key\` = CONCAT('task_image_', t.id)
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.value, '$.imageFilename')), '') <> ''
      )
      AND (
        t.batch_id IS NULL
        OR COALESCE(t.batch_total, 1) <= 1
        OR t.id = (
          SELECT t2.id
          FROM generation_tasks t2
          WHERE t2.batch_id = t.batch_id
          ORDER BY COALESCE(t2.batch_index, 1) ASC, t2.created_at ASC, t2.id ASC
          LIMIT 1
        )
      )
  `);
  return Number(rows[0]?.count ?? 0);
}

/** 统计公开成功且有最终图但没有标签的图库代表图数量，供后台判断是否还有历史任务待补标。 */
async function countPublicUntaggedTasks(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number }>>(Prisma.sql`
    SELECT COUNT(DISTINCT t.id) AS count
    FROM generation_tasks t
    WHERE t.status = 'success'
      AND t.is_private = false
      AND EXISTS (
        SELECT 1 FROM system_configs c
        WHERE c.\`key\` = CONCAT('task_image_', t.id)
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.value, '$.imageFilename')), '') <> ''
      )
      AND (
        t.batch_id IS NULL
        OR COALESCE(t.batch_total, 1) <= 1
        OR t.id = (
          SELECT t2.id
          FROM generation_tasks t2
          WHERE t2.batch_id = t.batch_id
          ORDER BY COALESCE(t2.batch_index, 1) ASC, t2.created_at ASC, t2.id ASC
          LIMIT 1
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM generation_task_tags gtt
        INNER JOIN gallery_tags gt ON gt.id = gtt.tag_id
        WHERE gtt.task_id = t.id
          AND gt.disabled = false
      )
  `);
  return Number(rows[0]?.count ?? 0);
}

/** 按状态聚合打标队列数量，并归一化状态值。 */
async function countJobsByStatus(): Promise<AdminGalleryTagOverviewResponse['jobsByStatus']> {
  const rows = await prisma.galleryTaggingJob.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  return rows.map((row) => ({
    status: normalizeJobStatus(row.status),
    count: row._count._all,
  })).sort((a, b) => statusOrder(a.status) - statusOrder(b.status));
}

/** 查询最近打标任务，错误信息只返回摘要，不包含上游响应全文以外的敏感配置。 */
async function listLatestJobs(): Promise<AdminGalleryTaggingJobView[]> {
  const rows = await prisma.galleryTaggingJob.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: {
      id: true,
      taskId: true,
      status: true,
      attemptCount: true,
      model: true,
      error: true,
      createdAt: true,
      updatedAt: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    status: normalizeJobStatus(row.status),
    attemptCount: row.attemptCount,
    model: row.model,
    error: row.error ? row.error.slice(0, 300) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

/** 读取打标配置摘要；API Key 只判断是否存在，不返回明文。 */
async function readTaggingConfigSummary(): Promise<AdminGalleryTaggingConfigView> {
  const keys = [
    'gallery_auto_tag_enabled',
    'gallery_auto_tag_private_enabled',
    'gallery_auto_tag_base_url',
    'gallery_auto_tag_api_key',
    'gallery_auto_tag_model',
    'gallery_auto_tag_timeout_sec',
    'gallery_auto_tag_max_tags',
    'gallery_auto_tag_max_attempts',
    'gallery_auto_tag_min_confidence',
    'tools_image_reverse_enabled',
    'tools_image_reverse_base_url',
    'tools_image_reverse_api_key',
    'tools_image_reverse_model',
    'tools_image_reverse_timeout_sec',
  ];
  const rows = await prisma.systemConfig.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const hasOwnEnabled = config.gallery_auto_tag_enabled === 'true' || config.gallery_auto_tag_enabled === 'false';
  const hasOwnBaseUrl = String(config.gallery_auto_tag_base_url ?? '').trim().length > 0;
  const hasOwnApiKey = String(config.gallery_auto_tag_api_key ?? '').trim().length > 0;
  const usesImageReverseFallback = !hasOwnBaseUrl || !hasOwnApiKey || !String(config.gallery_auto_tag_model ?? '').trim();
  return {
    enabled: config.gallery_auto_tag_enabled === 'true'
      || (!hasOwnEnabled && config.tools_image_reverse_enabled === 'true'),
    includePrivate: config.gallery_auto_tag_private_enabled === 'true',
    model: String(config.gallery_auto_tag_model ?? config.tools_image_reverse_model ?? 'gpt-5-3').trim() || 'gpt-5-3',
    hasBaseUrl: hasOwnBaseUrl || String(config.tools_image_reverse_base_url ?? '').trim().length > 0,
    hasApiKey: hasOwnApiKey || String(config.tools_image_reverse_api_key ?? '').trim().length > 0,
    usesImageReverseFallback,
    timeoutSec: clampInt(config.gallery_auto_tag_timeout_sec ?? config.tools_image_reverse_timeout_sec, 60, 5, 180),
    maxTags: clampInt(config.gallery_auto_tag_max_tags, 18, 6, 24),
    maxAttempts: clampInt(config.gallery_auto_tag_max_attempts, 5, 1, 20),
    minConfidence: clampNumber(config.gallery_auto_tag_min_confidence, 0.65, 0.1, 0.95),
  };
}

/** 管理接口鉴权：必须是 admin JWT，不能使用用户 JWT 或服务间 token 替代。 */
function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    const payload = verifyAccessToken(token);
    return payload.role === 'admin' ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** 归一化历史状态值，避免数据库脏值破坏后台渲染。 */
function normalizeJobStatus(value: string): GalleryTaggingJobStatus {
  if (value === 'pending' || value === 'running' || value === 'success' || value === 'failed' || value === 'skipped') return value;
  return 'failed';
}

function statusOrder(status: GalleryTaggingJobStatus): number {
  const order: Record<GalleryTaggingJobStatus, number> = { pending: 0, running: 1, failed: 2, skipped: 3, success: 4 };
  return order[status];
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
