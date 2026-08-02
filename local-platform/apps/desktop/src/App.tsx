/**
 * 本文件实现桌面生成、任务、模型、Runtime、资源、环境、图库同步和本地设置的响应式工作区。
 */
import type { DesktopAccountView, DesktopBootstrapView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopSettings, DesktopSoftwareUpdateView, DesktopStorageCleanupView } from "@drawhime/contracts";
import type { DesktopAiSettings, DesktopAiSettingsUpdate } from "@drawhime/contracts";
import { AlertTriangle, BookOpenCheck, CheckCircle2, Database, Download, Eraser, FlaskConical, FolderCog, Gauge, HardDrive, Image, Images, KeyRound, Layers3, LoaderCircle, LockKeyhole, Monitor, Moon, PackageCheck, RefreshCw, Save, ScanSearch, Settings2, ShieldCheck, Sparkles, Sun, Tags, Trash2, Upload } from "lucide-react";
import { Copy } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { applyDesktopSoftwareUpdate, cleanupDesktopStorage, downloadDesktopResource, downloadDesktopSoftwareUpdate, importDesktopOfflineUpdate, inspectDesktopEnvironment, installDesktopResource, listenDesktopResourceInstallProgress, listenDesktopResourceProgress, loadDesktopAccountStatus, loadDesktopBootstrap, loadDesktopResourceCatalog, loadDesktopRuntimeStatus, loadDesktopSoftwareUpdateStatus, pauseDesktopResourceDownload, revealDesktopLocalJobArtifact, rollbackDesktopSoftwareUpdate, saveDesktopSettings, selfTestDesktopRuntime, showDesktopGalleryPreview, startDesktopRuntime, toggleDesktopGenerationPreview } from "./desktop-api";
import { analyzeDesktopImage, loadDesktopAiSettings, saveDesktopAiSettings, testDesktopAiSettings } from "./desktop-api";
import { AccountPage } from "./AccountPage";
import { coreDependencyProblem, coreResources, desktopCoreState, DownloadQueueDialog, visibleEnvironmentIssues } from "./ResourceCenter";
import { StartupPage, type StartupPhase } from "./StartupPage";
import { applyDesktopDisplayScale } from "./desktop-display-scale";
import { ActiveLocalJobIndicator, DesktopFeaturePages } from "./DesktopFeaturePages";
import { useDesktopEnvironmentMonitor, useDesktopRuntimeMonitor } from "./hooks/use-desktop-runtime-monitor";
import { refreshDesktopLocalLoras, refreshDesktopLocalModels, setDesktopRepositoryAccountStatus, startDesktopRepositoryStore } from "./stores/desktop-repository-store";
import { startDesktopTaskStore } from "./stores/desktop-task-store";

type DesktopPage = "overview" | "generate" | "captioning" | "training" | "models" | "loras" | "gallery" | "settings";
type OverviewSection = "start" | "account";
type SettingsSection = "general" | "ai" | "updates";

const navigation = [
  { id: "overview" as const, label: "启动 / 账号", Icon: Gauge },
  { id: "generate" as const, label: "本地生成", Icon: Images },
  { id: "captioning" as const, label: "训练集打标", Icon: Tags },
  { id: "training" as const, label: "LoRA 训练", Icon: BookOpenCheck },
  { id: "models" as const, label: "模型仓库", Icon: Database },
  { id: "loras" as const, label: "LoRA 仓库", Icon: Layers3 },
  { id: "gallery" as const, label: "图库", Icon: Image },
  { id: "settings" as const, label: "设置", Icon: Settings2 },
];

/** 高频进度更新时只重绘数据真正变化的功能页，事件回调由对应数据变化带入最新闭包。 */
function samePageDataProps<Props extends object>(previous: Readonly<Props>, next: Readonly<Props>): boolean {
  const previousKeys = Object.keys(previous) as Array<keyof Props>;
  const nextKeys = Object.keys(next) as Array<keyof Props>;
  return previousKeys.length === nextKeys.length && previousKeys.every((key) => typeof previous[key] === "function" || Object.is(previous[key], next[key]));
}

/** 隐藏页面保持挂载但暂停接收新属性，重新显示时一次追平最新状态。 */
function cacheWhileHidden<Props extends object>(Component: ComponentType<Props>) {
  const CachedPage = ({ active: _active, ...props }: Props & { active: boolean }) => <Component {...props as Props} />;
  return memo(CachedPage, (previous, next) => !next.active || samePageDataProps(previous, next));
}

const StableStartupPage = cacheWhileHidden(StartupPage);
const StableAccountPage = cacheWhileHidden(AccountPage);
const StableSettingsPage = memo(SettingsPage, (previous, next) => previous.active === next.active && (!next.active || samePageDataProps(previous, next)));
const StableAiSettingsCard = cacheWhileHidden(AiSettingsCard);
const StableUpdatesPage = cacheWhileHidden(UpdatesPage);

