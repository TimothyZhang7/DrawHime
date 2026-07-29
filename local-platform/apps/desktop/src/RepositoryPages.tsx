/**
 * 本文件实现桌面底模与 LoRA 仓库的合并卡片、详情、下载状态和本机导入界面。
 */
import type { DesktopLocalLoraImportInput, DesktopLocalLoraView, DesktopLocalModelImportInput, DesktopLocalModelView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopWebsiteLoraInstallProgress, DesktopWebsiteLoraView, DesktopWebsiteModelView } from "@drawhime/contracts";
import { ArrowLeft, CheckCircle2, ChevronRight, Copy, Database, Download, FolderCog, HardDrive, Image, Layers3, LoaderCircle, PackageOpen, Plus, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useMemo, useState, type ReactNode } from "react";
import { importDesktopLocalLora, importDesktopLocalModel } from "./desktop-api";

type ResourceItem = DesktopResourceCatalogView["resources"][number];

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
  groupId: string | null;
  resources: ResourceItem[];
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

/** 合并主站底模、签名安装资源和本机登记记录，避免同一模型重复展示。 */
export function ModelRepositoryPage({ models, websiteModels, catalog, downloadProgress, installProgress, accountConnected, modelRoot, busyGroupId, onRefresh, onInstallGroup, onImported, onOpenSettings, onError }: { models: DesktopLocalModelView[]; websiteModels: DesktopWebsiteModelView[]; catalog: DesktopResourceCatalogView | null; downloadProgress: Record<string, DesktopResourceDownloadView>; installProgress: Record<string, DesktopResourceInstallView>; accountConnected: boolean; modelRoot: string; busyGroupId: string | null; onRefresh: () => void; onInstallGroup: (groupId: string, resourceIds: string[]) => void; onImported: (model: DesktopLocalModelView) => void; onOpenSettings: () => void; onError: (message: string) => void }) {
  const entries = useMemo(() => mergeModelEntries(models, websiteModels, catalog), [models, websiteModels, catalog]);
  const [query, setQuery] = useState("");
  const [localOnly, setLocalOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const selected = entries.find((entry) => entry.key === selectedKey) || null;
  const filtered = entries.filter((entry) => (!localOnly || Boolean(entry.local?.available)) && searchable(`${entry.displayName} ${entry.description} ${entry.familyName} ${entry.fileName}`, query));
  if (selected) return <ModelDetail entry={selected} modelRoot={modelRoot} busy={busyGroupId === selected.groupId} progress={modelGroupProgress(selected.resources, downloadProgress, installProgress)} onBack={() => setSelectedKey(null)} onInstall={() => selected.groupId && onInstallGroup(selected.groupId, selected.resources.map((resource) => resource.id))} onOpenSettings={onOpenSettings} />;
  return <div className="desktop-page repository-page">
    <RepositoryToolbar title="底模仓库" count={filtered.length} query={query} localOnly={localOnly} accountConnected={accountConnected} onQuery={setQuery} onLocalOnly={setLocalOnly} onRefresh={onRefresh} onImport={() => setImportOpen(true)} />
    {!accountConnected && <RepositoryHint text="连接绘图姬账号后会同步网页底模的封面、说明和推荐参数；已签名安装资源与本地模型仍可正常管理。" />}
    {filtered.length ? <section className="repository-grid">{filtered.map((entry) => {
      const progress = modelGroupProgress(entry.resources, downloadProgress, installProgress);
      const installable = Boolean(entry.groupId && entry.resources.length);
      const local = Boolean(entry.local?.available);
      const byteSize = entry.resources.length ? entry.resources.reduce((total, resource) => total + resource.byteSize, 0) : entry.local?.byteSize || 0;
      const missingBytes = entry.resources.filter((resource) => !resource.installed).reduce((total, resource) => total + resource.byteSize, 0);
      const subtitle = local ? `${entry.familyName} · ${formatBytes(byteSize)}` : installable ? `${entry.familyName} · 需下载 ${formatBytes(missingBytes)}` : `${entry.familyName} · ${formatBytes(byteSize)}`;
      return <RepositoryCard key={entry.key} title={entry.displayName} subtitle={subtitle} description={entry.description} coverPath={entry.coverPath} fallback="MODEL" local={local} secondaryTag={entry.website ? "主站" : entry.groupId ? "签名资源" : "本机导入"} onOpen={() => setSelectedKey(entry.key)} action={local ? { kind: "local", label: "已在本地", disabled: true, onClick: () => undefined } : installable ? { kind: "download", label: busyGroupId === entry.groupId ? progress.label : "下载并安装", disabled: Boolean(busyGroupId), loading: busyGroupId === entry.groupId, onClick: () => onInstallGroup(entry.groupId!, entry.resources.map((resource) => resource.id)) } : { kind: "view", label: "查看详情", disabled: false, onClick: () => setSelectedKey(entry.key) }} progress={progress.percent} />;
    })}</section> : <RepositoryEmpty text={query || localOnly ? "没有符合当前筛选条件的底模" : "当前仓库还没有可展示的底模"} />}
    {importOpen && <ModelImportDialog onClose={() => setImportOpen(false)} onImported={(model) => { onImported(model); setImportOpen(false); }} onError={onError} />}
  </div>;
}

/** 合并主站与本机 LoRA，以版本 SHA-256 作为安装状态的唯一判断依据。 */
export function LoraRepositoryPage({ loras, websiteLoras, progress, accountConnected, modelRoot, onRefresh, onInstall, onImported, onError }: { loras: DesktopLocalLoraView[]; websiteLoras: DesktopWebsiteLoraView[]; progress: Record<string, DesktopWebsiteLoraInstallProgress>; accountConnected: boolean; modelRoot: string; onRefresh: () => void; onInstall: (id: string) => void; onImported: (lora: DesktopLocalLoraView) => void; onError: (message: string) => void }) {
  const entries = useMemo(() => mergeLoraEntries(loras, websiteLoras), [loras, websiteLoras]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [localOnly, setLocalOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const selected = entries.find((entry) => entry.key === selectedKey) || null;
  const filtered = entries.filter((entry) => (type === "all" || entry.type === type) && (!localOnly || Boolean(entry.local?.available)) && searchable(`${entry.title} ${entry.description} ${entry.modelFamilyName} ${entry.website?.triggerWords.join(" ") || entry.local?.triggerWords.join(" ") || ""}`, query));
  if (selected) return <LoraDetail entry={selected} modelRoot={modelRoot} progress={selected.website ? progress[selected.website.id] : undefined} onBack={() => setSelectedKey(null)} onInstall={() => selected.website && onInstall(selected.website.id)} />;
  return <div className="desktop-page repository-page">
    <RepositoryToolbar title="LoRA 仓库" count={filtered.length} query={query} localOnly={localOnly} accountConnected={accountConnected} onQuery={setQuery} onLocalOnly={setLocalOnly} onRefresh={onRefresh} onImport={() => setImportOpen(true)} extra={<select aria-label="LoRA 类型" value={type} onChange={(event) => setType(event.target.value)}><option value="all">全部类型</option>{["style", "character", "concept", "clothing", "pose", "other"].map((value) => <option key={value} value={value}>{loraTypeLabel(value)}</option>)}</select>} />
    {!accountConnected && <RepositoryHint text="连接绘图姬账号后可浏览公开 LoRA 和自己的私有 LoRA，并直接断点下载；本机仓库和生成能力不受网络影响。" />}
    {filtered.length ? <section className="repository-grid">{filtered.map((entry) => {
      const current = entry.website ? progress[entry.website.id] : undefined;
      const running = Boolean(current && ["downloading", "verifying", "installing"].includes(current.status));
      const percent = current ? Math.min(100, Math.round(current.downloadedBytes / Math.max(1, current.totalBytes) * 100)) : null;
      const local = Boolean(entry.local?.available);
      return <RepositoryCard key={entry.key} title={entry.title} subtitle={`${loraTypeLabel(entry.type)} · ${entry.modelFamilyName}`} description={entry.description || entry.website?.triggerWords.join(", ") || entry.local?.triggerWords.join(", ") || "未填写说明"} coverPath={entry.coverPath} fallback="LORA" local={local} secondaryTag={entry.website?.privacy === "private" ? "私有" : entry.website ? "主站" : "本机导入"} onOpen={() => setSelectedKey(entry.key)} action={local ? { kind: "local", label: "已在本地", disabled: true, onClick: () => undefined } : entry.website ? { kind: "download", label: running ? loraProgressLabel(current!) : `下载 · ${formatBytes(entry.website.byteSize)}`, disabled: running, loading: running, onClick: () => onInstall(entry.website!.id) } : { kind: "view", label: "查看详情", disabled: false, onClick: () => setSelectedKey(entry.key) }} progress={percent} />;
    })}</section> : <RepositoryEmpty text={query || localOnly || type !== "all" ? "没有符合当前筛选条件的 LoRA" : "当前仓库还没有可展示的 LoRA"} />}
    {importOpen && <LoraImportDialog onClose={() => setImportOpen(false)} onImported={(lora) => { onImported(lora); setImportOpen(false); }} onError={onError} />}
  </div>;
}

function RepositoryToolbar({ title, count, query, localOnly, accountConnected, onQuery, onLocalOnly, onRefresh, onImport, extra }: { title: string; count: number; query: string; localOnly: boolean; accountConnected: boolean; onQuery: (value: string) => void; onLocalOnly: (value: boolean) => void; onRefresh: () => void; onImport: () => void; extra?: ReactNode }) {
  return <section className="repository-toolbar"><div className="repository-heading"><div><span>LOCAL LIBRARY</span><h2>{title}</h2></div><b>{count}</b></div><div className="repository-controls"><label className="repository-search"><Search /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索名称、系列或说明" /></label>{extra}<label className="repository-local-filter"><input type="checkbox" checked={localOnly} onChange={(event) => onLocalOnly(event.target.checked)} /><span>仅看本地</span></label><button title={accountConnected ? "刷新主站仓库" : "刷新本地仓库"} onClick={onRefresh}><RefreshCw />刷新</button><button className="primary" onClick={onImport}><Plus />导入本机文件</button></div></section>;
}

function RepositoryCard({ title, subtitle, description, coverPath, fallback, local, secondaryTag, onOpen, action, progress }: { title: string; subtitle: string; description: string; coverPath: string | null; fallback: string; local: boolean; secondaryTag: string; onOpen: () => void; action: { kind: "local" | "download" | "view"; label: string; disabled: boolean; loading?: boolean; onClick: () => void }; progress: number | null }) {
  return <article className="repository-card" tabIndex={0} role="button" onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpen(); }}><RepositoryCover path={coverPath} fallback={fallback} /><div className="repository-card-tags">{local && <b><CheckCircle2 />本地</b>}<i>{secondaryTag}</i></div><div className="repository-card-copy"><strong>{title}</strong><span>{subtitle}</span><p>{description}</p></div>{progress !== null && <div className="repository-card-progress"><i style={{ width: `${progress}%` }} /></div>}<button className={`is-${action.kind}`} disabled={action.disabled} onClick={(event) => { event.stopPropagation(); action.onClick(); }}>{action.loading ? <LoaderCircle className="spin" /> : action.kind === "local" ? <CheckCircle2 /> : action.kind === "download" ? <Download /> : <ChevronRight />}{action.label}</button></article>;
}

function ModelDetail({ entry, modelRoot, busy, progress, onBack, onInstall, onOpenSettings }: { entry: ModelRepositoryEntry; modelRoot: string; busy: boolean; progress: { percent: number | null; label: string }; onBack: () => void; onInstall: () => void; onOpenSettings: () => void }) {
  const local = Boolean(entry.local?.available);
  const website = entry.website;
  const runtimeFormat = website?.runtimeFormat || entry.local?.workflowKind || "Anima";
  const missingBytes = entry.resources.filter((resource) => !resource.installed).reduce((total, resource) => total + resource.byteSize, 0);
  return <div className="desktop-page repository-detail"><button className="repository-back" onClick={onBack}><ArrowLeft />返回底模仓库</button><section className="repository-detail-hero"><RepositoryCover path={entry.coverPath} fallback="MODEL" /><div className="repository-detail-summary"><div className="repository-detail-tags">{local && <b>已在本地</b>}<i>{entry.familyName}</i>{runtimeFormat.toLocaleLowerCase() !== entry.familyName.toLocaleLowerCase() && <i>{runtimeFormat}</i>}</div><h1>{entry.displayName}</h1><p>{entry.description}</p><div className="repository-detail-actions">{local ? <button disabled><CheckCircle2 />已安装，可直接生成</button> : entry.groupId ? <button className="primary" disabled={busy} onClick={onInstall}>{busy ? <LoaderCircle className="spin" /> : <Download />}{busy ? progress.label : `下载并安装 · ${formatBytes(missingBytes)}`}</button> : <button onClick={onOpenSettings}><FolderCog />设置模型目录</button>}</div>{progress.percent !== null && <div className="repository-detail-progress"><i style={{ width: `${progress.percent}%` }} /><span>{progress.label} · {progress.percent}%</span></div>}</div></section><section className="repository-detail-grid"><article><header><ShieldCheck /><strong>模型信息</strong></header><dl><InfoRow label="模型系列" value={entry.familyName} /><InfoRow label="文件名称" value={entry.fileName} /><InfoRow label="本机状态" value={local ? "文件校验通过" : entry.groupId ? "可从签名资源安装" : "仅提供仓库信息"} /><InfoRow label="待下载" value={local ? "无需下载" : entry.groupId ? formatBytes(missingBytes) : "未提供安装资源"} /><InfoRow label="存储目录" value={modelRoot} /></dl></article><article><header><HardDrive /><strong>推荐参数</strong></header><dl><InfoRow label="步数" value={String(website?.parameters.steps ?? "-")} /><InfoRow label="CFG" value={String(website?.parameters.cfg ?? "-")} /><InfoRow label="采样器" value={website?.parameters.sampler || "-"} /><InfoRow label="调度器" value={website?.parameters.scheduler || "-"} /></dl></article></section>{website?.usageGuide && <section className="repository-detail-copy"><h3>使用说明</h3><p>{website.usageGuide}</p></section>}{website?.sourceLinks.length ? <section className="repository-detail-copy"><h3>模型来源</h3><div className="repository-source-list">{website.sourceLinks.map((source) => <button key={source.url} onClick={() => void navigator.clipboard.writeText(source.url)}><Copy />复制 {source.label}</button>)}</div></section> : null}</div>;
}

function LoraDetail({ entry, modelRoot, progress, onBack, onInstall }: { entry: LoraRepositoryEntry; modelRoot: string; progress?: DesktopWebsiteLoraInstallProgress; onBack: () => void; onInstall: () => void }) {
  const local = Boolean(entry.local?.available);
  const running = Boolean(progress && ["downloading", "verifying", "installing"].includes(progress.status));
  const percent = progress ? Math.min(100, Math.round(progress.downloadedBytes / Math.max(1, progress.totalBytes) * 100)) : null;
  const triggers = entry.website?.triggerWords || entry.local?.triggerWords || [];
  return <div className="desktop-page repository-detail"><button className="repository-back" onClick={onBack}><ArrowLeft />返回 LoRA 仓库</button><section className="repository-detail-hero"><RepositoryCover path={entry.coverPath} fallback="LORA" /><div className="repository-detail-summary"><div className="repository-detail-tags">{local && <b>已在本地</b>}<i>{loraTypeLabel(entry.type)}</i>{entry.website?.privacy === "private" && <i>私有</i>}</div><h1>{entry.title}</h1><p>{entry.description || "当前条目未填写详细说明。"}</p><div className="repository-detail-actions">{local ? <button disabled><CheckCircle2 />已安装，可用于生成</button> : entry.website ? <button className="primary" disabled={running} onClick={onInstall}>{running ? <LoaderCircle className="spin" /> : <Download />}{running ? loraProgressLabel(progress!) : `下载到本机 · ${formatBytes(entry.website.byteSize)}`}</button> : null}</div>{percent !== null && <div className="repository-detail-progress"><i style={{ width: `${percent}%` }} /><span>{loraProgressLabel(progress!)} · {percent}%</span></div>}</div></section><section className="repository-detail-grid"><article><header><Layers3 /><strong>LoRA 信息</strong></header><dl><InfoRow label="类型" value={loraTypeLabel(entry.type)} /><InfoRow label="适用底模" value={entry.modelFamilyName} /><InfoRow label="文件名称" value={entry.website?.fileName || entry.local?.fileName || "-"} /><InfoRow label="文件大小" value={formatBytes(entry.website?.byteSize || entry.local?.byteSize || 0)} /></dl></article><article><header><HardDrive /><strong>本机状态</strong></header><dl><InfoRow label="状态" value={local ? "文件校验通过" : entry.website ? "可从主站下载" : "本地文件发生变化"} /><InfoRow label="存储位置" value={joinPath(modelRoot, "loras", entry.local?.fileName || entry.website?.fileName || "")} /><InfoRow label="作者" value={entry.website?.ownerDisplayName || "本机导入"} /><InfoRow label="更新时间" value={entry.local ? new Date(entry.local.updatedAt).toLocaleString("zh-CN") : "随主站同步"} /></dl></article></section><section className="repository-detail-copy"><h3>触发词</h3>{triggers.length ? <div className="repository-trigger-list">{triggers.map((trigger) => <button key={trigger} onClick={() => void navigator.clipboard.writeText(trigger)}>{trigger}<Copy /></button>)}</div> : <p>该 LoRA 未设置触发词，可直接按说明使用。</p>}</section></div>;
}

function RepositoryCover({ path, fallback }: { path: string | null; fallback: string }) { return <div className="repository-cover">{path ? <><img className="blur" src={convertFileSrc(path)} alt="" /><img src={convertFileSrc(path)} alt="仓库封面" /></> : <div className="repository-cover-fallback"><Image /><span>{fallback}</span></div>}</div>; }
function RepositoryHint({ text }: { text: string }) { return <section className="repository-hint"><ShieldCheck /><span>{text}</span></section>; }
function RepositoryEmpty({ text }: { text: string }) { return <section className="repository-empty"><PackageOpen /><strong>{text}</strong><span>可调整筛选、连接账号或导入本机文件。</span></section>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>; }

function ModelImportDialog({ onClose, onImported, onError }: { onClose: () => void; onImported: (model: DesktopLocalModelView) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState<DesktopLocalModelImportInput>({ displayName: "", family: "anima", workflowKind: "anima", modelSourcePath: "", textEncoderSourcePath: null, vaeSourcePath: null });
  const [busy, setBusy] = useState(false);
  const choose = async (field: "modelSourcePath" | "textEncoderSourcePath" | "vaeSourcePath") => { const selected = await open({ multiple: false, directory: false, filters: [{ name: "SafeTensors", extensions: ["safetensors"] }] }); if (typeof selected === "string") setForm((current) => ({ ...current, [field]: selected })); };
  const ready = Boolean(form.displayName.trim() && form.family.trim() && form.modelSourcePath && (form.workflowKind !== "anima" || (form.textEncoderSourcePath && form.vaeSourcePath)));
  const submit = async () => { if (!ready || busy) return; setBusy(true); try { onImported(await importDesktopLocalModel(form)); } catch (error) { onError(errorMessage(error)); } finally { setBusy(false); } };
  return <RepositoryDialog title="导入本机底模" description="文件会校验哈希并原子复制到当前模型目录，原文件不会被修改。" onClose={onClose}><div className="repository-form-grid"><label><span>显示名称</span><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="例如：Anima Base" /></label><label><span>模型系列</span><input value={form.family} onChange={(event) => setForm({ ...form, family: event.target.value })} placeholder="例如：anima" /></label><label><span>工作流格式</span><select value={form.workflowKind} onChange={(event) => { const workflowKind = event.target.value as DesktopLocalModelImportInput["workflowKind"]; setForm({ ...form, workflowKind, textEncoderSourcePath: workflowKind === "anima" ? form.textEncoderSourcePath : null, vaeSourcePath: workflowKind === "anima" ? form.vaeSourcePath : null }); }}><option value="anima">Anima · UNet + CLIP + VAE</option><option value="checkpoint">Checkpoint · 单文件</option></select></label><FileField label={form.workflowKind === "anima" ? "UNet 文件" : "Checkpoint 文件"} value={form.modelSourcePath} onPick={() => void choose("modelSourcePath")} />{form.workflowKind === "anima" && <><FileField label="文本编码器" value={form.textEncoderSourcePath || ""} onPick={() => void choose("textEncoderSourcePath")} /><FileField label="VAE 文件" value={form.vaeSourcePath || ""} onPick={() => void choose("vaeSourcePath")} /></>}</div><DialogActions busy={busy} ready={ready} onClose={onClose} onSubmit={() => void submit()} /></RepositoryDialog>;
}

function LoraImportDialog({ onClose, onImported, onError }: { onClose: () => void; onImported: (lora: DesktopLocalLoraView) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState<DesktopLocalLoraImportInput>({ title: "", type: "style", sourcePath: "", triggerWords: [] });
  const [triggerText, setTriggerText] = useState("");
  const [busy, setBusy] = useState(false);
  const choose = async () => { const selected = await open({ multiple: false, directory: false, filters: [{ name: "SafeTensors", extensions: ["safetensors"] }] }); if (typeof selected === "string") setForm((current) => ({ ...current, sourcePath: selected })); };
  const ready = Boolean(form.title.trim() && form.sourcePath);
  const submit = async () => { if (!ready || busy) return; setBusy(true); try { onImported(await importDesktopLocalLora({ ...form, triggerWords: triggerText.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean) })); } catch (error) { onError(errorMessage(error)); } finally { setBusy(false); } };
  return <RepositoryDialog title="导入本机 LoRA" description="支持角色、画风、服装、姿势等类型，导入后立即出现在生成页。" onClose={onClose}><div className="repository-form-grid"><label><span>标题</span><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="输入容易辨认的名称" /></label><label><span>类型</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as DesktopLocalLoraImportInput["type"] })}>{["style", "character", "concept", "clothing", "pose", "other"].map((value) => <option key={value} value={value}>{loraTypeLabel(value)}</option>)}</select></label><label className="wide"><span>触发词</span><input value={triggerText} onChange={(event) => setTriggerText(event.target.value)} placeholder="多个触发词使用英文逗号分隔" /></label><FileField label="LoRA 文件" value={form.sourcePath} onPick={() => void choose()} /></div><DialogActions busy={busy} ready={ready} onClose={onClose} onSubmit={() => void submit()} /></RepositoryDialog>;
}
function RepositoryDialog({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: ReactNode }) { return <div className="repository-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="repository-dialog" role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2><p>{description}</p></div><button onClick={onClose} aria-label="关闭"><X /></button></header>{children}</section></div>; }
function FileField({ label, value, onPick }: { label: string; value: string; onPick: () => void }) { return <label className="repository-file-field wide"><span>{label}</span><div><input readOnly value={value} placeholder="选择 .safetensors 文件" /><button onClick={onPick}>选择文件</button></div></label>; }
function DialogActions({ busy, ready, onClose, onSubmit }: { busy: boolean; ready: boolean; onClose: () => void; onSubmit: () => void }) { return <footer className="repository-dialog-actions"><button onClick={onClose}>取消</button><button className="primary" disabled={!ready || busy} onClick={onSubmit}>{busy ? <LoaderCircle className="spin" /> : <Download />}{busy ? "正在校验并导入" : "确认导入"}</button></footer>; }

function mergeModelEntries(models: DesktopLocalModelView[], websiteModels: DesktopWebsiteModelView[], catalog: DesktopResourceCatalogView | null): ModelRepositoryEntry[] {
  const groups = new Map<string, ResourceItem[]>();
  for (const resource of catalog?.resources || []) { const groupId = resource.modelRegistration?.groupId; if (groupId) groups.set(groupId, [...(groups.get(groupId) || []), resource]); }
  const usedLocal = new Set<string>();
  const usedGroups = new Set<string>();
  const entries: ModelRepositoryEntry[] = websiteModels.map((website) => {
    const local = models.find((item) => item.modelFileName.toLowerCase() === website.modelFileName.toLowerCase() || item.displayName.toLowerCase() === website.displayName.toLowerCase()) || null;
    if (local) usedLocal.add(local.id);
    const group = [...groups.entries()].find(([, resources]) => resources.some((resource) => resource.modelRegistration?.role === "primary" && (resource.fileName.toLowerCase() === website.modelFileName.toLowerCase() || resource.modelRegistration.displayName.toLowerCase() === website.displayName.toLowerCase()))) || null;
    if (group) usedGroups.add(group[0]);
    return { key: `web:${website.id}`, displayName: website.displayName, description: website.description, family: website.family, familyName: website.familyName, fileName: website.modelFileName, coverPath: website.coverPath, local, website, groupId: group?.[0] || null, resources: group?.[1] || [] };
  });
  for (const [groupId, resources] of groups) { if (usedGroups.has(groupId)) continue; const registration = resources[0]?.modelRegistration; if (!registration) continue; const local = models.find((item) => item.displayName.toLowerCase() === registration.displayName.toLowerCase()) || null; if (local) usedLocal.add(local.id); entries.push({ key: `group:${groupId}`, displayName: registration.displayName, description: "经过签名清单验证的底模资源，可直接下载并安装到当前模型目录。", family: registration.family, familyName: registration.family, fileName: resources.find((resource) => resource.modelRegistration?.role === "primary")?.fileName || "", coverPath: null, local, website: null, groupId, resources }); }
  for (const local of models) { if (usedLocal.has(local.id)) continue; entries.push({ key: `local:${local.id}`, displayName: local.displayName, description: local.available ? "本机导入并完成文件校验的底模。" : "登记文件缺失或已经变化，请重新导入。", family: local.family, familyName: local.family, fileName: local.modelFileName, coverPath: null, local, website: null, groupId: null, resources: [] }); }
  return entries.sort((left, right) => Number(Boolean(right.local?.available)) - Number(Boolean(left.local?.available)) || left.displayName.localeCompare(right.displayName, "zh-CN"));
}

function mergeLoraEntries(loras: DesktopLocalLoraView[], websiteLoras: DesktopWebsiteLoraView[]): LoraRepositoryEntry[] {
  const usedLocal = new Set<string>();
  const entries: LoraRepositoryEntry[] = websiteLoras.map((website) => { const local = loras.find((item) => item.sha256 === website.sha256) || null; if (local) usedLocal.add(local.id); return { key: `web:${website.id}`, title: website.title, description: website.description, type: website.type, modelFamilyName: website.modelFamilyName, coverPath: website.coverPath, local, website }; });
  for (const local of loras) { if (!usedLocal.has(local.id)) entries.push({ key: `local:${local.id}`, title: local.title, description: local.triggerWords.join(", "), type: local.type, modelFamilyName: "本机模型", coverPath: null, local, website: null }); }
  return entries.sort((left, right) => Number(Boolean(right.local?.available)) - Number(Boolean(left.local?.available)) || left.title.localeCompare(right.title, "zh-CN"));
}

function modelGroupProgress(resources: ResourceItem[], downloads: Record<string, DesktopResourceDownloadView>, installs: Record<string, DesktopResourceInstallView>): { percent: number | null; label: string } {
  if (!resources.length) return { percent: null, label: "等待下载" };
  const totalBytes = resources.reduce((total, resource) => total + resource.byteSize, 0);
  const installedBytes = resources.filter((resource) => resource.installed).reduce((total, resource) => total + resource.byteSize, 0);
  const installing = resources.find((resource) => ["verifying", "installing", "switching"].includes(installs[resource.id]?.status));
  if (installing) return { percent: Math.round((installedBytes + installing.byteSize * installs[installing.id]!.progress / 100) / totalBytes * 100), label: "正在安装" };
  const downloading = resources.find((resource) => ["queued", "downloading", "verifying"].includes(downloads[resource.id]?.status));
  if (downloading) { const value = downloads[downloading.id]!; return { percent: Math.round((installedBytes + value.downloadedBytes) / totalBytes * 100), label: value.status === "verifying" ? "正在校验" : "正在下载" }; }
  return { percent: installedBytes ? Math.round(installedBytes / totalBytes * 100) : null, label: installedBytes === totalBytes ? "安装完成" : `已复用 ${formatBytes(installedBytes)}` };
}

function searchable(value: string, query: string): boolean { return !query.trim() || value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()); }
function joinPath(root: string, ...segments: string[]): string { const separator = root.includes("\\") ? "\\" : "/"; return [root.replace(/[\\/]$/, ""), ...segments.filter(Boolean)].join(separator); }
function loraTypeLabel(type: string): string { return { style: "画风", character: "角色", concept: "概念", clothing: "服装", pose: "姿势", other: "其他" }[type] || "其他"; }
function loraProgressLabel(progress: DesktopWebsiteLoraInstallProgress): string { return { downloading: "正在下载", verifying: "正在校验", installing: "正在安装", installed: "安装完成", failed: "安装失败" }[progress.status] || progress.status; }
function formatBytes(bytes: number): string { if (!bytes) return "大小未知"; const units = ["B", "KiB", "MiB", "GiB"]; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
