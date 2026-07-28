/** 本文件定义生成任务模块内部错误类型，不作为跨接口 DTO 暴露。 */

/** 生成任务错误类型，用于路由层映射 HTTP 状态码。 */
export type GenerationErrorKind =
  | 'invalid_request'
  | 'not_bound'
  | 'not_found'
  | 'forbidden'
  | 'drawing_service_unavailable'
  | 'cooldown'
  | 'blocked';

/** 生成任务业务错误，message 必须是可返回给用户的中文短文本。 */
export class GenerationError extends Error {
  /** 保存错误分类，路由层据此映射统一错误码。 */
  constructor(readonly kind: GenerationErrorKind, message: string) {
    super(message);
  }
}
