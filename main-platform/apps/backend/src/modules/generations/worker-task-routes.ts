/**
 * 本文件注册 drawing-worker 拉取任务和回写结果的内部接口。
 * Worker 通过轮询本接口获取待处理任务，调用方必须携带服务间 token。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, isDrawingAspectRatio, type DrawingAspectRatio, type DrawingLoraSnapshot, type DrawingVideoResolution } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import type { Prisma } from '@prisma/client';
import { GenerationsService } from './generations-service.js';
import { GenerationError } from './generations-types.js';
import { invalidateImageCache, invalidateTaskCache, invalidateWalletCache } from '../../shared/cache/cache-service.js';
import { normalizeEnabledModel, readEnabledModelNames } from './generation-model-utils.js';
import {
  buildReferenceArchiveConfigValue,
  extractSafeReferenceFilenames,
  isSafeMediaFilename,
} from './reference-archive-state.js';

const prisma = getPrismaClient();
const generationsService = new GenerationsService();

/** 每次最多返回的任务数量，避免单次拉取过多。 */
const MAX_FETCH_SIZE = 10;

export function createWorkerTaskRoutes(): Route[] {
  return [
    /** Worker 拉取待处理任务：status='queued'，按创建时间升序。 */
    { method: 'GET', path: '/internal/worker/pending-tasks', handle: getPendingTasks },
    /** Worker 查询任务当前状态（重试编排中用，防任务被外部 kill 后继续跑）。 */
    { method: 'GET', path: '/internal/worker/task-status', handle: getTaskStatus },
    /** Worker 清理过期 running 任务（Worker 崩溃后的恢复）。 */
    { method: 'POST', path: '/internal/worker/cleanup-stale', handle: cleanupStaleTasks },
    /** Worker 抢占任务：条件更新 queued→running。 */
    { method: 'POST', path: '/internal/worker/claim-task', handle: claimTask },
    /** Worker 回写子任务结果。 */
    { method: 'POST', path: '/internal/worker/report-subtask', handle: reportSubTask },
    /** Worker 追加 finalize 子任务（不更新主任务状态，状态已由 orchestrator updateTaskStatus 处理）。 */
    { method: 'POST', path: '/internal/worker/report-finalize', handle: reportFinalize },
    /** Worker 更新主任务最终状态 + 追加 finalize 子任务（异常兜底，orchestrator 未更新状态时调用）。 */
    { method: 'POST', path: '/internal/worker/finalize-task', handle: finalizeTask },
    /** Worker 回写成功生成的图片文件名到主任务。 */
    { method: 'POST', path: '/internal/worker/report-image', handle: reportImage },
    /** Worker 回写成功生成的视频文件名到主任务。 */
    { method: 'POST', path: '/internal/worker/report-video', handle: reportVideo },
    /** Worker 回写本地参考图文件名到主任务。 */
    { method: 'POST', path: '/internal/worker/report-ref-images', handle: reportRefImages },
  ];
}

/**
 * 返回待处理任务列表。
 * 包括：(1) status='queued' 的任务 (2) status='running' 但有 queued 状态 upstream_attempt 子任务的任务。
 * Worker 每 2 秒轮询一次。
 */
