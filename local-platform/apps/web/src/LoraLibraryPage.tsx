/**
 * 本文件实现图库式 LoRA 仓库、弹窗创建、详情子页面、作者编辑与公开/私有外显控制。
 */
import type { LocalPlatformSessionView, LoraLibraryEntryView, LoraUploadSessionView } from "@drawhime/contracts";
import { ArrowLeft, CalendarDays, Check, ChevronRight, Copy, Download, ExternalLink, FileUp, Grid2X2, HardDrive, ImageIcon, Images, Layers3, LoaderCircle, Lock, Pencil, Plus, RotateCcw, Search, SlidersHorizontal, Sparkles, Tag, Trash2, Unlock, UploadCloud, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

const apiBase = import.meta.env.VITE_LOCAL_API_BASE || "/local-model-api";
const defaultLoraCoverUrl = `${import.meta.env.BASE_URL}lora-default-cover.svg`;
const loraTypes = [["style", "风格"], ["character", "角色"], ["concept", "概念"], ["clothing", "服装"], ["pose", "姿势"], ["other", "其他"]] as const;

interface LoraLibraryPageProps {
  session: LocalPlatformSessionView | null;
  entries: LoraLibraryEntryView[];
  modelFamilies: string[];
  onChanged: () => Promise<void>;
  onUseLora: (versionId: string) => void;
}

/** LoRA 图库与详情页面入口。 */
export function LoraLibraryPage({ session, entries, modelFamilies, onChanged, onUseLora }: LoraLibraryPageProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState(readDetailId);
  const [detail, setDetail] = useState<LoraLibraryEntryView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [type, setType] = useState("all");
  const [family, setFamily] = useState("all");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const families = useMemo(() => [...new Set([...modelFamilies, ...entries.map((entry) => entry.modelFamilyName)])].sort(), [entries, modelFamilies]);
  const scopeEntries = useMemo(() => scope === "mine" ? entries.filter((entry) => entry.isOwner) : entries, [entries, scope]);
  const filtered = useMemo(() => entries.filter((entry) => {
    const keyword = search.trim().toLowerCase();
    return (scope === "all" || entry.isOwner)
      && (type === "all" || entry.type === type)
      && (family === "all" || entry.modelFamilyName === family)
      && (!keyword || `${entry.title} ${entry.description} ${entry.ownerDisplayName} ${entry.triggerWords.join(" ")}`.toLowerCase().includes(keyword));
  }), [entries, family, scope, search, type]);
  const typeCounts = useMemo(() => Object.fromEntries(loraTypes.map(([value]) => [value, scopeEntries.filter((entry) => entry.type === value).length])), [scopeEntries]);
  const hasActiveFilters = scope !== "all" || type !== "all" || family !== "all" || search.trim().length > 0;
  const activeFilterCount = Number(scope !== "all") + Number(type !== "all") + Number(family !== "all") + Number(search.trim().length > 0);
  /** 一次性恢复仓库默认浏览状态，供筛选栏、结果栏和空状态复用。 */
  const resetFilters = () => { setScope("all"); setType("all"); setFamily("all"); setSearch(""); };

  useEffect(() => {
    const restoreDetail = () => setDetailId(readDetailId());
    window.addEventListener("popstate", restoreDetail);
    return () => window.removeEventListener("popstate", restoreDetail);
  }, []);
  useEffect(() => {
    if (!detailId || !session) { setDetail(null); return; }
    setDetailLoading(true); setMessage("");
    void loraJson<LoraLibraryEntryView>(`/v1/lora-library/${detailId}`, session.sessionToken)
      .then(setDetail)
      .catch((error) => setMessage(errorMessage(error)))
      .finally(() => setDetailLoading(false));
  }, [detailId, session]);

  /** 打开带可前进后退恢复的详情子页面。 */
  const openDetail = (id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "loras"); url.searchParams.set("lora", id);
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setDetailId(id);
  };
  /** 返回仓库时只移除详情参数，保留当前业务标签。 */
  const closeDetail = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("lora");
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setDetailId(""); setDetail(null); setMessage("");
  };

  if (detailId) return <LoraDetailPage session={session} entry={detail} loading={detailLoading} message={message} families={families} onBack={closeDetail} onChanged={async (updated, notice) => { setDetail(updated); setMessage(notice); await onChanged(); }} onDeleted={async () => { await onChanged(); closeDetail(); }} onUseLora={onUseLora} />;

  return <div className="lora-gallery-page lora-catalog">
    <aside className="card lora-catalog-sidebar">
      <header className="lora-filter-heading"><div><SlidersHorizontal size={15} /><span><strong>筛选 LoRA</strong><small>{hasActiveFilters ? `${activeFilterCount} 项条件生效` : "快速定位模型资产"}</small></span></div>{hasActiveFilters && <button type="button" onClick={resetFilters}><RotateCcw size={12} />重置</button>}</header>
      <button className="lora-add-button" onClick={() => setCreateOpen(true)}><Plus size={16} /><span>添加 LoRA</span></button>
      <label className={`lora-search${search ? " active" : ""}`}><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、作者或触发词" />{search && <button type="button" onClick={() => setSearch("")} aria-label="清除搜索"><X size={13} /></button>}</label>
      <section className="lora-catalog-filter lora-scope-filter"><header><Grid2X2 size={14} /><span>浏览范围</span></header><div className="lora-filter-tabs"><button type="button" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")} aria-pressed={scope === "all"}><span>全部可见</span><b>{entries.length}</b></button><button type="button" className={scope === "mine" ? "active" : ""} onClick={() => setScope("mine")} aria-pressed={scope === "mine"}><span>我的</span><b>{entries.filter((entry) => entry.isOwner).length}</b></button></div></section>
      <section className="lora-catalog-filter lora-content-filter"><header><Tag size={14} /><span>内容类型</span></header><div className="lora-type-filter"><button type="button" className={type === "all" ? "active" : ""} onClick={() => setType("all")} aria-pressed={type === "all"}><span><i className="lora-filter-dot all" />全部类型</span><b>{scopeEntries.length}</b></button>{loraTypes.map(([value, label]) => <button type="button" key={value} className={`lora-type-${value}${type === value ? " active" : ""}`} onClick={() => setType(value)} aria-pressed={type === value}><span><i className="lora-filter-dot" />{label}</span><b>{typeCounts[value] || 0}</b></button>)}</div></section>
      <label className="lora-family-filter"><span><SlidersHorizontal size={14} />主模型系列</span><select value={family} onChange={(event) => setFamily(event.target.value)}><option value="all">全部主模型</option>{families.map((item) => <option key={item}>{item}</option>)}</select></label>
    </aside>
    <main className="lora-catalog-main">
      <header className="lora-catalog-toolbar"><div><strong>{filtered.length}</strong><span>个可用 LoRA</span><small>{hasActiveFilters ? `已应用 ${activeFilterCount} 项筛选` : "按最近更新浏览"}</small></div></header>
      {filtered.length === 0 ? <section className="card empty-history lora-gallery-empty"><Layers3 size={36} /><h2>没有匹配的 LoRA</h2><p>调整筛选条件，或添加新的模型资产。</p>{hasActiveFilters && <button onClick={resetFilters}>查看全部</button>}</section> : <section className="lora-gallery-grid">{filtered.map((entry) => <LoraGalleryCard key={entry.id} entry={entry} token={session?.sessionToken || ""} onOpen={() => openDetail(entry.id)} />)}</section>}
    </main>
    {createOpen && <LoraCreateDialog session={session} entries={entries} families={families} onClose={() => setCreateOpen(false)} onCompleted={async () => { await onChanged(); setCreateOpen(false); }} />}
  </div>;
}

