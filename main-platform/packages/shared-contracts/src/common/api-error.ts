/** 本文件定义全局错误码和失败响应，规范来源：standards/interfaces/common.md。 */

/** API 错误码必须跨服务统一，禁止各程序定义自己的错误码字符串。 */
export const ApiErrorCode = {
  NotFound: 'not_found',
  BadRequest: 'bad_request',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  Conflict: 'conflict',
  RateLimited: 'rate_limited',
  InsufficientBalance: 'insufficient_balance',
  InternalError: 'internal_error',
  ServiceUnavailable: 'service_unavailable',
} as const;

/** API 错误码联合类型用于响应体和业务错误映射。 */
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** API 失败响应必须返回中文 message，内部堆栈不得暴露给调用方。 */
export type ApiErrorResponse = {
  ok: false;
  code: ApiErrorCode;
  message: string;
  requestId?: string;
};