async function getPendingTasks(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });

  // 查询 queued 任务 + running 但有待执行上游尝试的任务
  const tasks = await prisma.generationTask.findMany({
    where: {
      OR: [
        { status: 'queued' },
        {
          status: 'running',
          subTasks: {
            some: { kind: 'upstream_attempt', status: 'queued' },
          },
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_FETCH_SIZE,
    select: {
      id: true, clientRequestId: true, source: true, mode: true,
      prompt: true, qqNumber: true, userId: true, templateId: true,
      sourceImageUrls: true, isPrivate: true, status: true, createdAt: true,
      subTasks: { where: { kind: 'upstream_attempt' }, orderBy: { sequence: 'asc' }, take: 1, select: { model: true } },
    },
  });

  // 读取默认 size/quality，兜底 polling 路径缺失的场景
  const defaultSize = (await prisma.systemConfig.findUnique({ where: { key: 'drawing_default_size' }, select: { value: true } }))?.value ?? 'auto';
  const defaultQuality = (await prisma.systemConfig.findUnique({ where: { key: 'drawing_default_quality' }, select: { value: true } }))?.value ?? 'auto';
  const enabledModels = await readEnabledModelNames(prisma);
  const taskParamSnapshots = await readTaskGenerationParamSnapshots(tasks.map((task) => task.id));

  return sendJson(res, 200, {
    ok: true,
    data: {
      tasks: tasks.map((t) => {
        const snapshot = taskParamSnapshots.get(t.id) ?? { maxAttempts: 3 };
        return {
        taskId: t.id,
        clientRequestId: t.clientRequestId,
        source: t.source,
        mode: t.mode,
        // 参考增强任务只向纯文生图上游投递固化后的提示词，原始提示词和参考图仍保留在任务记录。
        prompt: snapshot.effectivePrompt ?? t.prompt,
        qqNumber: t.qqNumber?.toString(),
        userId: t.userId ?? undefined,
        templateId: t.templateId ?? undefined,
        sourceImageUrls: snapshot.referencePromptAssist === true
          ? undefined
          : Array.isArray(t.sourceImageUrls) ? t.sourceImageUrls.filter((v): v is string => typeof v === 'string') : undefined,
        isPrivate: t.isPrivate,
        // 轮询兜底优先使用任务创建时保存的模型快照，避免指定模型因 drawing-service/worker 竞态回退到站点默认模型。
        preferredModel: normalizeEnabledModel(snapshot.model ?? t.subTasks[0]?.model, enabledModels),
        maxAttempts: snapshot.maxAttempts,
        size: snapshot.size ?? defaultSize,
        aspectRatio: snapshot.aspectRatio,
        quality: snapshot.quality ?? defaultQuality,
        duration: snapshot.duration,
        resolution: snapshot.resolution,
        lora: snapshot.lora,
        createdAt: formatChinaDateTime(t.createdAt),
        };
      }),
    },
  });
}

/** 批量读取任务创建时的调度参数快照；快照不含凭证或图片数据。 */
async function readTaskGenerationParamSnapshots(taskIds: string[]): Promise<Map<string, { model?: string; size?: string; aspectRatio?: DrawingAspectRatio; quality?: string; duration?: number; resolution?: DrawingVideoResolution; effectivePrompt?: string; referencePromptAssist?: boolean; lora?: DrawingLoraSnapshot; maxAttempts: number }>> {
  const keys = taskIds.map((taskId) => buildTaskGenerationParamsKey(taskId));
  if (keys.length === 0) return new Map();
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  const result = new Map<string, { model?: string; size?: string; aspectRatio?: DrawingAspectRatio; quality?: string; duration?: number; resolution?: DrawingVideoResolution; effectivePrompt?: string; referencePromptAssist?: boolean; lora?: DrawingLoraSnapshot; maxAttempts: number }>();
  for (const row of rows) {
    const taskId = row.key.slice('task_generation_params_'.length);
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      result.set(taskId, {
        model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : undefined,
        size: typeof parsed.size === 'string' && parsed.size.trim() ? parsed.size : undefined,
        aspectRatio: isDrawingAspectRatio(parsed.aspectRatio) ? parsed.aspectRatio : undefined,
        quality: typeof parsed.quality === 'string' && parsed.quality.trim() ? parsed.quality : undefined,
        duration: Number.isSafeInteger(parsed.duration) && Number(parsed.duration) >= 1 && Number(parsed.duration) <= 15 ? Number(parsed.duration) : undefined,
        resolution: parsed.resolution === '480p' || parsed.resolution === '720p' || parsed.resolution === '1080p' ? parsed.resolution : undefined,
        effectivePrompt: typeof parsed.effectivePrompt === 'string' && parsed.effectivePrompt.trim() ? parsed.effectivePrompt : undefined,
        referencePromptAssist: parsed.referencePromptAssist === true,
        lora: parseDrawingLoraSnapshot(parsed.lora),
        maxAttempts: normalizeTaskMaxAttempts(parsed.maxAttempts),
      });
    } catch {
      result.set(taskId, { maxAttempts: 3 });
    }
  }
  return result;
}

/** 解析 Worker 轮询快照中的 LoRA 元数据，拒绝损坏或被手工篡改的文件名与哈希。 */
function parseDrawingLoraSnapshot(value: unknown): DrawingLoraSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const strength = Number(record.strength);
  const sizeBytes = Number(record.sizeBytes);
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const baseModel = typeof record.baseModel === 'string' ? record.baseModel.trim() : '';
  const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim().toLowerCase() : '';
  const gpuFileName = typeof record.gpuFileName === 'string' ? record.gpuFileName.trim() : '';
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(strength) || strength < 0 || strength > 2) return undefined;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || !title || !baseModel || !/^[a-f0-9]{64}$/.test(sha256)) return undefined;
  if (!/^aiimage_lora_[a-f0-9]{64}\.safetensors$/.test(gpuFileName)) return undefined;
  return { id, strength, sizeBytes, title, baseModel, sha256, gpuFileName };
}