/** 弹窗内创建统一可用的 LoRA 条目并上传模型文件与示例图。 */
function LoraCreateDialog({ session, entries, families, onClose, onCompleted }: { session: LocalPlatformSessionView | null; entries: LoraLibraryEntryView[]; families: string[]; onClose: () => void; onCompleted: () => Promise<void> }) {
  const [title, setTitle] = useState(""); const [description, setDescription] = useState("");
  const [type, setType] = useState<LoraLibraryEntryView["type"]>("style"); const [family, setFamily] = useState(families[0] || "anima");
  const [triggerWords, setTriggerWords] = useState(""); const [isPrivate, setPrivate] = useState(false);
  const [modelFile, setModelFile] = useState<File | null>(null); const [examples, setExamples] = useState<File[]>([]);
  const [createdEntry, setCreatedEntry] = useState<LoraLibraryEntryView | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const allFamilies = [...new Set([...families, ...entries.map((entry) => entry.modelFamilyName)])];
  const informationReady = Boolean(title.trim() && description.trim() && family.trim());
  const formReady = informationReady && Boolean(modelFile) && examples.length > 0;
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [busy, onClose]);
  const submit = async () => {
    if (!session) return setMessage("请先登录主站");
    if (!title.trim() || !description.trim() || !family.trim()) return setMessage("请完整填写标题、描述和主模型系列");
    if (!modelFile || examples.length === 0) return setMessage("请选择 safetensors 模型文件和至少一张封面图片");
    setBusy(true);
    try {
      const metadata = { title: title.trim(), description: description.trim(), type, modelFamily: family.trim(), triggerWords: splitTriggerWords(triggerWords), isPrivate };
      setMessage(createdEntry ? "正在恢复 LoRA 上传" : "正在创建 LoRA");
      // 上传失败后复用已创建条目并同步最新表单，避免每次重试产生新的空 LoRA 和上传会话。
      const entry = createdEntry
        ? await loraJson<LoraLibraryEntryView>(`/v1/lora-library/${createdEntry.id}`, session.sessionToken, { method: "PATCH", body: JSON.stringify(metadata) })
        : await loraJson<LoraLibraryEntryView>("/v1/lora-library", session.sessionToken, { method: "POST", body: JSON.stringify(metadata) });
      setCreatedEntry(entry);
      setMessage("正在上传并校验模型文件");
      await uploadLoraFileChunked(entry.id, modelFile, session.sessionToken, (received, total) => setMessage(`正在上传模型文件 ${Math.round(received / total * 100)}%`));
      await uploadExamples(entry.id, examples, session.sessionToken, (current, total) => setMessage(`正在处理示例图 ${current}/${total}`));
      await onCompleted();
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop lora-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="task-dialog lora-create-dialog" role="dialog" aria-modal="true" aria-label="添加 LoRA">
    <header><div className="lora-create-title"><span>ADD LORA</span><h2>添加 LoRA</h2><p>填写模型信息并上传真实文件，完成后直接进入仓库。</p></div><button onClick={onClose} disabled={busy} aria-label="关闭"><X /></button></header>
    <div className="lora-create-body">
      <section className="lora-form-section"><header><i>1</i><div><strong>基础信息</strong><small>用于仓库检索、筛选和兼容模型判断</small></div></header><div className="lora-form-grid"><label className="field"><span>标题 <b>必填</b></span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={191} placeholder="简洁描述这个 LoRA" /><small className="field-counter">{title.length}/191</small></label><label className="field"><span>主模型系列 <b>必填</b></span><div className="lora-family-control"><select aria-label="选择已有主模型系列" value={allFamilies.includes(family) ? family : ""} onChange={(event) => { if (event.target.value) setFamily(event.target.value); }}><option value="">选择已有系列</option>{allFamilies.map((item) => <option key={item} value={item}>{item}</option>)}</select><input value={family} onChange={(event) => setFamily(event.target.value)} maxLength={80} placeholder="也可输入新系列" /></div><small>从已有系列选择，或直接填写并登记新系列</small></label></div><div className="lora-type-field"><span>LoRA 类型</span><div className="lora-type-options">{loraTypes.map(([value, label]) => <button type="button" key={value} className={type === value ? "active" : ""} onClick={() => setType(value)}><strong>{label}</strong><small>{typeHint(value)}</small></button>)}</div></div></section>
      <section className="lora-form-section"><header><i>2</i><div><strong>描述与触发</strong><small>帮助其他用户理解适用画面和正确调用方式</small></div></header><label className="field"><span>详细描述 <b>必填</b></span><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={10000} placeholder="说明效果、推荐强度、适用题材和注意事项" /><small className="field-counter">{description.length}/10000</small></label><label className="field"><span>触发词 <small>可选，逗号分隔</small></span><input value={triggerWords} onChange={(event) => setTriggerWords(event.target.value)} placeholder="例如 character_name, costume_tag" /><small>最多 32 个，保存时自动去重</small></label></section>
      <section className="lora-form-section"><header><i>3</i><div><strong>外显与文件</strong><small>隐私决定谁能查看和使用，文件进入独立对象存储</small></div></header><PrivacyControl value={isPrivate} onChange={setPrivate} /><div className="upload-grid lora-create-upload-grid"><label className={`file-drop${modelFile ? " selected" : ""}`}>{modelFile ? <Check size={22} /> : <FileUp size={22} />}<strong>{modelFile?.name || "选择 .safetensors 文件"}</strong><small>{modelFile ? formatFileSize(modelFile.size) : "最大 512MB，服务端校验文件头与 SHA-256"}</small><input type="file" accept=".safetensors" onChange={(event) => setModelFile(event.target.files?.[0] || null)} /></label><label className={`file-drop${examples.length ? " selected" : ""}`}>{examples.length ? <Check size={22} /> : <ImageIcon size={22} />}<strong>{examples.length ? `${examples.length} 张图片已选择` : "选择封面与示例图"}</strong><small>{examples.length ? "第一张作为封面，可重新选择 1–8 张" : "封面必填，统一保存为高质量 WebP"}</small><input type="file" accept="image/*" multiple onChange={(event) => setExamples(Array.from(event.target.files || []).slice(0, 8))} /></label></div><div className="lora-form-readiness"><span className={informationReady ? "done" : ""}>{informationReady ? <Check /> : <i />}信息完整</span><span className={modelFile ? "done" : ""}>{modelFile ? <Check /> : <i />}模型文件</span><span className={examples.length ? "done" : ""}>{examples.length ? <Check /> : <i />}封面图片</span></div></section>
      {message && <div className={`notice compact ${message.includes("失败") || message.includes("请") ? "error" : ""}`}>{message}</div>}
    </div>
    <footer><span className="lora-footer-hint">{formReady ? "资料已完整，可以添加到仓库" : "请完成所有必填项"}</span><button onClick={onClose} disabled={busy}>取消</button><button className="lora-submit" disabled={busy || !session || !formReady} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <UploadCloud />}{busy ? message : "添加 LoRA"}</button></footer>
  </section></div>;
}

