/**
 * 本文件注册图库自动打标内部运维接口。
 *
 * 该接口只供 ops-worker 或管理员运维触发，必须使用服务间 token。
 * 打标任务只写图库标签表和打标 job 状态，不修改余额、扣费或生成主状态。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { GalleryTaggingService } from './gallery-tagging-service.js';

const taggingService = new GalleryTaggingService();

/** 创建图库打标内部路由。 */
export function createGalleryTaggingRoutes(): Route[] {
  return [
    { method: 'POST', path: '/internal/gallery/tagging/run', handle: runGalleryTagging },
  ];
}

/** 执行一批 pending/failed 图库打标任务。 */
async function runGalleryTagging(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const limit = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit') ?? '3');
  const data = await taggingService.processPending(limit);
  return sendJson(res, 200, { ok: true, data });
}

/** 校验服务间 token；仅显式开发或测试环境允许缺省调试。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}
