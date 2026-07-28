/**
 * 本文件实现底模仓库的浏览、详情、示例图管理和管理员真实 GPU 模型登记界面。
 */
import type { InferenceModelView, LocalPlatformSessionView, ModelLibraryCreateRequest, ModelLibraryEntryView, ModelLibraryUpdateRequest } from "@drawhime/contracts";
import { ArrowLeft, Check, ChevronRight, CircleDollarSign, Cpu, ExternalLink, FileImage, FilePlus2, Gauge, ImageIcon, Images, LoaderCircle, Pencil, Plus, Search, Settings2, SlidersHorizontal, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const apiBase = import.meta.env.VITE_LOCAL_API_BASE || "/local-model-api";
const defaultModelCoverUrl = `${import.meta.env.BASE_URL}model-default-cover.svg`;

interface ModelLibraryPageProps {
  session: LocalPlatformSessionView | null;
  entries: ModelLibraryEntryView[];
  models: InferenceModelView[];
  onChanged: () => Promise<void>;
  onUseModel: (modelVersionId: string) => void;
}

/** 底模图库与详情子页入口。 */
export function ModelLibraryPage({ session, entries, models, onChanged, onUseModel }: ModelLibraryPageProps) {
  const [detailId, setDetailId] = useState(readDetailId);
  const [detail, setDetail] = useState<ModelLibraryEntryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [family, setFamily] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [message, setMessage] = useState("");
  const families = useMemo(() => [...new Set(entries.map((entry) => entry.familyName))].sort(), [entries]);
  const filtered = useMemo(() => {
    const search = keyword.trim().toLowerCase();
    return entries.filter((entry) => (family === "all" || entry.familyName === family)
      && (!search || `${entry.displayName} ${entry.description} ${entry.modelFileName}`.toLowerCase().includes(search)));
  }, [entries, family, keyword]);
  const isAdmin = entries.some((entry) => entry.isAdmin);

  useEffect(() => {
    const restoreDetail = () => setDetailId(readDetailId());
    window.addEventListener("popstate", restoreDetail);
    return () => window.removeEventListener("popstate", restoreDetail);
  }, []);
  useEffect(() => {
    if (!detailId || !session) { setDetail(null); return; }
    setLoading(true);
    setMessage("");
    void modelJson<ModelLibraryEntryView>(`/v1/model-library/${detailId}`, session.sessionToken)
      .then(setDetail)
      .catch((error) => setMessage(errorMessage(error)))
      .finally(() => setLoading(false));
  }, [detailId, session]);

  /** 打开详情时保留模型仓库标签并支持浏览器前进后退。 */
  const openDetail = (id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "models");
    url.searchParams.set("model", id);
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setDetailId(id);
  };
  /** 返回列表仅清理当前模型详情参数。 */
  const closeDetail = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("model");
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setDetailId("");
    setDetail(null);
    setMessage("");
  };

  if (detailId) {
    return <ModelDetailPage session={session} entry={detail} loading={loading} message={message} onBack={closeDetail} onUseModel={onUseModel} onChanged={async (entry, notice) => { setDetail(entry); setMessage(notice); await onChanged(); }} />;
  }
  return <div className="model-library-page">
    <header className="model-library-toolbar card">
      <div className="model-library-search"><Search size={15} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索模型名称、简介或 GPU 文件名" />{keyword && <button onClick={() => setKeyword("")} aria-label="清除搜索"><X size={13} /></button>}</div>
      <label className="model-library-family"><SlidersHorizontal size={14} /><select value={family} onChange={(event) => setFamily(event.target.value)}><option value="all">全部模型系列</option>{families.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <span className="model-library-count">{filtered.length} 个可用模型</span>
      {isAdmin && <button className="model-library-add" onClick={() => setCreateOpen(true)}><Plus size={16} />添加模型</button>}
    </header>
    {filtered.length ? <section className="model-library-grid">{filtered.map((entry) => <ModelGalleryCard key={entry.id} entry={entry} token={session?.sessionToken || ""} onOpen={() => openDetail(entry.id)} />)}</section> : <section className="card model-library-empty"><Cpu size={38} /><h2>没有匹配的底模</h2><p>调整筛选条件，或由管理员登记已安装到 GPU 的模型。</p></section>}
    {createOpen && <ModelCreateDialog token={session?.sessionToken || ""} onClose={() => setCreateOpen(false)} onCreated={async (entry) => { await onChanged(); setCreateOpen(false); openDetail(entry.id); }} />}
  </div>;
}