/** 历史任务缺少模型级尝试快照时按 3 次兼容，并限制异常值。 */
function normalizeTaskMaxAttempts(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(Math.trunc(parsed), 1), 10);
}

/** Worker 查询任务当前状态（轻量级，供 orchestrator 每轮重试前校验） */
async function getTaskStatus(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const taskId = url.searchParams.get('taskId') ?? '';
  if (!taskId) return sendJson(res, 400, { ok: false, message: '缺少 taskId' });
  const task = await prisma.generationTask.findUnique({ where: { id: taskId }, select: { status: true } });
  return sendJson(res, 200, { ok: true, data: { status: task?.status ?? 'not_found' } });
}

/**
 * Worker 清理过期 queued/running 任务：Worker 崩溃或调度丢失后 stuck 任务自动超时失败。
 * Worker 每次轮询前调用一次，传入 staleTaskMinutes 阈值。
 */
async function cleanupStaleTasks(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const body = await readJsonBody(req);
  const minutes = Number(body.staleTaskMinutes ?? '30');
  if (minutes <= 0) return sendJson(res, 200, { ok: true, data: { cleaned: 0 } });

  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  // 查找 stuck 任务：
  // (a) queued 超时：已扣费但长时间未被 Worker 抢占，应失败退款并推进批次
  // (b) running 超时且无正在处理的 upstream_attempt（Worker 崩溃前未开始调用）
  // (c) running 超时且 upstream_attempt 的 started_at 也超时（Worker 崩溃在 API 调用中途）
  const staleTasks = await prisma.$queryRawUnsafe<{id:string}[]>(
    `SELECT t.id
     FROM generation_tasks t
     WHERE (
       (t.status = 'queued' AND t.updated_at < ?)
       OR (
         t.status = 'running'
         AND t.started_at IS NOT NULL AND t.started_at < ?
         AND (
           NOT EXISTS (
             SELECT 1 FROM generation_sub_tasks s
             WHERE s.task_id = t.id AND s.kind = 'upstream_attempt' AND s.status = 'running'
           )
           OR EXISTS (
             SELECT 1 FROM generation_sub_tasks s
             WHERE s.task_id = t.id AND s.kind = 'upstream_attempt'
               AND s.status = 'running' AND s.started_at IS NOT NULL AND s.started_at < ?
           )
         )
       )
     )`,
    cutoff, cutoff, cutoff,
  );

  if (staleTasks.length === 0) return sendJson(res, 200, { ok: true, data: { cleaned: 0 } });

  const ids = staleTasks.map(t => t.id);
  for (const taskId of ids) {
    await generationsService.updateTaskStatus({ taskId, status: 'failed', error: '任务执行超时（Worker 无响应）' });
  }
  await prisma.generationSubTask.updateMany({
    where: { taskId: { in: ids }, status: 'running' },
    data: { status: 'failed', error: '任务执行超时（Worker 无响应）', finishedAt: new Date() },
  });
  invalidateTaskCache(ids);
  invalidateWalletCache();

  return sendJson(res, 200, { ok: true, data: { cleaned: staleTasks.length } });
}

/**
 * Worker 抢占任务：用条件更新将 queued 改为 running。
 * 返回 true 表示抢占成功，Worker 可以开始执行。
 */
