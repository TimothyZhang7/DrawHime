/** 本文件注册 Web 钱包接口，用户余额展示不再依赖 QQ 绑定状态。 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type ApiDataResponse, type WalletLedgerListQuery, type WalletLedgerListResponse, type WalletStatusResponse } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { WalletService } from './wallet-service.js';
import { setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheWebWalletStatus } from '../../shared/cache/cache-policies.js';

const walletService = new WalletService();

/** 创建钱包路由表；当前仅暴露登录用户自己的可访问余额。 */
export function createWalletRoutes(): Route[] {
  return [
    { method: 'GET', path: '/wallet/status', handle: getWalletStatus },
    // 生产 Nginx 已稳定代理 /api/* 到 backend；前端统一走 /api 路径避免被 SPA 静态页吞掉。
    { method: 'GET', path: '/api/wallet/status', handle: getWalletStatus },
    { method: 'GET', path: '/api/wallet/ledger', handle: getWalletLedger },
  ];
}

/** 查询当前登录 Web 用户可访问的钱包余额。 */
async function getWalletStatus(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const cached = await cacheWebWalletStatus(userId, () => walletService.getWebStatus(userId));
  setBackendCacheHeader(res, cached.status);
  const data = cached.value;
  return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<WalletStatusResponse>);
}

/** 查询当前登录 Web 用户可访问钱包流水，包含免费余额和付费余额的完整收入/扣费记录。 */
async function getWalletLedger(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '30');
  const query: WalletLedgerListQuery = {
    page,
    pageSize,
    type: url.searchParams.get('type') as WalletLedgerListQuery['type'] ?? 'all',
    balanceKind: url.searchParams.get('balanceKind') as WalletLedgerListQuery['balanceKind'] ?? 'all',
    source: url.searchParams.get('source') as WalletLedgerListQuery['source'] ?? 'all',
    dateFrom: url.searchParams.get('dateFrom') ?? undefined,
    dateTo: url.searchParams.get('dateTo') ?? undefined,
  };
  const data = await walletService.listWebLedger(userId, query);
  return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<WalletLedgerListResponse>);
}

/** 校验用户 JWT，失败时不抛内部错误。 */
function authenticateUser(req: IncomingMessage) {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    return verifyAccessToken(token).sub;
  } catch {
    return undefined;
  }
}
