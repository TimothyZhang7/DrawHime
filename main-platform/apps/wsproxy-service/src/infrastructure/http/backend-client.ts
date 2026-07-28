/** 本文件封装 wsproxy-service 调用 backend 内部 wsproxy 端点接口的 HTTP 客户端。 */
import type {
  ApiDataResponse,
  WsproxyClaimEndpointRequest,
  WsproxyClaimEndpointResponse,
  WsproxyMarkBotSeenRequest,
  WsproxyMarkBotSeenResponse,
} from '@aiimage/shared-contracts';

/** backend 内部接口地址，默认使用本地开发端口。 */
const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';

/** 判断 backend claim 响应是否符合共享契约。 */
function isClaimResponse(value: unknown): value is ApiDataResponse<WsproxyClaimEndpointResponse> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<WsproxyClaimEndpointResponse>>;
  return response.ok === true
    && typeof response.data === 'object'
    && response.data !== null
    && response.data.accepted === true
    && typeof response.data.endpointId === 'number'
    && typeof response.data.userId === 'number'
    && typeof response.data.pathSuffix === 'string';
}

/** 判断 backend Bot 活跃登记响应是否符合共享契约。 */
function isMarkBotSeenResponse(value: unknown): value is ApiDataResponse<WsproxyMarkBotSeenResponse> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<WsproxyMarkBotSeenResponse>>;
  return response.ok === true && typeof response.data === 'object' && response.data !== null && response.data.accepted === true;
}

/** 调用 backend 校验动态 wsproxy 端点，失败时抛出中文错误供连接层拒绝建连。 */
export async function claimWsproxyEndpoint(request: WsproxyClaimEndpointRequest): Promise<WsproxyClaimEndpointResponse> {
  const body = await requestBackend('/internal/wsproxy/claim-endpoint', request);
  if (!isClaimResponse(body)) {
    throw new Error('backend 返回的 wsproxy 端点校验响应不正确');
  }
  return body.data;
}

/** 通知 backend Bot 已离线（WebSocket 断开或心跳超时），异步调用不阻断主流程。 */
export async function notifyBotOffline(selfId: number): Promise<void> {
  try {
    await fetch(`${BACKEND_INTERNAL_URL}/internal/bot/offline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ selfId }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* 通知失败不影响连接清理 */ }
}

/** 调用 backend 登记 Bot self_id 活跃状态；失败由连接层记录，不阻断消息投递。 */
export async function markWsproxyBotSeen(request: WsproxyMarkBotSeenRequest & { nickname?: string }): Promise<WsproxyMarkBotSeenResponse> {
  const body = await requestBackend('/internal/wsproxy/mark-bot-seen', request);
  if (!isMarkBotSeenResponse(body)) {
    throw new Error('backend 返回的 Bot 活跃登记响应不正确');
  }
  return body.data;
}

/** 统一封装 backend 内部 POST 调用，设置超时并携带服务间 token。 */
async function requestBackend(path: string, body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${BACKEND_INTERNAL_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 服务间 token 不写日志，只通过 header 传递给 backend 校验。
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`backend 内部接口调用失败：${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}