async function claimTask(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });

  const body = await readJsonBody(req);
  const taskId = String(body.taskId ?? '');
  if (!taskId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少 taskId' });

  const now = new Date();

  // 先查当前状态，避免竞态
  const currentTask = await prisma.generationTask.findUnique({
    where: { id: taskId },
    select: { status: true },
  });
  if (!currentTask || (currentTask.status !== 'queued' && currentTask.status !== 'running')) {
    return sendJson(res, 200, { ok: true, data: { claimed: false, status: currentTask?.status ?? 'not_found' } });
  }

  // queued → running 原子抢占（Bot 任务 / drawing-service 未投递时走此路径）
  if (currentTask.status === 'queued') {
    const claimed = await prisma.generationTask.updateMany({
      where: { id: taskId, status: 'queued' },
      data: { status: 'running', startedAt: now },
    });
    if (claimed.count === 0) {
      return sendJson(res, 200, { ok: true, data: { claimed: false, status: 'queued' } });
    }
  } else {
    // 已经是 running（drawing-service 已设置），原子抢占 upstream_attempt（防多 Worker 竞态）
    const claimedAttempt = await prisma.generationSubTask.updateMany({
      where: { taskId, kind: 'upstream_attempt', status: 'queued' },
      data: { status: 'running', startedAt: now },
    });
    if (claimedAttempt.count === 0) {
      return sendJson(res, 200, { ok: true, data: { claimed: false, status: 'running' } });
    }
  }

  // 追加 dispatch 子任务（事务内判断防重复）
  await prisma.$transaction(async (tx) => {
    // dispatch 幂等检查必须在主任务行锁之后执行；否则两个 Worker 可同时看到不存在并争抢相同 sequence。
    await lockGenerationTaskForUpdate(tx, taskId);
    const existingDispatch = await tx.generationSubTask.findFirst({
      where: { taskId, kind: 'dispatch' },
      select: { id: true },
    });
    if (!existingDispatch) {
      // dispatch 也走同一个加锁追加入口，防止与上游结果/收尾回写抢同一个 sequence。
      await appendSubTaskAfterTaskLock(tx, taskId, {
        kind: 'dispatch',
        status: 'success',
        startedAt: now,
        finishedAt: now,
      });
    }
  });

  invalidateTaskCache([taskId]);
  return sendJson(res, 200, { ok: true, data: { claimed: true, taskId } });
}

/**
 * Worker 回写上游尝试子任务。
 */
async function reportSubTask(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });

  const body = await readJsonBody(req);
  const taskId = String(body.taskId ?? '');
  if (!taskId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少 taskId' });
  const kind = String(body.kind ?? 'upstream_attempt');
  const status = String(body.status ?? 'failed');
  const attemptNo = typeof body.attemptNo === 'number' ? body.attemptNo : undefined;
  const startedAt = typeof body.startedAt === 'string' ? new Date(body.startedAt) : undefined;
  const finishedAt = typeof body.finishedAt === 'string' ? new Date(body.finishedAt) : undefined;
  const error = typeof body.error === 'string' ? body.error.slice(0, 2000) : undefined;

  const subTask = await prisma.$transaction(async (tx) => {
    // 清理 claimTask/drawing-service 留下的 queued 或 running 占位尝试，避免真实上游结果回写后仍残留假等待节点。
    if (kind === 'upstream_attempt') {
      await tx.generationSubTask.updateMany({
        where: { taskId, kind: 'upstream_attempt', status: { in: ['queued', 'running'] } },
        data: { status: 'skipped', error: '已被新尝试覆盖', finishedAt: new Date() },
      });
      if (attemptNo !== undefined) {
        // 新一轮上游调用开始时，上一条“切换站点/同站重试”已经完成，不能继续外显为运行中。
        await tx.generationSubTask.updateMany({
          where: {
            taskId,
            kind: { in: ['site_switch', 'same_site_retry'] },
            status: 'running',
            attemptNo: { lte: attemptNo },
          },
          data: { status: 'success', error: null, finishedAt: startedAt ?? new Date() },
        });
      }
    }
    if ((kind === 'site_switch' || kind === 'same_site_retry') && status !== 'running') {
      // 任务收尾或重试终止时，兜底关闭仍处于 running 的切站/重试节点，避免详情时间线残留假运行态。
      await tx.generationSubTask.updateMany({
        where: {
          taskId,
          kind: isRetryTransitionCleanup(body, kind) ? { in: ['site_switch', 'same_site_retry'] } : kind,
          status: 'running',
        },
        data: { status, error, finishedAt: finishedAt ?? new Date() },
      });
      if (isRetryTransitionCleanup(body, kind)) {
        const latest = await findLatestSubTaskAfterTaskLock(tx, taskId);
        if (latest) return latest;
      }
    }
    return appendSubTaskLocked(tx, taskId, {
      kind,
      status,
      attemptNo,
      siteId: typeof body.siteId === 'number' ? body.siteId : undefined,
      siteName: typeof body.siteName === 'string' ? body.siteName : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      retryable: typeof body.retryable === 'boolean' ? body.retryable : undefined,
      nextAction: typeof body.nextAction === 'string' ? body.nextAction : undefined,
      latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : undefined,
      error,
      rawError: typeof body.rawError === 'string' ? body.rawError.slice(0, 4000) : undefined,
      startedAt,
      finishedAt,
    });
  });

  invalidateTaskCache([taskId]);
  return sendJson(res, 200, { ok: true, data: { subTaskId: subTask.id, sequence: subTask.sequence } });
}

