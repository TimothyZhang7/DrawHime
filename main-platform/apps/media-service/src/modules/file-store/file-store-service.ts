/**
 * 本文件实现媒体文件存储服务：图片写入、读取、文件名规范化、路径穿越防护。
 *
 * 约束：
 * - 所有文件名必须规范化，防止目录穿越
 * - 文件写入使用原子操作（先写临时文件再重命名）
 * - 不判断图片的业务可见性，由调用方（backend）负责权限校验
 * - 符合 specs/README.md MEDIA-001 到 MEDIA-004
 */
import { mkdir, readdir, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 允许的图片 MIME 类型，不符合的拒绝存储。 */
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** 允许原样持久化的媒体 MIME；视频只开放已验证的 MP4。 */
const ALLOWED_MEDIA_MIME_TYPES = new Set([...ALLOWED_MIME_TYPES, 'video/mp4']);

/** 最大文件大小默认 20MB，后台配置不可用时兜底使用。 */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * 媒体文件存储服务，负责本地文件系统的读写操作。
 * 文件基础路径从环境变量 MEDIA_STORAGE_PATH 读取，默认 ./media-storage。
 */
export class FileStoreService {
  /** 文件存储根目录，所有读写操作必须在该目录内。 */
  private readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = resolve(basePath ?? process.env.MEDIA_STORAGE_PATH ?? join(process.cwd(), 'media-storage'));
  }

  /**
   * 确保基础目录存在，服务启动时调用。
   */
  async ensureBasePath(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
  }

  /** 返回本地媒体根目录；仅供受保护的维护任务枚举本地暂存文件。 */
  getBasePath(): string {
    return this.basePath;
  }

  /** 列出当前本地实际存在的安全媒体短文件名；维护任务用它避免反复处理已删除文件。 */
  async listLocalFilenames(limit = 1000, offset = 0, prefixes: string[] = []): Promise<{ filenames: string[]; totalScanned: number }> {
    await this.ensureBasePath();
    const entries = await readdir(this.basePath, { withFileTypes: true });
    const normalizedPrefixes = prefixes
      .map((prefix) => prefix.trim())
      .filter((prefix) => /^[a-zA-Z0-9_]{1,16}$/.test(prefix));
    const filenames: string[] = [];
    let matched = 0;
    let totalScanned = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
      totalScanned += 1;
      try {
        this.validateFilename(entry.name);
      } catch {
        continue;
      }
      if (normalizedPrefixes.length > 0 && !normalizedPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
      if (matched++ < Math.max(0, offset)) continue;
      filenames.push(entry.name);
      if (limit > 0 && filenames.length >= limit) break;
    }
    return { filenames, totalScanned };
  }

  /** 统计本地媒体目录占用；只读目录元数据，不读取图片内容也不删除文件。 */
  async getLocalStorageStats(): Promise<{
    basePath: string;
    totalFiles: number;
    totalBytes: number;
    tempFiles: number;
    largestFileBytes: number;
    prefixes: Array<{ prefix: string; count: number; bytes: number }>;
    sizeBuckets: Array<{ label: string; count: number; bytes: number }>;
    filesystem: { path: string; totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number } | null;
  }> {
    await this.ensureBasePath();
    const prefixMap = new Map<string, { prefix: string; count: number; bytes: number }>();
    const buckets = createSizeBuckets();
    let totalFiles = 0;
    let totalBytes = 0;
    let tempFiles = 0;
    let largestFileBytes = 0;
    const entries = await readdir(this.basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.tmp')) tempFiles += 1;
      try {
        this.validateFilename(entry.name);
        const fileStats = await stat(this.resolvePath(entry.name));
        if (!fileStats.isFile()) continue;
        const size = fileStats.size;
        totalFiles += 1;
        totalBytes += size;
        largestFileBytes = Math.max(largestFileBytes, size);
        const prefix = inferStoragePrefix(entry.name);
        const current = prefixMap.get(prefix) ?? { prefix, count: 0, bytes: 0 };
        current.count += 1;
        current.bytes += size;
        prefixMap.set(prefix, current);
        const bucket = buckets.find((item) => size <= item.maxBytes) ?? buckets[buckets.length - 1]!;
        bucket.count += 1;
        bucket.bytes += size;
      } catch {
        // 单个异常文件不能影响整体存储面板读取。
      }
    }
    return {
      basePath: this.basePath,
      totalFiles,
      totalBytes,
      tempFiles,
      largestFileBytes,
      prefixes: [...prefixMap.values()].sort((a, b) => b.bytes - a.bytes),
      sizeBuckets: buckets.map(({ label, count, bytes }) => ({ label, count, bytes })),
      filesystem: await readFilesystemStat(this.basePath),
    };
  }

  /**
   * 写入图片文件（原子操作：先写 .tmp 再重命名）。
   * @param buffer 图片二进制数据
   * @param mimeType 图片 MIME 类型
   * @returns 规范化后的文件名
   */
  async writeImage(buffer: Buffer, mimeType: string = 'image/png', prefix: string = 'img_', options: { maxFileSizeBytes?: number } = {}): Promise<string> {
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(`不支持的图片格式：${mimeType}，仅支持 PNG/JPEG/WebP`);
    }
    // 后台 image_max_file_size_mb 生效时由调用方传入上限；缺失时保留 20MB 安全兜底。
    const maxFileSize = normalizeMaxFileSize(options.maxFileSizeBytes);
    if (buffer.length > maxFileSize) {
      throw new Error(`文件大小超过限制：${(buffer.length / 1024 / 1024).toFixed(1)}MB，最大 ${(maxFileSize / 1024 / 1024).toFixed(0)}MB`);
    }

    return this.writeMedia(buffer, mimeType, prefix, options);
  }

  /** 原样写入已由路由校验的图片或视频二进制，使用临时文件保证原子落盘。 */
  async writeMedia(buffer: Buffer, mimeType: string, prefix: string = 'media_', options: { maxFileSizeBytes?: number } = {}): Promise<string> {
    if (!ALLOWED_MEDIA_MIME_TYPES.has(mimeType)) {
      throw new Error(`不支持的媒体格式：${mimeType}`);
    }
    const maxFileSize = normalizeMaxFileSize(options.maxFileSizeBytes);
    if (buffer.length > maxFileSize) {
      throw new Error(`文件大小超过限制：${(buffer.length / 1024 / 1024).toFixed(1)}MB，最大 ${(maxFileSize / 1024 / 1024).toFixed(0)}MB`);
    }
    const filename = this.generateFilename(prefix, mimeType);
    const filePath = this.resolvePath(filename);
    const tmpPath = `${filePath}.tmp`;

    // 先写临时文件，完成后再重命名（原子写入）
    await writeFile(tmpPath, buffer);
    await rename(tmpPath, filePath);

    return filename;
  }

  /**
   * 读取图片文件返回文件流。
   * @param filename 规范化文件名
   * @returns 文件读取流和文件大小
   */
  async readImage(filename: string, range?: { start: number; end: number }): Promise<{ stream: ReturnType<typeof createReadStream>; size: number; contentType?: string }> {
    const filePath = this.resolvePath(filename);
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`文件不存在：${filename}`);
    }
    // 视频播放只读取浏览器请求的字节范围；图片和缩略图继续使用完整文件流。
    const stream = range
      ? createReadStream(filePath, { start: range.start, end: range.end })
      : createReadStream(filePath);
    return { stream, size: stats.size, contentType: detectContentType(filename) };
  }

  /** 读取安全短文件名对应的本地媒体元数据，不打开文件流。 */
  async readFileMetadata(filename: string): Promise<{ size: number; contentType?: string }> {
    const filePath = this.resolvePath(filename);
    const stats = await stat(filePath);
    if (!stats.isFile()) throw new Error(`文件不存在：${filename}`);
    return { size: stats.size, contentType: detectContentType(filename) };
  }

  /**
   * 检查文件是否存在。
   */
  async fileExists(filename: string): Promise<boolean> {
    try {
      const filePath = this.resolvePath(filename);
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删除指定文件（用于清理参考图）。
   */
  async deleteFile(filename: string): Promise<void> {
    const filePath = this.resolvePath(filename);
    try {
      await unlink(filePath);
    } catch {
      // 文件不存在不抛出错误
    }
  }

  /** 删除指定本地文件并返回是否真实删除；维护任务用它统计实际释放数量。 */
  async deleteFileIfExists(filename: string): Promise<boolean> {
    const filePath = this.resolvePath(filename);
    try {
      await unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 清理超过指定年龄的本地暂存图片。
   * 当前本地媒体是唯一副本，调用方必须先确认文件不属于任务、图库或业务引用。
   * @param maxAgeMs 最大保留毫秒数，超过后删除
   */
  async cleanupExpiredFiles(
    maxAgeMs: number,
    canDelete?: (filename: string) => Promise<boolean>,
    protectedFilenames: Set<string> = new Set(),
    limit = 200,
    scanLimit = Number(process.env.MEDIA_CLEANUP_SCAN_LIMIT ?? '500'),
    ignoredPrefixes: string[] = [],
  ): Promise<{ deleted: number; skippedUnarchived?: number }> {
    await this.ensureBasePath();
    const now = Date.now();
    let deleted = 0;
    let skippedUnarchived = 0;
    const entries = await readdir(this.basePath, { withFileTypes: true });
    let scanned = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
      // 业务专用文件可交给专门维护链路处理，避免通用清理误删仍被引用的文件。
      if (ignoredPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
      if (scanLimit > 0 && scanned >= scanLimit) break;
      scanned++;
      try {
        this.validateFilename(entry.name);
        // 仍被未完成任务或近期完成任务引用的本地文件不能清理，Bot 卡片和外部绘图 API 都依赖本地暂存。
        if (protectedFilenames.has(entry.name)) continue;
        const filePath = this.resolvePath(entry.name);
        const stats = await stat(filePath);
        if (now - stats.mtimeMs <= maxAgeMs) continue;
        // 删除前由调用方做业务可删判断，避免把本地唯一媒体副本误删。
        if (canDelete && !(await canDelete(entry.name))) {
          skippedUnarchived++;
          continue;
        }
        await unlink(filePath);
        deleted++;
        // 清理动作必须限批，避免一次周期任务长时间占用磁盘 IO。
        if (limit > 0 && deleted >= limit) break;
      } catch {
        // 单个文件清理失败不影响其他暂存文件。
      }
    }
    return skippedUnarchived > 0 ? { deleted, skippedUnarchived } : { deleted };
  }

  /**
   * 列出超过指定年龄的本地暂存图片。
   * 仅供本地维护任务生成候选，不能直接把候选视为可删除文件。
   */
  async listExpiredFiles(maxAgeMs: number): Promise<string[]> {
    await this.ensureBasePath();
    const now = Date.now();
    const filenames: string[] = [];
    const entries = await readdir(this.basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
      try {
        this.validateFilename(entry.name);
        const filePath = this.resolvePath(entry.name);
        const stats = await stat(filePath);
        if (now - stats.mtimeMs > maxAgeMs) filenames.push(entry.name);
      } catch {
        // 单个文件状态读取失败不影响其他过期文件判断。
      }
    }
    return filenames;
  }

  /**
   * 获取文件完整路径（内部使用）。
   */
  getFilePath(filename: string): string {
    return this.resolvePath(filename);
  }

  /**
   * 生成规范化文件名：prefix + 时间戳 + 随机后缀 + MIME 对应扩展名。
   * 缩略图当前输出 JPEG，扩展名必须和真实内容一致，避免浏览器和 renderer 误判格式。
   */
  private generateFilename(prefix: string, mimeType: string): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(6).toString('hex');
    // 前缀只能包含字母数字和下划线
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16);
    return `${safePrefix}${timestamp}_${random}${extensionForMimeType(mimeType)}`;
  }

  /**
   * 校验文件名的安全性，防止路径穿越攻击。
   * 只允许字母数字、下划线、短横线和点。
   */
  private validateFilename(filename: string): void {
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(filename)) {
      throw new Error(`文件名不合法：${filename}`);
    }
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error('文件名包含非法路径字符');
    }
  }

  /**
   * 解析文件名到完整路径，校验路径穿越。
   */
  private resolvePath(filename: string): string {
    this.validateFilename(filename);
    const fullPath = resolve(join(this.basePath, filename));
    // 路径边界必须按目录分隔符校验，避免 /media-storage2 这类相邻目录通过 startsWith。
    if (fullPath !== this.basePath && !fullPath.startsWith(`${this.basePath}${sep}`)) {
      throw new Error('文件路径越界');
    }
    return fullPath;
  }
}

