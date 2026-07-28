/**
 * 本文件注册 notification-worker 的运行态路由。
 * Worker 主循环当前阶段由外部事件驱动（backend 触发），后续可接入定时轮询。
 */
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { emailService } from '../modules/email/email-service.js';
import type { IncomingMessage } from 'node:http';

/** Worker 统计计数器，通过 /worker/status 暴露。 */
const workerStats = {
  emailsSent: 0,
  emailsFailed: 0,
  botNotificationsSent: 0,
  botNotificationsFailed: 0,
};

/** 创建 notification-worker 专用路由。 */
export function createNotificationWorkerRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/worker/status',
      handle: async (_req, res) => {
        return sendJson(res, 200, { ok: true, data: workerStats });
      },
    },
    /**
     * POST /internal/send-email
     * backend 通过内部接口投递邮件发送任务。
     */
    {
      method: 'POST',
      path: '/internal/send-email',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
        }
        try {
          const body = await readJsonBody(req);
          const type = String(body.type ?? '');
          const to = String(body.to ?? '');
          const url = String(body.url ?? '');
          const idempotencyKey = String(body.idempotencyKey ?? '');

          if (!to || !idempotencyKey) {
            return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '缺少必填字段' });
          }

          if (type === 'verification') {
            await emailService.sendVerificationEmail(to, url, idempotencyKey);
          } else if (type === 'password-reset') {
            await emailService.sendPasswordResetEmail(to, url, idempotencyKey);
          } else {
            return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '不支持的邮件类型' });
          }

          workerStats.emailsSent++;
          return sendJson(res, 200, { ok: true, data: { sent: true } });
        } catch (error) {
          workerStats.emailsFailed++;
          const message = error instanceof Error ? error.message : '邮件发送失败';
          return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message });
        }
      },
    },
  ];
}

/** 校验服务间 token。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

/** 读取 JSON 请求体。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}
