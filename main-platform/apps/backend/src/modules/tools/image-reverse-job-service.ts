/** 本文件管理图片反推持久化任务：源图先落私有存储，状态和结果写入数据库，刷新与服务重启后均可恢复。 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { ImageReverseExtractOptions, ImageReverseJobView } from '@aiimage/shared-contracts';
import { logger } from '../../shared/logger.js';
import { ImageReverseJobRepository } from './image-reverse-job-repository.js';
import { ImageReverseSourceStorage } from './image-reverse-source-storage.js';
import { ImageReverseError, ImageReverseService, type ImageReverseRuntimeConfig } from './image-reverse-service.js';

const MAX_CONCURRENCY = 4;
const MAX_PENDING = 16;
const MAX_ACTIVE_PER_USER = 2;
const MAX_HISTORY_PER_USER = 50;
const MAX_RECOVERY_JOBS = MAX_CONCURRENCY + MAX_PENDING;

/** 图片反推异步任务提交参数。 */
export interface ImageReverseJobSubmitInput {
  /** 当前登录用户 ID。 */
  userId: number;
  /** 上传图片二进制，源图落盘后队列处理期间继续复用。 */
  imageBuffer: Buffer;
  /** 上传请求声明的 MIME 类型。 */
  mimeType: string;
  /** 上传时的原始文件名，仅用于历史展示。 */
  sourceFileName: string;
  /** 后台反推运行时配置。 */
  config: ImageReverseRuntimeConfig;
  /** 本次结构化反推选项。 */
  options: ImageReverseExtractOptions;
  /** 成功完成后的真实工具计数回调。 */
  onSucceeded?: () => Promise<void> | void;
}

interface PendingImageReverseJob {
  jobId: string;
  input: Omit<ImageReverseJobSubmitInput, 'sourceFileName'>;
}

/** 图片反推队列已满或当前用户同时提交过多时抛出的业务错误。 */
export class ImageReverseJobQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageReverseJobQueueError';
  }
}

/** 图片反推持久化任务服务。 */
export class ImageReverseJobService {
  private readonly pending: PendingImageReverseJob[] = [];
  private active = 0;
  private recoveryPromise: Promise<void> = Promise.resolve();
  private recoveryStarted = false;

  constructor(
    private readonly reverseService: ImageReverseService,
    private readonly repository: ImageReverseJobRepository = new ImageReverseJobRepository(),
    private readonly sourceStorage: ImageReverseSourceStorage = new ImageReverseSourceStorage(),
  ) {}

  /** 服务启动时恢复旧进程遗留的排队和运行任务；源图与选项均从持久化记录读取。 */
  startRecovery(loadConfig: () => Promise<ImageReverseRuntimeConfig>, onSucceeded?: () => Promise<void> | void): void {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    this.recoveryPromise = this.recoverInterruptedJobs(loadConfig, onSucceeded).catch((error) => {
      this.recoveryStarted = false;
      logger.warn({ error: readJobErrorMessage(error) }, '图片反推任务启动恢复失败');
    });
  }

  /** 提交任务：源图和数据库记录均成功后才进入真实识图队列。 */
  async submit(input: ImageReverseJobSubmitInput): Promise<ImageReverseJobView> {
    await this.recoveryPromise;
    if (await this.repository.countActiveForUser(input.userId) >= MAX_ACTIVE_PER_USER) {
      throw new ImageReverseJobQueueError('你已有图片反推任务正在处理，请等待完成后再提交');
    }
    if (this.pending.length >= MAX_PENDING) throw new ImageReverseJobQueueError('图片反推队列繁忙，请稍后重试');

    const now = new Date();
    const jobId = `rev_${now.getTime().toString(36)}_${randomUUID().slice(0, 8)}`;
    const stored = await this.sourceStorage.save(input.userId, input.imageBuffer, input.mimeType);
    let row;
    try {
      row = await this.repository.create({
        id: jobId,
        userId: input.userId,
        mode: input.options.mode,
        model: input.config.model,
        options: input.options,
        sourceFileName: sanitizeSourceFileName(input.sourceFileName),
        sourceStoredName: stored.sourceStoredName,
        previewStoredName: stored.previewStoredName,
        sourceMimeType: stored.mimeType,
        sourceSizeBytes: stored.sizeBytes,
        sourceWidth: stored.width,
        sourceHeight: stored.height,
        createdAt: now,
      });
    } catch (error) {
      // 数据库写入失败必须回滚刚落盘的私有文件，避免产生无法归属的孤儿源图。
      await this.sourceStorage.remove(stored.sourceStoredName, stored.previewStoredName);
      throw error;
    }

    this.pending.push({
      jobId,
      input: {
        userId: input.userId,
        imageBuffer: input.imageBuffer,
        mimeType: stored.mimeType,
        config: input.config,
        options: input.options,
        onSucceeded: input.onSucceeded,
      },
    });
    queueMicrotask(() => this.drain());
    return this.repository.toView(row);
  }

