const BASE: string = import.meta.env.VITE_API_BASE ?? '';

function getToken(): string | null {
  try {
    return localStorage.getItem('admin_token');
  } catch {
    return null;
  }
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  message?: string;
  /** HTTP 状态码，便于页面区分鉴权失效和普通业务错误。 */
  status?: number;
  /** 鉴权失败标记；401/403 时为 true。 */
  authFailed?: boolean;
}

/** 管理后台登录失效时清理本地会话，避免继续带着坏 token 反复请求。 */
function clearAdminSession(): void {
  try {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
  } catch {
    // 本地存储不可用时不额外处理，页面会继续按失败态展示。
  }
}

export async function api<T = unknown>(
  path: string,
  opts?: RequestInit,
): Promise<ApiResult<T>> {
  const url = `${BASE}${path}`;
  const token = getToken();

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Merge caller headers, letting caller overrides win over defaults
  if (opts?.headers) {
    const incoming = opts.headers as Record<string, string>;
    for (const [k, v] of Object.entries(incoming)) {
      headers[k] = v;
    }
  }

  try {
    const res = await fetch(url, {
      ...opts,
      headers,
    });

    let body: unknown = null;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }

    if (!res.ok) {
      const message =
        (body && typeof body === 'object' && 'message' in (body as Record<string, unknown>)
          ? (body as Record<string, unknown>).message
          : typeof body === 'string'
            ? body
            : undefined) as string | undefined;
      const authFailed = res.status === 401 || res.status === 403;
      if (authFailed && token) clearAdminSession();

      return {
        ok: false,
        data: [] as unknown as T,
        message: message ?? `Request failed with status ${res.status}`,
        status: res.status,
        authFailed,
      };
    }

    const unwrapped = (body && typeof body === 'object' && 'data' in (body as any)) ? (body as any).data : body;
    // 安全：确保 data 不为 null/undefined
    const safe = unwrapped ?? (Array.isArray(body) ? [] : {}) as T;
    return {
      ok: true,
      data: safe,
      status: res.status,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Network or unexpected error';
    return {
      ok: false,
      data: undefined,
      message,
      status: undefined,
      authFailed: false,
    };
  }
}
