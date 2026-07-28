/** 系统设置 — 分组可折叠卡片布局，统一管理所有配置 (Tailwind + lucide-react) */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Image as ImageIcon, Save, RotateCw, Settings, Trash2, Upload } from 'lucide-react';
import type { SiteAppearanceView, SiteBackgroundUploadView } from '@aiimage/shared-contracts';
import { api } from '../../api/client';
import Toast from '../../components/Toast';

/* ─── 类型 ─── */

interface ToastState {
  type: 'success' | 'error';
  message: string;
}

/** 从配置中读取字符串值 */
function g(cfg: Record<string, string>, key: string, def = ''): string {
  return cfg[key] ?? def;
}

/** 从配置中读取布尔值 */
function gb(cfg: Record<string, string>, key: string, def = false): boolean {
  const v = cfg[key];
  if (v === undefined) return def;
  return v === 'true';
}

/* ═══════════════════════════════════════════════════════════════════════
   共用 UI 组件
   ═══════════════════════════════════════════════════════════════════════ */

const inputClass =
  'w-full h-10 px-3 text-sm rounded-xl border border-border bg-surface text-text placeholder:text-soft focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-colors';

/** 可折叠分区卡片 */
function Section({
  title,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="card mb-4">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center justify-between w-full text-left"
      >
        <h3 className="text-sm font-bold text-text">{title}</h3>
        <svg
          className={`w-4 h-4 text-text-2 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && <div className="mt-4 pt-4 border-t border-border">{children}</div>}
    </div>
  );
}

/** Toggle 开关 */
function Toggle({ name, defaultChecked }: { name: string; defaultChecked: boolean }) {
  return (
    <input
      type="checkbox"
      name={name}
      defaultChecked={defaultChecked}
      className="appearance-none relative w-10 h-5 bg-border rounded-full checked:bg-primary cursor-pointer transition-colors before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:w-4 before:h-4 before:bg-white before:rounded-full before:shadow before:transition-transform checked:before:translate-x-5"
    />
  );
}

/** 表单字段包装 */
function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-text-2 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

/** 保存按钮 */
function SaveButton({ label, loading }: { label: string; loading: boolean }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="btn btn-sm flex items-center gap-1.5"
    >
      <Save size={14} />
      {loading ? '保存中...' : label}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   主页面
   ═══════════════════════════════════════════════════════════════════════ */

export function ConfigPage() {
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [backgroundImageUrl, setBackgroundImageUrl] = useState<string | null>(null);
  const [backgroundUploading, setBackgroundUploading] = useState(false);
  const [backgroundDeleting, setBackgroundDeleting] = useState(false);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    drawing: true,
    ratelimit: true,
    ops: true,
    media: true,
    templateAi: true,
    bot: true,
    appearance: true,
    registration: true,
  });

  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  /** 加载全部配置 */
  const loadConfig = useCallback(async () => {
    setLoading(true);
    const [res, appearance] = await Promise.all([
      api<Record<string, string>>('/admin/config'),
      api<SiteAppearanceView>('/api/appearance'),
    ]);
    if (res.ok && res.data) {
      setCfg(res.data);
    } else {
      setToast({ type: 'error', message: res.message ?? '加载配置失败' });
    }
    if (appearance.ok && appearance.data) setBackgroundImageUrl(appearance.data.backgroundImageUrl);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  /** 保存某个分区的配置 */
  const saveSection = async (
    sectionKey: string,
    formData: FormData,
    fields: [string, string, 'text' | 'toggle'][],
  ) => {
    setSaving(sectionKey);
    const payload: Record<string, string> = {};
    for (const [formKey, configKey, kind] of fields) {
      payload[configKey] =
        kind === 'toggle'
          ? String(formData.has(formKey))
          : String(formData.get(formKey) ?? '');
    }
    const res = await api('/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setToast({ type: 'success', message: '保存成功' });
      const refresh = await api<Record<string, string>>('/admin/config');
      if (refresh.ok && refresh.data) setCfg(refresh.data);
    } else {
      setToast({ type: 'error', message: res.message ?? '保存失败' });
    }
    setSaving(null);
  };

  /** 保存模板 AI 配置；API Key 留空时不写入，避免误清空生产密钥。 */
  const saveTemplateAiSection = async (formData: FormData) => {
    setSaving('templateAi');
    const apiKey = String(formData.get('apiKey') ?? '').trim();
    const payload: Record<string, string> = {
      template_ai_enabled: String(formData.has('enabled')),
      template_ai_base_url: String(formData.get('baseUrl') ?? '').trim(),
      template_ai_model: String(formData.get('model') ?? '').trim(),
      template_ai_temperature: String(formData.get('temperature') ?? '').trim(),
      template_ai_timeout_ms: String(formData.get('timeoutMs') ?? '').trim(),
      template_ai_system_prompt: String(formData.get('systemPrompt') ?? '').trim(),
    };
    if (apiKey) payload.template_ai_api_key = apiKey;
    const res = await api('/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setToast({ type: 'success', message: apiKey ? '模板 AI 配置已保存' : '模板 AI 配置已保存，API Key 保持不变' });
      const refresh = await api<Record<string, string>>('/admin/config');
      if (refresh.ok && refresh.data) setCfg(refresh.data);
    } else {
      setToast({ type: 'error', message: res.message ?? '模板 AI 配置保存失败' });
    }
    setSaving(null);
  };

  /** 表单提交处理器工厂 */
  const onSubmit =
    (sectionKey: string, fields: [string, string, 'text' | 'toggle'][]) =>
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      saveSection(sectionKey, new FormData(e.currentTarget), fields);
    };

  /** 上传全站背景图；文件由 backend 校验并压缩，浏览器不直接写配置文件名。 */
  const uploadBackground = async (file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setToast({ type: 'error', message: '背景图仅支持 PNG、JPEG、WebP' });
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setToast({ type: 'error', message: '背景图不能超过 15MB' });
      return;
    }
    setBackgroundUploading(true);
    const result = await api<SiteBackgroundUploadView>('/admin/appearance/background', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (result.ok && result.data) {
      setBackgroundImageUrl(result.data.backgroundImageUrl);
      setToast({ type: 'success', message: '全站背景图已上传' });
    } else {
      setToast({ type: 'error', message: result.message ?? '背景图上传失败' });
    }
    if (backgroundInputRef.current) backgroundInputRef.current.value = '';
    setBackgroundUploading(false);
  };

  /** 清除当前全站背景图；全局开关保持原值，便于后续重新上传。 */
  const deleteBackground = async () => {
    if (!backgroundImageUrl || !confirm('确定清除当前全站背景图吗？')) return;
    setBackgroundDeleting(true);
    const result = await api<SiteAppearanceView>('/admin/appearance/background', { method: 'DELETE' });
    if (result.ok) {
      setBackgroundImageUrl(null);
      setToast({ type: 'success', message: '全站背景图已清除' });
    } else {
      setToast({ type: 'error', message: result.message ?? '背景图清除失败' });
    }
    setBackgroundDeleting(false);
  };

  /* ─── 加载态 ─── */
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RotateCw size={22} className="animate-spin text-primary" />
        <span className="ml-3 text-sm text-text-2">加载配置中...</span>
      </div>
    );
  }

  /* ─── 页面主体 ─── */
  return (
    <div className="max-w-4xl">
      {/* 页头 */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <Settings size={20} className="text-primary" />
          <h2 className="text-lg font-extrabold text-text">系统设置</h2>
        </div>
        <button
          type="button"
          onClick={loadConfig}
          className="btn btn-sm btn-outline flex items-center gap-1.5"
        >
          <RotateCw size={14} />
          刷新
        </button>
      </div>

      {/* Toast 通知 */}
      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}


      {/* ═══════════════════════════════════════════════════════════════
          2. 限流与认证
          ═══════════════════════════════════════════════════════════════ */}
      <Section
        title="限流与认证"
        expanded={expanded.ratelimit}
        onToggle={() => toggle('ratelimit')}
      >
        <form
          onSubmit={onSubmit('ratelimit', [
            ['loginMax', 'rate_limit_login_max', 'text'],
            ['loginWin', 'rate_limit_login_window_ms', 'text'],
            ['regMax', 'rate_limit_register_max', 'text'],
            ['regWin', 'rate_limit_register_window_ms', 'text'],
            ['redeemMax', 'rate_limit_redeem_max', 'text'],
            ['redeemWin', 'rate_limit_redeem_window_ms', 'text'],
            ['forgotMax', 'rate_limit_forgotpwd_max', 'text'],
            ['forgotWin', 'rate_limit_forgotpwd_window_ms', 'text'],
            ['jwtExpires', 'auth_jwt_expires_in', 'text'],
            ['saltRounds', 'auth_salt_rounds', 'text'],
          ])}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
            <Field label="登录限流 (次/分钟)">
              <input
                type="number"
                name="loginMax"
                defaultValue={g(cfg, 'rate_limit_login_max', '15')}
                min={1}
                max={1000}
                className={inputClass}
              />
            </Field>
            <Field label="登录窗口 (ms)">
              <input
                type="number"
                name="loginWin"
                defaultValue={g(cfg, 'rate_limit_login_window_ms', '60000')}
                min={1000}
                max={3600000}
                className={inputClass}
              />
            </Field>
            <Field label="注册限流 (次/10分钟)">
              <input
                type="number"
                name="regMax"
                defaultValue={g(cfg, 'rate_limit_register_max', '5')}
                min={1}
                max={1000}
                className={inputClass}
              />
            </Field>
            <Field label="注册窗口 (ms)">
              <input
                type="number"
                name="regWin"
                defaultValue={g(cfg, 'rate_limit_register_window_ms', '600000')}
                min={1000}
                max={3600000}
                className={inputClass}
              />
            </Field>
            <Field label="兑换限流 (次/分钟)">
              <input
                type="number"
                name="redeemMax"
                defaultValue={g(cfg, 'rate_limit_redeem_max', '10')}
                min={1}
                max={1000}
                className={inputClass}
              />
            </Field>
            <Field label="兑换窗口 (ms)">
              <input
                type="number"
                name="redeemWin"
                defaultValue={g(cfg, 'rate_limit_redeem_window_ms', '60000')}
                min={1000}
                max={3600000}
                className={inputClass}
              />
            </Field>
            <Field label="忘记密码限流 (次/小时)">
              <input
                type="number"
                name="forgotMax"
                defaultValue={g(cfg, 'rate_limit_forgotpwd_max', '3')}
                min={1}
                max={1000}
                className={inputClass}
              />
            </Field>
            <Field label="忘记密码窗口 (ms)">
              <input
                type="number"
                name="forgotWin"
                defaultValue={g(cfg, 'rate_limit_forgotpwd_window_ms', '3600000')}
                min={1000}
                max={3600000}
                className={inputClass}
              />
            </Field>
            <Field label="JWT 有效期">
              <select
                name="jwtExpires"
                defaultValue={g(cfg, 'auth_jwt_expires_in', '7d')}
                className={inputClass + ' bg-surface'}
              >
                <option value="1h">1 小时</option>
                <option value="6h">6 小时</option>
                <option value="12h">12 小时</option>
                <option value="1d">1 天</option>
                <option value="7d">7 天</option>
                <option value="30d">30 天</option>
              </select>
            </Field>
            <Field label="bcrypt 轮数">
              <input
                type="number"
                name="saltRounds"
                defaultValue={g(cfg, 'auth_salt_rounds', '12')}
                min={8}
                max={16}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="flex justify-end mt-4 pt-3 border-t border-border">
            <SaveButton loading={saving === 'ratelimit'} label="保存限流配置" />
          </div>
        </form>
      </Section>

      {/* ═══════════════════════════════════════════════════════════════
          3. 运维
          ═══════════════════════════════════════════════════════════════ */}
      <Section
        title="运维配置"
        expanded={expanded.ops}
        onToggle={() => toggle('ops')}
      >
        <form
          onSubmit={onSubmit('ops', [
            ['pollInterval', 'worker_poll_interval_ms', 'text'],
            ['staleMinutes', 'worker_stale_task_minutes', 'text'],
            ['siteTimeout', 'site_default_timeout_sec', 'text'],
            ['siteConcurrency', 'site_default_max_concurrency', 'text'],
            ['pageSize', 'pagination_default_page_size', 'text'],
            ['maxPageSize', 'pagination_max_page_size', 'text'],
          ])}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
            <Field label="Worker 轮询间隔 (ms)">
              <input
                type="number"
                name="pollInterval"
                defaultValue={g(cfg, 'worker_poll_interval_ms', '2000')}
                min={500}
                max={30000}
                step={500}
                className={inputClass}
              />
            </Field>
            <Field label="超时任务阈值 (分钟)">
              <input
                type="number"
                name="staleMinutes"
                defaultValue={g(cfg, 'worker_stale_task_minutes', '30')}
                min={5}
                max={120}
                className={inputClass}
              />
            </Field>
            <Field label="站点默认超时 (秒)">
              <input
                type="number"
                name="siteTimeout"
                defaultValue={g(cfg, 'site_default_timeout_sec', '300')}
                min={10}
                max={600}
                className={inputClass}
              />
            </Field>
            <Field label="站点默认并发数">
              <input
                type="number"
                name="siteConcurrency"
                defaultValue={g(cfg, 'site_default_max_concurrency', '10')}
                min={1}
                max={100}
                className={inputClass}
              />
            </Field>
            <Field label="分页默认条数">
              <input
                type="number"
                name="pageSize"
                defaultValue={g(cfg, 'pagination_default_page_size', '20')}
                min={5}
                max={100}
                className={inputClass}
              />
            </Field>
            <Field label="分页最大条数">
              <input
                type="number"
                name="maxPageSize"
                defaultValue={g(cfg, 'pagination_max_page_size', '50')}
                min={10}
                max={500}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="flex justify-end mt-4 pt-3 border-t border-border">
            <SaveButton loading={saving === 'ops'} label="保存运维配置" />
          </div>
        </form>
      </Section>

      {/* ═══════════════════════════════════════════════════════════════
          4. 媒体
          ═══════════════════════════════════════════════════════════════ */}
      <Section
        title="媒体配置"
        expanded={expanded.media}
        onToggle={() => toggle('media')}
      >
        <form
          onSubmit={onSubmit('media', [
            ['thumbW', 'thumbnail_width', 'text'],
            ['thumbQ', 'thumbnail_quality', 'text'],
            ['maxSize', 'image_max_file_size_mb', 'text'],
            ['maxRes', 'image_max_resolution', 'text'],
          ])}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
            <Field label="缩略图宽度 (px)">
              <input
                type="number"
                name="thumbW"
                defaultValue={g(cfg, 'thumbnail_width', '400')}
                min={100}
                max={2048}
                className={inputClass}
              />
            </Field>
            <Field label="缩略图质量 (%)">
              <input
                type="number"
                name="thumbQ"
                defaultValue={g(cfg, 'thumbnail_quality', '80')}
                min={10}
                max={100}
                className={inputClass}
              />
            </Field>
            <Field label="最大文件大小 (MB)">
              <input
                type="number"
                name="maxSize"
                defaultValue={g(cfg, 'image_max_file_size_mb', '20')}
                min={1}
                max={100}
                className={inputClass}
              />
            </Field>
            <Field label="最大分辨率 (px)">
              <input
                type="number"
                name="maxRes"
                defaultValue={g(cfg, 'image_max_resolution', '8192')}
                min={512}
                max={16384}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="flex justify-end mt-4 pt-3 border-t border-border">
            <SaveButton loading={saving === 'media'} label="保存媒体配置" />
          </div>
        </form>
      </Section>


      {/* ═══════════════════════════════════════════════════════════════
          5. 模板 AI
          ═══════════════════════════════════════════════════════════════ */}
      <Section
        title="模板 AI"
        expanded={expanded.templateAi}
        onToggle={() => toggle('templateAi')}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveTemplateAiSection(new FormData(e.currentTarget));
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3 items-end">
            <Field label="启用 AI 转模板">
              <div className="h-10 flex items-center">
                <Toggle name="enabled" defaultChecked={gb(cfg, 'template_ai_enabled', false)} />
              </div>
            </Field>
            <Field label="API Base URL">
              <input
                type="url"
                name="baseUrl"
                defaultValue={g(cfg, 'template_ai_base_url', 'https://api.openai.com/v1')}
                placeholder="https://api.openai.com/v1"
                className={inputClass}
              />
            </Field>
            <Field label="模型">
              <input
                type="text"
                name="model"
                defaultValue={g(cfg, 'template_ai_model', 'gpt-4.1-mini')}
                placeholder="gpt-4.1-mini"
                className={inputClass}
              />
            </Field>
            <Field label="API Key">
              <input
                type="password"
                name="apiKey"
                autoComplete="new-password"
                placeholder={g(cfg, 'template_ai_api_key') ? '已配置，留空不修改' : '未配置'}
                className={inputClass}
              />
            </Field>
            <Field label="温度">
              <input
                type="number"
                name="temperature"
                defaultValue={g(cfg, 'template_ai_temperature', '0.2')}
                min={0}
                max={1}
                step={0.1}
                className={inputClass}
              />
            </Field>
            <Field label="超时 (ms)">
              <input
                type="number"
                name="timeoutMs"
                defaultValue={g(cfg, 'template_ai_timeout_ms', '45000')}
                min={5000}
                max={120000}
                step={1000}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="mt-3">
            <Field label="系统提示词">
              <textarea
                name="systemPrompt"
                defaultValue={g(cfg, 'template_ai_system_prompt')}
                placeholder="留空使用后端内置的严格模板转换提示词"
                className={inputClass}
                style={{ minHeight: 150, height: 'auto', paddingTop: 10, paddingBottom: 10, lineHeight: 1.55, resize: 'vertical' }}
              />
            </Field>
            <p className="mt-2 text-xs leading-relaxed text-text-2">
              用户端只提交普通提示词；后端会要求 AI 按绘图姬模板 JSON 输出标题、介绍、模板变量、默认值和生成参数。
            </p>
          </div>

          <div className="flex justify-end mt-4 pt-3 border-t border-border">
            <SaveButton loading={saving === 'templateAi'} label="保存模板 AI 配置" />
          </div>
        </form>
      </Section>


      {/* ═══════════════════════════════════════════════════════════════
          6. 外观与充值
          ═══════════════════════════════════════════════════════════════ */}
      <Section
        title="外观与充值"
        expanded={expanded.appearance}
        onToggle={() => toggle('appearance')}
      >
        <form
          onSubmit={onSubmit('appearance', [
            ['siteBackgroundEnabled', 'site_background_enabled', 'toggle'],
            ['primaryColor', 'admin_primary_color', 'text'],
            ['pollInterval', 'admin_status_poll_interval_sec', 'text'],
            ['appBaseUrl', 'app_base_url', 'text'],
            ['corsOrigins', 'cors_allowed_origins', 'text'],
            ['shopUrl', 'recharge_shop_url', 'text'],
            ['amounts', 'recharge_supported_amounts', 'text'],
            ['batchDefault', 'recharge_default_batch_count', 'text'],
            ['batchMax', 'recharge_max_batch_count', 'text'],
          ])}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
            <Field label="主题色">
              <input
                type="color"
                name="primaryColor"
                defaultValue={g(cfg, 'admin_primary_color', '#4f46e5')}
                className="w-10 h-10 p-0.5 border border-border rounded-lg cursor-pointer bg-surface"
              />
            </Field>
            <Field label="状态轮询间隔 (秒)">
              <input
                type="number"
                name="pollInterval"
                defaultValue={g(cfg, 'admin_status_poll_interval_sec', '30')}
                min={5}
                max={300}
                className={inputClass}
              />
            </Field>
            <Field label="前台 URL">
              <input
                type="text"
                name="appBaseUrl"
                defaultValue={g(cfg, 'app_base_url', 'https://www.xanime.ink')}
                placeholder="https://www.xanime.ink"
                className={inputClass}
              />
            </Field>
          </div>

          <div className="mt-3">
            <Field label="CORS 允许源 (逗号分隔)">
              <input
                type="text"
                name="corsOrigins"
                defaultValue={g(
                  cfg,
                  'cors_allowed_origins',
                  'http://localhost:5173,http://localhost:5174',
                )}
                placeholder="http://localhost:5173,http://localhost:5174"
                className={inputClass}
              />
            </Field>
          </div>

          <div className="mt-3 rounded-xl border border-border bg-bg/45 p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <ImageIcon size={18} />
                </div>
                <div className="min-w-0">
                  <strong className="block text-sm text-text">全站背景图</strong>
                  <span className="block text-xs leading-relaxed text-text-2">覆盖前台全部页面；用户仍可在个人设置中关闭。</span>
                </div>
              </div>
              <label className="flex flex-none items-center gap-2 text-xs font-semibold text-text-2">
                <Toggle name="siteBackgroundEnabled" defaultChecked={gb(cfg, 'site_background_enabled', false)} />
                全局启用
              </label>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="overflow-hidden rounded-xl border border-border bg-surface">
                {backgroundImageUrl ? (
                  <img src={backgroundImageUrl} alt="当前全站背景图预览" className="h-40 w-full object-cover" />
                ) : (
                  <div className="flex h-40 items-center justify-center text-xs text-text-2">尚未上传背景图</div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 sm:flex-col">
                <input
                  ref={backgroundInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => void uploadBackground(event.target.files?.[0])}
                />
                <button
                  type="button"
                  className="btn btn-sm flex items-center gap-1.5"
                  disabled={backgroundUploading || backgroundDeleting}
                  onClick={() => backgroundInputRef.current?.click()}
                >
                  <Upload size={14} />{backgroundUploading ? '上传中...' : backgroundImageUrl ? '替换图片' : '上传图片'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline flex items-center gap-1.5"
                  disabled={!backgroundImageUrl || backgroundUploading || backgroundDeleting}
                  onClick={() => void deleteBackground()}
                >
                  <Trash2 size={14} />{backgroundDeleting ? '清除中...' : '清除图片'}
                </button>
              </div>
            </div>
            <p className="mt-2 text-xs text-text-2">支持 PNG、JPEG、WebP，最大 15MB；服务端会限制长边并转为 WebP。</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3 mt-3">
            <Field label="商店 URL">
              <input
                type="text"
                name="shopUrl"
                defaultValue={g(cfg, 'recharge_shop_url')}
                placeholder="https://shop.example.com"
                className={inputClass}
              />
            </Field>
            <Field label="支持额度 (逗号分隔)">
              <input
                type="text"
                name="amounts"
                defaultValue={g(cfg, 'recharge_supported_amounts', '5,10,25,50,100,150')}
                placeholder="5,10,25,50,100"
                className={inputClass}
              />
            </Field>
            <Field label="默认卡密批次">
              <input
                type="number"
                name="batchDefault"
                defaultValue={g(cfg, 'recharge_default_batch_count', '100')}
                min={1}
                max={10000}
                className={inputClass}
              />
            </Field>
            <Field label="最大卡密批次">
              <input
                type="number"
                name="batchMax"
                defaultValue={g(cfg, 'recharge_max_batch_count', '1000')}
                min={1}
                max={50000}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="flex justify-end mt-4 pt-3 border-t border-border">
            <SaveButton loading={saving === 'appearance'} label="保存外观配置" />
          </div>
        </form>
      </Section>

      {/* ═══════════════════════════════════════════════════════════════
          7. 注册
          ═══════════════════════════════════════════════════════════════ */}
      <Section
        title="注册配置"
        expanded={expanded.registration}
        onToggle={() => toggle('registration')}
      >
        <form
          onSubmit={onSubmit('registration', [
            ['enableReg', 'enable_registration', 'text'],
          ])}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 items-end">
            <Field label="开放注册">
              <select
                name="enableReg"
                defaultValue={g(cfg, 'enable_registration', 'true')}
                className={inputClass + ' bg-surface'}
              >
                <option value="true">开启</option>
                <option value="false">关闭</option>
              </select>
            </Field>
            <div className="flex justify-end">
              <SaveButton loading={saving === 'registration'} label="保存注册配置" />
            </div>
          </div>
        </form>
      </Section>
    </div>
  );
}
