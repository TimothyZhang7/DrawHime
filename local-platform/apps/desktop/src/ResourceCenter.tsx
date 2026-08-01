/**
 * 本文件集中管理桌面端必需依赖清单、下载队列进度和左下角本地核心状态。
 */
import type { DesktopBootstrapView, DesktopEnvironmentReport, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView } from "@drawhime/contracts";
import { AlertTriangle, CheckCircle2, Download, LoaderCircle, PackageCheck, PackageOpen, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect } from "react";

type ResourceItem = DesktopResourceCatalogView["resources"][number];
type DownloadMap = Record<string, DesktopResourceDownloadView>;
type InstallMap = Record<string, DesktopResourceInstallView>;

const ACTIVE_DOWNLOAD_STATES = new Set(["queued", "downloading", "verifying"]);
const ACTIVE_INSTALL_STATES = new Set(["verifying", "installing", "switching"]);
const HIDDEN_RUNTIME_ISSUES = new Set(["runtime_missing", "runtime_unverified", "generation_model_missing", "captioner_missing", "trainer_missing", "amd_directml_compatibility_mode"]);

/** 资源安装页只纳入服务端签名清单明确标记为必需的依赖，客户端不写死任何底模。 */
export function coreResources(catalog: DesktopResourceCatalogView | null): ResourceItem[] {
  return catalog?.resources.filter((resource) => resource.required) || [];
}

/** 验证当前后端的必需依赖集合，防止只有公共模型却缺少专属 Runtime 时误进初始化。 */
export function coreDependencyProblem(catalog: DesktopResourceCatalogView | null): string | null {
  if (!catalog || !catalog.configured) return null;
  if (catalog.selectedBackend === "unavailable") return "当前未检测到可安装的 NVIDIA CUDA 或 AMD DirectML 后端";
  const required = coreResources(catalog);
  const runtimes = required.filter((resource) => resource.kind === "runtime" && resource.runtimeProfile?.backend === catalog.selectedBackend);
  if (runtimes.length !== 1) return `签名清单缺少唯一的 ${catalog.selectedBackend === "amd_directml" ? "AMD DirectML" : "NVIDIA CUDA"} Runtime`;
  const modelRoles = new Set(required.filter((resource) => resource.kind === "model").map((resource) => resource.modelRegistration?.role));
  if (!["primary", "text_encoder", "vae"].every((role) => modelRoles.has(role as "primary" | "text_encoder" | "vae"))) return "签名清单缺少完整的 Anima Base 主模型、文本编码器或 VAE";
  if (!required.some((resource) => resource.kind === "captioner")) return "签名清单缺少自动打标组件";
  if (catalog.selectedBackend === "nvidia_cuda" && !required.some((resource) => resource.kind === "trainer")) return "NVIDIA CUDA 依赖清单缺少 LoRA Trainer";
  return null;
}

/** Runtime 缺失和等待自检由左下角统一承载，环境页只保留其他真实问题。 */
export function visibleEnvironmentIssues(report: DesktopEnvironmentReport) {
  return report.issues.filter((issue) => !HIDDEN_RUNTIME_ISSUES.has(issue.code));
}

/** 汇总依赖的加载、下载和等待数量，概览页与弹窗使用同一状态口径。 */
export function dependencySummary(resources: ResourceItem[], progress: DownloadMap, installProgress: InstallMap) {
  return resources.reduce((summary, resource) => {
    if (resource.installed) summary.loaded += 1;
    else if (isResourceBusy(resource.id, progress, installProgress)) summary.downloading += 1;
    else summary.waiting += 1;
    return summary;
  }, { loaded: 0, downloading: 0, waiting: 0 });
}

