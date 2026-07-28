import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Edit, Trash2, Power, RotateCw, Globe, MinusCircle } from 'lucide-react';
import { api } from '../../api/client';
import Toast from '../../components/Toast';
import { Modal } from '../../components/Modal';
import Table from '../../components/Table';
import type { TableColumn } from '../../components/Table';
import { SiteCompatibilitySettings } from './SiteCompatibilitySettings';
import {
  resolveMaxReferenceImages,
  resolveAspectRatioSupport,
  resolveReferenceImageField,
  resolveReferenceImageOverflowStrategy,
  supportsCombinedReferenceImage,
  type ApiSiteModelOption,
  type ReferenceImageField,
  type ReferenceImageOverflowStrategy,
  type SiteModelApiMode,
  type SiteModelAspectRatioSupport,
  type SiteModelType,
} from '@aiimage/shared-contracts';

/* ===== Types ===== */

type ModelOption = Partial<ApiSiteModelOption> & Pick<ApiSiteModelOption, 'name'>;

type ModelOptionType = SiteModelType;
type ModelApiMode = SiteModelApiMode;

interface SiteRecord {
  id: number;
  name: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked?: string | null;
  isEnabled: boolean;
  weight: number;
  timeoutSec: number;
  maxConcurrency: number;
  sendResponseFormat: boolean;
  sendPromptCacheKey: boolean;
  autoSizeFromReference: boolean;
  modelOptions: ModelOption[];
  consecutiveFailures: number;
}

interface RuntimeStat {
  siteId: number;
  successRate: number;
  avgLatencyMs: number;
}

interface SiteFormData {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  weight: number;
  timeoutSec: number;
  maxConcurrency: number;
  sendResponseFormat: boolean;
  sendPromptCacheKey: boolean;
  autoSizeFromReference: boolean;
}

const EMPTY_FORM: SiteFormData = {
  name: '',
  model: '',
  baseUrl: '',
  apiKey: '',
  weight: 10,
  timeoutSec: 30,
  maxConcurrency: 10,
  sendResponseFormat: true,
  sendPromptCacheKey: false,
  autoSizeFromReference: false,
};

const MODEL_API_MODE_LABELS: Record<ModelApiMode, string> = {
  openai_images: 'OpenAI 格式',
  bfl_image_generation: 'BFL 格式',
  grok_image_edit_json: 'Grok 格式',
  grok_video_generation: 'Grok 视频格式',
  comfyui_generation: 'ComfyUI 格式',
};

/** 新站点只允许选择外部 API 格式；ComfyUI 仅用于展示历史只读配置。 */
const ACTIVE_MODEL_API_MODES = Object.entries(MODEL_API_MODE_LABELS)
  .filter(([value]) => value !== 'comfyui_generation');

/** 画幅能力必须对应上游实测，不支持的比例不会进入前台选项或 Worker 候选。 */
const MODEL_ASPECT_RATIO_SUPPORT_LABELS: Record<SiteModelAspectRatioSupport, string> = {
  all: '全部常用比例',
  gpt_image: 'GPT 原生比例',
  grok_video: 'Grok 视频比例',
  square_only: '仅正方形',
  auto_only: '仅自动',
};

const MODEL_PRESETS: Array<{
  name: string;
  type: ModelOptionType;
  apiMode: ModelApiMode;
  maxReferenceImages?: number;
  referenceImageField?: ReferenceImageField;
  referenceImageOverflowStrategy?: ReferenceImageOverflowStrategy;
  buttonLabel: string;
}> = [
  { name: 'flux-kontext-pro', type: 'universal', apiMode: 'bfl_image_generation', buttonLabel: '添加 FLUX Kontext Pro' },
  {
    name: 'grok-imagine-image-quality',
    type: 'universal',
    apiMode: 'grok_image_edit_json',
    maxReferenceImages: 4,
    referenceImageField: 'image',
    referenceImageOverflowStrategy: 'reject',
    buttonLabel: '添加 Grok Quality',
  },
  {
    name: 'grok-imagine-video',
    type: 'video',
    apiMode: 'grok_video_generation',
    maxReferenceImages: 8,
    referenceImageField: 'image',
    referenceImageOverflowStrategy: 'reject',
    buttonLabel: '添加 Grok 视频',
  },
];

