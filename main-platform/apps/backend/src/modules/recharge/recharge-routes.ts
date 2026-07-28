/**
 * 本文件注册充值路由：商店入口、卡密兑换、管理端批次生成和下载。
 */
import type { IncomingMessage } from 'node:http';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { ApiErrorCode, type BotRechargeRedeemRequest } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { RechargeService } from './recharge-service.js';
import { RechargeError } from './recharge-types.js';
import { checkRateLimit } from '../../shared/middleware/rate-limit.js';
import { invalidateWalletCache, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheRechargeShop } from '../../shared/cache/cache-policies.js';

const rechargeService = new RechargeService();
const BATCH_DIR = join(process.cwd(), 'modules', 'recharge', 'card-batches');
const botRedeemAttempts = new Map<string, { count: number; resetAt: number }>();

// Bot 卡密兑换限流状态只保留当前窗口，避免大量 QQ 尝试后长期占用内存。
setInterval(() => {
  const now = Date.now();
  for (const [qqNumber, entry] of botRedeemAttempts) {
    if (now > entry.resetAt) botRedeemAttempts.delete(qqNumber);
  }
}, 60_000).unref();

export function createRechargeRoutes(): Route[] {
  return [
    // 用户接口
    { method: 'GET', path: '/api/recharge/shop', handle: getShop },
    { method: 'POST', path: '/api/recharge/redeem', handle: redeemCard },
    { method: 'POST', path: '/internal/recharge/redeem-by-qq', handle: redeemCardByQq },
    // 管理接口
    { method: 'POST', path: '/admin/recharge/cards/generate', handle: generateCards },
    { method: 'GET', path: '/admin/recharge/batches', handle: listBatches },
    { method: 'GET', path: '/admin/recharge/batches/:id/download', handle: downloadBatch },
  ];
}

/** Bot 内部兑换：不要求网页登录，余额直接按 OneBot 事件 QQ 入账。 */
async function redeemCardByQq(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }

  const body = await readJsonBody<Partial<BotRechargeRedeemRequest>>(req);
  const qqStr = String(body.qqNumber ?? '').trim();
  const code = String(body.code ?? '').trim();
  if (!/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }
  if (!code) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请输入卡密' });
  }
  if (!checkBotRedeemLimit(qqStr)) {
    return sendJson(res, 429, { ok: false, code: ApiErrorCode.RateLimited, message: '兑换过于频繁，请稍后再试' });
  }

  try {
    const result = await rechargeService.redeemCardForQq(code, BigInt(qqStr));
    invalidateWalletCache([`qq:${qqStr}`]);
    return sendJson(res, 200, {
      ok: true,
      data: {
        qqNumber: qqStr,
        amount: result.amount.toFixed(2),
        paidBalance: result.newBalance,
        redeemedAt: result.redeemedAt,
      },
    });
  } catch (error) {
    return sendRechargeError(res, error);
  }
}

/** 商店入口：返回商店 URL 和当前余额。 */
async function getShop(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const cached = await cacheRechargeShop(() => rechargeService.getShopUrl());
  setBackendCacheHeader(res, cached.status);
  const shopUrl = cached.value;
  return sendJson(res, 200, { ok: true, data: { shopUrl } });
}

/** 卡密兑换：需登录 + 限流；未绑定 QQ 时直接入账 Web 用户钱包。 */
async function redeemCard(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!(await checkRateLimit(req, res, 'redeem'))) return;
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });

  const body = await readJsonBody<{ code?: string }>(req);
  const code = body.code?.trim();
  if (!code) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请输入卡密' });

  try {
    const result = await rechargeService.redeemCard(code, user.sub);
    invalidateWalletCache([`user:${user.sub}`]);
    return sendJson(res, 200, { ok: true, data: result });
  } catch (error) {
    return sendRechargeError(res, error);
  }
}

/** 管理员生成卡密批次。 */
async function generateCards(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateAdmin(req);
  if (!user) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });

  const body = await readJsonBody<{ amount?: number; count?: number }>(req);
  try {
    const result = await rechargeService.generateCards(
      body.amount,
      body.count,
      user.sub,
    );
    return sendJson(res, 200, { ok: true, data: { batch: result.batch, codes: result.codes } });
  } catch (error) {
    return sendRechargeError(res, error);
  }
}

/** 管理员查看批次列表。 */
async function listBatches(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateAdmin(req);
  if (!user) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });

  const url = new URL(req.url ?? '/', 'http://localhost');
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
  const data = await rechargeService.listBatches(page, pageSize);
  return sendJson(res, 200, { ok: true, data });
}

/** 管理员下载批次文件。 */
async function downloadBatch(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const user = authenticateAdmin(req);
  if (!user) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });

  const batchId = Number(params?.id ?? '0');
  try {
    const fileName = await rechargeService.getBatchFileName(batchId);
    const filePath = join(BATCH_DIR, fileName);
    const stats = await stat(filePath);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '批次文件不存在' });
  }
}

/** 校验用户 JWT。 */
function authenticateUser(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token); } catch { return undefined; }
}

/** 校验管理员 JWT。 */
function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const user = authenticateUser(req);
  if (!user || user.role !== 'admin') return undefined;
  return user;
}

/** 校验服务间 token；Bot 内部充值入口不能被公网绕过。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expectedToken;
}

/** Bot 卡密兑换按 QQ 限流，避免未绑定用户路径被拿来暴力撞卡密。 */
function checkBotRedeemLimit(qqNumber: string): boolean {
  const now = Date.now();
  const existing = botRedeemAttempts.get(qqNumber);
  if (!existing || now > existing.resetAt) {
    botRedeemAttempts.set(qqNumber, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  existing.count += 1;
  return existing.count <= 10;
}

function sendRechargeError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof RechargeError) {
    const status = error.kind === 'not_found' ? 404
      : error.kind === 'forbidden' ? 403
      : error.kind === 'rate_limited' ? 429
      : 400;
    return sendJson(res, status, { ok: false, code: ApiErrorCode.BadRequest, message: error.message });
  }
  throw error;
}