/** 左下角核心状态同时校验硬件、签名清单、必需组件、Anima Base 与 Runtime 自检。 */
export function desktopCoreState(state: DesktopBootstrapView, catalog: DesktopResourceCatalogView | null): { kind: "ready" | "starting" | "missing" | "error"; label: string; detail: string } {
  const critical = visibleEnvironmentIssues(state.environment).find((issue) => issue.severity === "critical");
  if (state.runtime.status === "failed" || state.environment.runtime.status === "broken") return { kind: "error", label: "本地核心错误", detail: state.runtime.error || "Runtime 文件或自检状态异常" };
  if (critical) return { kind: "error", label: "本地核心不可用", detail: critical.title };
  if (!catalog) return { kind: "starting", label: "正在检查本地核心", detail: "正在读取签名依赖清单" };
  if (!catalog.configured) return { kind: "missing", label: "依赖通道未配置", detail: "必需资源清单当前不可用" };
  const dependencyProblem = coreDependencyProblem(catalog);
  if (dependencyProblem) return { kind: "missing", label: "依赖清单不完整", detail: dependencyProblem };
  const required = coreResources(catalog);
  if (required.length === 0) return { kind: "missing", label: "依赖清单不完整", detail: "未找到 Anima Base 或必需组件" };
  const missing = required.filter((resource) => !resource.installed);
  if (missing.length > 0) return { kind: "missing", label: "本地核心未就绪", detail: `缺少 ${missing.length} 项必需依赖` };
  if (["starting", "stopping"].includes(state.runtime.status)) return { kind: "starting", label: state.runtime.status === "starting" ? "本地核心启动中" : "本地核心停止中", detail: "后台进程正在切换状态" };
  if (state.environment.runtime.status === "installed_unverified") return { kind: "missing", label: "本地核心等待自检", detail: "依赖已齐全，请执行一次完整自检" };
  if (state.runtime.status === "ready") return { kind: "ready", label: "本地核心可用", detail: `${state.environment.executionBackend.label}${state.environment.executionBackend.deviceIndex === null ? "" : ` · GPU ${state.environment.executionBackend.deviceIndex}`} 正在运行` };
  return { kind: "ready", label: "本地核心可用", detail: "必需依赖和自检均已完成" };
}

interface ResourceActions {
  onDownload: (resourceId: string) => void;
  onPause: (resourceId: string) => void;
  onInstall: (resourceId: string) => void;
}

interface DependencyListPageProps extends ResourceActions {
  catalog: DesktopResourceCatalogView | null;
  progress: DownloadMap;
  installProgress: InstallMap;
  loading: boolean;
  bulkBusy: boolean;
  onReload: () => void;
  onInstallRequired: () => void;
}

/** 依赖页只展示安装状态与操作，详细传输进度独立放入左下角下载队列弹窗。 */
export function DependencyListPage({ catalog, progress, installProgress, loading, bulkBusy, onReload, onInstallRequired, onDownload, onPause, onInstall }: DependencyListPageProps) {
  const resources = coreResources(catalog);
  const summary = dependencySummary(resources, progress, installProgress);
  const dependencyProblem = coreDependencyProblem(catalog);
  const reloadDisabledReason = loading ? "正在刷新签名依赖清单" : bulkBusy ? "批量依赖操作尚未完成" : null;
  const installDisabledReason = bulkBusy ? "正在处理必需依赖" : !catalog?.configured ? "签名依赖清单当前不可用" : dependencyProblem || (summary.waiting === 0 ? "必需依赖已经全部安装" : null);
  return <div className="desktop-page"><section className="section-card resource-card"><header><div><span>CORE DEPENDENCIES</span><h2>必需依赖清单</h2></div><div className="resource-header-actions"><button className="resource-reload" disabled={Boolean(reloadDisabledReason)} title={reloadDisabledReason || "重新读取签名清单和本机安装状态"} onClick={onReload}>{loading ? <LoaderCircle className="spin" /> : <RefreshCw />}刷新清单</button><button className="resource-install-all" disabled={Boolean(installDisabledReason)} title={installDisabledReason || `串行安装 ${summary.waiting} 项缺失依赖`} onClick={onInstallRequired}>{bulkBusy ? <LoaderCircle className="spin" /> : <Download />}{bulkBusy ? "正在安装" : summary.waiting ? `安装缺失依赖（${summary.waiting}）` : "必需依赖已齐全"}</button></div></header>{!catalog ? <div className="empty-block">正在读取资源发布状态</div> : !catalog.configured ? <UnconfiguredCatalog message={catalog.message} /> : <><div className="dependency-summary"><SummaryItem tone="loaded" label="已加载" value={summary.loaded} /><SummaryItem tone="downloading" label="下载中" value={summary.downloading} /><SummaryItem tone="waiting" label="等待下载" value={summary.waiting} /></div><div className="resource-channel-status"><ShieldCheck /><span><strong>{dependencyProblem || catalog.message}</strong><small>{dependencyProblem ? "请刷新清单或等待对应后端 Runtime 发布，客户端不会安装其他显卡的依赖。" : "仅列出 Runtime、自动打标、训练组件与 Anima Base；其他资源请前往对应仓库安装。"}</small></span></div>{resources.length ? <div className="resource-list dependency-list">{resources.map((resource) => <DependencyRow key={resource.id} resource={resource} current={progress[resource.id]} installing={installProgress[resource.id]} bulkBusy={bulkBusy} onDownload={onDownload} onPause={onPause} onInstall={onInstall} />)}</div> : <div className="empty-block">签名目录缺少适用于当前设备的必需依赖</div>}</>}</section></div>;
}

