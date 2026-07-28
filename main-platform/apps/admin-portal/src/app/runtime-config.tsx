/** 本文件提供管理后台运行时配置上下文，用于让系统设置保存后的主题色和轮询间隔真实生效。 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

/** 管理后台运行时配置，来自 backend system_configs。 */
export interface AdminRuntimeConfig {
  pollIntervalSec: number;
}

const DEFAULT_ADMIN_RUNTIME_CONFIG: AdminRuntimeConfig = {
  pollIntervalSec: 30,
};

const AdminRuntimeConfigContext = createContext<AdminRuntimeConfig>(DEFAULT_ADMIN_RUNTIME_CONFIG);

/** 管理后台运行时配置 Provider：登录后的页面共享同一份后台配置。 */
export function AdminRuntimeConfigProvider({ children }: { children: React.ReactNode }) {
  const config = useAdminRuntimeConfigValue();
  return (
    <AdminRuntimeConfigContext.Provider value={config}>
      {children}
    </AdminRuntimeConfigContext.Provider>
  );
}

/** 读取管理后台运行时配置，页面轮询必须使用这里的配置，避免后台设置保存后不生效。 */
export function useAdminRuntimeConfig(): AdminRuntimeConfig {
  return useContext(AdminRuntimeConfigContext);
}

/** 从 backend 加载后台运行时配置，并把主题色写入 CSS 变量。 */
function useAdminRuntimeConfigValue(): AdminRuntimeConfig {
  const [config, setConfig] = useState(DEFAULT_ADMIN_RUNTIME_CONFIG);

  useEffect(() => {
    let disposed = false;
    api<Record<string, string>>('/admin/config').then((res) => {
      if (!res.ok || !res.data || disposed) return;
      const primary = normalizeColor(res.data.admin_primary_color);
      if (primary) {
        document.documentElement.style.setProperty('--color-primary', primary);
        document.documentElement.style.setProperty('--color-primary-hover', primary);
      }
      const pollIntervalSec = clampNumber(res.data.admin_status_poll_interval_sec, DEFAULT_ADMIN_RUNTIME_CONFIG.pollIntervalSec, 5, 300);
      setConfig({ pollIntervalSec });
    });
    return () => { disposed = true; };
  }, []);

  return useMemo(() => config, [config]);
}

/** 校验后台主题色，只接受标准十六进制颜色，避免任意字符串进入 CSS 变量。 */
function normalizeColor(value: string | undefined): string {
  const color = value?.trim() ?? '';
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '';
}

/** 读取后台数值配置并限制范围，防止异常配置造成轮询过快。 */
function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}
