/** 模板编辑器 — 工具栏插入变量、可视化变量标签、属性编辑面板、蓝图快速方案 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import type { TemplateAiConvertResponse } from '@aiimage/shared-contracts';
import { useToast } from '../../providers/ToastProvider';
import { api } from '../../lib/api';
import { resolveMediaUrl } from '../../lib/media';
import {
  ArrowLeft, Save, Loader2, Type, Palette, ImagePlus, Sparkles, Braces, Trash2, X,
  Eye, Upload, Info, User, Calendar, Copy, Wand2, Check
} from 'lucide-react';

/* ====== 变量解析 ====== */

/** 变量音调色板 */
const VAR_TONES = [
  { color: '#2563eb', soft: '#eff6ff' },
  { color: '#dc2626', soft: '#fef2f2' },
  { color: '#059669', soft: '#ecfdf5' },
  { color: '#d97706', soft: '#fffbeb' },
  { color: '#7c3aed', soft: '#f5f3ff' },
  { color: '#0891b2', soft: '#ecfeff' },
  { color: '#db2777', soft: '#fdf2f8' },
  { color: '#4f46e5', soft: '#eef2ff' },
] as const;

type VarType = 'text' | 'color' | 'image';

/** 类型名 → VarType */
const TYPE_ALIASES: Record<string, VarType> = { color: 'color', '颜色': 'color', image: 'image', img: 'image', '图片': 'image', '参考图': 'image' };

interface ParsedVar {
  key: string;          // 变量名（不含类型后缀）
  label: string;
  type: VarType;
  defaultValue: string; // : 后面的默认值
  color: string;
  softColor: string;
}

/**
 * 解析 {{name}} / {{name:default}} / {{name#类型}} / {{name#类型:default}}
 * 匹配顺序：key → 可选 #类型 → 可选 :默认值
 */
