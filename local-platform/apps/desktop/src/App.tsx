/**
 * 本文件实现桌面生成、任务、模型、Runtime、资源、环境、图库同步和本地设置的响应式工作区。
 */
import type { DesktopAccountView, DesktopBootstrapView, DesktopCaptionJobView, DesktopLocalJobView, DesktopLocalLoraView, DesktopLocalModelView, DesktopManagedFileRemovalView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopSettings, DesktopSoftwareUpdateView, DesktopStorageCleanupView, DesktopTrainingDatasetView, DesktopTrainingJobView, DesktopWebsiteLoraInstallProgress, DesktopWebsiteLoraView, DesktopWebsiteModelInstallProgress, DesktopWebsiteModelView } from "@drawhime/contracts";
import type { DesktopAiSettings, DesktopAiSettingsUpdate } from "@drawhime/contracts";
import { AlertTriangle, BookOpenCheck, CheckCircle2, Database, Download, Eraser, FlaskConical, FolderCog, Gauge, HardDrive, Image, Images, KeyRound, Layers3, LoaderCircle, Monitor, Moon, PackageCheck, RefreshCw, Save, ScanSearch, Settings2, ShieldCheck, Sparkles, Sun, Tags, Trash2, Upload } from "lucide-react";
import { Copy } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { applyDesktopSoftwareUpdate, cancelDesktopLocalJob, cleanupDesktopStorage, downloadDesktopResource, downloadDesktopSoftwareUpdate, importDesktopOfflineUpdate, inspectDesktopEnvironment, installDesktopResource, installDesktopWebsiteLora, installDesktopWebsiteModel, listDesktopCaptionJobs, listDesktopLocalJobs, listDesktopLocalLoras, listDesktopLocalModels, listDesktopTrainingDatasets, listDesktopTrainingJobs, listenDesktopCaptionJobUpdates, listenDesktopLocalJobUpdates, listenDesktopResourceInstallProgress, listenDesktopResourceProgress, listenDesktopTrainingJobUpdates, listenDesktopWebsiteLoraProgress, listenDesktopWebsiteModelProgress, loadDesktopAccountStatus, loadDesktopBootstrap, loadDesktopResourceCatalog, loadDesktopRuntimeStatus, loadDesktopSoftwareUpdateStatus, loadDesktopWebsiteLoras, loadDesktopWebsiteModels, pauseDesktopResourceDownload, rollbackDesktopSoftwareUpdate, saveDesktopSettings, selfTestDesktopRuntime, startDesktopRuntime, toggleDesktopGenerationPreview } from "./desktop-api";
import { analyzeDesktopImage, loadDesktopAiSettings, saveDesktopAiSettings, testDesktopAiSettings } from "./desktop-api";
import { AccountPage } from "./AccountPage";
import { LoraRepositoryPage, ModelRepositoryPage } from "./RepositoryPages";
import { coreResources, desktopCoreState, DownloadQueueDialog, visibleEnvironmentIssues } from "./ResourceCenter";
import { StartupPage, type StartupPhase } from "./StartupPage";
import { LocalGalleryPage, LocalJobsPage } from "./LocalGalleryPages";
import { GenerationPage } from "./GenerationPage";
import { CaptioningPage, LoraTrainingPage } from "./TrainingPages";

type DesktopPage = "overview" | "generate" | "captioning" | "training" | "models" | "loras" | "gallery" | "settings";
type OverviewSection = "start" | "account";
type GallerySection = "gallery" | "jobs";
type SettingsSection = "general" | "ai" | "updates";

