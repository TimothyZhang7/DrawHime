/** 本文件注册生成主任务、任务恢复、任务查询和内部子任务写入路由。 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type ApiDataResponse, type GenerationCooldownResponse, type GenerationCreateRequest, type GenerationRecoverRequest, type GenerationRetryRequest } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { GenerationsService } from './generations-service.js';
import { GenerationError } from './generations-types.js';
import { QuotaError } from '../quota/quota-types.js';
import { WalletError } from '../wallet/wallet-types.js';
import { queryLocalPlatformBotJobs } from '../integrations/local-platform-bot-routes.js';
import { synchronizeLocalPlatformTaskDeletion } from '../integrations/local-platform-gallery-routes.js';
import {
  invalidateGalleryCache,
  invalidateImageCache,
  invalidateTaskCache,
  invalidateWalletCache,
  setBackendCacheHeader,
} from '../../shared/cache/cache-service.js';
import { cacheInternalTasks, cacheUserGenerationList, cacheUserTasks } from '../../shared/cache/cache-policies.js';
import {
  parseTaskIdsQuery,
  validateAppendSubTaskRequest,
  validateGenerationCreateRequest,
  validateRecoverClientRequestId,
  validateUpdateTaskStatusRequest,
} from './generations-validation.js';

const generationsService = new GenerationsService();

/** 创建生成任务路由表；用户接口走 JWT，内部写入接口走服务间 token。 */
export function createGenerationsRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/generate',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const body = await readJsonBody<GenerationCreateRequest>(req, 10 * 1024 * 1024 /* 10MB，支持 base64 参考图 */);
        const error = await validateGenerationCreateRequest(body);
        if (error) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error });
        try {
          const data = await generationsService.createTask(userId, body);
          // 创建任务会扣费并改变任务列表，必须主动清理余额和任务列表缓存。
          invalidateWalletCache([`user:${userId}`]);
          invalidateTaskCache([data.task.id], [`task-list:user:${userId}`]);
          return sendJson(res, 202, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendGenerationError(res, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/generate/recover',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const body = await readJsonBody<GenerationRecoverRequest>(req);
        if (!validateRecoverClientRequestId(body.clientRequestId)) {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'clientRequestId 格式不正确' });
        }
        try {
          const data = await generationsService.recoverTask(userId, body.clientRequestId);
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendGenerationError(res, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/generate/retry',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const body = await readJsonBody<GenerationRetryRequest>(req);
        if (typeof body.taskId !== 'string' || !/^[a-zA-Z0-9:_-]{1,64}$/.test(body.taskId)) {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '任务 ID 不正确' });
        }
        try {
          const data = await generationsService.retryTask(userId, body.taskId);
          // 复投创建了新任务并重新扣费，需要刷新余额、任务列表和新旧任务详情缓存。
          invalidateWalletCache([`user:${userId}`]);
          invalidateTaskCache([body.taskId, data.task.id], [`task-list:user:${userId}`]);
          return sendJson(res, 202, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendGenerationError(res, error);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/generations',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const url = new URL(req.url ?? '/', 'http://localhost');
        const page = Number(url.searchParams.get('page') ?? '1');
        const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
        const status = url.searchParams.get('status') ?? undefined;
        const cached = await cacheUserGenerationList(userId, { page, pageSize, status }, () => generationsService.listTasks(userId, page, pageSize, status));
        setBackendCacheHeader(res, cached.status);
        const data = cached.value;
        return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
      },
    },
    {
      method: 'GET',
      path: '/api/generations/cooldown',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const data = await generationsService.getCooldownStatus(userId);
        return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<GenerationCooldownResponse>);
      },
    },
    {
      method: 'GET',
      path: '/api/generations/tasks',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const url = new URL(req.url ?? '/', 'http://localhost');
        const ids = parseTaskIdsQuery(url.searchParams.get('ids'));
        const sortedIds = [...ids].sort();
        const cached = await cacheUserTasks(userId, sortedIds, () => generationsService.findTasks(userId, sortedIds));
        setBackendCacheHeader(res, cached.status);
        const data = cached.value;
        return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
      },
    },
    /** 内部接口：bot-service 轮询任务状态（服务间 token 鉴权） */
    {
      method: 'GET',
      path: '/internal/generations/tasks',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const ids = parseTaskIdsQuery(url.searchParams.get('ids'));
        const sortedIds = [...ids].sort();
        const cached = await cacheInternalTasks(sortedIds, () => generationsService.findTasks(null, sortedIds));
        setBackendCacheHeader(res, cached.status);
        const missingIds = sortedIds.filter((id) => !cached.value.tasks.some((task) => task.id === id));
        // 独立平台任务不复制进主站任务表；Bot 轮询时只把缺失 ID 的受保护状态快照合并进统一响应。
        const localJobs = await queryLocalPlatformBotJobs(missingIds);
        const data = { tasks: [...cached.value.tasks, ...localJobs] };
        return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
      },
    },
    {
      method: 'POST',
      path: '/internal/generations/sub-tasks',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody<unknown>(req);
        if (!validateAppendSubTaskRequest(body)) {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '子任务写入请求格式不正确' });
        }
        try {
          const data = await generationsService.appendSubTask(body);
          // 子任务变化会影响轮询卡片、后台详情和最终状态展示。
          invalidateTaskCache([body.taskId]);
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendGenerationError(res, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/internal/generations/status',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody<unknown>(req);
        if (!validateUpdateTaskStatusRequest(body)) {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '主任务状态更新请求格式不正确' });
        }
        try {
          const data = await generationsService.updateTaskStatus(body);
          // 状态写入是轮询缓存最关键的失效点；失败状态可能退款，因此同时清理余额缓存。
          invalidateTaskCache([body.taskId]);
          if (body.status === 'failed') invalidateWalletCache();
          // 成功任务已有本地图片即可进入公开图库；公开图库允许先返回 stale 旧列表并后台刷新，避免新图高峰打穿首屏缓存。
          if (body.status === 'success') invalidateGalleryCache([`image:${body.taskId}`], { soft: true });
          if (body.status === 'success' || body.status === 'finalizing') invalidateImageCache(body.taskId);
          return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<typeof data>);
        } catch (error) {
          return sendGenerationError(res, error);
        }
      },
    },
    /** 批量设置生成记录私密状态。 */
    {
      method: 'PATCH',
      path: '/api/generations/privacy',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const body = await readJsonBody<{ ids: string[]; isPrivate: boolean }>(req);
        if (!Array.isArray(body.ids) || body.ids.length === 0 || typeof body.isPrivate !== 'boolean') {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '参数不正确' });
        }
        try {
          const { getPrismaClient } = await import('../../infrastructure/database/prisma-client.js');
          const prisma = getPrismaClient();
          const taskIds = await expandUserVisibleTaskIds(userId, body.ids);
          const result = await prisma.generationTask.updateMany({
            where: { id: { in: taskIds }, userId },
            data: { isPrivate: body.isPrivate },
          });
          invalidateTaskCache(taskIds, [`task-list:user:${userId}`]);
          invalidateGalleryCache([...taskIds.map((id) => `image:${id}`), ...body.ids.map((id) => `image:${id}`)]);
          return sendJson(res, 200, { ok: true, data: { updated: result.count } });
        } catch (error) {
          return sendGenerationError(res, error);
        }
      },
    },
    /** 批量删除生成记录。 */
    {
      method: 'DELETE',
      path: '/api/generations',
      handle: async (req, res) => {
        const userId = authenticateUser(req);
        if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
        const body = await readJsonBody<{ ids: string[] }>(req);
        if (!Array.isArray(body.ids) || body.ids.length === 0) {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '参数不正确' });
        }
        try {
          const { getPrismaClient } = await import('../../infrastructure/database/prisma-client.js');
          const prisma = getPrismaClient();
          const taskIds = await expandUserVisibleTaskIds(userId, body.ids);
          // 本地模型作品发布在独立平台也有记录；先完成受保护同步，失败时不执行单边删除。
          await synchronizeLocalPlatformTaskDeletion(taskIds);
          // 只删除自己的记录
          const result = await prisma.generationTask.deleteMany({
            where: { id: { in: taskIds }, userId },
          });
          invalidateTaskCache(taskIds, [`task-list:user:${userId}`]);
          invalidateGalleryCache([...taskIds.map((id) => `image:${id}`), ...body.ids.map((id) => `image:${id}`)]);
          return sendJson(res, 200, { ok: true, data: { deleted: result.count } });
        } catch (error) {
          return sendGenerationError(res, error);
        }
      },
    },
  ];
}

