/** 本文件维护后台存储页 24 小时本地轮询历史；只保存真实接口快照。 */
import type { AdminStorageOverviewResponse, StoragePrefixStat } from '@aiimage/shared-contracts';
import type {
  LocalStorageDelta,
  LocalStorageDeltaPoint,
  LocalStorageHealthView,
  LocalStorageHistoryPoint,
  LocalStorageSnapshot,
  LocalStorageTrendRangeKey,
} from './storage-types';

export const STORAGE_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
export const STORAGE_HISTORY_LIMIT = 3000;
export const STORAGE_HISTORY_STORAGE_KEY = 'aiimage:admin:local-storage-history:v2';
export const STORAGE_TREND_RANGES: Array<{ key: LocalStorageTrendRangeKey; label: string; durationMs: number }> = [
  { key: '15m', label: '15分钟', durationMs: 15 * 60 * 1000 },
  { key: '1h', label: '1小时', durationMs: 60 * 60 * 1000 },
  { key: '6h', label: '6小时', durationMs: 6 * 60 * 60 * 1000 },
  { key: '24h', label: '24小时', durationMs: STORAGE_HISTORY_TTL_MS },
];

/** 从聚合响应抽取本地唯一副本快照。 */
export function snapshotFromOverview(overview: AdminStorageOverviewResponse | null): LocalStorageSnapshot {
  const mediaStats = overview?.media.stats ?? null;
  const cleanup = overview?.ops.cleanup ?? null;
  const filesystem = mediaStats?.filesystem ?? null;
  return {
    checkedAt: overview?.checkedAt ?? null,
    basePath: mediaStats?.basePath ?? null,
    driver: mediaStats?.driver ?? 'local',
    usedBytes: filesystem?.usedBytes ?? 0,
    freeBytes: filesystem?.freeBytes ?? 0,
    totalBytes: filesystem?.totalBytes ?? 0,
    usedPercent: filesystem?.usedPercent ?? 0,
    mediaFiles: mediaStats?.totalFiles ?? 0,
    mediaBytes: mediaStats?.totalBytes ?? 0,
    refFiles: findPrefix(mediaStats?.prefixes, 'ref_')?.count ?? 0,
    refBytes: findPrefix(mediaStats?.prefixes, 'ref_')?.bytes ?? 0,
    imageFiles: findPrefix(mediaStats?.prefixes, 'img_')?.count ?? 0,
    imageBytes: findPrefix(mediaStats?.prefixes, 'img_')?.bytes ?? 0,
    thumbFiles: findPrefix(mediaStats?.prefixes, 'thumb_')?.count ?? 0,
    thumbBytes: findPrefix(mediaStats?.prefixes, 'thumb_')?.bytes ?? 0,
    tempFiles: mediaStats?.tempFiles ?? 0,
    largestFileBytes: mediaStats?.largestFileBytes ?? 0,
    protectedFiles: cleanup?.mediaCacheProtectedFiles ?? 0,
    cleanupRuns: cleanup?.mediaCacheCleanupRuns ?? 0,
    cleanupFailed: cleanup?.mediaCacheCleanupFailed ?? 0,
    cleanupSkipped: cleanup?.mediaCacheCleanupSkipped ?? 0,
    cleanupLastRunAt: cleanup?.mediaCacheCleanupLastRunAt ?? null,
    cleanupLastStatus: cleanup?.mediaCacheCleanupLastStatus ?? 'never',
    cleanupLastDurationMs: cleanup?.mediaCacheCleanupLastDurationMs ?? 0,
    cleanupLastDeleted: cleanup?.mediaCacheCleanupLastDeleted ?? 0,
    referenceDeleted: cleanup?.mediaReferenceCleanupDeleted ?? 0,
    referenceSkipped: cleanup?.mediaReferenceCleanupSkippedUnarchived ?? 0,
    cacheDeleted: cleanup?.mediaCacheCleanupDeleted ?? 0,
    cleanupLastError: cleanup?.mediaCacheCleanupLastError ?? null,
    mediaHealthy: overview?.media.healthy === true,
    opsHealthy: overview?.ops.healthy === true,
  };
}

