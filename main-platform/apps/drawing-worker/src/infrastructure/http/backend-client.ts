/**
 * 本文件封装 drawing-worker 调用 backend 内部接口的 HTTP 客户端。
 * 所有任务状态回写和子任务追加必须通过本客户端，不直连数据库。
 */
import type {
  GenerationAppendSubTaskRequest,
  GenerationAppendSubTaskResponse,
  GenerationSubTaskKind,
  GenerationSubTaskStatus,
  GenerationRetryNextAction,
  GenerationUpdateTaskStatusRequest,
  GenerationUpdateTaskStatusResponse,
} from '@aiimage/shared-contracts';

/** backend 内部地址，默认指向 本地 backend。 */
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';

/** backend 内部接口超时，避免 Worker 因状态写回卡死。 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * 向 backend 上报子任务（dispatch、upstream_attempt、same_site_retry、site_switch、finalize）。
 * 所有重试和尝试都必须通过本函数写入主任务下。
 */
export async function reportSubTask(
  taskId: string,
  kind: GenerationSubTaskKind,
  status: GenerationSubTaskStatus,
  opts: {
    attemptNo?: number;
    siteId?: number;
    siteName?: string;
    model?: string;
    retryable?: boolean;
    nextAction?: GenerationRetryNextAction;
    latencyMs?: number;
    error?: string;
    rawError?: string;
    startedAt?: string;
    finishedAt?: string;
  } = {},
): Promise<GenerationAppendSubTaskResponse> {
  const body: GenerationAppendSubTaskRequest = {
    taskId,
    kind,
    status,
    attemptNo: opts.attemptNo,
    siteId: opts.siteId,
    siteName: opts.siteName,
    model: opts.model,
    retryable: opts.retryable,
    nextAction: opts.nextAction,
    latencyMs: opts.latencyMs,
    error: opts.error,
    rawError: opts.rawError,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
  };
  return postBackend<GenerationAppendSubTaskResponse>('/internal/generations/sub-tasks', body);
}

/**
 * 向 backend 更新主任务状态。
 * 只有 success/failed 状态变更时调用，running 状态由各子任务表达。
 */
export async function updateTaskStatus(
  taskId: string,
  status: GenerationUpdateTaskStatusRequest['status'],
  error?: string,
): Promise<GenerationUpdateTaskStatusResponse> {
  const body: GenerationUpdateTaskStatusRequest = { taskId, status, error };
  return postBackend<GenerationUpdateTaskStatusResponse>('/internal/generations/status', body);
}

/** 调用 backend 内部 JSON 接口并校验通用响应格式。 */
async function postBackend<TData>(path: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<TData> {
  const controller = new AbortController();
  const requestTimeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isOkDataResponse(payload)) {
      throw new Error(`backend 内部接口 ${path} 返回错误：${response.status}`);
    }
    return payload.data as TData;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`backend 内部接口 ${path} 调用超时`);
    }
    throw error;
  } finally {
    clearTimeout(requestTimeout);
  }
}

export async function fetchDrawingConfig(): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${BACKEND_URL}/internal/drawing-config`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok && isOkDataResponse(payload)) return payload.data as Record<string, unknown>;
    throw new Error('读取绘图配置失败');
  } finally {
    clearTimeout(timeout);
  }
}

/** 向 backend 记录站点故障，触发自动禁用逻辑（连续失败达阈值时禁用站点）。 */
export async function recordSiteFailure(siteId: number, error?: string, latencyMs?: number): Promise<void> {
  try {
    await postBackend(`/internal/sites/${siteId}/record-failure`, { error, latencyMs });
  } catch { /* 记录失败不阻塞主流程 */ }
}

/** 站点成功后重置连续故障计数和自动禁用状态，并记录延迟。 */
export async function resetSiteFailure(siteId: number, latencyMs?: number): Promise<void> {
  try {
    await postBackend(`/internal/sites/${siteId}/reset-failure`, { latencyMs });
  } catch { /* 重置失败不阻塞主流程 */ }
}

/** 宽松校验 backend 返回的 ApiDataResponse 结构。 */
function isOkDataResponse(value: unknown): value is { ok: true; data: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).ok === true &&
    'data' in (value as Record<string, unknown>)
  );
}
