/**
 * 本文件负责全站背景图片的本地持久化、压缩、删除与公开读取。
 * 背景图片属于站点外观资产，不进入图库、参考图或用户头像链路。
 */
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/** 后台背景图原始上传上限为 15MB。 */
export const SITE_BACKGROUND_UPLOAD_MAX_BYTES = Number(process.env.SITE_BACKGROUND_UPLOAD_MAX_BYTES ?? String(15 * 1024 * 1024));
const SITE_BACKGROUND_MAX_EDGE = Number(process.env.SITE_BACKGROUND_MAX_EDGE ?? '2560');
const SITE_BACKGROUND_WEBP_QUALITY = Number(process.env.SITE_BACKGROUND_WEBP_QUALITY ?? '85');
const MAX_INPUT_PIXELS = 48_000_000;
const SAFE_BACKGROUND_FILENAME = /^site_bg_[a-f0-9]{24}\.webp$/;
const ALLOWED_INPUT_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** 返回全站背景图存储目录；生产默认位于不会被快速部署覆盖的 /v3/local。 */
export function getSiteBackgroundStoragePath(): string {
  const configured = process.env.SITE_BACKGROUND_STORAGE_PATH?.trim();
  if (configured) return resolve(configured);
  const isProductionRoot = process.cwd().startsWith('/v3');
  return resolve(isProductionRoot ? '/v3/local/site-backgrounds' : join(process.cwd(), 'local', 'site-backgrounds'));
}

/** 判断背景文件名是否由服务端安全生成。 */
export function isSafeSiteBackgroundFilename(filename: string): boolean {
  return SAFE_BACKGROUND_FILENAME.test(filename);
}

/** 根据安全文件名生成公开背景图 URL。 */
export function buildSiteBackgroundUrl(filename: string | null | undefined): string | null {
  return filename && isSafeSiteBackgroundFilename(filename)
    ? `/api/appearance/background/${encodeURIComponent(filename)}`
    : null;
}

/** 校验、缩放并压缩管理员上传的背景图，成功后原子落盘。 */
export async function saveSiteBackground(input: Buffer, mimeType: string): Promise<string> {
  if (input.length <= 0) throw new Error('缺少背景图片');
  if (input.length > SITE_BACKGROUND_UPLOAD_MAX_BYTES) throw new Error('背景图片不能超过 15MB');
  if (!ALLOWED_INPUT_MIME.has(normalizeMimeType(mimeType))) throw new Error('背景图片仅支持 PNG、JPEG、WebP');

  const sharpFn = await loadSharp();
  let output: Buffer;
  try {
    output = await sharpFn(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: SITE_BACKGROUND_MAX_EDGE,
        height: SITE_BACKGROUND_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: SITE_BACKGROUND_WEBP_QUALITY, effort: 4 })
      .toBuffer();
  } catch {
    throw new Error('背景图片格式不正确或分辨率过大');
  }
  if (output.length <= 0) throw new Error('背景图片处理失败');

  const basePath = getSiteBackgroundStoragePath();
  await mkdir(basePath, { recursive: true });
  const filename = `site_bg_${randomBytes(12).toString('hex')}.webp`;
  const target = resolveSiteBackgroundPath(filename);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, output);
  await rename(temporary, target);
  return filename;
}

/** 删除旧背景图；只允许删除本服务生成的安全文件名。 */
export async function deleteSiteBackgroundFile(filename: string | null | undefined): Promise<void> {
  if (!filename || !isSafeSiteBackgroundFilename(filename)) return;
  try {
    await unlink(resolveSiteBackgroundPath(filename));
  } catch {
    // 文件已经不存在时，配置清理仍可继续完成。
  }
}

/** 判断当前配置的背景文件是否真实存在。 */
export async function siteBackgroundFileExists(filename: string | null | undefined): Promise<boolean> {
  if (!filename || !isSafeSiteBackgroundFilename(filename)) return false;
  const fileStats = await stat(resolveSiteBackgroundPath(filename)).catch(() => null);
  return Boolean(fileStats?.isFile());
}

/** 使用长缓存公开读取带随机文件名的背景图。 */
export async function serveSiteBackground(filename: string, res: ServerResponse): Promise<boolean> {
  if (!isSafeSiteBackgroundFilename(filename)) return false;
  const filePath = resolveSiteBackgroundPath(filename);
  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats?.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': 'image/webp',
    'Content-Length': String(fileStats.size),
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolvePromise);
    stream.pipe(res);
  });
  return true;
}

/** 解析背景图路径并阻止路径穿越。 */
function resolveSiteBackgroundPath(filename: string): string {
  if (!isSafeSiteBackgroundFilename(filename)) throw new Error('背景图片文件名不合法');
  const basePath = getSiteBackgroundStoragePath();
  const resolved = resolve(basePath, filename);
  if (resolved !== basePath && !resolved.startsWith(`${basePath}${sep}`)) throw new Error('背景图片路径不合法');
  return resolved;
}

/** 兼容带 charset 的图片 Content-Type。 */
function normalizeMimeType(mimeType: string): string {
  return String(mimeType || '').split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream';
}

/** 延迟加载 sharp，并限制单进程原生缓存，避免偶发上传长期占用内存。 */
async function loadSharp(): Promise<any> {
  const mod = await import('sharp');
  const sharpFn = ((mod as { default?: unknown }).default ?? mod) as any;
  if (typeof sharpFn.cache === 'function') sharpFn.cache({ memory: 0, files: 0, items: 0 });
  if (typeof sharpFn.concurrency === 'function') sharpFn.concurrency(1);
  return sharpFn;
}
