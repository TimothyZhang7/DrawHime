/** 本文件集中处理后台存储页格式化逻辑，避免视图组件重复实现。 */
import type { LocalStorageSnapshot } from './storage-types';

/** 格式化相对时间；后台轮询时间统一用当前页面时间计算。 */
export function formatRelativeTime(iso: string | null, now: number): string {
  if (!iso) return '-';
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return '-';
  const diff = Math.max(0, now - timestamp);
  if (diff < 1000) return '1秒前';
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}秒前`;
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}分钟前`;
  if (diff < 24 * 3_600_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** 格式化图表横轴时间。 */
export function formatChartTime(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return '-';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

/** 格式化字节大小。 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

/** 格式化带正负号的字节变化。 */
export function formatSignedBytes(value: number): string {
  if (value === 0) return '0 B';
  return `${value > 0 ? '+' : '-'}${formatBytes(Math.abs(value))}`;
}

/** 格式化带正负号的计数变化。 */
export function formatSignedCount(value: number): string {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '-'}${Math.abs(value)}`;
}

/** 格式化本地维护耗时。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}分${Math.round((ms % 60_000) / 1000)}秒`;
}

/** 将清理状态转为中文。 */
export function cleanupStatusLabel(status: LocalStorageSnapshot['cleanupLastStatus']): string {
  const map: Record<LocalStorageSnapshot['cleanupLastStatus'], string> = {
    success: '成功',
    partial: '部分失败',
    skipped: '已跳过',
    failed: '失败',
    never: '未运行',
  };
  return map[status];
}

/** 根据文件名前缀输出后台展示名称。 */
export function prefixLabel(prefix: string): string {
  const map: Record<string, string> = {
    ref_: '参考图 ref_',
    img_: '生成原图 img_',
    thumb_: '缩略图 thumb_',
    zip_: '下载包 zip_',
    other: '其他本地文件',
  };
  return map[prefix] ?? prefix;
}
