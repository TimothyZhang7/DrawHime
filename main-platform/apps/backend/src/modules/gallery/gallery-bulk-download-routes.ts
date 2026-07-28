/**
 * 本文件注册用户图库批量下载路由：创建临时 zip、鉴权下载并清理过期文件。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { constants as zlibConstants, deflateRaw } from 'node:zlib';
import { ApiErrorCode, type GalleryBulkDownloadRequest, type GalleryBulkDownloadResponse } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

const prisma = getPrismaClient();
const MEDIA_URL = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
const TEMP_ROOT = process.env.GALLERY_BULK_DOWNLOAD_DIR || join(process.cwd(), 'local', 'gallery-bulk-downloads');
const ZIP_TTL_MS = Number(process.env.GALLERY_BULK_DOWNLOAD_TTL_MS ?? String(3 * 60 * 60 * 1000));
const MAX_BULK_DOWNLOAD_IMAGES = Number(process.env.GALLERY_BULK_DOWNLOAD_MAX_IMAGES ?? '50');
const ZIP_FETCH_TIMEOUT_MS = Number(process.env.GALLERY_BULK_DOWNLOAD_IMAGE_TIMEOUT_MS ?? '45000');
const deflateRawAsync = promisify(deflateRaw);

type TaskImageConfig = {
  imageFilename?: string;
  thumbnailFilename?: string;
};

type ArchiveMeta = {
  archiveId: string;
  userId: number;
  filename: string;
  expiresAt: string;
  includedCount: number;
};

type ZipEntry = {
  name: string;
  data: Buffer;
};

type ZipWriteEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  crc: number;
  offset: number;
};

let cleanupStarted = false;

/** 创建图库批量下载路由，下载接口也必须校验当前用户 JWT。 */
export function createGalleryBulkDownloadRoutes(): Route[] {
  startBulkDownloadCleanup();
  return [
    { method: 'POST', path: '/api/gallery/bulk-downloads', handle: createBulkDownload },
    { method: 'GET', path: '/api/gallery/bulk-downloads/:archiveId', handle: downloadBulkArchive },
  ];
}

/** 创建当前用户选中图片的临时 zip，返回短时下载地址。 */
async function createBulkDownload(req: IncomingMessage, res: ServerResponse) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });

  const body = await readJsonBody<GalleryBulkDownloadRequest>(req);
  const ids = uniqueTaskIds(body.ids ?? []).slice(0, MAX_BULK_DOWNLOAD_IMAGES);
  if (ids.length < 2) {
    // 单张图片由前端直接下载原图；backend 只负责多图 zip 打包，避免产生无意义临时文件。
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: ids.length === 0 ? '请选择要下载的图片' : '至少选择 2 张图片才需要打包下载' });
  }

  const tasks = await prisma.generationTask.findMany({
    where: { id: { in: ids }, userId, status: 'success' },
    select: { id: true, createdAt: true },
  });
  const orderedTasks = ids
    .map((id) => tasks.find((task) => task.id === id))
    .filter((task): task is NonNullable<typeof task> => Boolean(task));
  const imageConfigs = await readTaskImageConfigs(orderedTasks.map((task) => task.id));
  const archiveId = createArchiveId(userId);
  const zipPath = archivePath(archiveId);
  await ensureTempRoot();
  const writer = await createZipWriter(zipPath);
  let includedCount = 0;

  try {
    for (const task of orderedTasks) {
      const config = imageConfigs.get(task.id);
      if (!config?.imageFilename || !isSafeImageFilename(config.imageFilename)) continue;
      const image = await fetchOriginalImage(config.imageFilename);
      if (!image) continue;
      // zip 使用 Deflate 无损压缩：不重编码图片，只压缩原始字节并保留可还原内容。
      await writer.add({
        name: buildZipEntryName(task.id, config.imageFilename),
        data: image,
      });
      includedCount += 1;
    }
    await writer.finish();
  } catch (error) {
    await writer.abort();
    await removeArchiveFiles(archiveId);
    throw error;
  }

  if (includedCount === 0) {
    await removeArchiveFiles(archiveId);
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '选中的图片文件暂不可下载' });
  }

  const expiresAt = new Date(Date.now() + ZIP_TTL_MS).toISOString();
  const filename = `gallery-${formatDateForFilename(new Date())}-${includedCount}.zip`;
  const meta: ArchiveMeta = { archiveId, userId, filename, expiresAt, includedCount };
  await writeFile(metaPath(archiveId), JSON.stringify(meta), 'utf8');

  const data: GalleryBulkDownloadResponse = {
    archiveId,
    downloadUrl: `/api/gallery/bulk-downloads/${encodeURIComponent(archiveId)}`,
    filename,
    expiresAt,
    requestedCount: ids.length,
    includedCount,
    skippedCount: ids.length - includedCount,
  };
  return sendJson(res, 200, { ok: true, data });
}

