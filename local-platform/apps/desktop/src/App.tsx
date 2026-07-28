/**
 * 本文件实现桌面端首个可运行工作区：真实环境检测、持续 GPU 阻断提示、本地设置和图库同步队列查看。
 */
import type { DesktopBootstrapView, DesktopEnvironmentReport, DesktopGallerySyncItem, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopSettings } from "@drawhime/contracts";
import { AlertTriangle, CheckCircle2, Cpu, Database, Download, FolderCog, Gauge, HardDrive, Image, LoaderCircle, MemoryStick, Monitor, Moon, PackageOpen, RefreshCw, Settings2, ShieldCheck, Sun, UploadCloud } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import { downloadDesktopResource, inspectDesktopEnvironment, listDesktopGallerySyncQueue, listenDesktopResourceProgress, loadDesktopBootstrap, loadDesktopResourceCatalog, saveDesktopSettings } from "./desktop-api";

type DesktopPage = "overview" | "environment" | "resources" | "sync" | "settings";

const navigation = [
  { id: "overview" as const, label: "本机概览", Icon: Gauge },
  { id: "environment" as const, label: "环境检测", Icon: Cpu },
  { id: "resources" as const, label: "资源安装", Icon: PackageOpen },
  { id: "sync" as const, label: "图库同步", Icon: UploadCloud },
  { id: "settings" as const, label: "本地设置", Icon: Settings2 },
];

