/** 本文件定义 Web 用户个人资料接口契约，覆盖资料读取和用户名修改响应。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';
import type { AuthUser, UserRole } from '../auth/auth-context.js';

/** 当前登录用户资料页展示的数据；只返回本人资料，不用于公开主页。 */
export type UserProfileView = {
  /** Web 用户数字 ID。 */
  id: number;
  /** 当前用户名，也是站内公开展示昵称。 */
  username: string;
  /** 当前绑定邮箱；未绑定时为空字符串。 */
  email: string;
  /** 当前用户角色。 */
  role: UserRole;
  /** 真实邮箱是否已验证。 */
  emailVerified: boolean;
  /** Web 端默认图片是否私密。 */
  defaultImagePrivate: boolean;
  /** Web 自定义头像 URL；为空时前端按兜底规则展示。 */
  avatarUrl: string | null;
  /** 已验证绑定的 QQ 号；未绑定时为 null。 */
  qqNumber: string | null;
  /** 账号创建时间，ISO 字符串。 */
  createdAt: string;
};

/** 修改用户名请求；用户名规则由 backend 与注册校验保持一致。 */
export type UpdateUserProfileRequest = {
  /** 新用户名，2-32 位中英文、数字或下划线。 */
  username: string;
};

/** 当前登录用户资料响应。 */
export type UserProfileResponse = ApiDataResponse<UserProfileView>;

/** 用户名修改成功后返回最新认证用户，便于前端立即刷新全局登录态。 */
export type UpdateUserProfileResponse = ApiDataResponse<AuthUser> & {
  message: string;
};

/** 当前登录用户资料端点契约。 */
export type GetUserProfileEndpoint = ApiEndpointContract<undefined, UserProfileResponse>;

/** 修改当前登录用户资料端点契约。 */
export type UpdateUserProfileEndpoint = ApiEndpointContract<UpdateUserProfileRequest, UpdateUserProfileResponse>;
