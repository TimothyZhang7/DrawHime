/**
 * 本文件实现导航工作台附件本地存储。
 *
 * 工作台图片先落 backend 私有本地目录，数据库只保存短文件名和元数据；
 * 浏览器与多模态模型调用都通过后端鉴权读取，避免把大图 base64 直接塞进数据库。
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import sharp from 'sharp';
import type { WorkbenchAttachmentView } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

const MAX_WORKBENCH_ATTACHMENT_BYTES = Number(process.env.WORKBENCH_ATTACHMENT_MAX_BYTES ?? String(12 * 1024 * 1024));
const MAX_WORKBENCH_ATTACHMENT_PIXELS = 48_000_000;
const MEDIA_URL = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
const REFERENCE_TASK_INPUT_MAX_BYTES = Number(process.env.REFERENCE_TASK_INPUT_MAX_BYTES ?? String(3 * 1024 * 1024));
const SAFE_ATTACHMENT_FILENAME = /^wbatt_u\d+_[a-f0-9]{24}\.(?:png|jpg|webp)$/;
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

type AttachmentRecord = {
  id: string;
  userId: number;
  conversationId: string | null;
  kind: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: Date;
};

/** 工作台附件服务：保存、读取和鉴权输出用户图片附件。 */
export class WorkbenchAttachmentService {
  private readonly prisma = getPrismaClient();

  /** 保存用户上传图片，并返回可用于当前工作台上下文的附件视图。 */
  async saveImage(userId: number, input: Buffer, mimeType: string, originalName: string, conversationId?: string): Promise<WorkbenchAttachmentView> {
    if (input.length <= 0) throw new WorkbenchAttachmentError('invalid_image', '请上传图片文件', 400);
    if (input.length > MAX_WORKBENCH_ATTACHMENT_BYTES) throw new WorkbenchAttachmentError('payload_too_large', '图片不能超过 12MB', 413);
    const normalizedMime = normalizeMimeType(mimeType);
    if (!ALLOWED_IMAGE_MIME.has(normalizedMime)) throw new WorkbenchAttachmentError('invalid_image', '仅支持 PNG、JPEG、WebP 图片', 400);

    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(input, { failOn: 'error', limitInputPixels: MAX_WORKBENCH_ATTACHMENT_PIXELS }).metadata();
    } catch {
      throw new WorkbenchAttachmentError('invalid_image', '图片文件无法识别', 400);
    }
    const width = Number(metadata.width ?? 0);
    const height = Number(metadata.height ?? 0);
    if (!width || !height) throw new WorkbenchAttachmentError('invalid_image', '图片尺寸不正确', 400);

    const extension = normalizedMime === 'image/png' ? 'png' : normalizedMime === 'image/webp' ? 'webp' : 'jpg';
    const filename = `wbatt_u${userId}_${randomBytes(12).toString('hex')}.${extension}`;
    const basePath = getWorkbenchAttachmentStoragePath();
    await mkdir(basePath, { recursive: true });
    const target = resolveAttachmentPath(filename);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, input);
    await rename(tmp, target);

    const record = await this.prisma.workbenchAttachment.create({
      data: {
        id: createAttachmentId(),
        userId,
        conversationId: conversationId || null,
        kind: 'image',
        filename,
        originalName: sanitizeOriginalName(originalName),
        mimeType: normalizedMime,
        sizeBytes: input.length,
        width,
        height,
      },
    });
    return mapAttachment(record);
  }

  /** 读取当前用户有权使用的一组附件元数据。 */
  async listOwned(userId: number, attachmentIds: string[]): Promise<WorkbenchAttachmentView[]> {
    const ids = normalizeAttachmentIds(attachmentIds);
    if (ids.length === 0) return [];
    const records = await this.prisma.workbenchAttachment.findMany({
      where: { userId, id: { in: ids } },
      orderBy: { createdAt: 'asc' },
    });
    return records.map(mapAttachment);
  }

  /** 按用户权限读取附件文件，供多模态模型调用。 */
  async readOwnedImage(userId: number, attachmentId: string): Promise<{ buffer: Buffer; mimeType: string; view: WorkbenchAttachmentView } | null> {
    const record = await this.prisma.workbenchAttachment.findFirst({ where: { id: attachmentId, userId } });
    if (!record || record.kind !== 'image') return null;
    const filePath = resolveAttachmentPath(record.filename);
    const buffer = await readFile(filePath).catch(() => null);
    if (!buffer) return null;
    return { buffer, mimeType: record.mimeType, view: mapAttachment(record) };
  }

  /** 把工作台附件转存成真实图生图参考图；只处理当前用户自己的附件，不接受外部 URL。 */
  async createGenerationReferences(userId: number, attachmentIds: string[]): Promise<{ sourceImageUrls: string[]; sourceImageSizes: number[] }> {
    const ids = normalizeAttachmentIds(attachmentIds);
    const sourceImageUrls: string[] = [];
    const sourceImageSizes: number[] = [];
    for (const attachmentId of ids) {
      const owned = await this.readOwnedImage(userId, attachmentId);
      if (!owned) continue;
      const uploaded = await uploadReferenceBufferToMedia(owned.buffer, owned.mimeType);
      sourceImageUrls.push(uploaded.url);
      sourceImageSizes.push(uploaded.size ?? owned.buffer.length);
    }
    return { sourceImageUrls, sourceImageSizes };
  }

  /** 鉴权输出当前用户自己的附件图片。 */
  async serveOwnedImage(userId: number, attachmentId: string, res: ServerResponse): Promise<boolean> {
    const record = await this.prisma.workbenchAttachment.findFirst({ where: { id: attachmentId, userId } });
    if (!record || record.kind !== 'image') return false;
    const filePath = resolveAttachmentPath(record.filename);
    const fileStats = await stat(filePath).catch(() => null);
    if (!fileStats?.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': record.mimeType,
      'Content-Length': String(fileStats.size),
      'Cache-Control': 'private, max-age=3600',
    });
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', resolvePromise);
      stream.pipe(res);
    });
    return true;
  }

  /** 删除一组已落盘的工作台附件文件；只接受数据库内保存过的安全短文件名。 */
  async deleteStoredFiles(filenames: string[]): Promise<void> {
    const uniqueFilenames = [...new Set(filenames.filter(filename => SAFE_ATTACHMENT_FILENAME.test(filename)))];
    for (const filename of uniqueFilenames) {
      const filePath = resolveAttachmentPath(filename);
      await unlink(filePath).catch(() => undefined);
    }
  }
}