interface DownloadQueueDialogProps extends ResourceActions {
  open: boolean;
  catalog: DesktopResourceCatalogView | null;
  progress: DownloadMap;
  installProgress: InstallMap;
  bulkBusy: boolean;
  onClose: () => void;
}

/** 下载队列弹窗集中展示断点、速度、预计耗时、来源和安装进度。 */
export function DownloadQueueDialog({ open, catalog, progress, installProgress, bulkBusy, onClose, onDownload, onPause, onInstall }: DownloadQueueDialogProps) {
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);
  if (!open) return null;
  const resources = coreResources(catalog).filter((resource) => progress[resource.id] || installProgress[resource.id]);
  return <div className="resource-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="resource-dialog" role="dialog" aria-modal="true" aria-label="下载队列"><header><div><span>DOWNLOAD QUEUE</span><h2>下载队列与进度</h2></div><button className="resource-dialog-close" onClick={onClose} aria-label="关闭下载队列"><X /></button></header><div className="resource-dialog-body">{resources.length ? resources.map((resource) => <QueueRow key={resource.id} resource={resource} current={progress[resource.id]} installing={installProgress[resource.id]} bulkBusy={bulkBusy} onDownload={onDownload} onPause={onPause} onInstall={onInstall} />) : <div className="empty-block compact">当前没有下载或安装记录</div>}</div></section></div>;
}

/** 单个依赖卡只展示就绪状态，避免与下载弹窗重复堆叠进度信息。 */
function DependencyRow({ resource, current, installing, bulkBusy, onDownload, onPause, onInstall }: { resource: ResourceItem; current?: DesktopResourceDownloadView; installing?: DesktopResourceInstallView; bulkBusy: boolean } & ResourceActions) {
  const busy = isResourceBusy(resource.id, current ? { [resource.id]: current } : {}, installing ? { [resource.id]: installing } : {});
  const state = resource.installed ? "loaded" : busy ? "downloading" : "waiting";
  return <article><ResourceIcon installed={resource.installed} /><div className="resource-info"><strong>{resourceDisplayName(resource)}</strong><span>{resourceKindLabel(resource.kind)} · {formatResourceBytes(resource.byteSize)} · {resource.sourceKinds.length ? resource.sourceKinds.map(sourceKindLabel).join(" / ") : "当前来源不可用"}</span></div><div className="dependency-row-tail"><b className={`dependency-state is-${state}`}>{state === "loaded" ? "已加载" : state === "downloading" ? "下载中" : resource.downloaded ? "等待安装" : current?.status === "paused" ? "已暂停" : current?.status === "failed" ? "需重试" : "等待下载"}</b><ResourceAction resource={resource} current={current} installing={installing} bulkBusy={bulkBusy} onDownload={onDownload} onPause={onPause} onInstall={onInstall} /></div></article>;
}

/** 队列卡把百分比与传输元数据分行展示，避免小字号文本压在进度条内。 */
function QueueRow({ resource, current, installing, bulkBusy, onDownload, onPause, onInstall }: { resource: ResourceItem; current?: DesktopResourceDownloadView; installing?: DesktopResourceInstallView; bulkBusy: boolean } & ResourceActions) {
  const installBusy = Boolean(installing && ACTIVE_INSTALL_STATES.has(installing.status));
  const currentFailed = current?.status === "failed";
  // 当前失败事件优先于上一次目录快照，防止损坏缓存仍被旧 downloaded 状态显示为 100%。
  const downloadComplete = !currentFailed && (resource.downloaded || current?.status === "downloaded");
  const percent = installBusy ? Math.round(installing!.progress) : currentFailed ? safeDownloadPercent(current) : resource.installed || downloadComplete ? 100 : current ? safeDownloadPercent(current) : 0;
  const status = installBusy ? installStatusLabel(installing!.status) : currentFailed ? "下载失败" : resource.installed ? "已加载" : downloadComplete ? "下载完成" : current ? downloadStatusLabel(current.status) : "等待下载";
  const meta = progressMeta(resource, current, installing);
  return <article className="queue-resource"><header><div><strong>{resourceDisplayName(resource)}</strong><span>{resource.fileName}</span></div><b>{percent}%</b></header><div className="resource-progress-head"><strong>{status}</strong><span>{current ? `${formatResourceBytes(current.downloadedBytes)} / ${formatResourceBytes(current.totalBytes)}` : resource.installed ? "文件已加载" : formatResourceBytes(resource.byteSize)}</span></div><div className={`resource-progress-track is-${current?.status || (installBusy ? "installing" : resource.installed ? "downloaded" : "queued")}`}><i style={{ width: `${percent}%` }} /></div><div className="resource-progress-meta">{meta.map((item) => <span key={item}>{item}</span>)}</div><footer><ResourceAction resource={resource} current={current} installing={installing} bulkBusy={bulkBusy} onDownload={onDownload} onPause={onPause} onInstall={onInstall} /></footer></article>;
}