/** 校验用户 JWT，返回用户 id；失败时由路由层转为 401。 */
function authenticateUser(req: IncomingMessage) {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    return verifyAccessToken(token).sub;
  } catch {
    return undefined;
  }
}

/** 校验服务间 token；仅显式开发或测试环境允许缺省调试。 */
function verifyServiceToken(req: IncomingMessage) {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

/** 展开用户可见生成 ID；批次外显 ID 会展开为整批真实任务。 */
async function expandUserVisibleTaskIds(userId: number, ids: string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const { getPrismaClient } = await import('../../infrastructure/database/prisma-client.js');
  const prisma = getPrismaClient();
  const batchRows = await prisma.generationTask.findMany({
    where: {
      batchId: { in: uniqueIds },
      userId,
    },
    select: { id: true, batchId: true },
    orderBy: [{ batchId: 'asc' }, { id: 'asc' }],
  });
  const grouped = new Map<string, string[]>();
  for (const row of batchRows) {
    if (!row.batchId) continue;
    const list = grouped.get(row.batchId) ?? [];
    list.push(row.id);
    grouped.set(row.batchId, list);
  }
  return uniqueIds.flatMap((id) => grouped.get(id) ?? [id]);
}

/** 将生成任务业务错误映射为 HTTP 响应。 */
function sendGenerationError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof QuotaError) {
    return sendJson(res, 402, { ok: false, code: 'insufficient_balance' as ApiErrorCode, message: error.message });
  }
  if (error instanceof WalletError) {
    const status = error.kind === 'insufficient_balance' ? 402 : error.kind === 'conflict' ? 409 : 400;
    const code = error.kind === 'insufficient_balance' ? 'insufficient_balance' as ApiErrorCode
      : error.kind === 'conflict' ? ApiErrorCode.Conflict
      : ApiErrorCode.BadRequest;
    return sendJson(res, status, { ok: false, code, message: error.message });
  }
  if (!(error instanceof GenerationError)) throw error;
  if (error.kind === 'not_bound' || error.kind === 'forbidden') {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: error.message });
  }
  if (error.kind === 'not_found') {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: error.message });
  }
  if (error.kind === 'invalid_request') {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error.message });
  }
  if (error.kind === 'drawing_service_unavailable') {
    return sendJson(res, 503, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: error.message });
  }
  if (error.kind === 'cooldown' || error.kind === 'blocked') {
    return sendJson(res, 429, { ok: false, code: ApiErrorCode.RateLimited, message: error.message });
  }
  return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: '生成任务处理失败' });
}
