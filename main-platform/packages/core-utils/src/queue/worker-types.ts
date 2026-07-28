/** 本文件定义 Worker 任务队列的基础类型，所有 Worker 程序必须遵守。 */

/** Worker 任务状态枚举，生命周期为 queued → running → success/failed → dead。 */
export type WorkerTaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'dead';

/** Worker 任务记录，存储于 worker_tasks 表或 Redis 队列。 */
export type WorkerTask<T = unknown> = {
  /** 任务唯一 ID，由生产者生成。 */
  id: string;
  /** 任务类型标识，按 domain:action 命名。 */
  type: string;
  /** 幂等键，同键重复投递不重复执行。 */
  idempotencyKey: string;
  /** 任务载荷，由调用方按任务类型传入。 */
  payload: T;
  /** 当前状态。 */
  status: WorkerTaskStatus;
  /** 已尝试次数，从 0 开始。 */
  attempt: number;
  /** 最大尝试次数，超过后进入死信。 */
  maxAttempts: number;
  /** 最后一次错误消息。 */
  lastError?: string;
  /** 下次重试时间，null 表示不重试。 */
  nextRetryAt?: string;
  /** 创建时间。 */
  createdAt: string;
  /** 最近一次开始执行时间。 */
  startedAt?: string;
  /** 最近一次结束时间。 */
  finishedAt?: string;
};

/** Worker 任务执行函数签名，接收任务并返回是否成功。 */
export type WorkerTaskHandler<T = unknown> = (task: WorkerTask<T>, signal?: AbortSignal) => Promise<void>;

/** 重试策略配置，所有 Worker 必须按退避公式计算延迟。 */
export type RetryPolicy = {
  /** 最大尝试次数。 */
  maxAttempts: number;
  /** 基础延迟毫秒。 */
  baseDelayMs: number;
  /** 最大延迟毫秒。 */
  maxDelayMs: number;
  /** 退避乘数。 */
  backoffMultiplier: number;
};

/** 默认重试策略，适用于大多数 Worker 任务。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
};

/** 计算指数退避延迟，带随机抖动避免惊群效应。 */
export function calcRetryDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exponential = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt);
  const jitter = Math.floor(Math.random() * 1000);
  return Math.min(exponential + jitter, policy.maxDelayMs);
}

/** Worker 健康状态摘要，通过 /health 接口暴露。 */
export type WorkerHealth = {
  /** 已处理任务数。 */
  processed: number;
  /** 成功数。 */
  succeeded: number;
  /** 失败数。 */
  failed: number;
  /** 死信数。 */
  dead: number;
  /** 当前进行中任务数。 */
  inProgress: number;
};
