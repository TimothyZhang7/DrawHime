/**
 * 本文件实现桌面底模与 LoRA 仓库的合并卡片、详情、下载状态和本机导入界面。
 */
import type { DesktopLocalJobView, DesktopLocalLoraImportInput, DesktopLocalLoraView, DesktopLocalModelImportInput, DesktopLocalModelView, DesktopManagedFileRemovalView, DesktopTrainingDatasetView, DesktopTrainingJobView, DesktopTrainingSnapshotView, DesktopWebsiteLoraInstallProgress, DesktopWebsiteLoraView, DesktopWebsiteModelInstallProgress, DesktopWebsiteModelView } from "@drawhime/contracts";
import { ArrowLeft, CheckCircle2, ChevronRight, Copy, Database, Download, FolderCog, HardDrive, Image, Layers3, LoaderCircle, PackageOpen, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { PaginationControls, usePagedItems } from "./components/Pagination";
import { copyDesktopTrainingSnapshot, deleteDesktopLocalLoraFile, deleteDesktopLocalModelFile, getDesktopTrainingSnapshot, importDesktopLocalLora, importDesktopLocalModel } from "./desktop-api";

/** 以首图本机路径索引同一仓库条目的全部示例图，现有卡片接口无需暴露远端媒体地址。 */
const repositoryExamplePaths = new Map<string, string[]>();

type ModelRepositoryEntry = {
  key: string;
  displayName: string;
  description: string;
  family: string;
  familyName: string;
  fileName: string;
  coverPath: string | null;
  local: DesktopLocalModelView | null;
  website: DesktopWebsiteModelView | null;
};

type LoraRepositoryEntry = {
  key: string;
  title: string;
  description: string;
  type: DesktopLocalLoraView["type"];
  modelFamilyName: string;
  coverPath: string | null;
  local: DesktopLocalLoraView | null;
  website: DesktopWebsiteLoraView | null;
};

/** 合并主站在线目录与本机登记记录；签名依赖清单不参与仓库外显和安装。 */
export function ModelRepositoryPage({ models, websiteModels, jobs, websiteProgress, accountConnected, modelRoot, refreshing, onRefresh, onInstallWebsite, onImported, onDeleted, onOpenSettings, onError }: { models: DesktopLocalModelView[]; websiteModels: DesktopWebsiteModelView[]; jobs: DesktopLocalJobView[]; websiteProgress: Record<string, DesktopWebsiteModelInstallProgress>; accountConnected: boolean; modelRoot: string; refreshing: boolean; onRefresh: () => void; onInstallWebsite: (modelId: string) => void; onImported: (model: DesktopLocalModelView) => void; onDeleted: (result: DesktopManagedFileRemovalView) => void; onOpenSettings: () => void; onError: (message: string) => void }) {
  const entries = useMemo(() => mergeModelEntries(models, websiteModels), [models, websiteModels]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [localOnly, setLocalOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const selected = entries.find((entry) => entry.key === selectedKey) || null;
  // 大仓库搜索让输入优先响应，筛选结果在下一次空闲渲染中收敛。
  const filtered = useMemo(() => entries.filter((entry) => (!localOnly || Boolean(entry.local?.available)) && searchable(`${entry.displayName} ${entry.description} ${entry.familyName} ${entry.fileName}`, deferredQuery)), [deferredQuery, entries, localOnly]);
  if (selected) {
    const directProgress = selected.website ? websiteProgress[selected.website.id] : undefined;
    const progress = websiteModelProgress(directProgress);
    const busy = Boolean(directProgress && ["downloading", "verifying", "installing"].includes(directProgress.status));
    const remove = async () => { if (!selected.local?.available || deleting || !window.confirm(`删除本机底模文件“${selected.displayName}”？历史任务记录会保留，共享组件不会删除。`)) return; setDeleting(true); try { onDeleted(await deleteDesktopLocalModelFile({ id: selected.local.id })); } catch (error) { onError(errorMessage(error)); } finally { setDeleting(false); } };
    return <ModelDetail entry={selected} jobs={jobs} modelRoot={modelRoot} busy={busy} deleting={deleting} progress={progress} onBack={() => setSelectedKey(null)} onInstall={() => selected.website && onInstallWebsite(selected.website.id)} onDelete={() => void remove()} onOpenSettings={onOpenSettings} />;
  }
  return <div className="desktop-page repository-page repository-model-page">
    <RepositoryToolbar title="底模仓库" count={filtered.length} query={query} localOnly={localOnly} accountConnected={accountConnected} refreshing={refreshing} onQuery={setQuery} onLocalOnly={setLocalOnly} onRefresh={onRefresh} onImport={() => setImportOpen(true)} />
    {!accountConnected && <RepositoryHint text="连接绘图姬账号后会同步网页底模的封面、说明和推荐参数；已签名安装资源与本地模型仍可正常管理。" />}
    {filtered.length ? <section className="repository-grid repository-model-grid">{filtered.map((entry) => {
      const directProgress = entry.website ? websiteProgress[entry.website.id] : undefined;
      const progress = websiteModelProgress(directProgress);
      const directInstallable = Boolean(entry.website?.download);
      const directBusy = Boolean(directProgress && ["downloading", "verifying", "installing"].includes(directProgress.status));
      const local = Boolean(entry.local?.available);
      const byteSize = entry.website?.download?.byteSize || entry.local?.byteSize || 0;
      const subtitle = local ? `${entry.familyName} · ${formatBytes(byteSize)}` : directInstallable ? `${entry.familyName} · 需下载 ${formatBytes(byteSize)}` : `${entry.familyName} · ${formatBytes(byteSize)}`;
      return <RepositoryCard variant="model" key={entry.key} title={entry.displayName} subtitle={subtitle} description={entry.description} triggerWords={[]} coverPath={entry.coverPath} fallback="MODEL" secondaryTag={entry.website ? "主站" : entry.familyName} onOpen={() => setSelectedKey(entry.key)} action={local ? { kind: "local", label: "已安装", disabled: true, onClick: () => undefined } : directInstallable ? { kind: "download", label: directBusy ? progress.label : "下载并安装", disabled: directBusy, loading: directBusy, onClick: () => onInstallWebsite(entry.website!.id) } : { kind: "view", label: "查看详情", disabled: false, onClick: () => setSelectedKey(entry.key) }} progress={progress.percent} />;
    })}</section> : <RepositoryEmpty text={query || localOnly ? "没有符合当前筛选条件的底模" : "当前仓库还没有可展示的底模"} />}
    {importOpen && <ModelImportDialog onClose={() => setImportOpen(false)} onImported={(model) => { onImported(model); setImportOpen(false); }} onError={onError} />}
  </div>;
}

/** 合并主站与本机 LoRA，以版本 SHA-256 作为安装状态的唯一判断依据。 */
export function LoraRepositoryPage({ loras, websiteLoras, jobs, trainingJobs, progress, accountConnected, modelRoot, refreshing, onRefresh, onInstall, onImported, onDatasetCopied, onDeleted, onError }: { loras: DesktopLocalLoraView[]; websiteLoras: DesktopWebsiteLoraView[]; jobs: DesktopLocalJobView[]; trainingJobs: DesktopTrainingJobView[]; progress: Record<string, DesktopWebsiteLoraInstallProgress>; accountConnected: boolean; modelRoot: string; refreshing: boolean; onRefresh: () => void; onInstall: (id: string) => void; onImported: (lora: DesktopLocalLoraView) => void; onDatasetCopied: (dataset: DesktopTrainingDatasetView) => void; onDeleted: (result: DesktopManagedFileRemovalView) => void; onError: (message: string) => void }) {
  const entries = useMemo(() => mergeLoraEntries(loras, websiteLoras), [loras, websiteLoras]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [type, setType] = useState("all");
  const [localOnly, setLocalOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const selected = entries.find((entry) => entry.key === selectedKey) || null;
  // LoRA 标题、说明和触发词较长时也不阻塞搜索框键入。
  const filtered = useMemo(() => entries.filter((entry) => (type === "all" || entry.type === type) && (!localOnly || Boolean(entry.local?.available)) && searchable(`${entry.title} ${entry.description} ${entry.modelFamilyName} ${entry.website?.triggerWords.join(" ") || entry.local?.triggerWords.join(" ") || ""}`, deferredQuery)), [deferredQuery, entries, localOnly, type]);
  const pagination = usePagedItems(filtered, 18, `${deferredQuery}\n${type}\n${localOnly}`);
  if (selected) {
    const sourceJob = selected.local ? trainingJobs.find((job) => job.outputLoraId === selected.local?.id) || null : null;
    const remove = async () => { if (!selected.local?.available || deleting || !window.confirm(`删除本机 LoRA 文件“${selected.title}”？历史任务记录会保留。`)) return; setDeleting(true); try { onDeleted(await deleteDesktopLocalLoraFile({ id: selected.local.id })); } catch (error) { onError(errorMessage(error)); } finally { setDeleting(false); } };
    return <LoraDetail entry={selected} jobs={jobs} sourceJob={sourceJob} modelRoot={modelRoot} progress={selected.website ? progress[selected.website.id] : undefined} deleting={deleting} onBack={() => setSelectedKey(null)} onInstall={() => selected.website && onInstall(selected.website.id)} onDelete={() => void remove()} onDatasetCopied={onDatasetCopied} onError={onError} />;
  }
  return <div className="desktop-page repository-page repository-lora-page">
    <RepositoryToolbar title="LoRA 仓库" count={filtered.length} query={query} localOnly={localOnly} accountConnected={accountConnected} refreshing={refreshing} onQuery={setQuery} onLocalOnly={setLocalOnly} onRefresh={onRefresh} onImport={() => setImportOpen(true)} extra={<select aria-label="LoRA 类型" value={type} onChange={(event) => setType(event.target.value)}><option value="all">全部类型</option>{["style", "character", "concept", "clothing", "pose", "other"].map((value) => <option key={value} value={value}>{loraTypeLabel(value)}</option>)}</select>} />
    {!accountConnected && <RepositoryHint text="连接绘图姬账号后可浏览公开 LoRA 和自己的私有 LoRA，并直接断点下载；本机仓库和生成能力不受网络影响。" />}
    {filtered.length ? <section className="repository-grid repository-lora-grid">{pagination.pageItems.map((entry) => {
      const current = entry.website ? progress[entry.website.id] : undefined;
      const running = Boolean(current && ["downloading", "verifying", "installing"].includes(current.status));
      const percent = current ? Math.min(100, Math.round(current.downloadedBytes / Math.max(1, current.totalBytes) * 100)) : null;
      const local = Boolean(entry.local?.available);
      const triggerWords = entry.website?.triggerWords || entry.local?.triggerWords || [];
      return <RepositoryCard variant="lora" key={entry.key} title={entry.title} subtitle={`${loraTypeLabel(entry.type)} · ${entry.modelFamilyName}`} description={entry.description || "未填写说明"} triggerWords={triggerWords} coverPath={entry.coverPath} fallback="LORA" secondaryTag={entry.website?.privacy === "private" ? "私有" : entry.website ? "主站" : loraTypeLabel(entry.type)} onOpen={() => setSelectedKey(entry.key)} action={local ? { kind: "local", label: "已安装", disabled: true, onClick: () => undefined } : entry.website ? { kind: "download", label: running ? loraProgressLabel(current!) : `下载 · ${formatBytes(entry.website.byteSize)}`, disabled: running, loading: running, onClick: () => onInstall(entry.website!.id) } : { kind: "view", label: "查看详情", disabled: false, onClick: () => setSelectedKey(entry.key) }} progress={percent} />;
    })}</section> : <RepositoryEmpty text={query || localOnly || type !== "all" ? "没有符合当前筛选条件的 LoRA" : "当前仓库还没有可展示的 LoRA"} />}
    <PaginationControls page={pagination.page} pageCount={pagination.pageCount} total={filtered.length} onPage={pagination.setPage} />
    {importOpen && <LoraImportDialog onClose={() => setImportOpen(false)} onImported={(lora) => { onImported(lora); setImportOpen(false); }} onError={onError} />}
  </div>;
}

function RepositoryToolbar({ title, count, query, localOnly, accountConnected, refreshing, onQuery, onLocalOnly, onRefresh, onImport, extra }: { title: string; count: number; query: string; localOnly: boolean; accountConnected: boolean; refreshing: boolean; onQuery: (value: string) => void; onLocalOnly: (value: boolean) => void; onRefresh: () => void; onImport: () => void; extra?: ReactNode }) {
  return <section className="repository-toolbar"><div className="repository-heading"><div><span>LOCAL LIBRARY</span><h2>{title}</h2></div><b>{count}</b></div><div className="repository-controls"><label className="repository-search"><Search /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索名称、系列或说明" /></label>{extra}<label className="repository-local-filter"><input type="checkbox" checked={localOnly} onChange={(event) => onLocalOnly(event.target.checked)} /><span>仅看本地</span></label><button disabled={refreshing} title={refreshing ? "正在刷新仓库，请勿重复操作" : accountConnected ? "刷新主站仓库" : "刷新本地仓库"} onClick={onRefresh}>{refreshing ? <LoaderCircle className="spin" /> : <RefreshCw />}{refreshing ? "刷新中" : "刷新"}</button><button className="primary" onClick={onImport}><Plus />导入本机文件</button></div></section>;
}

/** 仓库卡片动作统一承载下载、安装完成和详情状态，两个布局复用同一真实下载事件。 */
type RepositoryCardAction = { kind: "local" | "download" | "view"; label: string; disabled: boolean; loading?: boolean; onClick: () => void };

function RepositoryCard({ variant, title, subtitle, description, triggerWords, coverPath, fallback, secondaryTag, onOpen, action, progress }: { variant: "model" | "lora"; title: string; subtitle: string; description: string; triggerWords: string[]; coverPath: string | null; fallback: string; secondaryTag: string; onOpen: () => void; action: RepositoryCardAction; progress: number | null }) {
  return <article className={`repository-card is-${variant}`} tabIndex={0} role="button" onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpen(); }}>
    <div className="repository-card-media">
      <RepositoryCover path={coverPath} fallback={fallback} compact={variant === "lora"} />
      <div className="repository-card-tags"><i>{secondaryTag}</i></div>
      {variant === "model" && <div className="repository-card-title"><strong title={title}>{title}</strong><span title={subtitle}>{subtitle}</span></div>}
    </div>
    {variant === "model" ? <div className="repository-card-copy"><p>{description}</p>{progress !== null && <RepositoryProgress progress={progress} />}<RepositoryActionButton action={action} progress={progress} /></div> : <div className="repository-lora-content">
      <div className="repository-card-title"><strong title={title}>{title}</strong><span title={subtitle}>{subtitle}</span></div>
      <p className="repository-lora-description">{description}</p>
      <div className="repository-lora-triggers"><b>触发词</b><span title={triggerWords.join(", ")}>{triggerWords.join(", ") || "未设置"}</span></div>
      {progress !== null && <RepositoryProgress progress={progress} />}
      <RepositoryActionButton action={action} progress={progress} />
    </div>}
  </article>;
}

/** 卡片动作只位于内容区，避免封面重复按钮和图片遮挡。 */
function RepositoryActionButton({ action, progress }: { action: RepositoryCardAction; progress: number | null }) {
  const actionTitle = action.disabled ? action.loading ? `${action.label}，请勿重复操作` : action.kind === "local" ? "文件已在本机完成校验" : "当前操作暂不可用" : action.kind === "download" ? "从主站镜像下载并校验文件" : "打开完整详情";
  const label = action.loading && progress !== null ? `${action.label} · ${progress}%` : action.label;
  return <button className={`repository-card-action is-${action.kind}`} disabled={action.disabled} title={actionTitle} onClick={(event) => { event.stopPropagation(); action.onClick(); }}>{action.loading ? <LoaderCircle className="spin" /> : action.kind === "local" ? <CheckCircle2 /> : action.kind === "download" ? <Download /> : <ChevronRight />}{label}</button>;
}

/** 下载进度放在操作按钮上方，不占用或遮挡封面。 */
function RepositoryProgress({ progress }: { progress: number }) { return <div className="repository-card-progress" aria-label={`下载进度 ${progress}%`}><i style={{ width: `${progress}%` }} /></div>; }

function ModelDetail({ entry, jobs, modelRoot, busy, deleting, progress, onBack, onInstall, onDelete, onOpenSettings }: { entry: ModelRepositoryEntry; jobs: DesktopLocalJobView[]; modelRoot: string; busy: boolean; deleting: boolean; progress: { percent: number | null; label: string }; onBack: () => void; onInstall: () => void; onDelete: () => void; onOpenSettings: () => void }) {
  const local = Boolean(entry.local?.available);
  const website = entry.website;
  const runtimeFormat = website?.runtimeFormat || entry.local?.workflowKind || "Anima";
  const missingBytes = website?.download?.byteSize || 0;
  const installable = Boolean(website?.download);
  const relatedJobs = jobs.filter((job) => entry.local ? job.modelId === entry.local.id : job.modelDisplayName === entry.displayName);
  const examples = website?.examplePaths.length ? website.examplePaths : relatedJobs.flatMap((job) => job.artifact ? [job.artifact.path] : []).slice(0, 12);
  return <div className="desktop-page repository-detail"><button className="repository-back" onClick={onBack}><ArrowLeft />返回底模仓库</button><section className="repository-detail-hero"><RepositoryCover path={entry.coverPath} fallback="MODEL" /><div className="repository-detail-summary"><div className="repository-detail-tags">{local && <b>已安装</b>}<i>{entry.familyName}</i>{runtimeFormat.toLocaleLowerCase() !== entry.familyName.toLocaleLowerCase() && <i>{runtimeFormat}</i>}</div><h1>{entry.displayName}</h1><p>{entry.description}</p><div className="repository-detail-actions">{local ? <><button disabled><CheckCircle2 />已安装，可直接生成</button><button className="danger" disabled={deleting} onClick={onDelete}>{deleting ? <LoaderCircle className="spin" /> : <Trash2 />}{deleting ? "正在删除" : "删除本地文件"}</button></> : installable ? <button className="primary" disabled={busy} onClick={onInstall}>{busy ? <LoaderCircle className="spin" /> : <Download />}{busy ? progress.label : `下载并安装 · ${formatBytes(missingBytes)}`}</button> : <button onClick={onOpenSettings}><FolderCog />设置模型目录</button>}</div>{progress.percent !== null && <div className="repository-detail-progress"><i style={{ width: `${progress.percent}%` }} /><span>{progress.label} · {progress.percent}%</span></div>}</div></section><section className="repository-detail-grid"><article><header><ShieldCheck /><strong>模型信息</strong></header><dl><InfoRow label="模型系列" value={entry.familyName} /><InfoRow label="文件名称" value={entry.fileName} /><InfoRow label="本机状态" value={local ? "文件校验通过" : website?.download ? "可从主站安装" : "仅提供仓库信息"} /><InfoRow label="待下载" value={local ? "无需下载" : installable ? formatBytes(missingBytes) : "未提供安装资源"} /><InfoRow label="存储目录" value={modelRoot} /></dl></article><article><header><HardDrive /><strong>推荐参数</strong></header><dl><InfoRow label="步数" value={String(website?.parameters.steps ?? "-")} /><InfoRow label="CFG" value={String(website?.parameters.cfg ?? "-")} /><InfoRow label="采样器" value={website?.parameters.sampler || "-"} /><InfoRow label="调度器" value={website?.parameters.scheduler || "-"} /><InfoRow label="最大边长" value={website?.parameters.maxEdge ? `${website.parameters.maxEdge}px` : "-"} /></dl></article></section><RepositoryExamples paths={examples} title="模型示例" /><RelatedJobs jobs={relatedJobs} title="使用该模型的任务" />{website?.usageGuide && <section className="repository-detail-copy"><h3>使用说明</h3><p>{website.usageGuide}</p></section>}{website?.sourceLinks.length ? <section className="repository-detail-copy"><h3>模型来源</h3><div className="repository-source-list">{website.sourceLinks.map((source) => <button key={source.url} onClick={() => void navigator.clipboard.writeText(source.url)}><Copy />复制 {source.label}</button>)}</div></section> : null}</div>;
}

function LoraDetail({ entry, jobs, sourceJob, modelRoot, progress, deleting, onBack, onInstall, onDelete, onDatasetCopied, onError }: { entry: LoraRepositoryEntry; jobs: DesktopLocalJobView[]; sourceJob: DesktopTrainingJobView | null; modelRoot: string; progress?: DesktopWebsiteLoraInstallProgress; deleting: boolean; onBack: () => void; onInstall: () => void; onDelete: () => void; onDatasetCopied: (dataset: DesktopTrainingDatasetView) => void; onError: (message: string) => void }) {
  const local = Boolean(entry.local?.available);
  const running = Boolean(progress && ["downloading", "verifying", "installing"].includes(progress.status));
  const percent = progress ? Math.min(100, Math.round(progress.downloadedBytes / Math.max(1, progress.totalBytes) * 100)) : null;
  const triggers = entry.website?.triggerWords || entry.local?.triggerWords || [];
  const relatedJobs = jobs.filter((job) => job.loras.some((lora) => entry.local ? lora.id === entry.local.id || lora.sha256 === entry.local.sha256 : lora.sha256 === entry.website?.sha256));
  const examples = entry.website?.examplePaths.length ? entry.website.examplePaths : relatedJobs.flatMap((job) => job.artifact ? [job.artifact.path] : []).slice(0, 12);
  const [snapshot, setSnapshot] = useState<DesktopTrainingSnapshotView | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyTitle, setCopyTitle] = useState(sourceJob ? `${sourceJob.datasetTitle} 副本` : "");
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setCopyTitle(sourceJob ? `${sourceJob.datasetTitle} 副本` : "");
    if (!sourceJob) return () => { active = false; };
    setSnapshotLoading(true);
    void getDesktopTrainingSnapshot(sourceJob.id).then((value) => { if (active) setSnapshot(value); }).catch((error) => { if (active) onError(errorMessage(error)); }).finally(() => { if (active) setSnapshotLoading(false); });
    return () => { active = false; };
  }, [sourceJob?.id]);
  /** 快照复制由 Rust 事务创建全新训练集，界面只回写新记录。 */
  const copySnapshot = async () => {
    if (!sourceJob || !copyTitle.trim() || copying) return;
    setCopying(true);
    try {
      const dataset = await copyDesktopTrainingSnapshot({ jobId: sourceJob.id, title: copyTitle.trim() });
      onDatasetCopied(dataset);
      onError(`已从训练快照创建“${dataset.title}”`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setCopying(false);
    }
  };
  return <div className="desktop-page repository-detail">
    <button className="repository-back" onClick={onBack}><ArrowLeft />返回 LoRA 仓库</button>
    <section className="repository-detail-hero"><RepositoryCover path={entry.coverPath} fallback="LORA" /><div className="repository-detail-summary"><div className="repository-detail-tags">{local && <b>已安装</b>}<i>{loraTypeLabel(entry.type)}</i>{entry.website?.privacy === "private" && <i>私有</i>}</div><h1>{entry.title}</h1><p>{entry.description || "当前条目未填写详细说明。"}</p><div className="repository-detail-actions">{local ? <><button disabled><CheckCircle2 />已安装，可用于生成</button><button className="danger" disabled={deleting} onClick={onDelete}>{deleting ? <LoaderCircle className="spin" /> : <Trash2 />}{deleting ? "正在删除" : "删除本地文件"}</button></> : entry.website ? <button className="primary" disabled={running} onClick={onInstall}>{running ? <LoaderCircle className="spin" /> : <Download />}{running ? loraProgressLabel(progress!) : `下载到本机 · ${formatBytes(entry.website.byteSize)}`}</button> : null}</div>{percent !== null && <div className="repository-detail-progress"><i style={{ width: `${percent}%` }} /><span>{loraProgressLabel(progress!)} · {percent}%</span></div>}</div></section>
    <section className="repository-detail-grid"><article><header><Layers3 /><strong>LoRA 信息</strong></header><dl><InfoRow label="类型" value={loraTypeLabel(entry.type)} /><InfoRow label="适用底模" value={entry.modelFamilyName} /><InfoRow label="文件名称" value={entry.website?.fileName || entry.local?.fileName || "-"} /><InfoRow label="文件大小" value={formatBytes(entry.website?.byteSize || entry.local?.byteSize || 0)} /></dl></article><article><header><HardDrive /><strong>本机状态</strong></header><dl><InfoRow label="状态" value={local ? "文件校验通过" : entry.website ? "可从主站下载" : "本地文件发生变化"} /><InfoRow label="存储位置" value={joinPath(modelRoot, "loras", entry.local?.fileName || entry.website?.fileName || "")} /><InfoRow label="作者" value={entry.website?.ownerDisplayName || "本机导入"} /><InfoRow label="更新时间" value={entry.local ? new Date(entry.local.updatedAt).toLocaleString("zh-CN") : "随主站同步"} /></dl></article></section>
    <section className="repository-detail-copy"><h3>触发词</h3>{triggers.length ? <div className="repository-trigger-list">{triggers.map((trigger) => <button key={trigger} onClick={() => void navigator.clipboard.writeText(trigger)}>{trigger}<Copy /></button>)}</div> : <p>该 LoRA 未设置触发词，可直接按说明使用。</p>}</section>
    {sourceJob && <TrainingSnapshotSection job={sourceJob} snapshot={snapshot} loading={snapshotLoading} copyTitle={copyTitle} copying={copying} onCopyTitle={setCopyTitle} onCopy={() => void copySnapshot()} />}
    <RepositoryExamples paths={examples} title="LoRA 示例" /><RelatedJobs jobs={relatedJobs} title="使用该 LoRA 的任务" />
  </div>;
}

/** LoRA 来源区只展示任务创建时的只读快照，避免把后来修改的训练集误作历史事实。 */
function TrainingSnapshotSection({ job, snapshot, loading, copyTitle, copying, onCopyTitle, onCopy }: { job: DesktopTrainingJobView; snapshot: DesktopTrainingSnapshotView | null; loading: boolean; copyTitle: string; copying: boolean; onCopyTitle: (value: string) => void; onCopy: () => void }) {
  return <section className="repository-training-source"><header><Database /><div><span>TRAINING SNAPSHOT</span><h3>来源训练集</h3></div><small>{job.assetCount} 张</small></header><div className="repository-training-summary"><dl><InfoRow label="训练集" value={job.datasetTitle} /><InfoRow label="创建时间" value={new Date(job.createdAt).toLocaleString("zh-CN")} /><InfoRow label="训练类型" value={loraTypeLabel(job.type)} /><InfoRow label="训练轮次" value={`${job.parameters.epochs} Epoch · ${job.parameters.repeats} 次重复`} /><InfoRow label="Rank / Alpha" value={`${job.parameters.rank} / ${job.parameters.alpha}`} /><InfoRow label="分辨率" value={`${job.parameters.resolution}px`} /></dl><div><strong>触发词</strong><p>{job.triggerWords.join(", ") || "未设置"}</p><label><span>复制为新训练集</span><input value={copyTitle} maxLength={191} onChange={(event) => onCopyTitle(event.target.value)} /></label><button className="primary" disabled={copying || !copyTitle.trim()} onClick={onCopy}>{copying ? <LoaderCircle className="spin" /> : <Copy />}{copying ? "正在复制" : "创建可编辑副本"}</button></div></div>{loading && <div className="repository-detail-empty"><LoaderCircle className="spin" />正在读取冻结快照</div>}{snapshot && <details className="repository-training-snapshot"><summary>查看完整快照 · {snapshot.assets.length} 张图片</summary><div>{snapshot.assets.map((asset) => <article key={`${asset.sequence}-${asset.sha256}`}><img loading="lazy" decoding="async" src={convertFileSrc(asset.path)} alt={asset.fileName} /><div><strong>{asset.fileName}</strong><small>{formatBytes(asset.byteSize)} · {asset.sha256.slice(0, 12)}</small><p>{asset.tags.map((tag) => `${tag.value} [${trainingTagSourceLabel(tag.source)}]`).join(", ")}</p></div></article>)}</div></details>}</section>;
}

function RepositoryCover({ path, fallback, compact = false }: { path: string | null; fallback: string; compact?: boolean }) {
  // 列表卡片只解码主封面；完整示例仅在详情页按需读取，避免仓库首屏创建大量图片图层。
  const examples = path ? compact ? [path] : repositoryExamplePaths.get(path) || [path] : [];
  const hideBrokenImage = (event: React.SyntheticEvent<HTMLImageElement>) => { event.currentTarget.style.display = "none"; };
  return <div className={`repository-cover ${compact ? "is-compact" : ""} ${examples.length > 1 ? "has-examples" : ""}`} aria-label={path ? "仓库图片" : `${fallback} 默认封面`}><div className="repository-cover-fallback"><Image /><span>{fallback}</span></div>{path && <>{!compact && <img className="blur" decoding="async" src={convertFileSrc(path)} alt="" onError={hideBrokenImage} />}<div className="repository-cover-slides">{examples.map((example, index) => <img key={example} loading={compact || index > 0 ? "lazy" : "eager"} decoding="async" style={{ animationDelay: `${index * 2.8}s`, animationDuration: `${examples.length * 2.8}s` }} src={convertFileSrc(example)} alt="" onError={hideBrokenImage} />)}</div></>}</div>;
}
function RepositoryHint({ text }: { text: string }) { return <section className="repository-hint"><ShieldCheck /><span>{text}</span></section>; }
function RepositoryEmpty({ text }: { text: string }) { return <section className="repository-empty"><PackageOpen /><strong>{text}</strong><span>可调整筛选、连接账号或导入本机文件。</span></section>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>; }

/** 仓库详情按原始顺序完整展示主站缓存的示例图，本机离线时继续使用已缓存文件。 */
function RepositoryExamples({ paths, title }: { paths: string[]; title: string }) { return <section className="repository-detail-media"><header><Image /><div><span>EXAMPLES</span><h3>{title}</h3></div><small>{paths.length} 张</small></header>{paths.length ? <div className="repository-example-grid">{paths.map((path, index) => <article key={path}><img loading={index < 2 ? "eager" : "lazy"} decoding="async" src={convertFileSrc(path)} alt={`${title} ${index + 1}`} /></article>)}</div> : <div className="repository-detail-empty">当前条目暂无示例图片</div>}</section>; }

/** 仓库引用任务只读取本机 SQLite 任务快照，不依赖实时标题或远端任务接口。 */
function RelatedJobs({ jobs, title }: { jobs: DesktopLocalJobView[]; title: string }) { return <section className="repository-related-jobs"><header><HardDrive /><div><span>LOCAL USAGE</span><h3>{title}</h3></div><small>{jobs.length} 项</small></header>{jobs.length ? <div>{jobs.slice(0, 12).map((job) => <article key={job.id}>{job.artifact ? <img loading="lazy" decoding="async" src={convertFileSrc(job.artifact.path)} alt={job.prompt.slice(0, 80)} /> : <div className="repository-job-fallback"><Image /></div>}<span><strong>{job.prompt}</strong><small>{job.modelDisplayName} · {job.parameters.width}×{job.parameters.height} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small></span><b>{job.status === "succeeded" ? "已完成" : job.status === "running" ? "生成中" : job.status === "queued" ? "排队中" : job.status === "failed" ? "失败" : "已取消"}</b></article>)}</div> : <div className="repository-detail-empty">当前还没有引用任务</div>}</section>; }

function ModelImportDialog({ onClose, onImported, onError }: { onClose: () => void; onImported: (model: DesktopLocalModelView) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState<DesktopLocalModelImportInput>({ displayName: "", family: "anima", workflowKind: "anima", modelSourcePath: "", textEncoderSourcePath: null, vaeSourcePath: null });
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const choose = async (field: "modelSourcePath" | "textEncoderSourcePath" | "vaeSourcePath") => { const selected = await open({ multiple: false, directory: false, filters: [{ name: "SafeTensors", extensions: ["safetensors"] }] }); if (typeof selected === "string") setForm((current) => ({ ...current, [field]: selected })); };
  const chooseModel = async () => { const selected = await open({ multiple: false, directory: false, filters: [{ name: "Anima SafeTensors", extensions: ["safetensors"] }] }); if (typeof selected === "string") { const name = selected.split(/[\\/]/).pop()?.replace(/\.safetensors$/i, "") || "Anima 模型"; setForm((current) => ({ ...current, modelSourcePath: selected, displayName: current.displayName.trim() || name })); } };
  const customComponentsReady = !advanced || (!form.textEncoderSourcePath && !form.vaeSourcePath) || Boolean(form.textEncoderSourcePath && form.vaeSourcePath);
  const ready = Boolean(form.displayName.trim() && form.modelSourcePath && customComponentsReady);
  const submit = async () => { if (!ready || busy) return; setBusy(true); try { onImported(await importDesktopLocalModel(form)); } catch (error) { onError(errorMessage(error)); } finally { setBusy(false); } };
  return <RepositoryDialog title="添加 Anima 底模" description="选择一个 Anima 主模型即可；已初始化的 Qwen 文本编码器和 VAE 会自动复用。" locked={busy} onClose={onClose}><div className="repository-model-import"><FileField label="Anima 底模文件" value={form.modelSourcePath} onPick={() => void chooseModel()} /><label><span>模型名称</span><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="选择文件后自动填写" /></label><button type="button" className={`repository-advanced-toggle ${advanced ? "active" : ""}`} onClick={() => setAdvanced((value) => !value)}><Settings2 />高级组件<ChevronRight /></button>{advanced && <div className="repository-advanced-fields"><p>留空时复用初始化安装的共享组件；自定义时必须同时选择两项。</p><FileField label="自定义文本编码器" value={form.textEncoderSourcePath || ""} onPick={() => void choose("textEncoderSourcePath")} /><FileField label="自定义 VAE" value={form.vaeSourcePath || ""} onPick={() => void choose("vaeSourcePath")} /></div>}</div><DialogActions busy={busy} ready={ready} onClose={onClose} onSubmit={() => void submit()} /></RepositoryDialog>;
}

function LoraImportDialog({ onClose, onImported, onError }: { onClose: () => void; onImported: (lora: DesktopLocalLoraView) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState<DesktopLocalLoraImportInput>({ title: "", type: "style", sourcePath: "", triggerWords: [] });
  const [triggerText, setTriggerText] = useState("");
  const [busy, setBusy] = useState(false);
  const choose = async () => { const selected = await open({ multiple: false, directory: false, filters: [{ name: "SafeTensors", extensions: ["safetensors"] }] }); if (typeof selected === "string") setForm((current) => ({ ...current, sourcePath: selected })); };
  const ready = Boolean(form.title.trim() && form.sourcePath);
  const submit = async () => { if (!ready || busy) return; setBusy(true); try { onImported(await importDesktopLocalLora({ ...form, triggerWords: triggerText.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean) })); } catch (error) { onError(errorMessage(error)); } finally { setBusy(false); } };
  return <RepositoryDialog title="导入本机 LoRA" description="支持角色、画风、服装、姿势等类型，导入后立即出现在生成页。" locked={busy} onClose={onClose}><div className="repository-form-grid"><label><span>标题</span><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="输入容易辨认的名称" /></label><label><span>类型</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as DesktopLocalLoraImportInput["type"] })}>{["style", "character", "concept", "clothing", "pose", "other"].map((value) => <option key={value} value={value}>{loraTypeLabel(value)}</option>)}</select></label><label className="wide"><span>触发词</span><input value={triggerText} onChange={(event) => setTriggerText(event.target.value)} placeholder="多个触发词使用英文逗号分隔" /></label><FileField label="LoRA 文件" value={form.sourcePath} onPick={() => void choose()} /></div><DialogActions busy={busy} ready={ready} onClose={onClose} onSubmit={() => void submit()} /></RepositoryDialog>;
}
function RepositoryDialog({ title, description, locked = false, onClose, children }: { title: string; description: string; locked?: boolean; onClose: () => void; children: ReactNode }) { return <div className="repository-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !locked) onClose(); }}><section className="repository-dialog" role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2><p>{description}</p></div><button disabled={locked} title={locked ? "文件操作完成前不能关闭" : "关闭窗口"} onClick={onClose} aria-label="关闭"><X /></button></header>{children}</section></div>; }
function FileField({ label, value, onPick }: { label: string; value: string; onPick: () => void }) { return <label className="repository-file-field wide"><span>{label}</span><div><input readOnly value={value} placeholder="选择 .safetensors 文件" /><button onClick={onPick}>选择文件</button></div></label>; }
function DialogActions({ busy, ready, onClose, onSubmit }: { busy: boolean; ready: boolean; onClose: () => void; onSubmit: () => void }) { return <footer className="repository-dialog-actions"><button disabled={busy} title={busy ? "正在校验并导入，完成前不能关闭" : "取消本次导入"} onClick={onClose}>取消</button><button className="primary" disabled={!ready || busy} title={busy ? "文件正在校验并导入，请勿重复提交" : !ready ? "请完整填写名称并选择有效的 safetensors 文件" : "校验文件并导入本机仓库"} onClick={onSubmit}>{busy ? <LoaderCircle className="spin" /> : <Download />}{busy ? "正在校验并导入" : "确认导入"}</button></footer>; }

function mergeModelEntries(models: DesktopLocalModelView[], websiteModels: DesktopWebsiteModelView[]): ModelRepositoryEntry[] {
  // 本机缓存路径在列表和详情页之间稳定复用，坏图已由 Rust 核心逐张跳过。
  for (const website of websiteModels) if (website.coverPath) repositoryExamplePaths.set(website.coverPath, website.examplePaths.length ? website.examplePaths : [website.coverPath]);
  const usedLocal = new Set<string>();
  const entries: ModelRepositoryEntry[] = websiteModels.map((website) => {
    // 主站缺少可下载版本或旧登记缺少资源组时，使用系列、工作流和精确文件名补全稳定身份，禁止退化为标题匹配。
    const local = models.find((item) => (website.resourceGroupId && item.resourceGroupId === website.resourceGroupId) || (website.download && item.modelSha256.toLowerCase() === website.download.sha256.toLowerCase()) || (item.family.toLocaleLowerCase() === website.family.toLocaleLowerCase() && item.workflowKind.toLocaleLowerCase() === website.runtimeFormat.toLocaleLowerCase() && item.modelFileName.toLocaleLowerCase() === website.modelFileName.toLocaleLowerCase())) || null;
    if (local) usedLocal.add(local.id);
    return { key: `web:${website.id}`, displayName: website.displayName, description: website.description, family: website.family, familyName: website.familyName, fileName: website.modelFileName, coverPath: website.coverPath, local, website };
  });
  // 只有在线目录和用户本机导入记录可以外显，签名依赖清单不会形成第二套仓库。
  for (const local of models) { if (usedLocal.has(local.id)) continue; entries.push({ key: `local:${local.id}`, displayName: local.displayName, description: local.available ? "本机导入并完成文件校验的底模。" : "登记文件缺失或已经变化，请重新导入。", family: local.family, familyName: local.family, fileName: local.modelFileName, coverPath: null, local, website: null }); }
  return entries.sort((left, right) => Number(Boolean(right.local?.available)) - Number(Boolean(left.local?.available)) || left.displayName.localeCompare(right.displayName, "zh-CN"));
}

function mergeLoraEntries(loras: DesktopLocalLoraView[], websiteLoras: DesktopWebsiteLoraView[]): LoraRepositoryEntry[] {
  // LoRA 与底模共用示例图索引，首图仍是封面，其余图片按原顺序轮播。
  for (const website of websiteLoras) if (website.coverPath) repositoryExamplePaths.set(website.coverPath, website.examplePaths.length ? website.examplePaths : [website.coverPath]);
  const usedLocal = new Set<string>();
  const entries: LoraRepositoryEntry[] = websiteLoras.map((website) => { const local = loras.find((item) => item.sha256 === website.sha256) || null; if (local) usedLocal.add(local.id); return { key: `web:${website.id}`, title: website.title, description: website.description, type: website.type, modelFamilyName: website.modelFamilyName, coverPath: website.coverPath, local, website }; });
  for (const local of loras) { if (!usedLocal.has(local.id)) entries.push({ key: `local:${local.id}`, title: local.title, description: local.triggerWords.join(", "), type: local.type, modelFamilyName: "本机模型", coverPath: null, local, website: null }); }
  return entries.sort((left, right) => Number(Boolean(right.local?.available)) - Number(Boolean(left.local?.available)) || left.title.localeCompare(right.title, "zh-CN"));
}

/** 所有仓库底模均使用主站目录下载事件计算进度，不再依赖签名资源组。 */
function websiteModelProgress(progress?: DesktopWebsiteModelInstallProgress): { percent: number | null; label: string } {
  if (!progress) return { percent: null, label: "等待下载" };
  const percent = Math.min(100, Math.round(progress.downloadedBytes / Math.max(1, progress.totalBytes) * 100));
  const label = { downloading: "正在下载", verifying: "正在校验", installing: "正在安装", installed: "安装完成", failed: "安装失败" }[progress.status];
  return { percent, label };
}

function searchable(value: string, query: string): boolean { return !query.trim() || value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()); }
function joinPath(root: string, ...segments: string[]): string { const separator = root.includes("\\") ? "\\" : "/"; return [root.replace(/[\\/]$/, ""), ...segments.filter(Boolean)].join(separator); }
function loraTypeLabel(type: string): string { return { style: "画风", character: "角色", concept: "概念", clothing: "服装", pose: "姿势", other: "其他" }[type] || "其他"; }
/** 标签来源名称与训练集编辑页保持一致，快照中不丢失审计语义。 */
function trainingTagSourceLabel(source: string): string { return { auto: "自动", ai_cleaned: "AI 清洗", manual: "手动", imported: "导入", trigger: "触发词" }[source] || source; }
function loraProgressLabel(progress: DesktopWebsiteLoraInstallProgress): string { return { downloading: "正在下载", verifying: "正在校验", installing: "正在安装", installed: "安装完成", failed: "安装失败" }[progress.status] || progress.status; }
function formatBytes(bytes: number): string { if (!bytes) return "大小未知"; const units = ["B", "KiB", "MiB", "GiB"]; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
