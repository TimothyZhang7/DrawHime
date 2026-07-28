/** 本文件封装图片放大异步任务的持久化读写，任务状态以数据库为准，进程内只保留活动取消器。 */
import { Prisma, type ImageUpscaleJob, type PrismaClient } from '@prisma/client';
import type {
  ImageUpscaleJobStatus,
  ImageUpscaleJobView,
  ImageUpscaleOutputFormat,
  ImageUpscaleRunResponse,
  ImageUpscaleScale,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

const TERMINAL_STATUSES: ImageUpscaleJobStatus[] = ['succeeded', 'failed', 'cancelled'];

/** 新建图片放大持久化任务所需字段。 */
export interface CreateImageUpscaleJobRecordInput {
  /** 任务 ID，由业务服务生成，便于日志和 GPU trace 贯通。 */
  id: string;
  /** 当前登录用户 ID；查询和取消都按该字段隔离。 */
  userId: number;
  /** 上传源文件名，只用于用户端历史展示。 */
  sourceFileName: string;
  /** 私有原图短文件名。 */
  sourceStoredName: string;
  /** 私有预览短文件名。 */
  previewStoredName: string;
  /** 后端识别出的真实图片 MIME。 */
  sourceMimeType: string;
  /** 上传源文件大小。 */
  sourceSizeBytes: number;
  /** 上传源图宽度。 */
  sourceWidth: number;
  /** 上传源图高度。 */
  sourceHeight: number;
  /** 放大倍率。 */
  scale: ImageUpscaleScale;
  /** 实际模型名。 */
  model: string;
  /** 固定输出格式。 */
  outputFormat: ImageUpscaleOutputFormat;
  /** 是否保存到我的图片。 */
  saveToLibrary: boolean;
  /** 提交时指定的图库隐私；空值表示沿用账号默认设置。 */
  isPrivate?: boolean;
  /** 创建时间。 */
  createdAt: Date;
}

/** 图片放大任务仓储。 */
export class ImageUpscaleJobRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  /** 新建任务记录；任务必须先落库再启动后台 GPU 处理，避免提交响应后重启即丢失。 */
  async create(input: CreateImageUpscaleJobRecordInput): Promise<ImageUpscaleJob> {
    return this.prisma.imageUpscaleJob.create({
      data: {
        id: input.id,
        userId: input.userId,
        status: 'queued',
        progressText: '已提交，等待 GPU 队列',
        sourceFileName: input.sourceFileName,
        sourceStoredName: input.sourceStoredName,
        previewStoredName: input.previewStoredName,
        sourceMimeType: input.sourceMimeType,
        sourceSizeBytes: BigInt(input.sourceSizeBytes),
        sourceWidth: input.sourceWidth,
        sourceHeight: input.sourceHeight,
        scale: input.scale,
        model: input.model,
        outputFormat: input.outputFormat,
        saveToLibrary: input.saveToLibrary,
        isPrivate: input.isPrivate,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    });
  }

  /** 查询当前用户自己的单个任务；跨用户任务不会返回。 */
  async findForUser(userId: number, jobId: string): Promise<ImageUpscaleJob | null> {
    return this.prisma.imageUpscaleJob.findFirst({ where: { id: jobId, userId } });
  }

  /** 列出当前用户近期任务；结果 JSON 可选返回，列表默认不带大字段。 */
  async listForUser(userId: number, take: number, includeResult: boolean): Promise<ImageUpscaleJob[]> {
    return this.prisma.imageUpscaleJob.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(includeResult ? {} : { select: imageUpscaleJobListSelect }),
    }) as Promise<ImageUpscaleJob[]>;
  }

  /** 查询服务重启时遗留的未完成任务；新任务可通过私有源图重新排队。 */
  async listInterruptedJobs(take: number): Promise<ImageUpscaleJob[]> {
    return this.prisma.imageUpscaleJob.findMany({
      where: { status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  /** 重启恢复前把任务重新标记为排队，保留原任务 ID 和图库选项。 */
  async markQueued(jobId: string, progressText: string): Promise<void> {
    await this.prisma.imageUpscaleJob.updateMany({
      where: { id: jobId, status: { in: ['queued', 'running'] } },
      data: { status: 'queued', progressText, startedAt: null, finishedAt: null, error: null },
    });
  }

  /** 标记任务进入运行中；终态任务不会被覆盖。 */
  async markRunning(jobId: string, progressText: string, startedAt: Date): Promise<void> {
    await this.prisma.imageUpscaleJob.updateMany({
      where: { id: jobId, status: { notIn: TERMINAL_STATUSES } },
      data: { status: 'running', progressText, startedAt },
    });
  }

  /** 标记任务成功并保存完整结果视图；终态任务不会被覆盖。 */
  async markSucceeded(jobId: string, result: ImageUpscaleRunResponse, finishedAt: Date): Promise<void> {
    await this.prisma.imageUpscaleJob.updateMany({
      where: { id: jobId, status: { notIn: TERMINAL_STATUSES } },
      data: {
        status: 'succeeded',
        progressText: '处理完成',
        resultJson: toJsonValue(result),
        error: null,
        finishedAt,
      },
    });
  }

  /** 标记任务失败；失败原因持久化后刷新页面仍可见。 */
  async markFailed(jobId: string, message: string, finishedAt: Date): Promise<void> {
    await this.prisma.imageUpscaleJob.updateMany({
      where: { id: jobId, status: { notIn: TERMINAL_STATUSES } },
      data: { status: 'failed', progressText: '处理失败', error: message, finishedAt },
    });
  }

  /** 标记任务被用户手动结束；取消不能删除历史记录。 */
  async markCancelled(userId: number, jobId: string, finishedAt: Date): Promise<ImageUpscaleJob | null> {
    await this.prisma.imageUpscaleJob.updateMany({
      where: { id: jobId, userId, status: { notIn: TERMINAL_STATUSES } },
      data: {
        status: 'cancelled',
        progressText: '已手动结束',
        error: '用户已手动结束该图片放大任务。',
        finishedAt,
      },
    });
    return this.findForUser(userId, jobId);
  }

  /** 后台保存图库成功后补写 savedTask；只更新未取消且已有成功结果的任务。 */
  async updateSavedTask(jobId: string, result: ImageUpscaleRunResponse): Promise<void> {
    await this.prisma.imageUpscaleJob.updateMany({
      where: { id: jobId, status: 'succeeded' },
      data: { resultJson: toJsonValue(result), error: null },
    });
  }

  /** 后台保存图库失败时仅记录错误摘要，不覆盖已经可访问的放大结果。 */
  async markBackgroundSaveFailed(jobId: string, message: string): Promise<void> {
    await this.prisma.imageUpscaleJob.updateMany({
      where: { id: jobId, status: 'succeeded' },
      data: { error: `后台保存到我的图片失败：${message}` },
    });
  }

  /** 将数据库任务记录转为共享契约视图。 */
  toView(row: ImageUpscaleJob, includeResult = true): ImageUpscaleJobView {
    return {
      id: row.id,
      userId: row.userId,
      status: normalizeStatus(row.status),
      progress: computeProgress(row, Date.now()),
      progressText: row.progressText,
      sourceFileName: row.sourceFileName,
      sourceMimeType: row.sourceMimeType ?? undefined,
      sourceSizeBytes: Number(row.sourceSizeBytes),
      sourceWidth: row.sourceWidth ?? undefined,
      sourceHeight: row.sourceHeight ?? undefined,
      sourceUrl: row.sourceStoredName ? `/api/tools/image-upscale/jobs/${encodeURIComponent(row.id)}/source` : undefined,
      previewUrl: row.previewStoredName ? `/api/tools/image-upscale/jobs/${encodeURIComponent(row.id)}/source?preview=1` : undefined,
      scale: normalizeScale(row.scale),
      model: row.model,
      outputFormat: normalizeOutputFormat(row.outputFormat),
      saveToLibrary: row.saveToLibrary,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      startedAt: row.startedAt?.toISOString(),
      finishedAt: row.finishedAt?.toISOString(),
      result: includeResult ? normalizeResult(row.resultJson) : undefined,
      error: row.error ?? undefined,
    };
  }
}

const imageUpscaleJobListSelect = {
  id: true,
  userId: true,
  status: true,
  progressText: true,
  sourceFileName: true,
  sourceStoredName: true,
  previewStoredName: true,
  sourceMimeType: true,
  sourceSizeBytes: true,
  sourceWidth: true,
  sourceHeight: true,
  scale: true,
  model: true,
  outputFormat: true,
  saveToLibrary: true,
  isPrivate: true,
  error: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.ImageUpscaleJobSelect;

/** JSON 字段写入前统一转换为 Prisma 可接受类型。 */
function toJsonValue(result: ImageUpscaleRunResponse): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
}

/** 从 JSON 字段恢复图片放大结果；结构异常时不返回结果，避免前端崩溃。 */
function normalizeResult(value: Prisma.JsonValue | null): ImageUpscaleRunResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as unknown as ImageUpscaleRunResponse;
}

function normalizeStatus(value: string): ImageUpscaleJobStatus {
  if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled') return value;
  return 'failed';
}

function normalizeScale(value: number): ImageUpscaleScale {
  return value === 3 || value === 4 ? value : 2;
}

function normalizeOutputFormat(_value: string): ImageUpscaleOutputFormat {
  return 'webp';
}

function computeProgress(job: ImageUpscaleJob, now: number): number {
  const status = normalizeStatus(job.status);
  if (TERMINAL_STATUSES.includes(status)) return 100;
  if (status === 'queued') {
    const queuedSeconds = Math.max(0, (now - job.createdAt.getTime()) / 1000);
    return Math.min(18, 6 + Math.floor(queuedSeconds / 3));
  }
  const startedAt = job.startedAt?.getTime() ?? now;
  const runningSeconds = Math.max(0, (now - startedAt) / 1000);
  return Math.min(94, 24 + Math.floor(runningSeconds * 1.8));
}