/** 计算连续两轮本地存储快照差值。 */
export function diffSnapshot(prev: LocalStorageSnapshot | null, next: LocalStorageSnapshot): LocalStorageDelta {
  if (!prev) {
    return {
      ...next,
      usedBytes: 0,
      freeBytes: 0,
      totalBytes: 0,
      usedPercent: 0,
      mediaFiles: 0,
      mediaBytes: 0,
      refFiles: 0,
      refBytes: 0,
      imageFiles: 0,
      imageBytes: 0,
      thumbFiles: 0,
      thumbBytes: 0,
      tempFiles: 0,
      largestFileBytes: 0,
      protectedFiles: 0,
      cleanupRuns: 0,
      cleanupFailed: 0,
      cleanupSkipped: 0,
      cleanupLastDeleted: next.cleanupLastDeleted,
      referenceDeleted: 0,
      referenceSkipped: 0,
      cacheDeleted: 0,
    };
  }
  return {
    checkedAt: next.checkedAt,
    basePath: next.basePath,
    driver: next.driver,
    usedBytes: next.usedBytes - prev.usedBytes,
    freeBytes: next.freeBytes - prev.freeBytes,
    totalBytes: next.totalBytes - prev.totalBytes,
    usedPercent: next.usedPercent - prev.usedPercent,
    mediaFiles: next.mediaFiles - prev.mediaFiles,
    mediaBytes: next.mediaBytes - prev.mediaBytes,
    refFiles: next.refFiles - prev.refFiles,
    refBytes: next.refBytes - prev.refBytes,
    imageFiles: next.imageFiles - prev.imageFiles,
    imageBytes: next.imageBytes - prev.imageBytes,
    thumbFiles: next.thumbFiles - prev.thumbFiles,
    thumbBytes: next.thumbBytes - prev.thumbBytes,
    tempFiles: next.tempFiles - prev.tempFiles,
    largestFileBytes: next.largestFileBytes - prev.largestFileBytes,
    protectedFiles: next.protectedFiles - prev.protectedFiles,
    cleanupRuns: next.cleanupRuns - prev.cleanupRuns,
    cleanupFailed: next.cleanupFailed - prev.cleanupFailed,
    cleanupSkipped: next.cleanupSkipped - prev.cleanupSkipped,
    cleanupLastRunAt: next.cleanupLastRunAt,
    cleanupLastStatus: next.cleanupLastStatus,
    cleanupLastDurationMs: next.cleanupLastDurationMs,
    cleanupLastDeleted: next.cleanupLastDeleted,
    referenceDeleted: next.referenceDeleted - prev.referenceDeleted,
    referenceSkipped: next.referenceSkipped - prev.referenceSkipped,
    cacheDeleted: next.cacheDeleted - prev.cacheDeleted,
    cleanupLastError: next.cleanupLastError,
    mediaHealthy: next.mediaHealthy,
    opsHealthy: next.opsHealthy,
  };
}

/** 判断本地唯一副本链路的展示健康状态。 */
export function evaluateLocalStorageHealth(snapshot: LocalStorageSnapshot, delta: LocalStorageDelta, hasPrevious: boolean): LocalStorageHealthView {
  const servicesOk = snapshot.mediaHealthy && snapshot.opsHealthy;
  const recentFailure = snapshot.cleanupLastStatus === 'failed' || snapshot.cleanupLastStatus === 'partial' || snapshot.cleanupLastError != null;
  const lastRoundReleased = snapshot.cleanupLastDeleted > 0 || snapshot.cacheDeleted > 0;
  const pollReleased = hasPrevious && (delta.refFiles < 0 || delta.mediaFiles < 0 || delta.usedBytes < 0);
  if (!servicesOk) {
    return { servicesOk, cleanupOk: false, cleanupText: '服务异常', message: 'media-service 或 ops-worker 探活异常，本地存储状态无法确认。' };
  }
  if (recentFailure) {
    return { servicesOk, cleanupOk: false, cleanupText: '存在失败', message: snapshot.cleanupLastError ?? '最近一轮本地维护出现失败，请继续观察失败数。' };
  }
  if (lastRoundReleased || pollReleased) {
    return { servicesOk, cleanupOk: true, cleanupText: '维护有效', message: '最近轮询观察到本地文件释放，磁盘水位会随轮询更新。' };
  }
  return { servicesOk, cleanupOk: true, cleanupText: '本地稳定', message: null };
}

