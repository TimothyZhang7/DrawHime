/**
 * 本文件注册管理后台生成记录查询路由：批次聚合列表、详情、重试、隐私切换和删除。
 * 管理后台展示按批次聚合，内部管理和任务回写仍按真实单图任务执行。
 */
import type { IncomingMessage } from 'node:http';
import { Prisma } from '@prisma/client';
import {
  ApiErrorCode,
  getDrawingAspectRatioOption,
  isDrawingAspectRatio,
  type AdminGenerationDetailView,
  type AdminGenerationImageView,
  type AdminGenerationListItemView,
  type AdminGenerationListResponse,
  type AdminGenerationRequestParamsView,
  type AdminGenerationSubTaskView,
  type AdminGenerationUpstreamRequestView,
  type DrawingLoraSnapshot,
  type GenerationSubTaskView,
} from '@aiimage/shared-contracts';
import { buildPromptCacheKey, sendJson, type Route } from '@aiimage/core-utils';
import { readJsonBody } from '../../shared/http/body.js';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { invalidateGalleryCache, invalidateTaskCache, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheAdminGenerationDetail, cacheAdminGenerationList } from '../../shared/cache/cache-policies.js';
import { synchronizeLocalPlatformTaskDeletion } from '../integrations/local-platform-gallery-routes.js';

const prisma = getPrismaClient();

export function createAdminGenerationRoutes(): Route[] {
  return [
    { method: 'GET', path: '/admin/generations', handle: listGenerations },
    { method: 'DELETE', path: '/admin/generations', handle: batchDeleteGenerations },
    { method: 'DELETE', path: '/admin/generations/failed', handle: clearFailedGenerations },
    { method: 'GET', path: '/admin/generations/:id', handle: getGenerationDetail },
    { method: 'POST', path: '/admin/generations/:id/retry', handle: retryGeneration },
    { method: 'PATCH', path: '/admin/generations/:id/privacy', handle: updateGenerationPrivacy },
    { method: 'DELETE', path: '/admin/generations/:id', handle: deleteGeneration },
    { method: 'POST', path: '/admin/generations/batch-retry', handle: batchRetryGenerations },
  ];
}

/** 管理端筛选生成记录列表；n>1 时按批次聚合为一条。 */
async function listGenerations(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? '20'), 50);
  const where = buildGenerationWhere(url);

  const cached = await cacheAdminGenerationList({ page, pageSize, where }, async () => {
    const [groupRows, totalRows] = await Promise.all([
      prisma.$queryRaw<AdminGenerationListRow[]>(Prisma.sql`
        SELECT
          COALESCE(t.batch_id, t.id) AS visibleId,
          SUBSTRING_INDEX(GROUP_CONCAT(t.id ORDER BY COALESCE(t.batch_index, 1) ASC, t.created_at ASC SEPARATOR ','), ',', 1) AS taskId,
          MAX(t.batch_id) AS batchId,
          MAX(COALESCE(b.client_request_id, t.client_request_id)) AS clientRequestId,
          MAX(COALESCE(t.batch_total, 1)) AS batchTotal,
          COUNT(*) AS batchCount,
          MAX(COALESCE(b.user_id, t.user_id)) AS userId,
          MAX(COALESCE(b.source, t.source)) AS source,
          MAX(COALESCE(b.mode, t.mode)) AS mode,
          MAX(COALESCE(b.prompt, t.prompt)) AS prompt,
          MAX(t.qq_number) AS qqNumber,
          MAX(COALESCE(b.status, t.status)) AS status,
          MAX(t.error) AS error,
          MAX(t.is_private) AS isPrivate,
          MAX(COALESCE(b.created_at, t.created_at)) AS createdAt,
          MAX(t.started_at) AS startedAt,
          MAX(COALESCE(b.finished_at, t.finished_at)) AS finishedAt
        FROM generation_tasks t
        LEFT JOIN generation_batches b ON b.id = t.batch_id
        WHERE ${where}
        GROUP BY COALESCE(t.batch_id, t.id)
        ORDER BY MAX(COALESCE(b.created_at, t.created_at)) DESC, visibleId DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `),
      prisma.$queryRaw<{ total: bigint | number }[]>(Prisma.sql`
        SELECT COUNT(DISTINCT COALESCE(t.batch_id, t.id)) AS total
        FROM generation_tasks t
        LEFT JOIN generation_batches b ON b.id = t.batch_id
        WHERE ${where}
      `),
    ]);

    const visibleIds = groupRows.map((row) => row.batchId ?? row.visibleId);
    const batchTaskIds = await expandVisibleBatchTaskIds(visibleIds);
    const imageMap = await loadTaskImageMap(batchTaskIds);
    const taskDetails = await prisma.generationTask.findMany({
      where: { id: { in: batchTaskIds } },
      orderBy: [{ batchId: 'asc' }, { batchIndex: 'asc' }, { createdAt: 'asc' }],
      select: adminGenerationTaskSelect,
    });
    const taskGroupMap = new Map<string, AdminGenerationTaskRecord[]>();
    for (const row of taskDetails) {
      const key = row.batchId ?? row.id;
      const list = taskGroupMap.get(key) ?? [];
      list.push(row);
      taskGroupMap.set(key, list);
    }

    const items: AdminGenerationListItemView[] = groupRows.map((row) => {
      const taskGroup = taskGroupMap.get(row.batchId ?? row.visibleId) ?? [];
      const attempts = collectBatchVisibleAttempts(taskGroup);
      const lastAttempt = [...attempts].reverse().find((item) => item.siteName || item.model || item.latencyMs != null);
      const sitesUsed = [...new Set(attempts.map((item) => item.siteName).filter((name): name is string => Boolean(name)))];
      const imageTask = taskGroup.find((task) => task.status === 'success' && imageMap.has(task.id)) ?? taskGroup[0];
      const subTaskCount = taskGroup.reduce((sum, task) => sum + task.subTasks.length, 0);
      return {
        id: row.visibleId,
        taskId: row.taskId,
        batchId: row.batchId,
        batchTotal: Math.max(1, Number(row.batchTotal ?? row.batchCount ?? 1)),
        batchCount: Number(row.batchCount ?? 1),
        clientRequestId: row.clientRequestId,
        userId: row.userId,
        source: row.source,
        mode: row.mode,
        prompt: row.prompt.slice(0, 200),
        qqNumber: row.qqNumber?.toString() ?? null,
        status: row.status,
        error: row.error?.slice(0, 200),
        isPrivate: row.isPrivate,
        imageUrl: imageTask ? (imageMap.get(imageTask.id)?.imageUrl ?? null) : null,
        thumbnailUrl: imageTask ? (imageMap.get(imageTask.id)?.thumbnailUrl ?? null) : null,
        videoUrl: imageTask ? (imageMap.get(imageTask.id)?.videoUrl ?? null) : null,
        mediaType: imageTask ? (imageMap.get(imageTask.id)?.mediaType ?? null) : null,
        duration: imageTask ? (imageMap.get(imageTask.id)?.duration ?? null) : null,
        resolution: imageTask ? (imageMap.get(imageTask.id)?.resolution ?? null) : null,
        aspectRatio: imageTask ? (imageMap.get(imageTask.id)?.aspectRatio ?? null) : null,
        model: lastAttempt?.model ?? null,
        siteName: lastAttempt?.siteName ?? null,
        sitesUsed,
        attempts: attempts.length,
        failedCount: attempts.filter((item) => item.status === 'failed').length,
        subTaskCount,
        createdAt: formatChinaDateTime(row.createdAt),
        startedAt: row.startedAt ? formatChinaDateTime(row.startedAt) : null,
        finishedAt: row.finishedAt ? formatChinaDateTime(row.finishedAt) : null,
      };
    });

    return {
      items,
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    } satisfies AdminGenerationListResponse;
  });

  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: cached.value });
}

