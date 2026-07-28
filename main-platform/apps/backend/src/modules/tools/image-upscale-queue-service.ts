/** 本文件提供图片放大的进程内队列，限制并发请求以保护私有 GPU 服务。 */

type QueueEntry<T> = {
  /** 实际执行的异步任务。 */
  job: () => Promise<T>;
  /** 成功回调。 */
  resolve: (value: ImageUpscaleQueuedResult<T>) => void;
  /** 失败回调。 */
  reject: (error: unknown) => void;
  /** 入队时间，用于后续排障扩展。 */
  queuedAt: number;
  /** 等待超时计时器；任务开始执行或被移出队列时必须清理。 */
  timeout?: NodeJS.Timeout;
  /** 是否已经完成或超时，避免超时后的任务被再次执行。 */
  settled: boolean;
};

/** 图片放大队列参数。 */
export type ImageUpscaleQueueOptions = {
  /** 最大并发执行数。 */
  maxConcurrency: number;
  /** 最大等待队列长度。 */
  maxPending: number;
  /** 最大排队等待时间，单位毫秒；超过后直接返回 429。 */
  maxWaitMs: number;
};

/** 图片放大队列返回值，包含真实业务结果和排队等待耗时。 */
export type ImageUpscaleQueuedResult<T> = {
  /** 实际任务结果。 */
  result: T;
  /** 任务从入队到开始执行之间的等待耗时。 */
  waitMs: number;
};

/** 图片放大队列已满时抛出的业务错误。 */
export class ImageUpscaleQueueFullError extends Error {
  constructor(public readonly pending: number) {
    super('图片放大队列已满，请稍后再试');
    this.name = 'ImageUpscaleQueueFullError';
  }
}

/** 图片放大队列等待超时时抛出的业务错误。 */
export class ImageUpscaleQueueTimeoutError extends Error {
  constructor(public readonly maxWaitMs: number) {
    super('图片放大排队等待超时，请稍后再试');
    this.name = 'ImageUpscaleQueueTimeoutError';
  }
}

/** 简单 FIFO 队列；backend 多进程时每个进程独立限流，当前生产 backend 为单进程。 */
export class ImageUpscaleQueueService {
  private active = 0;
  private readonly queue: QueueEntry<unknown>[] = [];

  /** 入队执行任务；队列满时直接拒绝，避免请求无限堆积占满内存。 */
  run<T>(job: () => Promise<T>, options: ImageUpscaleQueueOptions): Promise<ImageUpscaleQueuedResult<T>> {
    const maxConcurrency = normalizePositiveInt(options.maxConcurrency, 1, 1, 8);
    const maxPending = normalizePositiveInt(options.maxPending, 8, 0, 200);
    const maxWaitMs = normalizePositiveInt(options.maxWaitMs, 30_000, 1_000, 600_000);
    if (this.active >= maxConcurrency && this.queue.length >= maxPending) {
      return Promise.reject(new ImageUpscaleQueueFullError(this.queue.length));
    }
    return new Promise<ImageUpscaleQueuedResult<T>>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        job,
        resolve,
        reject,
        queuedAt: Date.now(),
        settled: false,
      };
      entry.timeout = setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        this.removeEntry(entry as QueueEntry<unknown>);
        reject(new ImageUpscaleQueueTimeoutError(maxWaitMs));
      }, maxWaitMs);
      this.queue.push(entry as QueueEntry<unknown>);
      this.drain(maxConcurrency);
    });
  }

  /** 返回当前队列快照，供日志或未来健康接口使用。 */
  getSnapshot() {
    const now = Date.now();
    const oldest = this.queue.reduce((value, entry) => Math.max(value, now - entry.queuedAt), 0);
    return {
      active: this.active,
      pending: this.queue.length,
      oldestPendingMs: oldest,
    };
  }

  /** 按 FIFO 顺序释放任务，所有任务完成后继续调度下一项。 */
  private drain(maxConcurrency: number): void {
    while (this.active < maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.settled) continue;
      entry.settled = true;
      if (entry.timeout) clearTimeout(entry.timeout);
      const waitMs = Math.max(0, Date.now() - entry.queuedAt);
      this.active += 1;
      entry.job()
        .then((result) => entry.resolve({ result, waitMs }))
        .catch(entry.reject)
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.drain(maxConcurrency);
        });
    }
  }

  /** 从等待队列中移除指定任务；用于排队等待超时。 */
  private removeEntry(entry: QueueEntry<unknown>): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
  }
}

/** 读取正整数配置并限制范围，避免后台误填导致队列失控。 */
function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
