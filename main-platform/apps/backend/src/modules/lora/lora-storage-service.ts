/** 本文件负责 LoRA 模型文件、分片上传会话与示例图的本地原子存储和安全下载。 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';

const MAX_LORA_BYTES = Number(process.env.LORA_REPOSITORY_MAX_FILE_BYTES ?? String(1024 * 1024 * 1024));
const MAX_EXAMPLE_BYTES = Number(process.env.LORA_REPOSITORY_MAX_EXAMPLE_BYTES ?? String(12 * 1024 * 1024));
const UPLOAD_CHUNK_BYTES = 768 * 1024;
const UPLOAD_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EXAMPLE_PIXELS = 64_000_000;
const MAX_SAFETENSORS_HEADER_BYTES = 16 * 1024 * 1024;
const SAFE_LORA_NAME = /^lora_\d+_[a-f0-9]{24}\.safetensors$/;
const SAFE_EXAMPLE_NAME = /^loraex_\d+_[a-f0-9]{24}\.webp$/;
const SAFE_UPLOAD_ID = /^lrup_[a-f0-9]{32}$/;

type UploadKind = 'model' | 'example';
type UploadSession = {
  uploadId: string;
  userId: number;
  loraId: number;
  kind: UploadKind;
  originalName: string;
  totalBytes: number;
  receivedBytes: number;
  createdAt: string;
};

/** LoRA 分片上传会话视图。 */
export type LoraUploadSessionView = Pick<UploadSession, 'uploadId' | 'receivedBytes' | 'totalBytes'> & { chunkSizeBytes: number };

/** LoRA 模型文件完成落盘后的摘要。 */
export type SavedLoraModel = { storedName: string; sizeBytes: number; sha256: string; originalName: string };

/** LoRA 文件或图片存储错误。 */
export class LoraStorageError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'LoraStorageError';
  }
}

/** LoRA 仓库存储服务。 */
export class LoraStorageService {
  private readonly uploadLocks = new Map<string, Promise<void>>();
  private lastCleanupAt = 0;

