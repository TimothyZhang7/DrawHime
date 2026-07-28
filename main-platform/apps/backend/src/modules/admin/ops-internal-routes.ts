/**
 * 本文件注册运维 Worker 调用的内部接口：超时任务查询和修复、模块管理。
 * 所有接口需要服务间 token。
 */
import type { IncomingMessage } from 'node:http';
import {
  ApiErrorCode,
} from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { GenerationsService } from '../generations/generations-service.js';

const prisma = getPrismaClient();
const generationsService = new GenerationsService();

/** 超时阈值分钟数：超过此时间的 queued/running 或无最终图 finalizing 任务被认为是 stale。 */
const STALE_MINUTES = 30;

export function createOpsInternalRoutes(): Route[] {
  return [
    { method: 'GET', path: '/internal/ops/stale-tasks', handle: getStaleTasks },
    { method: 'POST', path: '/internal/ops/repair-stale-task', handle: repairStaleTask },
    /** Ops-worker 定期调用：查询仍需保留在 media-service 本地暂存里的图片文件名。 */
    { method: 'GET', path: '/internal/ops/protected-media-files', handle: getProtectedMediaFiles },
    /** Ops-worker 定期调用：POST 版本允许提交大量本地候选文件名，避免 URL 过长。 */
    { method: 'POST', path: '/internal/ops/protected-media-files', handle: getProtectedMediaFiles },
    /** Ops-worker 定期调用：清理已过期的 wsproxy 端点 */
    { method: 'POST', path: '/internal/cleanup-expired-endpoints', handle: cleanupEndpoints },
  ];
}

/** 查询超时任务列表（供 ops-worker 修复使用）；已有最终图的 Bot finalizing 由补发链路处理，不能误判失败。 */
async function getStaleTasks(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);
  const tasks = await prisma.generationTask.findMany({
    where: {
      OR: [
        // queued 超时代表任务已扣费但长期未被 Worker 抢占，需要失败退款并释放/结束批次。
        { status: 'queued', updatedAt: { lt: cutoff } },
        { status: 'running', updatedAt: { lt: cutoff } },
        // finalizing 若没有最终图配置，Bot 无法补发，应按超时失败处理；有图的 finalizing 继续交给 Bot 恢复投递。
        { status: 'finalizing', updatedAt: { lt: cutoff } },
      ],
    },
    select: { id: true, status: true, updatedAt: true },
    take: 100,
  });
  const finalizingIds = tasks.filter((task) => task.status === 'finalizing').map((task) => task.id);
  const imageRows = finalizingIds.length > 0
    ? await prisma.systemConfig.findMany({
      where: { key: { in: finalizingIds.map((taskId) => `task_image_${taskId}`) } },
      select: { key: true },
    })
    : [];
  const finalizingWithImage = new Set(imageRows.map((row) => row.key.replace('task_image_', '')));
  const taskIds = tasks
    .filter((task) => task.status !== 'finalizing' || !finalizingWithImage.has(task.id))
    .map((task) => task.id);
  return sendJson(res, 200, { ok: true, data: { taskIds } });
}

/** 修复单个超时任务：标记 queued/running/无最终图 finalizing 为 failed 并追加 timeout 子任务。 */
async function repairStaleTask(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const body = await readJsonBody(req);
  const taskId = String(body.taskId ?? '');
  if (!taskId) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少任务 ID' });

  const task = await prisma.generationTask.findUnique({ where: { id: taskId }, select: { id: true, status: true } });
  if (!task || (task.status !== 'queued' && task.status !== 'running' && task.status !== 'finalizing')) {
    return sendJson(res, 200, { ok: true, data: { repaired: false, reason: '任务不存在或已结束' } });
  }
  if (task.status === 'finalizing') {
    const imageConfig = await prisma.systemConfig.findUnique({ where: { key: `task_image_${taskId}` }, select: { key: true } });
    if (imageConfig) {
      // 有最终图的 Bot finalizing 仍可能只是消息 ACK 缺失，不能退款失败，交给 Bot 恢复补发/补确认。
      return sendJson(res, 200, { ok: true, data: { repaired: false, reason: '任务已有最终图，等待 Bot 投递恢复' } });
    }
  }

  const now = new Date();
  await generationsService.updateTaskStatus({ taskId, status: 'failed', error: '任务超时，已自动标记为失败' });
  await generationsService.appendSubTask({
    taskId,
    kind: 'finalize',
    status: 'failed',
    error: '任务超时自动修复',
    finishedAt: now.toISOString(),
  });

  return sendJson(res, 200, { ok: true, data: { repaired: true, taskId } });
}

