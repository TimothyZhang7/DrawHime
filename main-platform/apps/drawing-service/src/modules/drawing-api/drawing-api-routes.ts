/**
 * 本文件注册 drawing-service 全部路由：生成任务接收、站点信息、模型列表、站点统计。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { DrawingApiService, getSiteStatusSummary, getAvailableModels } from './drawing-api-service.js';
import { validateDrawingGenerateRequest } from './drawing-api-validation.js';
import { siteConfigService } from '../site-info/site-config-service.js';

const drawingApiService = new DrawingApiService();

export function createDrawingApiRoutes(): Route[] {
  return [
    { method: 'POST', path: '/api/drawing/generate', handle: acceptTask },
    { method: 'GET', path: '/api/drawing/site-info', handle: getSiteInfo },
    { method: 'GET', path: '/api/drawing/models', handle: getModels },
    { method: 'GET', path: '/api/drawing/site-stats', handle: getSiteStats },
    { method: 'GET', path: '/api/drawing/health', handle: healthCheck },
    // 缓存管理接口（内部使用）
    { method: 'POST', path: '/internal/sites/cache/invalidate', handle: invalidateCache },
  ];
}

/** 接收生成任务。 */
async function acceptTask(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const body = await readJsonBody(req);
  if (!validateDrawingGenerateRequest(body)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '绘图生成请求格式不正确' });
  }
  const data = await drawingApiService.acceptGenerationTask(body);
  return sendJson(res, 202, data);
}

/** 获取站点信息（sizes/qualities/models/defaults）。 */
async function getSiteInfo(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const sites = await siteConfigService.getEnabledSites();
  return sendJson(res, 200, {
    ok: true,
    data: {
      siteCount: sites.length,
      sizes: ['auto', '1024x1024', '1792x1024', '1024x1792'],
      qualities: ['auto', 'standard', 'hd'],
      models: sites.map((s) => s.model).filter((v, i, a) => a.indexOf(v) === i),
      defaults: { size: 'auto', quality: 'auto', moderation: 'auto' },
    },
  });
}

/** 获取模型列表。 */
async function getModels(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const data = await getAvailableModels();
  return sendJson(res, 200, { ok: true, data });
}

/** 获取站点统计（all/today/1h）。 */
async function getSiteStats(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const sites = await siteConfigService.getSites();
  const stats = sites.map((s) => ({
    id: s.id,
    name: s.name,
    isEnabled: s.isEnabled,
    consecutiveFailures: s.consecutiveFailures,
    autoDisabledUntil: s.autoDisabledUntil,
  }));
  return sendJson(res, 200, { ok: true, data: { sites: stats } });
}

/** 详细健康检查。 */
async function healthCheck(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const status = await getSiteStatusSummary();
  return sendJson(res, 200, {
    ok: true,
    data: { service: 'drawing-service', version: '3.0.0', sites: status },
  });
}

/** 手动失效站点配置缓存。 */
async function invalidateCache(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  siteConfigService.invalidateCache();
  return sendJson(res, 200, { ok: true, data: { invalidated: true } });
}

function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as unknown : {};
}
