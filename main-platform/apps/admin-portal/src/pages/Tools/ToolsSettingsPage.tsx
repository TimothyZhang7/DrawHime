/** 本页面管理用户端工具配置，所有值通过 backend /admin/config 持久化。 */
import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, Clock3, Loader2, RotateCw, Save, Settings, Sigma, TriangleAlert, Wrench } from 'lucide-react';
import type { ImageReverseWd14HealthResponse, ImageUpscaleHealthResponse, ToolId, ToolUsageOverviewResponse, ToolUsageView } from '@aiimage/shared-contracts';
import { api } from '../../api/client';
import Toast from '../../components/Toast';

interface ToastState {
  type: 'success' | 'error';
  message: string;
}

interface ToolSettingDefinition {
  id: ToolId;
  title: string;
  description: string;
  fields: ToolSettingField[];
}

interface ToolSettingField {
  name: string;
  key: string;
  label: string;
  type: 'toggle' | 'number' | 'text' | 'password' | 'textarea';
  defaultValue: string;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
  /** 密码类字段留空时不提交，避免管理员只改其他配置时清空生产密钥。 */
  preserveEmpty?: boolean;
}

const inputClass = 'w-full h-10 px-3 text-sm rounded-xl border border-border bg-surface text-text focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-colors';

const toolDefinitions: ToolSettingDefinition[] = [
  {
    id: 'image-splitter',
    title: '图片拆分',
    description: '用户上传本地图片后，按行列拆分并在浏览器本地打包下载。',
    fields: [
      { name: 'enabled', key: 'tools_image_splitter_enabled', label: '开放用户端入口', type: 'toggle', defaultValue: 'true' },
      { name: 'defaultRows', key: 'tools_image_splitter_default_rows', label: '默认行数', type: 'number', defaultValue: '3', min: 1, max: 12 },
      { name: 'defaultCols', key: 'tools_image_splitter_default_cols', label: '默认列数', type: 'number', defaultValue: '3', min: 1, max: 12 },
      { name: 'maxRows', key: 'tools_image_splitter_max_rows', label: '最大行数', type: 'number', defaultValue: '12', min: 1, max: 24 },
      { name: 'maxCols', key: 'tools_image_splitter_max_cols', label: '最大列数', type: 'number', defaultValue: '12', min: 1, max: 24 },
      { name: 'maxFileSizeMb', key: 'tools_image_splitter_max_file_size_mb', label: '最大文件大小', type: 'number', defaultValue: '30', min: 1, max: 200, suffix: 'MB' },
    ],
  },
  {
    id: 'image-converter',
    title: '格式转换与压缩',
    description: '用户在浏览器本地批量转换 PNG、JPEG、WebP，并按质量、尺寸或目标体积压缩。',
    fields: [
      { name: 'enabled', key: 'tools_image_converter_enabled', label: '开放用户端入口', type: 'toggle', defaultValue: 'true' },
      { name: 'maxFileSizeMb', key: 'tools_image_converter_max_file_size_mb', label: '单文件最大大小', type: 'number', defaultValue: '30', min: 1, max: 200, suffix: 'MB' },
      { name: 'maxBatchCount', key: 'tools_image_converter_max_batch_count', label: '单批最大图片数', type: 'number', defaultValue: '20', min: 1, max: 50, suffix: '张' },
      { name: 'defaultFormat', key: 'tools_image_converter_default_format', label: '默认输出格式', type: 'text', defaultValue: 'webp', placeholder: 'webp/jpeg/png' },
      { name: 'defaultQuality', key: 'tools_image_converter_default_quality', label: '默认有损质量', type: 'number', defaultValue: '82', min: 1, max: 100 },
    ],
  },
  {
    id: 'image-scrambler',
    title: '图片混淆',
    description: '用户上传本地图片后，按空间填充曲线一键生成混淆图或解混淆。',
    fields: [
      { name: 'enabled', key: 'tools_image_scrambler_enabled', label: '开放用户端入口', type: 'toggle', defaultValue: 'true' },
      { name: 'maxFileSizeMb', key: 'tools_image_scrambler_max_file_size_mb', label: '最大文件大小', type: 'number', defaultValue: '30', min: 1, max: 200, suffix: 'MB' },
    ],
  },
  {
    id: 'image-wobble',
    title: '局部抖动',
    description: '用户在浏览器本地涂抹图片区域，通过 WebGL 生成局部弹性形变并录制导出。',
    fields: [
      { name: 'enabled', key: 'tools_image_wobble_enabled', label: '开放用户端入口', type: 'toggle', defaultValue: 'true' },
      { name: 'maxFileSizeMb', key: 'tools_image_wobble_max_file_size_mb', label: '最大文件大小', type: 'number', defaultValue: '30', min: 1, max: 200, suffix: 'MB' },
    ],
  },
  {
    id: 'image-reverse',
    title: '图片反推',
    description: '用户上传一张图片后，由后台配置的真实识图模型提取风格、构图和可复用绘图提示词。',
    fields: [
      { name: 'enabled', key: 'tools_image_reverse_enabled', label: '开放用户端入口', type: 'toggle', defaultValue: 'false' },
      { name: 'baseUrl', key: 'tools_image_reverse_base_url', label: 'API Base URL', type: 'text', defaultValue: '', placeholder: 'https://example.com/v1' },
      { name: 'apiKey', key: 'tools_image_reverse_api_key', label: 'API Key', type: 'password', defaultValue: '', placeholder: '留空则保持原密钥', preserveEmpty: true },
      { name: 'model', key: 'tools_image_reverse_model', label: '识图模型', type: 'text', defaultValue: 'gpt-5.6-sol', placeholder: 'gpt-5.6-sol' },
      { name: 'maxFileSizeMb', key: 'tools_image_reverse_max_file_size_mb', label: '最大文件大小', type: 'number', defaultValue: '20', min: 1, max: 100, suffix: 'MB' },
      { name: 'timeoutSec', key: 'tools_image_reverse_timeout_sec', label: '请求超时', type: 'number', defaultValue: '300', min: 5, max: 600, suffix: '秒' },
      { name: 'maxOutputChars', key: 'tools_image_reverse_max_output_chars', label: '最大输出长度', type: 'number', defaultValue: '6000', min: 500, max: 20000, suffix: '字' },
      { name: 'defaultMode', key: 'tools_image_reverse_default_mode', label: '默认模式', type: 'text', defaultValue: 'description', placeholder: 'description/prompt/character/tags/edit' },
      { name: 'defaultLanguage', key: 'tools_image_reverse_default_language', label: '默认语言', type: 'text', defaultValue: 'zh', placeholder: 'zh/en/zh-CN/en-US' },
      { name: 'defaultPromptLanguage', key: 'tools_image_reverse_default_prompt_language', label: '默认 Prompt 语言', type: 'text', defaultValue: 'auto', placeholder: 'auto/zh/en/bilingual' },
      { name: 'enabledModes', key: 'tools_image_reverse_enabled_modes', label: '开放模式', type: 'text', defaultValue: 'description,prompt,character,tags,edit', placeholder: 'description,prompt,character,tags,edit' },
      { name: 'enabledLanguages', key: 'tools_image_reverse_enabled_languages', label: '开放语言', type: 'text', defaultValue: 'zh,en,zh-CN,en-US', placeholder: 'zh,en,zh-CN,en-US,ja-JP,ko-KR,zh-TW' },
      { name: 'wd14Enabled', key: 'tools_image_reverse_wd14_enabled', label: '启用 WD14 混合证据', type: 'toggle', defaultValue: 'false' },
      { name: 'wd14BaseUrl', key: 'tools_image_reverse_wd14_base_url', label: 'WD14 Provider 地址', type: 'text', defaultValue: '', placeholder: 'https://gpu.example.com' },
      { name: 'wd14ApiKey', key: 'tools_image_reverse_wd14_api_key', label: 'WD14 Provider 密钥', type: 'password', defaultValue: '', placeholder: '留空则保持原密钥', preserveEmpty: true },
      { name: 'wd14Model', key: 'tools_image_reverse_wd14_model', label: 'WD14 模型', type: 'text', defaultValue: 'wd-eva02-large-tagger-v3', placeholder: 'wd-eva02-large-tagger-v3' },
      { name: 'wd14TimeoutSec', key: 'tools_image_reverse_wd14_timeout_sec', label: 'WD14 超时', type: 'number', defaultValue: '120', min: 5, max: 600, suffix: '秒' },
      { name: 'wd14GeneralThreshold', key: 'tools_image_reverse_wd14_general_threshold', label: 'General 阈值', type: 'number', defaultValue: '0.35', min: 0.01, max: 1, step: 0.01 },
      { name: 'wd14CharacterThreshold', key: 'tools_image_reverse_wd14_character_threshold', label: 'Character 阈值', type: 'number', defaultValue: '0.85', min: 0.01, max: 1, step: 0.01 },
      { name: 'wd14MaxTags', key: 'tools_image_reverse_wd14_max_tags', label: 'WD14 标签上限', type: 'number', defaultValue: '300', min: 1, max: 500 },
      {
        name: 'systemPrompt',
        key: 'tools_image_reverse_system_prompt',
        label: '系统提示词',
        type: 'textarea',
        defaultValue: '',
        placeholder: '留空使用后端默认图片反推提示词',
      },
    ],
  },
  {
    id: 'image-upscale',
    title: '图片放大',
    description: '用户上传一张图片后，由后台配置的私有 GPU 超分服务放大并返回结果图。',
    fields: [
      { name: 'enabled', key: 'tools_image_upscale_enabled', label: '开放用户端入口', type: 'toggle', defaultValue: 'false' },
      { name: 'baseUrl', key: 'tools_image_upscale_base_url', label: 'GPU 服务地址', type: 'text', defaultValue: '', placeholder: 'https://gpu.example.com' },
      { name: 'apiKey', key: 'tools_image_upscale_api_key', label: '服务密钥', type: 'password', defaultValue: '', placeholder: '留空则保持原密钥', preserveEmpty: true },
      { name: 'model', key: 'tools_image_upscale_model', label: '默认模型', type: 'text', defaultValue: 'RealESRGAN_x4plus_anime_6B', placeholder: 'RealESRGAN_x4plus_anime_6B' },
      { name: 'allowedModels', key: 'tools_image_upscale_allowed_models', label: '允许模型', type: 'text', defaultValue: 'RealESRGAN_x4plus_anime_6B,realesr-animevideov3,realesr-general-x4v3,realesr-general-wdn-x4v3,RealESRGAN_x2plus,RealESRGAN_x4plus,RealESRNet_x4plus', placeholder: '多个模型用英文逗号分隔' },
      { name: 'maxFileSizeMb', key: 'tools_image_upscale_max_file_size_mb', label: '最大文件大小', type: 'number', defaultValue: '30', min: 1, max: 200, suffix: 'MB' },
      { name: 'timeoutSec', key: 'tools_image_upscale_timeout_sec', label: '请求超时', type: 'number', defaultValue: '120', min: 10, max: 600, suffix: '秒' },
      { name: 'allowedScales', key: 'tools_image_upscale_allowed_scales', label: '允许倍率', type: 'text', defaultValue: '2,4', placeholder: '2,3,4' },
      { name: 'defaultScale', key: 'tools_image_upscale_default_scale', label: '默认倍率', type: 'number', defaultValue: '2', min: 2, max: 4, suffix: 'x' },
      { name: 'maxOutputPixels', key: 'tools_image_upscale_max_output_pixels', label: '最大输出像素', type: 'number', defaultValue: '64000000', min: 4000000, max: 160000000 },
      { name: 'maxConcurrency', key: 'tools_image_upscale_max_concurrency', label: '最大并发', type: 'number', defaultValue: '1', min: 1, max: 8 },
      { name: 'queueMaxPending', key: 'tools_image_upscale_queue_max_pending', label: '等待队列', type: 'number', defaultValue: '8', min: 0, max: 200 },
      { name: 'queueTimeoutSec', key: 'tools_image_upscale_queue_timeout_sec', label: '排队超时', type: 'number', defaultValue: '30', min: 1, max: 600, suffix: '秒' },
    ],
  },
];

