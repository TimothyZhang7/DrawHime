/** 本文件提供生成链路内部参考图 URL 归一化与确定性去重工具。 */

/** 参考图数量上限；与前端、Bot 和绘图接口保持一致。 */
const DEFAULT_MAX_SOURCE_IMAGES = 8;

/**
 * 归一化参考图列表并按确定性键去重。
 * 只移除完全相同的站内短文件名、同一站内图片 URL 或完全一致的外部/data URL，不做相似图判断，避免误删不同参考图。
 */
export function normalizeGenerationSourceImageUrls(value: unknown, maxCount = DEFAULT_MAX_SOURCE_IMAGES): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  const limit = Number.isSafeInteger(maxCount) && maxCount > 0 ? maxCount : DEFAULT_MAX_SOURCE_IMAGES;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = normalizeReferenceImageValue(item);
    if (!normalized) continue;
    const key = buildReferenceImageKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

/** 校验站内参考图是否仍可从 media-service 读取；用于扣费前阻断本地文件缺失的无效参考图。 */
export async function assertGenerationSourceImagesAvailable(sourceImageUrls: string[]): Promise<void> {
  for (const [index, sourceImageUrl] of sourceImageUrls.entries()) {
    const filename = extractStationMediaFilename(sourceImageUrl);
    if (!filename) continue;
    const ok = await canReadMediaFile(filename);
    if (!ok) {
      throw new SourceImageUnavailableError(index + 1, `第 ${index + 1} 张参考图文件不可用，请重新上传`);
    }
  }
}

/** 参考图不可用错误；调用方应在扣费前转成 400/409，避免用户为无效输入付费。 */
export class SourceImageUnavailableError extends Error {
  constructor(
    /** 从 1 开始的参考图序号。 */
    public readonly index: number,
    message: string,
  ) {
    super(message);
    this.name = 'SourceImageUnavailableError';
  }
}

/** 规范化单个参考图值；站内图片统一为 /images/<filename>，外部和 data URL 保留原始语义。 */
function normalizeReferenceImageValue(value: string): string {
  const clean = value.trim();
  if (!clean) return '';
  const filename = extractStationMediaFilename(clean);
  if (filename) return `/images/${filename}`;
  if (clean.startsWith('data:image/')) return clean;
  if (clean.startsWith('http://') || clean.startsWith('https://')) return clean;
  return isSafeMediaFilename(clean) ? `/images/${clean}` : '';
}

/** 轻量读取 media-service 文件响应头；不消费图片正文，避免校验阶段下载大图。 */
async function canReadMediaFile(filename: string): Promise<boolean> {
  const mediaUrl = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.REFERENCE_PREFLIGHT_TIMEOUT_MS ?? '5000'));
  try {
    const response = await fetch(`${mediaUrl}/media/files/${encodeURIComponent(filename)}`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** 构建去重键；站内图片按短文件名去重，外部/data URL 按完整值去重。 */
function buildReferenceImageKey(value: string): string {
  const filename = extractStationMediaFilename(value);
  if (filename) return `file:${filename}`;
  if (value.startsWith('data:image/')) return `data:${value}`;
  if (value.startsWith('http://') || value.startsWith('https://')) return `url:${value}`;
  return '';
}

/** 从 /images、/api/images、站内完整 URL 或纯短文件名中提取安全媒体短文件名。 */
function extractStationMediaFilename(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0]?.trim() ?? '';
  const raw = withoutQuery.startsWith('/images/')
    ? withoutQuery.slice('/images/'.length)
    : withoutQuery.startsWith('/api/images/')
    ? withoutQuery.slice('/api/images/'.length)
    : withoutQuery.startsWith('http://') || withoutQuery.startsWith('https://')
    ? extractStationMediaFilenameFromAbsoluteUrl(withoutQuery)
    : withoutQuery.includes('/')
    ? ''
    : withoutQuery;
  const decoded = safeDecodeURIComponent(raw);
  return isSafeMediaFilename(decoded) ? decoded : '';
}

/** 从站内绝对 URL 中提取 /images 下的短文件名；外部同名文件不按站内文件去重。 */
function extractStationMediaFilenameFromAbsoluteUrl(value: string): string {
  if (!value.startsWith('http://') && !value.startsWith('https://')) return '';
  try {
    const parsed = new URL(value);
    const appHost = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).hostname : '';
    const allowedHosts = new Set([appHost, 'www.xanime.ink', 'xanime.ink'].filter(Boolean));
    if (!allowedHosts.has(parsed.hostname)) return '';
    if (!parsed.pathname.startsWith('/images/') && !parsed.pathname.startsWith('/api/images/')) return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.at(-1) ?? '';
  } catch {
    return '';
  }
}

/** URL 解码失败时返回原值，避免异常输入打断创建任务。 */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 短文件名安全校验，避免路径穿越或把外部 URL 写成站内文件。 */
function isSafeMediaFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename)
    && !filename.includes('..')
    && !filename.includes('/')
    && !filename.includes('\\');
}
