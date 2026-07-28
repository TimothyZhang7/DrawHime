/**
 * 本文件实现绘图模型设置面板，负责统一主模型、等价请求模型名、外显、价格与重试配置。
 */
import { useCallback, useEffect, useState } from 'react';
import { RotateCw, Save } from 'lucide-react';
import { api } from '../../api/client';

/** 管理端独立模型设置行；name 是统一主模型名。 */
export interface ModelSettingRow {
  name: string;
  label?: string;
  aliases?: string[];
  requestModelNames?: string[];
  weight?: number;
  price?: number;
  maxAttempts?: number;
  storyboardDesignEnabled?: boolean;
  referencePromptAssistEnabled?: boolean;
  promptFormat?: 'standard' | 'diffusion' | 'anima';
  isDefault?: boolean;
  type?: string;
  sites?: string[];
  capabilities?: { textToImage?: boolean; imageToImage?: boolean; textToVideo?: boolean; imageToVideo?: boolean; text?: boolean };
}

/** 模型设置表单行，文本字段保存前再拆分为数组。 */
interface ModelSettingFormRow extends ModelSettingRow {
  aliasesText: string;
  requestModelNamesText: string;
}

/** 参考图提示增强专用外部 AI 配置；密钥明文只在本次输入中存在。 */
interface ReferencePromptAssistConfigForm {
  baseUrl: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  model: string;
  timeoutSec: number;
  maxFileSizeMb: number;
  maxOutputChars: number;
}