/** 管理端查看生成记录详情；批次 ID 会展开为同一批次下全部真实单图。 */
async function getGenerationDetail(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const id = params?.id ?? '';
  const cached = await cacheAdminGenerationDetail(id, async () => {
    const resolved = await resolveAdminGenerationTarget(id);
    if (!resolved) return null;
    const batch = resolved.kind === 'batch'
      ? await prisma.generationBatch.findUnique({
          where: { id: resolved.batchId },
          select: {
            id: true,
            clientRequestId: true,
            userId: true,
            qqNumber: true,
            source: true,
            mode: true,
            prompt: true,
            status: true,
            count: true,
            concurrency: true,
            stopAfterConsecutiveFailures: true,
            createdAt: true,
            updatedAt: true,
            finishedAt: true,
          },
        })
      : null;
    const tasks = resolved.kind === 'batch'
      ? await prisma.generationTask.findMany({
          where: { batchId: resolved.batchId },
          orderBy: { batchIndex: 'asc' },
          select: adminGenerationTaskSelect,
        })
      : await prisma.generationTask.findMany({
          where: { id: resolved.taskId },
          select: adminGenerationTaskSelect,
        });
    if (tasks.length === 0) return null;

    const taskIds = tasks.map((task) => task.id);
    const siteIds = [...new Set(tasks.flatMap((task) => task.subTasks.map((item) => item.siteId).filter((siteId): siteId is number => siteId != null)))];
    const [imageMap, generationParamsMap, requestDefaults, apiSiteMap] = await Promise.all([
      loadTaskImageMap(taskIds),
      loadTaskGenerationParamsMap(taskIds),
      loadAdminGenerationRequestDefaults(),
      loadAdminApiSiteRequestMap(siteIds),
    ]);
    const detailImages = tasks
      .filter((task) => task.status === 'success')
      .map((task) => taskToAdminImage(task, imageMap.get(task.id)))
      .filter((item): item is AdminGenerationImageView => Boolean(item));
    const representativeTask = resolved.kind === 'batch'
      ? tasks.find((task) => task.status === 'success' && imageMap.has(task.id)) ?? tasks[0]
      : tasks[0];
    const selectedImage = representativeTask ? imageMap.get(representativeTask.id) : undefined;

    return toAdminGenerationDetailView(
      representativeTask ?? tasks[0],
      selectedImage,
      tasks,
      generationParamsMap,
      requestDefaults,
      apiSiteMap,
      batch ?? undefined,
      detailImages,
    );
  });

  setBackendCacheHeader(res, cached.status);
  if (!cached.value) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '生成记录不存在' });
  return sendJson(res, 200, { ok: true, data: cached.value });
}

/** 重新提交失败任务。 */
async function retryGeneration(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const id = params?.id ?? '';
  if (!id) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '任务 ID 不正确' });

  const task = await prisma.generationTask.findUnique({ where: { id }, select: { status: true } });
  if (!task) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '任务不存在' });
  if (task.status !== 'failed') return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '只能重试失败的任务' });

  await prisma.generationTask.update({
    where: { id },
    data: { status: 'queued', error: null, startedAt: null, finishedAt: null },
  });
  invalidateTaskCache([id]);
  invalidateGalleryCache([`image:${id}`]);
  return sendJson(res, 200, { ok: true, data: { retried: true } });
}

/** 管理端切换生成记录隐私；批次 ID 会同时更新整批单图。 */
async function updateGenerationPrivacy(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const id = params?.id ?? '';
  const body = await readJsonBody<{ isPrivate?: boolean }>(req);
  if (typeof body.isPrivate !== 'boolean') {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '参数不正确' });
  }
  const resolved = await resolveAdminGenerationTarget(id);
  if (!resolved) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '生成记录不存在' });
  const taskIds = resolved.kind === 'batch'
    ? (await prisma.generationTask.findMany({ where: { batchId: resolved.batchId }, select: { id: true } })).map((row) => row.id)
    : [resolved.taskId];
  await prisma.generationTask.updateMany({
    where: { id: { in: taskIds } },
    data: { isPrivate: body.isPrivate },
  });
  invalidateTaskCache([...taskIds, ...(resolved.kind === 'batch' ? [resolved.batchId] : [])]);
  invalidateGalleryCache([...taskIds.map((taskId) => `image:${taskId}`), ...(resolved.kind === 'batch' ? [`image:${resolved.batchId}`] : [])]);
  return sendJson(res, 200, { ok: true, data: { updated: taskIds.length } });
}