/** 单个底模的图库卡片，第一张示例图作为封面。 */
function ModelGalleryCard({ entry, token, onOpen }: { entry: ModelLibraryEntryView; token: string; onOpen: () => void }) {
  return <button className="model-gallery-card" onClick={onOpen}>
    <div className="model-gallery-cover"><ModelExampleImage example={entry.examples[0]} token={token} alt={entry.displayName} /><span>{entry.familyName}</span></div>
    <div className="model-gallery-info"><h2>{entry.displayName}</h2><p>{entry.description}</p><footer><small><Cpu size={12} />{entry.runtimeFormat}</small><small>{entry.examples.length ? `${entry.examples.length} 张示例` : "默认封面"}</small><ChevronRight size={15} /></footer></div>
  </button>;
}

/** 底模详情页包含使用说明、模型参数、示例与管理员维护操作。 */
function ModelDetailPage({ session, entry, loading, message, onBack, onUseModel, onChanged }: { session: LocalPlatformSessionView | null; entry: ModelLibraryEntryView | null; loading: boolean; message: string; onBack: () => void; onUseModel: (modelVersionId: string) => void; onChanged: (entry: ModelLibraryEntryView, notice: string) => Promise<void> }) {
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (loading || !entry) return <div className="loading-page"><LoaderCircle className="spin" />正在读取模型详情</div>;
  const cover = entry.examples[0];
  /** 管理员上传示例，服务端会转成 WebP 并限制实际数量。 */
  const uploadExamples = async (files: File[]) => {
    if (!session || !files.length) return;
    setBusy(true);
    try {
      let updated = entry;
      for (const file of files.slice(0, Math.max(0, 8 - entry.examples.length))) {
        updated = await modelBinary<ModelLibraryEntryView>(`/v1/admin/model-library/${entry.id}/examples`, session.sessionToken, file, "POST");
      }
      await onChanged(updated, "示例图片已保存");
    } catch (error) {
      await onChanged(entry, errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  /** 管理员删除示例时只移除仓库预览，不影响模型、历史任务或已发布图库。 */
  const removeExample = async (exampleId: string) => {
    if (!session || !window.confirm("删除这张模型示例图？不会影响底模、历史任务或图库作品。")) return;
    setBusy(true);
    try {
      const updated = await modelJson<ModelLibraryEntryView>(`/v1/admin/model-library/${entry.id}/examples/${exampleId}`, session.sessionToken, { method: "DELETE" });
      await onChanged(updated, "示例图片已删除");
    } catch (error) {
      await onChanged(entry, errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return <div className="model-detail-page">
    <header className="card model-detail-toolbar"><button onClick={onBack}><ArrowLeft size={16} />返回模型仓库</button><div><span>{entry.familyName} · {entry.runtimeFormat}</span><strong>{entry.displayName}</strong></div><nav><button className="model-use-button" onClick={() => onUseModel(entry.id)}><Sparkles size={15} />使用此模型</button>{entry.isAdmin && <button className="model-edit-button" onClick={() => setEditOpen(true)}><Pencil size={14} />编辑</button>}</nav></header>
    {message && <div className={`notice compact ${message.includes("失败") || message.includes("错误") ? "error" : "success"}`}>{message}</div>}
    <section className="card model-detail-hero">
      <div className="model-detail-cover"><ModelExampleImage example={cover} token={session?.sessionToken || ""} alt={entry.displayName} eager /></div>
      <div className="model-detail-summary"><div className="model-detail-badges"><span>{entry.familyName}</span>{entry.sourceLinks.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><ExternalLink size={11} />{source.label}</a>)}{!entry.visible && <span className="hidden">仅管理员可见</span>}<span>¥{entry.priceCny} / 张</span></div><h1>{entry.displayName}</h1><p>{entry.description}</p><dl><div><dt><Cpu />GPU 文件</dt><dd>{entry.modelFileName}</dd></div><div><dt><Gauge />推荐采样</dt><dd>{entry.parameters.steps} 步 · CFG {entry.parameters.cfg}</dd></div><div><dt><Settings2 />采样器</dt><dd>{entry.parameters.sampler} · {entry.parameters.scheduler}</dd></div><div><dt><ImageIcon />采样最长边</dt><dd>{entry.parameters.samplingMaxEdge}px / 输出 {entry.parameters.maxEdge}px</dd></div></dl></div>
    </section>
    <section className="card model-example-section"><header><div><span>视觉样本</span><h2>示例图片 <b>{entry.examples.length}</b></h2></div>{entry.isAdmin && <label className="model-inline-upload"><Upload size={14} />上传示例<input type="file" accept="image/*" multiple disabled={busy || entry.examples.length >= 8} onChange={(event) => void uploadExamples(Array.from(event.target.files || []))} /></label>}</header>{entry.examples.length ? <div className="model-example-grid">{entry.examples.map((example) => <div key={example.id}><ModelExampleImage example={example} token={session?.sessionToken || ""} alt={`${entry.displayName} 示例图`} />{example.prompt && <p>{example.prompt}</p>}{entry.isAdmin && <button onClick={() => void removeExample(example.id)} disabled={busy} aria-label="删除示例"><Trash2 size={14} /></button>}</div>)}</div> : <div className="model-example-empty"><FileImage size={28} /><span>暂无示例图，当前使用统一默认封面。</span></div>}</section>
    <section className="card model-reference-section"><header><div><span>公开引用</span><h2>使用示例 <b>{entry.referenceTasks.length}</b></h2></div><small>仅展示使用该底模、已发布到主站图库的公开任务</small></header>{entry.referenceTasks.length ? <div className="model-reference-grid">{entry.referenceTasks.map((task) => <a key={task.id} href={`/image/${task.galleryItemId}`}><img src={task.imageUrl} alt="模型公开使用示例" loading="lazy" /><strong>{task.prompt}</strong><footer><small>{new Date(task.createdAt).toLocaleDateString("zh-CN")}</small><ExternalLink size={13} /></footer></a>)}</div> : <div className="model-example-empty"><Images size={28} /><span>暂时没有已公开的使用示例。</span></div>}</section>
    {editOpen && <ModelEditDialog token={session?.sessionToken || ""} entry={entry} onClose={() => setEditOpen(false)} onSaved={async (updated) => { setEditOpen(false); await onChanged(updated, "模型信息已保存"); }} />}
  </div>;
}

/** 管理员创建模型时明确要求填写 GPU 已安装文件的真实元数据。 */
function ModelCreateDialog({ token, onClose, onCreated }: { token: string; onClose: () => void; onCreated: (entry: ModelLibraryEntryView) => Promise<void> }) {
  const [form, setForm] = useState<ModelLibraryCreateRequest>({ displayName: "", description: "", familyName: "Anima", modelFileName: "", modelSha256: "", modelByteSize: 0, sourceUrls: [], usageGuide: "在本地绘图页面选择该模型后，使用清晰的主体、场景、构图与画风描述生成。", steps: 24, cfg: 4, sampler: "er_sde", scheduler: "simple", samplingMaxEdge: 1152, qualityPrefix: "masterpiece, best quality, score_7", defaultNegativePrompt: "worst quality, low quality, score_1, score_2, score_3, artist name", productCode: "local.", pricingVersion: 1, priceCny: "0.05", visible: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 更新单个真实配置字段，数值字段在提交前由契约进行最终校验。 */
  const setValue = <Key extends keyof ModelLibraryCreateRequest>(key: Key, value: ModelLibraryCreateRequest[Key]) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const entry = await modelJson<ModelLibraryEntryView>("/v1/admin/model-library", token, { method: "POST", body: JSON.stringify(form) });
      await onCreated(entry);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };
  return <div className="modal-backdrop model-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="task-dialog model-dialog" role="dialog" aria-modal="true" aria-label="添加底模"><header><div><span>MODEL REGISTRY</span><h2>登记 GPU 底模</h2><p>仅填写已安装到私有 GPU `diffusion_models` 目录的真实 `.safetensors` 文件；当前只支持 Anima 格式。</p></div><button onClick={onClose} disabled={busy} aria-label="关闭"><X /></button></header><div className="model-dialog-body"><ModelFields form={form} onChange={setValue} /><section className="model-dialog-notice"><CircleDollarSign size={16} /><span>保存时将同步发布主站模型级价格；价格发布失败不会留下可选模型。</span></section>{error && <div className="notice error compact">{error}</div>}</div><footer><button onClick={onClose} disabled={busy}>取消</button><button className="model-save-button" onClick={() => void submit()} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <FilePlus2 />}{busy ? "正在登记" : "登记模型"}</button></footer></section></div>;
}

/** 管理员只编辑外显与说明，模型文件、采样和价格均在首次登记时固化。 */
function ModelEditDialog({ token, entry, onClose, onSaved }: { token: string; entry: ModelLibraryEntryView; onClose: () => void; onSaved: (entry: ModelLibraryEntryView) => Promise<void> }) {
  const [form, setForm] = useState<ModelLibraryUpdateRequest>({ displayName: entry.displayName, description: entry.description, sourceUrls: entry.sourceLinks.map((source) => source.url), usageGuide: entry.usageGuide, visible: entry.visible });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 保存展示信息不会改写模型文件、工作流、价格或历史任务。 */
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const updated = await modelJson<ModelLibraryEntryView>(`/v1/admin/model-library/${entry.id}`, token, { method: "PATCH", body: JSON.stringify(form) });
      await onSaved(updated);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };
  return <div className="modal-backdrop model-dialog-backdrop">
    <section className="task-dialog model-dialog model-edit-dialog" role="dialog" aria-modal="true" aria-label="编辑底模">
      <header><div><span>MODEL EDITOR</span><h2>编辑模型展示信息</h2></div><button onClick={onClose} disabled={busy} aria-label="关闭"><X /></button></header>
      <div className="model-dialog-body">
        <label className="field"><span>模型名称</span><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
        <label className="field"><span>模型简介</span><textarea rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <SourceUrlsField value={form.sourceUrls} onChange={(sourceUrls) => setForm({ ...form, sourceUrls })} />
        <label className="field"><span>使用说明</span><textarea rows={5} value={form.usageGuide} onChange={(event) => setForm({ ...form, usageGuide: event.target.value })} /></label>
        <label className="model-visible-switch"><span><strong>在模型仓库公开展示</strong><small>关闭后仅管理员可浏览，不会影响历史任务。</small></span><button type="button" className={form.visible ? "switch on" : "switch"} onClick={() => setForm({ ...form, visible: !form.visible })}><i /></button></label>
        {error && <div className="notice error compact">{error}</div>}
      </div>
      <footer><button onClick={onClose} disabled={busy}>取消</button><button className="model-save-button" onClick={() => void save()} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <><Check />保存</>}</button></footer>
    </section>
  </div>;
}

/** 复用添加表单的真实模型、采样与价格字段。 */
function ModelFields({ form, onChange }: { form: ModelLibraryCreateRequest; onChange: <Key extends keyof ModelLibraryCreateRequest>(key: Key, value: ModelLibraryCreateRequest[Key]) => void }) {
  return <><section className="model-form-section"><header><Cpu size={16} /><div><strong>模型信息</strong><small>名称和 GPU 文件名会进入任务审计。</small></div></header><div className="model-form-grid"><label className="field"><span>展示名称</span><input value={form.displayName} onChange={(event) => onChange("displayName", event.target.value)} /></label><label className="field"><span>主模型系列</span><input value={form.familyName} onChange={(event) => onChange("familyName", event.target.value)} /></label><label className="field model-form-wide"><span>简介</span><textarea rows={3} value={form.description} onChange={(event) => onChange("description", event.target.value)} /></label><label className="field"><span>GPU 文件名</span><input value={form.modelFileName} onChange={(event) => onChange("modelFileName", event.target.value)} placeholder="example_anima.safetensors" /></label><label className="field"><span>SHA-256</span><input value={form.modelSha256} onChange={(event) => onChange("modelSha256", event.target.value)} placeholder="64 位十六进制" /></label><label className="field"><span>文件字节数</span><input type="number" min="1" value={form.modelByteSize || ""} onChange={(event) => onChange("modelByteSize", Number(event.target.value))} /></label><SourceUrlsField value={form.sourceUrls} onChange={(sourceUrls) => onChange("sourceUrls", sourceUrls)} /></div></section><section className="model-form-section"><header><Settings2 size={16} /><div><strong>Anima 采样格式</strong><small>工作流按此配置固定，不能套用其他格式参数。</small></div></header><div className="model-form-grid"><label className="field"><span>步数</span><input type="number" min="1" max="50" value={form.steps} onChange={(event) => onChange("steps", Number(event.target.value))} /></label><label className="field"><span>CFG</span><input type="number" min="0.1" max="20" step="0.1" value={form.cfg} onChange={(event) => onChange("cfg", Number(event.target.value))} /></label><label className="field"><span>采样器</span><select value={form.sampler} onChange={(event) => onChange("sampler", event.target.value as ModelLibraryCreateRequest["sampler"])}><option value="er_sde">er_sde</option><option value="euler">euler</option><option value="euler_ancestral">euler_ancestral</option></select></label><label className="field"><span>调度器</span><select value={form.scheduler} onChange={(event) => onChange("scheduler", event.target.value as ModelLibraryCreateRequest["scheduler"])}><option value="simple">simple</option><option value="normal">normal</option></select></label><label className="field"><span>采样最长边</span><input type="number" min="512" max="1536" value={form.samplingMaxEdge} onChange={(event) => onChange("samplingMaxEdge", Number(event.target.value))} /></label><label className="field"><span>模型价格</span><input value={form.priceCny} onChange={(event) => onChange("priceCny", event.target.value)} placeholder="0.05" /></label><label className="field"><span>主站产品码</span><input value={form.productCode} onChange={(event) => onChange("productCode", event.target.value)} /></label><label className="field"><span>价格版本</span><input type="number" min="1" value={form.pricingVersion} onChange={(event) => onChange("pricingVersion", Number(event.target.value))} /></label><label className="field model-form-wide"><span>质量前缀</span><input value={form.qualityPrefix} onChange={(event) => onChange("qualityPrefix", event.target.value)} /></label><label className="field model-form-wide"><span>默认负面提示词</span><textarea rows={2} value={form.defaultNegativePrompt} onChange={(event) => onChange("defaultNegativePrompt", event.target.value)} /></label></div></section><label className="field"><span>使用说明</span><textarea rows={4} value={form.usageGuide} onChange={(event) => onChange("usageGuide", event.target.value)} /></label><label className="model-visible-switch"><span><strong>公开展示</strong><small>关闭后模型保留可用性，但只在管理员仓库中显示。</small></span><button type="button" className={form.visible ? "switch on" : "switch"} onClick={() => onChange("visible", !form.visible)}><i /></button></label></>;
}

/** 保留管理员输入中的换行，同时向表单同步经过规范化的真实来源链接。 */
function SourceUrlsField({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [text, setText] = useState(() => value.join("\n"));
  return <label className="field"><span>来源链接 <small>每行一个，最多 8 个</small></span><textarea rows={3} value={text} onChange={(event) => { setText(event.target.value); onChange(parseSourceUrls(event.target.value)); }} /></label>;
}

/** 将管理员逐行输入的来源链接去空、去重并限制为契约允许的数量。 */
function parseSourceUrls(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].slice(0, 8);
}

/** 按需鉴权读取底模示例图，失败时显示统一默认封面。 */
function ModelExampleImage({ example, token, alt, eager = false }: { example?: ModelLibraryEntryView["examples"][number]; token: string; alt: string; eager?: boolean }) {
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!example || !token) return; let objectUrl = ""; setFailed(false); void fetch(`${apiBase}/v1/model-library/examples/${example.id}/content`, { headers: { authorization: `Bearer ${token}` } }).then(async (response) => { if (!response.ok) throw new Error("模型示例读取失败"); objectUrl = URL.createObjectURL(await response.blob()); setSource(objectUrl); }).catch(() => setFailed(true)); return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [example?.id, token]);
  if (!example || failed) return <div className="model-default-cover"><img src={defaultModelCoverUrl} alt="模型默认封面" /></div>;
  return <div className="model-example-image">{source ? <img src={source} alt={alt} loading={eager ? "eager" : "lazy"} onError={() => setFailed(true)} /> : <LoaderCircle className="spin" />}</div>;
}

/** 从地址栏读取当前模型详情 ID。 */
function readDetailId(): string { return new URLSearchParams(window.location.search).get("model") || ""; }

/** 调用统一 JSON API 并只接受标准成功响应。 */
async function modelJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers || {}) }, cache: "no-store" });
  const payload = await response.json() as { ok?: boolean; data?: T; message?: string };
  if (!response.ok || payload.ok !== true || payload.data === undefined) throw new Error(payload.message || `请求失败：HTTP ${response.status}`);
  return payload.data;
}

/** 上传示例图片二进制，服务端负责安全转码与对象存储。 */
async function modelBinary<T>(path: string, token: string, body: Blob, method: "POST"): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": body.type || "application/octet-stream" }, body });
  const payload = await response.json() as { ok?: boolean; data?: T; message?: string };
  if (!response.ok || payload.ok !== true || payload.data === undefined) throw new Error(payload.message || `上传失败：HTTP ${response.status}`);
  return payload.data;
}

/** 将未知异常转换为简短的用户可读提示。 */
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "模型仓库操作失败"; }
