/** 本文件注册认证 HTTP 路由：注册、登录、当前用户、邮箱验证、密码重置。 */
import type { IncomingMessage } from 'node:http';
import type { Route } from '@aiimage/core-utils';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { sendJson } from '@aiimage/core-utils';
import type { AuthSessionResponse, CurrentUserResponse, LoginRequest, RegisterRequest } from '@aiimage/shared-contracts';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { AuthEmailError, AuthService } from './auth-service.js';
import { validateLoginRequest, validateRegisterRequest } from './auth-validation.js';
import { verifyAccessToken, type AccessTokenPayload } from './jwt.js';
import { EmailVerificationService, VerificationError } from './email-verification-service.js';
import { checkRateLimit } from '../../shared/middleware/rate-limit.js';
import { invalidateUserCache, invalidateWalletCache, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheCurrentUser } from '../../shared/cache/cache-policies.js';
import { ReferralError } from '../referral/referral-service.js';

const authService = new AuthService();
const verificationService = new EmailVerificationService();

/** 创建认证路由表，路由层只做解析、校验和响应包装。 */
export function createAuthRoutes(): Route[] {
  return [
    { method: 'POST', path: '/auth/register', handle: register },
    { method: 'POST', path: '/auth/login', handle: login },
    { method: 'GET', path: '/auth/me', handle: currentUser },
    { method: 'POST', path: '/auth/verify-email', handle: verifyEmail },
    { method: 'POST', path: '/auth/resend-verification', handle: resendVerification },
    { method: 'POST', path: '/auth/resend-verification-email', handle: resendVerificationByEmail },
    { method: 'POST', path: '/auth/bind-email', handle: bindEmail },
    { method: 'DELETE', path: '/auth/email', handle: unbindEmail },
    { method: 'POST', path: '/auth/forgot-password', handle: forgotPassword },
    { method: 'POST', path: '/auth/reset-password', handle: resetPassword },
    { method: 'POST', path: '/auth/change-password', handle: changePassword },
  ];
}

async function register(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  // 注册限流
  if (!(await checkRateLimit(req, res, 'register'))) return;
  // 检查注册开关
  const prisma = getPrismaClient();
  const regConfig = await prisma.systemConfig.findUnique({ where: { key: 'enable_registration' } });
  if (regConfig && regConfig.value === 'false') {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '注册功能已关闭' });
  }

  const body = await readJsonBody<RegisterRequest>(req);
  const error = validateRegisterRequest(body);
  if (error) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error });
  try {
    const result = await authService.register(body);
    // 异步发送验证邮件，不阻塞注册响应
    try {
      const token = await verificationService.createVerificationToken(result.user.id);
      await verificationService.notifyVerificationEmail(result.user.email, token);
    } catch (error) {
      console.error('[backend] [AUTH] 注册后发送验证邮件失败:', error instanceof Error ? error.message : String(error));
    }
    const response: AuthSessionResponse = { ok: true, ...result };
    return sendJson(res, 201, response);
  } catch (err) {
    if (err instanceof ReferralError) {
      const status = err.kind === 'conflict' ? 409 : err.kind === 'disabled' ? 403 : 400;
      return sendJson(res, status, { ok: false, code: ApiErrorCode.BadRequest, message: err.message });
    }
    return sendJson(res, 409, { ok: false, code: ApiErrorCode.Conflict, message: err instanceof Error ? err.message : '注册失败' });
  }
}

async function login(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!(await checkRateLimit(req, res, 'login'))) return;
  const body = await readJsonBody<LoginRequest>(req);
  const error = validateLoginRequest(body);
  if (error) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error });
  try {
    const result = await authService.login(body);
    const response: AuthSessionResponse = { ok: true, ...result };
    return sendJson(res, 200, response);
  } catch {
    // 登录失败返回统一错误（不区分账号不存在和密码错误）
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '账号或密码错误' });
  }
}

async function currentUser(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  // 当前用户接口会被前端轮询；无效或过期 token 必须稳定返回 401，不能抛出 500 污染生产日志。
  const payload = authenticateUser(req);
  if (!payload) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const cached = await cacheCurrentUser(payload.sub, () => authService.currentUser(payload.sub));
  setBackendCacheHeader(res, cached.status);
  const user = cached.value;
  const response = { ok: true, data: user };
  return sendJson(res, 200, response);
}

/** 验证邮箱 token。 */
async function verifyEmail(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const body = await readJsonBody<{ token?: string }>(req);
  if (!body.token) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少验证 token' });
  const result = await verificationService.verifyEmail(body.token);
  if (!result) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '验证链接无效或已过期' });
  // 邀请奖励会写 Web 钱包付费余额，验证成功后清理钱包缓存，避免充值页短时间展示旧余额。
  invalidateWalletCache();
  // 邮箱验证会改变 /auth/me、个人资料和充值页邮箱状态，必须同步失效用户缓存。
  const { userId, ...publicResult } = result;
  invalidateUserCache(userId);
  return sendJson(res, 200, { ok: true, message: publicResult.message, data: publicResult });
}

