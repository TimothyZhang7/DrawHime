/** 本页面实现 LoRA 仓库浏览、筛选、用户多示例图上传、草稿发布和作者删除。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileBox, ImagePlus, Loader2, PackageOpen, Plus, Search, Trash2, UploadCloud, X } from 'lucide-react';
import { LORA_REPOSITORY_TYPE_OPTIONS, type LoraBaseModelListResponse, type LoraRepositoryItemResponse, type LoraRepositoryItemView, type LoraRepositoryListResponse, type LoraRepositoryType, type LoraUploadChunkResponse, type LoraUploadKind, type LoraUploadSessionResponse } from '@aiimage/shared-contracts';
import { Seo } from '../../components/Seo';
import { api } from '../../lib/api';
import { config } from '../../lib/config';
import { useAuth } from '../../providers/AuthProvider';
import { useToast } from '../../providers/ToastProvider';
import './LoraRepositoryPage.css';

const MAX_EXAMPLES = 8;
const CUSTOM_MODEL_VALUE = '__custom__';

/** LoRA 仓库主页。 */
export function LoraRepositoryPage() {
  const { user } = useAuth();
  const { show } = useToast();
  const [items, setItems] = useState<LoraRepositoryItemView[]>([]);
  const [models, setModels] = useState<LoraBaseModelListResponse['models']>([{ value: 'anima', label: 'Anima' }, { value: 'krea2', label: 'Krea 2' }]);
  const [model, setModel] = useState('');
  const [loraType, setLoraType] = useState('');
  const [search, setSearch] = useState('');
  const [mine, setMine] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    void api<LoraBaseModelListResponse>('/api/loras/models').then(response => { if (response.ok && response.data) setModels(response.data.models); });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true);
      const query = new URLSearchParams({ page: '1', pageSize: '30' });
      if (search.trim()) query.set('search', search.trim());
      if (model) query.set('model', model);
      if (loraType) query.set('type', loraType);
      if (mine) query.set('mine', '1');
      void api<LoraRepositoryListResponse>(`/api/loras?${query}`).then(response => {
        if (response.ok && response.data) setItems(response.data.items);
        else show(response.message ?? 'LoRA 仓库加载失败', 'error');
        setLoading(false);
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [loraType, mine, model, refreshKey, search, show]);

  /** 删除作者自己的条目并清理真实存储文件。 */
  const removeItem = async (item: LoraRepositoryItemView) => {
    if (!window.confirm(`删除「${item.title}」及其文件？`)) return;
    const response = await api(`/api/loras/${item.id}`, { method: 'DELETE' });
    if (!response.ok) return show(response.message ?? '删除失败', 'error');
    show('LoRA 已删除', 'success');
    setRefreshKey(value => value + 1);
  };

  /** 对文件齐全但尚未发布的草稿执行发布。 */
  const publishItem = async (item: LoraRepositoryItemView) => {
    const response = await api<LoraRepositoryItemResponse>(`/api/loras/${item.id}/publish`, { method: 'POST' });
    if (!response.ok) return show(response.message ?? '发布失败', 'error');
    show('LoRA 已发布到仓库', 'success');
    setRefreshKey(value => value + 1);
  };

  return (
    <div className="lora-page">
      <Seo title="LoRA 仓库" description="按 Anima、Krea2 等主模型系列和风格、角色等类型浏览与上传 LoRA。" path="/loras" />
      <section className="lora-toolbar">
        <label className="lora-search"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索标题或描述" /></label>
        <select value={model} onChange={event => setModel(event.target.value)}><option value="">全部主模型</option>{models.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <select value={loraType} onChange={event => setLoraType(event.target.value)}><option value="">全部 LoRA 类型</option>{LORA_REPOSITORY_TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        {user && <button type="button" className={mine ? 'is-active' : ''} onClick={() => setMine(value => !value)}><FileBox size={15} />我的上传</button>}
        {user && <button type="button" className="lora-upload-button" onClick={() => setUploadOpen(true)}><Plus size={16} />上传 LoRA</button>}
      </section>

      {loading ? <div className="lora-state"><Loader2 className="animate-spin" />正在整理模型档案</div> : items.length === 0 ? (
        <div className="lora-state"><PackageOpen size={30} /><strong>{mine ? '还没有上传记录' : '当前筛选下没有 LoRA'}</strong><span>上传模型文件和示例图后即可建立第一份档案。</span></div>
      ) : (
        <section className="lora-grid">{items.map(item => <LoraCard key={item.id} item={item} modelLabel={models.find(modelOption => modelOption.value === item.baseModel)?.label} onDelete={removeItem} onPublish={publishItem} />)}</section>
      )}

      {uploadOpen && <LoraUploadDialog models={models} onClose={() => setUploadOpen(false)} onCompleted={() => { void api<LoraBaseModelListResponse>('/api/loras/models').then(response => { if (response.ok && response.data) setModels(response.data.models); }); setUploadOpen(false); setMine(true); setRefreshKey(value => value + 1); }} />}
    </div>
  );
}

function LoraCard({ item, modelLabel, onDelete, onPublish }: { item: LoraRepositoryItemView; modelLabel?: string; onDelete: (item: LoraRepositoryItemView) => void; onPublish: (item: LoraRepositoryItemView) => void }) {
  const cover = item.exampleImages.find(image => Boolean(image.url));
  return (
    <article className="lora-card">
      <div className="lora-card-cover">{cover?.url ? <img src={cover.url} alt={`${item.title} 示例图`} loading="lazy" /> : <PackageOpen size={30} />}<span>{modelLabel ?? formatModelLabel(item.baseModel)}</span>{item.exampleImages.length > 1 && <em>+{item.exampleImages.length - 1}</em>}</div>
      <div className="lora-card-body"><div className="lora-card-head"><div><span className={`is-${item.status}`}>{item.status === 'published' ? '已发布' : '草稿'}</span><span className="lora-type-chip">{formatLoraType(item.loraType)}</span></div><small>#{String(item.id).padStart(4, '0')}</small></div><h2>{item.title}</h2><p>{item.description}</p><div className="lora-meta"><span>by {item.author.username}</span><span>{formatBytes(item.fileSizeBytes)}</span><span>{item.downloadCount} 次下载</span></div><div className="lora-card-actions">{item.status === 'published' && <a href={`${config.apiBase}/api/loras/${item.id}/download`}><Download size={14} />下载</a>}{item.owned && item.status === 'draft' && item.fileReady && item.exampleImages.length > 0 && <button type="button" onClick={() => void onPublish(item)}>发布</button>}{item.owned && <button type="button" className="is-danger" onClick={() => void onDelete(item)}><Trash2 size={14} />删除</button>}</div></div>
    </article>
  );
}

function LoraUploadDialog({ models, onClose, onCompleted }: { models: LoraBaseModelListResponse['models']; onClose: () => void; onCompleted: () => void }) {
  const { show } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [baseModel, setBaseModel] = useState('anima');
  const [customModel, setCustomModel] = useState('');
  const [loraType, setLoraType] = useState<LoraRepositoryType>('style');
  const [loraFile, setLoraFile] = useState<File | null>(null);
  const [examples, setExamples] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const previews = useMemo(() => examples.map(file => ({ file, url: URL.createObjectURL(file) })), [examples]);
  useEffect(() => () => previews.forEach(item => URL.revokeObjectURL(item.url)), [previews]);
  useEffect(() => {
    // 弹窗通过 body Portal 脱离 main 的 contain 层叠上下文，并锁定底层页面滚动。
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const addExamples = (files: FileList | null) => {
    const next = Array.from(files ?? []).filter(file => file.type.startsWith('image/'));
    setExamples(current => [...current, ...next].slice(0, MAX_EXAMPLES));
  };

  const submit = async () => {
    const resolvedBaseModel = baseModel === CUSTOM_MODEL_VALUE ? customModel.trim() : baseModel;
    if (!title.trim() || !description.trim() || !loraFile || examples.length === 0) return show('请完整填写标题、描述、LoRA 文件和示例图', 'error');
    if (!resolvedBaseModel) return show('请填写主模型系列名称', 'error');
    if (!loraFile.name.toLowerCase().endsWith('.safetensors')) return show('LoRA 文件必须是 .safetensors', 'error');
    setBusy(true); setProgress(2);
    let draftId = 0;
    try {
      const created = await api<LoraRepositoryItemResponse>('/api/loras', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), description: description.trim(), baseModel: resolvedBaseModel, loraType }) });
      if (!created.ok || !created.data) throw new Error(created.message ?? '创建 LoRA 草稿失败');
      draftId = created.data.item.id;
      await uploadFileInChunks(draftId, 'model', loraFile, value => setProgress(5 + Math.round(value * 0.65)));
      for (const [index, file] of examples.entries()) {
        await uploadFileInChunks(draftId, 'example', file, value => setProgress(72 + Math.round(((index + value / 100) / examples.length) * 22)));
      }
      const published = await api<LoraRepositoryItemResponse>(`/api/loras/${draftId}/publish`, { method: 'POST' });
      if (!published.ok) throw new Error(published.message ?? 'LoRA 发布失败');
      setProgress(100); show('LoRA 已发布', 'success'); onCompleted();
    } catch (error) {
      show(error instanceof Error ? error.message : 'LoRA 上传失败', 'error');
      if (draftId) await api(`/api/loras/${draftId}`, { method: 'DELETE' });
    } finally { setBusy(false); }
  };

  return createPortal(
    <div className="lora-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="lora-dialog" role="dialog" aria-modal="true" aria-label="上传 LoRA">
        <header>
          <div><span>NEW ARCHIVE ENTRY</span><h2>上传 LoRA</h2></div>
          <button type="button" onClick={onClose} disabled={busy}><X size={18} /></button>
        </header>
        <div className="lora-form-grid">
          <label><span>标题</span><input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder="例如：柔光赛璐璐风格" /></label>
          <label><span>LoRA 类型</span><select value={loraType} onChange={event => setLoraType(event.target.value as LoraRepositoryType)}>{LORA_REPOSITORY_TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="is-wide"><span>主模型系列</span><select value={baseModel} onChange={event => setBaseModel(event.target.value)}>{models.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}<option value={CUSTOM_MODEL_VALUE}>填写其他主模型…</option></select>{baseModel === CUSTOM_MODEL_VALUE && <input value={customModel} maxLength={48} onChange={event => setCustomModel(event.target.value)} placeholder="例如：Flux、SDXL、Illustrious" autoFocus />}</label>
          <label className="is-wide"><span>描述</span><textarea value={description} maxLength={5000} onChange={event => setDescription(event.target.value)} placeholder="说明触发词、推荐权重、适用题材和已知限制" /></label>
        </div>
        <label className={`lora-file-drop${loraFile ? ' has-file' : ''}`}><UploadCloud size={22} /><strong>{loraFile ? loraFile.name : '选择 .safetensors 文件'}</strong><small>{loraFile ? formatBytes(loraFile.size) : '最大 1GB，上传过程显示真实进度'}</small><input type="file" accept=".safetensors" onChange={event => setLoraFile(event.target.files?.[0] ?? null)} /></label>
        <div className="lora-example-section"><div><span><ImagePlus size={16} />示例图</span><label><Plus size={14} />添加图片<input type="file" accept="image/*" multiple onChange={event => addExamples(event.target.files)} /></label></div><div className="lora-example-grid">{previews.map((item, index) => <figure key={`${item.file.name}-${index}`}><img src={item.url} alt="LoRA 示例预览" /><button type="button" onClick={() => setExamples(current => current.filter((_, itemIndex) => itemIndex !== index))}><X size={12} /></button></figure>)}{examples.length === 0 && <p>至少上传 1 张，最多 {MAX_EXAMPLES} 张</p>}</div></div>
        <div className={`lora-upload-progress${busy ? ' is-visible' : ''}`} aria-hidden={!busy}><span style={{ width: `${progress}%` }} /><em>{progress}%</em></div>
        <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="is-primary" onClick={() => void submit()} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />}{busy ? '正在上传' : '上传并发布'}</button></footer>
      </section>
    </div>,
    document.body,
  );
}