  /** 流式保存受控直连客户端上传的 safetensors，避免完整文件进入 Node 内存。 */
  async saveModelFile(loraId: number, req: IncomingMessage, originalName: string): Promise<SavedLoraModel> {
    const safeOriginal = validateModelOriginalName(originalName);
    const base = getStoragePath();
    await mkdir(join(base, 'files'), { recursive: true });
    const storedName = createStoredModelName(loraId);
    const target = resolveStoredPath('files', storedName, SAFE_LORA_NAME);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const fileHandle = await open(temporary, 'wx');
    try {
      for await (const rawChunk of req) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_LORA_BYTES) throw new LoraStorageError(413, `LoRA 文件不能超过 ${formatMegabytes(MAX_LORA_BYTES)}MB`);
        hash.update(chunk);
        await writeBuffer(fileHandle, chunk, sizeBytes - chunk.length);
      }
      await fileHandle.sync();
    } catch (error) {
      await fileHandle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await fileHandle.close();
    if (sizeBytes <= 0) {
      await unlink(temporary).catch(() => undefined);
      throw new LoraStorageError(400, 'LoRA 文件为空');
    }
    await validateSafetensorsFile(temporary, sizeBytes).catch(async (error) => {
      await unlink(temporary).catch(() => undefined);
      throw error;
    });
    await rename(temporary, target);
    return { storedName, sizeBytes, sha256: hash.digest('hex'), originalName: safeOriginal };
  }

  /** 创建绑定作者和草稿的持久化分片上传会话。 */
  async createUploadSession(input: { userId: number; loraId: number; kind: UploadKind; originalName: string; totalBytes: number }): Promise<LoraUploadSessionView> {
    await this.cleanupExpiredUploadSessions();
    const totalBytes = Math.trunc(Number(input.totalBytes));
    const maximum = input.kind === 'model' ? MAX_LORA_BYTES : MAX_EXAMPLE_BYTES;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new LoraStorageError(400, '上传文件大小不正确');
    if (totalBytes > maximum) throw new LoraStorageError(413, input.kind === 'model' ? `LoRA 文件不能超过 ${formatMegabytes(maximum)}MB` : '单张示例图不能超过 12MB');
    const originalName = input.kind === 'model' ? validateModelOriginalName(input.originalName) : sanitizeOriginalName(input.originalName || 'example-image');
    const uploadId = `lrup_${randomBytes(16).toString('hex')}`;
    const session: UploadSession = {
      uploadId,
      userId: input.userId,
      loraId: input.loraId,
      kind: input.kind,
      originalName,
      totalBytes,
      receivedBytes: 0,
      createdAt: new Date().toISOString(),
    };
    await mkdir(resolve(getStoragePath(), 'uploads'), { recursive: true });
    const partPath = resolveUploadPath(uploadId, '.part');
    const manifestPath = resolveUploadPath(uploadId, '.json');
    await writeFile(partPath, Buffer.alloc(0), { flag: 'wx' });
    try {
      await writeFile(manifestPath, JSON.stringify(session), { flag: 'wx' });
    } catch (error) {
      await unlink(partPath).catch(() => undefined);
      throw error;
    }
    return toUploadSessionView(session);
  }

  /** 顺序写入一个小分片，并将已接收偏移持久化到会话清单。 */
  async appendUploadChunk(input: { userId: number; loraId: number; uploadId: string; offset: number; req: IncomingMessage }): Promise<LoraUploadSessionView> {
    return this.withUploadLock(input.uploadId, async () => {
      const session = await this.requireUploadSession(input.uploadId, input.userId, input.loraId);
      const offset = Math.trunc(Number(input.offset));
      if (!Number.isSafeInteger(offset) || offset !== session.receivedBytes) {
        throw new LoraStorageError(409, `上传偏移不一致，服务端已接收 ${session.receivedBytes} 字节`);
      }
      const partPath = resolveUploadPath(session.uploadId, '.part');
      const fileHandle = await open(partPath, 'r+');
      let chunkBytes = 0;
      try {
        for await (const rawChunk of input.req) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          chunkBytes += chunk.length;
          if (chunkBytes > UPLOAD_CHUNK_BYTES) throw new LoraStorageError(413, `单个上传分片不能超过 ${UPLOAD_CHUNK_BYTES} 字节`);
          if (session.receivedBytes + chunkBytes > session.totalBytes) throw new LoraStorageError(400, '上传内容超过声明的文件大小');
          await writeBuffer(fileHandle, chunk, session.receivedBytes + chunkBytes - chunk.length);
        }
        if (chunkBytes <= 0) throw new LoraStorageError(400, '上传分片为空');
        await fileHandle.sync();
      } catch (error) {
        await fileHandle.close().catch(() => undefined);
        await truncate(partPath, session.receivedBytes).catch(() => undefined);
        throw error;
      }
      await fileHandle.close();
      session.receivedBytes += chunkBytes;
      await writeUploadSession(session);
      return toUploadSessionView(session);
    });
  }

  /** 读取当前作者上传会话的服务端真实偏移，供网络中断后续传。 */
  async getUploadSession(userId: number, loraId: number, uploadId: string): Promise<LoraUploadSessionView> {
    return toUploadSessionView(await this.requireUploadSession(uploadId, userId, loraId));
  }

  /** 完成模型分片会话，验证 safetensors 结构、计算哈希并原子移动到正式目录。 */
  async completeModelUpload(userId: number, loraId: number, uploadId: string): Promise<SavedLoraModel> {
    return this.withUploadLock(uploadId, async () => {
      const session = await this.requireCompleteSession(uploadId, userId, loraId, 'model');
      const partPath = resolveUploadPath(uploadId, '.part');
      await validateSafetensorsFile(partPath, session.totalBytes);
      const sha256 = await hashFile(partPath);
      await mkdir(resolve(getStoragePath(), 'files'), { recursive: true });
      const storedName = createStoredModelName(loraId);
      await rename(partPath, resolveStoredPath('files', storedName, SAFE_LORA_NAME));
      await unlink(resolveUploadPath(uploadId, '.json')).catch(() => undefined);
      return { storedName, sizeBytes: session.totalBytes, sha256, originalName: session.originalName };
    });
  }

  /** 完成示例图分片会话并返回受大小约束的原始图片内容。 */
  async consumeExampleUpload(userId: number, loraId: number, uploadId: string): Promise<Buffer> {
    return this.withUploadLock(uploadId, async () => {
      const session = await this.requireCompleteSession(uploadId, userId, loraId, 'example');
      const partPath = resolveUploadPath(uploadId, '.part');
      const input = await readFile(partPath);
      await this.deleteUploadSessionFiles(uploadId);
      return input;
    });
  }

  /** 取消当前作者草稿的一次未完成上传。 */
  async cancelUploadSession(userId: number, loraId: number, uploadId: string): Promise<void> {
    await this.withUploadLock(uploadId, async () => {
      await this.requireUploadSession(uploadId, userId, loraId);
      await this.deleteUploadSessionFiles(uploadId);
    });
  }

  /** 删除条目时一并清理它的全部未完成上传会话。 */
  async deleteUploadSessionsForLora(userId: number, loraId: number): Promise<void> {
    const directory = resolve(getStoragePath(), 'uploads');
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const uploadId = name.slice(0, -5);
      if (!SAFE_UPLOAD_ID.test(uploadId)) continue;
      const session = await readUploadSession(uploadId).catch(() => null);
      if (session?.userId === userId && session.loraId === loraId) await this.deleteUploadSessionFiles(uploadId);
    }
  }

  /** 示例图统一旋转、缩放并转成高质量 WebP。 */
  async saveExampleImage(loraId: number, input: Buffer): Promise<{ storedName: string; width: number; height: number; sizeBytes: number }> {
    if (input.length <= 0) throw new LoraStorageError(400, '示例图为空');
    if (input.length > MAX_EXAMPLE_BYTES) throw new LoraStorageError(413, '单张示例图不能超过 12MB');
    let output: Buffer;
    let width = 0;
    let height = 0;
    try {
      const pipeline = sharp(input, { failOn: 'error', limitInputPixels: MAX_EXAMPLE_PIXELS }).rotate().resize(1800, 1800, { fit: 'inside', withoutEnlargement: true });
      const result = await pipeline.webp({ quality: 88, effort: 4 }).toBuffer({ resolveWithObject: true });
      output = result.data;
      width = result.info.width;
      height = result.info.height;
    } catch {
      throw new LoraStorageError(400, '示例图片格式不正确');
    }
    await mkdir(resolve(getStoragePath(), 'examples'), { recursive: true });
    const storedName = `loraex_${loraId}_${randomBytes(12).toString('hex')}.webp`;
    const target = resolveStoredPath('examples', storedName, SAFE_EXAMPLE_NAME);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, output);
    await rename(temporary, target);
    return { storedName, width, height, sizeBytes: output.length };
  }

  /** 按 HTTP Range 流式输出已发布 LoRA，支持大文件续传。 */
  async serveModel(storedName: string, originalName: string, req: IncomingMessage, res: ServerResponse): Promise<'missing' | 'served' | 'range_not_satisfiable'> {
    return serveFile('files', storedName, SAFE_LORA_NAME, 'application/octet-stream', req, res, `attachment; filename*=UTF-8''${encodeURIComponent(originalName)}`);
  }

  /** 输出公开示例图。 */
  async serveExample(storedName: string, res: ServerResponse): Promise<boolean> {
    return (await serveFile('examples', storedName, SAFE_EXAMPLE_NAME, 'image/webp', undefined, res)) !== 'missing';
  }

  /** 删除数据库已引用的安全短文件名；缺失文件按幂等成功处理。 */
  async deleteFiles(modelName: string | null, exampleNames: string[]): Promise<void> {
    if (modelName && SAFE_LORA_NAME.test(modelName)) await unlink(resolveStoredPath('files', modelName, SAFE_LORA_NAME)).catch(() => undefined);
    for (const name of exampleNames) if (SAFE_EXAMPLE_NAME.test(name)) await unlink(resolveStoredPath('examples', name, SAFE_EXAMPLE_NAME)).catch(() => undefined);
  }

  private async requireCompleteSession(uploadId: string, userId: number, loraId: number, kind: UploadKind): Promise<UploadSession> {
    const session = await this.requireUploadSession(uploadId, userId, loraId);
    if (session.kind !== kind) throw new LoraStorageError(400, '上传会话类型不匹配');
    if (session.receivedBytes !== session.totalBytes) throw new LoraStorageError(400, `文件尚未上传完整，已接收 ${session.receivedBytes}/${session.totalBytes} 字节`);
    const fileInfo = await stat(resolveUploadPath(uploadId, '.part')).catch(() => null);
    if (!fileInfo?.isFile() || fileInfo.size !== session.totalBytes) throw new LoraStorageError(409, '上传临时文件与会话记录不一致');
    return session;
  }

  private async requireUploadSession(uploadId: string, userId: number, loraId: number): Promise<UploadSession> {
    const session = await readUploadSession(uploadId).catch(() => null);
    if (!session || session.userId !== userId || session.loraId !== loraId) throw new LoraStorageError(404, '上传会话不存在');
    return session;
  }

  private async deleteUploadSessionFiles(uploadId: string): Promise<void> {
    if (!SAFE_UPLOAD_ID.test(uploadId)) return;
    await Promise.all([
      unlink(resolveUploadPath(uploadId, '.part')).catch(() => undefined),
      unlink(resolveUploadPath(uploadId, '.json')).catch(() => undefined),
    ]);
  }

  private async cleanupExpiredUploadSessions(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanupAt < 60 * 60 * 1000) return;
    this.lastCleanupAt = now;
    const directory = resolve(getStoragePath(), 'uploads');
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const uploadId = name.slice(0, -5);
      if (!SAFE_UPLOAD_ID.test(uploadId)) continue;
      const info = await stat(resolveUploadPath(uploadId, '.json')).catch(() => null);
      if (info && now - info.mtimeMs > UPLOAD_SESSION_MAX_AGE_MS) await this.deleteUploadSessionFiles(uploadId);
    }
  }

  private async withUploadLock<T>(uploadId: string, task: () => Promise<T>): Promise<T> {
    if (!SAFE_UPLOAD_ID.test(uploadId)) throw new LoraStorageError(404, '上传会话不存在');
    const previous = this.uploadLocks.get(uploadId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const queued = previous.then(() => gate);
    this.uploadLocks.set(uploadId, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.uploadLocks.get(uploadId) === queued) this.uploadLocks.delete(uploadId);
    }
  }
}