/** 已登录用户重发验证邮件。 */
async function resendVerification(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!(await checkRateLimit(req, res, 'resendVerify'))) return;
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  try {
    const { token, email } = await verificationService.resendVerification(user.sub);
    await verificationService.notifyVerificationEmail(email, token);
    return sendJson(res, 200, { ok: true, message: '验证邮件已重新发送' });
  } catch (error) {
    if (error instanceof VerificationError) {
      return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error.message });
    }
    throw error;
  }
}

/** 未登录用户按邮箱重发验证邮件（防枚举：无论邮箱是否存在都返回相同提示）。 */
async function resendVerificationByEmail(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!(await checkRateLimit(req, res, 'resendVerifyEmail'))) return;
  const body = await readJsonBody<{ email?: string }>(req);
  const email = body.email?.trim().toLowerCase();
  if (!email) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请输入邮箱' });

  const prisma = getPrismaClient();
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, emailVerified: true } });

  // 防枚举：无论用户是否存在都返回相同提示
  if (user && !user.emailVerified) {
    try {
      const token = await verificationService.createVerificationToken(user.id);
      await verificationService.notifyVerificationEmail(user.email, token);
    } catch { /* 邮件发送失败不暴露 */ }
  }
  return sendJson(res, 200, { ok: true, message: '如果该邮箱已注册且未验证，验证邮件已发送' });
}

/** 已登录用户绑定或更正未验证邮箱，并发送新的验证邮件。 */
async function bindEmail(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!(await checkRateLimit(req, res, 'resendVerify'))) return;
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const body = await readJsonBody<{ email?: string }>(req);
  const email = body.email?.trim().toLowerCase() ?? '';
  try {
    const nextUser = await authService.bindEmail(user.sub, email);
    invalidateUserCache(user.sub);
    try {
      const token = await verificationService.createVerificationToken(user.sub);
      await verificationService.notifyVerificationEmail(nextUser.email, token);
    } catch (error) {
      console.error('[backend] [AUTH] 绑定邮箱后发送验证邮件失败:', error instanceof Error ? error.message : String(error));
    }
    return sendJson(res, 200, { ok: true, data: nextUser, message: '邮箱已绑定，验证邮件已发送' });
  } catch (error) {
    return sendAuthEmailError(res, error);
  }
}

/** 已登录用户解绑未验证邮箱；已验证邮箱不可直接解绑，避免破坏账号恢复和安全边界。 */
async function unbindEmail(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  try {
    const nextUser = await authService.unbindUnverifiedEmail(user.sub);
    invalidateUserCache(user.sub);
    return sendJson(res, 200, { ok: true, data: nextUser, message: '未验证邮箱已解绑' });
  } catch (error) {
    return sendAuthEmailError(res, error);
  }
}

/** 忘记密码（防用户枚举：无论邮箱是否存在返回相同提示）。 */
async function forgotPassword(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  // 忘记密码限流（防邮件轰炸）
  if (!(await checkRateLimit(req, res, 'forgotPwd'))) return;
  const body = await readJsonBody<{ email?: string }>(req);
  const email = body.email?.trim().toLowerCase();
  if (!email) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请输入邮箱' });
  const result = await verificationService.createPasswordResetToken(email);
  if (result) {
    await verificationService.notifyPasswordResetEmail(email, result.token);
  }
  // 无论邮箱是否存在都返回相同提示
  return sendJson(res, 200, { ok: true, message: '如果该邮箱已注册，重置邮件已发送' });
}

/** 重置密码。 */
async function resetPassword(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const body = await readJsonBody<{ token?: string; newPassword?: string }>(req);
  if (!body.token || !body.newPassword || String(body.newPassword).length < 8) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '参数不正确（需要 token 和至少 8 位新密码）' });
  }
  const ok = await verificationService.resetPassword(body.token, String(body.newPassword));
  if (!ok) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '重置链接无效或已过期' });
  return sendJson(res, 200, { ok: true, message: '密码已重置' });
}

/** 已登录用户修改密码。 */
async function changePassword(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const body = await readJsonBody<{ oldPassword?: string; newPassword?: string }>(req);
  if (!body.oldPassword || !body.newPassword || String(body.newPassword).length < 8) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '参数不正确' });
  }
  try {
    await authService.changePassword(user.sub, String(body.oldPassword), String(body.newPassword));
    return sendJson(res, 200, { ok: true, message: '密码已修改' });
  } catch (error) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error instanceof Error ? error.message : '修改密码失败' });
  }
}

function authenticateUser(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token); } catch { return undefined; }
}

function sendAuthEmailError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof AuthEmailError) {
    const status = error.kind === 'email_conflict' ? 409 : error.kind === 'not_found' ? 404 : 400;
    const code = error.kind === 'email_conflict' ? ApiErrorCode.Conflict
      : error.kind === 'not_found' ? ApiErrorCode.NotFound
      : ApiErrorCode.BadRequest;
    return sendJson(res, status, { ok: false, code, message: error.message });
  }
  return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: '邮箱操作失败' });
}