/** 管理端删除生成记录；批次 ID 会删除整批真实单图。 */
async function deleteGeneration(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const id = params?.id ?? '';
  const resolved = await resolveAdminGenerationTarget(id);
  if (!resolved) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '生成记录不存在' });

  const taskIds = resolved.kind === 'batch'
    ? (await prisma.generationTask.findMany({ where: { batchId: resolved.batchId }, select: { id: true } })).map((row) => row.id)
    : [resolved.taskId];
  if (taskIds.length === 0) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '生成记录不存在' });

  // 管理端删除也必须同步独立平台，避免管理员操作留下用户仍可见的本地模型记录。
  await synchronizeLocalPlatformTaskDeletion(taskIds);
  await prisma.imageLike.deleteMany({ where: { imageId: { in: taskIds } } });
  await prisma.imageView.deleteMany({ where: { imageId: { in: taskIds } } });
  await prisma.generationSubTask.deleteMany({ where: { taskId: { in: taskIds } } });
  await prisma.taskChargeAllocation.deleteMany({ where: { taskId: { in: taskIds } } });
  await prisma.systemConfig.deleteMany({
    where: {
      key: {
        in: taskIds.flatMap((taskId) => [`task_image_${taskId}`, `task_ref_images_${taskId}`, `task_generation_params_${taskId}`]),
      },
    },
  });
  const result = await prisma.generationTask.deleteMany({ where: { id: { in: taskIds } } });
  invalidateTaskCache([...taskIds, ...(resolved.kind === 'batch' ? [resolved.batchId] : [])]);
  invalidateGalleryCache([...taskIds.map((taskId) => `image:${taskId}`), ...(resolved.kind === 'batch' ? [`image:${resolved.batchId}`] : [])]);
  return sendJson(res, 200, { ok: true, data: { deleted: result.count } });
}

/** 管理端：批量删除生成记录；批次 ID 会自动展开为整批真实单图。 */
async function batchDeleteGenerations(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const body = await readJsonBody<{ ids: string[] }>(req);
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少生成记录 ID 列表' });
  }
  const taskIds = await expandAdminGenerationTaskIds(body.ids);
  const batchIds = await collectBatchIdsByTaskIds(taskIds);
  if (taskIds.length === 0) {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '生成记录不存在' });
  }
  // 批量管理删除沿用同一同步约束，独立平台不可达时不执行主站单边删除。
  await synchronizeLocalPlatformTaskDeletion(taskIds);
  await prisma.imageLike.deleteMany({ where: { imageId: { in: taskIds } } });
  await prisma.imageView.deleteMany({ where: { imageId: { in: taskIds } } });
  const result = await prisma.generationTask.deleteMany({ where: { id: { in: taskIds } } });
  invalidateTaskCache([...taskIds, ...batchIds]);
  invalidateGalleryCache([...taskIds.map((id) => `image:${id}`), ...batchIds.map((id) => `image:${id}`), ...body.ids.map((id) => `image:${id}`)]);
  return sendJson(res, 200, { ok: true, data: { deleted: result.count } });
}

/** 管理端：清空所有失败记录；仅删除真实失败单图，不动批次父记录。 */
async function clearFailedGenerations(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const failed = await prisma.generationTask.findMany({
    where: { status: 'failed' },
    select: { id: true },
  });
  const ids = failed.map((f) => f.id);
  if (ids.length === 0) return sendJson(res, 200, { ok: true, data: { deleted: 0 } });
  await prisma.imageLike.deleteMany({ where: { imageId: { in: ids } } });
  await prisma.imageView.deleteMany({ where: { imageId: { in: ids } } });
  const result = await prisma.generationTask.deleteMany({ where: { status: 'failed' } });
  invalidateTaskCache(ids);
  invalidateGalleryCache(ids.map((id) => `image:${id}`));
  return sendJson(res, 200, { ok: true, data: { deleted: result.count } });
}

/** 批量重试所有失败任务。 */
async function batchRetryGenerations(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const result = await prisma.generationTask.updateMany({
    where: { status: 'failed' },
    data: { status: 'queued', error: null, startedAt: null, finishedAt: null },
  });
  invalidateTaskCache();
  invalidateGalleryCache();
  return sendJson(res, 200, { ok: true, data: { retried: result.count } });
}

/** 扩展管理员操作中的批次外显 ID；传入批次 ID 时返回整批真实任务。 */
async function expandAdminGenerationTaskIds(ids: string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const batchRows = await prisma.generationTask.findMany({
    where: { batchId: { in: uniqueIds } },
    select: { id: true, batchId: true },
    orderBy: [{ batchId: 'asc' }, { id: 'asc' }],
  });
  const grouped = new Map<string, string[]>();
  for (const row of batchRows) {
    if (!row.batchId) continue;
    const list = grouped.get(row.batchId) ?? [];
    list.push(row.id);
    grouped.set(row.batchId, list);
  }
  return uniqueIds.flatMap((id) => grouped.get(id) ?? [id]);
}

