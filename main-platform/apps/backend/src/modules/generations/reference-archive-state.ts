/** 本文件统一维护参考图本地存储状态：文件名提取、状态快照构建和兼容旧配置读取共用。 */

/** 参考图单文件本地状态快照。 */
export type ReferenceArchiveAssetState = {
  /** 站内参考图短文件名。 */
  filename: string;
  /** 当前本地存储状态。 */
  status: 'local' | 'missing';
  /** 是否已确认写入本地媒体目录。 */
  stored: boolean;
  /** 用户原始上传或外链下载后的字节数。 */
  originalSize?: number;
  /** 当前本地文件字节数。 */
  size?: number;
  /** 是否发生过压缩或格式转换。 */
  compressed?: boolean;
  /** 最近一次写入本地媒体目录的时间。 */
  storedAt?: string;
  /** 最近一次错误摘要。 */
  error?: string | null;
};

/** 兼容 worker 直接回写的原始状态对象。 */
export type ReferenceArchiveStatusInput = Record<string, unknown>;

/** 构造参考图本地状态配置；保留 filenames 字段并兼容旧纯数组读取。 */
export function buildReferenceArchiveConfigValue(filenames: string[], statuses: ReferenceArchiveStatusInput[]): string {
  const statusByFilename = new Map<string, ReferenceArchiveAssetState>();
  for (const normalized of normalizeReferenceArchiveStates(statuses)) {
    statusByFilename.set(normalized.filename, normalized);
  }
  return JSON.stringify({
    version: 3,
    storage: 'local',
    filenames,
    assets: filenames.map((filename, index) => {
      const current = statusByFilename.get(filename) ?? {
        filename,
        status: 'local',
        stored: true,
        storedAt: new Date().toISOString(),
        error: null,
      } satisfies ReferenceArchiveAssetState;
      return {
        index: index + 1,
        filename,
        url: `/images/${filename}`,
        status: current.status,
        stored: current.stored,
        originalSize: current.originalSize,
        size: current.size,
        compressed: current.compressed === true,
        storedAt: current.storedAt ?? new Date().toISOString(),
        error: current.error ?? null,
      };
    }),
  });
}

/** 从主任务 sourceImageUrls 中恢复安全短文件名；用于防止部分转存结果覆盖原始参考图顺序。 */
export function extractSafeReferenceFilenames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const filename = extractReferenceFilename(item);
    if (filename) result.push(filename);
  }
  return result;
}

/** 支持 /images/filename 和纯短文件名，拒绝临时外链和 data URL，避免把不可控地址写回图库文件列表。 */
export function extractReferenceFilename(value: string): string {
  const clean = value.split('?')[0]?.trim() ?? '';
  if (clean.startsWith('/images/')) {
    const filename = decodeURIComponent(clean.replace('/images/', ''));
    return isSafeMediaFilename(filename) ? filename : '';
  }
  if (!clean.startsWith('http://') && !clean.startsWith('https://') && !clean.startsWith('data:') && isSafeMediaFilename(clean)) {
    return clean;
  }
  return '';
}

/** 读取已有的参考图本地状态配置，兼容旧纯数组和旧归档字段。 */
export function parseReferenceArchiveConfigValue(value: string): { filenames: string[]; assets: ReferenceArchiveAssetState[] } {
  const parsed = JSON.parse(value) as unknown;
  const rawFilenames = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { filenames?: unknown }).filenames)
    ? (parsed as { filenames: unknown[] }).filenames
    : [];
  const filenames = rawFilenames.filter((item): item is string => typeof item === 'string' && isSafeMediaFilename(item));
  const rawAssets = parsed && typeof parsed === 'object' && Array.isArray((parsed as { assets?: unknown }).assets)
    ? (parsed as { assets: unknown[] }).assets
    : [];
  return {
    filenames,
    assets: normalizeReferenceArchiveStates(rawAssets),
  };
}

/** 将 worker 或旧配置生成的状态对象规范化为本地存储状态。 */
export function normalizeReferenceArchiveStates(values: unknown[]): ReferenceArchiveAssetState[] {
  const result: ReferenceArchiveAssetState[] = [];
  for (const raw of values) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const filename = typeof record.filename === 'string' && isSafeMediaFilename(record.filename) ? record.filename : '';
    if (!filename) continue;
    const stored = record.stored === true
      || record.archived === true
      || record.status === 'local'
      || record.status === 'archived'
      || record.status === 'cleaned';
    result.push({
      filename,
      status: stored ? 'local' : 'missing',
      stored,
      originalSize: typeof record.originalSize === 'number' ? record.originalSize : undefined,
      size: typeof record.size === 'number'
        ? record.size
        : typeof record.archivedSize === 'number'
        ? record.archivedSize
        : undefined,
      compressed: record.compressed === true,
      storedAt: typeof record.storedAt === 'string'
        ? record.storedAt
        : typeof record.archivedAt === 'string'
        ? record.archivedAt
        : undefined,
      error: typeof record.error === 'string' ? record.error.slice(0, 500) : null,
    });
  }
  return result;
}

/** 参考图短文件名安全校验，内部回写也不能信任外部输入。 */
export function isSafeMediaFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}
