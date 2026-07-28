/** 本文件注册 LoRA 仓库公开浏览、用户草稿上传、发布、下载和删除接口。 */
import type { IncomingMessage } from 'node:http';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { LoraRepositoryError, LoraRepositoryService } from './lora-repository-service.js';
import { LoraStorageError } from './lora-storage-service.js';

const service = new LoraRepositoryService();

/** 注册 LoRA 仓库路由。 */
export function createLoraRepositoryRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/loras', handle: listLoras },
    { method: 'GET', path: '/api/loras/models', handle: listModels },
    { method: 'POST', path: '/api/loras', handle: rejectLegacyLoraWrite },
    { method: 'POST', path: '/api/loras/:id/uploads', handle: rejectLegacyLoraWrite },
    { method: 'GET', path: '/api/loras/:id/uploads/:uploadId', handle: rejectLegacyLoraWrite },
    { method: 'PUT', path: '/api/loras/:id/uploads/:uploadId', handle: rejectLegacyLoraWrite },
    { method: 'POST', path: '/api/loras/:id/uploads/:uploadId/complete', handle: rejectLegacyLoraWrite },
    { method: 'DELETE', path: '/api/loras/:id/uploads/:uploadId', handle: rejectLegacyLoraWrite },
    { method: 'PUT', path: '/api/loras/:id/file', handle: rejectLegacyLoraWrite },
    { method: 'POST', path: '/api/loras/:id/examples', handle: rejectLegacyLoraWrite },
    { method: 'POST', path: '/api/loras/:id/publish', handle: rejectLegacyLoraWrite },
    { method: 'DELETE', path: '/api/loras/:id', handle: rejectLegacyLoraWrite },
    { method: 'GET', path: '/api/loras/examples/:exampleId', handle: serveExample },
    { method: 'GET', path: '/api/loras/:id/download', handle: serveDownload },
    { method: 'GET', path: '/internal/loras/:id/file', handle: serveInternalDownload },
  ];
}

async function listLoras(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const userId = authenticate(req);
  const mine = url.searchParams.get('mine') === '1';
  if (mine && !userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  try {
    const data = await service.list({ userId, mine, page: Number(url.searchParams.get('page') ?? 1), pageSize: Number(url.searchParams.get('pageSize') ?? 18), search: url.searchParams.get('search')?.trim(), model: url.searchParams.get('model')?.trim(), loraType: url.searchParams.get('type')?.trim() });
    return sendJson(res, 200, { ok: true, data });
  } catch (error) { return sendError(res, error); }
}

async function listModels(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  return sendJson(res, 200, { ok: true, data: { models: await service.listBaseModels(), defaultModel: 'anima' } });
}

/** 主站 LoRA 只保留历史读取；所有新资产统一进入独立本地模型平台。 */
async function rejectLegacyLoraWrite(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticate(req)) return unauthorized(res);
  return sendJson(res, 410, {
    ok: false,
    code: 'local_model_platform_required',
    message: '主站 LoRA 仓库已转为历史只读，请前往独立本地模型平台管理 LoRA',
  });
}

async function serveExample(_req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  try {
    if (!await service.serveExample(readId(params?.exampleId), res)) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '示例图不存在' });
  } catch (error) { return sendError(res, error); }
}

async function serveDownload(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  try {
    if (!await service.serveDownload(readId(params?.id), req, res)) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: 'LoRA 文件不存在' });
  } catch (error) { return sendError(res, error); }
}

/** 只向携带服务间 token 的 Worker 输出任务已固化哈希对应的 LoRA 文件。 */
async function serveInternalDownload(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!await service.serveInternalDownload(readId(params?.id), url.searchParams.get('sha256') ?? '', req, res)) {
      return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: 'LoRA 文件不存在' });
    }
  } catch (error) { return sendError(res, error); }
}

function authenticate(req: IncomingMessage): number | undefined { const token = readBearerToken(req.headers.authorization); if (!token) return undefined; try { return verifyAccessToken(token).sub; } catch { return undefined; } }
/** 校验 Worker 与 backend 共用的内部服务 token。 */
function verifyServiceToken(req: IncomingMessage): boolean { const expected = process.env.WS_PROXY_TOKEN?.trim(); if (!expected) return isMissingServiceTokenAllowed(); return String(req.headers['x-service-token'] ?? '').trim() === expected; }
function unauthorized(res: Parameters<typeof sendJson>[0]) { return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' }); }
function readId(value: string | undefined): number { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw new LoraRepositoryError(400, 'LoRA 条目 ID 不正确'); return id; }
function sendError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof LoraRepositoryError || error instanceof LoraStorageError) return sendJson(res, error.status, { ok: false, code: error.status === 404 ? ApiErrorCode.NotFound : ApiErrorCode.BadRequest, message: error.message });
  const message = error instanceof Error ? error.message : 'LoRA 仓库请求失败';
  return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message });
}
