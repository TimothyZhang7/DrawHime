/** 本文件封装 bot-service 调用 backend 内部接口的 HTTP 客户端。 */
import {
  type ApiDataResponse,
  type BotAdminRuntimeConfig,
  type BotRechargeRedeemRequest,
  type BotGenerationStatsResponse,
  type HealthResponse,
  type QqBalanceQueryRequest,
  type QqBalanceQueryResponse,
  type QqTouchRequest,
  type QqTouchResponse,
  type QqVerifyBindingRequest,
  type QqVerifyBindingResponse,
  type RechargeRedeemResponse,
} from '@aiimage/shared-contracts';

/** backend 内部接口地址，默认指向 本地 backend。 */
const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';

/** backend 内部调用默认超时，避免 Bot 命令因 backend 异常长时间无响应。 */
const BACKEND_REQUEST_TIMEOUT_MS = 3000;

/** backend 健康检查超时，避免 `/ping` 因依赖异常长时间卡住。 */
const BACKEND_HEALTH_TIMEOUT_MS = 1500;

/** 判断 backend 健康检查响应是否符合共享健康契约。 */
function isBackendHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<HealthResponse>;
  return response.ok === true
    && response.service === 'backend'
    && typeof response.version === 'string'
    && typeof response.uptimeSec === 'number';
}

/** 判断 backend QQ 绑定验证响应是否符合共享契约。 */
function isQqVerifyBindingResponse(value: unknown): value is ApiDataResponse<QqVerifyBindingResponse> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<QqVerifyBindingResponse>>;
  const data = response.data;
  return response.ok === true
    && typeof data === 'object'
    && data !== null
    && data.verified === true
    && typeof data.qqNumber === 'string'
    && typeof data.balance === 'object'
    && data.balance !== null
    && typeof data.balance.paidBalance === 'string';
}

/** 判断 backend QQ 余额查询响应是否符合共享契约。 */
function isQqBalanceQueryResponse(value: unknown): value is ApiDataResponse<QqBalanceQueryResponse> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<QqBalanceQueryResponse>>;
  const data = response.data;
  return response.ok === true
    && typeof data === 'object'
    && data !== null
    && typeof data.qqNumber === 'string'
    && typeof data.paidBalance === 'string'
    && typeof data.freeBalance === 'string';
}

/** 判断 backend QQ 触达建档响应是否符合共享契约。 */
function isQqTouchResponse(value: unknown): value is ApiDataResponse<QqTouchResponse> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<QqTouchResponse>>;
  const data = response.data;
  return response.ok === true
    && typeof data === 'object'
    && data !== null
    && data.touched === true
    && typeof data.qqNumber === 'string';
}

/** 判断 backend Bot 卡密兑换响应是否符合共享契约。 */
function isRechargeRedeemResponse(value: unknown): value is ApiDataResponse<RechargeRedeemResponse> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<RechargeRedeemResponse>>;
  const data = response.data;
  return response.ok === true
    && typeof data === 'object'
    && data !== null
    && typeof data.qqNumber === 'string'
    && typeof data.amount === 'string'
    && typeof data.paidBalance === 'string'
    && typeof data.redeemedAt === 'string';
}

/** 判断 backend Bot 统计响应是否符合共享契约。 */
function isBotGenerationStatsResponse(value: unknown): value is ApiDataResponse<BotGenerationStatsResponse> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<BotGenerationStatsResponse>>;
  const data = response.data;
  return response.ok === true
    && typeof data === 'object'
    && data !== null
    && (data.scope === 'mine' || data.scope === 'all')
    && typeof data.generatedAt === 'string'
    && Array.isArray(data.buckets);
}

/** 判断 backend Bot 管理员配置响应是否符合共享契约。 */
function isBotAdminRuntimeConfigResponse(value: unknown): value is ApiDataResponse<BotAdminRuntimeConfig> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<ApiDataResponse<BotAdminRuntimeConfig>>;
  const data = response.data;
  return response.ok === true
    && typeof data === 'object'
    && data !== null
    && Array.isArray(data.adminQqNumbers)
    && data.adminQqNumbers.every((item) => typeof item === 'string');
}

