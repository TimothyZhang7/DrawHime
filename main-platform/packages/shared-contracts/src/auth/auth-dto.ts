import type { ApiEndpointContract } from '../common/api-contract.js';
import type { AuthSession, AuthUser } from './auth-context.js';

/** 本文件定义认证 HTTP 接口 DTO，规范来源：standards/interfaces/auth.md。 */

/** 注册请求体由公开注册接口接收，字段规则由 backend 的验证层执行。 */
export type RegisterRequest = {
  username: string;
  email: string;
  password: string;
  /** 可选邀请码；服务端会在注册事务里绑定邀请关系，邮箱验证后才发放奖励。 */
  inviteCode?: string;
};

/** 登录请求体允许用户名或邮箱作为账号。 */
export type LoginRequest = {
  account: string;
  password: string;
};

/** 已登录用户绑定新邮箱请求；仅用于未验证或未绑定邮箱的账号。 */
export type BindEmailRequest = {
  email: string;
};

/** 注册和登录成功响应保持与认证规范一致，直接返回用户和 token。 */
export type AuthSessionResponse = {
  ok: true;
  user: AuthUser;
  token: string;
};

/** 当前用户接口响应只返回当前登录用户，不返回 token。使用 data 字段符合 标准 API 响应格式。 */
export type CurrentUserResponse = {
  ok: true;
  data: AuthUser;
};

/** 邮箱绑定或解绑成功后返回最新当前用户，便于前端立即刷新状态。 */
export type AuthEmailUpdateResponse = {
  ok: true;
  data: AuthUser;
  message: string;
};

/** 注册端点契约把请求和响应固定在规范内，避免后续重新发明注册 DTO。 */
export type AuthRegisterEndpoint = ApiEndpointContract<RegisterRequest, AuthSessionResponse>;

/** 登录端点契约把请求和响应固定在规范内，避免后续重新发明登录 DTO。 */
export type AuthLoginEndpoint = ApiEndpointContract<LoginRequest, AuthSessionResponse>;

/** 当前用户端点没有请求体，使用 undefined 明确禁止伪造请求字段。 */
export type AuthMeEndpoint = ApiEndpointContract<undefined, CurrentUserResponse>;

/** 绑定邮箱端点；后端会发送新的验证邮件。 */
export type AuthBindEmailEndpoint = ApiEndpointContract<BindEmailRequest, AuthEmailUpdateResponse>;

/** 解绑未验证邮箱端点；后端只允许未验证邮箱执行。 */
export type AuthUnbindEmailEndpoint = ApiEndpointContract<undefined, AuthEmailUpdateResponse>;

/** 认证服务内部返回领域会话对象，HTTP ok 包裹由路由层负责。 */
export type AuthServiceSession = AuthSession;