/** 从浏览器读取最近 24 小时的真实存储快照。 */
export function readPersistedStorageHistory(now: number): LocalStorageHistoryPoint[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return pruneStorageHistory(parsed.filter(isStorageHistoryPoint), now);
  } catch {
    return [];
  }
}

/** 持久化最近 24 小时真实快照；失败不阻断页面。 */
export function persistStorageHistory(history: LocalStorageHistoryPoint[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // 浏览器禁用 localStorage 时保留内存态即可，不能影响后台监控页使用。
  }
}

/** 追加一次真实轮询采样。 */
export function appendStorageHistory(items: LocalStorageHistoryPoint[], snapshot: LocalStorageSnapshot, now: number): LocalStorageHistoryPoint[] {
  const sampledAtMs = items.some((item) => item.sampledAtMs === now) ? now + 1 : now;
  return pruneStorageHistory([...items.filter((item) => item.sampledAtMs !== sampledAtMs), { ...snapshot, sampledAtMs }], now);
}

/** 按时间范围筛选快照采样点。 */
export function filterStorageHistoryByRange(history: LocalStorageHistoryPoint[], range: LocalStorageTrendRangeKey, now: number): LocalStorageHistoryPoint[] {
  const since = now - storageTrendRangeDuration(range);
  return history.filter((item) => item.sampledAtMs >= since);
}

/** 把连续快照转成趋势图差值点。 */
export function buildStorageDeltaPoints(history: LocalStorageHistoryPoint[]): LocalStorageDeltaPoint[] {
  const points: LocalStorageDeltaPoint[] = [];
  for (let index = 1; index < history.length; index += 1) {
    const prev = history[index - 1];
    const current = history[index];
    if (!prev || !current) continue;
    points.push({
      sampledAtMs: current.sampledAtMs,
      diskDeltaBytes: current.usedBytes - prev.usedBytes,
      mediaDeltaBytes: current.mediaBytes - prev.mediaBytes,
      refDeltaBytes: current.refBytes - prev.refBytes,
    });
  }
  return points;
}

/** 按时间范围筛选趋势图差值点。 */
export function filterStorageDeltaPointsByRange(points: LocalStorageDeltaPoint[], range: LocalStorageTrendRangeKey, now: number): LocalStorageDeltaPoint[] {
  const since = now - storageTrendRangeDuration(range);
  return points.filter((item) => item.sampledAtMs >= since);
}

/** 读取趋势区间名称。 */
export function storageTrendRangeLabel(range: LocalStorageTrendRangeKey): string {
  return STORAGE_TREND_RANGES.find((item) => item.key === range)?.label ?? '24小时';
}

/** 查找指定本地文件名前缀统计。 */
export function findPrefix(prefixes: StoragePrefixStat[] | undefined, prefix: string): StoragePrefixStat | undefined {
  return prefixes?.find((item) => item.prefix === prefix);
}

/** 清理过期或异常的本地历史采样。 */
function pruneStorageHistory(items: LocalStorageHistoryPoint[], now: number): LocalStorageHistoryPoint[] {
  const since = now - STORAGE_HISTORY_TTL_MS;
  return items
    .filter((item) => Number.isFinite(item.sampledAtMs) && item.sampledAtMs >= since && item.sampledAtMs <= now + 60_000)
    .sort((a, b) => a.sampledAtMs - b.sampledAtMs)
    .slice(-STORAGE_HISTORY_LIMIT);
}

/** 校验 localStorage 里的采样结构，避免旧版本缓存污染页面。 */
function isStorageHistoryPoint(value: unknown): value is LocalStorageHistoryPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<LocalStorageHistoryPoint>;
  return (
    typeof point.sampledAtMs === 'number' &&
    typeof point.usedBytes === 'number' &&
    typeof point.mediaBytes === 'number' &&
    typeof point.refBytes === 'number' &&
    typeof point.mediaFiles === 'number' &&
    typeof point.refFiles === 'number'
  );
}

/** 读取趋势区间毫秒长度。 */
function storageTrendRangeDuration(range: LocalStorageTrendRangeKey): number {
  return STORAGE_TREND_RANGES.find((item) => item.key === range)?.durationMs ?? STORAGE_HISTORY_TTL_MS;
}
