/** 本文件管理图片放大异步任务：提交后由 backend 持续处理，前端可刷新后继续轮询。 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type {
  ImageUpscaleJobStatus,
  ImageUpscaleJobView,
  ImageUpscaleOutputFormat,
  ImageUpscaleRunOptions,
  ImageUpscaleRunResponse,
  ImageUpscaleScale,
} from '@aiimage/shared-contracts';
import { ImageUpscaleError, ImageUpscaleService, resolveLocalGpuResultDownloadUrl, type ImageUpscaleRuntimeConfig } from './image-upscale-service.js';
import { ImageUpscaleLibraryService } from './image-upscale-library-service.js';
import { ImageUpscaleJobRepository } from './image-upscale-job-repository.js';
import { ImageUpscaleQueueFullError, ImageUpscaleQueueService, ImageUpscaleQueueTimeoutError, type ImageUpscaleQueueOptions } from './image-upscale-queue-service.js';
import { ImageUpscaleSourceStorage } from './image-upscale-source-storage.js';
import { logger } from '../../shared/logger.js';

const MAX_JOBS_PER_USER = 50;
const MAX_RECOVERY_JOBS = 200;
const JOB_EXTRA_TIMEOUT_MS = 90_000;

/** 图片放大异步任务提交参数。 */
export interface ImageUpscaleJobSubmitInput {
  /** 当前登录用户 ID。 */
  userId: number;
  /** 上传文件名，仅用于前端历史展示。 */
  sourceFileName: string;
  /** 上传文件字节大小。 */
  sourceSizeBytes: number;
  /** 上传图片二进制。 */
  imageBuffer: Buffer;
  /** 请求 MIME 类型。 */
  mimeType: string;
  /** 后台运行时配置。 */
  config: ImageUpscaleRuntimeConfig;
  /** 用户请求选项。 */
  options: ImageUpscaleRunOptions;
  /** GPU 队列配置。 */
  queue: ImageUpscaleQueueOptions;
  /** 成功完成后调用，用于真实工具计数。 */
  onSucceeded?: () => Promise<void> | void;
}

interface ImageUpscaleJobRecord {
  id: string;
  userId: number;
  status: ImageUpscaleJobStatus;
  progressText: string;
  sourceFileName: string;
  sourceMimeType?: string;
  sourceSizeBytes: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceUrl?: string;
  previewUrl?: string;
  scale: ImageUpscaleScale;
  model: string;
  outputFormat: ImageUpscaleOutputFormat;
  saveToLibrary: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: ImageUpscaleRunResponse;
  error?: string;
  /** 当前任务的后端到 GPU 请求取消器；用户结束或硬超时时用于释放连接。 */
  abortController?: AbortController;
}

/** 图片放大异步任务服务；任务状态和结果持久化到数据库，进程内只保存当前活动请求的取消器。 */
export class ImageUpscaleJobService {
  private readonly jobs = new Map<string, ImageUpscaleJobRecord>();
  private recoveryPromise: Promise<void> = Promise.resolve();
  private recoveryStarted = false;

  constructor(
    private readonly queueService: ImageUpscaleQueueService,
    private readonly upscaleService: ImageUpscaleService,
    private readonly libraryService: ImageUpscaleLibraryService,
    private readonly repository: ImageUpscaleJobRepository = new ImageUpscaleJobRepository(),
    private readonly sourceStorage: ImageUpscaleSourceStorage = new ImageUpscaleSourceStorage(),
  ) {}

  /** 服务启动时从数据库和私有源图恢复旧进程遗留任务。 */
  startRecovery(loadConfig: () => Promise<ImageUpscaleRuntimeConfig>, onSucceeded?: () => Promise<void> | void): void {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    this.recoveryPromise = this.recoverInterruptedJobs(loadConfig, onSucceeded).catch((error) => {
      this.recoveryStarted = false;
      logger.warn({ error: readJobErrorMessage(error) }, '图片放大任务启动恢复失败');
    });
  }