/** 下载临时 zip；用户必须和创建归档的用户一致，避免临时 ID 泄露后跨账号读取。 */
async function downloadBulkArchive(req: IncomingMessage, res: ServerResponse, params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });

  const archiveId = params?.archiveId ?? '';
  if (!isSafeArchiveId(archiveId)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '下载任务不正确' });
  }

  const meta = await readArchiveMeta(archiveId);
  if (!meta || meta.userId !== userId) {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '下载文件不存在或已过期' });
  }
  if (new Date(meta.expiresAt).getTime() <= Date.now()) {
    await removeArchiveFiles(archiveId);
    return sendJson(res, 410, { ok: false, code: ApiErrorCode.NotFound, message: '下载文件已过期，请重新打包' });
  }

  try {
    const info = await stat(archivePath(archiveId));
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${meta.filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      'Cache-Control': 'private, max-age=0, no-store',
    });
    createReadStream(archivePath(archiveId)).pipe(res);
  } catch {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '下载文件不存在或已过期' });
  }
}

/** 启动 backend 本地临时 zip 清理任务；zip 过期后删除文件和元数据。 */
export function startBulkDownloadCleanup(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const cleanup = async () => {
    try {
      await ensureTempRoot();
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(TEMP_ROOT);
      const metas = files.filter((file) => file.endsWith('.json'));
      for (const file of metas) {
        const archiveId = file.slice(0, -5);
        const meta = await readArchiveMeta(archiveId);
        if (!meta || new Date(meta.expiresAt).getTime() <= Date.now()) {
          await removeArchiveFiles(archiveId);
        }
      }
    } catch {
      // 临时目录清理失败不能影响 backend 主流程；下一轮会继续尝试。
    }
  };
  const timer = setInterval(cleanup, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(cleanup, 30_000).unref?.();
}

/** 读取任务图片配置，图片真实文件名只来源于 worker 写入的 task_image_* 配置。 */
async function readTaskImageConfigs(taskIds: string[]): Promise<Map<string, TaskImageConfig>> {
  if (taskIds.length === 0) return new Map();
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: taskIds.map((id) => `task_image_${id}`) } },
    select: { key: true, value: true },
  });
  const map = new Map<string, TaskImageConfig>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as TaskImageConfig;
      map.set(row.key.replace('task_image_', ''), parsed);
    } catch {
      // 单条历史配置损坏时跳过，不影响其他图片打包。
    }
  }
  return map;
}

