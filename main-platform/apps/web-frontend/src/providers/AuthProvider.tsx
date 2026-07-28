/** 全局认证状态管理 — token 持久化到 localStorage，后端重启不丢失登录 */
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { AuthUser } from '@aiimage/shared-contracts';
import { config } from '../lib/config';

/** 前端登录态用户直接复用共享认证契约，避免遗漏邮箱绑定状态等跨端字段。 */
type User = AuthUser;
type Ctx = { user: User | null; loading: boolean; login: (t: string, u: User) => void; logout: () => void; refresh: () => Promise<void> };
const C = createContext<Ctx>({ user: null, loading: true, login: () => {}, logout: () => {}, refresh: async () => {} });
export const useAuth = () => useContext(C);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const t = localStorage.getItem('token');
    if (!t) { setLoading(false); return; }
    // 初始加载时快速重试 3 次，应对后端正在启动的场景
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${config.apiBase}/auth/me`, { headers: { Authorization: `Bearer ${t}` } });
        if (r.status === 401) {
          // token 确实过期，清除
          localStorage.removeItem('token');
          setUser(null);
          break;
        }
        const d = await r.json() as { ok?: boolean; data?: User };
        if (d.ok && d.data) {
          setUser(d.data);
          break;
        }
        // 非 401 的错误（500 等），等 1s 重试
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
      } catch {
        // 网络不可达（后端重启中），等 1s 重试
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        // 最后一次仍失败：保留 token，不清除登录状态
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // token 过期事件：仅清除用户状态并跳转
  useEffect(() => {
    const handler = () => { setUser(null); window.location.href = '/login'; };
    window.addEventListener('aiimage:auth-expired', handler);
    return () => window.removeEventListener('aiimage:auth-expired', handler);
  }, []);

  const login = (t: string, u: User) => { localStorage.setItem('token', t); setUser(u); };
  const logout = () => { localStorage.removeItem('token'); setUser(null); window.location.href = '/login'; };
  return <C.Provider value={{ user, loading, login, logout, refresh }}>{children}</C.Provider>;
}