  /** 提交异步任务并立即返回任务视图，后台会继续执行 GPU 队列。 */
  async submit(input: ImageUpscaleJobSubmitInput): Promise<ImageUpscaleJobView> {
    await this.ensureStartupRecovery();
    const now = Date.now();
    const scale = normalizeJobScale(input.options.scale, input.config.defaultScale);
    const model = normalizeJobModel(input.options.model, input.config.model);
    const outputFormat = normalizeJobOutputFormat(input.options.outputFormat, input.config.outputFormat);
    const job: ImageUpscaleJobRecord = {
      id: `up_${now.toString(36)}_${randomUUID().slice(0, 8)}`,
      userId: input.userId,
      status: 'queued',
      progressText: '已提交，等待 GPU 队列',
      sourceFileName: input.sourceFileName || 'image',
      sourceSizeBytes: input.sourceSizeBytes,
      scale,
      model,
      outputFormat,
      saveToLibrary: input.options.saveToLibrary === true,
      createdAt: now,
      updatedAt: now,
    };
    const stored = await this.sourceStorage.save(input.userId, input.imageBuffer, input.mimeType);
    job.sourceSizeBytes = stored.sizeBytes;
    job.sourceMimeType = stored.mimeType;
    job.sourceWidth = stored.width;
    job.sourceHeight = stored.height;
    job.sourceUrl = `/api/tools/image-upscale/jobs/${encodeURIComponent(job.id)}/source`;
    job.previewUrl = `${job.sourceUrl}?preview=1`;
    try {
      // 私有源图先原子落盘，数据库再记录安全短文件名；这样 backend 重启后可继续原任务。
      await this.repository.create({
        id: job.id,
        userId: job.userId,
        sourceFileName: job.sourceFileName,
        sourceStoredName: stored.sourceStoredName,
        previewStoredName: stored.previewStoredName,
        sourceMimeType: stored.mimeType,
        sourceSizeBytes: stored.sizeBytes,
        sourceWidth: stored.width,
        sourceHeight: stored.height,
        scale: job.scale,
        model: job.model,
        outputFormat: job.outputFormat,
        saveToLibrary: job.saveToLibrary,
        isPrivate: input.options.isPrivate,
        createdAt: new Date(now),
      });
    } catch (error) {
      // 数据库写入失败必须回滚刚落盘的私有文件，避免产生无法归属的源图。
      await this.sourceStorage.remove(stored.sourceStoredName, stored.previewStoredName);
      throw error;
    }
    this.jobs.set(job.id, job);
    this.enqueue(job, { ...input, sourceSizeBytes: stored.sizeBytes, mimeType: stored.mimeType });
    return this.toView(job);
  }

  /** 把已持久化的新任务或恢复任务提交到现有 GPU 队列，不改变入图库规则。 */
  private enqueue(job: ImageUpscaleJobRecord, input: ImageUpscaleJobSubmitInput): void {
    const timeoutMs = Math.max(30_000, input.config.timeoutSec * 1000 + JOB_EXTRA_TIMEOUT_MS);
    void this.queueService.run(() => {
      const abortController = new AbortController();
      job.abortController = abortController;
      return this.withJobTimeout(job.id, timeoutMs, abortController, async () => {
        await this.throwIfTerminal(job.id);
        logger.info({ jobId: job.id, userId: input.userId, sourceFileName: job.sourceFileName, scale: job.scale, model: job.model }, '图片放大任务开始调用 GPU');
        await this.markRunning(job.id, 'GPU 正在放大图片');
        const result = await this.upscaleService.upscale(input.imageBuffer, input.mimeType, input.config, input.options, {
          traceId: job.id,
          signal: abortController.signal,
          onStage: (text) => { void this.markRunning(job.id, text).catch((persistError) => this.logPersistError(job.id, persistError, '更新阶段进度失败')); },
        });
        await this.throwIfTerminal(job.id);
        logger.info({ jobId: job.id, elapsedMs: result.elapsedMs, outputBytes: result.image.sizeBytes, saveToLibrary: input.options.saveToLibrary === true }, '图片放大任务 GPU 已返回');
        await this.markRunning(job.id, input.options.saveToLibrary ? '正在保存到我的图片' : '正在整理放大结果');
        if (input.options.saveToLibrary) {
          if (result.image.base64) {
            // binary/S3 同步保存仍走现有真实服务，不触碰钱包和普通绘图扣费链路。
            result.savedTask = await this.libraryService.saveResult({
              userId: input.userId,
              result,
              imageBuffer: Buffer.from(result.image.base64, 'base64'),
              mimeType: result.image.mimeType,
              sourceImageBuffer: input.imageBuffer,
              sourceMimeType: input.mimeType,
              isPrivate: input.options.isPrivate,
              traceId: job.id,
            });
            logger.info({ jobId: job.id, taskId: result.savedTask.id }, '图片放大任务已保存到图库');
          }
        }
        await this.throwIfTerminal(job.id);
        return result;
      }).finally(() => {
        job.abortController = undefined;
      });
    }, input.queue).then(async ({ result, waitMs }) => {
      result.queueWaitMs = waitMs;
      await this.markSucceeded(job.id, result);
      if (input.options.saveToLibrary && !result.savedTask && result.image.url) {
        const libraryImageUrl = input.config.responseTransport === 'local'
          ? resolveLocalGpuResultDownloadUrl(result.image.url, input.config.baseUrl)
          : result.image.url;
        this.saveRemoteResultInBackground(job.id, input.userId, result, libraryImageUrl, input.options.isPrivate, input.imageBuffer, input.mimeType);
      }
      await input.onSucceeded?.();
      logger.info({ jobId: job.id, waitMs, elapsedMs: result.elapsedMs }, '图片放大任务完成');
    }).catch((error) => {
      void this.markFailed(job.id, readJobErrorMessage(error)).catch((persistError) => this.logPersistError(job.id, persistError, '标记失败状态失败'));
      logger.warn({ jobId: job.id, error: error instanceof Error ? error.message : String(error) }, '图片放大任务失败');
    });
  }

