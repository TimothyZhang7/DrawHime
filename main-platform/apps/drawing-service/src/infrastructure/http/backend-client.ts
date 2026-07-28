/** 本文件封装 drawing-service 调用 backend 生成任务内部接口的 HTTP 客户端。 */
import type {
  GenerationAppendSubTaskRequest,
  GenerationAppendSubTaskResponse,
  GenerationUpdateTaskStatusRequest,
  GenerationUpdateTaskStatusResponse,
} from '@aiimage/shared-contracts';
import type { ApiDataResponse } from '@aiimage/shared-contracts';

/** backend 内部地址，默认指向 本地 backend。 */
const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';

/** backend 内部接口超时，避免 drawing-service 因状态写回卡死。 */
const BACKEND_REQUEST_TIMEOUT_MS = Number(process.env.DRAWING_BACKEND_TIMEOUT_MS ?? '3000');

/** 向 backend 追加生成子任务。 */
export async function appendGenerationSubTask(request: GenerationAppendSubTaskRequest) {
  return postBackend<GenerationAppendSubTaskResponse>('/internal/generations/sub-tasks', request);
}

/** 向 backend 更新生成主任务状态。 */
export async function updateGenerationTaskStatus(request: GenerationUpdateTaskStatusRequest) {
  return postBackend<GenerationUpdateTaskStatusResponse>('/internal/generations/status', request);
}

/** 调用 backend 内部 JSON 接口并校验通用响应格式。 */
async function postBackend<TData>(path: string, body: unknown): Promise<TData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BACKEND_INTERNAL_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 服务间 token 不写日志，只通过 header 参与 backend 校验。
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isApiDataResponse<TData>(payload)) {
      throw new Error(`backend 内部接口 ${path} 调用失败：${response.status}`);
    }
    return payload.data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`backend 内部接口 ${path} 调用超时`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 判断 backend 是否返回 ApiDataResponse。 */
function isApiDataResponse<TData>(value: unknown): value is ApiDataResponse<TData> {
  return typeof value === 'object'
    && value !== null
    && (value as Partial<ApiDataResponse<TData>>).ok === true
    && 'data' in value;
}