/** 桌面应用根组件始终保留环境异常横幅，并周期复检 GPU 是否仍可用。 */
export function App() {
  const [page, setPage] = useState<DesktopPage>("overview");
  const [overviewSection, setOverviewSection] = useState<OverviewSection>("start");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [bootstrap, setBootstrap] = useState<DesktopBootstrapView | null>(null);
  const [resourceCatalog, setResourceCatalog] = useState<DesktopResourceCatalogView | null>(null);
  const [resourceProgress, setResourceProgress] = useState<Record<string, DesktopResourceDownloadView>>({});
  const [installProgress, setInstallProgress] = useState<Record<string, DesktopResourceInstallView>>({});
  const [softwareUpdate, setSoftwareUpdate] = useState<DesktopSoftwareUpdateView | null>(null);
  const [account, setAccount] = useState<DesktopAccountView>({ status: "signed_out", identity: null, expiresAt: null, message: "尚未连接绘图姬账号" });
  const [loading, setLoading] = useState(true);
  const [themeSaving, setThemeSaving] = useState(false);
  const [startupPhase, setStartupPhase] = useState<StartupPhase>(null);
  const [resourceBulkBusy, setResourceBulkBusy] = useState(false);
  const [downloadQueueOpen, setDownloadQueueOpen] = useState(false);
  const [message, setMessage] = useState("");
  const installedResourceRefresh = useRef<Promise<void> | null>(null);
  const pendingResourceProgress = useRef<Record<string, DesktopResourceDownloadView>>({});
  const resourceProgressFrame = useRef<number | null>(null);
  const pendingInstallProgress = useRef<Record<string, DesktopResourceInstallView>>({});
  const installProgressFrame = useRef<number | null>(null);
  const bootstrapReady = bootstrap !== null;

  const environmentChanged = useCallback((environment: DesktopBootstrapView["environment"]) => {
    setBootstrap((current) => current ? { ...current, environment } : current);
  }, []);
  const runtimeChanged = useCallback((runtime: DesktopBootstrapView["runtime"]) => {
    setBootstrap((current) => current ? { ...current, runtime } : current);
  }, []);
  const { checking, recheck } = useDesktopEnvironmentMonitor({ enabled: bootstrapReady, environment: bootstrap?.environment || null, onChanged: environmentChanged, onMessage: setMessage });
  const runtimeTransitioning = startupPhase === "starting" || startupPhase === "self_testing" || ["starting", "stopping"].includes(bootstrap?.runtime.status || "");
  useDesktopRuntimeMonitor({ enabled: bootstrapReady, runtime: bootstrap?.runtime || null, transitioning: runtimeTransitioning, onChanged: runtimeChanged });

  useEffect(() => startDesktopRepositoryStore(setMessage), []);
  useEffect(() => startDesktopTaskStore(setMessage, () => {
    // 训练产物只让 LoRA 本机目录在后台收敛，不触发模型或远端仓库刷新。
    void refreshDesktopLocalLoras().catch((error) => setMessage(errorMessage(error)));
  }), []);
  useEffect(() => { setDesktopRepositoryAccountStatus(account.status); }, [account.status]);

  /** 安装事件与命令返回共用一次状态收敛，避免重复扫描磁盘或被环境复检门禁跳过。 */
  const refreshInstalledResourceState = useCallback((): Promise<void> => {
    if (installedResourceRefresh.current) return installedResourceRefresh.current;
    const request = Promise.all([
      loadDesktopResourceCatalog(),
      inspectDesktopEnvironment(),
      loadDesktopRuntimeStatus(),
    ]).then(([catalog, environment, runtime]) => {
      const installedIds = new Set(catalog.resources.filter((resource) => resource.installed).map((resource) => resource.id));
      setResourceCatalog(catalog);
      setBootstrap((current) => current ? { ...current, environment, runtime } : current);
      setResourceProgress((current) => Object.fromEntries(Object.entries(current).filter(([resourceId]) => !installedIds.has(resourceId))));
      setInstallProgress((current) => Object.fromEntries(Object.entries(current).map(([resourceId, progress]) => installedIds.has(resourceId) ? [resourceId, { ...progress, status: "installed", progress: 100, error: null }] : [resourceId, progress])));
    });
    installedResourceRefresh.current = request;
    // 先吞掉清理链自身的拒绝，原始请求仍向调用方保留真实错误。
    void request.then(() => undefined, () => undefined).finally(() => {
      if (installedResourceRefresh.current === request) installedResourceRefresh.current = null;
    });
    return request;
  }, []);

  useEffect(() => { void loadDesktopBootstrap().then(async (state) => { setBootstrap(state); const accountRequest = loadDesktopAccountStatus().catch((): DesktopAccountView => ({ status: "offline", identity: null, expiresAt: null, message: "账号服务当前未连接；全部本地功能继续可用" })); const [catalog, nextAccount] = await Promise.all([loadDesktopResourceCatalog(), accountRequest]); setResourceCatalog(catalog); setAccount(nextAccount); }).catch((error) => setMessage(errorMessage(error))).finally(() => setLoading(false)); }, []);
  useEffect(() => { void loadDesktopSoftwareUpdateStatus().then(setSoftwareUpdate).catch((error) => setMessage(errorMessage(error))); }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopResourceProgress((progress) => {
      // 下载事件可能每秒触发数十次，按动画帧合并后再提交 React 状态，避免拖慢主界面。
      pendingResourceProgress.current[progress.resourceId] = progress;
      if (resourceProgressFrame.current === null) {
        resourceProgressFrame.current = window.requestAnimationFrame(() => {
          const pending = pendingResourceProgress.current;
          pendingResourceProgress.current = {};
          resourceProgressFrame.current = null;
          setResourceProgress((current) => ({ ...current, ...pending }));
        });
      }
      if (progress.status === "downloaded") setMessage((current) => isTransientNetworkNotice(current) ? "" : current);
    }).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => {
      unlisten?.();
      if (resourceProgressFrame.current !== null) window.cancelAnimationFrame(resourceProgressFrame.current);
      resourceProgressFrame.current = null;
      pendingResourceProgress.current = {};
    };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopResourceInstallProgress((progress) => {
      pendingInstallProgress.current[progress.resourceId] = progress;
      if (installProgressFrame.current === null) {
        installProgressFrame.current = window.requestAnimationFrame(() => {
          const pending = pendingInstallProgress.current;
          pendingInstallProgress.current = {};
          installProgressFrame.current = null;
          setInstallProgress((current) => ({ ...current, ...pending }));
        });
      }
      if (progress.status === "installed") {
        setMessage((current) => isTransientNetworkNotice(current) ? "" : current);
        void refreshInstalledResourceState().catch(() => setMessage("安装已完成，但状态刷新失败，请点击重新检测"));
      }
    }).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => {
      unlisten?.();
      if (installProgressFrame.current !== null) window.cancelAnimationFrame(installProgressFrame.current);
      installProgressFrame.current = null;
      pendingInstallProgress.current = {};
    };
  }, [refreshInstalledResourceState]);
  /** 顶部操作提示是瞬时反馈，超时类错误不会在后续页面中永久残留。 */
  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(() => setMessage(""), isTransientNetworkNotice(message) ? 6_000 : 4_000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    if (!bootstrapReady || bootstrap?.runtime.status === "ready" || !["generate", "training"].includes(page)) return;
    // 核心异常退出时立即离开 GPU 操作页，防止缓存页面继续接受用户输入或触发操作。
    setPage("overview");
    setOverviewSection("start");
    setMessage("本地核心未运行，已返回启动页面");
  }, [bootstrap?.runtime.status, bootstrapReady, page]);

  useEffect(() => {
    if (!bootstrap) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    /** 同时更新 WebView 语义主题和原生标题栏，系统主题变化无需重启。 */
    const applyTheme = () => {
      const resolved = bootstrap.settings.themeMode === "system" ? (media.matches ? "dark" : "light") : bootstrap.settings.themeMode;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      applyDesktopDisplayScale(bootstrap.settings.fontScale, bootstrap.settings.contentFontScale);
      void getCurrentWindow().setTheme(resolved).catch(() => undefined);
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [bootstrap?.settings.themeMode, bootstrap?.settings.fontScale, bootstrap?.settings.contentFontScale]);

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
  const reloadResourceCatalog = async (): Promise<DesktopResourceCatalogView | null> => {
    try { const catalog = await loadDesktopResourceCatalog(); setResourceCatalog(catalog); setMessage((current) => isTransientNetworkNotice(current) ? "" : current); return catalog; }
    catch (error) { setMessage(errorMessage(error)); return null; }
  };

  /** 单资源下载完成后重新读取目录，使已验证缓存状态立即更新。 */
  const downloadResource = async (resourceId: string, catalogOverride?: DesktopResourceCatalogView) => {
    const totalBytes = (catalogOverride || resourceCatalog)?.resources.find((item) => item.id === resourceId)?.byteSize || 1;
    setResourceProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "queued", sourceKind: current[resourceId]?.sourceKind || null, downloadedBytes: current[resourceId]?.downloadedBytes || 0, totalBytes, bytesPerSecond: 0, etaSeconds: null, targetPath: null, error: null } }));
    try { const progress = await downloadDesktopResource(resourceId); setResourceProgress((current) => ({ ...current, [resourceId]: progress })); await reloadResourceCatalog(); setMessage((current) => isTransientNetworkNotice(current) ? "" : current); return true; }
    catch (error) { const message = errorMessage(error); const cacheInvalidated = message.includes("已隔离"); setResourceProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "failed", sourceKind: current[resourceId]?.sourceKind || null, downloadedBytes: cacheInvalidated ? 0 : current[resourceId]?.downloadedBytes || 0, totalBytes, bytesPerSecond: 0, etaSeconds: null, targetPath: null, error: message } })); await reloadResourceCatalog(); setMessage(message); return false; }
  };

  /** 安装使用已验证缓存；完成后同步刷新资源状态与 Runtime 环境门禁。 */
  const installResource = async (resourceId: string) => {
    const resourceKind = resourceCatalog?.resources.find((item) => item.id === resourceId)?.kind;
    setInstallProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "verifying", progress: 0, installPath: null, rollbackPath: null, error: null } }));
    try {
      const progress = await installDesktopResource(resourceId);
      setInstallProgress((current) => ({ ...current, [resourceId]: progress }));
    } catch (error) {
      const message = errorMessage(error);
      setInstallProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "failed", progress: current[resourceId]?.progress || 0, installPath: null, rollbackPath: null, error: message } }));
      if (message.includes("已隔离")) setResourceProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "failed", sourceKind: current[resourceId]?.sourceKind || null, downloadedBytes: 0, totalBytes: resourceCatalog?.resources.find((item) => item.id === resourceId)?.byteSize || current[resourceId]?.totalBytes || 1, bytesPerSecond: 0, etaSeconds: null, targetPath: null, error: message } }));
      await reloadResourceCatalog();
      setMessage(message);
      return false;
    }
    try {
      await refreshInstalledResourceState();
      // 资源安装只刷新对应仓库域；Runtime、打标器等依赖不会扫描模型目录。
      if (resourceKind === "model") void refreshDesktopLocalModels().catch((error) => setMessage(errorMessage(error)));
      if (resourceKind === "lora") void refreshDesktopLocalLoras().catch((error) => setMessage(errorMessage(error)));
      setMessage((current) => isTransientNetworkNotice(current) ? "" : current);
    } catch {
      // 安装结果与后续状态读取分开处理，避免把真实成功的安装误报为失败。
      setMessage("安装已完成，但状态刷新失败，请点击重新检测");
    }
    return true;
  };

  /** 初始化严格按签名清单顺序安装核心资源，任一失败即停止并保留断点。 */
  const installCoreResources = async (catalog: DesktopResourceCatalogView, forceResourceIds: string[] = []): Promise<boolean> => {
    if (!catalog.configured || resourceBulkBusy) return false;
    const dependencyProblem = coreDependencyProblem(catalog);
    if (dependencyProblem) { setMessage(dependencyProblem); return false; }
    setResourceBulkBusy(true);
    try {
      const pending = coreResources(catalog).filter((item) => !item.installed || forceResourceIds.includes(item.id));
      // 批量安装开始时先把所有缺失下载登记为队列，弹窗可立即展示真实执行顺序。
      setResourceProgress((current) => pending.reduce((next, resource) => resource.downloaded ? next : ({ ...next, [resource.id]: { resourceId: resource.id, status: "queued", sourceKind: current[resource.id]?.sourceKind || null, downloadedBytes: current[resource.id]?.downloadedBytes || 0, totalBytes: resource.byteSize, bytesPerSecond: 0, etaSeconds: null, targetPath: null, error: null } }), { ...current }));
      if (pending.length > 0) setDownloadQueueOpen(true);
      for (const resource of pending) {
        if (!resource.downloaded && !(await downloadResource(resource.id, catalog))) return false;
        if (!(await installResource(resource.id))) return false;
      }
      return true;
    } finally { setResourceBulkBusy(false); }
  };

  /** 首次初始化串联环境检测、核心依赖、Runtime 启动和完整自检，后续只执行启动。 */
  const runStartup = async () => {
    if (startupPhase || resourceBulkBusy || !bootstrap) return;
    setStartupPhase("checking");
    try {
      const [environment, catalog, currentRuntime] = await Promise.all([inspectDesktopEnvironment(), loadDesktopResourceCatalog(), loadDesktopRuntimeStatus()]);
      setResourceCatalog(catalog);
      setBootstrap((current) => current ? { ...current, environment, runtime: currentRuntime } : current);
      const blockingIssue = visibleEnvironmentIssues(environment).find((issue) => issue.severity === "critical" && issue.code !== "runtime_broken");
      if (blockingIssue) throw new Error(`${blockingIssue.title}：${blockingIssue.message}`);
      if (!catalog.configured) throw new Error(catalog.message);
      const dependencyProblem = coreDependencyProblem(catalog);
      if (dependencyProblem) throw new Error(dependencyProblem);
      const required = coreResources(catalog);
      if (required.length === 0) throw new Error("签名清单缺少 Runtime、必需组件或 Anima Base");
      const runtimeRepairIds = environment.runtime.status === "broken" ? required.filter((resource) => resource.kind === "runtime").map((resource) => resource.id) : [];
      const needsInitialization = environment.runtime.status !== "ready" || required.some((resource) => !resource.installed);
      if (required.some((resource) => !resource.installed) || runtimeRepairIds.length > 0) {
        setStartupPhase("installing");
        if (!(await installCoreResources(catalog, runtimeRepairIds))) return;
      }
      const nextCatalog = await loadDesktopResourceCatalog();
      setResourceCatalog(nextCatalog);
      const nextDependencyProblem = coreDependencyProblem(nextCatalog);
      if (nextDependencyProblem) throw new Error(nextDependencyProblem);
      if (coreResources(nextCatalog).some((resource) => !resource.installed)) throw new Error("必需依赖尚未全部安装，请在下载队列中查看失败原因");
      let runtime = await loadDesktopRuntimeStatus();
      if (runtime.status !== "ready") {
        setStartupPhase("starting");
        runtime = await startDesktopRuntime();
        setBootstrap((current) => current ? { ...current, runtime } : current);
      }
      if (needsInitialization) {
        setStartupPhase("self_testing");
        runtime = await selfTestDesktopRuntime();
      }
      const finalEnvironment = await inspectDesktopEnvironment();
      setBootstrap((current) => current ? { ...current, runtime, environment: finalEnvironment } : current);
      void refreshDesktopLocalModels().catch((error) => setMessage(errorMessage(error)));
      setMessage(needsInitialization ? "初始化完成，本地核心已自动启动" : "本地核心已启动");
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setStartupPhase(null); }
  };

  /** 预览窗口以 Rust 中的真实窗口状态为准，关闭或最小化不会影响当前生成表单。 */
  const toggleGenerationPreview = useCallback(async () => {
    try { await toggleDesktopGenerationPreview(); }
    catch (error) { setMessage(errorMessage(error)); }
  }, []);
  /** 图库图片使用独立原生窗口预览，不改变生成页面的实时预览状态。 */
  const showGalleryPreview = useCallback(async (id: string) => {
    try { await showDesktopGalleryPreview(id); }
    catch (error) { setMessage(errorMessage(error)); }
  }, []);
  /** 文件位置由 Rust 核心按任务 ID 解析，前端不接触可伪造的磁盘路径。 */
  const revealGalleryArtifact = useCallback(async (id: string) => {
    try { await revealDesktopLocalJobArtifact(id); }
    catch (error) { setMessage(errorMessage(error)); }
  }, []);
  const openModelSettings = useCallback(() => { setPage("settings"); setSettingsSection("general"); }, []);
  const openResourceQueue = useCallback(() => setDownloadQueueOpen(true), []);

  if (loading || !bootstrap) return <div className="desktop-loading"><LoaderCircle className="spin" /><strong>正在建立本地工作区</strong><span>{message || "读取硬件、磁盘与本地数据库"}</span></div>;
  const visibleIssues = visibleEnvironmentIssues(bootstrap.environment);
  const critical = visibleIssues.find((issue) => issue.severity === "critical") || visibleIssues[0];
  const requiredResources = coreResources(resourceCatalog);
  const startupInitialized = !coreDependencyProblem(resourceCatalog) && requiredResources.length > 0 && requiredResources.every((resource) => resource.installed) && bootstrap.environment.runtime.status === "ready";
  const coreState = desktopCoreState(bootstrap, resourceCatalog);
  const coreRunning = bootstrap.runtime.status === "ready";
  return <div className="desktop-shell" data-environment-status={bootstrap.environment.status} data-inference-ready={bootstrap.environment.capabilities.inference} data-training-ready={bootstrap.environment.capabilities.training} data-core-running={coreRunning}>
    <aside className="desktop-sidebar"><header><div className="desktop-mark">D</div><div><strong>DrawHime</strong><span>DESKTOP</span></div></header><nav>{navigation.map(({ id, label, Icon }) => { const coreLocked = !coreRunning && (id === "generate" || id === "training"); const overviewWarning = id === "overview" && (bootstrap.environment.status !== "ready" || account.status !== "connected"); return <button key={id} className={`${page === id ? "active" : ""} ${coreLocked ? "core-locked" : ""}`} disabled={coreLocked} aria-disabled={coreLocked} title={coreLocked ? "请先在启动页面启动本地核心" : undefined} onClick={() => setPage(id)}><Icon size={17} />{label}{coreLocked ? <LockKeyhole className="navigation-lock" /> : overviewWarning ? <i /> : id === "gallery" ? <ActiveLocalJobIndicator /> : null}</button>; })}</nav><div className="theme-switch sidebar-theme-switch" aria-label="界面主题">{(["system", "dark", "light"] as const).map((mode) => { const Icon = mode === "system" ? Monitor : mode === "dark" ? Moon : Sun; return <button key={mode} className={bootstrap.settings.themeMode === mode ? "active" : ""} aria-label={themeModeLabel(mode)} title={themeModeLabel(mode)} disabled={themeSaving} onClick={() => void changeTheme(mode)}><Icon /></button>; })}</div><button type="button" className={`core-status is-${coreState.kind}`} onClick={() => setDownloadQueueOpen(true)} aria-label={`${coreState.label}，查看下载队列`}><Download className="core-status-icon" /><span>本地核心 · 点击查看队列</span><strong>{coreState.label}</strong><small>{coreState.detail}</small></button></aside>
    <main className="desktop-main">
      <header className="desktop-topbar"><div className="desktop-title"><span>本地模型工作站</span><strong>{pageTitle(page)}</strong></div>{bootstrap.environment.status !== "ready" && critical && <button type="button" className={`environment-banner is-${critical.severity}`} title="查看启动状态" onClick={() => { setPage("overview"); setOverviewSection("start"); }}><AlertTriangle /><span><strong>{critical.title}</strong><small>{critical.message}</small></span></button>}</header>
      {message && <div className="desktop-notice" role="status" aria-live="polite"><span>{message}</span><button aria-label="关闭提示" onClick={() => setMessage("")}>×</button></div>}
      <DesktopFeaturePages activePage={page} environment={bootstrap.environment} runtimeReady={coreRunning} defaultPrivacy={bootstrap.settings.defaultPrivacy} modelRoot={bootstrap.settings.modelRoot} accountConnected={account.status === "connected"} onOpenModelSettings={openModelSettings} onOpenResources={openResourceQueue} onToggleGenerationPreview={toggleGenerationPreview} onShowGalleryPreview={showGalleryPreview} onRevealGalleryArtifact={revealGalleryArtifact} onMessage={setMessage} />
       <div hidden={page !== "overview"} className="desktop-page-host workspace-page"><WorkspaceTabs label="启动与账号" value={overviewSection} onChange={(value) => setOverviewSection(value as OverviewSection)} items={[{ id: "start", label: "启动", status: bootstrap.runtime.status === "ready" ? "运行中" : startupInitialized ? "可启动" : "待初始化" }, { id: "account", label: "账号", status: account.status === "connected" ? "已连接" : "未连接" }]} /><div hidden={overviewSection !== "start"}><StableStartupPage active={page === "overview" && overviewSection === "start"} state={bootstrap} catalog={resourceCatalog} progress={resourceProgress} installProgress={installProgress} phase={startupPhase} checking={checking} bulkBusy={resourceBulkBusy} onPrimary={() => void runStartup()} onRecheck={() => void recheck()} onOpenQueue={() => setDownloadQueueOpen(true)} onInstallRequired={() => resourceCatalog && void installCoreResources(resourceCatalog)} onDownload={(resourceId) => void downloadResource(resourceId)} onPause={(resourceId) => void pauseDesktopResourceDownload(resourceId)} onInstall={(resourceId) => void installResource(resourceId)} /></div><div hidden={overviewSection !== "account"}><StableAccountPage active={page === "overview" && overviewSection === "account"} account={account} onChanged={setAccount} onError={setMessage} /></div></div>
      <div hidden={page !== "settings"} className="desktop-page-host workspace-page"><WorkspaceTabs label="应用设置" value={settingsSection} onChange={(value) => setSettingsSection(value as SettingsSection)} items={[{ id: "general", label: "基础设置" }, { id: "ai", label: "AI 辅助" }, { id: "updates", label: "软件更新", status: softwareUpdateStatusLabel(softwareUpdate?.status || "unavailable") }]} /><div hidden={settingsSection !== "general"}><StableSettingsPage active={page === "settings" && settingsSection === "general"} value={bootstrap.settings} onSaved={(settings) => { setBootstrap((current) => current ? { ...current, settings } : current); setMessage("本地设置已保存"); void reloadResourceCatalog(); }} onError={setMessage} /></div><div hidden={settingsSection !== "ai"}><StableAiSettingsCard active={page === "settings" && settingsSection === "ai"} onMessage={setMessage} /></div><div hidden={settingsSection !== "updates"}><StableUpdatesPage active={page === "settings" && settingsSection === "updates"} value={softwareUpdate} onChanged={setSoftwareUpdate} onError={setMessage} /></div></div>
    </main><DownloadQueueDialog open={downloadQueueOpen} catalog={resourceCatalog} progress={resourceProgress} installProgress={installProgress} bulkBusy={resourceBulkBusy} onClose={() => setDownloadQueueOpen(false)} onDownload={(resourceId) => void downloadResource(resourceId)} onPause={(resourceId) => void pauseDesktopResourceDownload(resourceId)} onInstall={(resourceId) => void installResource(resourceId)} />
  </div>;
}