/** 桌面应用根组件始终保留环境异常横幅，并周期复检 GPU 是否仍可用。 */
export function App() {
  const [page, setPage] = useState<DesktopPage>("overview");
  const [bootstrap, setBootstrap] = useState<DesktopBootstrapView | null>(null);
  const [queue, setQueue] = useState<DesktopGallerySyncItem[]>([]);
  const [resourceCatalog, setResourceCatalog] = useState<DesktopResourceCatalogView | null>(null);
  const [resourceProgress, setResourceProgress] = useState<Record<string, DesktopResourceDownloadView>>({});
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [message, setMessage] = useState("");
  const environmentCheckRunning = useRef(false);
  const lastEnvironmentCheckAt = useRef(0);
  const bootstrapReady = bootstrap !== null;

  useEffect(() => { void loadDesktopBootstrap().then(async (state) => { lastEnvironmentCheckAt.current = Date.now(); setBootstrap(state); const [nextQueue, catalog] = await Promise.all([listDesktopGallerySyncQueue(), loadDesktopResourceCatalog()]); setQueue(nextQueue); setResourceCatalog(catalog); }).catch((error) => setMessage(errorMessage(error))).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopResourceProgress((progress) => setResourceProgress((current) => ({ ...current, [progress.resourceId]: progress }))).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    if (!bootstrapReady) return;
    const timer = window.setInterval(() => void recheck(true), 90_000);
    const onVisibility = () => { if (document.visibilityState === "visible" && Date.now() - lastEnvironmentCheckAt.current >= 30_000) void recheck(true); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [bootstrapReady]);

  useEffect(() => {
    if (!bootstrap) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    /** 同时更新 WebView 语义主题和原生标题栏，系统主题变化无需重启。 */
    const applyTheme = () => {
      const resolved = bootstrap.settings.themeMode === "system" ? (media.matches ? "dark" : "light") : bootstrap.settings.themeMode;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      void getCurrentWindow().setTheme(resolved).catch(() => undefined);
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [bootstrap?.settings.themeMode]);

  /** 快速复检结果立即覆盖旧状态，GPU 恢复前警告不会消失。 */
  const recheck = async (quiet = false) => {
    if (environmentCheckRunning.current) return;
    environmentCheckRunning.current = true;
    if (!quiet) setChecking(true);
    try { const environment = await inspectDesktopEnvironment(); lastEnvironmentCheckAt.current = Date.now(); setBootstrap((current) => current ? { ...current, environment } : current); if (!quiet) setMessage("环境检测已更新"); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { environmentCheckRunning.current = false; if (!quiet) setChecking(false); }
  };

  /** 顶栏主题切换直接持久化，避免用户离开设置页后丢失选择。 */
  const changeTheme = async (themeMode: DesktopSettings["themeMode"]) => {
    if (!bootstrap || themeMode === bootstrap.settings.themeMode || themeSaving) return;
    setThemeSaving(true);
    try {
      const settings = await saveDesktopSettings({ ...bootstrap.settings, themeMode });
      setBootstrap((current) => current ? { ...current, settings } : current);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setThemeSaving(false);
    }
  };

  /** 资源目录刷新始终重新执行远端签名和有效期校验。 */
  const reloadResourceCatalog = async () => {
    setCatalogLoading(true);
    try { setResourceCatalog(await loadDesktopResourceCatalog()); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setCatalogLoading(false); }
  };

  /** 单资源下载完成后重新读取目录，使已验证缓存状态立即更新。 */
  const downloadResource = async (resourceId: string) => {
    const totalBytes = resourceCatalog?.resources.find((item) => item.id === resourceId)?.byteSize || 1;
    setResourceProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "queued", sourceKind: null, downloadedBytes: 0, totalBytes, bytesPerSecond: 0, targetPath: null, error: null } }));
    try { const progress = await downloadDesktopResource(resourceId); setResourceProgress((current) => ({ ...current, [resourceId]: progress })); await reloadResourceCatalog(); }
    catch (error) { const message = errorMessage(error); setResourceProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "failed", sourceKind: null, downloadedBytes: current[resourceId]?.downloadedBytes || 0, totalBytes, bytesPerSecond: 0, targetPath: null, error: message } })); setMessage(message); }
  };

  if (loading || !bootstrap) return <div className="desktop-loading"><LoaderCircle className="spin" /><strong>正在建立本地工作区</strong><span>{message || "读取硬件、磁盘与本地数据库"}</span></div>;
  const critical = bootstrap.environment.issues.find((issue) => issue.severity === "critical") || bootstrap.environment.issues[0];
  return <div className="desktop-shell">
    <aside className="desktop-sidebar"><header><div className="desktop-mark">D</div><div><strong>DrawHime</strong><span>DESKTOP</span></div></header><nav>{navigation.map(({ id, label, Icon }) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={17} />{label}{id === "environment" && bootstrap.environment.status !== "ready" && <i />}</button>)}</nav><footer><span>本地核心</span><strong>{bootstrap.environment.status === "ready" ? "运行正常" : "需要处理"}</strong></footer></aside>
    <main className="desktop-main">
      <header className="desktop-topbar"><div className="desktop-title"><span>本地模型工作站</span><strong>{pageTitle(page)}</strong></div><div className="topbar-actions"><div className="theme-switch" aria-label="界面主题">{(["system", "dark", "light"] as const).map((mode) => { const Icon = mode === "system" ? Monitor : mode === "dark" ? Moon : Sun; return <button key={mode} className={bootstrap.settings.themeMode === mode ? "active" : ""} aria-label={themeModeLabel(mode)} title={themeModeLabel(mode)} disabled={themeSaving} onClick={() => void changeTheme(mode)}><Icon /></button>; })}</div><button className="recheck-button" onClick={() => void recheck()} disabled={checking}>{checking ? <LoaderCircle className="spin" /> : <RefreshCw />}<span>重新检测</span></button></div></header>
      {bootstrap.environment.status !== "ready" && critical && <section className={`environment-banner is-${critical.severity}`}><AlertTriangle /><div><strong>{critical.title}</strong><span>{critical.message}</span></div><button onClick={() => setPage("environment")}>查看环境详情</button></section>}
      {message && <div className="desktop-notice">{message}<button onClick={() => setMessage("")}>×</button></div>}
      {page === "overview" && <OverviewPage state={bootstrap} />}
      {page === "environment" && <EnvironmentPage report={bootstrap.environment} />}
      {page === "resources" && <ResourcesPage catalog={resourceCatalog} progress={resourceProgress} loading={catalogLoading} onReload={() => void reloadResourceCatalog()} onDownload={(resourceId) => void downloadResource(resourceId)} />}
      {page === "sync" && <SyncPage items={queue} />}
      {page === "settings" && <SettingsPage value={bootstrap.settings} onSaved={(settings) => { setBootstrap((current) => current ? { ...current, settings } : current); setMessage("本地设置已保存"); void reloadResourceCatalog(); }} onError={setMessage} />}
    </main>
  </div>;
}

