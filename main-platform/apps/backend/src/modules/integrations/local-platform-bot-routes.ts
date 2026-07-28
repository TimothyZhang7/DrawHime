/**
 * 本文件作为 Bot 与独立本地模型平台之间的主站 BFF，负责服务鉴权、QQ 余额摘要和任务状态转发。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type BotGenerationRetryResponse, type LocalPlatformBotCatalogResponse, type LocalPlatformBotJobCreateRequest, type LocalPlatformBotJobCreateResponse, type LocalPlatformBotJobListResponse, type LocalPlatformBotJobView } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { readJsonBody } from '../../shared/http/body.js';
import { WalletService } from '../wallet/wallet-service.js';

const prisma = getPrismaClient();
const walletService = new WalletService();

/** 注册 Bot 专用的本地模型目录与提交路由。 */
export function createLocalPlatformBotRoutes(): Route[] {
  return [
    { method: 'GET', path: '/internal/bot/local-models', handle: listLocalModels },
    { method: 'POST', path: '/internal/bot/local-generate', handle: createLocalJob },
  ];
}

/** 读取独立平台当前真实可用模型目录。 */
async function listLocalModels(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyBotService(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const result = await requestLocalPlatform<LocalPlatformBotCatalogResponse>('/internal/bot/catalog');
  return sendJson(res, result.status, result.payload);
}

/** 由独立平台创建任务并由主站返回 QQ 当前可访问余额。 */
async function createLocalJob(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyBotService(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const body = await readJsonBody<LocalPlatformBotJobCreateRequest>(req);
  const qqNumber = normalizeQqNumber(body.qqNumber);
  if (!qqNumber) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  const privacy = await prisma.qqImagePrivacyPref.findUnique({ where: { qqNumber }, select: { isPrivate: true } });
  const platformRequest = { ...body, isPrivate: privacy?.isPrivate ?? false };
  const result = await requestLocalPlatform<LocalPlatformBotJobCreateResponse>('/internal/bot/jobs', { method: 'POST', body: JSON.stringify(platformRequest) });
  if (result.payload.ok !== true) return sendJson(res, result.status, result.payload);
  const [balance, binding] = await Promise.all([
    walletService.getQqBalanceSummary(qqNumber),
    prisma.qqBinding.findUnique({ where: { qqNumber }, select: { userId: true, verified: true, user: { select: { username: true } } } }),
  ]);
  const job = result.payload.data.job;
  const response: BotGenerationRetryResponse = {
    accepted: true,
    taskId: job.id,
    taskIds: [job.id],
    clientRequestId: body.idempotencyKey,
    status: job.status === 'queued' ? 'queued' : 'running',
    charged: Number(result.payload.data.chargedAmount) > 0,
    chargedSource: 'local_platform',
    chargedAmount: result.payload.data.chargedAmount,
    paidBalance: balance.paidBalance,
    freeBalance: balance.freeBalance,
    mode: 'text-to-image',
    prompt: body.prompt.slice(0, 200),
    preferredModel: `local:${body.modelVersionId}`,
    maxAttempts: job.maxAttempts,
    imageCount: 0,
    isPrivate: platformRequest.isPrivate,
    qqNumber: body.qqNumber,
    bindingUsername: binding?.verified ? binding.user.username : null,
    bindingUserId: binding?.verified ? binding.userId : null,
    sourceTaskId: job.id,
    sourceImageUrls: [],
  };
  return sendJson(res, result.status, { ok: true, data: response });
}

/** 批量读取独立平台 Bot 任务，供主站统一任务轮询接口合并。 */
export async function queryLocalPlatformBotJobs(ids: string[]): Promise<LocalPlatformBotJobView[]> {
  if (ids.length === 0) return [];
  const result = await requestLocalPlatform<LocalPlatformBotJobListResponse>(`/internal/bot/jobs?ids=${encodeURIComponent(ids.join(','))}`);
  return result.payload.ok === true ? result.payload.data.jobs : [];
}

/** 调用独立平台内部接口，固定携带平台服务凭证并保留真实错误状态。 */
async function requestLocalPlatform<T>(path: string, init: RequestInit = {}): Promise<{ status: number; payload: T }> {
  const baseUrl = process.env.LOCAL_PLATFORM_INTERNAL_URL?.trim() || 'http://127.0.0.1:7102';
  const token = process.env.LOCAL_PLATFORM_INTEGRATION_TOKEN?.trim();
  if (!token) return { status: 503, payload: { ok: false, code: ApiErrorCode.ServiceUnavailable, message: '本地模型平台集成尚未配置' } as T };
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-local-platform-token': token, ...(init.headers || {}) },
      signal: AbortSignal.timeout(init.method === 'POST' ? 30000 : 8000),
    });
    return { status: response.status, payload: await response.json() as T };
  } catch {
    return { status: 503, payload: { ok: false, code: ApiErrorCode.ServiceUnavailable, message: '本地模型平台暂不可用' } as T };
  }
}

/** 校验 Bot 到 backend 的服务凭证。 */
function verifyBotService(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}

/** 归一化真实 OneBot QQ 号。 */
function normalizeQqNumber(value: string): bigint | null {
  const text = String(value ?? '').trim();
  return /^[1-9][0-9]{4,19}$/.test(text) ? BigInt(text) : null;
}