/**
 * Worker 更新主任务最终状态（success 或 failed）+ 追加 finalize 子任务。
 */
async function finalizeTask(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });

  const body = await readJsonBody(req);
  const taskId = String(body.taskId ?? '');
  const status = body.status === 'success' || body.status === 'failed' ? body.status : null;
  if (!taskId || !status) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '参数不正确' });

  const now = new Date();
  let updateResult: Awaited<ReturnType<GenerationsService['updateTaskStatus']>>;
  try {
    updateResult = await generationsService.updateTaskStatus({
      taskId,
      status: status as 'success' | 'failed',
      error: typeof body.error === 'string' ? body.error.slice(0, 2000) : undefined,
    });
  } catch (error) {
    // Worker 可能在任务被清理后迟到回写最终状态；内部回写保持幂等成功，避免无效 500 触发日志告警。
    if (isMissingTaskError(error)) {
      return sendJson(res, 200, { ok: true, data: { finalized: false, taskId, status, reason: 'task_not_found' } });
    }
    throw error;
  }
  const finalStatus = updateResult.task.status === 'success' || updateResult.task.status === 'failed'
    ? updateResult.task.status
    : status;
  await runGenerationTaskWriteWithRetry(async () => prisma.$transaction(async (tx) => {
    // 终态收尾前先关闭残留的切站/同站重试 running 节点，保证任务详情不会显示假运行态。
    await closeRunningRetryTransitionsAfterTaskLock(tx, taskId, typeof body.error === 'string' ? body.error.slice(0, 2000) : '任务已结束');
    // finalize 与 image_saved 可能并发回写，必须锁主任务后计算 sequence。
    await appendSubTaskLocked(tx, taskId, {
      kind: 'finalize',
      status: finalStatus as 'success' | 'failed',
      error: typeof body.error === 'string' ? body.error.slice(0, 2000) : undefined,
      finishedAt: now,
    });
  }));

  invalidateTaskCache([taskId]);
  if (finalStatus === 'failed') invalidateWalletCache();
  // 这里只更新图片详情级缓存；公开图库列表由成功状态写入刷新。
  if (finalStatus === 'success') invalidateImageCache(taskId);
  return sendJson(res, 200, { ok: true, data: { finalized: true, taskId, status: finalStatus } });
}

/**
 * Worker 追加 finalize 子任务（轻量版，不更新主任务状态）。
 * 主任务状态已由 orchestrator 通过 updateTaskStatus 更新。
 */
