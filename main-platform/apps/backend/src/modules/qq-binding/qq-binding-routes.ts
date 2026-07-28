/** 本文件注册 QQ 绑定、余额查询和 QQ 触达建档 HTTP 路由。 */
import type { IncomingMessage } from 'node:http';
import {
  ApiErrorCode,
  type ApiDataResponse,
  type QqBalanceQueryRequest,
  type QqTouchRequest,
  type QqVerifyBindingRequest,
} from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { QqBindingService } from './qq-binding-service.js';
import { QqBindingError } from './qq-binding-types.js';
import { validateQqBalanceQueryRequest, validateQqTouchRequest, validateQqVerifyBindingRequest } from './qq-binding-validation.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { invalidateUserCache, invalidateWalletCache, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheQqStatus } from '../../shared/cache/cache-policies.js';

const qqBindingService = new QqBindingService();
const prisma = getPrismaClient();

/** 创建 QQ 相关路由；用户接口使用 JWT，Bot 内部接口使用 service token。 */
export function createQqBindingRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/qq/generate-key',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        try {
          const data = await qqBindingService.generateKey(userId);
          // 生成新绑定码会改变绑定页状态，清理用户级缓存避免旧状态残留。
          invalidateUserCache(userId);
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendQqBindingError(res, error);
        }
      },
    },
    {
      method: 'GET',
      path: '/qq/status',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const cached = await cacheQqStatus(userId, async () => {
          const status = await qqBindingService.getStatus(userId);
          let prefix = '#';
          try {
            const row = await prisma.systemConfig.findUnique({ where: { key: 'bot_cmd_prefix' }, select: { value: true } });
            if (row?.value) prefix = row.value;
          } catch {
            // 配置读取失败不影响绑定状态查询，前端使用默认命令前缀。
          }
          return { ...status, botCmdPrefix: prefix };
        });
        setBackendCacheHeader(res, cached.status);
        const data = cached.value;
        return sendJson(res, 200, { ok: true, data });
      },
    },
    {
      method: 'DELETE',
      path: '/qq/unbind',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        try {
          const data = await qqBindingService.unbind(userId);
          // QQ 解绑会改变钱包可见范围、个人资料 QQ 状态和 Bot 隐私设置入口。
          invalidateWalletCache([`user:${userId}`]);
          invalidateUserCache(userId);
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendQqBindingError(res, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/internal/qq/verify-binding',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody<unknown>(req);
        if (!validateQqVerifyBindingRequest(body)) {
          // 绑定验证必须拒绝格式错误请求，避免任意字符串进入 bigint 转换。
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 绑定验证请求格式不正确' });
        }
        try {
          const data = await qqBindingService.verifyBinding(normalizeVerifyBindingRequest(body));
          invalidateWalletCache([`qq:${data.qqNumber}`, ...(typeof data.userId === 'number' ? [`user:${data.userId}`] : [])]);
          if (typeof data.userId === 'number') {
            // 兼容契约中 userId 可选的情况；当前服务返回时清理对应网页用户缓存。
            invalidateUserCache(data.userId, [`qq:${data.qqNumber}`]);
          }
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendQqBindingError(res, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/internal/qq/balance',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody<unknown>(req);
        if (!validateQqBalanceQueryRequest(body)) {
          // 余额查询必须拒绝异常 QQ 号，避免无意义 bigint 转换和数据库查询。
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 余额查询请求格式不正确' });
        }
        try {
          const data = await qqBindingService.queryBalance(normalizeBalanceQueryRequest(body));
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendQqBindingError(res, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/internal/qq/touch',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody<unknown>(req);
        if (!validateQqTouchRequest(body)) {
          // QQ 触达建档属于余额关键链路，只接受 OneBot user_id，避免异常字符串污染余额表。
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 触达请求格式不正确' });
        }
        try {
          const data = await qqBindingService.touchQq(normalizeTouchRequest(body));
          invalidateWalletCache([`qq:${data.qqNumber}`]);
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendQqBindingError(res, error);
        }
      },
    },
  ];
}

/** 校验用户 JWT，返回用户 id；失败时由路由层转为 401。 */
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

/** 归一化服务间请求体，确保 service 层收到的 key 和 QQ 号没有首尾空格。 */
function normalizeVerifyBindingRequest(body: QqVerifyBindingRequest): QqVerifyBindingRequest {
  return {
    verificationKey: body.verificationKey.trim().toUpperCase(),
    qqNumber: body.qqNumber.trim(),
  };
}

/** 归一化余额查询请求体，确保 service 层只处理干净的 QQ 号。 */
function normalizeBalanceQueryRequest(body: QqBalanceQueryRequest): QqBalanceQueryRequest {
  return {
    qqNumber: body.qqNumber.trim(),
  };
}

/** 归一化 QQ 触达建档请求体，确保 service 层只处理干净的 QQ 号。 */
function normalizeTouchRequest(body: QqTouchRequest): QqTouchRequest {
  return {
    qqNumber: body.qqNumber.trim(),
  };
}

/** 将 QQ 绑定业务错误映射为 HTTP 响应，未知错误交给全局错误处理。 */
function sendQqBindingError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (!(error instanceof QqBindingError)) throw error;
  if (error.kind === 'already_bound' || error.kind === 'qq_already_bound') {
    return sendJson(res, 409, { ok: false, code: ApiErrorCode.Conflict, message: error.message });
  }
  if (error.kind === 'key_not_found' || error.kind === 'not_bound') {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: error.message });
  }
  if (error.kind === 'invalid_request') {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error.message });
  }
  return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: 'QQ 绑定操作失败' });
}