/** 后台工具设置页。 */
export function ToolsSettingsPage() {
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<ToolUsageOverviewResponse | null>(null);
  const [upscaleHealth, setUpscaleHealth] = useState<ImageUpscaleHealthResponse | null>(null);
  const [wd14Health, setWd14Health] = useState<ImageReverseWd14HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    const [configRes, usageRes] = await Promise.all([
      api<Record<string, string>>('/admin/config'),
      api<ToolUsageOverviewResponse>('/admin/tools/usage'),
    ]);
    if (configRes.ok && configRes.data) {
      setCfg(configRes.data);
    } else {
      setToast({ type: 'error', message: configRes.message ?? '加载工具配置失败' });
    }
    if (usageRes.ok && usageRes.data) setUsage(usageRes.data);
    const [healthRes, wd14HealthRes] = await Promise.all([
      api<ImageUpscaleHealthResponse>('/admin/tools/image-upscale/health'),
      api<ImageReverseWd14HealthResponse>('/admin/tools/image-reverse/wd14/health'),
    ]);
    if (healthRes.ok && healthRes.data) setUpscaleHealth(healthRes.data);
    if (wd14HealthRes.ok && wd14HealthRes.data) setWd14Health(wd14HealthRes.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  /** 保存单个工具的配置。 */
  const saveTool = async (tool: ToolSettingDefinition, form: HTMLFormElement) => {
    setSaving(tool.id);
    const formData = new FormData(form);
    const payload: Record<string, string> = {};
    for (const field of tool.fields) {
      const rawValue = String(formData.get(field.name) ?? '');
      if (field.preserveEmpty && rawValue.trim() === '') {
        // 密钥字段空值不提交，避免保存其他字段时把生产密钥覆盖为空。
        continue;
      }
      payload[field.key] = field.type === 'toggle'
        ? String(formData.has(field.name))
        : rawValue || field.defaultValue;
    }
    const res = await api('/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setToast({ type: 'success', message: '工具配置已保存' });
      await loadConfig();
    } else {
      setToast({ type: 'error', message: res.message ?? '保存失败' });
    }
    setSaving('');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={22} className="animate-spin text-primary" />
        <span className="ml-3 text-sm text-text-2">加载工具配置中...</span>
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-5 gap-3">
        <div className="flex items-center gap-2.5">
          <Wrench size={20} className="text-primary" />
          <div>
            <h2 className="text-lg font-extrabold text-text">工具设置</h2>
            <p className="text-xs text-text-2 mt-1">配置用户端工具入口和默认参数，后续新增工具会在这里扩展。</p>
          </div>
        </div>
        <button type="button" onClick={loadConfig} className="btn btn-sm btn-outline flex items-center gap-1.5">
          <RotateCw size={14} />
          刷新
        </button>
      </div>

      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

      <div className="grid grid-cols-1 gap-4">
        {toolDefinitions.map((tool) => {
          const usageStats = usage?.tools.find((item) => item.id === tool.id) ?? null;
          return (
          <form
            key={tool.id}
            className="card"
            onSubmit={(event) => {
              event.preventDefault();
              void saveTool(tool, event.currentTarget);
            }}
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Settings size={16} className="text-primary" />
                  <h3 className="text-sm font-bold text-text">{tool.title}</h3>
                </div>
                <p className="text-xs text-text-2 mt-1">{tool.description}</p>
              </div>
              <button type="submit" disabled={saving === tool.id} className="btn btn-sm flex items-center gap-1.5">
                {saving === tool.id ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                保存
              </button>
            </div>

            <ToolUsageStats stats={usageStats} />
            {tool.id === 'image-reverse' && <ImageReverseWd14HealthPanel health={wd14Health} />}
            {tool.id === 'image-upscale' && <ImageUpscaleHealthPanel health={upscaleHealth} />}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {tool.fields.map((field) => (
                <ToolField key={field.key} field={field} value={cfg[field.key] ?? field.defaultValue} />
              ))}
            </div>
          </form>
        ); })}
      </div>
    </div>
  );
}

/** 渲染 WD14 Provider 健康状态与真实 ONNX Execution Provider。 */
function ImageReverseWd14HealthPanel({ health }: { health: ImageReverseWd14HealthResponse | null }) {
  const ok = health?.upstream.ok === true;
  const providers = health?.upstream.activeProviders?.length ? health.upstream.activeProviders : health?.upstream.availableProviders ?? [];
  return (
    <div className="mb-4 rounded-xl border border-border bg-bg px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-text">
          {ok ? <CheckCircle2 size={14} className="text-emerald-600" /> : <TriangleAlert size={14} className="text-amber-600" />}
          WD14 Provider
        </div>
        <span className={`text-[11px] font-bold ${ok ? 'text-emerald-700' : 'text-amber-700'}`}>{ok ? '可用' : health?.upstream.error ?? '未检查'}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
        <HealthCell label="模型文件" value={health?.upstream.modelReady ? '就绪' : '未就绪'} />
        <HealthCell label="标签表" value={health?.upstream.tagsReady ? '就绪' : '未就绪'} />
        <HealthCell label="Session" value={health?.upstream.loaded ? '已加载' : '按需加载'} />
        <HealthCell label="Runtime" value={health?.upstream.runtimeVersion ?? '-'} />
      </div>
      <div className="mt-2 truncate text-[11px] font-semibold text-text-2" title={providers.join(', ')}>Provider：{providers.join(', ') || '-'}</div>
      {health && <div className="mt-1 text-[11px] font-semibold text-text-2">阈值：general {health.generalThreshold} · character {health.characterThreshold}</div>}
    </div>
  );
}

/** 渲染图片放大 GPU 健康状态；数据来自 backend 管理接口，不暴露 GPU 密钥。 */
function ImageUpscaleHealthPanel({ health }: { health: ImageUpscaleHealthResponse | null }) {
  const ok = health?.upstream.ok === true;
  const availableModels = health?.upstream.availableModels ?? [];
  const weightFiles = health?.upstream.weightFiles ?? [];
  const loadedModels = health?.upstream.models ?? [];
  /** GPU 刚重启时 loaded 为空是正常的，后台展示优先使用可用模型和权重文件。 */
  const displayModels = availableModels.length > 0 ? availableModels : weightFiles.length > 0 ? weightFiles : loadedModels;
  return (
    <div className="mb-4 rounded-xl border border-border bg-bg px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-text">
          {ok ? <CheckCircle2 size={14} className="text-emerald-600" /> : <TriangleAlert size={14} className="text-amber-600" />}
          GPU 健康
        </div>
        <span className={`text-[11px] font-bold ${ok ? 'text-emerald-700' : 'text-amber-700'}`}>
          {ok ? '正常' : health?.upstream.error ?? '未检查'}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
        <HealthCell label="设备" value={health?.upstream.device ?? '-'} />
        <HealthCell label="CUDA" value={health?.upstream.cuda === true ? '启用' : health ? '未启用' : '-'} />
        <HealthCell label="队列" value={health ? `${health.queue.active}/${health.queue.pending}` : '-'} />
        <HealthCell label="可用模型" value={String(availableModels.length || health?.allowedModels.length || 0)} />
        <HealthCell label="权重文件" value={String(weightFiles.length)} />
        <HealthCell label="已加载" value={String(loadedModels.length)} />
        <HealthCell label="缓存上限" value={String(health?.upstream.modelCacheLimit ?? '-')} />
      </div>
      {health ? (
        <div className="mt-2 text-[11px] font-semibold text-text-2">
          最老等待 {formatDurationMs(health.queue.oldestPendingMs)}，排队上限 {formatDurationMs(health.queue.maxWaitMs)}
        </div>
      ) : null}
      {displayModels.length ? (
        <div className="mt-2 truncate text-[11px] font-semibold text-text-2" title={displayModels.join(', ')}>
          模型：{displayModels.join(', ')}
        </div>
      ) : null}
      {loadedModels.length === 0 && displayModels.length > 0 ? (
        <div className="mt-1 text-[11px] font-semibold text-text-2">
          已加载只表示运行时缓存，GPU 服务重启后会在首次调用模型时重新加载。
        </div>
      ) : null}
    </div>
  );
}

/** 渲染健康状态中的单个只读指标。 */
function HealthCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
      <span className="block text-[11px] font-semibold text-text-2">{label}</span>
      <strong className="mt-0.5 block truncate text-xs text-text" title={value}>{value}</strong>
    </div>
  );
}