  /** 查询当前用户自己的任务详情，成功任务包含完整结构化结果。 */
  async getJob(userId: number, jobId: string): Promise<ImageReverseJobView | null> {
    await this.recoveryPromise;
    const row = await this.repository.findForUser(userId, jobId);
    return row ? this.repository.toView(row) : null;
  }

  /** 列出当前用户近期任务，列表只返回摘要和元数据。 */
  async listJobs(userId: number): Promise<ImageReverseJobView[]> {
    await this.recoveryPromise;
    const rows = await this.repository.listForUser(userId, MAX_HISTORY_PER_USER, false);
    return rows.map((row) => this.repository.toView(row, false));
  }

  /** 鉴权输出当前用户历史任务的私有源图或列表预览。 */
  async serveSource(userId: number, jobId: string, preview: boolean, res: ServerResponse): Promise<boolean> {
    const row = await this.repository.findForUser(userId, jobId);
    if (!row) return false;
    return this.sourceStorage.serve(preview ? row.previewStoredName : row.sourceStoredName, row.sourceMimeType, preview, res);
  }

  /** 在固定并发额度内启动排队任务。 */
  private drain(): void {
    while (this.active < MAX_CONCURRENCY && this.pending.length > 0) {
      const pendingJob = this.pending.shift();
      if (!pendingJob) return;
      this.active += 1;
      void this.run(pendingJob.jobId, pendingJob.input).finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.drain();
      });
    }
  }

  /** 执行真实识图，并把每个阶段和最终结果写入数据库。 */
  private async run(jobId: string, input: PendingImageReverseJob['input']): Promise<void> {
    const startedAt = new Date();
    await this.repository.markRunning(jobId, startedAt);
    logger.info({ jobId, userId: input.userId, mode: input.options.mode }, '图片反推持久化任务开始');
    try {
      const result = await this.reverseService.extract(input.imageBuffer, input.mimeType, input.config, input.options);
      const finishedAt = new Date();
      await this.repository.markSucceeded(jobId, result, finishedAt);
      await input.onSucceeded?.();
      logger.info({ jobId, userId: input.userId, elapsedMs: finishedAt.getTime() - startedAt.getTime() }, '图片反推持久化任务完成');
    } catch (error) {
      const message = readJobErrorMessage(error);
      await this.repository.markFailed(jobId, message, new Date()).catch((persistError) => {
        logger.error({ jobId, error: readJobErrorMessage(persistError) }, '图片反推失败状态持久化失败');
      });
      logger.warn({ jobId, userId: input.userId, error: message }, '图片反推持久化任务失败');
    }
  }

  /** 从数据库和私有源图恢复服务重启前未完成的任务。 */
  private async recoverInterruptedJobs(loadConfig: () => Promise<ImageReverseRuntimeConfig>, onSucceeded?: () => Promise<void> | void): Promise<void> {
    const rows = await this.repository.listInterruptedJobs(MAX_RECOVERY_JOBS);
    if (rows.length === 0) return;
    const baseConfig = await loadConfig();
    let recovered = 0;
    for (const row of rows) {
      const imageBuffer = await this.sourceStorage.read(row.sourceStoredName);
      if (!imageBuffer) {
        await this.repository.markFailed(row.id, '私有源图文件缺失，请重新提交图片反推。', new Date());
        continue;
      }
      const view = this.repository.toView(row, false);
      await this.repository.markQueued(row.id, '服务重启后已恢复，等待识图处理');
      this.pending.push({
        jobId: row.id,
        input: {
          userId: row.userId,
          imageBuffer,
          mimeType: row.sourceMimeType,
          config: { ...baseConfig, model: row.model || baseConfig.model },
          options: view.options,
          onSucceeded,
        },
      });
      recovered += 1;
    }
    if (recovered > 0) {
      logger.warn({ count: recovered }, '图片反推任务已从数据库和私有源图恢复');
      queueMicrotask(() => this.drain());
    }
  }
}

function sanitizeSourceFileName(value: string): string {
  return String(value || 'image')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 200) || 'image';
}

function readJobErrorMessage(error: unknown): string {
  if (error instanceof ImageReverseError) return error.message;
  return error instanceof Error ? error.message : '图片反推失败';
}