/** 工作台附件错误，路由层据此返回可读 HTTP 状态。 */
export class WorkbenchAttachmentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'WorkbenchAttachmentError';
  }
}

/** 返回工作台附件根目录；生产默认 /v3/local/workbench-attachments。 */
function getWorkbenchAttachmentStoragePath(): string {
  const configured = process.env.WORKBENCH_ATTACHMENT_STORAGE_PATH?.trim();
  if (configured) return resolve(configured);
  const isProductionRoot = process.cwd().startsWith('/v3');
  return resolve(isProductionRoot ? '/v3/local/workbench-attachments' : join(process.cwd(), 'local', 'workbench-attachments'));
}

/** 解析附件本地路径，防止路径穿越。 */
function resolveAttachmentPath(filename: string): string {
  if (!SAFE_ATTACHMENT_FILENAME.test(filename)) throw new Error('附件文件名不合法');
  const basePath = getWorkbenchAttachmentStoragePath();
  const resolved = resolve(basePath, filename);
  if (resolved !== basePath && !resolved.startsWith(`${basePath}${sep}`)) throw new Error('附件路径不合法');
  return resolved;
}

/** 附件 ID 不包含用户敏感信息。 */
function createAttachmentId() {
  return `att_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`;
}

/** 映射数据库附件为前端视图。 */
function mapAttachment(record: AttachmentRecord): WorkbenchAttachmentView {
  return {
    id: record.id,
    kind: 'image',
    url: `/api/workbench/attachments/${record.id}`,
    name: record.originalName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    width: record.width,
    height: record.height,
    createdAt: record.createdAt.toISOString(),
  };
}

/** 附件 ID 只接受服务端生成的安全短 ID。 */
export function normalizeAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(item))
    .filter((item, index, array) => array.indexOf(item) === index)
    .slice(0, 8);
}

/** 兼容带 charset 的 Content-Type。 */
function normalizeMimeType(mimeType: string): string {
  return String(mimeType || '').split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream';
}

/** 原始文件名只用于展示，避免控制字符和超长文本进入页面。 */
function sanitizeOriginalName(value: string) {
  return String(value || 'image')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 120) || 'image';
}

/** 上传工作台附件到 media-service 的参考图链路，复用生成任务输入压缩上限。 */
async function uploadReferenceBufferToMedia(imageBuffer: Buffer, mimeType: string): Promise<{ url: string; size?: number }> {
  const uploadRes = await fetch(`${MEDIA_URL}/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': normalizeMimeType(mimeType),
      'x-service-token': process.env.WS_PROXY_TOKEN?.trim() ?? '',
      'x-aiimage-prefix': 'ref_',
      'x-aiimage-max-bytes': String(REFERENCE_TASK_INPUT_MAX_BYTES),
    },
    // 关键分支：图生图参考图必须进入 media-service 本地媒体链路，不能把工作台私有附件 URL 直接交给绘图服务。
    body: new Uint8Array(imageBuffer),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await uploadRes.json().catch(() => ({})) as {
    ok?: boolean;
    message?: string;
    data?: { filename?: string; size?: number };
  };
  if (!uploadRes.ok || !payload.ok || !payload.data?.filename) {
    throw new WorkbenchAttachmentError('reference_upload_failed', payload.message || '图生图参考图转存失败', uploadRes.status >= 500 ? 502 : 400);
  }
  return { url: `/images/${payload.data.filename}`, size: payload.data.size };
}