/** 展示并保存统一模型设置。 */
export function ModelSettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const [rows, setRows] = useState<ModelSettingFormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [assistConfig, setAssistConfig] = useState<ReferencePromptAssistConfigForm>({
    baseUrl: '', apiKey: '', apiKeyConfigured: false, model: 'gpt-5.6-sol', timeoutSec: 90, maxFileSizeMb: 20, maxOutputChars: 5000,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    const res = await api<{ models: ModelSettingRow[]; defaultModel?: string; referencePromptAssistConfig?: Omit<ReferencePromptAssistConfigForm, 'apiKey'> }>('/admin/drawing/model-settings');
    if (res.ok && res.data) {
      setRows((res.data.models ?? []).map((item) => ({
        ...item,
        label: item.label ?? '',
        aliasesText: (item.aliases ?? []).join(', '),
        requestModelNamesText: (item.requestModelNames ?? []).join(', '),
        weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : 100,
        price: Number.isFinite(Number(item.price)) ? Number(item.price) : 0.05,
        maxAttempts: Number.isFinite(Number(item.maxAttempts)) ? Number(item.maxAttempts) : 3,
        storyboardDesignEnabled: item.type === 'video' && item.storyboardDesignEnabled !== false,
        referencePromptAssistEnabled: (item.type === 'text_to_image' || item.type === 'universal') && item.referencePromptAssistEnabled === true,
        promptFormat: item.promptFormat === 'diffusion' || item.promptFormat === 'anima' ? item.promptFormat : 'standard',
        isDefault: item.name === res.data?.defaultModel || item.isDefault === true,
      })));
      if (res.data.referencePromptAssistConfig) {
        setAssistConfig(current => ({ ...current, ...res.data?.referencePromptAssistConfig, apiKey: '' }));
      }
    } else {
      setMessage(res.message ?? '模型设置加载失败');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /** 按统一主模型名更新一行表单。 */
  const updateRow = (name: string, patch: Partial<ModelSettingFormRow>) => {
    setRows(prev => prev.map(row => row.name === name ? { ...row, ...patch } : row));
  };

  /** 全局默认模型只能选择一个统一主模型。 */
  const setDefault = (name: string) => {
    setRows(prev => prev.map(row => ({ ...row, isDefault: row.name === name })));
  };

  /** 保存时合并请求模型名并规范价格、尝试次数和分镜开关。 */
  const save = async () => {
    setSaving(true);
    setMessage(null);
    const defaultModel = rows.find(row => row.isDefault)?.name ?? rows[0]?.name ?? '';
    const payload = {
      defaultModel,
      models: rows.map(row => ({
        name: row.name,
        label: row.label?.trim() || undefined,
        aliases: splitModelNames(row.aliasesText),
        requestModelNames: splitModelNames(row.requestModelNamesText).filter((name) => name !== row.name),
        weight: Math.min(Math.max(Math.trunc(Number(row.weight) || 100), 0), 10000),
        // 钱包按分精度扣费，管理端保存时同步限制到 0-100 元。
        price: Math.round(Math.min(Math.max(Number(row.price) || 0, 0), 100) * 100) / 100,
        // 模型级尝试次数表示上游总调用次数，1 即失败后不再重试。
        maxAttempts: Math.min(Math.max(Math.trunc(Number(row.maxAttempts) || 3), 1), 10),
        // 分镜开关只允许视频模型保存为 true，避免图片模型误触发多模态分析。
        storyboardDesignEnabled: row.type === 'video' && row.storyboardDesignEnabled !== false,
        // AI 提示增强只允许具备文生图能力的模型开启，参考图是可选输入。
        referencePromptAssistEnabled: (row.type === 'text_to_image' || row.type === 'universal') && row.referencePromptAssistEnabled === true,
        // 提示词链路由模型格式决定，不再把部署位置当作模型能力。
        promptFormat: row.promptFormat ?? 'standard',
        type: row.type,
        isDefault: row.name === defaultModel,
      })),
      referencePromptAssistConfig: {
        baseUrl: assistConfig.baseUrl.trim(),
        ...(assistConfig.apiKey.trim() ? { apiKey: assistConfig.apiKey.trim() } : {}),
        model: assistConfig.model.trim() || 'gpt-5.6-sol',
        timeoutSec: Math.min(Math.max(Math.trunc(Number(assistConfig.timeoutSec) || 90), 10), 90),
        maxFileSizeMb: Math.min(Math.max(Math.trunc(Number(assistConfig.maxFileSizeMb) || 20), 1), 100),
        maxOutputChars: Math.min(Math.max(Math.trunc(Number(assistConfig.maxOutputChars) || 5000), 500), 50000),
      },
    };
    const res = await api('/admin/drawing/model-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setMessage('已保存');
      onSaved?.();
      await load();
    } else {
      setMessage(res.message ?? '保存失败');
    }
    setSaving(false);
  };

  return (
    <div className="card mb-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-gray-800">模型设置</h3>
          <p className="mt-1 text-xs text-text-2">主模型可合并多个等价的上游请求模型名，用户端只显示一项，Worker 仍按各站真实模型名调用。</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-sm btn-outline" onClick={load} disabled={loading || saving}>
            <RotateCw size={14} className={loading ? 'animate-spin' : ''} />刷新
          </button>
          <button className="btn btn-sm" onClick={save} disabled={loading || saving || rows.length === 0}>
            {saving ? <RotateCw size={14} className="animate-spin" /> : <Save size={14} />}保存
          </button>
        </div>
      </div>
      {message && (
        <div className={`rounded-lg px-3 py-2 text-xs ${message === '已保存' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {message}
        </div>
      )}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="mb-3">
          <h4 className="text-sm font-semibold text-gray-800">AI 提示增强接口</h4>
          <p className="mt-1 text-xs text-text-2">按模型独立开放，默认关闭。开启后无图会扩写文字，有图会先转写最多四张参考图；网页与 Bot 默认开启，网页用户可关闭。</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs text-gray-700">API Base URL<input className="mt-1 h-9 w-full rounded-lg border border-gray-200 px-2.5 outline-none focus:border-indigo-400" value={assistConfig.baseUrl} onChange={event => setAssistConfig(current => ({ ...current, baseUrl: event.target.value }))} placeholder="https://example.com/v1" /></label>
          <label className="text-xs text-gray-700">API Key<input type="password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" className="mt-1 h-9 w-full rounded-lg border border-gray-200 px-2.5 outline-none focus:border-indigo-400" value={assistConfig.apiKey} onChange={event => setAssistConfig(current => ({ ...current, apiKey: event.target.value }))} placeholder={assistConfig.apiKeyConfigured ? '已配置，留空保持原密钥' : '请输入 API Key'} /></label>
          <label className="text-xs text-gray-700">视觉模型<input className="mt-1 h-9 w-full rounded-lg border border-gray-200 px-2.5 outline-none focus:border-indigo-400" value={assistConfig.model} onChange={event => setAssistConfig(current => ({ ...current, model: event.target.value }))} placeholder="gpt-5.6-sol" /></label>
          <label className="text-xs text-gray-700">超时（秒）<input type="number" min={10} max={90} className="mt-1 h-9 w-full rounded-lg border border-gray-200 px-2.5 outline-none focus:border-indigo-400" value={assistConfig.timeoutSec} onChange={event => setAssistConfig(current => ({ ...current, timeoutSec: Number(event.target.value) }))} /></label>
          <label className="text-xs text-gray-700">单图上限（MB）<input type="number" min={1} max={100} className="mt-1 h-9 w-full rounded-lg border border-gray-200 px-2.5 outline-none focus:border-indigo-400" value={assistConfig.maxFileSizeMb} onChange={event => setAssistConfig(current => ({ ...current, maxFileSizeMb: Number(event.target.value) }))} /></label>
          <label className="text-xs text-gray-700">增强提示词上限<input type="number" min={500} max={50000} className="mt-1 h-9 w-full rounded-lg border border-gray-200 px-2.5 outline-none focus:border-indigo-400" value={assistConfig.maxOutputChars} onChange={event => setAssistConfig(current => ({ ...current, maxOutputChars: Number(event.target.value) }))} /></label>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full min-w-[1480px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-xs text-text-2">
              <th className="p-3 text-left font-medium">默认</th>
              <th className="p-3 text-left font-medium">主模型名</th>
              <th className="p-3 text-left font-medium">等价请求模型名</th>
              <th className="p-3 text-left font-medium">外显名</th>
              <th className="p-3 text-left font-medium">输入别名</th>
              <th className="p-3 text-left font-medium">权重</th>
              <th className="p-3 text-left font-medium">单价(元)</th>
              <th className="p-3 text-left font-medium">尝试次数</th>
              <th className="p-3 text-left font-medium">分镜设计</th>
              <th className="p-3 text-left font-medium">AI 提示增强</th>
              <th className="p-3 text-left font-medium">提示词格式 / 能力 / 站点</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={11} className="p-6 text-center text-xs text-text-2">加载中...</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={11} className="p-6 text-center text-xs text-text-2">暂无模型，请先在 API 站点中添加模型。</td></tr>
            ) : rows.map(row => (
              <tr key={row.name} className="border-b border-gray-100 last:border-0">
                <td className="p-3 align-top">
                  <input type="radio" name="defaultModel" checked={row.isDefault === true} onChange={() => setDefault(row.name)} className="h-4 w-4 accent-indigo-500" />
                </td>
                <td className="p-3 align-top"><div className="font-mono text-xs font-semibold text-gray-800">{row.name}</div></td>
                <td className="p-3 align-top">
                  <input className="h-9 w-full rounded-lg border border-gray-200 px-2.5 text-xs outline-none focus:border-indigo-400" value={row.requestModelNamesText} onChange={event => updateRow(row.name, { requestModelNamesText: event.target.value })} placeholder="如 gpt-image-free" title="填写与主模型能力和计费相同、但上游请求名不同的真实模型 ID" />
                </td>
                <td className="p-3 align-top">
                  <input className="h-9 w-full rounded-lg border border-gray-200 px-2.5 text-xs outline-none focus:border-indigo-400" value={row.label ?? ''} onChange={event => updateRow(row.name, { label: event.target.value })} placeholder="默认显示主模型名" />
                </td>
                <td className="p-3 align-top">
                  <input className="h-9 w-full rounded-lg border border-gray-200 px-2.5 text-xs outline-none focus:border-indigo-400" value={row.aliasesText} onChange={event => updateRow(row.name, { aliasesText: event.target.value })} placeholder="逗号分隔，如 nb, nano" />
                </td>
                <td className="p-3 align-top">
                  <input type="number" min={0} max={10000} className="h-9 w-24 rounded-lg border border-gray-200 px-2.5 text-xs outline-none focus:border-indigo-400" value={row.weight ?? 100} onChange={event => updateRow(row.name, { weight: Number(event.target.value) })} />
                </td>
                <td className="p-3 align-top">
                  <input type="number" min={0} max={100} step={0.01} className="h-9 w-24 rounded-lg border border-gray-200 px-2.5 text-xs outline-none focus:border-indigo-400" value={row.price ?? 0.05} onChange={event => updateRow(row.name, { price: Number(event.target.value) })} />
                </td>
                <td className="p-3 align-top">
                  <input type="number" min={1} max={10} title="每个任务最多调用上游的总次数；1 表示失败后不重试" className="h-9 w-24 rounded-lg border border-gray-200 px-2.5 text-xs outline-none focus:border-indigo-400" value={row.maxAttempts ?? 3} onChange={event => updateRow(row.name, { maxAttempts: Number(event.target.value) })} />
                  <div className="mt-1 text-[10px] text-text-2">1=不重试</div>
                </td>
                <td className="p-3 align-top">
                  {row.type === 'video' ? (
                    <label className="inline-flex items-center gap-2 text-xs text-gray-700">
                      <input type="checkbox" checked={row.storyboardDesignEnabled !== false} onChange={event => updateRow(row.name, { storyboardDesignEnabled: event.target.checked })} className="h-4 w-4 accent-indigo-500" />
                      <span>{row.storyboardDesignEnabled !== false ? '开启' : '关闭'}</span>
                    </label>
                  ) : <span className="text-xs text-text-2">不适用</span>}
                </td>
                <td className="p-3 align-top">
                  {row.type === 'text_to_image' || row.type === 'universal' ? (
                    <label className="inline-flex items-center gap-2 text-xs text-gray-700">
                      <input type="checkbox" checked={row.referencePromptAssistEnabled === true} onChange={event => updateRow(row.name, { referencePromptAssistEnabled: event.target.checked })} className="h-4 w-4 accent-indigo-500" />
                      <span>{row.referencePromptAssistEnabled ? '开放' : '关闭'}</span>
                    </label>
                  ) : <span className="text-xs text-text-2">不适用</span>}
                </td>
                <td className="p-3 align-top text-xs text-text-2">
                  <select
                    className="mb-2 h-9 w-full min-w-32 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-700 outline-none focus:border-indigo-400"
                    value={row.promptFormat ?? 'standard'}
                    onChange={event => updateRow(row.name, { promptFormat: event.target.value as ModelSettingRow['promptFormat'] })}
                    title="AI 提示增强独立链路；Grok 使用完整自然语言，Anima 使用单行小写标签协议"
                  >
                    <option value="standard">Grok / 通用完整描述</option>
                    <option value="diffusion">Diffusion 正负提示词</option>
                    <option value="anima">Anima 标签</option>
                  </select>
                  <div>{formatModelCapabilities(row)}</div>
                  <div className="mt-1 break-all">{row.sites?.join(' / ') || '无可用站点（配置已保留）'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 拆分模型名或输入别名，支持中文逗号、英文逗号、顿号和换行。 */
function splitModelNames(value: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value.split(/[\n,，、]/)) {
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** 格式化模型能力，帮助管理员确认当前模型可参与的真实生成链路。 */
function formatModelCapabilities(row: ModelSettingRow): string {
  const parts: string[] = [];
  if (row.capabilities?.textToImage) parts.push('文生图');
  if (row.capabilities?.imageToImage) parts.push('图生图');
  if (row.capabilities?.textToVideo) parts.push('文生视频');
  if (row.capabilities?.imageToVideo) parts.push('参考图视频');
  if (row.capabilities?.text) parts.push('文本');
  return parts.length > 0 ? parts.join(' + ') : row.type || '-';
}
