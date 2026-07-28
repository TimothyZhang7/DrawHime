/** 本文件注册邀请奖励用户接口，所有写入都通过 ReferralService 和钱包事务完成。 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type ApplyReferralRequest, type ApiDataResponse, type ReferralMeResponse } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { invalidateWalletCache } from '../../shared/cache/cache-service.js';
import { checkRateLimit } from '../../shared/middleware/rate-limit.js';
import { ReferralError, ReferralService } from './referral-service.js';

const referralService = new ReferralService();

/** 创建邀请奖励路由表；接口只面向已登录 Web 用户。 */
export function createReferralRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/referrals/me', handle: getMyReferral },
    { method: 'POST', path: '/api/referrals/apply', handle: applyReferral },
  ];
}

/** 查询当前用户的邀请码、邀请链接和奖励状态。 */
async function getMyReferral(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const data = await referralService.getMyReferralInfo(userId);
  return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<ReferralMeResponse>);
}

/** 使用邀请码；已验证邮箱用户会立即发奖，未验证用户等待邮箱验证事务触发。 */
async function applyReferral(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!(await checkRateLimit(req, res, 'redeem'))) return;
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const body = await readJsonBody<ApplyReferralRequest>(req);
  try {
    const result = await referralService.applyReferralCode(userId, body.code, 'recharge');
    if (result.rewarded) invalidateWalletCache([`user:${userId}`]);
    return sendJson(res, 200, { ok: true, data: result });
  } catch (error) {
    return sendReferralError(res, error);
  }
}

/** 校验用户 JWT，失败时稳定返回未登录，不抛内部异常。 */
function authenticateUser(req: IncomingMessage) {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    return verifyAccessToken(token).sub;
  } catch {
    return undefined;
  }
}

function sendReferralError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof ReferralError) {
    const status = error.kind === 'not_found' ? 404
      : error.kind === 'conflict' ? 409
      : error.kind === 'disabled' ? 403
      : 400;
    return sendJson(res, status, { ok: false, code: ApiErrorCode.BadRequest, message: error.message });
  }
  throw error;
}
