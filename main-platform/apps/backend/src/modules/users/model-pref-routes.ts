/**
 * 本文件注册用户模型偏好读写路由。
 * Bot /模型 命令通过本接口查询和保存默认模型。
 */
import type { IncomingMessage } from 'node:http';
import {
  ApiErrorCode,
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
} from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { invalidateUserCache, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheUserModelPref } from '../../shared/cache/cache-policies.js';
import { readEnabledModelNames } from '../generations/generation-model-utils.js';
import { resolveConfiguredModelName } from '../generations/model-settings-service.js';

const prisma = getPrismaClient();

export function createModelPrefRoutes(): Route[] {
  return [
    /** 查询用户模型偏好（Web JWT 或按 QQ 号）。 */
    { method: 'GET', path: '/api/user-model-pref', handle: getPref },
    /** 保存用户模型偏好。 */
    { method: 'POST', path: '/api/user-model-pref', handle: savePref },
    /** 内部接口：按 QQ 号查询偏好。 */
    { method: 'GET', path: '/internal/user-model-pref/:qqNumber', handle: getPrefByQq },
    /** 内部接口：按 QQ 号保存偏好，供 Bot /模型 命令持久化默认模型。 */
    { method: 'POST', path: '/internal/user-model-pref/:qqNumber', handle: savePrefByQq },
  ];
}

/** Web 用户按 JWT 查询偏好。 */
async function getPref(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });

  const cached = await cacheUserModelPref(user.sub, () => resolveWebModelPreference(user.sub));
  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: cached.value });
}

/** Web 用户按 JWT 保存偏好。 */
async function savePref(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });

  const body = await readJsonBody<UpdateUserModelPreferenceRequest>(req);
  const requestedModel = String(body.model ?? '').trim();
  if (!requestedModel || requestedModel.length > 64) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '模型名不能为空且不超过 64 字符' });
  }

  const [enabledModels, model] = await Promise.all([
    readEnabledModelNames(prisma),
    resolveConfiguredModelName(prisma, requestedModel),
  ]);
  if (!model || !enabledModels.has(model)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '模型不存在或未启用' });
  }

  await prisma.userModelPref.upsert({
    where: { userId: user.sub },
    update: { model },
    create: { userId: user.sub, model },
  });

  // 模型偏好影响生成页默认模型和后续提交参数，保存后必须清理用户级缓存。
  invalidateUserCache(user.sub);
  return sendJson(res, 200, { ok: true, data: { model, saved: true } });
}

/** 解析网页模型偏好；旧用户没有显式偏好时从最新网页任务的真实调度快照恢复。 */
async function resolveWebModelPreference(userId: number): Promise<UserModelPreferenceResponse> {
  const enabledModels = await readEnabledModelNames(prisma);
  const pref = await prisma.userModelPref.findUnique({ where: { userId } });
  const preferredModel = pref?.model ? await resolveConfiguredModelName(prisma, pref.model) : undefined;
  if (preferredModel && enabledModels.has(preferredModel)) {
    return { model: preferredModel, source: 'preference' };
  }

  const latestTask = await prisma.generationTask.findFirst({
    where: { userId, source: 'web' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      subTasks: {
        where: { model: { not: null } },
        orderBy: { sequence: 'desc' },
        take: 1,
        select: { model: true },
      },
    },
  });
  if (!latestTask) return { model: null, source: 'none' };

  const snapshot = await prisma.systemConfig.findUnique({
    where: { key: buildTaskGenerationParamsKey(latestTask.id) },
    select: { value: true },
  });
  const snapshotModel = readModelFromTaskSnapshot(snapshot?.value);
  const lastTaskModel = snapshotModel ?? latestTask.subTasks[0]?.model ?? null;
  const resolvedLastTaskModel = lastTaskModel ? await resolveConfiguredModelName(prisma, lastTaskModel) : undefined;
  return resolvedLastTaskModel && enabledModels.has(resolvedLastTaskModel)
    ? { model: resolvedLastTaskModel, source: 'last_task' }
    : { model: null, source: 'none' };
}

/** 从任务调度 JSON 快照读取模型；历史损坏配置只触发子任务回退，不影响页面加载。 */
function readModelFromTaskSnapshot(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 构造网页任务调度参数快照键，与生成仓储写入规则保持一致。 */
function buildTaskGenerationParamsKey(taskId: string) {
  return `task_generation_params_${taskId}`;
}

/** Bot 内部接口：按 QQ 号查询偏好。 */
async function getPrefByQq(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const qqStr = params?.qqNumber ?? '';
  if (!/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }
  const qqNumber = BigInt(qqStr);

  const pref = await prisma.userModelPref.findUnique({ where: { qqNumber } });
  const model = pref?.model ? await resolveConfiguredModelName(prisma, pref.model) : undefined;
  return sendJson(res, 200, { ok: true, data: { model: model ?? null } });
}

/** Bot 内部接口：按 QQ 号保存模型偏好。 */
async function savePrefByQq(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const qqStr = params?.qqNumber ?? '';
  if (!/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }

  const body = await readJsonBody<{ model?: string }>(req);
  const requestedModel = String(body.model ?? '').trim();
  if (!requestedModel || requestedModel.length > 64) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '模型名不能为空且不超过 64 字符' });
  }

  const [enabledModels, model] = await Promise.all([
    readEnabledModelNames(prisma),
    resolveConfiguredModelName(prisma, requestedModel),
  ]);
  if (!model || !enabledModels.has(model)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '模型不存在或未启用' });
  }

  const qqNumber = BigInt(qqStr);
  await prisma.userModelPref.upsert({
    where: { qqNumber },
    update: { model },
    create: { qqNumber, model },
  });

  // QQ 模型偏好会影响 Bot 后续未指定 m 序号的调度，必须落库后返回真实保存值。
  return sendJson(res, 200, { ok: true, data: { model, saved: true } });
}

function authenticateUser(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token); } catch { return undefined; }
}

function verifyServiceToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  const token = String(req.headers['x-service-token'] ?? '').trim();
  return token === expected;
}