/** 规范化本地写入大小上限，避免异常配置绕过 media-service 保护。 */
function normalizeMaxFileSize(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN) || Number(value) <= 0) return MAX_FILE_SIZE;
  return Math.min(100 * 1024 * 1024, Math.max(1024 * 1024, Math.trunc(Number(value))));
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'video/mp4') return '.mp4';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  return '.png';
}

function detectContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || filename.startsWith('thumb_')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  return 'image/png';
}

/** 识别媒体短文件名前缀，用于后台存储面板聚合。 */
function inferStoragePrefix(filename: string): string {
  if (filename.startsWith('ref_')) return 'ref_';
  if (filename.startsWith('img_')) return 'img_';
  if (filename.startsWith('thumb_')) return 'thumb_';
  if (filename.startsWith('zip_')) return 'zip_';
  if (filename.startsWith('video_')) return 'video_';
  const matched = filename.match(/^[a-zA-Z0-9]+_/);
  return matched?.[0] ?? 'other';
}

/** 创建固定大小分布桶，便于后台快速判断大文件是否重新积压。 */
function createSizeBuckets() {
  return [
    { label: '<256KB', maxBytes: 256 * 1024, count: 0, bytes: 0 },
    { label: '256KB-1MB', maxBytes: 1024 * 1024, count: 0, bytes: 0 },
    { label: '1MB-3MB', maxBytes: 3 * 1024 * 1024, count: 0, bytes: 0 },
    { label: '3MB-10MB', maxBytes: 10 * 1024 * 1024, count: 0, bytes: 0 },
    { label: '>10MB', maxBytes: Number.POSITIVE_INFINITY, count: 0, bytes: 0 },
  ];
}

/** 读取本地媒体目录所在文件系统容量；失败返回 null，避免影响 media-service 健康。 */
async function readFilesystemStat(path: string): Promise<{ path: string; totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number } | null> {
  try {
    const stats = await statfs(path);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
    return { path, totalBytes, usedBytes, freeBytes, usedPercent };
  } catch {
    return null;
  }
}
