/** 本文件负责校验 wsproxy 端点管理和内部登记接口的请求体。 */
import type { WsproxyClaimEndpointRequest, WsproxyMarkBotSeenRequest } from '@aiimage/shared-contracts';

/** 动态端点后缀只允许 URL 路径安全字符，避免目录穿越或路由混淆。 */
export function isValidPathSuffix(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{12,32}$/.test(value);
}

/** 校验 wsproxy-service 建连 claim 请求体。 */
export function validateClaimEndpointRequest(body: unknown): body is WsproxyClaimEndpointRequest {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Partial<WsproxyClaimEndpointRequest>;
  return isValidPathSuffix(candidate.pathSuffix)
    && typeof candidate.accessToken === 'string'
    && candidate.accessToken.length >= 24
    && candidate.accessToken.length <= 128;
}

/** 校验 wsproxy-service 上报 Bot 活跃状态请求体。 */
export function validateMarkBotSeenRequest(body: unknown): body is WsproxyMarkBotSeenRequest {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Partial<WsproxyMarkBotSeenRequest>;
  const pathOk = candidate.pathSuffix === undefined || isValidPathSuffix(candidate.pathSuffix);
  return pathOk && Number.isSafeInteger(candidate.selfId) && Number(candidate.selfId) > 0;
}
