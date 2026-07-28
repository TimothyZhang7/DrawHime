/**
 * 本文件提供独立本地模型平台的价格发布与钱包预留接口，所有资金写入由主站事务权威完成。
 */
import type { IncomingMessage } from 'node:http';
import { Prisma } from '@prisma/client';
import { sendJson, type Route } from '@aiimage/core-utils';
import {
  ApiErrorCode,
  type LocalPlatformBillingReservationCreateRequest,
  type LocalPlatformBillingReservationFinalizeRequest,
  type LocalPlatformBillingReservationResponse,
  type LocalPlatformPricePublishRequest,
  type LocalPlatformPricePublishResponse,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { readJsonBody } from '../../shared/http/body.js';
import { WalletService } from '../wallet/wallet-service.js';
import { WalletError } from '../wallet/wallet-types.js';

const prisma = getPrismaClient();
const walletService = new WalletService();

/** 注册独立平台价格与计费路由。 */
export function createLocalPlatformBillingRoutes(): Route[] {
  return [
    { method: 'PUT', path: '/internal/integrations/local-model/prices', handle: publishPrice },
    { method: 'POST', path: '/internal/integrations/local-model/billing/reservations', handle: createReservation },
    { method: 'POST', path: '/internal/integrations/local-model/billing/reservations/:id/commit', handle: commitReservation },
    { method: 'POST', path: '/internal/integrations/local-model/billing/reservations/:id/release', handle: releaseReservation },
  ];
}

/** 发布不可变价格版本；同一版本只允许幂等重放，更新价格必须递增版本号。 */
async function publishPrice(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticatePlatform(req)) return sendPlatformError(res, 403, ApiErrorCode.Forbidden, '本地模型平台服务凭证不正确');
  try {
    const body = await readJsonBody<LocalPlatformPricePublishRequest>(req);
    const input = normalizePriceRequest(body);
    const price = await prisma.$transaction(async (tx) => {
      const existing = await tx.localPlatformPriceVersion.findUnique({
        where: { productCode_pricingVersion: { productCode: input.productCode, pricingVersion: input.pricingVersion } },
      });
      if (existing && (
        existing.unitPrice.toFixed(2) !== input.unitPrice
        || existing.billingUnit !== input.billingUnit
        || existing.currency !== input.currency
      )) {
        throw new WalletError('conflict', '价格版本已经存在，修改价格时必须递增版本号');
      }
      const current = existing ?? await tx.localPlatformPriceVersion.create({ data: input });
      await tx.localPlatformPriceVersion.updateMany({
        where: { productCode: input.productCode, id: { not: current.id }, active: true },
        data: { active: false },
      });
      return current.active ? current : tx.localPlatformPriceVersion.update({ where: { id: current.id }, data: { active: true } });
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 });
    const response: LocalPlatformPricePublishResponse = { ok: true, data: {
      productCode: price.productCode,
      pricingVersion: price.pricingVersion,
      unitPrice: price.unitPrice.toFixed(2),
      billingUnit: price.billingUnit as 'image' | 'training_job',
      currency: 'CNY',
      active: true,
    } };
    return sendJson(res, 200, response);
  } catch (error) {
    return handleBillingError(res, error);
  }
}

/** 创建计费预留；请求不接收金额，主站按已发布价格版本计算并事务扣款。 */
async function createReservation(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticatePlatform(req)) return sendPlatformError(res, 403, ApiErrorCode.Forbidden, '本地模型平台服务凭证不正确');
  try {
    const body = await readJsonBody<LocalPlatformBillingReservationCreateRequest>(req);
    const input = normalizeReservationRequest(body);
    const price = await prisma.localPlatformPriceVersion.findUnique({
      where: { productCode_pricingVersion: { productCode: input.productCode, pricingVersion: input.pricingVersion } },
    });
    if (!price || !price.active) return sendPlatformError(res, 404, ApiErrorCode.NotFound, '本地模型价格版本不存在或已经停用');
    const amount = roundMoney(price.unitPrice.toNumber() * input.quantity);
    const data = await prisma.$transaction((tx) => walletService.reserveForLocalPlatformTx(tx, {
      walletOwnerType: input.walletOwnerType,
      userId: input.userId,
      qqNumber: input.qqNumber,
      externalTaskId: input.externalTaskId,
      idempotencyKey: input.idempotencyKey,
      priceVersionId: price.id,
      quantity: input.quantity,
      amount,
      currency: 'CNY',
    }), { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 });
    const response: LocalPlatformBillingReservationResponse = { ok: true, data };
    return sendJson(res, 201, response);
  } catch (error) {
    return handleBillingError(res, error);
  }
}

/** 提交已完成任务的资金预留，资金不会再次扣除。 */
async function commitReservation(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  return finalizeReservation(req, res, params?.id, 'commit');
}

/** 释放失败或取消任务的资金预留，严格按固化分账原路退款。 */
async function releaseReservation(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  return finalizeReservation(req, res, params?.id, 'release');
}

/** 执行提交或释放终态写入；终态幂等键必须与首次请求一致。 */
async function finalizeReservation(
  req: IncomingMessage,
  res: Parameters<typeof sendJson>[0],
  reservationId: string | undefined,
  action: 'commit' | 'release',
) {
  if (!authenticatePlatform(req)) return sendPlatformError(res, 403, ApiErrorCode.Forbidden, '本地模型平台服务凭证不正确');
  try {
    const id = String(reservationId ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new WalletError('invalid_request', '计费预留 ID 不正确');
    const body = await readJsonBody<LocalPlatformBillingReservationFinalizeRequest>(req);
    const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey);
    const data = await prisma.$transaction((tx) => action === 'commit'
      ? walletService.commitLocalPlatformReservationTx(tx, id, idempotencyKey)
      : walletService.releaseLocalPlatformReservationTx(tx, id, idempotencyKey, normalizeReason(body.reason)), {
      isolationLevel: 'Serializable',
      maxWait: 5000,
      timeout: 15000,
    });
    const response: LocalPlatformBillingReservationResponse = { ok: true, data };
    return sendJson(res, 200, response);
  } catch (error) {
    return handleBillingError(res, error);
  }
}