/** 读取一组真实任务对应的批次 ID；用于失效 batch 级详情缓存。 */
async function collectBatchIdsByTaskIds(taskIds: string[]): Promise<string[]> {
  const uniqueIds = [...new Set(taskIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const rows = await prisma.generationTask.findMany({
    where: { batchId: { in: uniqueIds } },
    select: { batchId: true },
    distinct: ['batchId'],
  });
  return rows.map((row) => row.batchId).filter((id): id is string => Boolean(id));
}

/** 管理端认证。 */
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

/** 管理端列表只统计真实上游尝试。 */
function getVisibleAttempts<T extends { kind: string; status: string; error: string | null; siteName: string | null; latencyMs: number | null; sequence: number; attemptNo: number | null }>(subTasks: T[]): T[] {
  return subTasks.filter((task) => task.kind === 'upstream_attempt' && !isPlaceholderAttempt(task, subTasks));
}

/** 判断上游子任务是否为内部占位记录。 */
function isPlaceholderAttempt<T extends { kind: string; status: string; error: string | null; siteName: string | null; latencyMs: number | null; sequence: number; attemptNo: number | null }>(task: T, allSubTasks: T[]): boolean {
  if (task.kind !== 'upstream_attempt') return false;
  if (Boolean(task.error?.includes('覆盖')) && !task.siteName && !task.latencyMs) return true;
  if (task.status !== 'queued' && task.status !== 'running') return false;
  return allSubTasks.some((other) => (
    other.kind === 'upstream_attempt'
    && other.sequence > task.sequence
    && other.attemptNo === task.attemptNo
    && (other.status === 'success' || other.status === 'failed')
  ));
}

/** 构建后台列表查询条件。 */
function buildGenerationWhere(url: URL): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  const userId = url.searchParams.get('userId');
  const qqNumber = url.searchParams.get('qqNumber');
  const status = url.searchParams.get('status');
  const mode = url.searchParams.get('mode');
  const source = url.searchParams.get('source');
  const search = url.searchParams.get('search');
  const dateFrom = url.searchParams.get('dateFrom');
  const dateTo = url.searchParams.get('dateTo');
  if (userId) clauses.push(Prisma.sql`t.user_id = ${Number(userId)}`);
  if (qqNumber && /^\d+$/.test(qqNumber)) clauses.push(Prisma.sql`t.qq_number = ${BigInt(qqNumber)}`);
  if (status) clauses.push(Prisma.sql`t.status = ${status}`);
  if (mode) clauses.push(Prisma.sql`t.mode = ${mode}`);
  if (source) clauses.push(Prisma.sql`t.source = ${source}`);
  if (search) {
    const like = `%${search.trim()}%`;
    clauses.push(Prisma.sql`(t.id LIKE ${like} OR COALESCE(t.batch_id, '') LIKE ${like} OR t.client_request_id LIKE ${like} OR t.prompt LIKE ${like})`);
  }
  if (dateFrom) clauses.push(Prisma.sql`t.created_at >= ${new Date(dateFrom)}`);
  if (dateTo) clauses.push(Prisma.sql`t.created_at <= ${new Date(dateTo)}`);
  return joinSqlClauses(clauses, Prisma.sql` AND `);
}

/** 拼接 Prisma SQL 条件。 */
function joinSqlClauses(clauses: Prisma.Sql[], separator: Prisma.Sql): Prisma.Sql {
  if (clauses.length === 0) return Prisma.sql`1 = 1`;
  return clauses.reduce((sql, clause, index) => (index === 0 ? clause : Prisma.sql`${sql}${separator}${clause}`), Prisma.empty);
}

/** 解析批次或单图外显 ID。 */
async function resolveAdminGenerationTarget(id: string): Promise<{ kind: 'batch'; batchId: string; taskId: string } | { kind: 'task'; taskId: string } | null> {
  const task = await prisma.generationTask.findUnique({ where: { id }, select: { id: true, batchId: true } });
  if (task) {
    if (task.batchId) return { kind: 'batch', batchId: task.batchId, taskId: task.id };
    return { kind: 'task', taskId: task.id };
  }
  const batchTask = await prisma.generationTask.findFirst({ where: { batchId: id }, select: { id: true, batchId: true } });
  if (batchTask?.batchId) return { kind: 'batch', batchId: batchTask.batchId, taskId: batchTask.id };
  return null;
}

/** 展开批次对应的全部单图任务 ID。 */
async function expandVisibleBatchTaskIds(taskIds: string[]): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const rows = await prisma.generationTask.findMany({
    where: { OR: [{ id: { in: taskIds } }, { batchId: { in: taskIds } }] },
    select: { id: true, batchId: true, batchIndex: true, createdAt: true },
    orderBy: [{ batchId: 'asc' }, { batchIndex: 'asc' }, { createdAt: 'asc' }],
  });
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.batchId ?? row.id;
    const list = grouped.get(key) ?? [];
    list.push(row.id);
    grouped.set(key, list);
  }
  return taskIds.flatMap((id) => grouped.get(id) ?? [id]);
}

/** 批量读取任务图片映射。 */
async function loadTaskImageMap(taskIds: string[]): Promise<Map<string, AdminTaskMedia>> {
  const configs = taskIds.length > 0
    ? await prisma.systemConfig.findMany({ where: { key: { in: taskIds.map((id) => `task_image_${id}`) } }, select: { key: true, value: true } })
    : [];
  const imgMap = new Map<string, AdminTaskMedia>();
  for (const c of configs) {
    try {
      const v = JSON.parse(c.value) as { mediaType?: string; imageFilename?: string; thumbnailFilename?: string; videoFilename?: string; duration?: number; resolution?: string; aspectRatio?: string };
      const tid = c.key.replace('task_image_', '');
      imgMap.set(tid, {
        imageUrl: v.imageFilename ? `/images/${v.imageFilename}` : undefined,
        thumbnailUrl: v.thumbnailFilename ? `/images/${v.thumbnailFilename}` : undefined,
        videoUrl: v.videoFilename ? `/images/${v.videoFilename}` : undefined,
        mediaType: v.mediaType === 'video' && v.videoFilename ? 'video' : v.imageFilename || v.thumbnailFilename ? 'image' : undefined,
        duration: Number.isFinite(v.duration) ? v.duration : undefined,
        resolution: v.resolution,
        aspectRatio: v.aspectRatio,
      });
    } catch {
      // 跳过坏配置。
    }
  }
  return imgMap;
}

