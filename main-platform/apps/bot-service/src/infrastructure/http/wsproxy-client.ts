/** 本文件封装 bot-service 调用 wsproxy-service 状态接口的 HTTP 客户端。 */
import type { ApiDataResponse, WsproxyBotsResponse, WsproxyConnectionSummary } from '@aiimage/shared-contracts';

/** wsproxy-service 内部 HTTP 地址，默认指向 本地 wsproxy 服务。 */
const WSPROXY_SERVICE_URL = process.env.WSPROXY_SERVICE_URL ?? 'http://localhost:3011';

/** wsproxy-service 查询超时，避免 Bot 状态命令因连接层异常长时间无响应。 */
const WSPROXY_REQUEST_TIMEOUT_MS = 1500;

/** 校验单个 wsproxy 连接摘要，避免错误代理响应被当成在线 Bot 列表。 */
function isWsproxyConnectionSummary(value: unknown): value is WsproxyConnectionSummary {
  if (typeof value !== 'object' || value === null) return false;
  const connection = value as Partial<WsproxyConnectionSummary>;
  return typeof connection.connectionId === 'string'
    && (typeof connection.selfId === 'number' || typeof connection.selfId === 'undefined')
    && typeof connection.connectedAt === 'string'
    && typeof connection.lastSeenAt === 'string'
    && typeof connection.lastPongAt === 'string'
    && typeof connection.uptimeSec === 'number'
    && typeof connection.heartbeatWaitingPong === 'boolean'
    && typeof connection.heartbeatIntervalMs === 'number'
    && typeof connection.heartbeatMaxMisses === 'number'
    && connection.transport === 'websocket';
}

/** 校验 wsproxy 在线连接列表响应，确保调用方只处理共享契约字段。 */
function isWsproxyBotsResponse(value: unknown): value is ApiDataResponse<WsproxyBotsResponse> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<WsproxyBotsResponse>>;
  const data = response.data;
  return response.ok === true
    && typeof data === 'object'
    && data !== null
    && Array.isArray(data.items)
    && data.items.every(isWsproxyConnectionSummary)
    && typeof data.total === 'number';
}

/** 查询 wsproxy-service 当前进程内 OneBot WebSocket 在线连接列表。 */
export async function queryWsproxyBots(): Promise<WsproxyBotsResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WSPROXY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${WSPROXY_SERVICE_URL}/wsproxy/bots`, {
      method: 'GET',
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`wsproxy-service 在线列表查询失败：${response.status}`);
    }
    if (!isWsproxyBotsResponse(body)) {
      throw new Error('wsproxy-service 在线列表响应不正确');
    }
    return body.data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('wsproxy-service 在线列表查询超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
