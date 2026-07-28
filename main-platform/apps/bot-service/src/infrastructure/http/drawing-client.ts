/** 本文件封装 bot-service 调用 drawing-service 内部健康检查和后续绘图接口的 HTTP 客户端。 */
import type { HealthResponse } from '@aiimage/shared-contracts';

/** drawing-service 内部地址，默认指向 本地绘图接入服务。 */
const DRAWING_SERVICE_URL = process.env.DRAWING_SERVICE_URL ?? 'http://localhost:3005';

/** drawing-service 探测超时，避免 `/ping` 因依赖异常长时间卡住。 */
const DRAWING_REQUEST_TIMEOUT_MS = 1500;

/** 校验 drawing-service 健康检查响应，避免把错误页或代理响应误判为健康。 */
function isDrawingHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<HealthResponse>;
  return response.ok === true
    && response.service === 'drawing-service'
    && typeof response.version === 'string'
    && typeof response.uptimeSec === 'number';
}

/** 查询 drawing-service 健康状态；失败时抛出中文错误供 Bot 命令降级展示。 */
export async function queryDrawingServiceHealth(): Promise<HealthResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DRAWING_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${DRAWING_SERVICE_URL}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`drawing-service 健康检查失败：${response.status}`);
    }
    if (!isDrawingHealthResponse(body)) {
      throw new Error('drawing-service 健康检查响应不正确');
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('drawing-service 健康检查超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