/** 后台请求 JSON 使用的任务级调度快照；只读取业务参数，不包含站点密钥。 */
type AdminTaskGenerationParams = {
  model?: string;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  duration?: number;
  resolution?: string;
  storyboardDesign?: boolean;
  count?: number;
  sourceImageSizes?: number[];
  effectivePrompt?: string;
  referencePromptAssist?: boolean;
  maxAttempts?: number;
  lora?: DrawingLoraSnapshot;
};

/** 历史快照缺省字段的当前兼容默认值。 */
type AdminGenerationRequestDefaults = { size: string; quality: string };

/** 后台还原上游请求所需的非敏感站点配置。 */
type AdminApiSiteRequestConfig = {
  id: number;
  name: string;
  baseUrl: string;
  responseFormat: string;
  sendResponseFormat: boolean;
  sendPromptCacheKey: boolean;
  timeoutSec: number;
  modelOptions: string | null;
};

/** 最近一次真实上游尝试的最小字段。 */
type AdminUpstreamAttemptRecord = {
  attemptNo: number;
  siteId: number;
  siteName: string;
  model: string;
};

/** 批量读取任务创建事务内保存的调度参数，避免详情页按子任务逐条查询。 */
async function loadTaskGenerationParamsMap(taskIds: string[]): Promise<Map<string, AdminTaskGenerationParams>> {
  if (taskIds.length === 0) return new Map();
  const prefix = 'task_generation_params_';
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: taskIds.map((taskId) => `${prefix}${taskId}`) } },
    select: { key: true, value: true },
  });
  const result = new Map<string, AdminTaskGenerationParams>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      result.set(row.key.slice(prefix.length), {
        model: readOptionalString(parsed.model),
        size: readOptionalString(parsed.size),
        aspectRatio: readOptionalString(parsed.aspectRatio),
        quality: readOptionalString(parsed.quality),
        duration: readOptionalInteger(parsed.duration),
        resolution: readOptionalString(parsed.resolution),
        storyboardDesign: typeof parsed.storyboardDesign === 'boolean' ? parsed.storyboardDesign : undefined,
        count: readOptionalInteger(parsed.count),
        sourceImageSizes: readOptionalIntegerArray(parsed.sourceImageSizes),
        effectivePrompt: readOptionalString(parsed.effectivePrompt),
        referencePromptAssist: typeof parsed.referencePromptAssist === 'boolean' ? parsed.referencePromptAssist : undefined,
        maxAttempts: readOptionalInteger(parsed.maxAttempts),
        lora: readDrawingLoraSnapshot(parsed.lora),
      });
    } catch {
      // 损坏的历史快照只回退任务表和默认配置，不影响详情页其他真实记录。
    }
  }
  return result;
}

/** 读取后台详情兼容旧任务所需的尺寸和质量默认值。 */
async function loadAdminGenerationRequestDefaults(): Promise<AdminGenerationRequestDefaults> {
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: ['drawing_default_size', 'drawing_default_quality'] } },
    select: { key: true, value: true },
  });
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    size: values.drawing_default_size?.trim() || 'auto',
    quality: values.drawing_default_quality?.trim() || 'auto',
  };
}

