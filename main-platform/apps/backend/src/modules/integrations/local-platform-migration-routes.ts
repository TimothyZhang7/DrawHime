/**
 * 本文件提供独立本地模型平台的一次性只读资产迁移接口，只导出已发布 LoRA 及其校验摘要。
 */
import type { IncomingMessage } from 'node:http';
import { readStringEnv, sendJson, type Route } from '@aiimage/core-utils';
import { ApiErrorCode, type LocalPlatformMigrationSnapshotResponse } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { LoraRepositoryService } from '../lora/lora-repository-service.js';

const prisma = getPrismaClient();
const loraService = new LoraRepositoryService();

/** 注册主站本地资产只读迁移路由。 */
export function createLocalPlatformMigrationRoutes(): Route[] {
  return [
    { method: 'GET', path: '/internal/integrations/local-model/migration/snapshot', handle: getSnapshot },
    { method: 'GET', path: '/internal/integrations/local-model/migration/loras/:id/file', handle: getLoraFile },
    { method: 'GET', path: '/internal/integrations/local-model/migration/examples/:id', handle: getLoraExample },
  ];
}

/** 导出已发布且文件摘要完整的 LoRA 元数据，不返回主站存储路径。 */
async function getSnapshot(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticatePlatform(req)) return sendJson(res, 403, failure('本地模型平台服务凭证不正确'));
  const rows = await prisma.loraRepositoryItem.findMany({
    where: { status: 'published', storedName: { not: null }, sha256: { not: null }, fileSizeBytes: { not: null }, publishedAt: { not: null } },
    include: {
      user: { select: { id: true, username: true, emailVerified: true } },
      exampleImages: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
    },
    orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
  });
  const response: LocalPlatformMigrationSnapshotResponse = { ok: true, data: {
    issuer: process.env.MAIN_PLATFORM_ISSUER?.trim() || readStringEnv('MAIN_SITE_URL', 'https://www.xanime.ink'),
    generatedAt: new Date().toISOString(),
    loras: rows.map((item) => ({
      id: item.id,
      owner: { subject: String(item.user.id), displayName: item.user.username, emailVerified: item.user.emailVerified },
      title: item.title,
      description: item.description,
      baseModel: item.baseModel,
      loraType: item.loraType,
      originalFileName: item.originalFileName ?? 'model.safetensors',
      fileSizeBytes: Number(item.fileSizeBytes),
      sha256: item.sha256!,
      publishedAt: item.publishedAt!.toISOString(),
      examples: item.exampleImages.map((example) => ({ id: example.id, width: example.width, height: example.height, sizeBytes: example.sizeBytes, sortOrder: example.sortOrder })),
    })),
  } };
  return sendJson(res, 200, response);
}

/** 按快照中的 SHA-256 流式输出 LoRA 文件。 */
async function getLoraFile(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticatePlatform(req)) return sendJson(res, 403, failure('本地模型平台服务凭证不正确'));
  const id = Number(params?.id ?? 0);
  const sha256 = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sha256') ?? '';
  if (!Number.isSafeInteger(id) || id <= 0) return sendJson(res, 400, failure('LoRA ID 不正确'));
  try {
    if (!await loraService.serveInternalDownload(id, sha256, req, res)) return sendJson(res, 404, failure('LoRA 文件不存在'));
  } catch {
    return sendJson(res, 400, failure('LoRA 文件摘要不正确'));
  }
}

/** 输出已发布 LoRA 的示例图，服务端仍会校验示例所属 LoRA 发布状态。 */
async function getLoraExample(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticatePlatform(req)) return sendJson(res, 403, failure('本地模型平台服务凭证不正确'));
  const id = Number(params?.id ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0) return sendJson(res, 400, failure('示例图 ID 不正确'));
  if (!await loraService.serveExample(id, res)) return sendJson(res, 404, failure('示例图不存在'));
}

/** 校验独立平台服务 token。 */
function authenticatePlatform(req: IncomingMessage): boolean {
  const expected = process.env.LOCAL_PLATFORM_INTEGRATION_TOKEN?.trim();
  const value = String(req.headers['x-local-platform-token'] ?? '').trim();
  return Boolean(expected && value && expected === value);
}

/** 构造统一失败响应。 */
function failure(message: string): LocalPlatformMigrationSnapshotResponse {
  return { ok: false, code: ApiErrorCode.BadRequest, message };
}
