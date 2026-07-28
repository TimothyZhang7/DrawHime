/** 模板使用页 — 颜色变量显示取色器、图片变量显示快速选项、预览高亮填充值 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useToast } from '../../providers/ToastProvider';
import { api } from '../../lib/api';
import { resolveMediaUrl } from '../../lib/media';
import {
  ArrowLeft, Copy, Check, Save, Loader2, Edit3, Eye,
  Variable, User, Calendar, Info, Trash2, Wand2, Palette, ImagePlus
} from 'lucide-react';

/* ====== 变量解析 ====== */
type VarType = 'text' | 'color' | 'image';
const TYPE_ALIASES: Record<string, VarType> = { color: 'color', '颜色': 'color', image: 'image', img: 'image', '图片': 'image', '参考图': 'image' };

interface VarDef {
  key: string;
  type: VarType;
  defaultValue: string;
  color: string;
  softColor: string;
}

const TEMPLATE_RE = /\{\{([^{}\s:#]+)(?:#([^{}\s:]+))?(?:[:：]([^}]*?))?\}\}/g;

function parseVars(template: string): VarDef[] {
  const seen = new Map<string, VarDef>();
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_RE.exec(template)) !== null) {
    if (seen.has(m[1])) continue;
    const rawType = (m[2] ?? '').toLowerCase();
    seen.set(m[1], {
      key: m[1],
      type: TYPE_ALIASES[rawType] ?? 'text',
      defaultValue: (m[3] ?? '').trim(),
      // 参数使用页沿用模板编辑器变量色板，保证标题和预览高亮颜色一致。
      color: VAR_TONES[seen.size % VAR_TONES.length].color,
      softColor: VAR_TONES[seen.size % VAR_TONES.length].soft,
    });
  }
  return [...seen.values()];
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(TEMPLATE_RE, (_, name: string) => values[name] ?? `{{${name}}}`);
}

const COLOR_SWATCHES = ['#ffffff', '#111827', '#f87171', '#fb7185', '#f472b6', '#a78bfa', '#60a5fa', '#22d3ee', '#34d399', '#a3e635', '#facc15', '#fb923c'];

type TemplateData = {
  id: number; name: string; description: string; promptTemplate: string;
  defaultValues?: string; sourceTemplateId?: number;
  coverImageUrls: string[]; isPublic: boolean;
  isFavorited: boolean; favoriteCount: number;
  userId: number; username: string; createdAt: string;
};

export function TemplateUsePage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { show } = useToast();

  const [tpl, setTpl] = useState<TemplateData | null>(null);
  const [fetching, setFetching] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!id) return;
    api<TemplateData>(`/api/templates/${id}`).then(d => {
      if (d.ok && d.data) {
        setTpl(d.data);
        const init: Record<string, string> = {};
        if (d.data.defaultValues) {
          try { Object.assign(init, JSON.parse(d.data.defaultValues)); } catch { /* */ }
        }
        for (const v of parseVars(d.data.promptTemplate)) {
          if (!init[v.key] && v.defaultValue) init[v.key] = v.defaultValue;
        }
        setParamValues(init);
      }
      setFetching(false);
    });
    api<{ id: number }>('/auth/me').then(d => { if (d.ok && d.data) setCurrentUserId(d.data.id); });
  }, [id]);

  const varDefs = useMemo(() => tpl ? parseVars(tpl.promptTemplate) : [], [tpl]);
  const filledPrompt = useMemo(() => tpl ? fillTemplate(tpl.promptTemplate, paramValues) : '', [tpl, paramValues]);

  const setVar = useCallback((name: string, value: string) => setParamValues(p => ({ ...p, [name]: value })), []);

  const copyPrompt = useCallback(async () => {
    if (!filledPrompt) return;
    try { await navigator.clipboard.writeText(filledPrompt); } catch { /* */ }
    setCopied(true); show('提示词已复制', 'success'); setTimeout(() => setCopied(false), 2000);
  }, [filledPrompt, show]);

  const goGenerate = useCallback(() => {
    if (!filledPrompt) return;
    // 模板使用页直接把提示词带到首页绘图工作台。
    nav(`/?prompt=${encodeURIComponent(filledPrompt)}`);
  }, [filledPrompt, nav]);

  const saveCopy = useCallback(async () => {
    if (!tpl) return;
    setSaving(true);
    const body = {
      name: `${tpl.name}`, promptTemplate: tpl.promptTemplate,
      description: tpl.description, coverImageUrls: tpl.coverImageUrls,
      isPublic: false, sourceTemplateId: tpl.id, defaultValues: JSON.stringify(paramValues),
    };
    const d = await api<{ id: number }>('/api/templates', { method: 'POST', body: JSON.stringify(body) });
    if (d.ok) { show('副本已保存', 'success'); nav(`/templates/${d.data!.id}`); }
    else show(d.message ?? '保存副本失败', 'error');
    setSaving(false);
  }, [tpl, paramValues, show, nav]);

  const del = useCallback(async () => {
    if (!tpl || !window.confirm(`确定删除「${tpl.name}」？此操作不可撤销。`)) return;
    setDeleting(true);
    const d = await api(`/api/templates/${tpl.id}`, { method: 'DELETE' });
    if (d.ok) { show('已删除', 'success'); nav('/api/templates', { replace: true }); }
    else show(d.message ?? '删除失败', 'error');
    setDeleting(false);
  }, [tpl, show, nav]);

  /** 切换公开/私密状态 */
  const togglePublic = useCallback(async () => {
    if (!tpl) return;
    const next = !tpl.isPublic;
    // 乐观更新
    setTpl(prev => prev ? { ...prev, isPublic: next } : prev);
    const d = await api(`/api/templates/${tpl.id}`, {
      method: 'PUT',
      body: JSON.stringify({ isPublic: next }),
    });
    if (d.ok) {
      show(next ? '已设为公开' : '已设为私密', 'success');
    } else {
      // 回滚
      setTpl(prev => prev ? { ...prev, isPublic: !next } : prev);
      show(d.message ?? '切换失败', 'error');
    }
  }, [tpl, show]);

  if (fetching) return (
    <div className="text-center py-16 text-text-2 flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />加载中...</div>
  );
  if (!tpl) return (
    <div className="text-center py-24 text-text-2">
      <div className="text-lg font-semibold mb-2">模板不存在</div>
      <Link to="/templates" className="btn btn-outline btn-sm">返回模板列表</Link>
    </div>
  );

  const isOwner = currentUserId !== null && currentUserId === tpl.userId;
  const authLoading = currentUserId === null;

  return (
    <div className="animate-fade-in">
      {/* 顶部操作栏 — 模板管理 */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3" style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 12 }}>
        <Link to="/templates" className="inline-flex items-center gap-1 text-sm text-text-2 hover:text-text">
          <ArrowLeft size={14} />返回模板列表
        </Link>
        <div className="flex items-center gap-2">
          {/* 隐私状态 — 始终可见，公开=绿色，私密=灰色 */}
          {isOwner ? (
            <button onClick={togglePublic}
              className="btn btn-sm flex items-center gap-1.5 text-xs font-medium"
              style={{
                background: tpl.isPublic ? '#dcfce7' : '#f3f4f6',
                color: tpl.isPublic ? '#16a34a' : '#6b7280',
                border: `1px solid ${tpl.isPublic ? '#bbf7d0' : '#e5e7eb'}`,
              }}
              title={tpl.isPublic ? '点击设为私密' : '点击设为公开'}>
              <Eye size={13} />{tpl.isPublic ? '公开' : '私密'}
            </button>
          ) : (
            <span className="badge text-xs font-medium flex items-center gap-1 px-2.5 py-1"
              style={tpl.isPublic
                ? { background: '#dcfce7', color: '#16a34a' }
                : { background: '#f3f4f6', color: '#6b7280' }}>
              <Eye size={12} />{tpl.isPublic ? '公开' : '私密'}
            </span>
          )}
          {/* 编辑 — 所有者可编辑 */}
          {isOwner ? (
            <Link to={`/templates/${tpl.id}/edit`} className="btn btn-outline btn-sm flex items-center gap-1">
              <Edit3 size={13} />编辑模板
            </Link>
          ) : (
            <span className="text-xs text-text-2 flex items-center gap-1" style={{ opacity: 0.5 }}>
              <Edit3 size={13} />{tpl.username} 的模板
            </span>
          )}
          {/* 删除 — 仅所有者 */}
          {isOwner && (
            <button onClick={del} disabled={deleting} className="btn btn-sm flex items-center gap-1 text-white" style={{ background: deleting ? '#f87171' : '#ef4444' }}>
              <Trash2 size={13} />{deleting ? '删除中...' : '删除'}
            </button>
          )}
        </div>
      </div>

      {/* 模板信息 */}
      <div className="card mb-4">
        <div className="flex items-start gap-4 flex-wrap">
          {tpl.coverImageUrls.length > 0 && (
            <div className="flex-shrink-0 rounded-lg overflow-hidden border border-border bg-bg flex items-center justify-center" style={{ width: 160, height: 120 }}>
              <img src={resolveMediaUrl(tpl.coverImageUrls[0])} alt="" loading="lazy" className="w-full h-full object-cover" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h1 className="page-title truncate">{tpl.name}</h1>
              {tpl.sourceTemplateId && <span className="badge text-[10px]" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning)' }}>副本</span>}
            </div>
            {tpl.description && <p className="text-xs text-text-2 leading-relaxed mb-2">{tpl.description}</p>}
            <div className="flex items-center gap-3 text-[11px] text-text-2 flex-wrap">
              <span className="flex items-center gap-1"><User size={11} />{tpl.username}</span>
              <span className="flex items-center gap-1"><Calendar size={11} />{tpl.createdAt?.slice(0, 10)}</span>
              {tpl.sourceTemplateId && <span className="flex items-center gap-1"><Info size={11} />源自模板 #{tpl.sourceTemplateId}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* 参数 + 预览 */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* 左侧：参数 */}
        <div className="flex-1">
          <div className="card">
            <h2 className="card-title flex items-center gap-2 mb-3">
              <Variable size={14} />参数
              {varDefs.length === 0 && <span className="text-xs text-text-2 font-normal">— 此模板无参数</span>}
            </h2>
            {varDefs.length > 0 ? (
              <div className="flex flex-col gap-4">
                {varDefs.map(v => (
                  <div key={v.key}>
                    <label className="mb-1.5 flex items-center gap-2">
                      <span
                        className="text-sm font-extrabold leading-tight tracking-normal"
                        style={{ color: v.color }}
                      >
                        {v.key}
                      </span>
                      <TypeBadge type={v.type} />
                    </label>
                    {v.type === 'color' ? (
                      <ColorInput value={paramValues[v.key] ?? ''} onChange={val => setVar(v.key, val)} />
                    ) : v.type === 'image' ? (
                      <ImageInput value={paramValues[v.key] ?? ''} onChange={val => setVar(v.key, val)} />
                    ) : (
                      <input value={paramValues[v.key] ?? ''} onChange={e => setVar(v.key, e.target.value)}
                        placeholder={`输入 ${v.key} 的值...`} className="input" />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-2">此模板不含变量，可以直接使用下方按钮。</p>
            )}
          </div>
        </div>

        {/* 右侧：预览 + 操作 */}
        <div className="lg:w-[380px] flex flex-col gap-3">
          <div className="card">
            <h2 className="card-title flex items-center gap-2 mb-3"><Eye size={14} />预览</h2>
            <div className="bg-bg rounded-lg p-3 text-sm leading-relaxed whitespace-pre-wrap break-words"
              style={{ minHeight: 80, color: filledPrompt ? 'var(--color-text)' : 'var(--color-text-2)' }}>
              {filledPrompt ? (
                <FilledPreview template={tpl.promptTemplate} values={paramValues} varDefs={varDefs} />
              ) : (
                <span className="italic">填写参数后在此预览...</span>
              )}
            </div>
            <details className="mt-2">
              <summary className="text-xs text-text-2 cursor-pointer">查看原始模板</summary>
              <div className="mt-1.5 bg-bg rounded p-2 text-xs font-mono text-text-2 whitespace-pre-wrap break-words">{tpl.promptTemplate}</div>
            </details>
          </div>
          <div className="flex flex-col gap-2">
            <button onClick={copyPrompt} disabled={!filledPrompt}
              className="btn flex items-center justify-center gap-2" style={{ height: 44, fontSize: 14, ...(!filledPrompt ? { opacity: 0.5 } : {}) }}>
              {copied ? <><Check size={16} />已复制到剪贴板</> : <><Copy size={16} />复制到剪贴板</>}
            </button>
            <button onClick={goGenerate} disabled={!filledPrompt}
              className="btn flex items-center justify-center gap-2"
              style={{ height: 44, fontSize: 14, background: 'linear-gradient(135deg, var(--color-primary), var(--color-accent))', ...(!filledPrompt ? { opacity: 0.5 } : {}) }}>
              <Wand2 size={16} />去生成图片
            </button>
            <button onClick={saveCopy} disabled={saving}
              className="btn btn-outline flex items-center justify-center gap-2">
              <Save size={15} />{saving ? '保存中...' : '另存为副本'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ====== 类型徽章 ====== */
function TypeBadge({ type }: { type: VarType }) {
  if (type === 'color') return <span className="inline-flex items-center gap-0.5 text-[10px] font-medium" style={{ color: '#7c3aed' }}><Palette size={10} />颜色</span>;
  if (type === 'image') return <span className="inline-flex items-center gap-0.5 text-[10px] font-medium" style={{ color: '#0891b2' }}><ImagePlus size={10} />图片</span>;
  return null;
}

/* ====== 颜色输入 ====== */
function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#6366f1';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 items-center">
        <input type="color" value={hex} onChange={e => onChange(e.target.value)}
          style={{ width: 38, height: 38, border: '1px solid var(--color-border)', borderRadius: 10, padding: 3, cursor: 'pointer', flexShrink: 0 }} />
        <input value={value} onChange={e => onChange(e.target.value)}
          placeholder="#6366f1 或 red" className="input flex-1" />
      </div>
      <div className="flex flex-wrap gap-1">
        {COLOR_SWATCHES.map(c => (
          <button key={c} onClick={() => onChange(c)}
            className="rounded-lg border border-border transition-transform hover:scale-110"
            style={{ width: 26, height: 26, background: c, cursor: 'pointer' }}
            title={c} />
        ))}
      </div>
    </div>
  );
}

/* ====== 图片参考图输入 ====== */
function ImageInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <input value={value} onChange={e => onChange(e.target.value)}
        placeholder="输入参考图描述..." className="input" />
      <div className="flex flex-wrap gap-1">
        {['图1', '图2', '图3', '图4', '图5'].map(label => (
          <button key={label} onClick={() => onChange(label)}
            className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg border transition-colors"
            style={{
              background: value === label ? 'var(--color-primary-soft)' : 'var(--color-bg)',
              borderColor: value === label ? 'var(--color-primary)' : 'var(--color-border)',
              color: value === label ? 'var(--color-primary)' : 'var(--color-text-2)',
              cursor: 'pointer',
            }}>{label}</button>
        ))}
      </div>
    </div>
  );
}

/* ====== 预览（填充值高亮） ====== */
const VAR_TONES = [
  { color: '#2563eb', soft: '#eff6ff' },
  { color: '#dc2626', soft: '#fef2f2' },
  { color: '#059669', soft: '#ecfdf5' },
  { color: '#d97706', soft: '#fffbeb' },
  { color: '#7c3aed', soft: '#f5f3ff' },
  { color: '#0891b2', soft: '#ecfeff' },
  { color: '#db2777', soft: '#fdf2f8' },
  { color: '#4f46e5', soft: '#eef2ff' },
];

function FilledPreview({ template, values, varDefs }: { template: string; values: Record<string, string>; varDefs: VarDef[] }) {
  const toneMap = new Map(varDefs.map(v => [v.key, { color: v.color, soft: v.softColor }]));
  const parts: { text: string; tone?: typeof VAR_TONES[0] }[] = [];
  let last = 0;
  const re = /\{\{([^{}\s:#]+)(?:#[^{}\s:]+)?(?:[:：]([^}]*?))?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    const key = m[1];
    const filled = values[key]?.trim() || (m[2] ?? '').trim() || `{{${key}}}`;
    const tone = !values[key]?.trim() ? undefined : toneMap.get(key);
    parts.push({ text: filled, tone });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });

  return (
    <>
      {parts.map((p, i) => p.tone ? (
        <span key={i} className="rounded-sm px-0.5 font-semibold" style={{ background: p.tone.soft, color: p.tone.color }}>{p.text}</span>
      ) : (
        <span key={i}>{p.text}</span>
      ))}
    </>
  );
}