/** 规范化后台模型类型，兼容历史 image 字段，避免保存后 worker 无法匹配。 */
function normalizeModelOption(option: ModelOption): ModelOption {
  const rawType = option.type as string | undefined;
  const type: ModelOptionType = rawType === 'text_to_image' || rawType === 'image_to_image' || rawType === 'universal' || rawType === 'video' || rawType === 'text'
    ? rawType
    : rawType === 'image'
      ? 'universal'
      : option.name === 'gemini-3.5-flash'
        ? 'text'
        : 'universal';
  const normalized = { ...option, name: option.name.trim(), type, apiMode: normalizeModelApiMode({ ...option, type }), enabled: option.enabled !== false };
  return {
    ...normalized,
    maxReferenceImages: resolveMaxReferenceImages(normalized),
    referenceImageField: resolveReferenceImageField(normalized),
    referenceImageOverflowStrategy: supportsCombinedReferenceImage(normalized.apiMode)
      ? resolveReferenceImageOverflowStrategy({
        maxReferenceImages: resolveMaxReferenceImages(normalized),
        referenceImageOverflowStrategy: normalized.referenceImageOverflowStrategy,
      })
      : 'reject',
    aspectRatioSupport: resolveAspectRatioSupport(normalized),
  };
}

/** 规范化模型调用协议；已清理的历史格式统一显示为 OpenAI 格式。 */
function normalizeModelApiMode(option: ModelOption): ModelApiMode {
  if (option.apiMode === 'openai_images' || option.apiMode === 'bfl_image_generation' || option.apiMode === 'grok_image_edit_json' || option.apiMode === 'grok_video_generation' || option.apiMode === 'comfyui_generation') return option.apiMode;
  return 'openai_images';
}

/** 切换站点格式时同步该协议已经验证的参考图能力默认值。 */
function getApiModeDefaults(apiMode: ModelApiMode, currentType?: ModelOptionType): Partial<ModelOption> {
  if (apiMode === 'grok_video_generation') {
    return { apiMode, type: 'video', maxReferenceImages: 8, referenceImageField: 'image', referenceImageOverflowStrategy: 'reject', aspectRatioSupport: 'grok_video' };
  }
  const type = currentType === 'video' ? 'universal' : currentType;
  if (apiMode === 'grok_image_edit_json') {
    return { apiMode, type, maxReferenceImages: 4, referenceImageField: 'image', referenceImageOverflowStrategy: 'reject', aspectRatioSupport: 'all' };
  }
  if (apiMode === 'bfl_image_generation') {
    return { apiMode, type, maxReferenceImages: 1, referenceImageField: 'image', referenceImageOverflowStrategy: 'combine', aspectRatioSupport: 'all' };
  }
  if (apiMode === 'comfyui_generation') return { apiMode, type: 'text_to_image', maxReferenceImages: 0, referenceImageField: 'image', referenceImageOverflowStrategy: 'reject', aspectRatioSupport: 'all' };
  return { apiMode, type, aspectRatioSupport: 'all' };
}

/* ===== Toast manager (lightweight state list driving the shared Toast component) ===== */

interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error';
}

/* ===== Main Page Component ===== */