/** LoRA 详情子页面：访客只读，作者可编辑文件、示例图、元数据和隐私。 */
function LoraDetailPage({ session, entry, loading, message, families, onBack, onChanged, onDeleted, onUseLora }: { session: LocalPlatformSessionView | null; entry: LoraLibraryEntryView | null; loading: boolean; message: string; families: string[]; onBack: () => void; onChanged: (entry: LoraLibraryEntryView, notice: string) => Promise<void>; onDeleted: () => Promise<void>; onUseLora: (versionId: string) => void }) {
  const [title, setTitle] = useState(""); const [description, setDescription] = useState("");
  const [type, setType] = useState<LoraLibraryEntryView["type"]>("style"); const [family, setFamily] = useState("");
  const [triggerWords, setTriggerWords] = useState(""); const [isPrivate, setPrivate] = useState(false); const [busy, setBusy] = useState(false); const [downloading, setDownloading] = useState(false); const [editOpen, setEditOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  useEffect(() => { if (entry) { setTitle(entry.title); setDescription(entry.description); setType(entry.type); setFamily(entry.modelFamilyName); setTriggerWords(entry.triggerWords.join(", ")); setPrivate(entry.privacy === "private"); } }, [entry]);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === "Escape" && editOpen && !busy) setEditOpen(false); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [busy, editOpen]);
  if (loading || !entry) return <section className="card lora-detail-loading"><button onClick={onBack}><ArrowLeft />返回仓库</button>{loading ? <><LoaderCircle className="spin" /><span>正在读取 LoRA 详情</span></> : <><Layers3 /><span>{message || "LoRA 不存在"}</span></>}</section>;
  const token = session?.sessionToken || "";
  const coverExample = entry.examples[0];
  const coverRatio = coverExample?.width && coverExample.height ? coverExample.width / coverExample.height : 0.8;
  // 信息区高度固定时按真实图片比例计算封面列宽，宽图和竖图都保留完整画面。
  const coverStyle = { "--lora-detail-cover-width": `${Math.round(Math.min(610, Math.max(320, 430 * coverRatio)))}px`, "--lora-detail-cover-ratio": String(coverRatio) } as CSSProperties;
  const run = async (operation: () => Promise<LoraLibraryEntryView>, notice: string) => { setBusy(true); setFeedback(null); try { await onChanged(await operation(), ""); setFeedback({ kind: "success", text: notice }); } catch (error) { setFeedback({ kind: "error", text: errorMessage(error) }); } finally { setBusy(false); } };
  const save = () => run(() => loraJson(`/v1/lora-library/${entry.id}`, token, { method: "PATCH", body: JSON.stringify({ title: title.trim(), description: description.trim(), type, modelFamily: family.trim(), triggerWords: splitTriggerWords(triggerWords), isPrivate }) }), "LoRA 信息已保存");
  const uploadModel = (file: File) => run(() => uploadLoraFileChunked(entry.id, file, token, () => undefined), "模型文件已上传");
  const addExamples = (files: File[]) => run(async () => { await uploadExamples(entry.id, files.slice(0, Math.max(0, 8 - entry.examples.length)), token, () => undefined); return loraJson(`/v1/lora-library/${entry.id}`, token); }, "示例图已添加");
  const removeExample = (id: string) => run(() => loraJson(`/v1/lora-library/${entry.id}/examples/${id}`, token, { method: "DELETE" }), "示例图已删除");
  /** 使用本地会话鉴权读取真实模型文件，并交给浏览器保存为原始 safetensors 文件名。 */
  const downloadLora = async () => {
    if (!entry.version || downloading) return;
    setDownloading(true); setFeedback(null);
    try {
      const response = await fetch(`${apiBase}/v1/lora-library/${entry.id}/download`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(payload?.message || `下载失败：HTTP ${response.status}`);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = entry.version.fileName.split(/[\\/]/).pop() || `${entry.title}.safetensors`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setFeedback({ kind: "success", text: "LoRA 模型文件已开始下载" });
    } catch (error) { setFeedback({ kind: "error", text: errorMessage(error) }); }
    finally { setDownloading(false); }
  };
  /** 删除 LoRA 会立即下架当前条目，并保留历史任务、训练产物和计费审计。 */
  const deleteLora = async () => {
    if (!window.confirm(`删除 LoRA“${entry.title}”？它会立即从仓库和生成选择中下架；历史任务、训练产物和计费记录会保留。`)) return;
    setBusy(true);
    try { await loraJson(`/v1/lora-library/${entry.id}`, token, { method: "DELETE" }); await onDeleted(); }
    catch (error) { setFeedback({ kind: "error", text: errorMessage(error) }); setBusy(false); }
  };
  return <div className="lora-detail-page">
    <header className="card lora-detail-toolbar"><button className="lora-detail-back" onClick={onBack}><ArrowLeft size={16} />返回仓库</button><div><span>{typeLabel(entry.type)} · {entry.modelFamilyName}</span><strong>{entry.title}</strong></div><nav className="lora-detail-actions">{entry.isOwner && <button className="lora-edit-button" onClick={() => { setFeedback(null); setEditOpen(true); }}><Pencil size={14} />编辑</button>}{entry.version && <button className="lora-download-button" disabled={downloading} onClick={() => void downloadLora()}>{downloading ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}{downloading ? "下载中" : "下载"}</button>}{entry.version ? <button className="lora-use-button" onClick={() => onUseLora(entry.version!.id)}><Sparkles size={15} />用于绘图</button> : <span className="lora-detail-unavailable">尚未上传模型文件</span>}</nav></header>
    {feedback && <div className={`notice compact lora-detail-feedback ${feedback.kind === "error" ? "error" : "success"}`}><span>{feedback.text}</span><button onClick={() => setFeedback(null)} aria-label="关闭提示"><X size={13} /></button></div>}
    <section className="lora-detail-hero card" style={coverStyle}>
      <div className="lora-detail-cover">{coverExample ? <LoraExampleImage example={coverExample} token={token} alt={entry.title} eager /> : <LoraDefaultCover />}</div>
      <div className="lora-detail-summary"><div className="lora-detail-badges"><LoraTypeBadge type={entry.type} />{entry.privacy === "private" && <span className="lora-privacy private"><Lock />私有</span>}</div><h1>{entry.title}</h1><p>{entry.description}</p><section className="lora-summary-triggers"><header><Tag size={12} /><span>触发词</span></header><div>{entry.triggerWords.length ? entry.triggerWords.map((word) => <span key={word}>{word}<button onClick={() => void navigator.clipboard.writeText(word)} aria-label={`复制触发词 ${word}`}><Copy size={10} /></button></span>) : <small>未设置触发词</small>}</div></section><dl><div><dt><UserRound />作者</dt><dd>{entry.ownerDisplayName}</dd></div><div><dt><Layers3 />主模型</dt><dd>{entry.modelFamilyName}</dd></div><div><dt><HardDrive />模型文件</dt><dd>{entry.version ? `${(entry.version.byteSize / 1024 / 1024).toFixed(1)} MB` : "待上传"}</dd></div><div><dt><CalendarDays />最近更新</dt><dd>{new Date(entry.updatedAt).toLocaleDateString("zh-CN")}</dd></div></dl></div>
    </section>
    <section className="card lora-detail-section"><header><div><span>视觉样本</span><h2>示例图片 <b>{entry.examples.length}</b></h2></div>{entry.isOwner && <label className="lora-inline-upload"><Plus />添加示例<input type="file" accept="image/*" multiple disabled={busy || entry.examples.length >= 8} onChange={(event) => void addExamples(Array.from(event.target.files || []))} /></label>}</header>{entry.examples.length ? <div className="lora-example-grid">{entry.examples.map((example) => <div key={example.id}><LoraExampleImage example={example} token={token} alt={`${entry.title} 示例图`} />{entry.isOwner && <button disabled={busy} onClick={() => void removeExample(example.id)} aria-label="删除示例图"><Trash2 /></button>}</div>)}</div> : <div className="lora-example-empty"><Images size={28} /><span>暂无示例图片，当前使用默认封面</span></div>}</section>
    <section className="card lora-reference-section"><header><div><span>公开引用</span><h2>引用任务 <b>{entry.referenceTasks.length}</b></h2></div><small>仅展示已发布到主站图库的公开任务</small></header>{entry.referenceTasks.length ? <div className="lora-reference-grid">{entry.referenceTasks.map((task) => <a key={task.id} className="lora-reference-card" href={`/image/${task.galleryItemId}`}><LoraReferenceImage source={task.imageUrl} alt={task.prompt} /><div><strong>{task.prompt}</strong><span>{task.modelDisplayName} · {task.ownerDisplayName}</span><small>{task.width && task.height ? `${task.width} × ${task.height} · ` : ""}{new Date(task.createdAt).toLocaleDateString("zh-CN")}</small></div><ExternalLink size={13} /></a>)}</div> : <div className="lora-reference-empty"><Images size={25} /><span>暂时没有公开任务引用这个 LoRA</span></div>}</section>
    {editOpen && <div className="modal-backdrop lora-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setEditOpen(false); }}><section className="task-dialog lora-edit-dialog" role="dialog" aria-modal="true" aria-label="编辑 LoRA"><header><div><span>ASSET EDITOR</span><h2>编辑 LoRA</h2></div><button onClick={() => setEditOpen(false)} disabled={busy} aria-label="关闭"><X /></button></header><div className="lora-edit-body"><div className="lora-edit-grid"><label className="field"><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={191} /></label><label className="field"><span>类型</span><select value={type} onChange={(event) => setType(event.target.value as typeof type)}>{loraTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label className="field"><span>详细描述</span><textarea rows={5} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={10000} /></label><div className="lora-edit-grid"><label className="field"><span>主模型系列</span><input value={family} list="lora-detail-family-options" onChange={(event) => setFamily(event.target.value)} /><datalist id="lora-detail-family-options">{families.map((item) => <option key={item} value={item} />)}</datalist></label><label className="field"><span>触发词</span><input value={triggerWords} onChange={(event) => setTriggerWords(event.target.value)} placeholder="使用逗号分隔" /></label></div><PrivacyControl value={isPrivate} onChange={setPrivate} /><section className="lora-edit-assets"><header><span>模型文件</span><small>上传完成后立即可用于绘图</small></header><div><label><FileUp />{entry.version ? "替换模型文件" : "上传模型文件"}<input type="file" accept=".safetensors" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadModel(file); }} /></label></div></section>{feedback && <div className={`lora-edit-feedback ${feedback.kind}`}><span>{feedback.text}</span></div>}<button className="lora-edit-danger" disabled={busy} onClick={() => void deleteLora()}><Trash2 />删除 LoRA</button><p className="lora-owner-note">删除后立即下架资产；历史任务、训练产物与计费记录继续保留。</p></div><footer><button onClick={() => setEditOpen(false)} disabled={busy}>取消</button><button className="lora-save-button" disabled={busy || !title.trim() || !description.trim() || !family.trim()} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" /> : <Check />}{busy ? "处理中" : "保存修改"}</button></footer></section></div>}
  </div>;
}

