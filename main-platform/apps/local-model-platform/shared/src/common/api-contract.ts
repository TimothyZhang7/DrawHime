/**
 * 本文件定义 API 端点契约的纯类型骨架，规范来源：standards/interfaces/README.md。
 */

/** HTTP 方法枚举用于登记接口契约，避免业务代码用随意字符串伪造端点。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** API 鉴权等级用于让每个端点明确公开、用户、管理员或服务间调用边界。 */
export type ApiAuthLevel = 'public' | 'user' | 'admin' | 'service';

/** API 端点契约把请求体、响应体、路径和鉴权等级绑定在一起。 */
export type ApiEndpointContract<TRequest, TResponse> = {
  method: HttpMethod;
  path: string;
  auth: ApiAuthLevel;
  request: TRequest;
  response: TResponse;
};