/** 匹配 {{名称}} {{名称:默认值}} {{名称#类型}} {{名称#类型:默认值}}，key 支持中英文 */
const VAR_RE = /\{\{([^{}\s:#]+)(?:#([^{}\s:]+))?(?:[:：]([^}]*?))?\}\}/g;

function parseVars(template: string): ParsedVar[] {
  const seen = new Map<string, ParsedVar>();
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(template)) !== null) {
    const rawKey = m[1];
    // 尝试从 #后缀 解析类型，支持中英文别名
    const rawType = (m[2] ?? '').toLowerCase();
    const type = TYPE_ALIASES[rawType] ?? 'text';
    const key = rawKey.replace(/[{}]/g, '').trim();
    if (seen.has(key)) continue;
    const tone = VAR_TONES[seen.size % VAR_TONES.length];
    seen.set(key, {
      key, label: key, type,
      defaultValue: (m[3] ?? '').trim(),
      color: tone.color, softColor: tone.soft,
    });
  }
  return [...seen.values()];
}

/** 构建变量 token（含类型后缀和默认值） */
function buildToken(name: string, type: VarType, defVal: string): string {
  const n = name.replace(/[{}]/g, '').trim() || '变量';
  const v = defVal.replace(/[{}]/g, '').trim();
  const suffix = type === 'color' ? '#颜色' : type === 'image' ? '#图片' : '';
  return `{{${n}${suffix}${v ? `:${v}` : ''}}}`;
}

/** 转义正则特殊字符 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把服务端 defaultValues 写回模板占位符，确保 AI 草稿保存时默认值不会丢失。 */
function ensureInlineDefaults(template: string, defaultValues: Record<string, string>): string {
  let prompt = template;
  for (const [key, rawValue] of Object.entries(defaultValues)) {
    const value = String(rawValue ?? '').replace(/[{}]/g, '').trim();
    if (!key || !value) continue;
    const tokenRe = new RegExp(`\\{\\{${escapeRe(key)}(?:#[^{}\\s:]+)?(?:[:：]([^}]*?))?\\}\\}`, 'g');
    prompt = prompt.replace(tokenRe, (match, existingDefault) => {
      if (existingDefault !== undefined) {
        return match.replace(new RegExp(`[:：]${escapeRe(existingDefault)}(?=\\}\\}$)`), `:${value}`);
      }
      return match.replace('}}', `:${value}}}`);
    });
  }
  return prompt;
}

/* ====== 颜色常量 ====== */
const COLOR_SWATCHES = ['#ffffff', '#111827', '#f87171', '#fb7185', '#f472b6', '#a78bfa', '#60a5fa', '#22d3ee', '#34d399', '#a3e635', '#facc15', '#fb923c'];
/** 前端保存前提示词长度上限，与后端模板保存兜底保持一致。 */
const MAX_TEMPLATE_PROMPT_LENGTH = 30000;
/** 前端保存前默认值 JSON 长度上限，与后端模板保存兜底保持一致。 */
const MAX_TEMPLATE_DEFAULT_VALUES_LENGTH = 30000;

/* ====== 蓝图 ====== */
const BLUEPRINTS = [
  { label: '人物肖像', desc: '精细的人物肖像模板', prompt: 'a beautiful portrait of {{角色}} in {{风格}} style, highly detailed, {{主色#颜色:#6366f1}} accent' },
  { label: '风景画', desc: '自然风景绘画模板', prompt: 'a breathtaking landscape of {{场景}}, {{风格}} style, masterpiece, {{主色调#颜色:#60a5fa}} palette' },
  { label: '角色设计', desc: '角色概念设计模板', prompt: 'character design sheet of {{角色}}, {{风格}} style, full body, concept art, reference {{参考图#图片:图1}}' },
  { label: '图标/Logo', desc: '简洁图标设计模板', prompt: 'minimalist icon design of {{主体}}, flat vector, clean lines, {{主题色#颜色:#111827}} background' },
];

/* ====== 数据类型 ====== */
type TemplateData = {
  id: number; name: string; description: string; promptTemplate: string;
  defaultValues?: string; sourceTemplateId?: number;
  size: string; quality: string; moderation: string;
  coverImageUrls: string[]; isPublic: boolean;
  isFavorited: boolean; favoriteCount: number;
  userId: number; username: string; createdAt: string;
};

type FormState = {
  name: string;
  description: string;
  promptTemplate: string;
  coverImageUrls: string[];
  isPublic: boolean;
};

/* ====== 主组件 ====== */
export function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { show } = useToast();
  const isNew = !id || id === 'new';
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 表单
  const [form, setForm] = useState<FormState>({ name: '', description: '', promptTemplate: '', coverImageUrls: [], isPublic: false });

  // 元数据
  const [tplMeta, setTplMeta] = useState<TemplateData | null>(null);
  const [fetching, setFetching] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiConverting, setAiConverting] = useState(false);

  // 选中的变量
  const [activeVarKey, setActiveVarKey] = useState('');

  // 加载已有模板
  useEffect(() => {
    if (isNew) return;
    api<TemplateData>(`/api/templates/${id}`).then(d => {
      if (d.ok && d.data) {
        setTplMeta(d.data);
        // 加载 defaultValues JSON 中的值，合并到 prompt template 的 :default 上
        let prompt = d.data.promptTemplate;
        if (d.data.defaultValues) {
          try {
            const saved: Record<string, string> = JSON.parse(d.data.defaultValues);
            prompt = ensureInlineDefaults(prompt, saved);
          } catch { /* ignore */ }
        }
        setForm({
          name: d.data.name,
          description: d.data.description ?? '',
          promptTemplate: prompt,
          coverImageUrls: d.data.coverImageUrls ?? [],
          isPublic: d.data.isPublic,
        });
        const vars = parseVars(prompt);
        if (vars[0]) setActiveVarKey(vars[0].key);
      }
      setFetching(false);
    });
    api<{ id: number }>('/auth/me').then(d => { if (d.ok && d.data) setCurrentUserId(d.data.id); });
  }, [id, isNew]);

  // 解析变量
  const variables = useMemo(() => parseVars(form.promptTemplate), [form.promptTemplate]);
  const activeVar = variables.find(v => v.key === activeVarKey) ?? variables[0] ?? null;

  // 保持选中变量有效
  useEffect(() => {
    if (activeVarKey && variables.some(v => v.key === activeVarKey)) return;
    setActiveVarKey(variables[0]?.key ?? '');
  }, [activeVarKey, variables]);

  // 更新表单字段
  const patch = useCallback((partial: Partial<FormState>) => setForm(p => ({ ...p, ...partial })), []);

  // 在光标位置插入文本
  const insertAtCursor = useCallback((text: string) => {
    const ta = textareaRef.current;
    const cur = form.promptTemplate;
    const start = ta?.selectionStart ?? cur.length;
    const end = ta?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + text + cur.slice(end);
    patch({ promptTemplate: next });
    requestAnimationFrame(() => {
      ta?.focus();
      const pos = start + text.length;
      ta?.setSelectionRange(pos, pos);
    });
  }, [form.promptTemplate, patch]);

  // 插入新变量
  const insertVar = useCallback((type: VarType) => {
    const count = variables.length + 1;
    const key = type === 'color' ? `颜色${count}` : type === 'image' ? `参考图${count}` : `变量${count}`;
    const def = type === 'color' ? COLOR_SWATCHES[(count - 1) % COLOR_SWATCHES.length] : type === 'image' ? `图${Math.min(count, 5)}` : '默认值';
    insertAtCursor(buildToken(key, type, def));
    setActiveVarKey(key);
  }, [variables.length, insertAtCursor]);

  /** 调用后端真实 AI，把一段普通提示词转换为当前模板编辑器可直接保存的草稿。 */
  const convertPromptWithAi = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) return show('请先输入一段普通绘图提示词', 'warn');
    setAiConverting(true);
    const result = await api<TemplateAiConvertResponse>('/api/templates/ai/convert', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
    if (result.ok && result.data) {
      const nextPrompt = ensureInlineDefaults(result.data.promptTemplate, result.data.defaultValues);
      patch({
        name: result.data.name,
        description: result.data.description,
        promptTemplate: nextPrompt,
      });
      const firstVar = parseVars(nextPrompt)[0];
      if (firstVar) setActiveVarKey(firstVar.key);
      show('已生成模板草稿', 'success');
    } else {
      show(result.message ?? 'AI 转模板失败', 'error');
    }
    setAiConverting(false);
  }, [aiPrompt, patch, show]);

  // 应用蓝图
  const applyBlueprint = useCallback((b: typeof BLUEPRINTS[number]) => {
    patch({
      name: form.name.trim() || b.label,
      description: form.description.trim() || b.desc,
      promptTemplate: b.prompt,
    });
    const v = parseVars(b.prompt)[0];
    if (v) setActiveVarKey(v.key);
  }, [form.name, form.description, patch]);

  // 更新选中变量
  const updateVar = useCallback((patchVar: { key?: string; type?: VarType; defaultValue?: string }) => {
    if (!activeVar) return;
    const nextKey = patchVar.key ?? activeVar.key;
    const nextType = patchVar.type ?? activeVar.type;
    const nextDef = patchVar.defaultValue ?? activeVar.defaultValue;
    const oldToken = buildToken(activeVar.key, activeVar.type, activeVar.defaultValue);
    const newToken = buildToken(nextKey, nextType, nextDef);
    const next = form.promptTemplate.replace(new RegExp(escapeRe(oldToken), 'g'), newToken);
    patch({ promptTemplate: next });
    setActiveVarKey(nextKey);
  }, [activeVar, form.promptTemplate, patch]);

  // 删除选中变量
  const deleteVar = useCallback(() => {
    if (!activeVar) return;
    const token = buildToken(activeVar.key, activeVar.type, activeVar.defaultValue);
    const next = form.promptTemplate.replace(new RegExp(escapeRe(token) + '\\s*', 'g'), '').replace(/\s+/g, ' ').trim();
    patch({ promptTemplate: next });
    setActiveVarKey('');
  }, [activeVar, form.promptTemplate, patch]);

  // 保存
  const save = useCallback(async () => {
    if (!form.name.trim() || !form.promptTemplate.trim()) return show('名称和提示词不能为空', 'warn');
    if (form.promptTemplate.trim().length > MAX_TEMPLATE_PROMPT_LENGTH) return show(`Prompt 模板不能超过 ${MAX_TEMPLATE_PROMPT_LENGTH} 字`, 'warn');
    const defaultValues = JSON.stringify(Object.fromEntries(variables.map(v => [v.key, v.defaultValue])));
    if (defaultValues.length > MAX_TEMPLATE_DEFAULT_VALUES_LENGTH) return show('模板默认值过长，请减少变量数量或默认值长度', 'warn');
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        promptTemplate: form.promptTemplate.trim(),
        description: form.description.trim(),
        coverImageUrls: form.coverImageUrls,
        isPublic: form.isPublic,
        defaultValues,
      };
      const d = isNew
        ? await api<{ id: number }>('/api/templates', { method: 'POST', body: JSON.stringify(body) })
        : await api<{ id: number }>(`/api/templates/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (d.ok) {
        show(isNew ? '创建成功' : '模板已更新', 'success');
        if (isNew) { nav(`/templates/${d.data!.id}`); }
        else { setTplMeta(prev => prev ? { ...prev, name: form.name.trim(), description: form.description.trim(), promptTemplate: form.promptTemplate.trim(), coverImageUrls: form.coverImageUrls, isPublic: form.isPublic } : prev); }
      } else show(d.message ?? '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [form, isNew, id, variables, show, nav]);

  // 复制提示词
  const copyPrompt = useCallback(async () => {
    try { await navigator.clipboard.writeText(form.promptTemplate); } catch { /* */ }
    setCopied(true); show('已复制', 'success'); setTimeout(() => setCopied(false), 2000);
  }, [form.promptTemplate, show]);

  // 删除
  const del = useCallback(async () => {
    if (!tplMeta || !window.confirm(`确定删除「${tplMeta.name}」？`)) return;
    const d = await api(`/api/templates/${tplMeta.id}`, { method: 'DELETE' });
    if (d.ok) { show('已删除', 'success'); nav('/templates', { replace: true }); }
    else show(d.message ?? '删除失败', 'error');
  }, [tplMeta, show, nav]);

  // 另存为副本（从编辑器）
  const saveCopy = useCallback(async () => {
    if (!tplMeta) return;
    if (form.promptTemplate.trim().length > MAX_TEMPLATE_PROMPT_LENGTH) return show(`Prompt 模板不能超过 ${MAX_TEMPLATE_PROMPT_LENGTH} 字`, 'warn');
    const defaultValues = JSON.stringify(Object.fromEntries(variables.map(v => [v.key, v.defaultValue])));
    if (defaultValues.length > MAX_TEMPLATE_DEFAULT_VALUES_LENGTH) return show('模板默认值过长，请减少变量数量或默认值长度', 'warn');
    setSaving(true);
    try {
      const body = {
        name: `${form.name}`, promptTemplate: form.promptTemplate,
        description: form.description, coverImageUrls: form.coverImageUrls,
        isPublic: false, sourceTemplateId: tplMeta.id,
        defaultValues,
      };
      const d = await api<{ id: number }>('/api/templates', { method: 'POST', body: JSON.stringify(body) });
      if (d.ok) { show('副本已保存', 'success'); nav(`/templates/${d.data!.id}`); }
      else show(d.message ?? '保存副本失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [tplMeta, form, variables, show, nav]);

  /* ====== 加载 ====== */
  if (fetching) return (
    <div className="text-center py-16 text-text-2 flex items-center justify-center gap-2">
      <Loader2 size={16} className="animate-spin" />加载中...
    </div>
  );

  if (!isNew && !tplMeta) return (
    <div className="text-center py-24 text-text-2">
      <div className="text-lg font-semibold mb-2">模板不存在</div>
      <Link to="/templates" className="btn btn-outline btn-sm">返回模板列表</Link>
    </div>
  );

  const isOwner = !isNew && currentUserId !== null && currentUserId === tplMeta?.userId;

  /* ====== 渲染 ====== */
  return (
    <div className="animate-fade-in">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <Link to="/templates" className="inline-flex items-center gap-1 text-sm text-text-2 hover:text-text">
          <ArrowLeft size={14} />返回模板列表
        </Link>
        <div className="flex items-center gap-2">
          {!isNew && (
            <>
              <Link to={`/templates/${tplMeta!.id}`} className="btn btn-outline btn-sm flex items-center gap-1 no-underline">
                <Eye size={13} />使用
              </Link>
              <button onClick={copyPrompt} className="btn btn-outline btn-sm flex items-center gap-1">
                {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}
              </button>
              <button onClick={saveCopy} disabled={saving} className="btn btn-outline btn-sm flex items-center gap-1">
                <Save size={13} />{saving ? '保存中...' : '存为副本'}
              </button>
            </>
          )}
          {isOwner && (
            <button onClick={del} className="btn btn-sm flex items-center gap-1" style={{ background: 'var(--color-error)' }}>
              <Trash2 size={13} />删除
            </button>
          )}
          <button onClick={() => nav('/templates')} className="btn btn-ghost btn-sm">取消</button>
          <button onClick={save} disabled={saving} className="btn btn-sm flex items-center gap-1.5">
            <Save size={14} />{saving ? '保存中...' : '保存模板'}
          </button>
        </div>
      </div>

      {/* 主体：三栏布局 */}
      <div className="flex flex-col lg:flex-row gap-3" style={{ minHeight: 'calc(100vh - 140px)' }}>
        {/* ====== 左栏：元信息 + 蓝图 ====== */}
        <div className="lg:w-[260px] flex-shrink-0 flex flex-col gap-3">
          <div className="card flex flex-col gap-3">
            <h2 className="card-title flex items-center gap-1.5"><Wand2 size={14} />AI 转模板</h2>
            <textarea
              value={aiPrompt}
              onChange={event => setAiPrompt(event.target.value)}
              placeholder="输入一段常规绘图提示词，AI 会生成标题、介绍、变量模板和默认值。"
              className="input"
              style={{ minHeight: 118, resize: 'vertical', lineHeight: 1.55 }}
            />
            <button
              type="button"
              onClick={convertPromptWithAi}
              disabled={aiConverting}
              className="btn btn-sm flex items-center justify-center gap-1.5"
            >
              {aiConverting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {aiConverting ? '生成中...' : '生成模板草稿'}
            </button>
            <div className="text-[11px] leading-relaxed text-text-2">
              生成后会覆盖当前编辑区内容，保存前仍可手动调整变量。
            </div>
          </div>

          <div className="card flex flex-col gap-3">
            <h2 className="card-title flex items-center gap-1.5"><Info size={14} />基本信息</h2>
            <div>
              <label className="text-xs text-text-2 mb-1 block font-medium">名称</label>
              <input value={form.name} onChange={e => patch({ name: e.target.value })} placeholder="模板名称" className="input" />
            </div>
            <div>
              <label className="text-xs text-text-2 mb-1 block font-medium">描述</label>
              <textarea value={form.description} onChange={e => patch({ description: e.target.value })} placeholder="简短描述（可选）" className="input" style={{ minHeight: 60, resize: 'vertical' }} />
            </div>
            <CoverUploader value={form.coverImageUrls} onChange={v => patch({ coverImageUrls: v })} />
            <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
              <input type="checkbox" checked={form.isPublic} onChange={e => patch({ isPublic: e.target.checked })} />公开模板
            </label>
          </div>

          {/* 蓝图 */}
          <div className="card">
            <h2 className="card-title flex items-center gap-1.5 mb-3"><Braces size={14} />快速方案</h2>
            <div className="flex flex-col gap-2">
              {BLUEPRINTS.map(b => (
                <button key={b.label} onClick={() => applyBlueprint(b)}
                  className="text-left p-2.5 rounded-lg border border-border bg-bg hover:border-primary transition-colors"
                  style={{ cursor: 'pointer' }}>
                  <div className="text-xs font-semibold text-text">{b.label}</div>
                  <div className="text-[11px] text-text-2 mt-0.5 truncate">{b.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ====== 中栏：提示词编辑器 ====== */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* 变量插入工具栏 */}
          <div className="card flex items-center gap-2 flex-wrap" style={{ padding: '14px 16px' }}>
            <span className="text-xs text-text-2 font-medium mr-1">插入变量：</span>
            <button onClick={() => insertVar('text')} className="btn btn-outline btn-sm flex items-center gap-1"><Type size={13} />文本</button>
            <button onClick={() => insertVar('color')} className="btn btn-outline btn-sm flex items-center gap-1"><Palette size={13} />颜色</button>
            <button onClick={() => insertVar('image')} className="btn btn-outline btn-sm flex items-center gap-1"><ImagePlus size={13} />图片</button>
            <span className="text-text-2 mx-1">·</span>
            <button onClick={() => insertAtCursor('，高细节，画面自然融合，结构准确')} className="btn-ghost btn-sm flex items-center gap-1"><Sparkles size={13} />补充细节</button>
          </div>

          {/* 文本编辑器 */}
          <div className="card flex flex-col flex-1" style={{ padding: 0, overflow: 'hidden', minHeight: 360 }}>
            <textarea
              ref={textareaRef}
              value={form.promptTemplate}
              onChange={e => patch({ promptTemplate: e.target.value })}
              placeholder={'在下方工具栏点击按钮插入变量，例如 {{角色}}。\n\n示例：a beautiful portrait of {{角色}} in {{风格}} style，高细节'}
              className="flex-1 w-full resize-none p-4 text-sm leading-7"
              style={{ border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-text)', fontFamily: 'monospace', minHeight: 0 }}
            />
            {/* 变量标签条 */}
            <div className="border-t border-border p-3 flex flex-wrap items-center gap-2" style={{ background: 'var(--color-bg)' }}>
              <span className="text-[11px] text-text-2 font-medium">变量</span>
              {variables.length > 0 ? variables.map(v => {
                const isActive = v.key === activeVarKey;
                const token = buildToken(v.key, v.type, v.defaultValue);
                return (
                  <span key={v.key}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold border transition-colors"
                    style={{
                      background: isActive ? v.softColor : 'var(--color-surface)',
                      borderColor: isActive ? v.color : 'var(--color-border)',
                      color: v.color,
                    }}>
                    <button onClick={() => setActiveVarKey(v.key)}
                      className="inline-flex items-center gap-1"
                      style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, font: 'inherit' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: v.color }} />
                      {v.label}
                    </button>
                    <button onClick={() => {
                      const re = new RegExp(escapeRe(token) + '\\s*', 'g');
                      patch({ promptTemplate: form.promptTemplate.replace(re, '').replace(/\s+/g, ' ').trim() });
                      if (isActive) setActiveVarKey('');
                    }}
                      className="flex items-center justify-center rounded-full hover:bg-black/10"
                      style={{ width: 16, height: 16, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: 'inherit', opacity: 0.6 }}
                      title="删除此变量">
                      <X size={10} />
                    </button>
                  </span>
                );
              }) : (
                <span className="text-[11px] text-text-2">无 — 点击上方按钮插入变量</span>
              )}
            </div>
          </div>
        </div>

        {/* ====== 右栏：变量属性编辑 + 预览 ====== */}
        <div className="lg:w-[300px] flex-shrink-0 flex flex-col gap-3">
          {/* 统计 */}
          <div className="grid grid-cols-2 gap-2">
            <StatsBox label="变量" value={variables.length} />
            <StatsBox label="字数" value={`${form.promptTemplate.length}/8000`} />
          </div>

          {/* 变量列表 */}
          <div className="card" style={{ padding: 14 }}>
            <h2 className="card-title flex items-center gap-1.5 mb-2 text-xs">变量列表</h2>
            <div className="max-h-36 overflow-y-auto flex flex-col gap-1">
              {variables.length > 0 ? variables.map(v => {
                const isActive = v.key === activeVarKey;
                return (
                  <button key={v.key} onClick={() => setActiveVarKey(v.key)}
                    className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-left text-xs transition-colors"
                    style={{
                      background: isActive ? v.softColor : 'var(--color-bg)',
                      border: `1px solid ${isActive ? v.color : 'transparent'}`,
                      cursor: 'pointer',
                    }}>
                    <span className="font-semibold truncate" style={{ color: v.color }}>{v.label}</span>
                    <span className="text-text-2 flex-shrink-0 text-[10px]">{v.type === 'color' ? '颜色' : v.type === 'image' ? '图片' : '文本'}</span>
                  </button>
                );
              }) : <span className="text-xs text-text-2 p-2">点击工具栏插入第一个变量</span>}
            </div>
          </div>

          {/* 变量编辑器 */}
          {activeVar ? (
            <div className="card flex flex-col gap-3" style={{ padding: 14 }}>
              <div className="flex items-center justify-between">
                <h2 className="card-title flex items-center gap-1.5 text-xs">编辑变量</h2>
                <button onClick={deleteVar}
                  className="flex items-center gap-1 text-[11px] font-medium hover:underline"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-error)' }}>
                  <Trash2 size={11} />删除
                </button>
              </div>
              <div>
                <label className="text-[11px] text-text-2 mb-1 block">名称</label>
                <input
                  value={activeVar.key}
                  onChange={e => updateVar({ key: e.target.value })}
                  className="input"
                  style={{ height: 34, fontSize: 12 }}
                />
              </div>
              <div>
                <label className="text-[11px] text-text-2 mb-1 block">类型</label>
                <div className="flex gap-1">
                  {(['text', 'color', 'image'] as VarType[]).map(t => (
                    <button key={t} onClick={() => updateVar({ type: t })}
                      className="flex-1 text-[11px] font-medium py-1.5 rounded-lg border transition-colors"
                      style={{
                        background: activeVar.type === t ? activeVar.softColor : 'var(--color-bg)',
                        borderColor: activeVar.type === t ? activeVar.color : 'var(--color-border)',
                        color: activeVar.type === t ? activeVar.color : 'var(--color-text-2)',
                        cursor: 'pointer',
                      }}>
                      {t === 'color' ? '颜色' : t === 'image' ? '图片' : '文本'}
                    </button>
                  ))}
                </div>
              </div>
              {/* 颜色选择器 */}
              {activeVar.type === 'color' ? (
                <div>
                  <label className="text-[11px] text-text-2 mb-1 block">默认颜色</label>
                  <div className="flex gap-1.5 mb-2">
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(activeVar.defaultValue) ? activeVar.defaultValue : '#6366f1'}
                      onChange={e => updateVar({ defaultValue: e.target.value })}
                      style={{ width: 36, height: 34, border: '1px solid var(--color-border)', borderRadius: 8, padding: 2, cursor: 'pointer' }}
                    />
                    <input
                      value={activeVar.defaultValue}
                      onChange={e => updateVar({ defaultValue: e.target.value })}
                      className="input flex-1"
                      style={{ height: 34, fontSize: 12 }}
                      placeholder="#6366f1"
                    />
                  </div>
                  <div className="grid grid-cols-6 gap-1">
                    {COLOR_SWATCHES.map(c => (
                      <button key={c} onClick={() => updateVar({ defaultValue: c })}
                        className="rounded-lg border border-border"
                        style={{ height: 28, background: c, cursor: 'pointer' }} />
                    ))}
                  </div>
                </div>
              ) : activeVar.type === 'image' ? (
                <div>
                  <label className="text-[11px] text-text-2 mb-1 block">默认参考图</label>
                  <div className="flex flex-wrap gap-1">
                    {['图1', '图2', '图3', '图4', '图5'].map(label => (
                      <button key={label} onClick={() => updateVar({ defaultValue: label })}
                        className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg border transition-colors"
                        style={{
                          background: activeVar.defaultValue === label ? activeVar.softColor : 'var(--color-bg)',
                          borderColor: activeVar.defaultValue === label ? activeVar.color : 'var(--color-border)',
                          color: activeVar.defaultValue === label ? activeVar.color : 'var(--color-text-2)',
                          cursor: 'pointer',
                        }}>{label}</button>
                    ))}
                  </div>
                </div>
              ) : (
                <div>
                  <label className="text-[11px] text-text-2 mb-1 block">默认值</label>
                  <textarea
                    value={activeVar.defaultValue}
                    onChange={e => updateVar({ defaultValue: e.target.value })}
                    className="input"
                    style={{ minHeight: 50, resize: 'vertical', fontSize: 12 }}
                    placeholder="变量的默认填充值..."
                  />
                </div>
              )}
            </div>
          ) : null}

          {/* 预览 */}
          <div className="card" style={{ padding: 14 }}>
            <h2 className="card-title flex items-center gap-1.5 mb-2 text-xs"><Eye size={13} />实时预览</h2>
            <div className="text-xs leading-relaxed whitespace-pre-wrap break-words rounded-lg p-2.5"
              style={{ background: 'var(--color-bg)', color: form.promptTemplate ? 'var(--color-text)' : 'var(--color-text-2)', minHeight: 60 }}>
              {form.promptTemplate ? (
                <PromptPreview template={form.promptTemplate} variables={variables} />
              ) : (
                <span className="italic">输入提示词后在此预览...</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ====== 封面上传器（单图，预上传存文件名） ====== */
function CoverUploader({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [err, setErr] = useState('');
  const [uploading, setUploading] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    setErr('');
    if (!files || files.length === 0) return;
    const f = files[0];
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) { setErr('仅支持 PNG/JPEG/WebP'); return; }
    if (f.size > 6 * 1024 * 1024) { setErr('单张不超过 6MB'); return; }

    setUploading(true);
    // 先读为 data URL 做即时预览
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      onChange([dataUrl]); // 即时预览

      // 上传到 backend → media-service → 返回文件名
      try {
        const base64 = dataUrl.includes('base64,') ? dataUrl.split('base64,')[1] : dataUrl;
        const d = await api<{ filename: string; url: string }>('/api/upload-reference', {
          method: 'POST',
          body: JSON.stringify({ fileData: base64, mimeType: f.type }),
        });
        if (d.ok && d.data) {
          // 用 /images/filename URL 替换 data URL（存文件名路径，不存 base64）
          onChange([d.data.url]);
        }
      } catch { /* 上传失败保留 data URL，保存时仍可工作 */ }
      setUploading(false);
    };
    reader.onerror = () => { setErr('读取失败'); setUploading(false); };
    reader.readAsDataURL(f);
  };

  const url = value[0];
  const displayUrl = resolveMediaUrl(url);

  return (
    <div>
      <label className="text-xs text-text-2 mb-1 block font-medium">模板封面</label>
      <div className="mb-2">
        <div className="aspect-[4/3] rounded-lg border border-border bg-bg flex items-center justify-center overflow-hidden relative" style={{ maxWidth: 260 }}>
          {url ? (
            <>
              {uploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-10">
                  <Loader2 size={20} className="animate-spin text-white" />
                </div>
              )}
              <img src={displayUrl} alt="封面" loading="lazy" className="w-full h-full object-cover" />
              <button onClick={() => onChange([])}
                className="absolute top-1.5 right-1.5 flex items-center justify-center rounded-full z-10"
                style={{ width: 24, height: 24, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                <X size={12} />
              </button>
            </>
          ) : (
            <div className="text-center text-xs text-text-2 p-4">
              <ImagePlus size={20} className="mx-auto mb-1" />点击上传封面
            </div>
          )}
        </div>
      </div>
      <label className={`inline-flex items-center gap-1 h-8 px-3 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
        uploading ? 'opacity-40 pointer-events-none' : ''
      }`} style={{ background: 'var(--color-primary)', color: '#fff' }}>
        <Upload size={12} />{uploading ? '上传中...' : url ? '已上传' : '上传封面'}
        <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => handleFiles(e.target.files)} disabled={uploading} />
      </label>
      {err && <div className="text-[11px] text-error mt-1">{err}</div>}
    </div>
  );
}

/* ====== 提示词预览（变量用默认值填充 + 彩色高亮） ====== */
function PromptPreview({ template, variables }: { template: string; variables: ParsedVar[] }) {
  const varMap = new Map(variables.map(v => [v.key, v]));
  const parts: { text: string; color?: string; softColor?: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // 创建局部 regex 避免与 parseVars 共享 lastIndex
  const re = /\{\{([^{}\s:#]+)(?:#([^{}\s:]+))?(?:[:：]([^}]*?))?\}\}/g;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    const v = varMap.get(m[1]);
    // 优先展示变量的默认值，其次展示模板内的 :默认值，最后展示变量名
    const display = v?.defaultValue || (m[3] ?? '').trim() || m[1];
    parts.push({ text: display, color: v?.color, softColor: v?.softColor });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });

  return (
    <>
      {parts.map((p, i) => p.color ? (
        <span key={i} className="rounded px-1 py-0.5 font-semibold" style={{ background: p.softColor, color: p.color }}>{p.text}</span>
      ) : (
        <span key={i}>{p.text}</span>
      ))}
    </>
  );
}

/* ====== 统计小盒 ====== */
function StatsBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card" style={{ padding: '10px 14px' }}>
      <div className="text-[11px] text-text-2 font-medium">{label}</div>
      <div className="text-base font-bold text-text mt-0.5">{value}</div>
    </div>
  );
}
