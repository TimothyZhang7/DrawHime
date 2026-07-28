/**
 * 本文件负责图片放大源图的私有本地存储。
 *
 * 原图和轻量预览原子落盘，数据库只保存安全短文件名；读取前必须完成任务归属鉴权。
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import sharp from 'sharp';

const MAX_SOURCE_PIXELS = 48_000_000;
const SAFE_SOURCE_NAME = /^upsrc_u\d+_[a-f0-9]{24}\.bin$/;
const SAFE_PREVIEW_NAME = /^upprev_u\d+_[a-f0-9]{24}\.webp$/;

/** 已保存图片放大源图的安全元数据。 */
export interface StoredImageUpscaleSource {
  /** 原图私有短文件名。 */
  sourceStoredName: string;
  /** WebP 预览私有短文件名。 */
  previewStoredName: string;
  /** 后端识别出的真实图片 MIME。 */
  mimeType: string;
  /** 原图字节数。 */
  sizeBytes: number;
  /** 原图宽度。 */
  width: number;
  /** 原图高度。 */
  height: number;
}

/** 图片放大源图存储错误。 */
export class ImageUpscaleSourceStorageError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'ImageUpscaleSourceStorageError';
  }
}

/** 图片放大私有源图存储服务。 */
export class ImageUpscaleSourceStorage {
  /** 校验图片并原子保存原图与历史列表预览。 */
  async save(userId: number, input: Buffer, requestMimeType: string): Promise<StoredImageUpscaleSource> {
    if (input.length <= 0) throw new ImageUpscaleSourceStorageError('invalid_image', '请上传图片文件', 400);
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(input, { failOn: 'error', limitInputPixels: MAX_SOURCE_PIXELS }).metadata();
    } catch {
      throw new ImageUpscaleSourceStorageError('invalid_image', '图片文件无法识别', 400);
    }
    const width = Number(metadata.width ?? 0);
    const height = Number(metadata.height ?? 0);
    if (!width || !height) throw new ImageUpscaleSourceStorageError('invalid_image', '图片尺寸不正确', 400);
    if (width * height > MAX_SOURCE_PIXELS) throw new ImageUpscaleSourceStorageError('invalid_image', '图片像素过大，请缩小后再上传', 400);

    const token = randomBytes(12).toString('hex');
    const sourceStoredName = `upsrc_u${userId}_${token}.bin`;
    const previewStoredName = `upprev_u${userId}_${token}.webp`;
    const basePath = getImageUpscaleSourceStoragePath();
    await mkdir(basePath, { recursive: true });
    const sourcePath = resolveStoredPath(sourceStoredName, false);
    const previewPath = resolveStoredPath(previewStoredName, true);
    const sourceTmp = `${sourcePath}.${process.pid}.${Date.now()}.tmp`;
    const previewTmp = `${previewPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(sourceTmp, input);
      const preview = await sharp(input, { failOn: 'error', limitInputPixels: MAX_SOURCE_PIXELS })
        .rotate()
        .resize({ width: 560, height: 560, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
      await writeFile(previewTmp, preview);
      await rename(sourceTmp, sourcePath);
      await rename(previewTmp, previewPath);
    } catch (error) {
      await Promise.all([sourceTmp, previewTmp, sourcePath, previewPath].map((path) => unlink(path).catch(() => undefined)));
      if (error instanceof ImageUpscaleSourceStorageError) throw error;
      throw new ImageUpscaleSourceStorageError('storage_failed', '图片放大源图保存失败', 500);
    }

    return { sourceStoredName, previewStoredName, mimeType: normalizeImageMime(metadata.format, requestMimeType), sizeBytes: input.length, width, height };
  }

  /** 读取已通过数据库归属校验的原图，供 backend 重启后重新排队。 */
  async read(sourceStoredName: string): Promise<Buffer | null> {
    return readFile(resolveStoredPath(sourceStoredName, false)).catch(() => null);
  }

  /** 向当前登录用户输出已通过任务归属校验的源图或轻量预览。 */
  async serve(storedName: string, mimeType: string, preview: boolean, res: ServerResponse): Promise<boolean> {
    const filePath = resolveStoredPath(storedName, preview);
    const fileStats = await stat(filePath).catch(() => null);
    if (!fileStats?.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': preview ? 'image/webp' : mimeType,
      'Content-Length': String(fileStats.size),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', resolvePromise);
      stream.pipe(res);
    });
    return true;
  }

  /** 数据库创建失败时回滚刚落盘的私有文件。 */
  async remove(sourceStoredName: string, previewStoredName: string): Promise<void> {
    await Promise.all([
      unlink(resolveStoredPath(sourceStoredName, false)).catch(() => undefined),
      unlink(resolveStoredPath(previewStoredName, true)).catch(() => undefined),
    ]);
  }
}

/** 返回图片放大私有源图目录；生产默认位于不会随源码部署覆盖的 /v3/local。 */
function getImageUpscaleSourceStoragePath(): string {
  const configured = process.env.IMAGE_UPSCALE_SOURCE_STORAGE_PATH?.trim();
  if (configured) return resolve(configured);
  const isProductionRoot = process.cwd().startsWith('/v3');
  return resolve(isProductionRoot ? '/v3/local/image-upscale-sources' : join(process.cwd(), 'local', 'image-upscale-sources'));
}

/** 解析安全短文件名并限制在存储根目录内，防止路径穿越。 */
function resolveStoredPath(storedName: string, preview: boolean): string {
  const pattern = preview ? SAFE_PREVIEW_NAME : SAFE_SOURCE_NAME;
  if (!pattern.test(storedName)) throw new Error('图片放大源图文件名不合法');
  const basePath = getImageUpscaleSourceStoragePath();
  const resolved = resolve(basePath, storedName);
  if (resolved !== basePath && !resolved.startsWith(`${basePath}${sep}`)) throw new Error('图片放大源图路径不合法');
  return resolved;
}

function normalizeImageMime(format: string | undefined, requestMimeType: string): string {
  const map: Record<string, string> = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    tiff: 'image/tiff',
  };
  return map[String(format ?? '').toLowerCase()] ?? (requestMimeType.startsWith('image/') ? requestMimeType : 'application/octet-stream');
}