/** 资源按钮根据真实下载和安装状态选择暂停、继续、安装或完成。 */
/** 必需依赖列表和启动页共用同一真实下载、暂停与安装状态机。 */
export function ResourceAction({ resource, current, installing, bulkBusy, onDownload, onPause, onInstall }: { resource: ResourceItem; current?: DesktopResourceDownloadView; installing?: DesktopResourceInstallView; bulkBusy: boolean } & ResourceActions) {
  const downloadBusy = Boolean(current && ACTIVE_DOWNLOAD_STATES.has(current.status));
  const installBusy = Boolean(installing && ACTIVE_INSTALL_STATES.has(installing.status));
  const sourceAvailable = resource.sourceKinds.length > 0;
  if (current?.status === "downloading") return <button className="secondary" disabled={bulkBusy} title={bulkBusy ? "批量依赖操作正在进行" : "暂停下载并保留断点数据"} onClick={() => onPause(resource.id)}>暂停</button>;
  if (resource.installed) return <button disabled title="该依赖已经完成校验并加载"><CheckCircle2 />已加载</button>;
  if (installBusy) return <button disabled title="正在校验并写入安装目录，请勿重复操作"><LoaderCircle className="spin" />安装中</button>;
  if (downloadBusy) return <button disabled title={current?.status === "verifying" ? "正在校验完整文件哈希" : "已经进入下载队列"}><LoaderCircle className="spin" />{current?.status === "verifying" ? "校验中" : "排队中"}</button>;
  if (current?.status === "failed") return <button disabled={bulkBusy || !sourceAvailable} title={bulkBusy ? "批量依赖操作正在进行" : !sourceAvailable ? "签名清单未提供当前设备可用的下载来源" : current.error || "重新从已保存的断点继续下载"} onClick={() => onDownload(resource.id)}><Download />重试</button>;
  if (resource.downloaded || current?.status === "downloaded") return <button disabled={bulkBusy} title={bulkBusy ? "批量依赖操作正在进行" : "文件与哈希校验已完成，可以安装"} onClick={() => onInstall(resource.id)}><PackageCheck />安装</button>;
  return <button disabled={bulkBusy || !sourceAvailable} title={bulkBusy ? "批量依赖操作正在进行" : !sourceAvailable ? "签名清单未提供当前设备可用的下载来源" : current?.status === "paused" ? "从已保存的断点继续下载" : "从主站镜像下载并校验"} onClick={() => onDownload(resource.id)}><Download />{current?.status === "paused" ? "继续" : sourceAvailable ? "下载" : "无来源"}</button>;
}

/** 进度辅助信息按阶段隐藏失效速度和 ETA。 */
function progressMeta(resource: ResourceItem, current?: DesktopResourceDownloadView, installing?: DesktopResourceInstallView): string[] {
  if (installing && ACTIVE_INSTALL_STATES.has(installing.status)) return ["正在写入并校验安装目录"];
  if (current?.status === "failed") return [current.error || "下载失败，请重试", current.sourceKind ? `来源 ${sourceKindLabel(current.sourceKind)}` : null].filter(Boolean) as string[];
  if (resource.downloaded && !resource.installed) return ["下载与哈希校验已完成，可以直接安装"];
  if (!current) return [resource.installed ? "依赖已加载" : "尚未进入下载队列"];
  const source = current.sourceKind ? `来源 ${sourceKindLabel(current.sourceKind)}` : null;
  if (current.status === "downloading") return [current.bytesPerSecond > 0 ? `速度 ${formatTransferRate(current.bytesPerSecond)}` : "正在稳定测速", current.etaSeconds !== null ? `预计 ${formatEta(current.etaSeconds)}` : "正在估算剩余时间", source].filter(Boolean) as string[];
  if (current.status === "paused") return ["断点已保留，继续后重新测速", source].filter(Boolean) as string[];
  if (current.status === "verifying") return ["正在校验文件大小与 SHA-256", source].filter(Boolean) as string[];
  if (current.status === "downloaded") return [resource.installed ? "下载和安装均已完成" : "下载完成，等待安装", source].filter(Boolean) as string[];
  return ["等待前序资源完成", source].filter(Boolean) as string[];
}