const navigation = [
  { id: "overview" as const, label: "启动 / 账号", Icon: Gauge },
  { id: "generate" as const, label: "本地生成", Icon: Images },
  { id: "captioning" as const, label: "训练集打标", Icon: Tags },
  { id: "training" as const, label: "LoRA 训练", Icon: BookOpenCheck },
  { id: "models" as const, label: "模型仓库", Icon: Database },
  { id: "loras" as const, label: "LoRA 仓库", Icon: Layers3 },
  { id: "gallery" as const, label: "图库 / 记录", Icon: Image },
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

const StableGenerationPage = cacheWhileHidden(GenerationPage);
const StableModelRepositoryPage = cacheWhileHidden(ModelRepositoryPage);
const StableLoraRepositoryPage = cacheWhileHidden(LoraRepositoryPage);
const StableCaptioningPage = cacheWhileHidden(CaptioningPage);
const StableLoraTrainingPage = cacheWhileHidden(LoraTrainingPage);
const StableLocalGalleryPage = cacheWhileHidden(LocalGalleryPage);
const StableLocalJobsPage = cacheWhileHidden(LocalJobsPage);
const StableStartupPage = cacheWhileHidden(StartupPage);
const StableAccountPage = cacheWhileHidden(AccountPage);
const StableSettingsPage = cacheWhileHidden(SettingsPage);
const StableAiSettingsCard = cacheWhileHidden(AiSettingsCard);
const StableUpdatesPage = cacheWhileHidden(UpdatesPage);

/** 桌面应用根组件始终保留环境异常横幅，并周期复检 GPU 是否仍可用。 */
export function App() {
  const [page, setPage] = useState<DesktopPage>("overview");
  const [overviewSection, setOverviewSection] = useState<OverviewSection>("start");
  const [gallerySection, setGallerySection] = useState<GallerySection>("gallery");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [bootstrap, setBootstrap] = useState<DesktopBootstrapView | null>(null);
  const [resourceCatalog, setResourceCatalog] = useState<DesktopResourceCatalogView | null>(null);
  const [resourceProgress, setResourceProgress] = useState<Record<string, DesktopResourceDownloadView>>({});
  const [installProgress, setInstallProgress] = useState<Record<string, DesktopResourceInstallView>>({});
  const [models, setModels] = useState<DesktopLocalModelView[]>([]);
  const [loras, setLoras] = useState<DesktopLocalLoraView[]>([]);
  const [websiteModels, setWebsiteModels] = useState<DesktopWebsiteModelView[]>([]);
  const [websiteLoras, setWebsiteLoras] = useState<DesktopWebsiteLoraView[]>([]);
  const [websiteLoraProgress, setWebsiteLoraProgress] = useState<Record<string, DesktopWebsiteLoraInstallProgress>>({});
  const [websiteModelProgress, setWebsiteModelProgress] = useState<Record<string, DesktopWebsiteModelInstallProgress>>({});
  const [softwareUpdate, setSoftwareUpdate] = useState<DesktopSoftwareUpdateView | null>(null);
  const [trainingDatasets, setTrainingDatasets] = useState<DesktopTrainingDatasetView[]>([]);
  const [captionJobs, setCaptionJobs] = useState<DesktopCaptionJobView[]>([]);
  const [trainingJobs, setTrainingJobs] = useState<DesktopTrainingJobView[]>([]);
  const [jobs, setJobs] = useState<DesktopLocalJobView[]>([]);
  const [account, setAccount] = useState<DesktopAccountView>({ status: "signed_out", identity: null, expiresAt: null, message: "尚未连接绘图姬账号" });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [startupPhase, setStartupPhase] = useState<StartupPhase>(null);
  const [resourceBulkBusy, setResourceBulkBusy] = useState(false);
  const [downloadQueueOpen, setDownloadQueueOpen] = useState(false);
  const [message, setMessage] = useState("");
  const environmentCheckRunning = useRef(false);
  const lastEnvironmentCheckAt = useRef(0);
  const captionDatasetRefresh = useRef<number | null>(null);
  const websiteModelsLoaded = useRef(false);
  const websiteLorasLoaded = useRef(false);
  const websiteModelsLoading = useRef<Promise<void> | null>(null);
  const websiteLorasLoading = useRef<Promise<void> | null>(null);
  const websiteCatalogEpoch = useRef(0);
  const accountStatus = useRef<DesktopAccountView["status"]>("signed_out");
  const bootstrapReady = bootstrap !== null;

  useEffect(() => { void loadDesktopBootstrap().then(async (state) => { lastEnvironmentCheckAt.current = Date.now(); setBootstrap(state); const accountRequest = loadDesktopAccountStatus().catch((): DesktopAccountView => ({ status: "offline", identity: null, expiresAt: null, message: "账号服务当前未连接；全部本地功能继续可用" })); const [catalog, nextModels, nextJobs, nextLoras, nextTrainingDatasets, nextCaptionJobs, nextTrainingJobs, nextAccount] = await Promise.all([loadDesktopResourceCatalog(), listDesktopLocalModels(), listDesktopLocalJobs(), listDesktopLocalLoras(), listDesktopTrainingDatasets(), listDesktopCaptionJobs(), listDesktopTrainingJobs(), accountRequest]); setResourceCatalog(catalog); setModels(nextModels); setJobs(nextJobs); setLoras(nextLoras); setTrainingDatasets(nextTrainingDatasets); setCaptionJobs(nextCaptionJobs); setTrainingJobs(nextTrainingJobs); setAccount(nextAccount); }).catch((error) => setMessage(errorMessage(error))).finally(() => setLoading(false)); }, []);
  useEffect(() => { void loadDesktopSoftwareUpdateStatus().then(setSoftwareUpdate).catch((error) => setMessage(errorMessage(error))); }, []);
  /** 主站仓库按需读取并合并同一时刻的并发请求，避免启动阶段缓存全部示例图。 */
  const ensureWebsiteModels = useCallback((forceRefresh = false): Promise<void> => {
    if (!["connected", "offline"].includes(accountStatus.current) || (!forceRefresh && websiteModelsLoaded.current)) return Promise.resolve();
    if (websiteModelsLoading.current) return websiteModelsLoading.current;
    const epoch = websiteCatalogEpoch.current;
    const request = loadDesktopWebsiteModels(forceRefresh).then((items) => {
      if (websiteCatalogEpoch.current !== epoch) return;
      websiteModelsLoaded.current = true;
      setWebsiteModels(items);
    }).catch((error) => setMessage(errorMessage(error))).finally(() => {
      if (websiteModelsLoading.current === request) websiteModelsLoading.current = null;
    });
    websiteModelsLoading.current = request;
    return request;
  }, []);
  /** LoRA 目录仅在仓库、图库或选择器真正需要标题和封面时加载。 */
  const ensureWebsiteLoras = useCallback((forceRefresh = false): Promise<void> => {
    if (!["connected", "offline"].includes(accountStatus.current) || (!forceRefresh && websiteLorasLoaded.current)) return Promise.resolve();
    if (websiteLorasLoading.current) return websiteLorasLoading.current;
    const epoch = websiteCatalogEpoch.current;
    const request = loadDesktopWebsiteLoras(forceRefresh).then((items) => {
      if (websiteCatalogEpoch.current !== epoch) return;
      websiteLorasLoaded.current = true;
      setWebsiteLoras(items);
    }).catch((error) => setMessage(errorMessage(error))).finally(() => {
      if (websiteLorasLoading.current === request) websiteLorasLoading.current = null;
    });
    websiteLorasLoading.current = request;
    return request;
  }, []);
  useEffect(() => {
    accountStatus.current = account.status;
    websiteCatalogEpoch.current += 1;
    websiteModelsLoading.current = null;
    websiteLorasLoading.current = null;
    websiteModelsLoaded.current = false;
    websiteLorasLoaded.current = false;
    if (!["connected", "offline"].includes(account.status)) { setWebsiteModels([]); setWebsiteLoras([]); }
  }, [account.status]);
  useEffect(() => { if (page === "models") void ensureWebsiteModels(); }, [ensureWebsiteModels, page]);
  useEffect(() => { if (page === "loras" || page === "gallery") void ensureWebsiteLoras(); }, [ensureWebsiteLoras, page]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopResourceProgress((progress) => {
      setResourceProgress((current) => ({ ...current, [progress.resourceId]: progress }));
      if (progress.status === "downloaded") setMessage((current) => isTransientNetworkNotice(current) ? "" : current);
    }).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopWebsiteModelProgress((progress) => setWebsiteModelProgress((current) => ({ ...current, [progress.modelId]: progress }))).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopWebsiteLoraProgress((progress) => setWebsiteLoraProgress((current) => ({ ...current, [progress.loraId]: progress }))).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopCaptionJobUpdates((job) => {
      setCaptionJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
      if (captionDatasetRefresh.current !== null) window.clearTimeout(captionDatasetRefresh.current);
      captionDatasetRefresh.current = window.setTimeout(() => void listDesktopTrainingDatasets().then(setTrainingDatasets).catch((error) => setMessage(errorMessage(error))), 120);
    }).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => { unlisten?.(); if (captionDatasetRefresh.current !== null) window.clearTimeout(captionDatasetRefresh.current); };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopTrainingJobUpdates((job) => {
      setTrainingJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
      if (job.status === "succeeded") void listDesktopLocalLoras().then(setLoras).catch((error) => setMessage(errorMessage(error)));
    }).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopLocalJobUpdates((job) => setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)))).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopResourceInstallProgress((progress) => {
      setInstallProgress((current) => ({ ...current, [progress.resourceId]: progress }));
      if (progress.status === "installed") setMessage((current) => isTransientNetworkNotice(current) ? "" : current);
    }).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => unlisten?.();
  }, []);
  /** 顶部操作提示是瞬时反馈，超时类错误不会在后续页面中永久残留。 */
  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(() => setMessage(""), isTransientNetworkNotice(message) ? 6_000 : 4_000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    if (!bootstrapReady) return;
    const timer = window.setInterval(() => void recheck(true), 90_000);
    const onVisibility = () => { if (document.visibilityState === "visible" && Date.now() - lastEnvironmentCheckAt.current >= 30_000) void recheck(true); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [bootstrapReady]);
  useEffect(() => {
    if (!bootstrapReady) return;
    // checkedAt 每次轮询都会变化；只有可见生命周期字段变化时才更新根状态。
    const timer = window.setInterval(() => void loadDesktopRuntimeStatus().then((runtime) => setBootstrap((current) => current && !sameRuntimeState(current.runtime, runtime) ? { ...current, runtime } : current)).catch(() => undefined), 5_000);
    return () => window.clearInterval(timer);
  }, [bootstrapReady]);

  useEffect(() => {
    if (!bootstrap) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    /** 同时更新 WebView 语义主题和原生标题栏，系统主题变化无需重启。 */
    const applyTheme = () => {
      const resolved = bootstrap.settings.themeMode === "system" ? (media.matches ? "dark" : "light") : bootstrap.settings.themeMode;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      document.documentElement.style.setProperty("--desktop-font-scale", String(bootstrap.settings.fontScale));
      document.documentElement.style.setProperty("--desktop-viewport-height", `${100 / bootstrap.settings.fontScale}vh`);
      void getCurrentWindow().setTheme(resolved).catch(() => undefined);
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [bootstrap?.settings.themeMode, bootstrap?.settings.fontScale]);

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
    try { setResourceCatalog(await loadDesktopResourceCatalog()); setMessage((current) => isTransientNetworkNotice(current) ? "" : current); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setCatalogLoading(false); }
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
    setInstallProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "verifying", progress: 0, installPath: null, rollbackPath: null, error: null } }));
    try { const progress = await installDesktopResource(resourceId); setInstallProgress((current) => ({ ...current, [resourceId]: progress })); const [, , nextModels] = await Promise.all([reloadResourceCatalog(), recheck(true), listDesktopLocalModels()]); setModels(nextModels); setMessage((current) => isTransientNetworkNotice(current) ? "" : current); return true; }
    catch (error) { const message = errorMessage(error); setInstallProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "failed", progress: current[resourceId]?.progress || 0, installPath: null, rollbackPath: null, error: message } })); if (message.includes("已隔离")) setResourceProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "failed", sourceKind: current[resourceId]?.sourceKind || null, downloadedBytes: 0, totalBytes: resourceCatalog?.resources.find((item) => item.id === resourceId)?.byteSize || current[resourceId]?.totalBytes || 1, bytesPerSecond: 0, etaSeconds: null, targetPath: null, error: message } })); await reloadResourceCatalog(); setMessage(message); return false; }
  };

  /** 初始化严格按签名清单顺序安装核心资源，任一失败即停止并保留断点。 */
  const installCoreResources = async (catalog: DesktopResourceCatalogView, forceResourceIds: string[] = []): Promise<boolean> => {
    if (!catalog.configured || resourceBulkBusy) return false;
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

  /** 仓库刷新并行读取本机登记、签名资源与主站元数据，任一远端失败不清空本机条目。 */
  const refreshRepositories = async () => {
    setCatalogLoading(true);
    try {
      const canReadCatalog = ["connected", "offline"].includes(account.status);
      const remoteModels = canReadCatalog ? loadDesktopWebsiteModels(true).catch(() => websiteModels) : Promise.resolve([]);
      const remoteLoras = canReadCatalog ? loadDesktopWebsiteLoras(true).catch(() => websiteLoras) : Promise.resolve([]);
      const [catalog, nextModels, nextLoras, nextWebsiteModels, nextWebsiteLoras] = await Promise.all([loadDesktopResourceCatalog(), listDesktopLocalModels(), listDesktopLocalLoras(), remoteModels, remoteLoras]);
      websiteModelsLoaded.current = canReadCatalog;
      websiteLorasLoaded.current = canReadCatalog;
      setResourceCatalog(catalog); setModels(nextModels); setLoras(nextLoras); setWebsiteModels(nextWebsiteModels); setWebsiteLoras(nextWebsiteLoras); setMessage("模型与 LoRA 仓库已刷新");
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setCatalogLoading(false); }
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
      const [finalEnvironment, nextModels] = await Promise.all([inspectDesktopEnvironment(), listDesktopLocalModels()]);
      setModels(nextModels);
      setBootstrap((current) => current ? { ...current, runtime, environment: finalEnvironment } : current);
      setMessage(needsInitialization ? "初始化完成，本地核心已自动启动" : "本地核心已启动");
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setStartupPhase(null); }
  };

  /** 模型导入和任务创建只更新对应集合，页面切换不会清空用户尚未提交的表单。 */
  const modelImported = (model: DesktopLocalModelView) => {
    setModels((current) => [model, ...current.filter((item) => item.id !== model.id)]);
    setMessage(`模型“${model.displayName}”已完成校验并导入`);
    void recheck(true);
  };
  /** LoRA 导入完成后按 ID 更新本地仓库，不重建生成页以保留用户输入。 */
  const loraImported = (lora: DesktopLocalLoraView) => {
    setLoras((current) => [lora, ...current.filter((item) => item.id !== lora.id)]);
    setMessage(`LoRA“${lora.title}”已完成校验并导入`);
  };
  /** 删除只改变受管文件可用性，刷新列表后历史任务仍保留原模型和 LoRA 快照。 */
  const managedFileDeleted = async (result: DesktopManagedFileRemovalView) => {
    if (result.kind === "model") { setModels(await listDesktopLocalModels()); void recheck(true); }
    else { setLoras(await listDesktopLocalLoras()); }
    const retained = result.retainedSharedFiles ? `，保留 ${result.retainedSharedFiles} 个共享组件` : "";
    setMessage(result.removed ? `已删除 ${result.fileName}，释放 ${formatResourceBytes(result.freedBytes)}${retained}` : `${result.fileName} 已不在本机`);
  };
  /** 网站 LoRA 安装后同时刷新本机与网站目录的安装状态。 */
  const installWebsiteLora = async (id: string) => {
    try { loraImported(await installDesktopWebsiteLora(id)); setWebsiteLoras(await loadDesktopWebsiteLoras()); websiteLorasLoaded.current = true; }
    catch (error) { const message = errorMessage(error); setWebsiteLoraProgress((current) => ({ ...current, [id]: { loraId: id, status: "failed", downloadedBytes: current[id]?.downloadedBytes || 0, totalBytes: current[id]?.totalBytes || 1, bytesPerSecond: 0, error: message } })); setMessage(message); }
  };
  /** 所有仓库底模不依赖签名资源组，直接按主站目录 SHA-256 安装并刷新本机模型。 */
  const installWebsiteModel = async (id: string) => {
    try { modelImported(await installDesktopWebsiteModel(id)); setWebsiteModels(await loadDesktopWebsiteModels()); websiteModelsLoaded.current = true; }
    catch (error) {
      const message = errorMessage(error);
      const totalBytes = websiteModels.find((item) => item.id === id)?.download?.byteSize || websiteModelProgress[id]?.totalBytes || 1;
      setWebsiteModelProgress((current) => ({ ...current, [id]: { modelId: id, status: "failed", downloadedBytes: current[id]?.downloadedBytes || 0, totalBytes, bytesPerSecond: 0, error: message } }));
      setMessage(message);
    }
  };
  /** 训练集任一步骤成功后按 ID 更新并置顶，页面实例保持当前输入。 */
  const trainingDatasetUpdated = (dataset: DesktopTrainingDatasetView) => {
    setTrainingDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)]);
  };
  /** 打标任务按 ID 实时更新，数据库事件是进度事实源。 */
  const captionJobUpdated = (job: DesktopCaptionJobView) => {
    setCaptionJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  };
  /** 训练提交和取消均按 ID 更新同一条持久化任务。 */
  const trainingJobUpdated = (job: DesktopTrainingJobView) => {
    setTrainingJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
    // 训练产物由 Rust 核心原子登记，成功事件后立即刷新 LoRA 仓库，页面无需重启才能使用。
    if (job.status === "succeeded" && job.outputLoraId) void listDesktopLocalLoras().then(setLoras).catch((error) => setMessage(errorMessage(error)));
  };
  const jobCreated = (job: DesktopLocalJobView) => {
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    setMessage("本地任务已进入持久队列");
  };
  const cancelJob = async (id: string) => {
    try { const job = await cancelDesktopLocalJob(id); setJobs((current) => current.map((item) => item.id === id ? job : item)); setMessage("已提交取消请求"); }
    catch (error) { setMessage(errorMessage(error)); }
  };
  /** 预览窗口以 Rust 中的真实窗口状态为准，关闭或最小化不会影响当前生成表单。 */
  const toggleGenerationPreview = async () => {
    try { await toggleDesktopGenerationPreview(); }
    catch (error) { setMessage(errorMessage(error)); }
  };

  if (loading || !bootstrap) return <div className="desktop-loading"><LoaderCircle className="spin" /><strong>正在建立本地工作区</strong><span>{message || "读取硬件、磁盘与本地数据库"}</span></div>;
  const visibleIssues = visibleEnvironmentIssues(bootstrap.environment);
  const critical = visibleIssues.find((issue) => issue.severity === "critical") || visibleIssues[0];
  const requiredResources = coreResources(resourceCatalog);
  const startupInitialized = requiredResources.length > 0 && requiredResources.every((resource) => resource.installed) && bootstrap.environment.runtime.status === "ready";
  const coreState = desktopCoreState(bootstrap, resourceCatalog);
  return <div className="desktop-shell" data-environment-status={bootstrap.environment.status} data-inference-ready={bootstrap.environment.capabilities.inference} data-training-ready={bootstrap.environment.capabilities.training}>
    <aside className="desktop-sidebar"><header><div className="desktop-mark">D</div><div><strong>DrawHime</strong><span>DESKTOP</span></div></header><nav>{navigation.map(({ id, label, Icon }) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={17} />{label}{((id === "overview" && (bootstrap.environment.status !== "ready" || account.status !== "connected")) || (id === "gallery" && jobs.some((job) => ["queued", "running"].includes(job.status)))) && <i />}</button>)}</nav><div className="theme-switch sidebar-theme-switch" aria-label="界面主题">{(["system", "dark", "light"] as const).map((mode) => { const Icon = mode === "system" ? Monitor : mode === "dark" ? Moon : Sun; return <button key={mode} className={bootstrap.settings.themeMode === mode ? "active" : ""} aria-label={themeModeLabel(mode)} title={themeModeLabel(mode)} disabled={themeSaving} onClick={() => void changeTheme(mode)}><Icon /></button>; })}</div><button type="button" className={`core-status is-${coreState.kind}`} onClick={() => setDownloadQueueOpen(true)} aria-label={`${coreState.label}，查看下载队列`}><Download className="core-status-icon" /><span>本地核心 · 点击查看队列</span><strong>{coreState.label}</strong><small>{coreState.detail}</small></button></aside>
    <main className="desktop-main">
      <header className="desktop-topbar"><div className="desktop-title"><span>本地模型工作站</span><strong>{pageTitle(page)}</strong></div></header>
       {bootstrap.environment.status !== "ready" && critical && <section className={`environment-banner is-${critical.severity}`}><AlertTriangle /><div><strong>{critical.title}</strong><span>{critical.message}</span></div><button onClick={() => { setPage("overview"); setOverviewSection("start"); }}>查看启动状态</button></section>}
      {message && <div className="desktop-notice" role="status" aria-live="polite"><span>{message}</span><button aria-label="关闭提示" onClick={() => setMessage("")}>×</button></div>}
      <div hidden={page !== "generate"}><StableGenerationPage active={page === "generate"} models={models} loras={loras} websiteLoras={websiteLoras} websiteLoraProgress={websiteLoraProgress} inferenceReady={bootstrap.environment.capabilities.inference} defaultPrivacy={bootstrap.settings.defaultPrivacy} onCreated={jobCreated} onInstallWebsiteLora={(id) => void installWebsiteLora(id)} onOpenLoraLibrary={() => void ensureWebsiteLoras()} onTogglePreview={() => void toggleGenerationPreview()} onError={setMessage} /></div>
      <div hidden={page !== "models"}><StableModelRepositoryPage active={page === "models"} models={models} websiteModels={websiteModels} jobs={jobs} websiteProgress={websiteModelProgress} accountConnected={account.status === "connected"} modelRoot={bootstrap.settings.modelRoot} onRefresh={() => void refreshRepositories()} onInstallWebsite={(id) => void installWebsiteModel(id)} onImported={modelImported} onDeleted={(result) => void managedFileDeleted(result)} onOpenSettings={() => { setPage("settings"); setSettingsSection("general"); }} onError={setMessage} /></div>
      <div hidden={page !== "loras"}><StableLoraRepositoryPage active={page === "loras"} loras={loras} websiteLoras={websiteLoras} jobs={jobs} progress={websiteLoraProgress} accountConnected={account.status === "connected"} modelRoot={bootstrap.settings.modelRoot} onRefresh={() => void refreshRepositories()} onInstall={(id) => void installWebsiteLora(id)} onImported={loraImported} onDeleted={(result) => void managedFileDeleted(result)} onError={setMessage} /></div>
      <div hidden={page !== "captioning"}><StableCaptioningPage active={page === "captioning"} datasets={trainingDatasets} captionJobs={captionJobs} captioningReady={bootstrap.environment.capabilities.captioning} onUpdated={trainingDatasetUpdated} onCaptionJobUpdated={captionJobUpdated} onOpenResources={() => { setPage("overview"); setOverviewSection("start"); }} onError={setMessage} /></div>
      <div hidden={page !== "training"}><StableLoraTrainingPage active={page === "training"} datasets={trainingDatasets} trainingJobs={trainingJobs} models={models} trainingReady={bootstrap.environment.capabilities.training} onTrainingJobUpdated={trainingJobUpdated} onOpenResources={() => { setPage("overview"); setOverviewSection("start"); }} onError={setMessage} /></div>
       <div hidden={page !== "overview"} className="workspace-page"><WorkspaceTabs label="启动与账号" value={overviewSection} onChange={(value) => setOverviewSection(value as OverviewSection)} items={[{ id: "start", label: "启动", status: bootstrap.runtime.status === "ready" ? "运行中" : startupInitialized ? "可启动" : "待初始化" }, { id: "account", label: "账号", status: account.status === "connected" ? "已连接" : "未连接" }]} /><div hidden={overviewSection !== "start"}><StableStartupPage active={page === "overview" && overviewSection === "start"} state={bootstrap} catalog={resourceCatalog} progress={resourceProgress} installProgress={installProgress} phase={startupPhase} checking={checking} bulkBusy={resourceBulkBusy} onPrimary={() => void runStartup()} onRecheck={() => void recheck()} onOpenQueue={() => setDownloadQueueOpen(true)} onInstallRequired={() => resourceCatalog && void installCoreResources(resourceCatalog)} onDownload={(resourceId) => void downloadResource(resourceId)} onPause={(resourceId) => void pauseDesktopResourceDownload(resourceId)} onInstall={(resourceId) => void installResource(resourceId)} /></div><div hidden={overviewSection !== "account"}><StableAccountPage active={page === "overview" && overviewSection === "account"} account={account} onChanged={setAccount} onError={setMessage} /></div></div>
      <div hidden={page !== "gallery"} className="workspace-page"><WorkspaceTabs label="图库与本地记录" value={gallerySection} onChange={(value) => setGallerySection(value as GallerySection)} items={[{ id: "gallery", label: "图库", status: `${jobs.filter((job) => job.artifact).length} 张` }, { id: "jobs", label: "记录", status: `${jobs.length} 项` }]} /><div hidden={gallerySection !== "gallery"}><StableLocalGalleryPage active={page === "gallery" && gallerySection === "gallery"} jobs={jobs} loras={loras} websiteLoras={websiteLoras} /></div><div hidden={gallerySection !== "jobs"}><StableLocalJobsPage active={page === "gallery" && gallerySection === "jobs"} jobs={jobs} loras={loras} websiteLoras={websiteLoras} onCancel={(id) => void cancelJob(id)} /></div></div>
      <div hidden={page !== "settings"} className="workspace-page"><WorkspaceTabs label="应用设置" value={settingsSection} onChange={(value) => setSettingsSection(value as SettingsSection)} items={[{ id: "general", label: "基础设置" }, { id: "ai", label: "AI 辅助" }, { id: "updates", label: "软件更新", status: softwareUpdateStatusLabel(softwareUpdate?.status || "unavailable") }]} /><div hidden={settingsSection !== "general"}><StableSettingsPage active={page === "settings" && settingsSection === "general"} value={bootstrap.settings} onSaved={(settings) => { setBootstrap((current) => current ? { ...current, settings } : current); setMessage("本地设置已保存"); void reloadResourceCatalog(); }} onError={setMessage} /></div><div hidden={settingsSection !== "ai"}><StableAiSettingsCard active={page === "settings" && settingsSection === "ai"} onMessage={setMessage} /></div><div hidden={settingsSection !== "updates"}><StableUpdatesPage active={page === "settings" && settingsSection === "updates"} value={softwareUpdate} onChanged={setSoftwareUpdate} onError={setMessage} /></div></div>
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
function SettingsPage({ value, onSaved, onError }: { value: DesktopSettings; onSaved: (settings: DesktopSettings) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState({ ...value, dependencySource: "mirror" as const });
  const [busy, setBusy] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState<"scan" | "clean" | null>(null);
  const [cleanup, setCleanup] = useState<DesktopStorageCleanupView | null>(null);
  useEffect(() => setForm((current) => ({ ...current, themeMode: value.themeMode, fontScale: value.fontScale, dependencySource: "mirror" })), [value.themeMode, value.fontScale]);
  const changed = useMemo(() => JSON.stringify(form) !== JSON.stringify(value), [form, value]);
  const save = async () => { setBusy(true); try { onSaved(await saveDesktopSettings({ ...form, dependencySource: "mirror" })); setCleanup(null); } catch (error) { onError(errorMessage(error)); } finally { setBusy(false); } };
  const scan = async () => { if (cleanupBusy) return; setCleanupBusy("scan"); try { setCleanup(await cleanupDesktopStorage({ execute: false })); } catch (error) { onError(errorMessage(error)); } finally { setCleanupBusy(null); } };
  const clean = async () => { if (!cleanup?.totalFiles || cleanup.executed || cleanupBusy || !window.confirm(`确认清理 ${cleanup.totalFiles} 项受管残留并释放 ${formatResourceBytes(cleanup.totalBytes)}？作品、训练集和当前模型不会删除。`)) return; setCleanupBusy("clean"); try { const result = await cleanupDesktopStorage({ execute: true }); setCleanup(result); onError(`存储清理完成，释放 ${formatResourceBytes(result.totalBytes)}`); } catch (error) { onError(errorMessage(error)); } finally { setCleanupBusy(null); } };
  return <div className="desktop-page settings-page"><section className="section-card settings-card"><header><div><span>LOCAL SETTINGS</span><h2>界面、下载与存储</h2></div><ShieldCheck /></header><div className="settings-grid"><label><span>界面主题</span><select value={form.themeMode} onChange={(event) => setForm({ ...form, themeMode: event.target.value as DesktopSettings["themeMode"] })}><option value="system">跟随系统</option><option value="dark">深色</option><option value="light">亮色</option></select><small>保存后同步更新窗口与页面</small></label><label><span>字体大小</span><select value={form.fontScale} onChange={(event) => setForm({ ...form, fontScale: Number(event.target.value) })}><option value={1}>紧凑（100%）</option><option value={1.1}>默认（110%）</option><option value={1.2}>较大（120%）</option><option value={1.3}>特大（130%）</option></select><small>调整整个工作区文字和控件比例</small></label><label><span>默认图库权限</span><select value={form.defaultPrivacy} onChange={(event) => setForm({ ...form, defaultPrivacy: event.target.value as DesktopSettings["defaultPrivacy"] })}><option value="public">公开</option><option value="private">私有</option></select><small>自动上传默认公开，每次生成仍可单独覆盖</small></label><label><span>上传并发数</span><select value={form.uploadConcurrency} onChange={(event) => setForm({ ...form, uploadConcurrency: Number(event.target.value) })}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select><small>弱网环境建议 1–2</small></label><PathField label="模型目录" value={form.modelRoot} /><PathField label="作品目录" value={form.outputRoot} /><PathField label="Runtime 目录" value={form.runtimeRoot} /><label className="settings-check"><input type="checkbox" checked={form.autoUpload} onChange={(event) => setForm({ ...form, autoUpload: event.target.checked })} /><span>登录后自动上传新图片到网页图库</span></label><label className="settings-check"><input type="checkbox" checked={form.wifiOnly} onChange={(event) => setForm({ ...form, wifiOnly: event.target.checked })} /><span>仅在非计费网络同步图库</span></label></div><footer><button disabled={!changed || busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" /> : <FolderCog />}{busy ? "保存中" : "保存本地设置"}</button></footer></section><section className="section-card storage-cleanup-card"><header><div><span>STORAGE CARE</span><h2>存储清理</h2></div><HardDrive /></header><div className="storage-cleanup-summary"><i><Eraser /></i><span><strong>{cleanup ? formatResourceBytes(cleanup.totalBytes) : "等待扫描"}</strong><small>{cleanup ? cleanup.executed ? `${cleanup.totalFiles} 项受管残留已清理` : `${cleanup.totalFiles} 个受管文件或目录可清理` : "只扫描客户端创建且已无引用的文件"}</small></span><button disabled={Boolean(cleanupBusy)} onClick={() => void scan()}>{cleanupBusy === "scan" ? <LoaderCircle className="spin" /> : <ScanSearch />}{cleanup ? "重新扫描" : "扫描存储"}</button></div>{cleanup && <div className="storage-cleanup-categories">{cleanup.categories.length ? cleanup.categories.map((category) => <div key={category.key}><span><strong>{category.label}</strong><small>{category.fileCount} 项</small></span><b>{formatResourceBytes(category.byteSize)}</b></div>) : <div className="storage-cleanup-empty"><CheckCircle2 />没有发现可安全清理的受管文件</div>}</div>}<footer><span><ShieldCheck />不会删除作品、训练集、当前 Runtime、当前模型或未知文件</span><button className="danger" disabled={!cleanup?.totalFiles || cleanup.executed || Boolean(cleanupBusy)} onClick={() => void clean()}>{cleanupBusy === "clean" ? <LoaderCircle className="spin" /> : cleanup?.executed ? <CheckCircle2 /> : <Trash2 />}{cleanupBusy === "clean" ? "正在清理" : cleanup?.executed ? "清理完成" : "确认清理"}</button></footer></section></div>;
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
function pageTitle(page: DesktopPage): string { return { overview: "启动 / 账号", generate: "本地生成", captioning: "训练集打标", training: "LoRA 训练", models: "模型仓库", loras: "LoRA 仓库", gallery: "图库 / 记录", settings: "设置" }[page]; }

/** Runtime 的检查时间不影响页面外显，排除该字段可避免每五秒重绘整个工作区。 */
function sameRuntimeState(previous: DesktopBootstrapView["runtime"], next: DesktopBootstrapView["runtime"]): boolean {
  return previous.status === next.status && previous.pid === next.pid && previous.port === next.port && previous.startedAt === next.startedAt && previous.logPath === next.logPath && previous.error === next.error;
}

/** LoRA 类型统一使用中文外显，数据库和契约仍保存稳定英文枚举。 */
function loraTypeLabel(type: string): string { return { style: "画风", character: "角色", concept: "概念", clothing: "服装", pose: "姿势", other: "其他" }[type] || type; }
function websiteLoraProgressLabel(progress: DesktopWebsiteLoraInstallProgress): string { return { downloading: "下载中", verifying: "校验中", installing: "安装中", installed: "已安装", failed: "失败" }[progress.status]; }
function softwareUpdateStatusLabel(status: DesktopSoftwareUpdateView["status"]): string { return { unavailable: "通道暂不可达", up_to_date: "已是最新", available: "发现新版本", downloading: "下载中", downloaded: "已验证待应用", staged: "已暂存", applying: "正在更新", failed: "更新失败" }[status]; }
/** 主题选项使用简短中文标签供按钮标题和辅助技术读取。 */
function themeModeLabel(mode: DesktopSettings["themeMode"]): string { return { system: "跟随系统", dark: "深色主题", light: "亮色主题" }[mode]; }
function formatResourceBytes(value: number): string { if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KiB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`; return `${(value / 1024 ** 3).toFixed(2)} GiB`; }
function formatBytes(value: number): string { if (value <= 0) return "0 GB"; return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error || "桌面端操作失败"); }
/** 只自动清理由临时网络状态产生的旧提示，业务校验错误仍按统一时限展示。 */
function isTransientNetworkNotice(message: string): boolean { return ["超时", "连接失败", "网络传输失败", "资源清单", "下载来源"].some((fragment) => message.includes(fragment)); }