/** 总览页只展示真实检测与本地数据，不模拟未接入的生成结果。 */
function OverviewPage({ state }: { state: DesktopBootstrapView }) {
  const gpu = state.environment.gpus[0];
  const capability = state.environment.capabilities;
  return <div className="desktop-page"><section className="overview-hero"><div><span>LOCAL COMPUTE</span><h1>{gpu?.name || "等待可用 GPU"}</h1><p>本地计算与网页钱包隔离。环境通过自检后才开放生成和训练，结果将进入持久化图库同步队列。</p></div><StatusSeal status={state.environment.status} /></section><section className="capability-grid"><CapabilityCard label="本地生成" ready={capability.inference} text={capability.inference ? "Runtime 已通过推理自检" : "等待 GPU 与推理环境就绪"} /><CapabilityCard label="LoRA 训练" ready={capability.training} text={capability.training ? "训练 Runtime 可用" : "训练入口保持锁定"} /><CapabilityCard label="自动打标" ready={capability.captioning} text={capability.captioning ? "打标 Runtime 可用" : "仍可手动整理标签"} /><CapabilityCard label="模型管理" ready={capability.modelManagement} text="支持本地目录和文件哈希管理" /></section><section className="metric-grid"><Metric Icon={MemoryStick} label="GPU 显存" value={gpu ? `${formatBytes(gpu.memoryFreeBytes)} / ${formatBytes(gpu.memoryTotalBytes)}` : "未检测到"} /><Metric Icon={Cpu} label="处理器" value={`${state.environment.cpu.name} · ${state.environment.cpu.logicalCores} 线程`} /><Metric Icon={Database} label="系统内存" value={`${formatBytes(state.environment.memory.availableBytes)} 可用`} /><Metric Icon={UploadCloud} label="待同步图库" value={`${state.pendingGallerySyncCount} 项`} /></section></div>;
}

/** 环境页展示完整问题和硬件明细，便于用户按具体原因修复。 */
function EnvironmentPage({ report }: { report: DesktopEnvironmentReport }) {
  return <div className="desktop-page"><section className="section-card"><header><div><span>ENVIRONMENT REPORT</span><h2>本机能力检测</h2></div><small>{new Date(report.checkedAt).toLocaleString("zh-CN")}</small></header><div className="environment-summary"><div><Cpu /><span><small>系统</small><strong>{report.os.name} · {report.os.arch}{report.os.build ? ` · ${report.os.build}` : ""}</strong></span></div><div><MemoryStick /><span><small>内存</small><strong>{formatBytes(report.memory.totalBytes)}</strong></span></div><div><HardDrive /><span><small>Runtime</small><strong>{runtimeLabel(report.runtime.status)}</strong></span></div></div></section>{report.issues.length > 0 && <section className="issue-list">{report.issues.map((issue) => <article className={`is-${issue.severity}`} key={issue.code}><AlertTriangle /><div><strong>{issue.title}</strong><p>{issue.message}</p><span>{issue.action}</span></div></article>)}</section>}<section className="section-card"><header><div><span>GPU INVENTORY</span><h2>图形设备</h2></div><small>{report.gpus.length} 个</small></header>{report.gpus.length ? <div className="gpu-list">{report.gpus.map((gpu) => <article key={gpu.uuid}><div><strong>{gpu.name}</strong><span>{gpu.vendor} · 驱动 {gpu.driverVersion}</span></div><dl><div><dt>空闲显存</dt><dd>{formatBytes(gpu.memoryFreeBytes)}</dd></div><div><dt>总显存</dt><dd>{formatBytes(gpu.memoryTotalBytes)}</dd></div><div><dt>计算能力</dt><dd>{gpu.computeCapability || "-"}</dd></div><div><dt>利用率</dt><dd>{gpu.utilizationPercent === null ? "-" : `${gpu.utilizationPercent}%`}</dd></div></dl></article>)}</div> : <div className="empty-block">当前未检测到受支持的 NVIDIA GPU</div>}</section><section className="section-card"><header><div><span>STORAGE</span><h2>本地磁盘</h2></div></header><div className="disk-list">{report.disks.map((disk) => <article key={disk.name}><HardDrive /><span><strong>{disk.name}</strong><small>{disk.fileSystem || "未知文件系统"}</small></span><b>{formatBytes(disk.availableBytes)} 可用</b></article>)}</div></section></div>;
}