async function reportFinalize(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });

  const body = await readJsonBody(req);
  const taskId = String(body.taskId ?? '');
  const status = body.status === 'success' || body.status === 'failed' ? body.status : null;
  if (!taskId || !status) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '参数不正确' });

  const now = new Date();
  try {
    await runGenerationTaskWriteWithRetry(async () => prisma.$transaction(async (tx) => {
      // 轻量 finalize 同样整理重试流转节点，避免另一条 worker 回写路径口径不一致。
      await closeRunningRetryTransitionsAfterTaskLock(tx, taskId, typeof body.error === 'string' ? body.error.slice(0, 2000) : '任务已结束');
      // 轻量 finalize 也必须加锁追加，避免与 report-image 同时写入同一 sequence。
      await appendSubTaskLocked(tx, taskId, {
        kind: 'finalize',
        status: status as 'success' | 'failed',
        error: typeof body.error === 'string' ? body.error.slice(0, 2000) : undefined,
        finishedAt: now,
      });
    }));
  } catch (error) {
    // Worker 迟到追加 finalize 时，如果主任务已被清理，视为幂等完成。
    if (isMissingTaskError(error)) {
      return sendJson(res, 200, { ok: true, data: { finalized: false, taskId, status, reason: 'task_not_found' } });
    }
    throw error;
  }

  invalidateTaskCache([taskId]);
  return sendJson(res, 200, { ok: true, data: { finalized: true, taskId, status } });
}

/**
 * Worker 回写成功生成的图片文件名和缩略图。
 * 图库通过该字段展示图片，Worker 在 media-service 保存图片后调用。
 */
async function reportImage(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });

  const body = await readJsonBody(req);
  const taskId = String(body.taskId ?? '');
  const imageFilename = String(body.imageFilename ?? '');
  const thumbnailFilename = String(body.thumbnailFilename ?? '');

  if (!taskId || !imageFilename) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少 taskId 或 imageFilename' });
  }

  const size = String(body.size ?? '');
  const quality = String(body.quality ?? '');

  // 图片先标记为 local：任务交付和公开图库都只通过本地媒体目录读取。
  const configKey = `task_image_${taskId}`;
  const value = JSON.stringify({
    imageFilename,
    thumbnailFilename,
    size,
    quality,
    storage: 'local',
    storedAt: new Date().toISOString(),
  });
  try {
    await prisma.systemConfig.upsert({
      where: { key: configKey },
      update: { value },
      create: { key: configKey, value },
    });

    // 追加 image_saved 子任务时也锁主任务，避免成功收尾和图片保存并发导致序号冲突。
    await prisma.$transaction(async (tx) => {
      await appendSubTaskLocked(tx, taskId, {
        kind: 'image_saved',
        status: 'success',
        finishedAt: new Date(),
      });
    });
  } catch (error) {
    // 图片文件已经由 media-service 保存；若主任务已被清理，只忽略业务回写并清掉刚写入的图片配置。
    if (isMissingTaskError(error)) {
      await prisma.systemConfig.deleteMany({ where: { key: configKey } });
      return sendJson(res, 200, { ok: true, data: { saved: false, taskId, imageFilename, reason: 'task_not_found' } });
    }
    throw error;
  }

  invalidateTaskCache([taskId]);
  // 图片刚落本地即可用于详情；成功状态写入会刷新图库列表缓存。
  invalidateImageCache(taskId);
  return sendJson(res, 200, { ok: true, data: { saved: true, taskId, imageFilename } });
}

/** Worker 回写视频文件名和真实生成参数；仍使用 task_image_ 兼容现有任务存在性查询。 */
async function reportVideo(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const body = await readJsonBody(req);
  const taskId = String(body.taskId ?? '');
  const videoFilename = String(body.videoFilename ?? '');
  const thumbnailFilename = String(body.thumbnailFilename ?? '');
  if (!taskId || !isSafeMediaFilename(videoFilename) || !videoFilename.toLowerCase().endsWith('.mp4')) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少合法的 taskId 或 MP4 文件名' });
  }
  if (thumbnailFilename && (!isSafeMediaFilename(thumbnailFilename) || !/\.(?:webp|jpe?g|png)$/i.test(thumbnailFilename))) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '视频首帧封面文件名不正确' });
  }
  const duration = Number(body.duration);
  const resolution = String(body.resolution ?? '');
  const aspectRatio = String(body.aspectRatio ?? '');
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 15
    || !['480p', '720p', '1080p'].includes(resolution)
    || !['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].includes(aspectRatio)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '视频结果参数不正确' });
  }
  const configKey = `task_image_${taskId}`;
  const value = JSON.stringify({
    mediaType: 'video',
    videoFilename,
    ...(thumbnailFilename ? { thumbnailFilename } : {}),
    duration,
    resolution,
    aspectRatio,
    mimeType: 'video/mp4',
    storage: 'local',
    storedAt: new Date().toISOString(),
  });
  try {
    await prisma.systemConfig.upsert({ where: { key: configKey }, update: { value }, create: { key: configKey, value } });
    await prisma.$transaction(async (tx) => {
      await appendSubTaskLocked(tx, taskId, { kind: 'video_saved', status: 'success', finishedAt: new Date() });
    });
  } catch (error) {
    if (isMissingTaskError(error)) {
      await prisma.systemConfig.deleteMany({ where: { key: configKey } });
      return sendJson(res, 200, { ok: true, data: { saved: false, taskId, videoFilename, reason: 'task_not_found' } });
    }
    throw error;
  }
  invalidateTaskCache([taskId]);
  invalidateImageCache(taskId);
  return sendJson(res, 200, { ok: true, data: { saved: true, taskId, videoFilename } });
}

