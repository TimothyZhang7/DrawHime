/** 本文件注册 backend 的 wsproxy 用户端点和内部服务间登记路由。 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type ApiDataResponse } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { WsproxyAdminService } from './wsproxy-admin-service.js';
import { validateClaimEndpointRequest, validateMarkBotSeenRequest } from './wsproxy-admin-validation.js';

const wsproxyAdminService = new WsproxyAdminService();

/** 创建 wsproxy 管理路由，用户接口使用 JWT，内部接口使用服务间 token。 */
export function createWsproxyAdminRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/wsproxy/create-endpoint',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const data = await wsproxyAdminService.createEndpoint(userId);
        return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
      },
    },
    {
      method: 'GET',
      path: '/wsproxy/my-endpoint',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const data = await wsproxyAdminService.getMyEndpoint(userId);
        return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
      },
    },
    {
      method: 'POST',
      path: '/internal/wsproxy/claim-endpoint',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody<unknown>(req);
        if (!validateClaimEndpointRequest(body)) {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'wsproxy 端点校验请求格式不正确' });
        }
        try {
          const data = await wsproxyAdminService.claimEndpoint(body.pathSuffix, body.accessToken);
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          // token 或过期错误统一按 forbidden 返回，避免向协议端泄露端点存在性细节。
          const message = error instanceof Error ? error.message : 'wsproxy 端点不可用';
          const code = message.includes('不存在') ? ApiErrorCode.NotFound : ApiErrorCode.Forbidden;
          return sendJson(res, code === ApiErrorCode.NotFound ? 404 : 403, { ok: false, code, message });
        }
      },
    },
    {
      method: 'POST',
      path: '/internal/wsproxy/mark-bot-seen',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody<unknown>(req);
        if (!validateMarkBotSeenRequest(body)) {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'Bot 活跃登记请求格式不正确' });
        }
        try {
          const nickname = typeof body.nickname === 'string' ? body.nickname : undefined;
          const data = await wsproxyAdminService.markBotSeen(body.pathSuffix, body.selfId, nickname);
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Bot 活跃登记失败';
          const code = message.includes('其他 Bot') ? ApiErrorCode.Conflict : ApiErrorCode.InternalError;
          return sendJson(res, code === ApiErrorCode.Conflict ? 409 : 500, { ok: false, code, message });
        }
      },
    },
  ];
}

/** 校验用户 JWT，返回用户 id；失败时返回 undefined 由路由层转为 401。 */
function authenticateUser(req: IncomingMessage) {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    return verifyAccessToken(token).sub;
  } catch {
    return undefined;
  }
}

/** 校验服务间 token；仅显式开发或测试环境允许缺省调试。 */
function verifyServiceToken(req: IncomingMessage) {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}