/** 公开引用任务封面加载失败时回退统一默认封面。 */
function LoraReferenceImage({ source, alt }: { source: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="lora-reference-image">{failed ? <LoraDefaultCover /> : <img src={source} alt={alt} loading="lazy" onError={() => setFailed(true)} />}</div>;
}

/** 公开与私有二选一控件，文字明确说明外显影响。 */
function PrivacyControl({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return <div className="lora-privacy-control"><span>隐私与外显</span><div><button type="button" className={!value ? "active" : ""} onClick={() => onChange(false)}><Unlock />公开<small>所有登录用户可见和使用</small></button><button type="button" className={value ? "active" : ""} onClick={() => onChange(true)}><Lock />私有<small>仅作者可见和使用</small></button></div></div>;
}

/** 按 LoRA 内容类型输出带稳定颜色语义的标签。 */
function LoraTypeBadge({ type }: { type: LoraLibraryEntryView["type"] }) {
  return <span className={`lora-type-badge lora-type-${type}`}>{typeLabel(type)}</span>;
}

/** 仓库卡片只在悬浮时启动多图轮换，避免列表静止时产生额外图片请求。 */
function LoraGalleryCard({ entry, token, onOpen }: { entry: LoraLibraryEntryView; token: string; onOpen: () => void }) {
  const [previewActive, setPreviewActive] = useState(false);
  return <button className="lora-gallery-card" onClick={onOpen} onMouseEnter={() => setPreviewActive(true)} onMouseLeave={() => setPreviewActive(false)}>
    <div className="lora-gallery-cover">
      <LoraGalleryPreview examples={entry.examples} token={token} alt={entry.title} active={previewActive} />
      <div className="lora-cover-badges"><LoraTypeBadge type={entry.type} />{entry.privacy === "private" && <span className="lora-privacy private"><Lock />私有</span>}</div>
      <div className="lora-gallery-overlay"><span>{entry.modelFamilyName}</span><h2>{entry.title}</h2><p>{entry.description}</p><footer><small><UserRound size={11} />{entry.ownerDisplayName}</small><small><ImageIcon size={11} />{entry.examples.length ? entry.examples.length : "默认封面"}</small><ChevronRight size={15} /></footer></div>
    </div>
  </button>;
}

/** 按视口与悬浮状态逐张读取鉴权示例图，并缓存本次卡片会话中的 Blob URL。 */
function LoraGalleryPreview({ examples, token, alt, active }: { examples: LoraLibraryEntryView["examples"]; token: string; alt: string; active: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const objectUrls = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());
  const failedExamples = useRef(new Set<string>());
  const [visible, setVisible] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sources, setSources] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!root.current || visible) return;
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver((items) => {
      if (items.some((item) => item.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "240px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!active || examples.length < 2) { setActiveIndex(0); return; }
    const timer = window.setInterval(() => setActiveIndex((current) => (current + 1) % examples.length), 1400);
    return () => window.clearInterval(timer);
  }, [active, examples.length]);

  useEffect(() => {
    const example = examples[activeIndex];
    if (!visible || !token || !example || sources[example.id] || failedExamples.current.has(example.id) || controllers.current.has(example.id)) return;
    const controller = new AbortController();
    controllers.current.set(example.id, controller);
    void fetch(`${apiBase}/v1/lora-library/examples/${example.id}/content`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("示例图读取失败"); return response.blob(); })
      .then((blob) => {
        if (controller.signal.aborted) return;
        const source = URL.createObjectURL(blob);
        objectUrls.current.add(source);
        setSources((current) => ({ ...current, [example.id]: source }));
      })
      .catch(() => { if (!controller.signal.aborted) failedExamples.current.add(example.id); })
      .finally(() => controllers.current.delete(example.id));
  }, [activeIndex, examples, sources, token, visible]);

  useEffect(() => () => {
    controllers.current.forEach((controller) => controller.abort());
    objectUrls.current.forEach((source) => URL.revokeObjectURL(source));
  }, []);

  const selectedExample = examples[activeIndex];
  const firstExample = examples[0];
  const selectedSource = selectedExample ? sources[selectedExample.id] : "";
  const firstSource = firstExample ? sources[firstExample.id] : "";
  const source = selectedSource || firstSource || "";
  const displayedExampleId = selectedSource ? selectedExample?.id : firstExample?.id;
  /** Blob 解码异常时清理失效缓存，后续保持默认封面而不是显示破图。 */
  const handleImageError = () => {
    if (displayedExampleId) failedExamples.current.add(displayedExampleId);
    if (source) { URL.revokeObjectURL(source); objectUrls.current.delete(source); }
    if (displayedExampleId) setSources((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== displayedExampleId)));
  };
  return <div className={`lora-gallery-preview${active && examples.length > 1 ? " cycling" : ""}`} ref={root}>{source ? <img key={source} src={source} alt={alt} onError={handleImageError} /> : <LoraDefaultCover />}</div>;
}