/** 资源页只开放真实签名目录中的项目，并展示断点、来源和校验状态。 */
function ResourcesPage({ catalog, progress, loading, onReload, onDownload }: { catalog: DesktopResourceCatalogView | null; progress: Record<string, DesktopResourceDownloadView>; loading: boolean; onReload: () => void; onDownload: (resourceId: string) => void }) {
  return <div className="desktop-page"><section className="section-card resource-card"><header><div><span>RESOURCE CHANNEL</span><h2>依赖与模型资源</h2></div><button className="resource-reload" disabled={loading} onClick={onReload}>{loading ? <LoaderCircle className="spin" /> : <RefreshCw />}刷新签名目录</button></header>{!catalog ? <div className="empty-block">正在读取资源发布状态</div> : !catalog.configured ? <div className="resource-unconfigured"><ShieldCheck /><div><strong>资源发布通道尚未配置</strong><span>{catalog.message}</span><small>安装入口保持关闭，避免下载未登记或未签名的文件。</small></div></div> : <><div className="resource-channel-status"><ShieldCheck /><span><strong>{catalog.message}</strong><small>密钥 {catalog.keyId} · 有效至 {catalog.expiresAt ? new Date(catalog.expiresAt).toLocaleString("zh-CN") : "-"}</small></span></div>{catalog.resources.length ? <div className="resource-list">{catalog.resources.map((resource) => { const current = progress[resource.id]; const busy = current && ["queued", "downloading", "verifying"].includes(current.status); const sourceAvailable = resource.sourceKinds.length > 0; const percent = current ? Math.min(100, Math.round(current.downloadedBytes / current.totalBytes * 100)) : resource.downloaded ? 100 : 0; return <article key={resource.id}><PackageOpen /><div className="resource-info"><strong>{resource.fileName}</strong><span>{resourceKindLabel(resource.kind)} · {resource.version} · {formatResourceBytes(resource.byteSize)} · {sourceAvailable ? resource.sourceKinds.map(sourceKindLabel).join(" / ") : "当前来源设置下不可用"}</span>{current && <div className="resource-progress"><i style={{ width: `${percent}%` }} /><small>{downloadStatusLabel(current.status)} · {percent}%{current.bytesPerSecond ? ` · ${formatResourceBytes(current.bytesPerSecond)}/s` : ""}</small></div>}</div><button disabled={busy || resource.downloaded || !sourceAvailable} onClick={() => onDownload(resource.id)}>{busy ? <LoaderCircle className="spin" /> : resource.downloaded ? <CheckCircle2 /> : <Download />}{resource.downloaded ? "已验证" : busy ? "下载中" : sourceAvailable ? "下载" : "无来源"}</button></article>; })}</div> : <div className="empty-block">签名目录中没有适用于当前 Windows 架构的资源</div>}</>}</section></div>;
}

/** 图库同步页读取真实 SQLite 队列，离线队列不会因关闭窗口而丢失。 */
function SyncPage({ items }: { items: DesktopGallerySyncItem[] }) {
  return <div className="desktop-page"><section className="section-card"><header><div><span>GALLERY OUTBOX</span><h2>网页图库同步</h2></div><small>{items.length} 项</small></header>{items.length ? <div className="sync-list">{items.map((item) => <article key={item.id}><Image /><div><strong>{item.localTaskId}</strong><span>{item.privacy === "private" ? "私有" : "公开"} · {syncStatusLabel(item.status)}</span></div><small>{item.galleryItemId || item.artifactSha256.slice(0, 12)}</small></article>)}</div> : <div className="empty-block">本机暂时没有等待同步的生成结果</div>}</section></div>;
}