function isResourceBusy(resourceId: string, progress: DownloadMap, installProgress: InstallMap): boolean {
  return Boolean(progress[resourceId] && ACTIVE_DOWNLOAD_STATES.has(progress[resourceId]!.status)) || Boolean(installProgress[resourceId] && ACTIVE_INSTALL_STATES.has(installProgress[resourceId]!.status));
}

function resourceDisplayName(resource: ResourceItem): string {
  if (resource.kind === "runtime") return resource.runtimeProfile?.backend === "amd_directml" ? "AMD DirectML Runtime" : "NVIDIA CUDA Runtime";
  if (resource.kind === "captioner") return "自动打标组件";
  if (resource.kind === "trainer") return "LoRA 训练组件";
  const role = resource.modelRegistration?.role;
  return role === "primary" ? "Anima Base 底模" : role === "text_encoder" ? "Anima Base 文本编码器" : role === "vae" ? "Anima Base VAE" : resource.fileName;
}

function ResourceIcon({ installed }: { installed: boolean }) { return installed ? <PackageCheck /> : <PackageOpen />; }
function SummaryItem({ tone, label, value }: { tone: string; label: string; value: number }) { return <article className={`is-${tone}`}><span>{label}</span><strong>{value}</strong><small>项</small></article>; }
function UnconfiguredCatalog({ message }: { message: string }) { return <div className="resource-unconfigured"><AlertTriangle /><div><strong>资源发布通道尚未配置</strong><span>{message}</span><small>安装入口保持关闭，避免下载未登记或未签名的文件。</small></div></div>; }
function resourceKindLabel(kind: string): string { return { runtime: "运行环境", model: "底模组件", captioner: "打标模型", trainer: "训练组件" }[kind] || kind; }
/** 资源清单只保留主站镜像，本标签用于展示实际下载通道。 */
function sourceKindLabel(kind: string): string { return kind === "mirror" ? "主站镜像" : kind; }
function downloadStatusLabel(status: DesktopResourceDownloadView["status"]): string { return { queued: "排队中", downloading: "下载中", paused: "已暂停", verifying: "校验中", downloaded: "下载完成", failed: "下载失败" }[status]; }
function installStatusLabel(status: DesktopResourceInstallView["status"]): string { return { verifying: "校验缓存", installing: "安装中", switching: "切换版本", installed: "已安装", rolled_back: "已回滚", failed: "安装失败" }[status]; }
/** 字节格式化保留真实零值，小文件不再被误报成已经下载 1 KiB。 */
function formatResourceBytes(value: number): string { if (value < 1024) return `${Math.max(0, Math.round(value))} B`; if (value < 1024 ** 2) return `${Math.round(value / 1024)} KiB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`; return `${(value / 1024 ** 3).toFixed(2)} GiB`; }
/** 防御异常总大小和过期事件，进度永远保持在真实的 0–100 范围。 */
function safeDownloadPercent(current: DesktopResourceDownloadView): number { return current.totalBytes > 0 ? Math.min(100, Math.max(0, Math.round(current.downloadedBytes / current.totalBytes * 100))) : 0; }
function formatTransferRate(value: number): string { return value < 1024 ** 2 ? `${Math.max(1, Math.round(value / 1024))} KiB/s` : `${(value / 1024 ** 2).toFixed(value >= 100 * 1024 ** 2 ? 0 : 1)} MiB/s`; }
function formatEta(seconds: number): string { if (seconds < 60) return `约 ${Math.max(1, seconds)} 秒`; if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟`; const minutes = Math.ceil((seconds % 3600) / 60); return `约 ${Math.floor(seconds / 3600)} 小时${minutes ? ` ${minutes} 分钟` : ""}`; }
