/** 本文件定义认证上下文和会话对象，规范来源：standards/interfaces/auth.md。 */

/** 用户角色只允许普通用户和管理员，权限判断不得使用其他字符串。 */
export type UserRole = 'user' | 'admin';

/** 认证用户对象是登录、当前用户和前端会话共享的唯一用户类型。 */
export type AuthUser = {
  id: number;
  username: string;
  email: string;
  /** 当前账号是否绑定真实邮箱；未验证邮箱解绑后为 false，email 对外返回空字符串。 */
  emailBound: boolean;
  role: UserRole;
  emailVerified: boolean;
  qqNumber?: string;
  /** Web 用户自定义头像地址；为空时前端使用用户名首字母默认头像，不能回退到 QQ 头像。 */
  avatarUrl?: string | null;
};

/** 认证会话包含用户对象和后续请求使用的 JWT。 */
export type AuthSession = {
  user: AuthUser;
  token: string;
};