/** 二级分页只切换可见面板并保留已挂载表单状态，避免合并页面堆叠和重复请求。 */
function WorkspaceTabs({ label, value, items, onChange }: { label: string; value: string; items: Array<{ id: string; label: string; status?: string }>; onChange: (value: string) => void }) {
  return <nav className="workspace-tabs" aria-label={label} role="tablist">{items.map((item) => <button key={item.id} type="button" role="tab" aria-selected={value === item.id} className={value === item.id ? "active" : ""} onClick={() => onChange(item.id)}><span>{item.label}</span>{item.status && <small>{item.status}</small>}</button>)}</nav>;
}


/** 软件更新页只应用通过固定 Ed25519 公钥和完整哈希验证的在线或离线 NSIS 包。 */
function UpdatesPage({ value, onChanged, onError }: { value: DesktopSoftwareUpdateView | null; onChanged: (value: DesktopSoftwareUpdateView) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState<"check" | "download" | "offline" | "apply" | "rollback" | null>(null);
  const execute = async (kind: NonNullable<typeof busy>, operation: () => Promise<DesktopSoftwareUpdateView>) => { if (busy) return; setBusy(kind); try { onChanged(await operation()); } catch (error) { onError(errorMessage(error)); } finally { setBusy(null); } };
  const importOffline = async () => {
    try {
      const chosen = await open({ multiple: true, directory: false, filters: [{ name: "DrawHime 离线更新包", extensions: ["exe", "json"] }] });
      const paths = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
      const installerPath = paths.find((path) => path.toLowerCase().endsWith(".exe"));
      const envelopePath = paths.find((path) => path.toLowerCase().endsWith(".json"));
      if (!installerPath || !envelopePath) return onError("请同时选择 NSIS EXE 安装包和签名信封 JSON");
      await execute("offline", () => importDesktopOfflineUpdate({ installerPath, envelopePath }));
    } catch (error) { onError(errorMessage(error)); }
  };
  const apply = () => { if (window.confirm("应用更新后将打开更新助手窗口，DrawHime 会退出、完成安装并自动重新启动。是否继续？")) void execute("apply", applyDesktopSoftwareUpdate); };
  const rollback = () => { if (window.confirm(`将回滚到 ${value?.rollbackVersion || "上一版本"} 并退出程序。是否继续？`)) void execute("rollback", rollbackDesktopSoftwareUpdate); };
  if (!value) return <div className="desktop-page"><section className="section-card"><div className="empty-block"><LoaderCircle className="spin" />正在检查签名更新通道</div></section></div>;
  const available = value.status === "available";
  const ready = ["downloaded", "staged"].includes(value.status);
  return <div className="desktop-page updates-page"><section className="section-card update-overview"><header><div><span>SOFTWARE CHANNEL</span><h2>DrawHime Desktop</h2></div><b className={`is-${value.status}`}>{softwareUpdateStatusLabel(value.status)}</b></header><div className="update-version"><div><span>当前版本</span><strong>{value.currentVersion}</strong></div><RefreshCw /><div><span>稳定通道</span><strong>{value.latestVersion || value.currentVersion}</strong></div></div>{value.releaseNotes && <section><strong>版本说明</strong><p>{value.releaseNotes}</p></section>}{value.error && <div className="update-warning"><AlertTriangle /><span>{value.error}</span></div>}<div className="update-actions"><button disabled={Boolean(busy)} onClick={() => void execute("check", loadDesktopSoftwareUpdateStatus)}>{busy === "check" ? <LoaderCircle className="spin" /> : <RefreshCw />}重新检查</button><button className="primary" disabled={!available || Boolean(busy)} onClick={() => void execute("download", downloadDesktopSoftwareUpdate)}>{busy === "download" ? <LoaderCircle className="spin" /> : <Download />}{busy === "download" ? "正在断点下载" : `下载更新${value.byteSize ? ` · ${formatResourceBytes(value.byteSize)}` : ""}`}</button><button className="primary" disabled={!ready || Boolean(busy)} onClick={apply}>{busy === "apply" ? <LoaderCircle className="spin" /> : <PackageCheck />}应用并重启</button></div></section><section className="section-card update-recovery"><header><div><span>OFFLINE & ROLLBACK</span><h2>离线更新与恢复</h2></div><ShieldCheck /></header><p>离线包必须同时携带安装程序和 Ed25519 签名信封；应用前会重新验证版本、平台、大小与 SHA-256。更新不会修改模型、LoRA、训练集、任务、账号或图库队列。</p><div><button disabled={Boolean(busy)} onClick={() => void importOffline()}>{busy === "offline" ? <LoaderCircle className="spin" /> : <Upload />}导入离线更新包</button><button className="danger" disabled={!value.rollbackVersion || Boolean(busy)} onClick={rollback}>{busy === "rollback" ? <LoaderCircle className="spin" /> : <RefreshCw />}{value.rollbackVersion ? `回滚到 ${value.rollbackVersion}` : "暂无可信回滚包"}</button></div></section></div>;
}

/** 设置页把隐私、目录和上传策略真实保存到本机 SQLite。 */
function SettingsPage({ active, value, onSaved, onError }: { active: boolean; value: DesktopSettings; onSaved: (settings: DesktopSettings) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState({ ...value, dependencySource: "mirror" as const });
  const [busy, setBusy] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState<"scan" | "clean" | null>(null);
  const [cleanup, setCleanup] = useState<DesktopStorageCleanupView | null>(null);
  useEffect(() => setForm((current) => ({ ...current, themeMode: value.themeMode, fontScale: value.fontScale, contentFontScale: value.contentFontScale, dependencySource: "mirror" })), [value.themeMode, value.fontScale, value.contentFontScale]);
  useEffect(() => { if (!active) applyDesktopDisplayScale(value.fontScale, value.contentFontScale); }, [active, value.fontScale, value.contentFontScale]);
  const changed = useMemo(() => JSON.stringify(form) !== JSON.stringify(value), [form, value]);
  const previewScale = (fontScale: number, contentFontScale: number) => { applyDesktopDisplayScale(fontScale, contentFontScale); setForm((current) => ({ ...current, fontScale, contentFontScale })); };
  const save = async () => { setBusy(true); try { onSaved(await saveDesktopSettings({ ...form, dependencySource: "mirror" })); setCleanup(null); } catch (error) { applyDesktopDisplayScale(value.fontScale, value.contentFontScale); onError(errorMessage(error)); } finally { setBusy(false); } };
  const scan = async () => { if (cleanupBusy) return; setCleanupBusy("scan"); try { setCleanup(await cleanupDesktopStorage({ execute: false })); } catch (error) { onError(errorMessage(error)); } finally { setCleanupBusy(null); } };
  const clean = async () => { if (!cleanup?.totalFiles || cleanup.executed || cleanupBusy || !window.confirm(`确认清理 ${cleanup.totalFiles} 项受管残留并释放 ${formatResourceBytes(cleanup.totalBytes)}？作品、训练集和当前模型不会删除。`)) return; setCleanupBusy("clean"); try { const result = await cleanupDesktopStorage({ execute: true }); setCleanup(result); onError(`存储清理完成，释放 ${formatResourceBytes(result.totalBytes)}`); } catch (error) { onError(errorMessage(error)); } finally { setCleanupBusy(null); } };
  return <div className="desktop-page settings-page"><section className="section-card settings-card"><header><div><span>LOCAL SETTINGS</span><h2>界面、下载与存储</h2></div><ShieldCheck /></header><div className="settings-grid"><label><span>界面主题</span><select value={form.themeMode} onChange={(event) => setForm({ ...form, themeMode: event.target.value as DesktopSettings["themeMode"] })}><option value="system">跟随系统</option><option value="dark">深色</option><option value="light">亮色</option></select><small>保存后同步更新窗口与页面</small></label><label><span>页面缩放</span><select value={form.fontScale} onChange={(event) => previewScale(Number(event.target.value), form.contentFontScale)}><option value={1}>紧凑（100%）</option><option value={1.1}>默认（110%）</option><option value={1.2}>较大（120%）</option><option value={1.3}>特大（130%）</option></select><small>选择后立即预览控件和页面密度</small></label><label><span>内容字体</span><select value={form.contentFontScale} onChange={(event) => previewScale(form.fontScale, Number(event.target.value))}><option value={1}>紧凑（100%）</option><option value={1.2}>默认（120%）</option><option value={1.4}>较大（140%）</option><option value={1.6}>特大（160%）</option></select><small>选择后立即预览正文、提示词、标签和说明文字</small></label><label><span>默认图库权限</span><select value={form.defaultPrivacy} onChange={(event) => setForm({ ...form, defaultPrivacy: event.target.value as DesktopSettings["defaultPrivacy"] })}><option value="public">公开</option><option value="private">私有</option></select><small>自动上传默认公开，每次生成仍可单独覆盖</small></label><label><span>上传并发数</span><select value={form.uploadConcurrency} onChange={(event) => setForm({ ...form, uploadConcurrency: Number(event.target.value) })}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select><small>弱网环境建议 1–2</small></label><PathField label="模型目录" value={form.modelRoot} /><PathField label="作品目录" value={form.outputRoot} /><PathField label="Runtime 目录" value={form.runtimeRoot} /><label className="settings-check"><input type="checkbox" checked={form.autoUpload} onChange={(event) => setForm({ ...form, autoUpload: event.target.checked })} /><span>登录后自动上传新图片到网页图库</span></label><label className="settings-check"><input type="checkbox" checked={form.wifiOnly} onChange={(event) => setForm({ ...form, wifiOnly: event.target.checked })} /><span>仅在非计费网络同步图库</span></label></div><footer><button disabled={!changed || busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" /> : <FolderCog />}{busy ? "保存中" : "保存本地设置"}</button></footer></section><section className="section-card storage-cleanup-card"><header><div><span>STORAGE CARE</span><h2>存储清理</h2></div><HardDrive /></header><div className="storage-cleanup-summary"><i><Eraser /></i><span><strong>{cleanup ? formatResourceBytes(cleanup.totalBytes) : "等待扫描"}</strong><small>{cleanup ? cleanup.executed ? `${cleanup.totalFiles} 项受管残留已清理` : `${cleanup.totalFiles} 个受管文件或目录可清理` : "只扫描客户端创建且已无引用的文件"}</small></span><button disabled={Boolean(cleanupBusy)} onClick={() => void scan()}>{cleanupBusy === "scan" ? <LoaderCircle className="spin" /> : <ScanSearch />}{cleanup ? "重新扫描" : "扫描存储"}</button></div>{cleanup && <div className="storage-cleanup-categories">{cleanup.categories.length ? cleanup.categories.map((category) => <div key={category.key}><span><strong>{category.label}</strong><small>{category.fileCount} 项</small></span><b>{formatResourceBytes(category.byteSize)}</b></div>) : <div className="storage-cleanup-empty"><CheckCircle2 />没有发现可安全清理的受管文件</div>}</div>}<footer><span><ShieldCheck />不会删除作品、训练集、当前 Runtime、当前模型或未知文件</span><button className="danger" disabled={!cleanup?.totalFiles || cleanup.executed || Boolean(cleanupBusy)} onClick={() => void clean()}>{cleanupBusy === "clean" ? <LoaderCircle className="spin" /> : cleanup?.executed ? <CheckCircle2 /> : <Trash2 />}{cleanupBusy === "clean" ? "正在清理" : cleanup?.executed ? "清理完成" : "确认清理"}</button></footer></section></div>;
}

/** AI 设置卡统一管理真实 OpenAI 兼容端点、系统凭据和图片分析验证。 */
function AiSettingsCard({ onMessage }: { onMessage: (message: string) => void }) {
  const [saved, setSaved] = useState<DesktopAiSettings | null>(null);
  const [form, setForm] = useState<DesktopAiSettingsUpdate>({ enabled: false, endpointType: "openai_chat", baseUrl: "", model: "", apiKey: null, clearApiKey: false });
  const [busy, setBusy] = useState<"save" | "test" | "analyze" | null>(null);
  const [analysis, setAnalysis] = useState("");
  useEffect(() => { void loadDesktopAiSettings().then((value) => { setSaved(value); setForm({ enabled: value.enabled, endpointType: value.endpointType, baseUrl: value.baseUrl, model: value.model, apiKey: null, clearApiKey: false }); }).catch((error) => onMessage(errorMessage(error))); }, []);
  const save = async () => {
    if (busy) return;
    setBusy("save");
    try {
      const next = await saveDesktopAiSettings(form);
      setSaved(next);
      setForm({ enabled: next.enabled, endpointType: next.endpointType, baseUrl: next.baseUrl, model: next.model, apiKey: null, clearApiKey: false });
      onMessage("AI 辅助设置已保存，密钥已写入 Windows Credential Manager");
    } catch (error) { onMessage(errorMessage(error)); }
    finally { setBusy(null); }
  };
  const test = async () => {
    if (busy) return;
    setBusy("test");
    try { onMessage(await testDesktopAiSettings()); }
    catch (error) { onMessage(errorMessage(error)); }
    finally { setBusy(null); }
  };
  const analyze = async (purpose: "caption" | "reverse") => {
    if (busy) return;
    const selected = await open({ multiple: false, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (!selected) return;
    setBusy("analyze");
    try { setAnalysis((await analyzeDesktopImage({ imagePath: selected, purpose, userInstruction: null })).text); }
    catch (error) { onMessage(errorMessage(error)); }
    finally { setBusy(null); }
  };
  const changed = !saved || form.enabled !== saved.enabled || form.endpointType !== saved.endpointType || form.baseUrl.trim() !== saved.baseUrl || form.model.trim() !== saved.model || Boolean(form.apiKey?.trim()) || form.clearApiKey;
  return <div className="desktop-page"><section className="section-card ai-settings-card"><header><div><span>AI ASSIST</span><h2>AI 辅助配置</h2></div><div className={`ai-credential-state ${saved?.apiKeyConfigured ? "configured" : "missing"}`}><KeyRound /><span>{saved?.apiKeyConfigured ? "密钥已安全保存" : "尚未保存密钥"}</span></div></header><div className="ai-settings-grid"><label className="ai-enabled"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span><strong>启用 AI 辅助</strong><small>用于训练图片打标、提示词反推等本机工作流</small></span></label><label><span>端点类型</span><select value={form.endpointType} onChange={(event) => setForm({ ...form, endpointType: event.target.value as DesktopAiSettingsUpdate["endpointType"] })}><option value="openai_chat">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses</option></select></label><label><span>API 基础地址</span><input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://HOST/v1" autoComplete="off" /></label><label><span>视觉模型</span><input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="支持图片输入的模型名称" autoComplete="off" /></label><label><span>API Key</span><input type="password" value={form.apiKey || ""} onChange={(event) => setForm({ ...form, apiKey: event.target.value || null, clearApiKey: false })} placeholder={saved?.apiKeyConfigured ? "留空保留现有密钥" : "输入后保存到系统凭据库"} autoComplete="new-password" /></label><label className="ai-clear-key"><input type="checkbox" checked={form.clearApiKey} onChange={(event) => setForm({ ...form, clearApiKey: event.target.checked, apiKey: event.target.checked ? null : form.apiKey })} /><span>删除已保存的 API Key</span></label></div><footer className="ai-settings-actions"><button disabled={!changed || Boolean(busy)} onClick={() => void save()}>{busy === "save" ? <LoaderCircle className="spin" /> : <Save />}保存配置</button><button className="secondary" disabled={Boolean(busy) || !saved?.apiKeyConfigured} onClick={() => void test()}>{busy === "test" ? <LoaderCircle className="spin" /> : <FlaskConical />}测试连接</button></footer></section><section className="section-card ai-tool-card"><header><div><span>VISION TOOL</span><h2>图片打标与提示词反推</h2></div><small>选择图片后由已配置端点直接分析</small></header><div className="ai-tool-actions"><button disabled={Boolean(busy) || !saved?.enabled} onClick={() => void analyze("caption")}><Tags />生成 LoRA 标签</button><button disabled={Boolean(busy) || !saved?.enabled} onClick={() => void analyze("reverse")}><Sparkles />反推详细提示词</button>{analysis && <button className="secondary" onClick={() => void navigator.clipboard.writeText(analysis)}><Copy />复制结果</button>}</div>{busy === "analyze" ? <div className="ai-analysis-loading"><LoaderCircle className="spin" /><span>正在分析图片</span></div> : analysis ? <textarea className="ai-analysis-output" value={analysis} onChange={(event) => setAnalysis(event.target.value)} /> : <div className="empty-block compact">保存并启用视觉模型后，可从这里验证打标和反推链路。</div>}</section></div>;
}

/** 存储路径只读展示安装目录下的真实分类位置，避免用户误把资源分散到其他磁盘。 */
function PathField({ label, value }: { label: string; value: string }) {
  return <label className="path-field"><span>{label}</span><input value={value} readOnly /><small>路径由安装时选择的位置统一管理。</small></label>;
}
function pageTitle(page: DesktopPage): string { return { overview: "启动 / 账号", generate: "本地生成", captioning: "训练集打标", training: "LoRA 训练", models: "模型仓库", loras: "LoRA 仓库", gallery: "图库", settings: "设置" }[page]; }

function softwareUpdateStatusLabel(status: DesktopSoftwareUpdateView["status"]): string { return { unavailable: "通道暂不可达", up_to_date: "已是最新", available: "发现新版本", downloading: "下载中", downloaded: "已验证待应用", staged: "已暂存", applying: "正在更新", failed: "更新失败" }[status]; }
/** 主题选项使用简短中文标签供按钮标题和辅助技术读取。 */
function themeModeLabel(mode: DesktopSettings["themeMode"]): string { return { system: "跟随系统", dark: "深色主题", light: "亮色主题" }[mode]; }
function formatResourceBytes(value: number): string { if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KiB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`; return `${(value / 1024 ** 3).toFixed(2)} GiB`; }
function formatBytes(value: number): string { if (value <= 0) return "0 GB"; return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error || "桌面端操作失败"); }
/** 只自动清理由临时网络状态产生的旧提示，业务校验错误仍按统一时限展示。 */
function isTransientNetworkNotice(message: string): boolean { return ["超时", "连接失败", "网络传输失败", "资源清单", "下载来源"].some((fragment) => message.includes(fragment)); }
