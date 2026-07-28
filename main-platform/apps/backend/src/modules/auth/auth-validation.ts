/** 本文件负责认证接口请求体校验，类型来源于/standards/interfaces/auth.md。 */

import type { LoginRequest, RegisterRequest } from '@aiimage/shared-contracts';

/** 校验注册请求，返回中文错误说明；undefined 表示请求体符合当前认证规范。 */
export function validateRegisterRequest(body: RegisterRequest): string | undefined {
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/.test(body.username || '')) return '用户名格式不正确';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email || '')) return '邮箱格式不正确';
  if (typeof body.password !== 'string' || body.password.length < 8) return '密码至少 8 位';
  if (body.inviteCode && !/^[A-Za-z0-9]{4,16}$/.test(body.inviteCode.trim())) return '邀请码格式不正确';
  return undefined;
}

/** 校验登录请求，避免空账号或空密码进入认证服务。 */
export function validateLoginRequest(body: LoginRequest): string | undefined {
  if (typeof body.account !== 'string' || body.account.trim().length === 0) return '请输入账号';
  if (typeof body.password !== 'string' || body.password.length === 0) return '请输入密码';
  return undefined;
}