function getStoragePath(): string {
  const configured = process.env.LORA_REPOSITORY_STORAGE_PATH?.trim();
  if (configured) return resolve(configured);
  return resolve(process.cwd().startsWith('/v3') ? '/v3/local/lora-repository' : join(process.cwd(), 'local', 'lora-repository'));
}

function resolveStoredPath(folder: string, name: string, pattern: RegExp): string {
  if (!pattern.test(name)) throw new LoraStorageError(400, 'LoRA 存储文件名不正确');
  const base = resolve(getStoragePath(), folder);
  const target = resolve(base, name);
  if (!target.startsWith(`${base}${sep}`)) throw new LoraStorageError(400, 'LoRA 存储路径不正确');
  return target;
}

function resolveUploadPath(uploadId: string, suffix: '.part' | '.json'): string {
  if (!SAFE_UPLOAD_ID.test(uploadId)) throw new LoraStorageError(404, '上传会话不存在');
  const base = resolve(getStoragePath(), 'uploads');
  const target = resolve(base, `${uploadId}${suffix}`);
  if (!target.startsWith(`${base}${sep}`)) throw new LoraStorageError(400, '上传会话路径不正确');
  return target;
}

async function readUploadSession(uploadId: string): Promise<UploadSession> {
  const parsed = JSON.parse(await readFile(resolveUploadPath(uploadId, '.json'), 'utf8')) as Partial<UploadSession>;
  if (parsed.uploadId !== uploadId || !Number.isInteger(parsed.userId) || !Number.isInteger(parsed.loraId) || (parsed.kind !== 'model' && parsed.kind !== 'example') || !Number.isSafeInteger(parsed.totalBytes) || !Number.isSafeInteger(parsed.receivedBytes)) {
    throw new LoraStorageError(409, '上传会话记录不正确');
  }
  return parsed as UploadSession;
}

