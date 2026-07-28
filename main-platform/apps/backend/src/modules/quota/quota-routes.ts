/**
 * 本文件注册内部余额扣减、退款和管理员余额调整路由。
 * 余额扣减是服务间接口，由 drawing-service 在生成前调用。
 * 余额调整是管理接口，需要 admin JWT。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { QuotaService } from './quota-service.js';
import { QuotaError } from './quota-types.js';

const quotaService = new QuotaService();

export function createQuotaRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/internal/quota/charge',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody<Record<string, unknown>>(req);
        const qqStr = String(body.qqNumber ?? '');
        const price = Number(body.pricePerGen ?? 0);
        if (!/^\d{5,}$/.test(qqStr) || price <= 0) {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '扣费参数格式不正确' });
        }
        try {
          const result = await quotaService.chargeForGeneration(BigInt(qqStr), price);
          return sendJson(res, 200, { ok: true, data: result });
        } catch (error) {
          if (error instanceof QuotaError && error.kind === 'insufficient_balance') {
            return sendJson(res, 402, {
              ok: false,
              code: 'insufficient_balance',
              message: error.message,
              details: error.details,
            });
          }
          throw error;
        }
      },
    },
    {
      method: 'POST',
      path: '/internal/quota/refund',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody<Record<string, unknown>>(req);
        const qqStr = String(body.qqNumber ?? '');
        const chargedSource = String(body.chargedSource ?? '');
        const chargedAmount = String(body.chargedAmount ?? '0');
        if (!/^\d{5,}$/.test(qqStr) || !chargedSource) {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '退款参数格式不正确' });
        }
        try {
          const amt = Number(chargedAmount || '0');
          await quotaService.refundForFailedGeneration(
            BigInt(qqStr),
            chargedSource === 'free' ? amt : 0,
            chargedSource === 'paid' ? amt : 0,
          );
          return sendJson(res, 200, { ok: true, data: { refunded: true } });
        } catch {
          return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: '退款操作失败' });
        }
      },
    },
  ];
}

/** 校验服务间 token。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

/** 读取 JSON 请求体（复用 shared/http/body 的实现，不再本地重定义）。 */
