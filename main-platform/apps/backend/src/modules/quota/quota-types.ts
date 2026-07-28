/**
 * 本文件定义余额模块的错误类型和内部类型。
 */

/** 余额业务错误，路由层按 kind 映射为 HTTP 状态码。 */
export class QuotaError extends Error {
  constructor(
    /** 错误类别：insufficient_balance 余额不足，invalid_request 参数错误。 */
    public readonly kind: 'insufficient_balance' | 'invalid_request' | 'not_bound',
    message: string,
    /** 附加数据，如余额不足时的当前余额。 */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'QuotaError';
  }
}
