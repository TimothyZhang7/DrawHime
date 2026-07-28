/** 本文件封装 wsproxy-service 调用 bot-service 的内部 HTTP 客户端。 */
import { type ApiDataResponse, type OneBotWsActionRequest, type WsproxyDispatchEventRequest, type WsproxyDispatchEventResponse } from '@aiimage/shared-contracts';

/** bot-service 内部事件投递地址，默认使用本地开发端口。 */
const BOT_SERVICE_URL = process.env.BOT_SERVICE_URL ?? 'http://localhost:3004';
/** Bot 绘图事件可能包含 QQ 参考图解析和本地化，投递等待窗口必须可配置，避免提交回执被过早取消。 */
const BOT_SERVICE_DISPATCH_TIMEOUT_MS = Math.max(15_000, Number(process.env.BOT_SERVICE_DISPATCH_TIMEOUT_MS ?? '45000'));

/** 判断 bot-service 返回体是否符合事件投递响应契约。 */
function isDispatchResponse(value: unknown): value is ApiDataResponse<WsproxyDispatchEventResponse> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<WsproxyDispatchEventResponse>>;
  return response.ok === true
    && typeof response.data === 'object'
    && response.data !== null
    && response.data.accepted === true
    && Array.isArray(response.data.actions);
}

/** 将 OneBot 事件投递给 bot-service，并返回需要回写协议端的动作列表。 */
export async function dispatchOneBotEventToBotService(request: WsproxyDispatchEventRequest): Promise<OneBotWsActionRequest[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOT_SERVICE_DISPATCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${BOT_SERVICE_URL}/internal/onebot/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 服务间 token 不写入日志，只通过 header 传给 bot-service 校验。
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isDispatchResponse(body)) {
      throw new Error(`bot-service 事件投递失败：${response.status}`);
    }
    return body.data.actions;
  } finally {
    clearTimeout(timeout);
  }
}
