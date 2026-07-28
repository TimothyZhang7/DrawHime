/**
 * 本文件注册 ops-worker 的运行态路由。
 * 定时任务通过内部 cron 定时器触发，不暴露外部接口。
 */
import { sendJson, type Route } from '@aiimage/core-utils';
import type {
  StorageCleanupLastStatus,
} from '@aiimage/shared-contracts';
import { StaleRepairService } from '../modules/stale-repair/stale-repair-service.js';

/** Worker 统计计数器。 */
const workerStats = {
  /** stale-repair 执行次数。 */
  staleRepairRuns: 0,
  /** stale-repair 修复任务数。 */
  staleRepairFixed: 0,
  /** stale-repair 失败次数。 */
  staleRepairFailed: 0,
  /** 过期端点清理次数。 */
  endpointCleanupRuns: 0,
  /** 过期端点清理数量。 */
  endpointCleanupDeleted: 0,
  /** media-service 本地暂存清理次数。 */
  mediaCacheCleanupRuns: 0,
  /** 旧远端存储统计字段；当前本地链路固定为 0，仅为后台契约保留。 */
  mediaCacheArchiveRuns: 0,
  /** 旧远端存储统计字段；当前本地链路固定为 0，仅为后台契约保留。 */
  mediaCacheArchiveArchived: 0,
  /** 旧远端存储统计字段；当前本地链路固定为 0，仅为后台契约保留。 */
  mediaCacheArchiveFailed: 0,
  /** 旧远端存储统计字段；当前本地链路固定为 0，仅为后台契约保留。 */
  mediaCacheArchiveSkipped: 0,
  /** media-service 本地暂存清理文件数。 */
  mediaCacheCleanupDeleted: 0,
  /** 旧远端存储统计字段；当前本地唯一副本禁止直删。 */
  mediaArchivedLocalDeleted: 0,
  /** 参考图本地副本清理文件数；当前默认不自动删除唯一副本。 */
  mediaReferenceCleanupDeleted: 0,
  /** 参考图本地维护保护跳过数量。 */
  mediaReferenceCleanupSkippedUnarchived: 0,
  /** media-service 本地暂存清理被跳过次数。 */
  mediaCacheCleanupSkipped: 0,
  /** 最近一次 media 本地暂存保护文件数。 */
  mediaCacheProtectedFiles: 0,
  /** media-service 本地暂存清理失败次数。 */
  mediaCacheCleanupFailed: 0,
  /** media-service 本地暂存清理最近一次错误摘要。 */
  mediaCacheCleanupLastError: null as string | null,
  /** media-service 本地暂存最近一次维护时间。 */
  mediaCacheCleanupLastRunAt: null as string | null,
  /** media-service 本地暂存最近一次维护状态。 */
  mediaCacheCleanupLastStatus: 'never' as StorageCleanupLastStatus,
  /** media-service 本地暂存最近一次维护耗时。 */
  mediaCacheCleanupLastDurationMs: 0,
  /** media-service 本地暂存最近一次维护总释放文件数。 */
  mediaCacheCleanupLastDeleted: 0,
  /** 图库自动打标执行次数。 */
  galleryTaggingRuns: 0,
  /** 图库自动打标成功数量。 */
  galleryTaggingSucceeded: 0,
  /** 图库自动打标失败数量。 */
  galleryTaggingFailed: 0,
  /** 图库自动打标跳过数量。 */
  galleryTaggingSkipped: 0,
  /** 图库自动打标最近一次错误。 */
  galleryTaggingLastError: null as string | null,
  /** media-service 最近一次参考图本地副本清理文件数。 */
  mediaReferenceCleanupLastDeleted: 0,
  /** media-service 最近一次参考图维护保护跳过数量。 */
  mediaReferenceCleanupLastSkippedUnarchived: 0,
  /** 旧远端存储统计字段；当前本地链路固定为 0，仅为后台契约保留。 */
  mediaCacheArchiveLastArchived: 0,
  /** 旧远端存储统计字段；当前本地链路固定为 0，仅为后台契约保留。 */
  mediaCacheArchiveLastFailed: 0,
  /** 旧远端存储统计字段；当前本地链路固定为 0，仅为后台契约保留。 */
  mediaCacheArchiveLastSkipped: 0,
  /** media-service 最近一次普通缓存清理文件数。 */
  mediaCacheCleanupLastCacheDeleted: 0,
  /** 旧远端存储统计字段；当前本地唯一副本禁止直删。 */
  mediaArchivedLocalLastDeleted: 0,
};

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';

