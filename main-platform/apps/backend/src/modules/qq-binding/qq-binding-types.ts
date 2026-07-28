/** 本文件定义 QQ 绑定模块内部类型；跨接口 DTO 必须从 shared-contracts 导入。 */

/** QQ 绑定状态枚举用于服务层分类业务错误，避免路由层解析任意错误字符串。 */
export type QqBindingErrorKind =
  | 'already_bound'
  | 'key_not_found'
  | 'qq_already_bound'
  | 'not_bound'
  | 'invalid_request'
  | 'internal_error';

/** QQ 绑定业务错误，路由层根据 kind 映射 HTTP 状态码和统一错误码。 */
export class QqBindingError extends Error {
  /** 创建 QQ 绑定错误，message 必须是可直接返回调用方的中文信息。 */
  constructor(
    readonly kind: QqBindingErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'QqBindingError';
  }
}
