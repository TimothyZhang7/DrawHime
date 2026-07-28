/** 本文件定义后台存储页内部视图模型；只描述本地唯一副本存储状态。 */
import type { StorageCleanupLastStatus } from '@aiimage/shared-contracts';

/** 后台存储页从真实接口抽取后的单次本地快照。 */
export type LocalStorageSnapshot = {
  checkedAt: string | null;
  basePath: string | null;
  driver: string;
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
  usedPercent: number;
  mediaFiles: number;
  mediaBytes: number;
  refFiles: number;
  refBytes: number;
  imageFiles: number;
  imageBytes: number;
  thumbFiles: number;
  thumbBytes: number;
  tempFiles: number;
  largestFileBytes: number;
  protectedFiles: number;
  cleanupRuns: number;
  cleanupFailed: number;
  cleanupSkipped: number;
  cleanupLastRunAt: string | null;
  cleanupLastStatus: StorageCleanupLastStatus;
  cleanupLastDurationMs: number;
  cleanupLastDeleted: number;
  referenceDeleted: number;
  referenceSkipped: number;
  cacheDeleted: number;
  cleanupLastError: string | null;
  mediaHealthy: boolean;
  opsHealthy: boolean;
};

/** 存储页快照差值，用同一结构承载数值差异和当前状态字段。 */
export type LocalStorageDelta = LocalStorageSnapshot;

/** 浏览器持久化的本地存储历史采样点。 */
export type LocalStorageHistoryPoint = LocalStorageSnapshot & {
  sampledAtMs: number;
};

/** 趋势图每轮变化量。 */
export type LocalStorageDeltaPoint = {
  sampledAtMs: number;
  diskDeltaBytes: number;
  mediaDeltaBytes: number;
  refDeltaBytes: number;
};

/** 后台存储趋势可切换的时间范围。 */
export type LocalStorageTrendRangeKey = '15m' | '1h' | '6h' | '24h';

/** 本地维护链路健康判断结果。 */
export type LocalStorageHealthView = {
  servicesOk: boolean;
  cleanupOk: boolean;
  cleanupText: string;
  message: string | null;
};