/** 校验独立平台服务 token；该接口不接受用户 JWT 代替服务凭证。 */
function authenticatePlatform(req: IncomingMessage): boolean {
  const expected = process.env.LOCAL_PLATFORM_INTEGRATION_TOKEN?.trim();
  const value = readHeader(req.headers['x-local-platform-token']);
  return Boolean(expected && value && value === expected);
}

/** 归一化价格发布请求，防止异常价格或产品键进入资金表。 */
function normalizePriceRequest(input: LocalPlatformPricePublishRequest) {
  const productCode = String(input?.productCode ?? '').trim();
  const pricingVersion = Number(input?.pricingVersion);
  const unitPrice = Number(input?.unitPrice);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/.test(productCode)) throw new WalletError('invalid_request', '产品代码格式不正确');
  if (!Number.isSafeInteger(pricingVersion) || pricingVersion <= 0) throw new WalletError('invalid_request', '价格版本必须为正整数');
  if (!Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > 10000) throw new WalletError('invalid_request', '单价必须在 0.01 到 10000 元之间');
  if (input.billingUnit !== 'image' && input.billingUnit !== 'training_job') throw new WalletError('invalid_request', '计费单位必须为图片或训练任务');
  if (input.currency !== 'CNY') throw new WalletError('invalid_request', '当前仅支持人民币计费');
  return { productCode, pricingVersion, unitPrice: roundMoney(unitPrice).toFixed(2), billingUnit: input.billingUnit, currency: 'CNY', active: true } as const;
}

/** 归一化预留请求，明确区分网页用户和 QQ 钱包主体。 */
function normalizeReservationRequest(input: LocalPlatformBillingReservationCreateRequest) {
  const externalTaskId = String(input?.externalTaskId ?? '').trim();
  const walletOwnerType = input?.walletOwnerType;
  const numericSubject = String(input?.userSubject ?? '').trim();
  const productCode = String(input?.productCode ?? '').trim();
  const pricingVersion = Number(input?.pricingVersion);
  const quantity = Number(input?.quantity);
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(externalTaskId)) throw new WalletError('invalid_request', '独立平台任务 ID 格式不正确');
  if (walletOwnerType !== 'user' && walletOwnerType !== 'qq') throw new WalletError('invalid_request', '钱包主体类型不正确');
  if (!/^[1-9][0-9]{0,19}$/.test(numericSubject)) throw new WalletError('invalid_request', '钱包主体格式不正确');
  const userId = walletOwnerType === 'user' ? Number(numericSubject) : undefined;
  const qqNumber = walletOwnerType === 'qq' ? BigInt(numericSubject) : undefined;
  if (walletOwnerType === 'user' && (!Number.isSafeInteger(userId) || Number(userId) <= 0)) throw new WalletError('invalid_request', '主站用户主体格式不正确');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/.test(productCode)) throw new WalletError('invalid_request', '产品代码格式不正确');
  if (!Number.isSafeInteger(pricingVersion) || pricingVersion <= 0) throw new WalletError('invalid_request', '价格版本必须为正整数');
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 32) throw new WalletError('invalid_request', '计费数量必须为 1 到 32 的整数');
  return { externalTaskId, idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey), walletOwnerType, userId, qqNumber, productCode, pricingVersion, quantity };
}

/** 幂等键限制为可审计短字符串，禁止空值和超长数据。 */
function normalizeIdempotencyKey(value: string): string {
  const key = String(value ?? '').trim();
  if (key.length < 8 || key.length > 191) throw new WalletError('invalid_request', '幂等键长度必须为 8 到 191 个字符');
  return key;
}

/** 释放原因只保存单行摘要，避免任意长文本进入资金表。 */
function normalizeReason(value?: string): string | undefined {
  const reason = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return reason ? reason.slice(0, 500) : undefined;
}

/** 统一映射钱包、Prisma 与输入错误，不向调用方暴露数据库细节。 */
function handleBillingError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof WalletError) {
    const status = error.kind === 'insufficient_balance' ? 402 : error.kind === 'conflict' ? 409 : 400;
    const code = error.kind === 'insufficient_balance' ? ApiErrorCode.InsufficientBalance : error.kind === 'conflict' ? ApiErrorCode.Conflict : ApiErrorCode.BadRequest;
    return sendPlatformError(res, status, code, error.message);
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return sendPlatformError(res, 409, ApiErrorCode.Conflict, '计费幂等键已经被其他请求使用');
    if (error.code === 'P2025') return sendPlatformError(res, 404, ApiErrorCode.NotFound, '计费预留不存在');
  }
  return sendPlatformError(res, 500, ApiErrorCode.InternalError, '本地模型计费操作失败');
}

/** 发送符合共享契约的失败响应。 */
function sendPlatformError(res: Parameters<typeof sendJson>[0], status: number, code: typeof ApiErrorCode[keyof typeof ApiErrorCode], message: string) {
  return sendJson(res, status, { ok: false, code, message } satisfies LocalPlatformBillingReservationResponse);
}

/** 金额统一四舍五入到分。 */
function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 读取单值请求头。 */
function readHeader(value: string | string[] | undefined): string {
  return String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim();
}