/** 使用小分片上传模型和示例图，并在响应丢失时读取服务端偏移继续。 */
async function uploadFileInChunks(loraId: number, kind: LoraUploadKind, file: File, onProgress: (value: number) => void): Promise<void> {
  const created = await api<LoraUploadSessionResponse>(`/api/loras/${loraId}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, fileName: file.name, sizeBytes: file.size }),
  });
  if (!created.ok || !created.data) throw new Error(created.message ?? '创建上传会话失败');
  const session = created.data;
  let offset = session.receivedBytes;
  try {
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(file.size, offset + session.chunkSizeBytes));
      const expectedOffset = offset + chunk.size;
      try {
        const response = await uploadChunk(loraId, session.uploadId, offset, chunk);
        offset = response.receivedBytes;
      } catch (error) {
        // 分片可能已成功写入但响应在网络中丢失，先读取服务端真实偏移再决定是否重试。
        const status = await api<LoraUploadSessionResponse>(`/api/loras/${loraId}/uploads/${session.uploadId}`);
        if (!status.ok || !status.data) throw error;
        if (status.data.receivedBytes !== offset && status.data.receivedBytes !== expectedOffset) throw new Error('上传偏移异常，请重新上传');
        if (status.data.receivedBytes === offset) {
          const retry = await uploadChunk(loraId, session.uploadId, offset, chunk);
          offset = retry.receivedBytes;
        } else {
          offset = status.data.receivedBytes;
        }
      }
      onProgress(Math.round((offset / file.size) * 100));
    }
    const completed = await api<LoraRepositoryItemResponse>(`/api/loras/${loraId}/uploads/${session.uploadId}/complete`, { method: 'POST' });
    if (!completed.ok) throw new Error(completed.message ?? '完成文件上传失败');
  } catch (error) {
    await api(`/api/loras/${loraId}/uploads/${session.uploadId}`, { method: 'DELETE' });
    throw error;
  }
}

/** 上传单个二进制分片并返回服务端持久化偏移。 */
function uploadChunk(loraId: number, uploadId: string, offset: number, chunk: Blob): Promise<LoraUploadChunkResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${config.apiBase}/api/loras/${loraId}/uploads/${uploadId}`);
    const token = localStorage.getItem('token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-aiimage-upload-offset', String(offset));
    xhr.onerror = () => reject(new Error('上传连接中断'));
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { ok?: boolean; data?: LoraUploadChunkResponse; message?: string };
        if (xhr.status >= 200 && xhr.status < 300 && body.ok && body.data) resolve(body.data);
        else reject(new Error(body.message || `上传失败 HTTP ${xhr.status}`));
      } catch {
        reject(new Error(`上传失败 HTTP ${xhr.status}`));
      }
    };
    xhr.send(chunk);
  });
}

function formatBytes(value?: number): string { if (!value) return '文件待上传'; if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)}GB`; if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)}MB`; return `${Math.round(value / 1024)}KB`; }

/** 返回 LoRA 类型的中文外显。 */
function formatLoraType(value: LoraRepositoryType): string {
  return LORA_REPOSITORY_TYPE_OPTIONS.find(option => option.value === value)?.label ?? '其他';
}

/** 返回主模型系列的统一外显。 */
function formatModelLabel(value: string): string {
  if (value === 'anima') return 'Anima';
  if (value === 'krea2') return 'Krea 2';
  return value;
}
