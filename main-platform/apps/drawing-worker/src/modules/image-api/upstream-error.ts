/**
 * 本文件定义上游图片 API 的统一错误类型。
 * Worker 通过该类型区分用户可见错误、管理排障原始错误和重试策略。
 */

/** 上游 API 错误信息，已做脱敏处理，rawError 供管理排障。 */
export type UpstreamApiError = {
  /** 面向用户的中文错误。 */
  userMessage: string;
  /** 脱敏后的原始错误，仅管理台可查看。 */
  rawError: string;
  /** 是否可重试。 */
  retryable: boolean;
  /** HTTP 状态码（如有）。 */
  statusCode?: number;
  /** 上游 Retry-After 建议等待毫秒数（如有）。 */
  retryAfterMs?: number;
};

/** 上游 API 调用错误，区分面向用户消息和管理排障信息。 */
export class UpstreamApiCallError extends Error {
  constructor(
    /** 面向用户的中文错误消息。 */
    message: string,
    /** 脱敏后的原始错误，仅管理排障使用。 */
    public readonly rawError: string,
    /** 是否可重试。 */
    public readonly retryable: boolean,
    /** HTTP 状态码。 */
    public readonly statusCode?: number,
    /** 上游 Retry-After 建议等待毫秒数。 */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'UpstreamApiCallError';
  }
}