/** 从 media-service 读取原图；批量下载只读取本地媒体文件。 */
async function fetchOriginalImage(filename: string): Promise<Buffer | undefined> {
  try {
    const response = await fetch(`${MEDIA_URL}/media/files/${encodeURIComponent(filename)}`, {
      signal: AbortSignal.timeout(ZIP_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return undefined;
  }
}

/** 创建 zip 写入器；中央目录只记录元数据，图片内容边下载边写入。 */
async function createZipWriter(path: string) {
  const output = createWriteStream(path);
  const entries: ZipWriteEntry[] = [];
  let offset = 0;
  return {
    /** 追加单张图片到 zip；只做 Deflate 无损压缩，不改变图片编码和像素内容。 */
    async add(entry: ZipEntry) {
      const nameBuffer = Buffer.from(entry.name, 'utf8');
      const crc = crc32(entry.data);
      const compressed = await deflateRawAsync(entry.data, { level: zlibConstants.Z_BEST_SPEED });
      const localHeader = createLocalFileHeader(nameBuffer, compressed.length, entry.data.length, crc);
      await writeChunk(output, localHeader);
      await writeChunk(output, compressed);
      entries.push({ name: entry.name, compressedSize: compressed.length, uncompressedSize: entry.data.length, crc, offset });
      offset += localHeader.length + compressed.length;
    },
    /** 完成 zip 中央目录并关闭文件。 */
    async finish() {
      const centralParts = entries.map((entry) => createCentralDirectoryHeader(
        Buffer.from(entry.name, 'utf8'),
        entry.compressedSize,
        entry.uncompressedSize,
        entry.crc,
        entry.offset,
      ));
      const centralDirectory = Buffer.concat(centralParts);
      await writeChunk(output, centralDirectory);
      await writeChunk(output, createEndOfCentralDirectory(entries.length, centralDirectory.length, offset));
      output.end();
      await once(output, 'close');
    },
    /** 异常时销毁文件流，避免半成品继续占用文件句柄。 */
    async abort() {
      const closed = once(output, 'close');
      output.destroy();
      await closed.catch(() => undefined);
    },
  };
}

/** 构造 zip 本地文件头。 */
function createLocalFileHeader(name: Buffer, compressedSize: number, uncompressedSize: number, crc: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc >>> 0, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

/** 构造 zip 中央目录头。 */
function createCentralDirectoryHeader(name: Buffer, compressedSize: number, uncompressedSize: number, crc: number, offset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(crc >>> 0, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

/** 构造 zip 结束目录记录。 */
function createEndOfCentralDirectory(count: number, centralSize: number, centralOffset: number): Buffer {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(count, 8);
  footer.writeUInt16LE(count, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

/** 向文件流写入一段数据并处理背压，避免大 zip 写入时占满内存。 */
async function writeChunk(output: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (output.write(chunk)) return;
  await once(output, 'drain');
}

/** 计算 zip 需要的 CRC32。 */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** 校验用户 JWT，返回用户 ID。 */
function authenticateUser(req: IncomingMessage): number | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    return verifyAccessToken(token).sub;
  } catch {
    return undefined;
  }
}

/** 去重并过滤任务 ID，防止异常参数放大数据库查询和文件打包。 */
function uniqueTaskIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const value = String(id ?? '').trim();
    if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** 生成 zip 内文件名，保留任务 ID 方便用户回查来源。 */
function buildZipEntryName(taskId: string, filename: string): string {
  const ext = filenameExtension(filename);
  return `${sanitizeZipName(taskId)}${ext}`;
}

function filenameExtension(filename: string): string {
  const match = filename.match(/\.(png|jpe?g|webp)$/i);
  return match ? `.${match[1]!.toLowerCase().replace('jpeg', 'jpg')}` : '.png';
}

function sanitizeZipName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'image';
}

function isSafeImageFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}

function isSafeArchiveId(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

function createArchiveId(userId: number): string {
  return createHash('sha1').update(`${userId}:${Date.now()}:${randomBytes(16).toString('hex')}`).digest('hex');
}

async function ensureTempRoot(): Promise<void> {
  await mkdir(TEMP_ROOT, { recursive: true });
}

function archivePath(archiveId: string): string {
  return join(TEMP_ROOT, `${archiveId}.zip`);
}

function metaPath(archiveId: string): string {
  return join(TEMP_ROOT, `${archiveId}.json`);
}

async function readArchiveMeta(archiveId: string): Promise<ArchiveMeta | undefined> {
  try {
    return JSON.parse(await readFile(metaPath(archiveId), 'utf8')) as ArchiveMeta;
  } catch {
    return undefined;
  }
}

async function removeArchiveFiles(archiveId: string): Promise<void> {
  await Promise.all([
    rm(archivePath(archiveId), { force: true }),
    rm(metaPath(archiveId), { force: true }),
  ]);
}

function formatDateForFilename(date: Date): string {
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return china.toISOString().slice(0, 19).replace(/[-:T]/g, '');
}
