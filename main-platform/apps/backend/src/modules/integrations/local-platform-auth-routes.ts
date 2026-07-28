/**
 * 本文件提供主站到独立本地模型平台的身份交换端点，只输出最小身份摘要。
 */
import type { IncomingMessage } from 'node:http';
import { readStringEnv, sendJson, type Route } from '@aiimage/core-utils';
import { ApiErrorCode, type LocalPlatformIdentityExchangeResponse } from '@aiimage/shared-contracts';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { AuthService } from '../auth/auth-service.js';
import { verifyAccessToken } from '../auth/jwt.js';

const authService = new AuthService();

/** 注册独立平台身份集成路由。 */
export function createLocalPlatformAuthRoutes(): Route[] {
  return [{ method: 'POST', path: '/internal/integrations/local-model/auth/exchange', handle: exchangeIdentity }];
}

/** 同时校验服务凭证和用户登录态，再返回不含敏感字段的身份摘要。 */
async function exchangeIdentity(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const expectedServiceToken = process.env.LOCAL_PLATFORM_INTEGRATION_TOKEN?.trim();
  if (!expectedServiceToken) {
    return sendJson(res, 503, failure(ApiErrorCode.ServiceUnavailable, '本地模型平台身份集成尚未配置'));
  }
  if (readHeader(req.headers['x-local-platform-token']) !== expectedServiceToken) {
    return sendJson(res, 403, failure(ApiErrorCode.Forbidden, '本地模型平台服务凭证不正确'));
  }
  const token = readBearerToken(req.headers.authorization);
  if (!token) return sendJson(res, 401, failure(ApiErrorCode.Unauthorized, '请先登录'));

  try {
    const payload = verifyAccessToken(token);
    const user = await authService.currentUser(payload.sub);
    const response: LocalPlatformIdentityExchangeResponse = {
      ok: true,
      data: {
        issuer: process.env.MAIN_PLATFORM_ISSUER?.trim() || readStringEnv('MAIN_SITE_URL', 'https://www.xanime.ink'),
        subject: String(user.id),
        displayName: user.username,
        avatarUrl: user.avatarUrl || null,
        roles: [user.role],
        emailVerified: user.emailVerified,
        issuedAt: new Date().toISOString(),
      },
    };
    return sendJson(res, 200, response);
  } catch {
    return sendJson(res, 401, failure(ApiErrorCode.Unauthorized, '登录状态已失效'));
  }
}

/** 构造符合共享契约的失败响应。 */
function failure(code: ApiErrorCode, message: string): LocalPlatformIdentityExchangeResponse {
  return { ok: false, code, message };
}

/** 读取单值请求头。 */
function readHeader(value: string | string[] | undefined): string {
  return String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim();
}