/** 批量读取用于还原请求的站点非敏感配置，明确排除 apiKey。 */
async function loadAdminApiSiteRequestMap(siteIds: number[]): Promise<Map<number, AdminApiSiteRequestConfig>> {
  if (siteIds.length === 0) return new Map();
  const rows = await prisma.apiSite.findMany({
    where: { id: { in: siteIds } },
    select: { id: true, name: true, baseUrl: true, responseFormat: true, sendResponseFormat: true, sendPromptCacheKey: true, timeoutSec: true, modelOptions: true },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/** 合并任务表与不可变调度快照，形成后台可复制的完整规范化请求 JSON。 */
function buildAdminGenerationRequestParams(
  task: AdminGenerationTaskRecord,
  params: AdminTaskGenerationParams | undefined,
  defaults: AdminGenerationRequestDefaults,
  fallbackModel?: string | null,
  upstreamAttempt?: AdminUpstreamAttemptRecord,
  apiSiteMap: Map<number, AdminApiSiteRequestConfig> = new Map(),
): AdminGenerationRequestParamsView {
  const requestParams: AdminGenerationRequestParamsView = {
    taskId: task.id,
    clientRequestId: task.clientRequestId,
    promptCacheKey: buildPromptCacheKey({
      source: task.source,
      userId: task.userId ?? undefined,
      qqNumber: task.qqNumber?.toString(),
      clientRequestId: task.clientRequestId,
    }),
    batchId: task.batchId ?? null,
    source: task.source,
    mode: task.mode,
    prompt: task.prompt,
    effectivePrompt: params?.effectivePrompt ?? null,
    referencePromptAssist: params?.referencePromptAssist === true,
    templateId: task.templateId ?? null,
    sourceImageUrls: asStringArray(task.sourceImageUrls),
    sourceImageSizes: params?.sourceImageSizes ?? null,
    isPrivate: task.isPrivate,
    count: Math.max(1, params?.count ?? task.batchTotal ?? 1),
    model: params?.model ?? fallbackModel ?? null,
    size: params?.size ?? defaults.size,
    aspectRatio: params?.aspectRatio ?? null,
    quality: params?.quality ?? defaults.quality,
    duration: params?.duration ?? null,
    resolution: params?.resolution ?? null,
    storyboardDesign: params?.storyboardDesign === true,
    maxAttempts: Math.max(1, params?.maxAttempts ?? 3),
    lora: params?.lora ?? null,
    upstreamRequest: null,
  };
  requestParams.upstreamRequest = buildAdminUpstreamRequest(requestParams, upstreamAttempt, apiSiteMap.get(upstreamAttempt?.siteId ?? -1));
  return requestParams;
}

/** 读取任务最后一次已真实调用站点的尝试记录。 */
function resolveLastUpstreamAttempt(task: AdminGenerationTaskRecord): AdminUpstreamAttemptRecord | undefined {
  const attempt = [...task.subTasks].reverse().find((item) => (
    item.kind === 'upstream_attempt'
    && item.siteId != null
    && item.attemptNo != null
    && Boolean(item.siteName)
    && Boolean(item.model)
  ));
  return attempt?.siteId != null && attempt.attemptNo != null && attempt.siteName && attempt.model
    ? { attemptNo: attempt.attemptNo, siteId: attempt.siteId, siteName: attempt.siteName, model: attempt.model }
    : undefined;
}

/** 按 Worker 的 OpenAI 文生图参数规则还原真实 JSON；其他协议不猜测，避免后台展示伪请求。 */
function buildAdminUpstreamRequest(
  params: AdminGenerationRequestParamsView,
  attempt: AdminUpstreamAttemptRecord | undefined,
  site: AdminApiSiteRequestConfig | undefined,
): AdminGenerationUpstreamRequestView | null {
  if (!attempt || !site || params.mode !== 'text-to-image') return null;
  const apiMode = readSiteModelApiMode(site.modelOptions, attempt.model);
  if (apiMode !== 'openai_images' && apiMode !== 'bfl_image_generation' && apiMode !== 'grok_image_edit_json') return null;
  const isGptModel = attempt.model.toLowerCase().includes('gpt-image') || attempt.model.toLowerCase().includes('dall-e');
  const responseFormat = site.responseFormat === 'auto' ? (isGptModel ? 'auto' : 'b64_json') : site.responseFormat;
  const body: Record<string, unknown> = {
    model: attempt.model,
    prompt: params.effectivePrompt ?? params.prompt,
    n: 1,
  };
  // 后台排障 JSON 必须与 Worker 的站点开关一致，关闭时不展示并不存在的 response_format 字段。
  if (site.sendResponseFormat) body.response_format = responseFormat;
  // 渠道亲和键仅在站点显式开启后进入真实请求体，后台 JSON 与 Worker 行为保持一致。
  if (site.sendPromptCacheKey) body.prompt_cache_key = params.promptCacheKey;
  const usesJsonAspectRatio = apiMode === 'bfl_image_generation' || apiMode === 'grok_image_edit_json';
  if (usesJsonAspectRatio) {
    if (params.aspectRatio && params.aspectRatio !== 'auto') body.aspect_ratio = params.aspectRatio;
    if (params.quality !== 'auto') body.quality = params.quality;
  } else if (isGptModel) {
    const size = resolveAdminOpenAiImageSize(params.size, params.aspectRatio, attempt.model);
    if (size) body.size = size;
    if (params.quality) body.quality = params.quality;
    body.output_format = 'png';
  } else {
    const size = resolveAdminOpenAiImageSize(params.size, params.aspectRatio, attempt.model);
    if (size && size !== 'auto') body.size = size;
    if (params.quality !== 'auto') body.quality = params.quality;
  }
  return {
    attemptNo: attempt.attemptNo,
    siteId: attempt.siteId,
    siteName: attempt.siteName,
    model: attempt.model,
    apiMode,
    method: 'POST',
    url: `${site.baseUrl.replace(/\/+$/, '')}/images/generations`,
    contentType: 'application/json',
    timeoutMs: Math.max(1000, site.timeoutSec * 1000),
    body,
  };
}

/** 读取站点指定模型的真实协议格式。 */
function readSiteModelApiMode(modelOptions: string | null, model: string): string {
  try {
    const rows = JSON.parse(modelOptions ?? '[]') as Array<{ name?: unknown; apiMode?: unknown }>;
    const row = rows.find((item) => item.name === model);
    return typeof row?.apiMode === 'string' && row.apiMode.trim() ? row.apiMode : 'openai_images';
  } catch {
    return 'openai_images';
  }
}

/** 与 Worker 保持一致地把统一画幅转换为 OpenAI 图片尺寸。 */
function resolveAdminOpenAiImageSize(size: string, aspectRatio: string | null, model: string): string | undefined {
  if (!isDrawingAspectRatio(aspectRatio) || aspectRatio === 'auto') return size;
  const option = getDrawingAspectRatioOption(aspectRatio);
  if (model.toLowerCase().includes('gpt-image')) {
    if (!option.width || !option.height || option.width === option.height) return '1024x1024';
    return option.width > option.height ? '1536x1024' : '1024x1536';
  }
  return option.width && option.height ? `${option.width}x${option.height}` : size;
}

/** 从调度快照读取非空字符串。 */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** 从调度快照读取正整数。 */
function readOptionalInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/** 从调度快照读取参考图字节数数组。 */
function readOptionalIntegerArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.filter((item): item is number => Number.isSafeInteger(item) && item >= 0);
  return parsed.length === value.length ? parsed : undefined;
}

/** 从后台调度快照读取已验证 LoRA 元数据，损坏字段不进入完整请求 JSON。 */
function readDrawingLoraSnapshot(value: unknown): DrawingLoraSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const strength = Number(record.strength);
  const sizeBytes = Number(record.sizeBytes);
  const title = readOptionalString(record.title);
  const baseModel = readOptionalString(record.baseModel);
  const sha256 = readOptionalString(record.sha256)?.toLowerCase();
  const gpuFileName = readOptionalString(record.gpuFileName);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(strength) || strength < 0 || strength > 2) return undefined;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || !title || !baseModel || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) return undefined;
  if (!gpuFileName || !/^aiimage_lora_[a-f0-9]{64}\.safetensors$/.test(gpuFileName)) return undefined;
  return { id, title, baseModel, strength, sizeBytes, sha256, gpuFileName };
}