/**
 * Worker 回写本地参考图文件名列表。
 * 每个参考图只有一个站内短文件名，backend 同时维护 sourceImageUrls 与 task_ref_images_* 状态快照。
 */
async function reportRefImages(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });

  const body = await readJsonBody(req);
  const taskId = String(body.taskId ?? '');
  const filenames = Array.isArray(body.filenames)
    ? body.filenames.filter((item): item is string => typeof item === 'string' && isSafeMediaFilename(item))
    : [];
  const statuses = Array.isArray(body.statuses)
    ? body.statuses.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

  if (!taskId || filenames.length === 0) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少 taskId 或 filenames' });
  }

  const configKey = `task_ref_images_${taskId}`;

  const saved = await runGenerationTaskWriteWithRetry(async () => prisma.$transaction(async (tx) => {
    // 先锁定主任务行再读取参考图，避免与状态收尾同时更新 generation_tasks 触发 MySQL 1020。
    const lockedTasks = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM generation_tasks WHERE id = ${taskId} FOR UPDATE
    `;
    if (lockedTasks.length === 0) return { saved: false, count: 0 };
    const task = await tx.generationTask.findUnique({
      where: { id: taskId },
      select: { sourceImageUrls: true },
    });
    if (!task) return { saved: false, count: 0 };

    // 参考图本地转存可能只成功一部分；回写时必须优先保留主任务原始顺序，不能用成功子集覆盖 sourceImageUrls。
    const currentFilenames = extractSafeReferenceFilenames(task.sourceImageUrls);
    const orderedFilenames = currentFilenames.length >= filenames.length ? currentFilenames : filenames;
    const refUrls = orderedFilenames.map(f => `/images/${f}`);
    const statusValue = buildReferenceArchiveConfigValue(orderedFilenames, statuses);

    const currentUrls = Array.isArray(task.sourceImageUrls) ? task.sourceImageUrls.filter((value): value is string => typeof value === 'string') : [];
    const sourceUrlsUnchanged = currentUrls.length === refUrls.length && currentUrls.every((value, index) => value === refUrls[index]);
    if (!sourceUrlsUnchanged) {
      // 参考图已是同一组站内路径时不重复写主任务，降低高并发状态回写的锁竞争。
      await tx.generationTask.update({
        where: { id: taskId },
        data: { sourceImageUrls: refUrls as any },
      });
    }

    // 仅在主任务仍存在时记录参考图本地状态，避免生成 task_ref_images_* 孤儿配置。
    await tx.systemConfig.upsert({
      where: { key: configKey },
      update: { value: statusValue },
      create: { key: configKey, value: statusValue },
    });
    return { saved: true, count: orderedFilenames.length };
  }));

  invalidateTaskCache([taskId]);
  // 参考图变更只影响详情页，不影响图库列表排序和可见集合。
  invalidateImageCache(taskId);
  if (!saved.saved) {
    return sendJson(res, 200, { ok: true, data: { saved: false, taskId, count: 0, reason: 'task_not_found' } });
  }
  return sendJson(res, 200, { ok: true, data: { saved: true, taskId, count: saved.count } });
}

/** 主任务并发写发生瞬时行版本冲突时短退避重试，所有尝试都重新获取任务行锁和最新参考图。 */
async function runGenerationTaskWriteWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isGenerationTaskWriteConflict(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 25));
    }
  }
  throw new Error('主任务并发写重试未返回结果');
}

/** 识别 generation_tasks 的 MySQL 行版本冲突和 Prisma 死锁冲突。 */
function isGenerationTaskWriteConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Record has changed since last read in table 'generation_tasks'")
    || error.message.includes('write conflict or a deadlock');
}

function verifyToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  const token = String(req.headers['x-service-token'] ?? '').trim();
  return token === expected;
}

/** 判断 worker 迟到回写时的“主任务不存在”错误，供内部接口做幂等忽略。 */
function isMissingTaskError(error: unknown): boolean {
  return (error instanceof GenerationError && error.kind === 'not_found')
    || (error instanceof Error && error.message.includes('生成主任务不存在'));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

/** Worker 内部追加子任务的统一入口；锁住主任务行后计算 sequence，避免并发回写撞唯一键。 */
async function appendSubTaskLocked(
  tx: Prisma.TransactionClient,
  taskId: string,
  data: Omit<Prisma.GenerationSubTaskUncheckedCreateInput, 'taskId' | 'sequence'>,
) {
  await lockGenerationTaskForUpdate(tx, taskId);
  return appendSubTaskAfterTaskLock(tx, taskId, data);
}

/** 锁定生成主任务行；所有需要计算子任务 sequence 的写入都必须先拿到这把锁。 */
async function lockGenerationTaskForUpdate(tx: Prisma.TransactionClient, taskId: string): Promise<void> {
  const lockedTasks = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM generation_tasks WHERE id = ${taskId} FOR UPDATE
  `;
  if (lockedTasks.length === 0) throw new Error(`生成主任务不存在：${taskId}`);
}

/** 在已持有主任务行锁的事务内追加子任务，避免重复 FOR UPDATE 和竞态检查顺序错误。 */
async function appendSubTaskAfterTaskLock(
  tx: Prisma.TransactionClient,
  taskId: string,
  data: Omit<Prisma.GenerationSubTaskUncheckedCreateInput, 'taskId' | 'sequence'>,
) {
  const lastSub = await tx.generationSubTask.findFirst({
    where: { taskId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  return tx.generationSubTask.create({
    data: {
      taskId,
      sequence: (lastSub?.sequence ?? 0) + 1,
      ...data,
    },
  });
}

/** 判断是否为重试编排收尾清理上报；该类请求只更新旧节点，不追加噪声子任务。 */
function isRetryTransitionCleanup(body: Record<string, unknown>, kind: string): boolean {
  return (kind === 'site_switch' || kind === 'same_site_retry')
    && body.status !== 'running'
    && body.attemptNo === undefined
    && body.siteId === undefined
    && body.siteName === undefined
    && body.model === undefined
    && body.retryable === undefined
    && body.nextAction === undefined
    && body.latencyMs === undefined
    && body.rawError === undefined
    && body.startedAt === undefined;
}

/** 返回任务最后一条子任务，用于清理型上报保持内部接口幂等成功。 */
async function findLatestSubTaskAfterTaskLock(tx: Prisma.TransactionClient, taskId: string) {
  return tx.generationSubTask.findFirst({
    where: { taskId },
    orderBy: { sequence: 'desc' },
  });
}

/** 关闭仍在 running 的切站/同站重试节点，避免终态任务时间线残留处理中状态。 */
async function closeRunningRetryTransitionsAfterTaskLock(tx: Prisma.TransactionClient, taskId: string, error: string): Promise<void> {
  await lockGenerationTaskForUpdate(tx, taskId);
  await tx.generationSubTask.updateMany({
    where: {
      taskId,
      kind: { in: ['site_switch', 'same_site_retry'] },
      status: 'running',
    },
    data: {
      status: 'skipped',
      error,
      finishedAt: new Date(),
    },
  });
}

function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** 任务调度参数快照 key，必须与 GenerationsRepository 写入口径一致。 */
function buildTaskGenerationParamsKey(taskId: string) {
  return `task_generation_params_${taskId}`;
}