  /** 查询当前用户可访问的图片放大任务。 */
  async getJob(userId: number, jobId: string): Promise<ImageUpscaleJobView | null> {
    await this.ensureStartupRecovery();
    const row = await this.repository.findForUser(userId, jobId);
    return row ? this.repository.toView(row) : null;
  }

  /** 列出当前用户近期任务，供刷新页面后恢复历史。 */
  async listJobs(userId: number): Promise<ImageUpscaleJobView[]> {
    await this.ensureStartupRecovery();
    const rows = await this.repository.listForUser(userId, MAX_JOBS_PER_USER, false);
    return rows.map((row) => this.repository.toView(row, false));
  }

  /** 鉴权输出当前用户历史任务的私有源图或轻量预览。 */
  async serveSource(userId: number, jobId: string, preview: boolean, res: ServerResponse): Promise<boolean> {
    await this.ensureStartupRecovery();
    const row = await this.repository.findForUser(userId, jobId);
    const storedName = preview ? row?.previewStoredName : row?.sourceStoredName;
    if (!row || !storedName || !row.sourceMimeType) return false;
    return this.sourceStorage.serve(storedName, row.sourceMimeType, preview, res);
  }

  /** 手动结束当前用户的图片放大任务；已进入 GPU 的请求无法中断，但后续结果会被忽略。 */
  async cancelJob(userId: number, jobId: string): Promise<ImageUpscaleJobView | null> {
    await this.ensureStartupRecovery();
    const job = this.jobs.get(jobId);
    if (job && !isTerminalStatus(job.status)) {
      const now = Date.now();
      job.status = 'cancelled';
      job.updatedAt = now;
      job.finishedAt = now;
      job.progressText = '已手动结束';
      job.error = '用户已手动结束该图片放大任务。';
      // 取消只终止 backend 自己的等待和读取；GPU 已开始的推理不做强杀，避免破坏共享服务状态。
      job.abortController?.abort();
      logger.info({ jobId, userId }, '图片放大任务已由用户手动结束');
    }
    const row = await this.repository.markCancelled(userId, jobId, new Date());
    return row ? this.repository.toView(row) : null;
  }

