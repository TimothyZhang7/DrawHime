/** 本文件封装 backend 调用 drawing-service 的内部 HTTP 客户端。 */
import type { DrawingGenerateRequest, DrawingGenerateResponse } from '@aiimage/shared-contracts';

/** drawing-service 内部地址，默认指向 本地开发端口。 */
const DRAWING_SERVICE_URL = process.env.DRAWING_SERVICE_URL ?? 'http://localhost:3005';

/** 调用 drawing-service 超时（ms），从环境变量读取，默认 5000。 */
const TIMEOUT_MS = Number(process.env.DRAWING_REQUEST_TIMEOUT_MS ?? '5000');

/** 调用 drawing-service 接收已创建的生成主任务。 */
export async function submitDrawingTask(request: DrawingGenerateRequest): Promise<DrawingGenerateResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${DRAWING_SERVICE_URL}/api/drawing/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 服务间 token 只走 header，不写入日志或响应。
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isDrawingGenerateResponse(body)) {
      throw new Error(`drawing-service 接收生成任务失败：${response.status}`);
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('drawing-service 接收生成任务超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 宽松校验 drawing-service 响应，只确认它是当前契约允许的响应形态。 */
function isDrawingGenerateResponse(value: unknown): value is DrawingGenerateResponse {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Record<string, unknown>;
  if ('accepted' in response) {
    return response.accepted === true
      && typeof response.taskId === 'string'
      && typeof response.clientRequestId === 'string'
      && typeof response.status === 'string';
  }
  return typeof response.id === 'string' && typeof response.status === 'string';
}
