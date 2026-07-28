/** API 客户端 — 所有 URL 从 config 读取，禁止硬编码。连接失败时返回友好错误信息。 */
import { config } from './config';

function token() { return localStorage.getItem('token') ?? ''; }

/** 后端不可达时返回的统一错误消息，调用方直接展示给用户。 */
export const BACKEND_UNREACHABLE = '后端服务未启动或无法连接，请稍后刷新重试';

export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<{ ok: boolean; data?: T; message?: string; code?: string; status: number }> {
  const headers: Record<string,string> = { ...(opts?.headers as Record<string,string>??{}) };
  if (token()) headers['Authorization'] = `Bearer ${token()}`;
  if (!headers['Content-Type'] && (opts?.method === 'POST' || opts?.method === 'PUT' || opts?.method === 'PATCH'))
    headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${config.apiBase}${path}`, { ...opts, headers });
  } catch {
    // fetch 抛出 TypeError：DNS 解析失败、连接拒绝、CORS 阻止、超时
    return { ok: false, message: BACKEND_UNREACHABLE, status: 0 };
  }

  const data = await res.json().catch(() => ({})) as Record<string,unknown>;
  if (res.status === 401) {
    // 清除过期 token，派发事件让 AuthProvider 处理跳转，避免轮询请求触发页面刷新
    localStorage.removeItem('token');
    window.dispatchEvent(new CustomEvent('aiimage:auth-expired'));
  }
  return { ok: data.ok === true, data: data.data as T, message: data.message as string, code: data.code as string, status: res.status };
}
