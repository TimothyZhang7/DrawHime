/**
 * 本文件注册模板 CRUD 和收藏路由，需用户 JWT 鉴权。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type TemplateAiConvertRequest, type TemplateAiConvertResponse, type TemplateListQuery } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { JsonBodyTooLargeError, readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { TemplateService } from './template-service.js';
import { TemplateAiService } from './template-ai-service.js';
import { TemplateError } from './template-types.js';
import { invalidateTemplateCache } from '../../shared/cache/cache-service.js';
import { setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheTemplateDetail, cacheUserTemplateList } from '../../shared/cache/cache-policies.js';

const templateService = new TemplateService();
const templateAiService = new TemplateAiService();

export function createTemplateRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/templates', handle: listTemplates },
    { method: 'POST', path: '/api/templates/ai/convert', handle: convertPromptToTemplate },
    { method: 'POST', path: '/api/templates', handle: createTemplate },
    { method: 'GET', path: '/api/templates/:id', handle: getTemplate },
    { method: 'PUT', path: '/api/templates/:id', handle: updateTemplate },
    { method: 'DELETE', path: '/api/templates/:id', handle: deleteTemplate },
    { method: 'POST', path: '/api/templates/:id/favorite', handle: favoriteTemplate },
    { method: 'DELETE', path: '/api/templates/:id/favorite', handle: unfavoriteTemplate },
  ];
}

/** 把用户普通提示词转换为模板草稿；只返回草稿，最终保存仍走模板创建接口。 */
async function convertPromptToTemplate(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const body = await readJsonBody<TemplateAiConvertRequest>(req, 64 * 1024);
  try {
    const data: TemplateAiConvertResponse = await templateAiService.convertPromptToTemplate(body.prompt);
    return sendJson(res, 200, { ok: true, data });
  } catch (error) {
    return sendTemplateError(res, error);
  }
}

async function listTemplates(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query: TemplateListQuery = {
    myOnly: url.searchParams.get('my') === 'true',
    favoriteOnly: url.searchParams.get('favorite') === 'true',
    source: url.searchParams.get('source') ?? undefined,
    search: url.searchParams.get('search') ?? undefined,
    page: Number(url.searchParams.get('page') ?? '1'),
    pageSize: Number(url.searchParams.get('pageSize') ?? '20'),
  };
  const cached = await cacheUserTemplateList(userId, query, () => templateService.listTemplates(userId, query));
  setBackendCacheHeader(res, cached.status);
  const data = cached.value;
  return sendJson(res, 200, { ok: true, data });
}

async function createTemplate(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  try {
    const body = await readJsonBody(req, 10 * 1024 * 1024 /* 10MB 支持 base64 封面图 */);
    const data = await templateService.createTemplate(userId, body as Parameters<typeof templateService.createTemplate>[1]);
    // 模板创建会影响当前用户模板列表和公开模板列表，必须主动失效。
    invalidateTemplateCache([data.id], [`user:${userId}`]);
    return sendJson(res, 201, { ok: true, data });
  } catch (error) {
    return sendTemplateError(res, error);
  }
}

async function getTemplate(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req) ?? 0;
  const id = Number(params?.id ?? '0');
  if (!id) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '模板 ID 不正确' });
  try {
    const cached = await cacheTemplateDetail(id, userId, () => templateService.getTemplate(id, userId));
    setBackendCacheHeader(res, cached.status);
    const data = cached.value;
    return sendJson(res, 200, { ok: true, data });
  } catch (error) {
    return sendTemplateError(res, error);
  }
}

async function updateTemplate(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const id = Number(params?.id ?? '0');
  try {
    const body = await readJsonBody<Record<string, unknown>>(req, 10 * 1024 * 1024 /* 10MB 支持 base64 封面图 */);
    const data = await templateService.updateTemplate(id, userId, body as Parameters<typeof templateService.updateTemplate>[2]);
    // 模板更新会影响详情、列表和公开可见性，清理模板全局 tag。
    invalidateTemplateCache([id], [`user:${userId}`]);
    return sendJson(res, 200, { ok: true, data });
  } catch (error) {
    return sendTemplateError(res, error);
  }
}

async function deleteTemplate(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const id = Number(params?.id ?? '0');
  try {
    await templateService.deleteTemplate(id, userId);
    // 删除模板后列表和详情缓存必须失效，避免用户继续看到已删除模板。
    invalidateTemplateCache([id], [`user:${userId}`]);
    return sendJson(res, 200, { ok: true, data: { deleted: true } });
  } catch (error) {
    return sendTemplateError(res, error);
  }
}

async function favoriteTemplate(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const id = Number(params?.id ?? '0');
  try {
    const data = await templateService.toggleFavorite(id, userId);
    // 收藏状态和收藏计数同时影响当前用户详情、列表以及公开列表展示。
    invalidateTemplateCache([id], [`user:${userId}`]);
    return sendJson(res, 200, { ok: true, data });
  } catch (error) {
    return sendTemplateError(res, error);
  }
}

/** DELETE 取消收藏：仅删除已有收藏，不存在时返回 404。 */
async function unfavoriteTemplate(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const id = Number(params?.id ?? '0');
  try {
    const data = await templateService.unfavorite(id, userId);
    // 取消收藏同样改变用户态收藏状态和全局收藏计数。
    invalidateTemplateCache([id], [`user:${userId}`]);
    return sendJson(res, 200, { ok: true, data });
  } catch (error) {
    return sendTemplateError(res, error);
  }
}

function authenticateUser(req: IncomingMessage) {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token).sub; } catch { return undefined; }
}

function sendTemplateError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof TemplateError) {
    const status = error.kind === 'not_found' ? 404 : error.kind === 'forbidden' ? 403 : 400;
    const code = error.kind === 'not_found' ? ApiErrorCode.NotFound
      : error.kind === 'forbidden' ? ApiErrorCode.Forbidden
      : ApiErrorCode.BadRequest;
    return sendJson(res, status, { ok: false, code, message: error.message });
  }
  if (error instanceof JsonBodyTooLargeError) {
    return sendJson(res, 413, { ok: false, code: ApiErrorCode.BadRequest, message: '模板内容或封面过大，请缩短内容后重试' });
  }
  if (error instanceof SyntaxError) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请求 JSON 格式不正确' });
  }
  console.error('[templates] request failed', error);
  return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: '模板保存失败，请稍后重试' });
}

/** 读取 JSON 请求体（复用 shared/http/body 的实现）。 */
