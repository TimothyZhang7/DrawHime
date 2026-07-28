/** 本文件实现 LoRA 仓库列表、草稿、上传、发布、下载和作者删除业务。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LORA_REPOSITORY_TYPE_OPTIONS, type DrawingLoraSnapshot, type DrawingPromptFormat, type GenerationLoraSelection, type LoraBaseModelOptionView, type LoraRepositoryItemView, type LoraRepositoryType, type LoraUploadKind } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { LoraStorageError, LoraStorageService } from './lora-storage-service.js';

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 5000;
const MAX_EXAMPLES = 8;

/** LoRA 仓库业务错误。 */
export class LoraRepositoryError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'LoraRepositoryError'; }
}

/** LoRA 仓库业务服务。 */
export class LoraRepositoryService {
  private readonly prisma = getPrismaClient();
  private readonly exampleCompletionLocks = new Map<number, Promise<void>>();
  constructor(private readonly storage = new LoraStorageService()) {}

  /** 返回只包含主模型系列的全局下拉词表。 */
  async listBaseModels(): Promise<LoraBaseModelOptionView[]> {
    const models = await this.prisma.loraBaseModel.findMany({ orderBy: [{ isSystem: 'desc' }, { displayName: 'asc' }], select: { name: true, displayName: true } });
    return models.map(item => ({ value: item.name, label: item.displayName }));
  }