/** 查询仍被运行中任务或近期完成任务引用的本地媒体文件，供 media-service 清理时跳过。 */
async function getProtectedMediaFiles(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const body: Record<string, unknown> = req.method === 'POST' ? await readJsonBody(req).catch(() => ({})) : {};
  const completedGraceMinutes = Math.max(1, Number(body.completedGraceMinutes ?? url.searchParams.get('completedGraceMinutes') ?? process.env.MEDIA_COMPLETED_LOCAL_PROTECT_MINUTES ?? '30'));
  const limit = Math.max(100, Math.min(10000, Number(body.limit ?? url.searchParams.get('limit') ?? process.env.MEDIA_PROTECTED_TASK_LIMIT ?? '3000')));
  const cutoff = new Date(Date.now() - completedGraceMinutes * 60 * 1000);

  const tasks = await prisma.generationTask.findMany({
    where: {
      OR: [
        { status: { in: ['queued', 'running', 'finalizing'] } },
        { status: { in: ['success', 'failed'] }, updatedAt: { gte: cutoff } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true, status: true, sourceImageUrls: true },
  });

  const filenames = new Set<string>();
  for (const task of tasks) {
    if (task.status === 'queued' || task.status === 'running' || task.status === 'finalizing') {
      // 本地文件是唯一副本；未结束任务参考图必须继续保护。
      addFilenamesFromUnknown(task.sourceImageUrls, filenames);
    }
  }

  const imageTaskIds = tasks.map((task) => task.id);
  const activeTaskIds = tasks
    .filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'finalizing')
    .map((task) => task.id);
  if (imageTaskIds.length > 0 || activeTaskIds.length > 0) {
    const keys = [
      ...imageTaskIds.map((taskId) => `task_image_${taskId}`),
      // 本地媒体是唯一副本；终态参考图不参与自动删除。
      ...activeTaskIds.map((taskId) => `task_ref_images_${taskId}`),
    ];
    const configs = await prisma.systemConfig.findMany({
      where: { key: { in: keys } },
      select: { value: true },
    });
    for (const config of configs) {
      addFilenamesFromConfigValue(config.value, filenames);
    }
  }
  const deletableArchivedFilenames: string[] = [];

  return sendJson(res, 200, {
    ok: true,
    data: {
      filenames: [...filenames],
      deletableArchivedFilenames: [...deletableArchivedFilenames],
      taskCount: tasks.length,
      completedGraceMinutes,
    },
  });
}

/** 清理已过期的 wsproxy 端点记录。由 ops-worker 每 10 分钟触发。 */
async function cleanupEndpoints(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const result = await prisma.wsProxyEndpoint.deleteMany({
    where: {
      // 只清理从未测试成功、也未绑定 self_id 的临时端点；已使用端点是 OneBot 反向 WebSocket 的长期凭据，离线重连必须继续可用。
      used: false,
      usedBySelfId: null,
      expiresAt: { lt: new Date() },
    },
  });
  return sendJson(res, 200, { ok: true, data: { deleted: result.count } });
}

/** 从 system_config 的 JSON 字符串中提取任务图片、缩略图和参考图短文件名。 */
function addFilenamesFromConfigValue(value: string, target: Set<string>): void {
  try {
    addFilenamesFromUnknown(JSON.parse(value), target);
  } catch {
    // 配置损坏时跳过，不能影响清理任务整体执行。
  }
}

/** 从任意 JSON 值中递归提取站内图片短文件名。 */
function addFilenamesFromUnknown(value: unknown, target: Set<string>): void {
  if (typeof value === 'string') {
    const filename = extractMediaFilename(value);
    if (filename) target.add(filename);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addFilenamesFromUnknown(item, target);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of ['imageFilename', 'thumbnailFilename', 'filename']) addFilenamesFromUnknown(record[key], target);
}

/** 支持 /images/name、/api/images/name、历史远端直链和纯短文件名，输出安全短文件名。 */
function extractMediaFilename(value: string): string {
  const text = value.trim();
  if (!text) return '';
  let candidate = text;
  try {
    const parsed = new URL(text, 'https://www.xanime.ink');
    candidate = parsed.pathname.split('/').pop() ?? '';
  } catch {
    candidate = text.split(/[?#]/, 1)[0] ?? '';
  }
  if (/^[a-zA-Z0-9_.-]{1,128}$/.test(candidate) && !candidate.includes('..')) return candidate;
  return '';
}

function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}
