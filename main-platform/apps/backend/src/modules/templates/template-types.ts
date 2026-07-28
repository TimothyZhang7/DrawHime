/**
 * 本文件定义模板模块的共享类型和错误类。
 */
import type { TemplateFavoriteResponse, TemplateListResponse, TemplateView } from '@aiimage/shared-contracts';

/** 模板业务错误，路由层按 kind 映射为 HTTP 状态码。 */
export class TemplateError extends Error {
  constructor(
    public readonly kind: 'not_found' | 'forbidden' | 'invalid_request' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** 模板视图类型，统一从共享契约导出给模板服务使用。 */
export type { TemplateView };
/** 模板列表响应类型，统一从共享契约导出给模板服务使用。 */
export type { TemplateListResponse };
/** 模板收藏响应类型，统一从共享契约导出给模板服务使用。 */
export type { TemplateFavoriteResponse };