/** 提取 backend 错误响应中的中文 message，失败时返回通用错误。 */
function readBackendErrorMessage(value: unknown, status: number) {
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return `backend 内部接口调用失败：${status}`;
}

/** 调用 backend 健康检查；失败时抛出中文错误供 `/ping` 汇总展示。 */
export async function queryBackendHealth(): Promise<HealthResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${BACKEND_INTERNAL_URL}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`backend 健康检查失败：${response.status}`);
    }
    if (!isBackendHealthResponse(body)) {
      throw new Error('backend 健康检查响应不正确');
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('backend 健康检查超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 调用 backend 验证 QQ 绑定 key；QQ 号必须由调用方从 OneBot 事件传入。 */
export async function verifyQqBindingByBackend(request: QqVerifyBindingRequest): Promise<QqVerifyBindingResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BACKEND_INTERNAL_URL}/internal/qq/verify-binding`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 服务间 token 不写入日志，只通过 header 传递给 backend 校验。
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(readBackendErrorMessage(body, response.status));
    }
    if (!isQqVerifyBindingResponse(body)) {
      throw new Error('backend 返回的 QQ 绑定验证响应不正确');
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

/** 调用 backend 查询 QQ 余额；该接口不要求网页绑定，并会由 backend 补齐首次触达的余额行。 */
export async function queryQqBalanceByBackend(request: QqBalanceQueryRequest): Promise<QqBalanceQueryResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BACKEND_INTERNAL_URL}/internal/qq/balance`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 服务间 token 不写入日志，只通过 header 传递给 backend 校验。
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(readBackendErrorMessage(body, response.status));
    }
    if (!isQqBalanceQueryResponse(body)) {
      throw new Error('backend 返回的 QQ 余额查询响应不正确');
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

/** 调用 backend 登记 QQ 用户触达；失败只影响后台统计，不应阻断 Bot 命令回复。 */
export async function touchQqAccountByBackend(request: QqTouchRequest): Promise<QqTouchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BACKEND_INTERNAL_URL}/internal/qq/touch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 服务间 token 不写入日志，只通过 header 传递给 backend 校验。
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(readBackendErrorMessage(body, response.status));
    }
    if (!isQqTouchResponse(body)) {
      throw new Error('backend 返回的 QQ 触达建档响应不正确');
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

/** 调用 backend 按 QQ 兑换卡密；QQ 号必须来自 OneBot 事件 user_id，Bot 不读取用户文本中的 QQ。 */
export async function redeemRechargeCardByBackend(request: BotRechargeRedeemRequest): Promise<RechargeRedeemResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BACKEND_INTERNAL_URL}/internal/recharge/redeem-by-qq`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 服务间 token 不写入日志，只通过 header 传递给 backend 校验。
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(readBackendErrorMessage(body, response.status));
    }
    if (!isRechargeRedeemResponse(body)) {
      throw new Error('backend 返回的卡密兑换响应不正确');
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

/** 调用 backend 查询 Bot 统计；scope=mine 时按当前 QQ，scope=all 时返回全站排行。 */
export async function queryBotGenerationStatsByBackend(scope: 'mine' | 'all', qqNumber?: string): Promise<BotGenerationStatsResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(`${BACKEND_INTERNAL_URL}/internal/bot/stats`);
    url.searchParams.set('scope', scope);
    if (qqNumber) url.searchParams.set('qqNumber', qqNumber);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(readBackendErrorMessage(body, response.status));
    }
    if (!isBotGenerationStatsResponse(body)) {
      throw new Error('backend 返回的 Bot 统计响应不正确');
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

/** 调用 backend 读取 QQ 端管理员配置；失败时由调用方按无管理员白名单降级处理。 */
export async function queryBotAdminRuntimeConfigByBackend(): Promise<BotAdminRuntimeConfig> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BACKEND_INTERNAL_URL}/internal/bot/admin-config`, {
      method: 'GET',
      headers: {
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(readBackendErrorMessage(body, response.status));
    }
    if (!isBotAdminRuntimeConfigResponse(body)) {
      throw new Error('backend 返回的 Bot 管理员配置响应不正确');
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}
