/**
 * 本页面实现主站 LoRA 训练打标工具，训练集、图片和标签直接持久化到独立本地模型平台。
 */
import type { LocalCaptioningAssetView, LocalCaptioningDatasetListView, LocalCaptioningDatasetView, LocalCaptioningStageView, LocalCaptioningTranslationListView } from '@aiimage/shared-contracts';
import { ArrowLeft, Check, ChevronRight, Copy, ImagePlus, Languages, LoaderCircle, Plus, RefreshCw, Save, Sparkles, Tags, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { Link } from 'react-router-dom';
import { Seo } from '../../../components/Seo';
import { ensureLocalTrainingSession, loadTrainingImage, localTrainingJson, uploadTrainingImage } from './localTrainingApi';
import './LoraCaptioningPage.css';

const maximumDatasetAssets = 200;
const uploadConcurrency = 3;
type TagTranslation = LocalCaptioningTranslationListView['translations'][number];
type TranslationMap = Record<string, TagTranslation>;

/** LoRA 训练打标工具入口。 */
export function LoraCaptioningPage() {
  const [token, setToken] = useState('');
  const [datasets, setDatasets] = useState<LocalCaptioningDatasetView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [translations, setTranslations] = useState<TranslationMap>({});

  /** 从独立平台读取当前账号的权威训练集。 */
  const refresh = useCallback(async (sessionToken: string, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const payload = await localTrainingJson<LocalCaptioningDatasetListView>('/v1/training/datasets', sessionToken);
      setDatasets(payload.datasets);
      setSelectedId((current) => payload.datasets.some((dataset) => dataset.id === current) ? current : payload.datasets[0]?.id || '');
      if (!quiet) setMessage('');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void ensureLocalTrainingSession().then(async (session) => {
      if (!active) return;
      setToken(session.sessionToken);
      await refresh(session.sessionToken);
    }).catch((error) => { if (active) { setMessage(errorMessage(error)); setLoading(false); } });
    return () => { active = false; };
  }, [refresh]);

  const selected = datasets.find((dataset) => dataset.id === selectedId) ?? null;
  const captionActive = datasets.some((dataset) => ['queued', 'running'].includes(dataset.captionStage?.status || ''));
  useEffect(() => {
    if (!token || !captionActive) return;
    const timer = window.setInterval(() => void refresh(token, true), 2500);
    return () => window.clearInterval(timer);
  }, [captionActive, refresh, token]);

  return <div className="lora-captioning-page">
    <Seo title="LoRA 训练打标" description="创建 LoRA 训练集，批量上传图片、自动打标、翻译和人工整理标签，并联动本地模型 LoRA 训练。" path="/tools/lora-captioning" />
    <header className="lora-captioning-header">
      <div><Link to="/tools"><ArrowLeft size={15} />返回工具中心</Link><span><Tags size={15} />LoRA 数据准备</span><h1>LoRA 训练打标</h1><p>训练集与本地模型 LoRA 训练实时联动。自动打标后逐图核对、增删标签并保存，再进入训练。</p></div>
      <button onClick={() => token && void refresh(token)} disabled={!token || loading}><RefreshCw className={loading ? 'spin' : ''} size={16} />刷新数据</button>
    </header>
    {message && <div className="lora-captioning-notice"><span>{message}</span><button onClick={() => setMessage('')} aria-label="关闭提示"><X size={14} /></button></div>}
    <div className="lora-captioning-layout">
      <DatasetSidebar token={token} datasets={datasets} selectedId={selectedId} onSelect={setSelectedId} onCreated={async (dataset) => { await refresh(token, true); setSelectedId(dataset.id); }} onError={setMessage} />
      {selected ? <CaptioningWorkspace token={token} dataset={selected} translations={translations} onTranslations={setTranslations} onChanged={() => refresh(token, true)} onArchived={() => refresh(token)} onMessage={setMessage} /> : <section className="lora-captioning-empty"><Tags size={42} /><h2>{loading ? '正在读取训练集' : '创建第一个训练集'}</h2><p>训练图片与标签会保存到独立平台后端，刷新页面也不会丢失。</p></section>}
    </div>
  </div>;
}

/** 训练集侧栏提供持久化创建与选择。 */
function DatasetSidebar({ token, datasets, selectedId, onSelect, onCreated, onError }: { token: string; datasets: LocalCaptioningDatasetView[]; selectedId: string; onSelect: (id: string) => void; onCreated: (dataset: LocalCaptioningDatasetView) => Promise<void>; onError: (message: string) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!token || !title.trim()) return;
    setBusy(true);
    try {
      const dataset = await localTrainingJson<LocalCaptioningDatasetView>('/v1/training/datasets', token, { method: 'POST', body: JSON.stringify({ title: title.trim(), description: description.trim() || null }) });
      setTitle(''); setDescription(''); await onCreated(dataset);
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <aside className="lora-dataset-sidebar"><header><span>训练集</span><strong>{datasets.length}</strong></header><div className="lora-dataset-create"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="训练集名称" maxLength={191} /><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} placeholder="用途或角色说明（可选）" maxLength={10000} /><button onClick={() => void create()} disabled={busy || !token || !title.trim()}>{busy ? <LoaderCircle className="spin" /> : <Plus />}创建训练集</button></div><div className="lora-dataset-list">{datasets.map((dataset) => <button key={dataset.id} className={dataset.id === selectedId ? 'active' : ''} onClick={() => onSelect(dataset.id)}><span><strong>{dataset.title}</strong><small>{dataset.assets.length} 张 · {stageLabel(dataset.captionStage?.status)}</small></span><ChevronRight size={15} /></button>)}</div></aside>;
}

/** 当前训练集的上传、自动打标、翻译、确认和逐图标签操作区。 */
function CaptioningWorkspace({ token, dataset, translations, onTranslations, onChanged, onArchived, onMessage }: { token: string; dataset: LocalCaptioningDatasetView; translations: TranslationMap; onTranslations: Dispatch<SetStateAction<TranslationMap>>; onChanged: () => Promise<void>; onArchived: () => Promise<void>; onMessage: (message: string) => void }) {
  const [mode, setMode] = useState<'character' | 'style' | 'concept'>('character');
  const [busy, setBusy] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [uploadText, setUploadText] = useState('添加图片');
  const automaticTranslationKeys = useRef(new Set<string>());
  const stage = dataset.captionStage;
  const active = ['queued', 'running'].includes(stage?.status || '');
  const locked = active || dataset.trainingJobCount > 0;
  const allCaptioned = dataset.assets.length > 0 && dataset.assets.every((asset) => Boolean(asset.caption?.trim()));
  const allTags = useMemo(() => [...new Set(dataset.assets.flatMap((asset) => splitTags(asset.caption || '')))], [dataset.assets]);

  /** 受控并发上传本次选择的全部可容纳文件，单图失败不回滚其他成功图片。 */
  const upload = async (files: File[]) => {
    const accepted = files.slice(0, Math.max(0, maximumDatasetAssets - dataset.assets.length));
    if (!accepted.length) return;
    setBusy(true);
    try {
      let nextIndex = 0; let succeeded = 0; const failures: string[] = [];
      const worker = async () => {
        for (;;) {
          const index = nextIndex++;
          const file = accepted[index];
          if (!file) return;
          setUploadText(`上传 ${succeeded + failures.length}/${accepted.length}`);
          try { await uploadTrainingImage(dataset.id, file, token); succeeded += 1; }
          catch (error) { failures.push(`${file.name}: ${errorMessage(error)}`); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(uploadConcurrency, accepted.length) }, () => worker()));
      await onChanged();
      setUploadText(`完成 ${succeeded}/${accepted.length}`);
      if (failures.length) onMessage(`已保存 ${succeeded} 张，${failures.length} 张失败：${failures.slice(0, 3).join('；')}`);
    } catch (error) {
      onMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  /** 创建独立平台持久化自动打标任务。 */
  const autoCaption = async () => {
    setBusy(true);
    try { await localTrainingJson(`/v1/training/datasets/${dataset.id}/caption-jobs`, token, { method: 'POST', body: JSON.stringify({ mode }) }); await onChanged(); }
    catch (error) { onMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 分批读取后端持久化翻译集，缺失标签由独立平台补全并保存。 */
  const requestTranslations = useCallback(async (tags: string[]) => {
    const merged: TranslationMap = {};
    for (let index = 0; index < tags.length; index += 150) {
      const result = await localTrainingJson<LocalCaptioningTranslationListView>('/v1/training/tag-translations', token, { method: 'POST', body: JSON.stringify({ tags: tags.slice(index, index + 150) }) });
      for (const item of result.translations) merged[item.tag] = item;
    }
    onTranslations((current) => ({ ...current, ...merged }));
    return Object.keys(merged).length;
  }, [onTranslations, token]);
  /** 手动刷新当前训练集全部标签的翻译、来源和稳定色。 */
  const translateAll = async () => {
    if (!allTags.length) return onMessage('当前训练集还没有可翻译标签');
    setTranslating(true);
    try { onMessage(`已读取 ${await requestTranslations(allTags)} 个去重标签的翻译集`); }
    catch (error) { onMessage(errorMessage(error)); }
    finally { setTranslating(false); }
  };
  const missingTags = useMemo(() => allTags.filter((tag) => !translations[tag]), [allTags, translations]);
  const automaticTranslationKey = `${dataset.id}:${missingTags.join('\u0000')}`;
  /** 自动补齐已打标图片的中文栏，同一标签集合在当前页面只发起一次请求。 */
  useEffect(() => {
    if (!token || active || missingTags.length === 0 || automaticTranslationKeys.current.has(automaticTranslationKey)) return;
    automaticTranslationKeys.current.add(automaticTranslationKey);
    let mounted = true;
    setTranslating(true);
    void requestTranslations(missingTags).catch((error) => { if (mounted) onMessage(errorMessage(error)); }).finally(() => { if (mounted) setTranslating(false); });
    return () => { mounted = false; };
  }, [active, automaticTranslationKey, missingTags, onMessage, requestTranslations, token]);
  /** 确认当前图片快照和所有 Caption，开放独立平台正式训练。 */
  const confirm = async () => {
    if (!stage || !window.confirm('确认已逐图核对全部标签，并将当前训练集标记为可训练？')) return;
    setBusy(true);
    try { await localTrainingJson(`/v1/training/datasets/${dataset.id}/caption-jobs/${stage.id}/confirm`, token, { method: 'POST', body: '{}' }); await onChanged(); }
    catch (error) { onMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 归档未投入训练的数据集；已训练数据继续保留审计。 */
  const archive = async () => {
    if (dataset.trainingJobCount > 0 || !window.confirm(`归档训练集“${dataset.title}”？`)) return;
    try { await localTrainingJson(`/v1/training/datasets/${dataset.id}`, token, { method: 'DELETE' }); await onArchived(); }
    catch (error) { onMessage(errorMessage(error)); }
  };
  return <main className="lora-captioning-workspace"><header className="lora-captioning-dataset-head"><div><span>{dataset.assets.length} / {maximumDatasetAssets} 张</span><h2>{dataset.title}</h2><p>{dataset.description || '未填写训练集说明'}</p></div><div><label><ImagePlus size={15} />{uploadText}<input type="file" accept="image/*,.avif,.heic,.heif,.webp" multiple disabled={busy || locked || dataset.assets.length >= maximumDatasetAssets} onChange={(event) => void upload(Array.from(event.target.files || []))} /></label><button className="danger" disabled={busy || dataset.trainingJobCount > 0} onClick={() => void archive()}><Trash2 size={14} />归档</button></div></header>
    <section className="lora-caption-controls"><label><span>打标重点</span><select value={mode} disabled={busy || active} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="character">角色：外观、服装、姿势</option><option value="style">画风：线条、色彩、光影</option><option value="concept">概念：主体、场景、画风</option></select></label><button onClick={() => void autoCaption()} disabled={busy || active || dataset.assets.length < 1 || dataset.trainingJobCount > 0}><Sparkles size={15} />{stage ? '重新自动打标' : '自动打标'}</button><button onClick={() => void translateAll()} disabled={busy || translating || allTags.length === 0}><Languages size={15} />{translating ? '读取翻译集' : '刷新翻译'}</button><button className="confirm" onClick={() => void confirm()} disabled={busy || !allCaptioned || stage?.status !== 'awaiting_confirmation'}><Check size={15} />{stage?.status === 'confirmed' ? '已确认' : '确认标签'}</button><a href={`/local-model/?tab=training&dataset=${encodeURIComponent(dataset.id)}`}><ChevronRight size={15} />进入 LoRA 训练</a></section>
    {stage && <section className={`lora-caption-progress is-${stage.status}`}><div><Tags size={17} /><span><strong>{stageLabel(stage.status)}</strong><small>{stage.completedAssets}/{stage.totalAssets} 张 · {Math.round(stage.progress)}%</small></span></div><div><i style={{ width: `${stage.progress}%` }} /></div>{stage.errorMessage && <p>{stage.errorMessage}</p>}</section>}
    {locked && <div className="lora-captioning-lock">{active ? '自动打标正在处理当前图片快照，完成前暂不允许修改。' : '该训练集已经用于训练，标签与图片已锁定以保留审计。'}</div>}
    <section className="lora-captioning-assets">{dataset.assets.map((asset) => <CaptionAssetCard key={asset.id} token={token} datasetId={dataset.id} asset={asset} locked={locked} translations={translations} onChanged={onChanged} onMessage={onMessage} />)}{dataset.assets.length === 0 && <label className="lora-caption-drop"><ImagePlus size={34} /><strong>选择任意数量训练图片</strong><span>一次多选并受控并发上传；最多保存 200 张，单图失败不会丢失其他图片。</span><input type="file" accept="image/*,.avif,.heic,.heif,.webp" multiple disabled={busy} onChange={(event) => void upload(Array.from(event.target.files || []))} /></label>}</section>
  </main>;
}

/** 单图标签行按图片、英文原文、中文翻译三栏展示并支持显式后端保存。 */
function CaptionAssetCard({ token, datasetId, asset, locked, translations, onChanged, onMessage }: { token: string; datasetId: string; asset: LocalCaptioningAssetView; locked: boolean; translations: TranslationMap; onChanged: () => Promise<void>; onMessage: (message: string) => void }) {
  const [tags, setTags] = useState(() => splitTags(asset.caption || ''));
  const [newTag, setNewTag] = useState('');
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const serverCaption = normalizeCaption(asset.caption || '');
  const draftCaption = normalizeCaption(tags.join(', '));
  const dirty = draftCaption !== serverCaption;
  useEffect(() => { if (!edited) setTags(splitTags(asset.caption || '')); }, [asset.caption, edited]);
  const addTag = () => { const tag = normalizeTag(newTag); if (!tag) return; setTags((current) => current.includes(tag) ? current : [...current, tag]); setEdited(true); setNewTag(''); };
  const save = async () => {
    setSaving(true);
    try { await localTrainingJson(`/v1/training/datasets/${datasetId}/assets/${asset.id}`, token, { method: 'PATCH', body: JSON.stringify({ caption: draftCaption || null }) }); setEdited(false); await onChanged(); }
    catch (error) { onMessage(errorMessage(error)); }
    finally { setSaving(false); }
  };
  const removeImage = async () => {
    if (!window.confirm('从训练集中删除这张图片？')) return;
    try { await localTrainingJson(`/v1/training/datasets/${datasetId}/assets/${asset.id}`, token, { method: 'DELETE' }); await onChanged(); }
    catch (error) { onMessage(errorMessage(error)); }
  };
  /** 复制当前单图的英文 Anima 标签，保持逗号加空格的标准分隔格式。 */
  const copyTags = async () => {
    try { await copyText(tags.join(', ')); onMessage(`已复制当前图片的 ${tags.length} 个 Anima 标签`); }
    catch (error) { onMessage(errorMessage(error)); }
  };
  return <article className={`lora-caption-asset${asset.caption?.trim() ? ' captioned' : ''}`}>
    <div className="lora-caption-image"><PrivateDatasetImage token={token} datasetId={datasetId} assetId={asset.id} /><span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : '训练图片'}</span><button disabled={locked} onClick={() => void removeImage()} aria-label="删除图片"><Trash2 size={14} /></button></div>
    <section className="lora-caption-column"><header><span>图片标签</span><div><small>{tags.length} 个</small><button className="lora-caption-copy" disabled={!tags.length} onClick={() => void copyTags()}><Copy size={12} />复制 Anima Tag</button></div></header><div className="lora-caption-tag-list">{tags.length ? tags.map((tag) => { const translation = translations[tag]; return <span className={`lora-caption-tag${translation ? '' : ' is-pending'}`} style={tagColorStyle(translation)} key={tag} title={translation?.source === 'common' ? '平台常用标签翻译集' : translation ? '智能翻译并已持久化' : '正在读取翻译'}><b>{tag}</b><small>{translation?.translated || '翻译中'}</small><button disabled={locked} onClick={() => { setTags((current) => current.filter((item) => item !== tag)); setEdited(true); }} aria-label={`删除标签 ${tag}`}><X size={11} /></button></span>; }) : <p>尚未打标，可自动打标或手动添加。</p>}</div><footer><div className="lora-caption-add"><input value={newTag} disabled={locked} onChange={(event) => setNewTag(event.target.value)} placeholder="输入英文标签" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }} /><button disabled={locked || !newTag.trim()} onClick={addTag}><Plus size={13} />添加</button></div><button className="lora-caption-save" disabled={locked || saving || !dirty} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" /> : <Save size={14} />}{saving ? '保存中' : dirty ? '保存标签' : '已保存'}</button></footer></section>
  </article>;
}

/** 图片进入视口后再读取私有二进制，避免大训练集首屏并发加载全部原图。 */
function PrivateDatasetImage({ token, datasetId, assetId }: { token: string; datasetId: string; assetId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!root.current || visible) return; const observer = new IntersectionObserver((items) => { if (items.some((item) => item.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '240px' }); observer.observe(root.current); return () => observer.disconnect(); }, [visible]);
  useEffect(() => { if (!visible) return; const controller = new AbortController(); let objectUrl = ''; void loadTrainingImage(datasetId, assetId, token, controller.signal).then((blob) => { objectUrl = URL.createObjectURL(blob); setSource(objectUrl); }).catch(() => { if (!controller.signal.aborted) setFailed(true); }); return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [assetId, datasetId, token, visible]);
  return <div ref={root}>{source ? <img src={source} alt="LoRA 训练图片" /> : failed ? <span>图片读取失败</span> : <LoaderCircle className="spin" />}</div>;
}

/** 把持久化 Caption 拆成去重英文标签。 */
function splitTags(value: string): string[] { return [...new Set(value.split(/[,，\n;；]+/).map(normalizeTag).filter(Boolean))]; }
/** 统一单个标签的大小写和空白。 */
function normalizeTag(value: string): string { return value.trim().replace(/\s+/g, ' ').toLowerCase(); }
/** 统一 Caption 序列化格式，避免无意义空白产生脏状态。 */
function normalizeCaption(value: string): string { return splitTags(value).join(', '); }
/** 把后端持久化色写入同一英文、中文标签的 CSS 变量。 */
function tagColorStyle(translation: TagTranslation | undefined): CSSProperties { return { '--tag-color': translation?.color || '#64748b' } as CSSProperties; }
/** 优先使用安全剪贴板 API，浏览器限制时回退到临时文本框复制。 */
async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement('textarea');
  textarea.value = value; textarea.style.position = 'fixed'; textarea.style.opacity = '0';
  document.body.appendChild(textarea); textarea.select();
  const copied = document.execCommand('copy'); textarea.remove();
  if (!copied) throw new Error('复制失败，请检查浏览器剪贴板权限');
}
/** 输出打标阶段中文状态。 */
function stageLabel(status: LocalCaptioningStageView['status'] | null | undefined): string {
  return { queued: '等待打标', running: '自动打标中', awaiting_confirmation: '等待确认', confirmed: '已确认', failed: '打标失败', stale: '需要重新打标' }[String(status)] || '未打标';
}
/** 将未知异常转为用户可读文本。 */
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'LoRA 打标操作失败'; }