/** 渲染工具调用计数，统计来自 backend 聚合数据，不在前端伪造。 */
function ToolUsageStats({ stats }: { stats: ToolUsageView | null }) {
  const total = stats?.totalCount ?? 0;
  const today = stats?.todayCount ?? 0;
  const lastUsed = stats?.lastUsedAt ? formatDateTime(stats.lastUsedAt) : '暂无调用';
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
      <div className="min-h-16 rounded-xl border border-border bg-bg px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-2"><Sigma size={13} />累计调用</div>
        <strong className="block mt-1 text-lg text-text">{total.toLocaleString('zh-CN')}</strong>
      </div>
      <div className="min-h-16 rounded-xl border border-border bg-bg px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-2"><Activity size={13} />今日调用</div>
        <strong className="block mt-1 text-lg text-text">{today.toLocaleString('zh-CN')}</strong>
      </div>
      <div className="min-h-16 rounded-xl border border-border bg-bg px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-2"><Clock3 size={13} />最近调用</div>
        <strong className="block mt-1 text-sm text-text truncate" title={lastUsed}>{lastUsed}</strong>
      </div>
    </div>
  );
}

/** 渲染单个工具配置字段。 */
function ToolField({ field, value }: { field: ToolSettingField; value: string }) {
  if (field.type === 'toggle') {
    return (
      <label className="flex items-center justify-between gap-3 min-h-10 px-3 border border-border rounded-xl bg-surface">
        <span className="text-xs font-semibold text-text-2">{field.label}</span>
        <input
          type="checkbox"
          name={field.name}
          defaultChecked={value !== 'false'}
          className="appearance-none relative w-10 h-5 bg-border rounded-full checked:bg-primary cursor-pointer transition-colors before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:w-4 before:h-4 before:bg-white before:rounded-full before:shadow before:transition-transform checked:before:translate-x-5"
        />
      </label>
    );
  }

  if (field.type === 'textarea') {
    return (
      <label className="block sm:col-span-2 lg:col-span-3">
        <span className="block text-xs font-medium text-text-2 mb-1.5">{field.label}</span>
        <textarea
          name={field.name}
          defaultValue={value}
          placeholder={field.placeholder}
          className={`${inputClass} min-h-28 py-2 resize-y leading-5`}
        />
      </label>
    );
  }

  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-2 mb-1.5">{field.label}</span>
      <div className="flex items-center gap-2">
        <input
          type={field.type}
          name={field.name}
          defaultValue={field.type === 'password' ? '' : value}
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={field.placeholder}
          className={inputClass}
        />
        {field.suffix && <span className="text-xs text-text-2 flex-shrink-0">{field.suffix}</span>}
      </div>
    </label>
  );
}

/** 后台统计时间按中国时区展示，避免与“今日调用”的日期口径错位。 */
function formatDateTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '暂无调用';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

/** 把毫秒时长压缩成后台卡片中的短文本。 */
function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0s';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}