/** 创建 ops-worker 专用路由和初始化定时任务。 */
export function createOpsWorkerRoutes(): Route[] {
  const staleRepairService = new StaleRepairService();

  // 每 5 分钟执行一次超时任务修复。
  const REPAIR_INTERVAL_MS = 5 * 60 * 1000;
  schedulePeriodic('stale-repair', REPAIR_INTERVAL_MS, async () => {
    const result = await staleRepairService.repairStaleTasks();
    workerStats.staleRepairRuns++;
    workerStats.staleRepairFixed += result.repaired;
    workerStats.staleRepairFailed += result.failed;
  });

  // 每 10 分钟清理过期端点。
  schedulePeriodic('endpoint-cleanup', 10 * 60 * 1000, async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/internal/cleanup-expired-endpoints`, {
        method: 'POST',
        headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { deleted: number } };
      workerStats.endpointCleanupRuns++;
      workerStats.endpointCleanupDeleted += data?.data?.deleted ?? 0;
    } catch {
      // endpoint 清理是低优先级维护任务，失败不影响主流程。
    }
  });

  // 巡检 media-service 本地状态；当前本地媒体是唯一副本，不做周期性图片删除。
  schedulePeriodic('media-cache-cleanup', Number(process.env.MEDIA_CACHE_CLEANUP_INTERVAL_MS ?? String(60 * 1000)), async () => {
    await cleanupMediaLocalCache();
  }, Number(process.env.MEDIA_CACHE_CLEANUP_INITIAL_DELAY_MS ?? '30000'));

  // 图库自动打标是旁路增强任务；backend 配置关闭时会立即返回 0，不影响其他运维任务。
  schedulePeriodic('gallery-tagging', Number(process.env.GALLERY_TAGGING_INTERVAL_MS ?? String(60 * 1000)), async () => {
    await runGalleryTagging();
  }, Number(process.env.GALLERY_TAGGING_INITIAL_DELAY_MS ?? '45000'));

  return [
    {
      method: 'GET',
      path: '/worker/status',
      handle: async (_req, res) => {
        return sendJson(res, 200, { ok: true, data: workerStats });
      },
    },
    /**
     * POST /worker/run-media-cache-cleanup
     * 手动触发 media-service 本地暂存清理，便于部署后立即验证。
     */
    {
      method: 'POST',
      path: '/worker/run-media-cache-cleanup',
      handle: async (_req, res) => {
        try {
          const result = await cleanupMediaLocalCache();
          return sendJson(res, 200, { ok: true, data: result });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'media 本地暂存清理失败';
          return sendJson(res, 500, { ok: false, data: { message } });
        }
      },
    },
    /**
     * POST /worker/run-stale-repair
     * 手动触发超时任务修复（运维排障用）。
     */
    {
      method: 'POST',
      path: '/worker/run-stale-repair',
      handle: async (_req, res) => {
        try {
          const result = await staleRepairService.repairStaleTasks();
          workerStats.staleRepairRuns++;
          workerStats.staleRepairFixed += result.repaired;
          workerStats.staleRepairFailed += result.failed;
          return sendJson(res, 200, { ok: true, data: result });
        } catch (error) {
          const message = error instanceof Error ? error.message : '修复执行失败';
          return sendJson(res, 500, { ok: false, data: { message } });
        }
      },
    },
  ];
}

/** 触发 backend 处理一小批图库打标任务；失败只记录统计，不影响 worker 健康。 */
async function runGalleryTagging(): Promise<void> {
  try {
    const limit = Number(process.env.GALLERY_TAGGING_BATCH_SIZE ?? '3');
    const res = await fetch(`${BACKEND_URL}/internal/gallery/tagging/run?limit=${encodeURIComponent(String(limit))}`, {
      method: 'POST',
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(Number(process.env.GALLERY_TAGGING_TIMEOUT_MS ?? '120000')),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { succeeded?: number; failed?: number; skipped?: number }; message?: string };
    if (!res.ok || data.ok !== true) throw new Error(data.message || `图库打标接口失败：${res.status}`);
    workerStats.galleryTaggingRuns++;
    workerStats.galleryTaggingSucceeded += Number(data.data?.succeeded ?? 0);
    workerStats.galleryTaggingFailed += Number(data.data?.failed ?? 0);
    workerStats.galleryTaggingSkipped += Number(data.data?.skipped ?? 0);
    workerStats.galleryTaggingLastError = null;
  } catch (error) {
    workerStats.galleryTaggingFailed++;
    workerStats.galleryTaggingLastError = error instanceof Error ? error.message : '图库打标执行失败';
  }
}

/** 执行 media-service 本地媒体维护；当前只记录巡检状态，不删除本地唯一副本。 */
async function cleanupMediaLocalCache(): Promise<{ deleted: number; protectedFiles: number }> {
  const startedAt = Date.now();
  workerStats.mediaCacheCleanupRuns++;
  workerStats.mediaCacheCleanupLastError = null;
  recordMediaCacheCleanupLast({
    status: 'success',
    durationMs: Date.now() - startedAt,
    protectedFiles: 0,
    deleted: 0,
    error: null,
  });
  return { deleted: 0, protectedFiles: 0 };
}

/** 记录最近一轮媒体维护结果；后台存储页依赖这些字段判断当前轮询是否真的推进。 */
function recordMediaCacheCleanupLast(input: {
  status: StorageCleanupLastStatus;
  durationMs: number;
  protectedFiles: number;
  deleted?: number;
  referenceDeleted?: number;
  referenceSkippedUnarchived?: number;
  archiveArchived?: number;
  archiveFailed?: number;
  archiveSkipped?: number;
  cacheDeleted?: number;
  archivedLocalDeleted?: number;
  error?: string | null;
}): void {
  workerStats.mediaCacheCleanupLastRunAt = new Date().toISOString();
  workerStats.mediaCacheCleanupLastStatus = input.status;
  workerStats.mediaCacheCleanupLastDurationMs = Math.max(0, Math.round(input.durationMs));
  workerStats.mediaCacheProtectedFiles = input.protectedFiles;
  workerStats.mediaCacheCleanupLastDeleted = Number(input.deleted ?? 0);
  workerStats.mediaReferenceCleanupLastDeleted = Number(input.referenceDeleted ?? 0);
  workerStats.mediaReferenceCleanupLastSkippedUnarchived = Number(input.referenceSkippedUnarchived ?? 0);
  workerStats.mediaCacheArchiveLastArchived = Number(input.archiveArchived ?? 0);
  workerStats.mediaCacheArchiveLastFailed = Number(input.archiveFailed ?? 0);
  workerStats.mediaCacheArchiveLastSkipped = Number(input.archiveSkipped ?? 0);
  workerStats.mediaCacheCleanupLastCacheDeleted = Number(input.cacheDeleted ?? 0);
  workerStats.mediaArchivedLocalLastDeleted = Number(input.archivedLocalDeleted ?? 0);
  if (input.error !== undefined) workerStats.mediaCacheCleanupLastError = input.error;
}

/**
 * 注册周期性任务，启动后立即执行一次，之后按间隔重复。
 * Worker 关闭时由 Node 进程退出隐式清理，不做显式取消。
 */
function schedulePeriodic(name: string, intervalMs: number, fn: () => Promise<void>, initialDelayMs = 5000): void {
  const run = async () => {
    try {
      await fn();
    } catch (error) {
      console.warn(`[ops-worker] [${name}] 周期任务执行失败`, error instanceof Error ? error.message : error);
    }
    setTimeout(run, intervalMs);
  };
  // 启动后延迟执行首次任务，给服务和跨服务器网络连接预热时间。
  setTimeout(run, initialDelayMs);
}
