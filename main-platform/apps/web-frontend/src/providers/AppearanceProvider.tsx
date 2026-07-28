/** 本文件管理全站背景图公开配置、当前用户显示偏好与页面背景层。 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SiteAppearanceView, UserAppearancePreferenceView } from '@aiimage/shared-contracts';
import { api } from '../lib/api';
import { useAuth } from './AuthProvider';

type PreferenceUpdateResult = { ok: boolean; message?: string };

type AppearanceContextValue = {
  /** 后台公开的全站背景配置。 */
  siteAppearance: SiteAppearanceView;
  /** 当前用户是否选择显示背景图；尚在加载时为 null。 */
  userBackgroundEnabled: boolean | null;
  /** 当前页面是否实际显示背景图。 */
  backgroundActive: boolean;
  /** 用户偏好是否正在保存。 */
  saving: boolean;
  /** 保存当前用户背景图偏好。 */
  updateUserBackgroundEnabled: (enabled: boolean) => Promise<PreferenceUpdateResult>;
};

const DEFAULT_SITE_APPEARANCE: SiteAppearanceView = {
  backgroundEnabled: false,
  backgroundImageUrl: null,
};

const AppearanceContext = createContext<AppearanceContextValue>({
  siteAppearance: DEFAULT_SITE_APPEARANCE,
  userBackgroundEnabled: null,
  backgroundActive: false,
  saving: false,
  updateUserBackgroundEnabled: async () => ({ ok: false, message: '外观设置尚未加载' }),
});

/** 读取并修改当前页面的全站背景状态。 */
export function useAppearance(): AppearanceContextValue {
  return useContext(AppearanceContext);
}

/** 全站背景图 Provider；公开页默认显示，登录用户按数据库偏好决定。 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [siteAppearance, setSiteAppearance] = useState<SiteAppearanceView>(DEFAULT_SITE_APPEARANCE);
  const [userBackgroundEnabled, setUserBackgroundEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void api<SiteAppearanceView>('/api/appearance').then((result) => {
      if (active && result.ok && result.data) setSiteAppearance(result.data);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setUserBackgroundEnabled(true);
      return;
    }
    let active = true;
    setUserBackgroundEnabled(null);
    void api<UserAppearancePreferenceView>('/api/users/me/appearance').then((result) => {
      if (!active) return;
      setUserBackgroundEnabled(result.ok && result.data ? result.data.backgroundEnabled : false);
    });
    return () => { active = false; };
  }, [authLoading, user?.id]);

  /** 保存用户个人开关；全局关闭时仍保留个人选择，管理员恢复后继续生效。 */
  const updateUserBackgroundEnabled = useCallback(async (enabled: boolean): Promise<PreferenceUpdateResult> => {
    if (!user) return { ok: false, message: '请先登录' };
    setSaving(true);
    try {
      const result = await api<UserAppearancePreferenceView>('/api/users/me/appearance', {
        method: 'PATCH',
        body: JSON.stringify({ backgroundEnabled: enabled }),
      });
      if (!result.ok || !result.data) return { ok: false, message: result.message ?? '背景图偏好保存失败' };
      setUserBackgroundEnabled(result.data.backgroundEnabled);
      return { ok: true };
    } finally {
      setSaving(false);
    }
  }, [user?.id]);

  const backgroundActive = Boolean(
    !authLoading
    && siteAppearance.backgroundEnabled
    && siteAppearance.backgroundImageUrl
    && userBackgroundEnabled === true,
  );
  const contextValue = useMemo<AppearanceContextValue>(() => ({
    siteAppearance,
    userBackgroundEnabled,
    backgroundActive,
    saving,
    updateUserBackgroundEnabled,
  }), [siteAppearance, userBackgroundEnabled, backgroundActive, saving, updateUserBackgroundEnabled]);

  const backgroundImage = siteAppearance.backgroundImageUrl
    ? `url(${JSON.stringify(siteAppearance.backgroundImageUrl)})`
    : undefined;

  return (
    <AppearanceContext.Provider value={contextValue}>
      <div className={`site-appearance-root${backgroundActive ? ' has-site-background' : ''}`}>
        {backgroundActive && <div className="site-background-layer" style={{ backgroundImage }} aria-hidden="true" />}
        <div className="site-appearance-content">{children}</div>
      </div>
    </AppearanceContext.Provider>
  );
}