/** 设置页把隐私、目录和上传策略真实保存到本机 SQLite。 */
function SettingsPage({ value, onSaved, onError }: { value: DesktopSettings; onSaved: (settings: DesktopSettings) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm((current) => ({ ...current, themeMode: value.themeMode })), [value.themeMode]);
  const changed = useMemo(() => JSON.stringify(form) !== JSON.stringify(value), [form, value]);
  const save = async () => { setBusy(true); try { onSaved(await saveDesktopSettings(form)); } catch (error) { onError(errorMessage(error)); } finally { setBusy(false); } };
  return <div className="desktop-page"><section className="section-card settings-card"><header><div><span>LOCAL SETTINGS</span><h2>界面、下载与存储</h2></div><ShieldCheck /></header><div className="settings-grid"><label><span>界面主题</span><select value={form.themeMode} onChange={(event) => setForm({ ...form, themeMode: event.target.value as DesktopSettings["themeMode"] })}><option value="system">跟随系统</option><option value="dark">深色</option><option value="light">亮色</option></select><small>保存后同步更新窗口与页面</small></label><label><span>依赖来源</span><select value={form.dependencySource} onChange={(event) => setForm({ ...form, dependencySource: event.target.value as DesktopSettings["dependencySource"] })}><option value="auto">自动：优先官方，异常切换镜像</option><option value="official">仅官方来源</option><option value="mirror">仅主站镜像</option></select><small>所有来源仍需通过相同签名和哈希校验</small></label><label><span>默认图库权限</span><select value={form.defaultPrivacy} onChange={(event) => setForm({ ...form, defaultPrivacy: event.target.value as DesktopSettings["defaultPrivacy"] })}><option value="private">私有</option><option value="public">公开</option></select><small>每次生成仍可单独覆盖</small></label><label><span>上传并发数</span><select value={form.uploadConcurrency} onChange={(event) => setForm({ ...form, uploadConcurrency: Number(event.target.value) })}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select><small>弱网环境建议 1–2</small></label><PathField label="模型目录" value={form.modelRoot} onChange={(modelRoot) => setForm({ ...form, modelRoot })} /><PathField label="作品目录" value={form.outputRoot} onChange={(outputRoot) => setForm({ ...form, outputRoot })} /><PathField label="Runtime 目录" value={form.runtimeRoot} onChange={(runtimeRoot) => setForm({ ...form, runtimeRoot })} /><label className="settings-check"><input type="checkbox" checked={form.wifiOnly} onChange={(event) => setForm({ ...form, wifiOnly: event.target.checked })} /><span>仅在非计费网络同步图库</span></label></div><footer><button disabled={!changed || busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" /> : <FolderCog />}{busy ? "保存中" : "保存本地设置"}</button></footer></section></div>;
}

/** 目录输入保持明确文本，保存时由本地核心创建并验证写权限。 */
function PathField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="path-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
/** 单项能力卡统一显示真实开放或锁定状态。 */
function CapabilityCard({ label, ready, text }: { label: string; ready: boolean; text: string }) { return <article className={ready ? "is-ready" : "is-locked"}>{ready ? <CheckCircle2 /> : <AlertTriangle />}<div><strong>{label}</strong><span>{text}</span></div></article>; }
/** 总览指标保持紧凑并适配长硬件名称。 */
function Metric({ Icon, label, value }: { Icon: typeof Cpu; label: string; value: string }) { return <article><Icon /><span><small>{label}</small><strong>{value}</strong></span></article>; }
/** 环境状态印章突出当前是否可执行 GPU 任务。 */
function StatusSeal({ status }: { status: DesktopEnvironmentReport["status"] }) { return <div className={`status-seal is-${status}`}><span>ENV</span><strong>{status === "ready" ? "READY" : status.toUpperCase()}</strong></div>; }
function pageTitle(page: DesktopPage): string { return { overview: "本机概览", environment: "环境检测", resources: "资源安装", sync: "图库同步", settings: "本地设置" }[page]; }
function runtimeLabel(status: DesktopEnvironmentReport["runtime"]["status"]): string { return { not_installed: "未安装", installed_unverified: "等待自检", ready: "运行正常", broken: "需要修复" }[status]; }
function syncStatusLabel(status: DesktopGallerySyncItem["status"]): string { return { queued: "等待上传", waiting_network: "等待网络", waiting_auth: "等待登录", uploading: "上传中", committing: "正在提交", synced: "已同步", privacy_pending: "权限待同步", paused: "已暂停", failed_retryable: "等待重试", failed_final: "同步失败", remote_deleted: "网页已删除" }[status]; }
/** 主题选项使用简短中文标签供按钮标题和辅助技术读取。 */
function themeModeLabel(mode: DesktopSettings["themeMode"]): string { return { system: "跟随系统", dark: "深色主题", light: "亮色主题" }[mode]; }
function resourceKindLabel(kind: string): string { return { runtime: "运行环境", model: "底模", lora: "LoRA", captioner: "打标模型", trainer: "训练组件" }[kind] || kind; }
function sourceKindLabel(kind: string): string { return { official: "官方", mirror: "主站镜像" }[kind] || kind; }
function downloadStatusLabel(status: DesktopResourceDownloadView["status"]): string { return { queued: "排队中", downloading: "下载中", verifying: "校验中", downloaded: "已完成", failed: "失败" }[status]; }
function formatResourceBytes(value: number): string { if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KiB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`; return `${(value / 1024 ** 3).toFixed(2)} GiB`; }
function formatBytes(value: number): string { if (value <= 0) return "0 GB"; return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error || "桌面端操作失败"); }