export function SitesPage() {
  /* --- Data --- */
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [runtimeStats, setRuntimeStats] = useState<Map<number, RuntimeStat>>(new Map());
  const [loading, setLoading] = useState(true);

  /* --- Add / Edit Modal --- */
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<SiteFormData>(EMPTY_FORM);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [newModel, setNewModel] = useState<ModelOption>({ name: '', type: 'universal', apiMode: 'openai_images', maxReferenceImages: 1, referenceImageField: 'image', referenceImageOverflowStrategy: 'combine', enabled: true });
  const [apiKeyReplaceEnabled, setApiKeyReplaceEnabled] = useState(true);

  /* --- Delete confirm --- */
  const [deleteTarget, setDeleteTarget] = useState<SiteRecord | null>(null);

  /* --- Toast --- */
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const addToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);
  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  /* ==================================================================
   *  Data fetching
   * ================================================================*/

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [sitesRes, statsRes] = await Promise.all([
        api<SiteRecord[]>('/admin/sites'),
        api<RuntimeStat[]>('/admin/sites/runtime-stats'),
      ]);

      if (sitesRes.ok && sitesRes.data) {
        setSites(sitesRes.data);
      } else {
        addToast('error', sitesRes.message || '获取站点列表失败');
      }

      if (statsRes.ok && statsRes.data) {
        const map = new Map<number, RuntimeStat>();
        const items = Array.isArray(statsRes.data) ? statsRes.data : ((statsRes.data as any).sites ?? []);
        for (const s of items) {
          map.set(s.siteId, s);
        }
        setRuntimeStats(map);
      }
    } catch {
      addToast('error', '网络错误，获取站点数据失败');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  /* ==================================================================
   *  Modal open / close
   * ================================================================*/

  const openAddModal = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setModels([]);
    setApiKeyReplaceEnabled(true);
    setNewModel({ name: '', type: 'universal', apiMode: 'openai_images', maxReferenceImages: 1, referenceImageField: 'image', referenceImageOverflowStrategy: 'combine', enabled: true });
    setModalOpen(true);
  };

  const openEditModal = (site: SiteRecord) => {
    setEditingId(site.id);
    setForm({
      name: site.name,
      model: site.model || '',
      baseUrl: site.baseUrl,
      apiKey: '',
      weight: site.weight,
      timeoutSec: site.timeoutSec,
      maxConcurrency: site.maxConcurrency,
      sendResponseFormat: site.sendResponseFormat !== false,
      sendPromptCacheKey: site.sendPromptCacheKey === true,
      autoSizeFromReference: site.autoSizeFromReference === true,
    });
    setModels((site.modelOptions || []).map(normalizeModelOption));
    // 编辑站点默认不渲染密钥输入框，浏览器和密码管理器没有可自动填充的目标。
    setApiKeyReplaceEnabled(false);
    setNewModel({ name: '', type: 'universal', apiMode: 'openai_images', maxReferenceImages: 1, referenceImageField: 'image', referenceImageOverflowStrategy: 'combine', enabled: true });
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingId(null);
    setApiKeyReplaceEnabled(false);
  };

  /* ==================================================================
   *  CRUD handlers
   * ================================================================*/

  const handleSave = async () => {
    if (!form.name.trim()) { addToast('error', '请输入站点名称'); return; }
    if (!form.baseUrl.trim()) { addToast('error', '请输入 API URL'); return; }

    const { apiKey, ...siteFields } = form;
    const body = {
      ...siteFields,
      // 编辑时只有管理员显式开启替换且输入非空值，才把 API Key 发送给 backend。
      ...(!editingId || (apiKeyReplaceEnabled && apiKey.trim()) ? { apiKey: apiKey.trim() } : {}),
      modelOptions: models.map(normalizeModelOption),
    };

    const result = editingId
      ? await api(`/admin/sites/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await api('/admin/sites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

    if (result.ok) {
      addToast('success', editingId ? '站点已更新' : '站点已创建');
      closeModal();
      fetchData();
    } else {
      addToast('error', result.message || '保存失败');
    }
  };

  const handleToggle = async (site: SiteRecord) => {
    const result = await api(`/admin/sites/${site.id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isEnabled: !site.isEnabled }),
    });

    if (result.ok) {
      addToast('success', site.isEnabled ? '站点已停用' : '站点已启用');
      fetchData();
    } else {
      addToast('error', result.message || '操作失败');
    }
  };

  const handleResetFailures = async (siteId: number) => {
    const result = await api(`/admin/sites/${siteId}/reset-failures`, { method: 'POST' });

    if (result.ok) {
      addToast('success', '连败计数已重置');
      fetchData();
    } else {
      addToast('error', result.message || '操作失败');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const result = await api(`/admin/sites/${deleteTarget.id}`, { method: 'DELETE' });

    if (result.ok) {
      addToast('success', '站点已删除');
      setDeleteTarget(null);
      fetchData();
    } else {
      addToast('error', result.message || '删除失败');
    }
  };

  /* ==================================================================
   *  Model options sub-form helpers
   * ================================================================*/

  const addModel = () => {
    if (!newModel.name.trim()) { addToast('error', '请输入模型名称'); return; }
    if (models.some(m => m.name === newModel.name.trim())) { addToast('error', '模型名重复'); return; }
    setModels(prev => [...prev, normalizeModelOption({ ...newModel, name: newModel.name.trim() })]);
    setNewModel({ name: '', type: 'universal', apiMode: 'openai_images', maxReferenceImages: 1, referenceImageField: 'image', referenceImageOverflowStrategy: 'combine', enabled: true });
  };

  /** 添加已验证的模型预设；参考图上限和超限策略必须随真实端点能力一并写入。 */
  const addModelPreset = (preset: typeof MODEL_PRESETS[number]) => {
    if (models.some(m => m.name === preset.name)) { addToast('error', '模型名重复'); return; }
    const { buttonLabel: _buttonLabel, ...modelPreset } = preset;
    setModels(prev => [...prev, normalizeModelOption({ ...modelPreset, enabled: true })]);
    // 已验证的视频生成通常超过 30 秒，添加预设时同步提高站点超时，但不覆盖管理员更大的值。
    if (preset.apiMode === 'grok_video_generation') setForm(prev => ({ ...prev, timeoutSec: Math.max(prev.timeoutSec, 120) }));
  };

  const toggleModel = (idx: number) => {
    setModels(prev => prev.map((m, i) => (i === idx ? { ...m, enabled: !m.enabled } : m)));
  };

  /** 更新单个模型参考图能力，保存前仍会经过统一规范化。 */
  const updateModel = (idx: number, patch: Partial<ModelOption>) => {
    setModels(prev => prev.map((model, modelIndex) => (modelIndex === idx ? normalizeModelOption({ ...model, ...patch }) : model)));
  };

  const removeModel = (idx: number) => {
    setModels(prev => prev.filter((_, i) => i !== idx));
  };

  /* ==================================================================
   *  Table column definitions
   * ================================================================*/

  const columns: TableColumn<SiteRecord>[] = [
    {
      key: 'id',
      label: 'ID',
      width: '60px',
    },
    {
      key: 'name',
      label: '名称',
      width: '140px',
      render: (_val, row) => (
        <span className="font-medium" style={{ color: 'var(--color-text)' }}>
          {row.name}
        </span>
      ),
    },
    {
      key: 'weight',
      label: '权重',
      width: '60px',
      render: (_val) => <span className="tabular-nums">{String(_val)}</span>,
    },
    {
      key: 'modelOptions',
      label: '可用模型',
      width: '180px',
      render: (_val, row) => {
        const names = (row.modelOptions || [])
          .filter((m: ModelOption) => m.enabled !== false)
          .map((m: ModelOption) => m.name);
        return <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>{names.length > 0 ? names.join(', ') : '-'}</span>;
      },
    },
    {
      key: 'isEnabled',
      label: '状态',
      width: '80px',
      render: (_val, row) => (
        <span className={`badge ${row.isEnabled ? 'badge-success' : 'badge-error'}`}>
          {row.isEnabled ? '启用' : '停用'}
        </span>
      ),
    },
    {
      key: 'successRate',
      label: '成功率',
      width: '90px',
      render: (_val, row) => {
        const stat = runtimeStats.get(row.id);
        if (!stat) return <span style={{ color: 'var(--color-soft)' }}>-</span>;
        const pct = stat.successRate;
        const color = pct >= 80
          ? 'var(--color-success)'
          : pct >= 50
            ? 'var(--color-warning)'
            : 'var(--color-error)';
        return <span style={{ color, fontWeight: 600 }}>{pct.toFixed(1)}%</span>;
      },
    },
    {
      key: 'avgLatencyMs',
      label: '延迟',
      width: '90px',
      render: (_val, row) => {
        const stat = runtimeStats.get(row.id);
        if (!stat) return <span style={{ color: 'var(--color-soft)' }}>-</span>;
        const ms = stat.avgLatencyMs;
        return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
      },
    },
    {
      key: 'consecutiveFailures',
      label: '连败',
      width: '60px',
      render: (_val, row) => (
        <span
          style={{
            color: row.consecutiveFailures > 0 ? 'var(--color-error)' : 'var(--color-text-2)',
            fontWeight: row.consecutiveFailures > 0 ? 600 : 400,
          }}
        >
          {row.consecutiveFailures}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '操作',
      width: '200px',
      render: (_val, row) => (
        <div className="flex items-center gap-1.5">
          <button
            className="btn btn-sm btn-outline"
            onClick={() => openEditModal(row)}
            title="编辑"
          >
            <Edit size={14} />
          </button>
          <button
            className={`btn btn-sm ${row.isEnabled ? 'btn-outline' : 'btn'}`}
            onClick={() => handleToggle(row)}
            title={row.isEnabled ? '停用' : '启用'}
          >
            <Power size={14} />
          </button>
          <button
            className="btn btn-sm btn-outline"
            onClick={() => handleResetFailures(row.id)}
            title="重置连败"
          >
            <RotateCw size={14} />
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => {
              if (row.isEnabled) {
                addToast('error', '请先停用站点再删除');
                return;
              }
              setDeleteTarget(row);
            }}
            title="删除"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ];

  /* ==================================================================
   *  Render
   * ================================================================*/

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="skeleton w-48 h-5" />
        <div className="skeleton w-64 h-4" />
      </div>
    );
  }

  return (
    <>
      {/* ---- Toasts ---- */}
      {toasts.map(t => (
        <Toast
          key={t.id}
          message={t.message}
          type={t.type}
          onClose={() => removeToast(t.id)}
        />
      ))}

      {/* ---- Page header ---- */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Globe size={20} style={{ color: 'var(--color-primary)' }} />
          <h2 className="page-title">API 站点管理</h2>
        </div>
        <button className="btn" onClick={openAddModal}>
          <Plus size={16} className="mr-1" />
          新增站点
        </button>
      </div>

      {/* ---- Sites table ---- */}
      <Table columns={columns} data={sites} />

      {/* ==================================================================
       *  Add / Edit modal
       * ================================================================*/}
      <Modal
        open={modalOpen}
        title={editingId ? '编辑站点' : '新增站点'}
        onClose={closeModal}
        wide
      >
        <div className="space-y-4">
          {/* Row 1: Name (full width) */}
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--color-text-2)' }}>
              名称 <span style={{ color: 'var(--color-error)' }}>*</span>
            </label>
            <input className="input" value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))} placeholder="站点名称" />
          </div>

          {/* Row 2: API URL */}
          <div>
            <label
              className="block text-xs font-semibold mb-1.5"
              style={{ color: 'var(--color-text-2)' }}
            >
              API URL <span style={{ color: 'var(--color-error)' }}>*</span>
            </label>
            <input
              className="input"
              value={form.baseUrl}
              onChange={e => setForm(prev => ({ ...prev, baseUrl: e.target.value }))}
              placeholder="https://api.example.com/v1"
            />
          </div>

          {/* Row 3: API Key */}
          <div>
            <label
              className="block text-xs font-semibold mb-1.5"
              style={{ color: 'var(--color-text-2)' }}
            >
              API Key
            </label>
            {editingId && !apiKeyReplaceEnabled ? (
              <div className="flex items-center gap-3">
                <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  {sites.find(site => site.id === editingId)?.hasApiKey
                    ? sites.find(site => site.id === editingId)?.apiKeyMasked || '已安全保存'
                    : '尚未配置'}
                </span>
                <button
                  className="btn btn-sm btn-outline"
                  type="button"
                  onClick={() => {
                    setForm(prev => ({ ...prev, apiKey: '' }));
                    setApiKeyReplaceEnabled(true);
                  }}
                >
                  替换 API Key
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  key={editingId ? `replace-api-key-${editingId}` : 'create-api-key'}
                  className="input"
                  type="password"
                  name="site-api-key-manual-entry"
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  spellCheck={false}
                  value={form.apiKey}
                  onChange={e => setForm(prev => ({ ...prev, apiKey: e.target.value }))}
                  placeholder="手动输入新的 API Key"
                />
                {editingId && (
                  <button
                    className="btn btn-sm btn-outline"
                    type="button"
                    onClick={() => {
                      setForm(prev => ({ ...prev, apiKey: '' }));
                      setApiKeyReplaceEnabled(false);
                    }}
                  >
                    取消替换
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Row 4: 站点调度与上游参数兼容配置。 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <div>
              <label
                className="block text-xs font-semibold mb-1.5"
                style={{ color: 'var(--color-text-2)' }}
              >
                权重 (1-1000)
              </label>
              <input className="input" type="number" min={1} max={1000} value={form.weight} onChange={e => setForm(prev => ({ ...prev, weight: Number(e.target.value) }))} />
              <span className="text-[10px] text-gray-400">越高越优先分配</span>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--color-text-2)' }}>超时(秒)</label>
              <input className="input" type="number" min={1} max={999999} value={form.timeoutSec} onChange={e => setForm(prev => ({ ...prev, timeoutSec: Number(e.target.value) }))} />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--color-text-2)' }}>并发上限</label>
              <input className="input" type="number" min={1} max={10000}
                value={form.maxConcurrency}
                onChange={e => setForm(prev => ({ ...prev, maxConcurrency: Number(e.target.value) }))}
              />
            </div>
            <SiteCompatibilitySettings
              sendResponseFormat={form.sendResponseFormat}
              sendPromptCacheKey={form.sendPromptCacheKey}
              autoSizeFromReference={form.autoSizeFromReference}
              onChange={(name, value) => setForm(prev => ({ ...prev, [name]: value }))}
            />
          </div>

          {/* ---- Model options sub-section ---- */}
          <div className="pt-2">
            <div className="flex items-center gap-3 mb-3">
              <div className="flex-1 border-t" style={{ borderColor: 'var(--color-border)' }} />
              <span
                className="text-xs font-bold whitespace-nowrap"
                style={{ color: 'var(--color-text-2)' }}
              >
                模型选项
              </span>
              <div className="flex-1 border-t" style={{ borderColor: 'var(--color-border)' }} />
            </div>

            {/* Existing models table */}
            {models.length > 0 && (
              <div
                className="mb-3 border rounded-lg overflow-hidden"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr
                      className="border-b"
                      style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}
                    >
                      <th
                        className="text-left py-2 px-3 text-xs"
                        style={{ color: 'var(--color-text-2)' }}
                      >
                        模型名
                      </th>
                      <th className="text-left py-2 px-3 text-xs" style={{ color: 'var(--color-text-2)' }}>
                        类型
                      </th>
                      <th
                        className="text-left py-2 px-3 text-xs"
                        style={{ color: 'var(--color-text-2)' }}
                      >
                        站点格式
                      </th>
                      <th className="text-left py-2 px-3 text-xs" style={{ color: 'var(--color-text-2)' }}>
                        画幅能力
                      </th>
                      <th className="text-left py-2 px-3 text-xs" style={{ color: 'var(--color-text-2)' }}>
                        参考图数量
                      </th>
                      <th
                        className="text-center py-2 px-3 text-xs"
                        style={{ color: 'var(--color-text-2)' }}
                      >
                        启用
                      </th>
                      <th className="text-center py-2 px-3 w-10 text-xs" style={{ color: 'var(--color-text-2)' }}>
                        删除
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m, i) => {
                      const legacyLocalModel = normalizeModelApiMode(m) === 'comfyui_generation';
                      return (
                      <tr
                        key={i}
                        className="border-b last:border-0"
                        style={{ borderColor: 'var(--color-border)' }}
                      >
                        <td className="py-1.5 px-3 font-medium">{m.name}</td>
                        <td className="py-1.5 px-3">
                          <select
                            className="input h-8 text-xs"
                            style={{ width: 112 }}
                            value={m.type ?? 'universal'}
                            disabled={legacyLocalModel}
                            onChange={event => updateModel(i, { type: event.target.value as ModelOptionType })}
                            title="模型真实生成类型"
                          >
                            <option value="universal">通用图片</option>
                            <option value="text_to_image">文生图</option>
                            <option value="image_to_image">图生图</option>
                            <option value="video">视频</option>
                            <option value="text">文本</option>
                          </select>
                        </td>
                        <td className="py-1.5 px-3">
                          <select
                            className="input h-8 text-xs"
                            style={{ width: 116 }}
                            value={normalizeModelApiMode(m)}
                            disabled={legacyLocalModel}
                            onChange={event => updateModel(i, getApiModeDefaults(event.target.value as ModelApiMode, m.type))}
                            title="每个模型独立设置真实上游请求格式"
                          >
                            {(legacyLocalModel ? Object.entries(MODEL_API_MODE_LABELS) : ACTIVE_MODEL_API_MODES).map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-1.5 px-3">
                          <select
                            className="input h-8 text-xs"
                            style={{ width: 124 }}
                            value={resolveAspectRatioSupport(m)}
                            disabled={legacyLocalModel}
                            onChange={event => updateModel(i, { aspectRatioSupport: event.target.value as SiteModelAspectRatioSupport })}
                            title="只允许调度到上游实测支持的画幅比例"
                          >
                            {Object.entries(MODEL_ASPECT_RATIO_SUPPORT_LABELS).map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-1.5 px-3">
                          <input
                            className="input h-8 text-xs"
                            style={{ width: 88 }}
                            type="number"
                            min={0}
                            max={8}
                            value={m.maxReferenceImages ?? 1}
                            disabled={legacyLocalModel}
                            onChange={event => updateModel(i, { maxReferenceImages: Number(event.target.value) })}
                            title="该模型允许接收的最大参考图数量"
                          />
                        </td>
                        <td className="py-1.5 px-3 text-center">
                          <button
                            role="switch"
                            aria-checked={m.enabled !== false}
                            disabled={legacyLocalModel}
                            onClick={() => toggleModel(i)}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 ${
                              m.enabled !== false
                                ? 'bg-[var(--color-primary)]'
                                : 'bg-[var(--color-border)]'
                            }`}
                          >
                            <span
                              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                                m.enabled !== false
                                  ? 'translate-x-[18px]'
                                  : 'translate-x-[3px]'
                              }`}
                            />
                          </button>
                        </td>
                        <td className="py-1.5 px-3 text-center">
                          <button
                            className="p-0.5 transition-colors hover:text-[var(--color-error)]"
                            style={{ color: 'var(--color-soft)' }}
                            onClick={() => removeModel(i)}
                            disabled={legacyLocalModel}
                            title={legacyLocalModel ? '历史 ComfyUI 配置只读保留' : '删除模型'}
                          >
                            <MinusCircle size={15} />
                          </button>
                        </td>
                      </tr>
                    );})}
                  </tbody>
                </table>
              </div>
            )}

            {/* Add new model row */}
            <div className="flex flex-wrap items-center gap-3">
              <input
                className="input h-9 text-xs"
                style={{ width: 140 }}
                placeholder="模型名"
                value={newModel.name}
                onChange={e => setNewModel(prev => ({ ...prev, name: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && addModel()}
              />
              <select
                className="input h-9 text-xs"
                style={{ width: 160 }}
                value={newModel.type ?? 'universal'}
                onChange={event => setNewModel(prev => ({ ...prev, type: event.target.value as ModelOptionType }))}
              >
                <option value="universal">通用图片</option>
                <option value="text_to_image">文生图</option>
                <option value="image_to_image">图生图</option>
                <option value="video">视频</option>
                <option value="text">文本</option>
              </select>
              <select
                className="input h-9 text-xs"
                style={{ width: 160 }}
                value={newModel.apiMode ?? normalizeModelApiMode(newModel)}
                onChange={e => setNewModel(prev => ({ ...prev, ...getApiModeDefaults(e.target.value as ModelApiMode, prev.type) }))}
              >
                {ACTIVE_MODEL_API_MODES.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <input
                className="input h-9 text-xs"
                style={{ width: 120 }}
                type="number"
                min={0}
                max={8}
                value={newModel.maxReferenceImages ?? 1}
                onChange={event => setNewModel(prev => ({ ...prev, maxReferenceImages: Number(event.target.value) }))}
                title="该模型允许接收的最大参考图数量"
              />
              <select
                className="input h-9 text-xs"
                style={{ width: 140 }}
                value={resolveAspectRatioSupport(newModel)}
                onChange={event => setNewModel(prev => ({ ...prev, aspectRatioSupport: event.target.value as SiteModelAspectRatioSupport }))}
                title="该模型真实支持的画幅比例"
              >
                {Object.entries(MODEL_ASPECT_RATIO_SUPPORT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <button className="btn btn-sm btn-outline" onClick={addModel}>
                添加模型
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {MODEL_PRESETS.map(preset => (
                <button
                  key={preset.name}
                  className="btn btn-sm btn-outline"
                  onClick={() => addModelPreset(preset)}
                  disabled={models.some(m => m.name === preset.name)}
                  title={preset.name}
                >
                  {preset.buttonLabel}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Modal footer actions */}
        <div
          className="flex items-center justify-end gap-3 mt-4 pt-4 border-t"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <button className="btn btn-outline btn-sm" onClick={closeModal}>
            取消
          </button>
          <button className="btn btn-sm" onClick={handleSave}>
            {editingId ? '保存' : '创建'}
          </button>
        </div>
      </Modal>

      {/* ==================================================================
       *  Delete confirmation modal
       * ================================================================*/}
      <Modal
        open={deleteTarget !== null}
        title="确认删除"
        onClose={() => setDeleteTarget(null)}
      >
        <p className="text-sm mb-2" style={{ color: 'var(--color-text-2)' }}>
          确定要删除站点{' '}
          <span className="font-semibold" style={{ color: 'var(--color-text)' }}>
            {deleteTarget?.name}
          </span>{' '}
          吗？
        </p>
        <p className="text-xs mb-6" style={{ color: 'var(--color-error)' }}>
          此操作不可撤销。
        </p>
        <div className="flex justify-end gap-3">
          <button className="btn btn-outline btn-sm" onClick={() => setDeleteTarget(null)}>
            取消
          </button>
          <button className="btn btn-sm btn-danger" onClick={handleDelete}>
            删除
          </button>
        </div>
      </Modal>
    </>
  );
}
