/** 本文件定义 bot-service 接收 wsproxy-service OneBot 事件的内部 HTTP 路由。 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type ApiDataResponse, type OneBotWsEvent, type WsproxyDispatchEventRequest, type WsproxyDispatchEventResponse } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { handleWsproxyEvent } from './wsproxy-event-service.js';

/** 读取 JSON 请求体，限制 64KB，避免内部接口被异常大 payload 阻塞。 */
async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalLength += buffer.length;
    if (totalLength > 64 * 1024) {
      throw new Error('请求体超过 64KB');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** 校验服务间 token；仅显式开发或测试环境允许缺省调试。 */
function verifyServiceToken(req: IncomingMessage) {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

/** 判断请求体是否符合 wsproxy 事件投递契约。 */
function isDispatchRequest(value: unknown): value is WsproxyDispatchEventRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WsproxyDispatchEventRequest>;
  return typeof candidate.connectionId === 'string' && isOneBotWsEvent(candidate.event);
}

/** 校验 OneBot 事件的最小结构，详细业务字段由后续命令模块继续细化。 */
function isOneBotWsEvent(value: unknown): value is OneBotWsEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.post_type === 'meta_event') {
    return candidate.meta_event_type === 'lifecycle' && typeof candidate.self_id === 'number';
  }
  if (candidate.post_type === 'message') {
    return typeof candidate.self_id === 'number'
      && typeof candidate.message_id === 'number'
      && typeof candidate.user_id === 'number'
      && Array.isArray(candidate.message)
      && (candidate.message_type === 'private' || candidate.message_type === 'group');
  }
  if (candidate.post_type === 'request') {
    // 请求事件是 OneBot 标准事件，需要进入 bot-service 执行自动审批动作。
    if (typeof candidate.self_id !== 'number' || typeof candidate.user_id !== 'number' || typeof candidate.flag !== 'string') {
      return false;
    }
    if (candidate.request_type === 'friend') return true;
    if (candidate.request_type === 'group') {
      return typeof candidate.group_id === 'number' && typeof candidate.sub_type === 'string' && candidate.sub_type.length > 0;
    }
  }
  return false;
}

/** 创建 wsproxy 事件投递路由，供 wsproxy-service 调用。 */
export function createWsproxyEventRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/internal/onebot/events',
      handle: async (req, res) => {
        if (!verifyServiceToken(req)) {
          sendJson(res, 403, {
            ok: false,
            code: ApiErrorCode.Forbidden,
            message: '服务间 token 不正确',
          });
          return;
        }

        try {
          const body = await readJsonBody(req);
          if (!isDispatchRequest(body)) {
            sendJson(res, 400, {
              ok: false,
              code: ApiErrorCode.BadRequest,
              message: 'OneBot 事件投递请求格式不正确',
            });
            return;
          }
          const actions = await handleWsproxyEvent(body.event);
          const data: WsproxyDispatchEventResponse = {
            accepted: true,
            actions,
          };
          const response: ApiDataResponse<WsproxyDispatchEventResponse> = { ok: true, data };
          sendJson(res, 200, response);
        } catch (error) {
          console.error('[bot-service] wsproxy event failed', error);
          sendJson(res, 400, {
            ok: false,
            code: ApiErrorCode.BadRequest,
            message: 'OneBot 事件投递请求无法解析',
          });
        }
      },
    },
  ];
}