async function writeUploadSession(session: UploadSession): Promise<void> {
  const target = resolveUploadPath(session.uploadId, '.json');
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(session));
  await rename(temporary, target);
}

async function writeBuffer(fileHandle: Awaited<ReturnType<typeof open>>, buffer: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const result = await fileHandle.write(buffer, written, buffer.length - written, position + written);
    if (result.bytesWritten <= 0) throw new LoraStorageError(500, '写入 LoRA 文件失败');
    written += result.bytesWritten;
  }
}

async function validateSafetensorsFile(path: string, totalBytes: number): Promise<void> {
  if (totalBytes < 10) throw new LoraStorageError(400, 'safetensors 文件结构不正确');
  const fileHandle = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(8);
    const prefixRead = await fileHandle.read(prefix, 0, 8, 0);
    if (prefixRead.bytesRead !== 8) throw new LoraStorageError(400, 'safetensors 文件头不完整');
    const headerBytesBig = prefix.readBigUInt64LE(0);
    if (headerBytesBig <= 1n || headerBytesBig > BigInt(MAX_SAFETENSORS_HEADER_BYTES) || headerBytesBig > BigInt(totalBytes - 8)) throw new LoraStorageError(400, 'safetensors 文件头长度不正确');
    const headerBytes = Number(headerBytesBig);
    const header = Buffer.alloc(headerBytes);
    const headerRead = await fileHandle.read(header, 0, headerBytes, 8);
    if (headerRead.bytesRead !== headerBytes) throw new LoraStorageError(400, 'safetensors 文件头不完整');
    const metadata = JSON.parse(header.toString('utf8').trim()) as Record<string, unknown>;
    const tensors = Object.entries(metadata).filter(([name]) => name !== '__metadata__');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || tensors.length === 0) throw new LoraStorageError(400, 'safetensors 中没有张量数据');
    for (const [, value] of tensors) {
      const tensor = value as { dtype?: unknown; shape?: unknown; data_offsets?: unknown };
      if (!tensor || typeof tensor !== 'object' || typeof tensor.dtype !== 'string' || !Array.isArray(tensor.shape) || !Array.isArray(tensor.data_offsets) || tensor.data_offsets.length !== 2) throw new LoraStorageError(400, 'safetensors 张量目录不正确');
    }
  } catch (error) {
    if (error instanceof LoraStorageError) throw error;
    throw new LoraStorageError(400, 'safetensors 文件头不是有效 JSON');
  } finally {
    await fileHandle.close();
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function serveFile(folder: string, name: string, pattern: RegExp, contentType: string, req: IncomingMessage | undefined, res: ServerResponse, disposition?: string): Promise<'missing' | 'served' | 'range_not_satisfiable'> {
  const target = resolveStoredPath(folder, name, pattern);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return 'missing';
  const range = parseRange(req?.headers.range, info.size);
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Accept-Ranges': 'bytes' });
    res.end();
    return 'range_not_satisfiable';
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const partial = Boolean(range);
  res.writeHead(partial ? 206 : 200, {
    'Content-Type': contentType,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': disposition ? 'private, no-store' : 'public, max-age=31536000, immutable',
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
    ...(disposition ? { 'Content-Disposition': disposition } : {}),
  });
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(target, { start, end });
    stream.on('error', reject);
    stream.on('end', resolvePromise);
    res.on('close', resolvePromise);
    stream.pipe(res);
  });
  return 'served';
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

function toUploadSessionView(session: UploadSession): LoraUploadSessionView {
  return { uploadId: session.uploadId, receivedBytes: session.receivedBytes, totalBytes: session.totalBytes, chunkSizeBytes: UPLOAD_CHUNK_BYTES };
}

function createStoredModelName(loraId: number): string {
  return `lora_${loraId}_${randomBytes(12).toString('hex')}.safetensors`;
}

function validateModelOriginalName(value: string): string {
  const safeOriginal = sanitizeOriginalName(value);
  if (!safeOriginal.toLowerCase().endsWith('.safetensors')) throw new LoraStorageError(400, 'LoRA 文件仅支持 .safetensors');
  return safeOriginal;
}

function sanitizeOriginalName(value: string): string {
  return String(value || 'model.safetensors').replace(/[\r\n\t]/g, ' ').replace(/[\\/]/g, '_').trim().slice(0, 240) || 'model.safetensors';
}

function formatMegabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