/** 将任务记录转换成管理后台详情视图。 */
function toAdminGenerationDetailView(
  task: AdminGenerationTaskRecord,
  selectedImage: AdminTaskMedia | undefined,
  tasks: AdminGenerationTaskRecord[],
  generationParamsMap: Map<string, AdminTaskGenerationParams>,
  requestDefaults: AdminGenerationRequestDefaults,
  apiSiteMap: Map<number, AdminApiSiteRequestConfig>,
  batch?: {
    id: string;
    clientRequestId: string;
    userId: number | null;
    qqNumber: bigint | null;
    source: string;
    mode: string;
    prompt: string;
    status: string;
    count: number;
    createdAt: Date;
    finishedAt: Date | null;
  },
  images?: AdminGenerationImageView[],
): AdminGenerationDetailView {
  const selected = tasks.find((item) => item.id === task.id) ?? task;
  const batchLike = batch ?? null;
  const attempts = collectBatchVisibleAttempts(tasks);
  const lastAttempt = [...attempts].reverse().find((item) => item.siteName || item.model || item.latencyMs != null);
  const allSubTasks = collectBatchSubTasks(tasks);
  const taskImageMap = new Map(tasks.map((item) => [item.id, images?.find((image) => image.id === item.id)] as const));
  const startedAt = tasks.find((item) => item.startedAt)?.startedAt ?? selected.startedAt;
  const finishedAt = batchLike?.finishedAt ?? tasks.slice().reverse().find((item) => item.finishedAt)?.finishedAt ?? selected.finishedAt;
  const selectedRequestParams = buildAdminGenerationRequestParams(
    selected,
    generationParamsMap.get(selected.id),
    requestDefaults,
    lastAttempt?.model,
    resolveLastUpstreamAttempt(selected),
    apiSiteMap,
  );
  return {
    id: batchLike && batchLike.count > 1 ? batchLike.id : selected.id,
    taskId: selected.id,
    batchId: batchLike?.id ?? selected.batchId ?? null,
    batchTotal: Math.max(1, batchLike?.count ?? selected.batchTotal ?? tasks.length ?? 1),
    batchCount: tasks.length,
    clientRequestId: batchLike?.clientRequestId ?? selected.clientRequestId,
    userId: batchLike?.userId ?? selected.userId ?? null,
    source: batchLike?.source ?? selected.source,
    mode: batchLike?.mode ?? selected.mode,
    prompt: batchLike?.prompt ?? selected.prompt,
    qqNumber: batchLike?.qqNumber?.toString() ?? selected.qqNumber?.toString() ?? null,
    status: batchLike?.status ?? selected.status,
    error: tasks.slice().reverse().find((item) => item.error)?.error ?? selected.error ?? null,
    isPrivate: selected.isPrivate,
    imageUrl: selectedImage?.imageUrl ?? null,
    thumbnailUrl: selectedImage?.thumbnailUrl ?? null,
    videoUrl: selectedImage?.videoUrl ?? null,
    mediaType: selectedImage?.mediaType ?? null,
    duration: selectedImage?.duration ?? null,
    resolution: selectedImage?.resolution ?? null,
    aspectRatio: selectedImage?.aspectRatio ?? null,
    model: lastAttempt?.model ?? null,
    siteName: lastAttempt?.siteName ?? null,
    sitesUsed: [...new Set(attempts.map((item) => item.siteName).filter((name): name is string => Boolean(name)))],
    attempts: attempts.length,
    failedCount: attempts.filter((item) => item.status === 'failed').length,
    subTaskCount: allSubTasks.length,
    createdAt: formatChinaDateTime(batchLike?.createdAt ?? selected.createdAt),
    startedAt: startedAt ? formatChinaDateTime(startedAt) : null,
    finishedAt: finishedAt ? formatChinaDateTime(finishedAt) : null,
    templateId: selected.templateId ?? null,
    sourceImageUrls: asStringArray(selected.sourceImageUrls),
    images,
    requestParams: selectedRequestParams,
    tasks: tasks.map((item) => {
      const itemImage = taskImageMap.get(item.id);
      const itemAttempts = collectBatchVisibleAttempts([item]);
      const itemLastAttempt = [...itemAttempts].reverse().find((attempt) => attempt.siteName || attempt.model || attempt.latencyMs != null);
      const itemSubTasks = collectBatchSubTasks([item]);
      return {
        id: item.id,
        batchIndex: item.batchIndex ?? null,
        batchTotal: item.batchTotal ?? null,
        status: item.status,
        source: item.source,
        mode: item.mode,
        prompt: item.prompt,
        qqNumber: item.qqNumber?.toString() ?? null,
        userId: item.userId ?? null,
        templateId: item.templateId ?? null,
        sourceImageUrls: asStringArray(item.sourceImageUrls),
        isPrivate: item.isPrivate,
        error: item.error ?? null,
        imageUrl: itemImage?.imageUrl ?? null,
        thumbnailUrl: itemImage?.thumbnailUrl ?? null,
        videoUrl: itemImage?.videoUrl ?? null,
        mediaType: itemImage?.mediaType ?? null,
        duration: itemImage?.duration ?? null,
        resolution: itemImage?.resolution ?? null,
        aspectRatio: itemImage?.aspectRatio ?? null,
        model: itemLastAttempt?.model ?? null,
        siteName: itemLastAttempt?.siteName ?? null,
        sitesUsed: [...new Set(itemAttempts.map((attempt) => attempt.siteName).filter((name): name is string => Boolean(name)))],
        attempts: itemAttempts.length,
        failedCount: itemAttempts.filter((attempt) => attempt.status === 'failed').length,
        subTaskCount: itemSubTasks.length,
        createdAt: formatChinaDateTime(item.createdAt),
        startedAt: item.startedAt ? formatChinaDateTime(item.startedAt) : null,
        finishedAt: item.finishedAt ? formatChinaDateTime(item.finishedAt) : null,
        subTasks: itemSubTasks,
        requestParams: buildAdminGenerationRequestParams(
          item,
          generationParamsMap.get(item.id),
          requestDefaults,
          itemLastAttempt?.model,
          resolveLastUpstreamAttempt(item),
          apiSiteMap,
        ),
      };
    }),
    subTasks: allSubTasks,
  };
}