  private async markRunning(jobId: string, progressText = 'GPU 正在放大图片'): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || isTerminalStatus(job.status)) return;
    const now = Date.now();
    job.status = 'running';
    job.startedAt = job.startedAt ?? now;
    job.updatedAt = now;
    job.progressText = progressText;
    await this.repository.markRunning(jobId, progressText, new Date(job.startedAt));
  }

  private async markSucceeded(jobId: string, result: ImageUpscaleRunResponse): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || isTerminalStatus(job.status)) return;
    const now = Date.now();
    job.status = 'succeeded';
    job.updatedAt = now;
    job.finishedAt = now;
    job.progressText = '处理完成';
    job.result = result;
    await this.repository.markSucceeded(jobId, result, new Date(now));
  }

  private async markFailed(jobId: string, message: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || isTerminalStatus(job.status)) return;
    const now = Date.now();
    job.status = 'failed';
    job.updatedAt = now;
    job.finishedAt = now;
    job.progressText = '处理失败';
    job.error = message;
    await this.repository.markFailed(jobId, message, new Date(now));
  }

  /** 后台把 GPU 本机暂存 URL 拉回主站保存；失败只记录到任务结果，不覆盖已展示的放大图。 */
  private saveRemoteResultInBackground(jobId: string, userId: number, result: ImageUpscaleRunResponse, libraryImageUrl: string, isPrivate: boolean | undefined, sourceImageBuffer?: Buffer, sourceMimeType?: string): void {
    const job = this.jobs.get(jobId);
    if (job && !isTerminalStatus(job.status)) return;
    logger.info({ jobId, userId, url: result.image.url ? true : undefined }, '图片放大任务开始后台保存图库');
    void this.libraryService.saveResultFromUrl({
      userId,
      result,
      imageUrl: libraryImageUrl,
      mimeType: result.image.mimeType,
      sourceImageBuffer,
      sourceMimeType,
      isPrivate,
      traceId: jobId,
    }).then((savedTask) => {
      const current = this.jobs.get(jobId);
      if (!current?.result || current.status === 'cancelled') return;
      current.result.savedTask = savedTask;
      current.updatedAt = Date.now();
      void this.repository.updateSavedTask(jobId, current.result);
      logger.info({ jobId, taskId: savedTask.id }, '图片放大任务后台保存图库完成');
    }).catch((error) => {
      const current = this.jobs.get(jobId);
      if (current?.result && current.status !== 'cancelled') {
        current.error = `后台保存到我的图片失败：${readJobErrorMessage(error)}`;
        current.updatedAt = Date.now();
        void this.repository.markBackgroundSaveFailed(jobId, readJobErrorMessage(error));
      }
      logger.warn({ jobId, error: error instanceof Error ? error.message : String(error) }, '图片放大任务后台保存图库失败');
    });
  }

  /** 给后台异步任务增加整体硬超时，避免上游连接或保存阶段异常时任务永久 running。 */
  private withJobTimeout<T>(jobId: string, timeoutMs: number, abortController: AbortController, run: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new ImageUpscaleError('job_timeout', '图片放大任务处理超时，请稍后重试', 504));
      }, timeoutMs);
    });
    return Promise.race([run(), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** 队列释放或 GPU 返回后检查终态，避免用户取消后继续保存或覆盖状态。 */
  private async throwIfTerminal(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job && !isTerminalStatus(job.status)) return;
    const row = await this.repository.findForUser(job?.userId ?? 0, jobId);
    const status = row ? row.status : job?.status;
    if (!status || !isTerminalStatus(status as ImageUpscaleJobStatus)) return;
    if (status === 'cancelled') throw new ImageUpscaleError('job_cancelled', '图片放大任务已手动结束', 409);
    throw new ImageUpscaleError('job_terminal', '图片放大任务已经结束', 409);
  }

  private toView(job: ImageUpscaleJobRecord, includeResult = true): ImageUpscaleJobView {
    const now = Date.now();
    return {
      id: job.id,
      userId: job.userId,
      status: job.status,
      progress: computeProgress(job, now),
      progressText: job.progressText,
      sourceFileName: job.sourceFileName,
      sourceMimeType: job.sourceMimeType,
      sourceSizeBytes: job.sourceSizeBytes,
      sourceWidth: job.sourceWidth,
      sourceHeight: job.sourceHeight,
      sourceUrl: job.sourceUrl,
      previewUrl: job.previewUrl,
      scale: job.scale,
      model: job.model,
      outputFormat: job.outputFormat,
      saveToLibrary: job.saveToLibrary,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
      // 列表接口不携带大体积 base64 结果，详情接口按需返回，避免历史任务拖慢工具页。
      result: includeResult ? job.result : undefined,
      error: job.error,
    };
  }

  /** 等待启动恢复完成；恢复失败只记录日志，不阻断正常查询和新任务。 */
  private async ensureStartupRecovery(): Promise<void> {
    await this.recoveryPromise.catch(() => undefined);
  }

  /** 从数据库与私有源图恢复服务重启前未完成的图片放大任务。 */
  private async recoverInterruptedJobs(loadConfig: () => Promise<ImageUpscaleRuntimeConfig>, onSucceeded?: () => Promise<void> | void): Promise<void> {
    const baseConfig = await loadConfig();
    const recoveryCapacity = Math.min(MAX_RECOVERY_JOBS, baseConfig.maxConcurrency + baseConfig.queueMaxPending);
    const rows = await this.repository.listInterruptedJobs(Math.max(1, recoveryCapacity));
    if (rows.length === 0) return;
    let recovered = 0;
    for (const row of rows) {
      if (!row.sourceStoredName || !row.sourceMimeType) {
        await this.repository.markFailed(row.id, '该历史任务创建于源图持久化升级前，请重新提交图片放大。', new Date());
        continue;
      }
      const imageBuffer = await this.sourceStorage.read(row.sourceStoredName);
      if (!imageBuffer) {
        await this.repository.markFailed(row.id, '私有源图文件缺失，请重新提交图片放大。', new Date());
        continue;
      }
      const createdAt = row.createdAt.getTime();
      const job: ImageUpscaleJobRecord = {
        id: row.id,
        userId: row.userId,
        status: 'queued',
        progressText: '服务重启后已恢复，等待 GPU 队列',
        sourceFileName: row.sourceFileName,
        sourceMimeType: row.sourceMimeType,
        sourceSizeBytes: Number(row.sourceSizeBytes),
        sourceWidth: row.sourceWidth ?? undefined,
        sourceHeight: row.sourceHeight ?? undefined,
        sourceUrl: `/api/tools/image-upscale/jobs/${encodeURIComponent(row.id)}/source`,
        previewUrl: `/api/tools/image-upscale/jobs/${encodeURIComponent(row.id)}/source?preview=1`,
        scale: normalizeJobScale(row.scale, baseConfig.defaultScale),
        model: normalizeJobModel(row.model, baseConfig.model),
        outputFormat: normalizeJobOutputFormat(row.outputFormat, baseConfig.outputFormat),
        saveToLibrary: row.saveToLibrary,
        createdAt,
        updatedAt: Date.now(),
      };
      await this.repository.markQueued(row.id, job.progressText);
      this.jobs.set(row.id, job);
      const config: ImageUpscaleRuntimeConfig = {
        ...baseConfig,
        model: job.model,
        allowedModels: Array.from(new Set([job.model, ...baseConfig.allowedModels])),
      };
      this.enqueue(job, {
        userId: row.userId,
        sourceFileName: row.sourceFileName,
        sourceSizeBytes: Number(row.sourceSizeBytes),
        imageBuffer,
        mimeType: row.sourceMimeType,
        config,
        options: {
          scale: job.scale,
          model: job.model,
          outputFormat: job.outputFormat,
          saveToLibrary: row.saveToLibrary,
          isPrivate: row.isPrivate ?? undefined,
        },
        queue: {
          maxConcurrency: baseConfig.maxConcurrency,
          maxPending: baseConfig.queueMaxPending,
          maxWaitMs: baseConfig.queueMaxWaitMs,
        },
        onSucceeded,
      });
      recovered += 1;
    }
    if (recovered > 0) {
      logger.warn({ count: recovered }, '图片放大任务已从数据库和私有源图恢复');
    }
  }

  /** 持久化失败不能制造未处理 Promise；日志保留任务 ID 便于后续人工修复。 */
  private logPersistError(jobId: string, error: unknown, message: string): void {
    logger.warn({ jobId, error: error instanceof Error ? error.message : String(error) }, message);
  }
}