/** 在 LoRA 尚未上传示例图时展示统一的项目默认封面。 */
function LoraDefaultCover() {
  return <div className="lora-default-cover"><img src={defaultLoraCoverUrl} alt="LoRA 默认封面" /></div>;
}

/** 进入视口后再鉴权读取示例图，避免图库首屏同时加载所有大图。 */
function LoraExampleImage({ example, token, alt, eager = false }: { example: LoraLibraryEntryView["examples"][number]; token: string; alt: string; eager?: boolean }) {
  const root = useRef<HTMLDivElement>(null); const [visible, setVisible] = useState(eager); const [source, setSource] = useState(""); const [failed, setFailed] = useState(false); const [ratio, setRatio] = useState("1 / 1");
  useEffect(() => { if (visible || !root.current) return; if (!("IntersectionObserver" in window)) { setVisible(true); return; } const observer = new IntersectionObserver((items) => { if (items.some((item) => item.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "240px" }); observer.observe(root.current); return () => observer.disconnect(); }, [visible]);
  useEffect(() => { if (!visible || !token) return; let objectUrl = ""; setFailed(false); setSource(""); void fetch(`${apiBase}/v1/lora-library/examples/${example.id}/content`, { headers: { authorization: `Bearer ${token}` } }).then(async (response) => { if (!response.ok) throw new Error("示例图读取失败"); objectUrl = URL.createObjectURL(await response.blob()); setSource(objectUrl); }).catch(() => setFailed(true)); return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [example.id, token, visible]);
  const imageStyle = source ? { "--lora-image": `url("${source}")`, "--lora-image-ratio": ratio } as CSSProperties : undefined;
  // 读取真实宽高，让固定高度的示例图按原始比例自适应宽度，避免裁切图片内容。
  const recordRatio = (image: HTMLImageElement) => { if (image.naturalWidth && image.naturalHeight) setRatio(`${image.naturalWidth} / ${image.naturalHeight}`); };
  if (failed) return <LoraDefaultCover />;
  return <div className={`lora-cover${source ? " has-image" : ""}`} ref={root} style={imageStyle}>{source ? <img src={source} alt={alt} onLoad={(event) => recordRatio(event.currentTarget)} onError={() => setFailed(true)} /> : <LoaderCircle className="spin" />}</div>;
}

/** 批量上传示例图，服务端负责格式统一和数量终验。 */
async function uploadExamples(entryId: string, files: File[], token: string, onProgress: (current: number, total: number) => void): Promise<void> { for (let index = 0; index < files.length; index += 1) { onProgress(index + 1, files.length); await loraBinary(`/v1/lora-library/${entryId}/examples`, token, files[index]!, "POST"); } }

/** 以服务端偏移分片续传 LoRA，刷新后重选同一文件可继续。 */
async function uploadLoraFileChunked(entryId: string, file: File, token: string, onProgress: (received: number, total: number) => void): Promise<LoraLibraryEntryView> {
  const storageKey = `drawhime_lora_upload_${entryId}`; let upload: LoraUploadSessionView | null = null; const existingId = localStorage.getItem(storageKey);
  if (existingId) { try { const current = await loraJson<LoraUploadSessionView>(`/v1/lora-library/${entryId}/uploads/${existingId}`, token); if (current.totalBytes === file.size && current.fileName === file.name && current.status === "uploading" && Date.parse(current.expiresAt) > Date.now()) upload = current; else localStorage.removeItem(storageKey); } catch { localStorage.removeItem(storageKey); } }
  if (!upload) { const created = await loraJson<LoraUploadSessionView>(`/v1/lora-library/${entryId}/uploads`, token, { method: "POST", body: JSON.stringify({ fileName: file.name, totalBytes: file.size }) }); upload = created; localStorage.setItem(storageKey, created.id); }
  if (!upload) throw new Error("LoRA 上传会话创建失败");
  const activeUpload = upload;
  let offset = activeUpload.receivedBytes; onProgress(offset, file.size);
  while (offset < file.size) {
    const chunkEnd = Math.min(file.size, offset + activeUpload.chunkSizeBytes);
    const chunk = file.slice(offset, chunkEnd);
    let advanced = false;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 5 && !advanced; attempt += 1) {
      try {
        const updated = await loraBinary<{ receivedBytes: number }>(`/v1/lora-library/${entryId}/uploads/${activeUpload.id}`, token, chunk, "PUT", { "x-upload-offset": String(offset) });
        if (updated.receivedBytes <= offset || updated.receivedBytes > chunkEnd) throw new Error("LoRA 上传服务返回了异常偏移");
        offset = updated.receivedBytes;
        advanced = true;
      } catch (error) {
        lastError = error;
        if (!isRecoverableUploadError(error)) throw error;
        // 响应丢失时源站可能已经写入分片，以服务端文件长度为准，禁止盲目重复追加。
        await waitForUploadRetry(attempt);
        const current = await loraJson<LoraUploadSessionView>(`/v1/lora-library/${entryId}/uploads/${activeUpload.id}`, token);
        if (current.receivedBytes > offset && current.receivedBytes <= chunkEnd) { offset = current.receivedBytes; advanced = true; }
        else if (current.receivedBytes !== offset) throw new Error(`LoRA 续传偏移异常：服务端为 ${current.receivedBytes}`);
      }
    }
    if (!advanced) throw lastError instanceof Error ? lastError : new Error("LoRA 分片上传重试失败");
    onProgress(offset, file.size);
  }
  try { return await loraJson(`/v1/lora-library/${entryId}/uploads/${activeUpload.id}/complete`, token, { method: "POST", body: "{}" }); } finally { localStorage.removeItem(storageKey); }
}

/** 带独立会话调用 LoRA JSON 接口。 */
async function loraJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> { const response = await fetch(`${apiBase}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers || {}) }, cache: "no-store" }); return readLoraResponse<T>(response, "请求失败"); }
/** 上传 LoRA 二进制分片或示例图。 */
async function loraBinary<T>(path: string, token: string, body: Blob, method: "PUT" | "POST", headers: Record<string, string> = {}): Promise<T> { const response = await fetch(`${apiBase}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": body.type || "application/octet-stream", ...headers }, body }); return readLoraResponse<T>(response, "上传失败"); }

class LoraHttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

/** 同时解析标准 JSON 与代理错误页，避免把 HTML 解析异常直接展示给用户。 */
async function readLoraResponse<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let payload: { ok?: boolean; data?: T; message?: string } = {};
  try { payload = text ? JSON.parse(text) as typeof payload : {}; } catch { payload = {}; }
  if (!response.ok || payload.ok !== true || payload.data === undefined) throw new LoraHttpError(payload.message || `${fallback}：HTTP ${response.status}`, response.status);
  return payload.data;
}

/** 网络中断、偏移冲突和代理 5xx 可通过服务端真实偏移恢复，其余业务错误立即返回。 */
function isRecoverableUploadError(error: unknown): boolean { return error instanceof TypeError || (error instanceof LoraHttpError && (error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500)); }
function waitForUploadRetry(attempt: number): Promise<void> { return new Promise((resolveRetry) => window.setTimeout(resolveRetry, Math.min(8000, 750 * 2 ** (attempt - 1)))); }
function readDetailId(): string { return new URLSearchParams(window.location.search).get("lora") || ""; }
function splitTriggerWords(value: string): string[] { return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))].slice(0, 32); }
function typeLabel(type: LoraLibraryEntryView["type"]): string { return Object.fromEntries(loraTypes)[type]; }
function typeHint(type: LoraLibraryEntryView["type"]): string { return { style: "画风与渲染", character: "角色身份", concept: "主题概念", clothing: "服装造型", pose: "动作姿态", other: "其他用途" }[type]; }
function formatFileSize(bytes: number): string { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "LoRA 操作失败"; }
