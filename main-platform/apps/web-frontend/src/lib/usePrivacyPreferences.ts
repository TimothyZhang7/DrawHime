/** 本文件封装默认图片隐私偏好的读取、乐观更新和防抖持久化。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateUserPrivacyPreferenceRequest, UserPrivacyPreferenceResponse } from '@aiimage/shared-contracts';
import { api } from './api';

const DEFAULT_PRIVACY_PREFERENCES: UserPrivacyPreferenceResponse = {
  webDefaultPrivate: false,
  botDefaultPrivate: false,
  qqNumber: null,
  botAvailable: false,
  defaultImagePrivate: false,
};

const SAVE_DEBOUNCE_MS = 450;

/** 统一整理后端响应，确保兼容旧字段和缺省字段。 */
function normalizePrivacyPreference(input?: Partial<UserPrivacyPreferenceResponse>): UserPrivacyPreferenceResponse {
  const webDefaultPrivate = input?.webDefaultPrivate ?? input?.defaultImagePrivate ?? false;
  return {
    webDefaultPrivate,
    botDefaultPrivate: input?.botDefaultPrivate ?? false,
    qqNumber: input?.qqNumber ?? null,
    botAvailable: input?.botAvailable ?? Boolean(input?.qqNumber),
    defaultImagePrivate: webDefaultPrivate,
  };
}

/** 当前登录用户的隐私偏好 Hook；频繁点击会合并成最后一次 PATCH。 */
export function usePrivacyPreferences(enabled = true) {
  const [preferences, setPreferences] = useState<UserPrivacyPreferenceResponse>(DEFAULT_PRIVACY_PREFERENCES);
  const [loading, setLoading] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestPreferencesRef = useRef<UserPrivacyPreferenceResponse>(DEFAULT_PRIVACY_PREFERENCES);
  const pendingPatchRef = useRef<UpdateUserPrivacyPreferenceRequest>({});
  const debounceTimerRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);
  const mutationSeqRef = useRef(0);

  const applyPreferences = useCallback((next: UserPrivacyPreferenceResponse) => {
    latestPreferencesRef.current = next;
    setPreferences(next);
  }, []);

  const fetchPreferences = useCallback(async () => {
    if (!enabled) {
      applyPreferences(DEFAULT_PRIVACY_PREFERENCES);
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await api<UserPrivacyPreferenceResponse>('/api/users/me/privacy');
    if (result.ok && result.data) {
      applyPreferences(normalizePrivacyPreference(result.data));
      setError(null);
    } else {
      setError(result.message ?? '隐私偏好加载失败');
    }
    setLoading(false);
  }, [applyPreferences, enabled]);

  useEffect(() => {
    fetchPreferences();
  }, [fetchPreferences]);

  useEffect(() => () => {
    if (debounceTimerRef.current !== null) window.clearTimeout(debounceTimerRef.current);
  }, []);

  const flushPendingPatch = useCallback(() => {
    if (debounceTimerRef.current !== null) window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = window.setTimeout(async () => {
      const patch = pendingPatchRef.current;
      pendingPatchRef.current = {};
      if (
        typeof patch.webDefaultPrivate !== 'boolean'
        && typeof patch.botDefaultPrivate !== 'boolean'
        && typeof patch.defaultImagePrivate !== 'boolean'
      ) return;

      const requestSeq = requestSeqRef.current + 1;
      const mutationSeq = mutationSeqRef.current;
      requestSeqRef.current = requestSeq;
      setSaving(true);
      setError(null);
      const result = await api<UserPrivacyPreferenceResponse>('/api/users/me/privacy', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });

      if (result.ok && result.data) {
        if (mutationSeq === mutationSeqRef.current) applyPreferences(normalizePrivacyPreference(result.data));
      } else if (mutationSeq === mutationSeqRef.current) {
        setError(result.message ?? '隐私偏好保存失败');
        await fetchPreferences();
      }
      if (requestSeq === requestSeqRef.current) setSaving(false);
    }, SAVE_DEBOUNCE_MS);
  }, [applyPreferences, fetchPreferences]);

  const queuePatch = useCallback((patch: UpdateUserPrivacyPreferenceRequest) => {
    mutationSeqRef.current += 1;
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    setError(null);
    setPreferences(prev => {
      const next = normalizePrivacyPreference({
        ...prev,
        webDefaultPrivate: typeof patch.webDefaultPrivate === 'boolean' ? patch.webDefaultPrivate : prev.webDefaultPrivate,
        defaultImagePrivate: typeof patch.webDefaultPrivate === 'boolean' ? patch.webDefaultPrivate : prev.defaultImagePrivate,
        botDefaultPrivate: typeof patch.botDefaultPrivate === 'boolean' ? patch.botDefaultPrivate : prev.botDefaultPrivate,
      });
      latestPreferencesRef.current = next;
      return next;
    });
    flushPendingPatch();
  }, [flushPendingPatch]);

  const updateWebDefaultPrivate = useCallback((value: boolean) => {
    queuePatch({ webDefaultPrivate: value });
  }, [queuePatch]);

  const updateBotDefaultPrivate = useCallback((value: boolean) => {
    if (!latestPreferencesRef.current.botAvailable) {
      setError('请先绑定 QQ 后再设置 Bot 隐私');
      return;
    }
    queuePatch({ botDefaultPrivate: value });
  }, [queuePatch]);

  const clearError = useCallback(() => setError(null), []);

  return {
    preferences,
    loading,
    saving,
    error,
    refresh: fetchPreferences,
    clearError,
    updateWebDefaultPrivate,
    updateBotDefaultPrivate,
  };
}
