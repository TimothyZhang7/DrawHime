/**
 * 本文件注册 drawing-worker 的运行态路由：任务执行、状态查询。
 * Drawing-service 可通过 /internal/execute-task 直接推送任务，减少 2s 轮询延迟。
 */
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { workerHealth, isWorkerRunning, enqueuePushedTask, getPushQueueSize } from './drawing-worker-loop.js';
import type { DrawingGenerateRequest } from '@aiimage/shared-contracts';
import type { IncomingMessage } from 'node:http';

/** 创建 drawing-worker 专用路由。 */
export function createDrawingWorkerRoutes(): Route[] {
  return [
    /**
     * POST /internal/execute-task
     * Drawing-service 推送任务到 Worker（push 模式，减少轮询延迟）。
     * Worker 不会等待任务完成，仅入队后立即返回。
     */
    {
      method: 'POST',
      path: '/internal/execute-task',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        try {
          const body = await readJsonBody(req);
          const task = body as unknown as DrawingGenerateRequest;
          // QQ 号只对 Bot 任务必填；未绑定 QQ 的 Web 任务使用 userId 归属。
          if (!task.taskId || !task.prompt || !task.mode || (task.source === 'bot' && !task.qqNumber)) {
            return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少必填字段（taskId/prompt/mode，Bot 任务还需要 qqNumber）' });
          }
          const enqueued = enqueuePushedTask(task);
          return sendJson(res, 200, {
            ok: true,
            data: { enqueued, taskId: task.taskId },
          });
        } catch {
          return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请求体格式不正确' });
        }
      },
    },
    /**
     * GET /worker/status
     * 返回 Worker 运行状态和任务处理统计。
     */
    {
      method: 'GET',
      path: '/worker/status',
      handle: async (_req, res) => {
        return sendJson(res, 200, {
          ok: true,
          data: {
            running: isWorkerRunning(),
            health: workerHealth,
            pushQueueSize: getPushQueueSize(),
          },
        });
      },
    },
  ];
}

/** 校验服务间 token。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  const token = String(req.headers['x-service-token'] ?? '').trim();
  return token === expected;
}

/** 读取 JSON 请求体。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}