  /** 查询公开仓库或当前用户自己的全部记录。 */
  async list(input: { userId?: number; mine: boolean; page: number; pageSize: number; search?: string; model?: string; loraType?: string }) {
    const pageSize = normalizePositiveInteger(input.pageSize, 18, 30);
    const page = normalizePositiveInteger(input.page, 1, 1_000_000);
    const where = {
      ...(input.mine && input.userId ? { userId: input.userId } : { status: 'published' }),
      ...(input.model ? { baseModel: normalizeBaseModel(input.model).name } : {}),
      ...(input.loraType ? { loraType: normalizeLoraType(input.loraType) } : {}),
      ...(input.search ? { OR: [{ title: { contains: input.search } }, { description: { contains: input.search } }] } : {}),
    };
    const [records, total] = await Promise.all([
      this.prisma.loraRepositoryItem.findMany({ where, orderBy: input.mine ? { createdAt: 'desc' } : { publishedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: itemInclude }),
      this.prisma.loraRepositoryItem.count({ where }),
    ]);
    return { items: records.map(record => mapItem(record, input.userId)), total, page, pageSize };
  }

  /** 创建只对作者可见的上传草稿。 */
  async createDraft(userId: number, input: { title: string; description: string; baseModel: string; loraType: LoraRepositoryType }): Promise<LoraRepositoryItemView> {
    const title = String(input?.title ?? '').trim();
    const description = String(input?.description ?? '').trim();
    if (!title || title.length > MAX_TITLE) throw new LoraRepositoryError(400, `标题必须为 1-${MAX_TITLE} 个字符`);
    if (!description || description.length > MAX_DESCRIPTION) throw new LoraRepositoryError(400, `描述必须为 1-${MAX_DESCRIPTION} 个字符`);
    const baseModel = normalizeBaseModel(input?.baseModel);
    const loraType = normalizeLoraType(input?.loraType);
    // 新主模型词表项与草稿同事务首次写入；词条属于全局资产，后续上传失败删除草稿时仍保留。
    const record = await this.prisma.$transaction(async (tx) => {
      await tx.loraBaseModel.upsert({
        where: { name: baseModel.name },
        update: baseModel.isSystem ? { displayName: baseModel.displayName, isSystem: true } : {},
        create: { name: baseModel.name, displayName: baseModel.displayName, isSystem: baseModel.isSystem, createdByUserId: baseModel.isSystem ? null : userId },
      });
      return tx.loraRepositoryItem.create({ data: { userId, title, description, baseModel: baseModel.name, loraType }, include: itemInclude });
    });
    return mapItem(record, userId);
  }

  /** 流式上传作者草稿的模型文件，数据库失败时回滚新文件。 */
  async uploadModel(userId: number, loraId: number, req: IncomingMessage, originalName: string): Promise<LoraRepositoryItemView> {
    const existing = await this.requireOwnedDraft(userId, loraId);
    const saved = await this.storage.saveModelFile(loraId, req, originalName);
    return this.persistSavedModel(userId, existing, saved);
  }

  /** 创建绑定当前作者草稿的模型或示例图分片上传会话。 */
  async createUploadSession(userId: number, loraId: number, input: { kind: LoraUploadKind; fileName: string; sizeBytes: number }) {
    const existing = await this.requireOwnedDraft(userId, loraId);
    const kind = input?.kind;
    if (kind !== 'model' && kind !== 'example') throw new LoraRepositoryError(400, '上传类型不正确');
    if (kind === 'example' && existing.exampleImages.length >= MAX_EXAMPLES) throw new LoraRepositoryError(400, `示例图最多 ${MAX_EXAMPLES} 张`);
    return this.storage.createUploadSession({ userId, loraId, kind, originalName: String(input?.fileName ?? ''), totalBytes: Number(input?.sizeBytes) });
  }

  /** 写入一个分片，偏移必须与服务端记录严格一致。 */
  async uploadChunk(userId: number, loraId: number, uploadId: string, offset: number, req: IncomingMessage) {
    await this.requireOwnedDraft(userId, loraId);
    return this.storage.appendUploadChunk({ userId, loraId, uploadId, offset, req });
  }

  /** 返回当前作者分片会话的服务端偏移。 */
  async getUploadSession(userId: number, loraId: number, uploadId: string) {
    await this.requireOwnedDraft(userId, loraId);
    return this.storage.getUploadSession(userId, loraId, uploadId);
  }

  /** 完成分片会话，并按模型文件或示例图的真实存储链路落库。 */
  async completeUpload(userId: number, loraId: number, uploadId: string): Promise<LoraRepositoryItemView> {
    const existing = await this.requireOwnedDraft(userId, loraId);
    try {
      const saved = await this.storage.completeModelUpload(userId, loraId, uploadId);
      return this.persistSavedModel(userId, existing, saved);
    } catch (error) {
      if (!(error instanceof LoraStorageError) || error.message !== '上传会话类型不匹配') throw error;
    }
    return this.withExampleCompletionLock(loraId, async () => {
      const latest = await this.requireOwnedDraft(userId, loraId);
      if (latest.exampleImages.length >= MAX_EXAMPLES) {
        await this.storage.cancelUploadSession(userId, loraId, uploadId);
        throw new LoraRepositoryError(400, `示例图最多 ${MAX_EXAMPLES} 张`);
      }
      const input = await this.storage.consumeExampleUpload(userId, loraId, uploadId);
      return this.saveAndRegisterExample(userId, loraId, latest.exampleImages.length, input);
    });
  }

  /** 取消作者草稿中的一个分片上传会话。 */
  async cancelUpload(userId: number, loraId: number, uploadId: string): Promise<void> {
    await this.requireOwnedDraft(userId, loraId);
    await this.storage.cancelUploadSession(userId, loraId, uploadId);
  }

  private async persistSavedModel(userId: number, existing: Awaited<ReturnType<LoraRepositoryService['requireOwnedDraft']>>, saved: { storedName: string; originalName: string; sizeBytes: number; sha256: string }): Promise<LoraRepositoryItemView> {
    try {
      const updated = await this.prisma.loraRepositoryItem.update({ where: { id: existing.id }, data: { storedName: saved.storedName, originalFileName: saved.originalName, fileSizeBytes: BigInt(saved.sizeBytes), sha256: saved.sha256 }, include: itemInclude });
      // 数据库成功后再清理被替换文件，避免更新失败导致草稿丢失原模型。
      if (existing.storedName && existing.storedName !== saved.storedName) await this.storage.deleteFiles(existing.storedName, []);
      return mapItem(updated, userId);
    } catch (error) {
      await this.storage.deleteFiles(saved.storedName, []);
      throw error;
    }
  }

  /** 上传并登记一张示例图。 */
  async uploadExample(userId: number, loraId: number, input: Buffer): Promise<LoraRepositoryItemView> {
    const existing = await this.requireOwnedDraft(userId, loraId);
    if (existing.exampleImages.length >= MAX_EXAMPLES) throw new LoraRepositoryError(400, `示例图最多 ${MAX_EXAMPLES} 张`);
    return this.saveAndRegisterExample(userId, loraId, existing.exampleImages.length, input);
  }

  private async saveAndRegisterExample(userId: number, loraId: number, sortOrder: number, input: Buffer): Promise<LoraRepositoryItemView> {
    const saved = await this.storage.saveExampleImage(loraId, input);
    try {
      await this.prisma.loraExampleImage.create({ data: { loraId, ...saved, sortOrder } });
      return await this.getOwned(loraId, userId);
    } catch (error) {
      await this.storage.deleteFiles(null, [saved.storedName]);
      throw error;
    }
  }

  /** 草稿满足文件与示例图要求后原子发布。 */
  async publish(userId: number, loraId: number): Promise<LoraRepositoryItemView> {
    const existing = await this.requireOwnedDraft(userId, loraId);
    if (!existing.storedName) throw new LoraRepositoryError(400, '请先上传 LoRA 文件');
    if (existing.exampleImages.length === 0) throw new LoraRepositoryError(400, '请至少上传一张示例图');
    const updated = await this.prisma.loraRepositoryItem.update({ where: { id: loraId }, data: { status: 'published', publishedAt: new Date() }, include: itemInclude });
    return mapItem(updated, userId);
  }

  /** 作者删除条目；先事务删除数据库，再幂等清理本地文件。 */
  async deleteOwned(userId: number, loraId: number): Promise<void> {
    const existing = await this.prisma.loraRepositoryItem.findFirst({ where: { id: loraId, userId }, include: itemInclude });
    if (!existing) throw new LoraRepositoryError(404, 'LoRA 条目不存在');
    await this.prisma.loraRepositoryItem.delete({ where: { id: loraId } });
    await Promise.all([
      this.storage.deleteFiles(existing.storedName, existing.exampleImages.map(item => item.storedName)),
      this.storage.deleteUploadSessionsForLora(userId, loraId),
    ]);
  }

  /** 输出已发布示例图。 */
  async serveExample(exampleId: number, res: ServerResponse): Promise<boolean> {
    const example = await this.prisma.loraExampleImage.findFirst({ where: { id: exampleId, lora: { status: 'published' } } });
    return example ? this.storage.serveExample(example.storedName, res) : false;
  }

  /** 输出已发布 LoRA 并幂等增加下载计数。 */
  async serveDownload(loraId: number, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const item = await this.prisma.loraRepositoryItem.findFirst({ where: { id: loraId, status: 'published', storedName: { not: null } } });
    if (!item?.storedName || !item.originalFileName) return false;
    const result = await this.storage.serveModel(item.storedName, item.originalFileName, req, res);
    if (result === 'served') await this.prisma.loraRepositoryItem.update({ where: { id: item.id }, data: { downloadCount: { increment: 1 } } }).catch(() => undefined);
    return result !== 'missing';
  }

  /** 校验生成请求选择并返回跨服务使用的不可变 LoRA 文件快照。 */
  async resolveGenerationSelection(selection: GenerationLoraSelection, promptFormat: DrawingPromptFormat): Promise<DrawingLoraSnapshot> {
    const id = Number(selection?.id);
    const strength = Number(selection?.strength);
    if (!Number.isSafeInteger(id) || id <= 0) throw new LoraRepositoryError(400, 'LoRA 条目 ID 不正确');
    if (!Number.isFinite(strength) || strength < 0 || strength > 2) throw new LoraRepositoryError(400, 'LoRA 强度必须在 0-2 之间');
    // 当前真实工作流只在 Anima ComfyUI 链路接入用户 LoRA，其他格式不做静默忽略。
    if (promptFormat !== 'anima') throw new LoraRepositoryError(400, '当前模型格式不支持 LoRA');
    const item = await this.prisma.loraRepositoryItem.findFirst({
      where: { id, status: 'published', storedName: { not: null }, sha256: { not: null }, fileSizeBytes: { not: null } },
      select: { id: true, title: true, baseModel: true, sha256: true, fileSizeBytes: true },
    });
    if (!item?.sha256 || item.fileSizeBytes === null) throw new LoraRepositoryError(404, 'LoRA 文件不存在或尚未发布');
    if (item.baseModel.toLowerCase() !== 'anima') throw new LoraRepositoryError(400, '所选 LoRA 与当前 Anima 模型不兼容');
    return {
      id: item.id,
      title: item.title,
      baseModel: item.baseModel,
      strength: Math.round(strength * 100) / 100,
      sizeBytes: Number(item.fileSizeBytes),
      sha256: item.sha256,
      gpuFileName: `aiimage_lora_${item.sha256}.safetensors`,
    };
  }

  /** 按任务快照 SHA 流式输出 LoRA，供 Worker 同步到 ComfyUI，不增加公开下载量。 */
  async serveInternalDownload(loraId: number, expectedSha256: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const sha256 = expectedSha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new LoraRepositoryError(400, 'LoRA 文件哈希不正确');
    const item = await this.prisma.loraRepositoryItem.findFirst({
      where: { id: loraId, status: 'published', storedName: { not: null }, sha256 },
      select: { storedName: true, originalFileName: true },
    });
    if (!item?.storedName) return false;
    const result = await this.storage.serveModel(item.storedName, item.originalFileName ?? 'model.safetensors', req, res);
    return result !== 'missing';
  }

  private async requireOwnedDraft(userId: number, loraId: number) {
    const item = await this.prisma.loraRepositoryItem.findFirst({ where: { id: loraId, userId }, include: itemInclude });
    if (!item) throw new LoraRepositoryError(404, 'LoRA 草稿不存在');
    if (item.status !== 'draft') throw new LoraRepositoryError(400, '已发布 LoRA 不再接受文件修改');
    return item;
  }

  private async getOwned(loraId: number, userId: number): Promise<LoraRepositoryItemView> {
    const item = await this.prisma.loraRepositoryItem.findFirst({ where: { id: loraId, userId }, include: itemInclude });
    if (!item) throw new LoraRepositoryError(404, 'LoRA 草稿不存在');
    return mapItem(item, userId);
  }

  private async withExampleCompletionLock<T>(loraId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.exampleCompletionLocks.get(loraId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const queued = previous.then(() => gate);
    this.exampleCompletionLocks.set(loraId, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.exampleCompletionLocks.get(loraId) === queued) this.exampleCompletionLocks.delete(loraId);
    }
  }
}

const itemInclude = { user: { select: { id: true, username: true } }, exampleImages: { orderBy: { sortOrder: 'asc' as const } } } as const;

function mapItem(record: any, currentUserId?: number): LoraRepositoryItemView {
  const owned = record.userId === currentUserId;
  return {
    id: record.id, title: record.title, description: record.description, baseModel: record.baseModel, loraType: normalizeStoredLoraType(record.loraType), status: record.status === 'published' ? 'published' : 'draft',
    author: { id: record.user.id, username: record.user.username },
    ...(owned && record.originalFileName ? { fileName: record.originalFileName } : {}),
    ...(record.fileSizeBytes !== null ? { fileSizeBytes: Number(record.fileSizeBytes) } : {}),
    fileReady: Boolean(record.storedName),
    exampleImages: record.exampleImages.map((image: any) => ({ id: image.id, ...(record.status === 'published' ? { url: `/api/loras/examples/${image.id}` } : {}), width: image.width, height: image.height, sortOrder: image.sortOrder })),
    downloadCount: record.downloadCount, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(), ...(record.publishedAt ? { publishedAt: record.publishedAt.toISOString() } : {}), owned,
  };
}

const loraTypeValues = new Set<LoraRepositoryType>(LORA_REPOSITORY_TYPE_OPTIONS.map(item => item.value));

/** 校验用户提交的 LoRA 分类。 */
function normalizeLoraType(value: unknown): LoraRepositoryType {
  const normalized = String(value ?? '').trim() as LoraRepositoryType;
  if (!loraTypeValues.has(normalized)) throw new LoraRepositoryError(400, 'LoRA 类型不正确');
  return normalized;
}

/** 兼容读取迁移前或异常历史分类。 */
function normalizeStoredLoraType(value: unknown): LoraRepositoryType {
  const normalized = String(value ?? '').trim() as LoraRepositoryType;
  return loraTypeValues.has(normalized) ? normalized : 'other';
}

/** 将主模型输入归一化为系列名，已知系列不保存 checkpoint 或版本名。 */
function normalizeBaseModel(value: unknown): { name: string; displayName: string; isSystem: boolean } {
  const displayName = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (/^anima(?:[-_.\s]|$)/i.test(displayName)) return { name: 'anima', displayName: 'Anima', isSystem: true };
  if (/^krea[-_.\s]*2(?:[-_.\s]|$)/i.test(displayName)) return { name: 'krea2', displayName: 'Krea 2', isSystem: true };
  if (displayName.toLowerCase().endsWith('.safetensors')) throw new LoraRepositoryError(400, '请填写主模型系列名称，不要填写 checkpoint 文件名');
  if (displayName.length < 2 || displayName.length > 48 || !/^[\p{L}\p{N}][\p{L}\p{N} ._+\-]*$/u.test(displayName)) throw new LoraRepositoryError(400, '主模型系列名称必须为 2-48 个有效字符');
  return { name: displayName.toLocaleLowerCase('en-US'), displayName, isSystem: false };
}

/** 归一化分页数字，避免非法查询参数进入 Prisma。 */
function normalizePositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), 1), maximum);
}