/** 任务图像数据转为后台详情中的图片项。 */
function taskToAdminImage(task: AdminGenerationTaskRecord, image?: AdminTaskMedia): AdminGenerationImageView | null {
  if (!image?.imageUrl && !image?.thumbnailUrl && !image?.videoUrl) return null;
  return {
    id: task.id,
    batchIndex: task.batchIndex,
    batchTotal: task.batchTotal,
    imageUrl: image.imageUrl ?? null,
    thumbnailUrl: image.thumbnailUrl ?? null,
    videoUrl: image.videoUrl ?? null,
    mediaType: image.mediaType ?? null,
    duration: image.duration ?? null,
    resolution: image.resolution ?? null,
    aspectRatio: image.aspectRatio ?? null,
    status: task.status,
  };
}

/** 管理任务列表复用的图片或视频结果映射。 */
type AdminTaskMedia = {
  imageUrl?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  mediaType?: 'image' | 'video';
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
};

/** 合并批次内真实可见上游尝试；批次列表和详情都用这份统计口径。 */
function collectBatchVisibleAttempts(tasks: AdminGenerationTaskRecord[]): Array<GenerationSubTaskView & { taskId: string }> {
  const taskOrder = new Map(tasks.map((item, index) => [item.id, index]));
  return tasks
    .flatMap((task) => getVisibleAttempts(task.subTasks).map((attempt) => ({
      id: attempt.id,
      taskId: task.id,
      sequence: attempt.sequence,
      kind: attempt.kind as GenerationSubTaskView['kind'],
      status: attempt.status as GenerationSubTaskView['status'],
      attemptNo: attempt.attemptNo ?? undefined,
      siteId: attempt.siteId ?? undefined,
      siteName: attempt.siteName ?? undefined,
      model: attempt.model ?? undefined,
      retryable: attempt.retryable ?? undefined,
      nextAction: attempt.nextAction as GenerationSubTaskView['nextAction'] | undefined,
      latencyMs: attempt.latencyMs ?? undefined,
      error: attempt.error ?? undefined,
      createdAt: formatChinaDateTime(attempt.createdAt),
      startedAt: attempt.startedAt ? formatChinaDateTime(attempt.startedAt) : undefined,
      finishedAt: attempt.finishedAt ? formatChinaDateTime(attempt.finishedAt) : undefined,
    } satisfies GenerationSubTaskView & { taskId: string })))
    .sort((left, right) => {
      const leftOrder = taskOrder.get(left.taskId) ?? 0;
      const rightOrder = taskOrder.get(right.taskId) ?? 0;
      return leftOrder - rightOrder || left.sequence - right.sequence;
    });
}

/** 合并批次内全部子任务时间线；单图任务会自然退化为原子任务视图。 */
function collectBatchSubTasks(tasks: AdminGenerationTaskRecord[]): AdminGenerationSubTaskView[] {
  const taskOrder = new Map(tasks.map((item, index) => [item.id, index]));
  return tasks
    .flatMap((task) => task.subTasks.map((st) => ({
      id: st.id,
      taskId: st.taskId,
      sequence: st.sequence,
      kind: st.kind as AdminGenerationSubTaskView['kind'],
      status: st.status as AdminGenerationSubTaskView['status'],
      attemptNo: st.attemptNo ?? undefined,
      siteId: st.siteId ?? undefined,
      siteName: st.siteName ?? undefined,
      model: st.model ?? undefined,
      retryable: st.retryable ?? undefined,
      nextAction: st.nextAction as AdminGenerationSubTaskView['nextAction'] | undefined,
      latencyMs: st.latencyMs ?? undefined,
      error: st.error ?? undefined,
      upstreamRawError: st.rawError,
      createdAt: formatChinaDateTime(st.createdAt),
      startedAt: st.startedAt ? formatChinaDateTime(st.startedAt) : undefined,
      finishedAt: st.finishedAt ? formatChinaDateTime(st.finishedAt) : undefined,
    } satisfies AdminGenerationSubTaskView)))
    .sort((left, right) => {
      const leftOrder = taskOrder.get(left.taskId) ?? 0;
      const rightOrder = taskOrder.get(right.taskId) ?? 0;
      return leftOrder - rightOrder || left.sequence - right.sequence;
    });
}

/** 读取 JSON 数组字段为字符串数组。 */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 管理后台列表查询记录的轻量行类型。 */
type AdminGenerationListRow = {
  visibleId: string;
  taskId: string;
  batchId: string | null;
  batchTotal: number | null;
  batchCount: bigint | number;
  clientRequestId: string;
  userId: number | null;
  source: string;
  mode: string;
  prompt: string;
  qqNumber: bigint | null;
  status: string;
  error: string | null;
  isPrivate: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  subTaskCount: bigint | number;
};

/** 管理后台详情查询的任务字段。 */
const adminGenerationTaskSelect = {
  id: true,
  batchId: true,
  batchIndex: true,
  batchTotal: true,
  clientRequestId: true,
  userId: true,
  source: true,
  mode: true,
  prompt: true,
  qqNumber: true,
  templateId: true,
  sourceImageUrls: true,
  isPrivate: true,
  status: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  subTasks: {
    orderBy: { sequence: 'asc' },
    select: {
      id: true,
      taskId: true,
      sequence: true,
      kind: true,
      status: true,
      attemptNo: true,
      siteId: true,
      siteName: true,
      model: true,
      retryable: true,
      nextAction: true,
      latencyMs: true,
      error: true,
      rawError: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
    },
  },
} satisfies Prisma.GenerationTaskSelect;

/** 管理后台详情查询记录的 Prisma 载荷类型。 */
type AdminGenerationTaskRecord = Prisma.GenerationTaskGetPayload<{ select: typeof adminGenerationTaskSelect }>;

/** 中国时区时间格式化。 */
function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}