function computeProgress(job: ImageUpscaleJobRecord, now: number): number {
  if (isTerminalStatus(job.status)) return 100;
  if (job.status === 'queued') {
    const queuedSeconds = Math.max(0, (now - job.createdAt) / 1000);
    return Math.min(18, 6 + Math.floor(queuedSeconds / 3));
  }
  const startedAt = job.startedAt ?? now;
  const runningSeconds = Math.max(0, (now - startedAt) / 1000);
  return Math.min(94, 24 + Math.floor(runningSeconds * 1.8));
}

function isTerminalStatus(status: ImageUpscaleJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function normalizeJobScale(value: unknown, fallback: ImageUpscaleScale): ImageUpscaleScale {
  return value === 2 || value === 3 || value === 4 ? value : fallback;
}

function normalizeJobModel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeJobOutputFormat(_value: unknown, _fallback: ImageUpscaleOutputFormat): ImageUpscaleOutputFormat {
  // 任务展示和实际 GPU 调用保持一致：输出格式固定为 WebP，旧任务请求里的 PNG 不再生效。
  return 'webp';
}

function readJobErrorMessage(error: unknown): string {
  if (error instanceof ImageUpscaleQueueFullError || error instanceof ImageUpscaleQueueTimeoutError) return error.message;
  if (error instanceof ImageUpscaleError) return error.message;
  return error instanceof Error ? error.message : '图片放大失败';
}
