/** 本文件定义运维接口契约：本地存储巡检与后台存储面板。 */

/** 单个存储前缀统计项。 */
export type StoragePrefixStat = {
  /** 文件名前缀，例如 ref_、img_、thumb_。 */
  prefix: string;
  /** 文件数量。 */
  count: number;
  /** 文件总字节数。 */
  bytes: number;
};

/** 本地文件大小分布。 */
export type StorageSizeBucket = {
  /** 分桶标签。 */
  label: string;
  /** 文件数量。 */
  count: number;
  /** 文件总字节数。 */
  bytes: number;
};

/** 文件系统容量信息。 */
export type StorageFilesystemStat = {
  /** 文件系统挂载路径或统计路径。 */
  path: string;
  /** 总字节数。 */
  totalBytes: number;
  /** 已用字节数。 */
  usedBytes: number;
  /** 可用字节数。 */
  freeBytes: number;
  /** 已用百分比，0-100。 */
  usedPercent: number;
};

/** media-service 本地存储统计响应。 */
export type MediaStorageStatsResponse = {
  /** 存储驱动。 */
  driver: string;
  /** 本地媒体目录。 */
  basePath: string | null;
  /** 统计时间。 */
  checkedAt: string;
  /** 本地文件总数。 */
  totalFiles: number;
  /** 本地文件总字节数。 */
  totalBytes: number;
  /** 临时文件数量。 */
  tempFiles: number;
  /** 最大文件字节数。 */
  largestFileBytes: number;
  /** 前缀聚合。 */
  prefixes: StoragePrefixStat[];
  /** 大小分布。 */
  sizeBuckets: StorageSizeBucket[];
  /** 文件系统容量。 */
  filesystem: StorageFilesystemStat | null;
};

/** 运维 Worker 最近一轮媒体清理状态。 */
export type StorageCleanupLastStatus = 'success' | 'partial' | 'skipped' | 'failed' | 'never';

/** 运维 Worker 存储清理统计摘要。 */
export type StorageCleanupStats = {
  /** 本地暂存清理成功次数。 */
  mediaCacheCleanupRuns: number;
  /** 本地暂存清理失败次数。 */
  mediaCacheCleanupFailed: number;
  /** 本地暂存清理跳过次数。 */
  mediaCacheCleanupSkipped: number;
  /** 最近保护文件数量。 */
  mediaCacheProtectedFiles: number;
  /** 本地暂存清理删除文件数。 */
  mediaCacheCleanupDeleted: number;
  /** 参考图本地副本清理删除文件数。 */
  mediaReferenceCleanupDeleted: number;
  /** 旧远端存储字段；当前本地唯一副本链路固定为 0。 */
  mediaArchivedLocalDeleted: number;
  /** 旧远端存储字段；当前本地链路固定为 0。 */
  mediaCacheArchiveRuns: number;
  /** 旧远端存储字段；当前本地链路固定为 0。 */
  mediaCacheArchiveArchived: number;
  /** 旧远端存储字段；当前本地链路固定为 0。 */
  mediaCacheArchiveFailed: number;
  /** 旧远端存储字段；当前本地链路固定为 0。 */
  mediaCacheArchiveSkipped: number;
  /** 参考图本地维护保护跳过数量。 */
  mediaReferenceCleanupSkippedUnarchived: number;
  /** 最近一次清理错误。 */
  mediaCacheCleanupLastError: string | null;
  /** 最近一次本地媒体维护运行时间。 */
  mediaCacheCleanupLastRunAt: string | null;
  /** 最近一次本地媒体维护状态。 */
  mediaCacheCleanupLastStatus: StorageCleanupLastStatus;
  /** 最近一次本地媒体维护耗时。 */
  mediaCacheCleanupLastDurationMs: number;
  /** 最近一次本地媒体维护总释放文件数。 */
  mediaCacheCleanupLastDeleted: number;
  /** 最近一次参考图清理释放文件数。 */
  mediaReferenceCleanupLastDeleted: number;
  /** 最近一次参考图维护保护跳过数量。 */
  mediaReferenceCleanupLastSkippedUnarchived: number;
  /** 旧远端存储字段；当前本地链路固定为 0。 */
  mediaCacheArchiveLastArchived: number;
  /** 旧远端存储字段；当前本地链路固定为 0。 */
  mediaCacheArchiveLastFailed: number;
  /** 旧远端存储字段；当前本地链路固定为 0。 */
  mediaCacheArchiveLastSkipped: number;
  /** 最近一次通用本地缓存清理释放文件数。 */
  mediaCacheCleanupLastCacheDeleted: number;
  /** 旧远端存储字段；当前本地唯一副本链路固定为 0。 */
  mediaArchivedLocalLastDeleted: number;
};

/** 后台存储面板聚合响应。 */
export type AdminStorageOverviewResponse = {
  /** backend 聚合时间。 */
  checkedAt: string;
  /** media-service 连接状态。 */
  media: {
    healthy: boolean;
    statusCode: number | null;
    latencyMs: number | null;
    error: string | null;
    stats: MediaStorageStatsResponse | null;
  };
  /** ops-worker 连接状态和清理统计。 */
  ops: {
    healthy: boolean;
    statusCode: number | null;
    latencyMs: number | null;
    error: string | null;
    cleanup: StorageCleanupStats | null;
  };
};
