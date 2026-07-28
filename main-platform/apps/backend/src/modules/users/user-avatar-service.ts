/**
 * 本文件实现 Web 用户头像本地存储服务。
 *
 * 头像是网页账号资料，不属于生成图、参考图或 QQ 头像：
 * - 只写入 backend 管理的本地目录；
 * - 不进入 media-service 图片链路；
 * - 不使用 QQ 头像作为兜底。
 */
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/** 用户头像原始上传最大 5MB；这是单文件限制。 */
export const USER_AVATAR_UPLOAD_MAX_BYTES = Number(process.env.USER_AVATAR_UPLOAD_MAX_BYTES ?? String(5 * 1024 * 1024));
/** 用户头像统一输出为 512x512，避免超大图片长期占用本地磁盘。 */
const USER_AVATAR_SIZE = Number(process.env.USER_AVATAR_SIZE ?? '512');
/** 用户头像 WebP 质量；目标是清晰且稳定小于 512KB。 */
const USER_AVATAR_WEBP_QUALITY = Number(process.env.USER_AVATAR_WEBP_QUALITY ?? '82');
const SAFE_AVATAR_FILENAME = /^avatar_u\d+_[a-f0-9]{24}\.webp$/;
const ALLOWED_INPUT_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_INPUT_PIXELS = 32_000_000;

/** 返回头像存储根目录；生产默认 /v3/local/user-avatars，本地默认 local/user-avatars。 */
export function getUserAvatarStoragePath(): string {
  const configured = process.env.USER_AVATAR_STORAGE_PATH?.trim();
  if (configured) return resolve(configured);
  const isProductionRoot = process.cwd().startsWith('/v3');
  return resolve(isProductionRoot ? '/v3/local/user-avatars' : join(process.cwd(), 'local', 'user-avatars'));
}

/** 判断头像文件名是否由服务端生成，防止路径穿越和误删。 */
export function isSafeAvatarFilename(filename: string): boolean {
  return SAFE_AVATAR_FILENAME.test(filename);
}

/** 根据文件名生成前端可访问头像 URL。 */
export function buildAvatarUrl(filename: string | null | undefined): string | null {
  return filename && isSafeAvatarFilename(filename) ? `/api/users/avatar/${filename}` : null;
}

/** 把用户上传图片压缩为本地 WebP 头像，并返回新文件名。 */
export async function saveUserAvatar(userId: number, input: Buffer, mimeType: string): Promise<string> {
  if (input.length <= 0) throw new Error('缺少头像图片');
  if (input.length > USER_AVATAR_UPLOAD_MAX_BYTES) throw new Error('头像图片不能超过 5MB');
  if (!ALLOWED_INPUT_MIME.has(normalizeMimeType(mimeType))) throw new Error('头像仅支持 PNG、JPEG、WebP');

  const sharpFn = await loadSharp();
  let output: Buffer;
  try {
    output = await sharpFn(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(USER_AVATAR_SIZE, USER_AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: USER_AVATAR_WEBP_QUALITY, effort: 4 })
      .toBuffer();
  } catch {
    throw new Error('头像图片格式不正确');
  }
  if (output.length <= 0) throw new Error('头像处理失败');

  const basePath = getUserAvatarStoragePath();
  await mkdir(basePath, { recursive: true });
  const filename = `avatar_u${userId}_${randomBytes(12).toString('hex')}.webp`;
  const target = resolveAvatarPath(filename);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, output);
  await rename(tmp, target);
  return filename;
}

/** 删除当前用户旧头像；只允许删除服务端生成的头像短文件名。 */
export async function deleteUserAvatarFile(filename: string | null | undefined): Promise<void> {
  if (!filename || !isSafeAvatarFilename(filename)) return;
  try {
    await unlink(resolveAvatarPath(filename));
  } catch {
    // 旧文件已经不存在时无需影响用户资料更新。
  }
}

/** 把头像文件流式写回浏览器。 */
export async function serveUserAvatar(filename: string, res: ServerResponse): Promise<boolean> {
  if (!isSafeAvatarFilename(filename)) return false;
  const filePath = resolveAvatarPath(filename);
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

/** 头像路径解析必须保证最终路径仍在头像根目录内。 */
function resolveAvatarPath(filename: string): string {
  if (!isSafeAvatarFilename(filename)) throw new Error('头像文件名不合法');
  const basePath = getUserAvatarStoragePath();
  const resolved = resolve(basePath, filename);
  if (resolved !== basePath && !resolved.startsWith(`${basePath}${sep}`)) throw new Error('头像路径不合法');
  return resolved;
}

/** 兼容带 charset 的 Content-Type。 */
function normalizeMimeType(mimeType: string): string {
  return String(mimeType || '').split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream';
}

/** 动态加载 sharp，避免测试环境提前初始化原生库。 */
async function loadSharp(): Promise<any> {
  const mod = await import('sharp');
  const sharpFn = ((mod as { default?: unknown }).default ?? mod) as any;
  if (typeof sharpFn.cache === 'function') sharpFn.cache({ memory: 0, files: 0, items: 0 });
  if (typeof sharpFn.concurrency === 'function') sharpFn.concurrency(1);
  return sharpFn;
}
