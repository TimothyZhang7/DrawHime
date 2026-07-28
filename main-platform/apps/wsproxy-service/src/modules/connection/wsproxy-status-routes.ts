/** 本文件定义 wsproxy-service 当前 OneBot 连接状态查询路由 + 异步消息推送。 */
import { type ApiDataResponse, type OneBotWsActionRequest, type WsproxyBotsResponse, type WsproxyCallApiRequest, type WsproxyCallApiResponse } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import type { WsproxyConnectionService } from './wsproxy-connection-service.js';
import type { IncomingMessage } from 'node:http';

/** 创建 wsproxy 状态路由，当前返回进程内 WebSocket 连接快照。 */
export function createWsproxyStatusRoutes(connectionService: WsproxyConnectionService): Route[] {
  return [
    {
      method: 'GET',
      path: '/wsproxy/bots',
      handle: (_req, res) => {
        const items = connectionService.listConnections();
        const data: WsproxyBotsResponse = { items, total: items.length };
        sendJson(res, 200, { ok: true, data });
      },
    },
    /** 内部接口：断开指定 selfId 的所有 WebSocket 连接（解绑时调用）。 */
    {
      method: 'POST',
      path: '/internal/disconnect-bot',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody(req);
        const selfId = Number(body.selfId);
        if (!selfId) {
          return sendJson(res, 400, { ok: false, message: '缺少 selfId' });
        }
        const count = connectionService.disconnectBySelfId(selfId);
        sendJson(res, 200, { ok: true, data: { disconnected: count } });
      },
    },
    /** 同步 API 调用：bot-service 通过此接口向 OneBot 发送 API 并等待响应（如 get_msg 获取引用消息）。 */
    {
      method: 'POST',
      path: '/internal/call-api',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody(req) as Partial<WsproxyCallApiRequest>;
        const selfId = Number(body.selfId);
        const action = String(body.action ?? '');
        const params = (body.params ?? {}) as Record<string, unknown>;
        if (!selfId || !action) {
          return sendJson(res, 400, { ok: false, message: '缺少 selfId 或 action' });
        }
        try {
          // get_image 等协议端本地缓存解析可能慢于普通 API；超时由调用方显式传入并在这里限幅。
          const result = await connectionService.callApiOnConnection(selfId, action, params, readBoundedCallApiTimeoutMs(body.timeoutMs));
          sendJson(res, 200, { ok: true, data: { data: result } satisfies WsproxyCallApiResponse });
        } catch (err) {
          sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : 'API 调用失败' });
        }
      },
    },
    /** 异步消息推送：bot-service 完成任务后直接推送 action 到指定 QQ 连接，并等待 OneBot 明确回包。 */
    {
      method: 'POST',
      path: '/internal/send-action',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          return sendJson(res, 403, { ok: false, message: '服务间 token 不正确' });
        }
        const body = await readJsonBody(req);
        const selfId = Number(body.selfId);
        const action = body.action as OneBotWsActionRequest;
        if (!selfId || !action?.action) {
          return sendJson(res, 400, { ok: false, message: '缺少 selfId 或 action' });
        }
        const timeoutMs = readBoundedTimeoutMs(body.timeoutMs);
        try {
          // 最终图投递必须以真实 OneBot API 回包为准，不能只以 WebSocket 写入成功作为已送达。
          const result = await connectionService.callApiOnConnection(selfId, action.action, action.params ?? {}, timeoutMs);
          sendJson(res, 200, { ok: true, data: { sent: true, ack: true, result } });
        } catch (error) {
          sendJson(res, 200, {
            ok: true,
            data: {
              sent: false,
              ack: false,
              error: error instanceof Error ? error.message : 'OneBot 未确认发送成功',
            },
          });
        }
      },
    },
  ];
}

/** 读取内部直推等待 ACK 的超时，限制范围防止配置失误卡死 wsproxy 请求。 */
function readBoundedTimeoutMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return 45_000;
  return Math.min(Math.max(n, 3_000), 90_000);
}

/** 内部 OneBot API 调用超时，允许图片缓存解析更久，但避免请求无限挂起。 */
function readBoundedCallApiTimeoutMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return 5_000;
  return Math.min(Math.max(n, 3_000), 30_000);
}

function verifyServiceToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}
