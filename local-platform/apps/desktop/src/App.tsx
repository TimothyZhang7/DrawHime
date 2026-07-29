/**
 * 本文件实现桌面生成、任务、模型、Runtime、资源、环境、图库同步和本地设置的响应式工作区。
 */
import type { DesktopBootstrapView, DesktopEnvironmentReport, DesktopGallerySyncItem, DesktopLocalJobCreateInput, DesktopLocalJobView, DesktopLocalLoraImportInput, DesktopLocalLoraView, DesktopLocalModelImportInput, DesktopLocalModelView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopRuntimeStatusView, DesktopSettings, DesktopTrainingDatasetCreateInput, DesktopTrainingDatasetView } from "@drawhime/contracts";
import { Activity, AlertTriangle, BookOpenCheck, CheckCircle2, Cpu, Database, Download, FlaskConical, FolderCog, FolderPlus, Gauge, HardDrive, Image, Images, Layers3, LoaderCircle, MemoryStick, Monitor, Moon, PackageCheck, PackageOpen, Play, Power, RefreshCw, Save, Settings2, ShieldCheck, Sun, Upload, UploadCloud, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { addDesktopTrainingImages, cancelDesktopLocalJob, confirmDesktopTrainingDataset, createDesktopLocalJob, createDesktopTrainingDataset, downloadDesktopResource, importDesktopLocalLora, importDesktopLocalModel, inspectDesktopEnvironment, installDesktopResource, listDesktopGallerySyncQueue, listDesktopLocalJobs, listDesktopLocalLoras, listDesktopLocalModels, listDesktopTrainingDatasets, listenDesktopLocalJobUpdates, listenDesktopResourceInstallProgress, listenDesktopResourceProgress, loadDesktopBootstrap, loadDesktopResourceCatalog, loadDesktopRuntimeStatus, saveDesktopSettings, selfTestDesktopRuntime, startDesktopRuntime, stopDesktopRuntime, updateDesktopTrainingCaption } from "./desktop-api";

type DesktopPage = "generate" | "jobs" | "models" | "loras" | "training" | "overview" | "environment" | "resources" | "sync" | "settings";

const navigation = [
  { id: "generate" as const, label: "本地生成", Icon: Images },
  { id: "jobs" as const, label: "任务记录", Icon: Image },
  { id: "models" as const, label: "本地模型", Icon: Database },
  { id: "loras" as const, label: "LoRA 仓库", Icon: Layers3 },
  { id: "training" as const, label: "LoRA 训练", Icon: BookOpenCheck },
  { id: "overview" as const, label: "本机概览", Icon: Gauge },
  { id: "environment" as const, label: "环境检测", Icon: Cpu },
  { id: "resources" as const, label: "资源安装", Icon: PackageOpen },
  { id: "sync" as const, label: "图库同步", Icon: UploadCloud },
  { id: "settings" as const, label: "本地设置", Icon: Settings2 },
];

/** 桌面应用根组件始终保留环境异常横幅，并周期复检 GPU 是否仍可用。 */
export function App() {
  const [page, setPage] = useState<DesktopPage>("generate");
  const [bootstrap, setBootstrap] = useState<DesktopBootstrapView | null>(null);
  const [queue, setQueue] = useState<DesktopGallerySyncItem[]>([]);
  const [resourceCatalog, setResourceCatalog] = useState<DesktopResourceCatalogView | null>(null);
  const [resourceProgress, setResourceProgress] = useState<Record<string, DesktopResourceDownloadView>>({});
  const [installProgress, setInstallProgress] = useState<Record<string, DesktopResourceInstallView>>({});
  const [models, setModels] = useState<DesktopLocalModelView[]>([]);
  const [loras, setLoras] = useState<DesktopLocalLoraView[]>([]);
  const [trainingDatasets, setTrainingDatasets] = useState<DesktopTrainingDatasetView[]>([]);
  const [jobs, setJobs] = useState<DesktopLocalJobView[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [resourceBulkBusy, setResourceBulkBusy] = useState(false);
  const [message, setMessage] = useState("");
  const environmentCheckRunning = useRef(false);
  const lastEnvironmentCheckAt = useRef(0);
  const bootstrapReady = bootstrap !== null;

  useEffect(() => { void loadDesktopBootstrap().then(async (state) => { lastEnvironmentCheckAt.current = Date.now(); setBootstrap(state); const [nextQueue, catalog, nextModels, nextJobs, nextLoras, nextTrainingDatasets] = await Promise.all([listDesktopGallerySyncQueue(), loadDesktopResourceCatalog(), listDesktopLocalModels(), listDesktopLocalJobs(), listDesktopLocalLoras(), listDesktopTrainingDatasets()]); setQueue(nextQueue); setResourceCatalog(catalog); setModels(nextModels); setJobs(nextJobs); setLoras(nextLoras); setTrainingDatasets(nextTrainingDatasets); }).catch((error) => setMessage(errorMessage(error))).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopResourceProgress((progress) => setResourceProgress((current) => ({ ...current, [progress.resourceId]: progress }))).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopLocalJobUpdates((job) => setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)))).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopResourceInstallProgress((progress) => setInstallProgress((current) => ({ ...current, [progress.resourceId]: progress }))).then((dispose) => { unlisten = dispose; }).catch((error) => setMessage(errorMessage(error)));
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
    if (!bootstrapReady) return;
    const timer = window.setInterval(() => void loadDesktopRuntimeStatus().then((runtime) => setBootstrap((current) => current ? { ...current, runtime } : current)).catch(() => undefined), 5_000);
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
    try { const progress = await downloadDesktopResource(resourceId); setResourceProgress((current) => ({ ...current, [resourceId]: progress })); await reloadResourceCatalog(); return true; }
    catch (error) { const message = errorMessage(error); setResourceProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "failed", sourceKind: null, downloadedBytes: current[resourceId]?.downloadedBytes || 0, totalBytes, bytesPerSecond: 0, targetPath: null, error: message } })); setMessage(message); return false; }
  };

  /** 安装使用已验证缓存；完成后同步刷新资源状态与 Runtime 环境门禁。 */
  const installResource = async (resourceId: string) => {
    setInstallProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "verifying", progress: 0, installPath: null, rollbackPath: null, error: null } }));
    try { const progress = await installDesktopResource(resourceId); setInstallProgress((current) => ({ ...current, [resourceId]: progress })); const [, , nextModels] = await Promise.all([reloadResourceCatalog(), recheck(true), listDesktopLocalModels()]); setModels(nextModels); return true; }
    catch (error) { const message = errorMessage(error); setInstallProgress((current) => ({ ...current, [resourceId]: { resourceId, status: "failed", progress: current[resourceId]?.progress || 0, installPath: null, rollbackPath: null, error: message } })); setMessage(message); return false; }
  };

  /** 一键安装严格按签名清单顺序串行下载和安装，任一失败即停止并保留断点。 */
  const installRequiredResources = async () => {
    if (!resourceCatalog?.configured || resourceBulkBusy) return;
    setResourceBulkBusy(true);
    try {
      for (const resource of resourceCatalog.resources.filter((item) => item.required && !item.installed)) {
        if (!resource.downloaded && !(await downloadResource(resource.id))) return;
        if (!(await installResource(resource.id))) return;
      }
      setMessage("全部必需资源已安装并完成模型登记");
    } finally { setResourceBulkBusy(false); }
  };

  /** Runtime 控制始终等待本地核心返回真实状态，自检成功后同步刷新环境能力门禁。 */
  const controlRuntime = async (action: "start" | "stop" | "selfTest") => {
    if (runtimeBusy) return;
    setRuntimeBusy(true);
    try {
      const runtime = action === "start" ? await startDesktopRuntime() : action === "stop" ? await stopDesktopRuntime() : await selfTestDesktopRuntime();
      setBootstrap((current) => current ? { ...current, runtime } : current);
      if (action === "selfTest") await recheck(true);
      setMessage(action === "start" ? "本地 Runtime 已启动" : action === "stop" ? "本地 Runtime 已停止" : "Runtime GPU 与核心节点自检通过");
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setRuntimeBusy(false); }
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
  /** 训练集任一步骤成功后按 ID 更新并置顶，页面实例保持当前输入。 */
  const trainingDatasetUpdated = (dataset: DesktopTrainingDatasetView) => {
    setTrainingDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)]);
  };
  const jobCreated = (job: DesktopLocalJobView) => {
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    setMessage("本地任务已进入持久队列");
  };
  const cancelJob = async (id: string) => {
    try { const job = await cancelDesktopLocalJob(id); setJobs((current) => current.map((item) => item.id === id ? job : item)); setMessage("已提交取消请求"); }
    catch (error) { setMessage(errorMessage(error)); }
  };

  if (loading || !bootstrap) return <div className="desktop-loading"><LoaderCircle className="spin" /><strong>正在建立本地工作区</strong><span>{message || "读取硬件、磁盘与本地数据库"}</span></div>;
  const critical = bootstrap.environment.issues.find((issue) => issue.severity === "critical") || bootstrap.environment.issues[0];
  return <div className="desktop-shell">
    <aside className="desktop-sidebar"><header><div className="desktop-mark">D</div><div><strong>DrawHime</strong><span>DESKTOP</span></div></header><nav>{navigation.map(({ id, label, Icon }) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={17} />{label}{((id === "environment" && bootstrap.environment.status !== "ready") || (id === "jobs" && jobs.some((job) => ["queued", "running"].includes(job.status)))) && <i />}</button>)}</nav><footer><span>本地核心</span><strong>{bootstrap.runtime.status === "ready" ? "Runtime 运行中" : "Runtime 已停止"}</strong></footer></aside>
    <main className="desktop-main">
      <header className="desktop-topbar"><div className="desktop-title"><span>本地模型工作站</span><strong>{pageTitle(page)}</strong></div><div className="topbar-actions"><div className="theme-switch" aria-label="界面主题">{(["system", "dark", "light"] as const).map((mode) => { const Icon = mode === "system" ? Monitor : mode === "dark" ? Moon : Sun; return <button key={mode} className={bootstrap.settings.themeMode === mode ? "active" : ""} aria-label={themeModeLabel(mode)} title={themeModeLabel(mode)} disabled={themeSaving} onClick={() => void changeTheme(mode)}><Icon /></button>; })}</div><button className="recheck-button" onClick={() => void recheck()} disabled={checking}>{checking ? <LoaderCircle className="spin" /> : <RefreshCw />}<span>重新检测</span></button></div></header>
      {bootstrap.environment.status !== "ready" && critical && <section className={`environment-banner is-${critical.severity}`}><AlertTriangle /><div><strong>{critical.title}</strong><span>{critical.message}</span></div><button onClick={() => setPage("environment")}>查看环境详情</button></section>}
      {message && <div className="desktop-notice">{message}<button onClick={() => setMessage("")}>×</button></div>}
      <div hidden={page !== "generate"}><GeneratePage models={models} loras={loras} defaultPrivacy={bootstrap.settings.defaultPrivacy} onCreated={jobCreated} onError={setMessage} /></div>
      <div hidden={page !== "jobs"}><JobsPage jobs={jobs} onCancel={(id) => void cancelJob(id)} /></div>
      <div hidden={page !== "models"}><ModelsPage models={models} onImported={modelImported} onError={setMessage} /></div>
      <div hidden={page !== "loras"}><LorasPage loras={loras} onImported={loraImported} onError={setMessage} /></div>
      <div hidden={page !== "training"}><TrainingPage datasets={trainingDatasets} onUpdated={trainingDatasetUpdated} onError={setMessage} /></div>
      <div hidden={page !== "overview"}><OverviewPage state={bootstrap} runtimeBusy={runtimeBusy} onRuntimeAction={(action) => void controlRuntime(action)} /></div>
      <div hidden={page !== "environment"}><EnvironmentPage report={bootstrap.environment} /></div>
      <div hidden={page !== "resources"}><ResourcesPage catalog={resourceCatalog} progress={resourceProgress} installProgress={installProgress} loading={catalogLoading} bulkBusy={resourceBulkBusy} onReload={() => void reloadResourceCatalog()} onInstallRequired={() => void installRequiredResources()} onDownload={(resourceId) => void downloadResource(resourceId)} onInstall={(resourceId) => void installResource(resourceId)} /></div>
      <div hidden={page !== "sync"}><SyncPage items={queue} /></div>
      <div hidden={page !== "settings"}><SettingsPage value={bootstrap.settings} onSaved={(settings) => { setBootstrap((current) => current ? { ...current, settings } : current); setMessage("本地设置已保存"); void reloadResourceCatalog(); }} onError={setMessage} /></div>
    </main>
  </div>;
}

/** 本地生成页在页面切换时保持表单实例，提交后立即返回任务而不等待 Runtime。 */
function GeneratePage({ models, loras, defaultPrivacy, onCreated, onError }: { models: DesktopLocalModelView[]; loras: DesktopLocalLoraView[]; defaultPrivacy: DesktopSettings["defaultPrivacy"]; onCreated: (job: DesktopLocalJobView) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState<DesktopLocalJobCreateInput>({ modelId: "", prompt: "", negativePrompt: null, width: 1024, height: 1024, steps: 20, cfg: 5, samplerName: "euler", schedulerName: "normal", seed: null, loras: [], privacy: defaultPrivacy });
  const [busy, setBusy] = useState(false);
  const availableModels = models.filter((model) => model.available);
  const availableLoras = loras.filter((lora) => lora.available);
  useEffect(() => { if (!availableModels.some((model) => model.id === form.modelId)) setForm((current) => ({ ...current, modelId: availableModels[0]?.id || "" })); }, [models]);
  useEffect(() => { setForm((current) => ({ ...current, loras: current.loras.filter((selection) => availableLoras.some((lora) => lora.id === selection.id)) })); }, [loras]);
  const submit = async () => {
    if (!form.modelId || !form.prompt.trim() || busy) return;
    setBusy(true);
    try { onCreated(await createDesktopLocalJob({ ...form, prompt: form.prompt.trim(), negativePrompt: form.negativePrompt?.trim() || null })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const chooseSize = (value: string) => { const [width, height] = value.split("x").map(Number); setForm({ ...form, width, height }); };
  /** 选择与强度始终写回同一个任务表单，最多四个且不重复。 */
  const toggleLora = (id: string) => setForm((current) => {
    const selected = current.loras.some((item) => item.id === id);
    if (selected) return { ...current, loras: current.loras.filter((item) => item.id !== id) };
    if (current.loras.length >= 4) { onError("每个任务最多选择 4 个 LoRA"); return current; }
    return { ...current, loras: [...current.loras, { id, strength: 0.8 }] };
  });
  const changeLoraStrength = (id: string, strength: number) => setForm((current) => ({ ...current, loras: current.loras.map((item) => item.id === id ? { ...item, strength } : item) }));
  return <div className="desktop-page generate-layout"><section className="section-card generation-form"><header><div><span>LOCAL GENERATION</span><h2>本地生成</h2></div><small>任务提交后由 SQLite 队列后台执行</small></header>{availableModels.length === 0 ? <div className="resource-unconfigured"><Database /><div><strong>尚无可用底模</strong><span>先在“本地模型”导入 safetensors，或在“资源安装”下载网站发布模型。</span></div></div> : <><div className="generation-grid"><label><span>底模</span><select value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.family}</option>)}</select></label><label><span>输出尺寸</span><select value={`${form.width}x${form.height}`} onChange={(event) => chooseSize(event.target.value)}><option value="1024x1024">1:1 · 1024 × 1024</option><option value="1024x1536">2:3 · 1024 × 1536</option><option value="1536x1024">3:2 · 1536 × 1024</option><option value="864x1536">9:16 · 864 × 1536</option><option value="1536x864">16:9 · 1536 × 864</option></select></label><label><span>采样步数</span><input type="number" min={1} max={50} value={form.steps} onChange={(event) => setForm({ ...form, steps: Number(event.target.value) })} /></label><label><span>CFG</span><input type="number" min={0.1} max={20} step={0.1} value={form.cfg} onChange={(event) => setForm({ ...form, cfg: Number(event.target.value) })} /></label><label><span>采样器</span><select value={form.samplerName} onChange={(event) => setForm({ ...form, samplerName: event.target.value as DesktopLocalJobCreateInput["samplerName"] })}><option value="euler">Euler</option><option value="euler_ancestral">Euler Ancestral</option></select></label><label><span>调度器</span><select value={form.schedulerName} onChange={(event) => setForm({ ...form, schedulerName: event.target.value as DesktopLocalJobCreateInput["schedulerName"] })}><option value="normal">Normal</option><option value="simple">Simple</option></select></label><label><span>种子</span><input type="number" min={0} max={2147483647} placeholder="留空随机" value={form.seed ?? ""} onChange={(event) => setForm({ ...form, seed: event.target.value ? Number(event.target.value) : null })} /></label><label><span>图库权限</span><select value={form.privacy} onChange={(event) => setForm({ ...form, privacy: event.target.value as DesktopLocalJobCreateInput["privacy"] })}><option value="private">私有</option><option value="public">公开</option></select></label></div>{availableLoras.length > 0 && <section className="generation-loras"><header><div><strong>叠加 LoRA</strong><span>最多 4 个，每个任务固化文件与强度快照</span></div><b>{form.loras.length}/4</b></header><div>{availableLoras.map((lora) => { const selection = form.loras.find((item) => item.id === lora.id); return <article key={lora.id} className={selection ? "selected" : ""}><button type="button" onClick={() => toggleLora(lora.id)}><i>{selection ? <CheckCircle2 /> : <Layers3 />}</i><span><strong>{lora.title}</strong><small>{loraTypeLabel(lora.type)} · {lora.triggerWords.join(", ") || "无触发词"}</small></span></button>{selection && <label><span>强度</span><input type="number" min={0} max={1.5} step={0.05} value={selection.strength} onChange={(event) => changeLoraStrength(lora.id, Number(event.target.value))} /></label>}</article>; })}</div></section>}<label className="prompt-field"><span>提示词</span><textarea value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="描述希望生成的画面" /></label><label className="prompt-field negative"><span>负面提示词</span><textarea value={form.negativePrompt || ""} onChange={(event) => setForm({ ...form, negativePrompt: event.target.value || null })} placeholder="可选；与正面提示词独立进入 negative conditioning" /></label><footer><button disabled={busy || !form.modelId || !form.prompt.trim()} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <Play />}{busy ? "正在创建任务" : "提交本地任务"}</button></footer></>}</section></div>;
}

/** 任务页从 SQLite 视图渲染，成功产物使用 Tauri 受控 asset URL 延迟加载。 */
function JobsPage({ jobs, onCancel }: { jobs: DesktopLocalJobView[]; onCancel: (id: string) => void }) {
  return <div className="desktop-page"><section className="section-card"><header><div><span>LOCAL JOBS</span><h2>任务记录</h2></div><small>{jobs.length} 项</small></header>{jobs.length ? <div className="local-job-grid">{jobs.map((job) => <article key={job.id}><div className="local-job-preview">{job.artifact ? <img loading="lazy" src={convertFileSrc(job.artifact.path)} alt={job.prompt.slice(0, 80)} /> : <div><Image /><span>{localJobStatusLabel(job.status)}</span><b>{job.progress}%</b></div>}</div><div className="local-job-copy"><strong>{job.prompt}</strong><span>{job.modelDisplayName} · {job.loras.length} 个 LoRA · {job.parameters.width}×{job.parameters.height} · Seed {job.parameters.seed}</span>{job.error && <small>{job.error}</small>}</div>{["queued", "running"].includes(job.status) && <button title="取消任务" onClick={() => onCancel(job.id)}><X /></button>}</article>)}</div> : <div className="empty-block">尚未提交本地生成任务</div>}</section></div>;
}

/** 模型页通过原生文件选择器导入，不要求用户把绝对路径手工复制到程序外部。 */
function ModelsPage({ models, onImported, onError }: { models: DesktopLocalModelView[]; onImported: (model: DesktopLocalModelView) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState<DesktopLocalModelImportInput>({ displayName: "", family: "anima", workflowKind: "anima", modelSourcePath: "", textEncoderSourcePath: null, vaeSourcePath: null });
  const [busy, setBusy] = useState(false);
  const chooseFile = async (field: "modelSourcePath" | "textEncoderSourcePath" | "vaeSourcePath") => {
    try { const selected = await open({ multiple: false, directory: false, filters: [{ name: "safetensors 模型", extensions: ["safetensors"] }] }); if (typeof selected === "string") setForm((current) => ({ ...current, [field]: selected })); }
    catch (error) { onError(errorMessage(error)); }
  };
  const submit = async () => {
    setBusy(true);
    try { const model = await importDesktopLocalModel(form); onImported(model); setForm((current) => ({ ...current, displayName: "", modelSourcePath: "", textEncoderSourcePath: null, vaeSourcePath: null })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const ready = form.displayName.trim() && form.family.trim() && form.modelSourcePath && (form.workflowKind === "checkpoint" || (form.textEncoderSourcePath && form.vaeSourcePath));
  return <div className="desktop-page model-layout"><section className="section-card model-import"><header><div><span>MODEL IMPORT</span><h2>导入本地底模</h2></div><small>仅 safetensors · 自动哈希 · 原子复制</small></header><div className="model-import-grid"><label><span>显示名称</span><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label><label><span>模型系列</span><input value={form.family} onChange={(event) => setForm({ ...form, family: event.target.value })} /></label><label><span>工作流格式</span><select value={form.workflowKind} onChange={(event) => { const workflowKind = event.target.value as DesktopLocalModelImportInput["workflowKind"]; setForm({ ...form, workflowKind, textEncoderSourcePath: workflowKind === "anima" ? form.textEncoderSourcePath : null, vaeSourcePath: workflowKind === "anima" ? form.vaeSourcePath : null }); }}><option value="anima">Anima · UNet + CLIP + VAE</option><option value="checkpoint">Checkpoint · 单文件</option></select></label><FilePicker label={form.workflowKind === "anima" ? "UNet 文件" : "Checkpoint 文件"} value={form.modelSourcePath} onPick={() => void chooseFile("modelSourcePath")} />{form.workflowKind === "anima" && <><FilePicker label="文本编码器" value={form.textEncoderSourcePath || ""} onPick={() => void chooseFile("textEncoderSourcePath")} /><FilePicker label="VAE 文件" value={form.vaeSourcePath || ""} onPick={() => void chooseFile("vaeSourcePath")} /></>}</div><footer><button disabled={!ready || busy} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <Download />}{busy ? "正在校验并导入" : "导入模型"}</button></footer></section><section className="section-card"><header><div><span>REGISTERED MODELS</span><h2>已登记模型</h2></div><small>{models.length} 个</small></header>{models.length ? <div className="model-list">{models.map((model) => <article key={model.id} className={model.available ? "is-ready" : "is-missing"}><Database /><div><strong>{model.displayName}</strong><span>{model.family} · {model.workflowKind === "anima" ? "Anima" : "Checkpoint"} · {formatResourceBytes(model.byteSize)}</span><small>{model.modelFileName} · {model.modelSha256.slice(0, 12)}</small></div><b>{model.available ? "可用" : "文件已变化"}</b></article>)}</div> : <div className="empty-block">当前设备尚未登记模型</div>}</section></div>;
}

/** LoRA 仓库通过原生文件选择器导入真实权重，并保留类型与触发词供任务选择。 */
function LorasPage({ loras, onImported, onError }: { loras: DesktopLocalLoraView[]; onImported: (lora: DesktopLocalLoraView) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState<DesktopLocalLoraImportInput>({ title: "", type: "style", sourcePath: "", triggerWords: [] });
  const [triggerText, setTriggerText] = useState("");
  const [busy, setBusy] = useState(false);
  const chooseFile = async () => {
    try { const selected = await open({ multiple: false, directory: false, filters: [{ name: "safetensors LoRA", extensions: ["safetensors"] }] }); if (typeof selected === "string") setForm((current) => ({ ...current, sourcePath: selected })); }
    catch (error) { onError(errorMessage(error)); }
  };
  const submit = async () => {
    if (busy || !form.title.trim() || !form.sourcePath) return;
    setBusy(true);
    try {
      const triggerWords = triggerText.split(/[,，\n]/).map((word) => word.trim()).filter(Boolean);
      const lora = await importDesktopLocalLora({ ...form, title: form.title.trim(), triggerWords });
      onImported(lora);
      setForm((current) => ({ ...current, title: "", sourcePath: "", triggerWords: [] }));
      setTriggerText("");
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <div className="desktop-page lora-layout"><section className="section-card model-import"><header><div><span>LORA IMPORT</span><h2>导入本机 LoRA</h2></div><small>内容哈希去重 · 受控目录保存</small></header><div className="model-import-grid"><label><span>标题</span><input maxLength={191} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label><span>类型</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as DesktopLocalLoraImportInput["type"] })}>{["style", "character", "concept", "clothing", "pose", "other"].map((type) => <option key={type} value={type}>{loraTypeLabel(type)}</option>)}</select></label><label><span>触发词</span><input value={triggerText} onChange={(event) => setTriggerText(event.target.value)} placeholder="多个触发词使用逗号分隔" /></label><FilePicker label="LoRA 文件" value={form.sourcePath} onPick={() => void chooseFile()} /></div><footer><button disabled={busy || !form.title.trim() || !form.sourcePath} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <Download />}{busy ? "正在校验并导入" : "导入 LoRA"}</button></footer></section><section className="section-card"><header><div><span>LOCAL LORA LIBRARY</span><h2>已登记 LoRA</h2></div><small>{loras.length} 个</small></header>{loras.length ? <div className="lora-library-grid">{loras.map((lora) => <article key={lora.id} className={lora.available ? "is-ready" : "is-missing"}><div><Layers3 /><b>{loraTypeLabel(lora.type)}</b></div><strong>{lora.title}</strong><span>{lora.triggerWords.join(", ") || "无触发词"}</span><small>{lora.fileName} · {formatResourceBytes(lora.byteSize)} · {lora.sha256.slice(0, 12)}</small><i>{lora.available ? "可用" : "文件已变化"}</i></article>)}</div> : <div className="empty-block">当前设备尚未登记 LoRA</div>}</section></div>;
}

/** LoRA 训练页先完成真实训练集、图片导入、逐图 Caption 与确认门禁。 */
function TrainingPage({ datasets, onUpdated, onError }: { datasets: DesktopTrainingDatasetView[]; onUpdated: (dataset: DesktopTrainingDatasetView) => void; onError: (message: string) => void }) {
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<DesktopTrainingDatasetCreateInput>({ title: "", type: "character", triggerWords: [] });
  const [triggerText, setTriggerText] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = datasets.find((dataset) => dataset.id === selectedId) || null;
  useEffect(() => { if (!datasets.some((dataset) => dataset.id === selectedId)) setSelectedId(datasets[0]?.id || ""); }, [datasets, selectedId]);
  const create = async () => {
    if (busy || !form.title.trim()) return;
    setBusy(true);
    try {
      const triggerWords = triggerText.split(/[,，\n]/).map((word) => word.trim()).filter(Boolean);
      const dataset = await createDesktopTrainingDataset({ ...form, title: form.title.trim(), triggerWords });
      onUpdated(dataset); setSelectedId(dataset.id); setForm((current) => ({ ...current, title: "", triggerWords: [] })); setTriggerText("");
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const addImages = async () => {
    if (!selected || busy) return;
    try {
      const chosen = await open({ multiple: true, directory: false, filters: [{ name: "训练图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      const sourcePaths = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
      if (!sourcePaths.length) return;
      setBusy(true); onUpdated(await addDesktopTrainingImages({ datasetId: selected.id, sourcePaths }));
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try { onUpdated(await confirmDesktopTrainingDataset({ datasetId: selected.id })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const missingCaptions = selected?.assets.filter((asset) => !asset.caption?.trim()).length || 0;
  const unavailableAssets = selected?.assets.filter((asset) => !asset.available).length || 0;
  return <div className="desktop-page training-page"><section className="section-card training-create"><header><div><span>TRAINING DATASETS</span><h2>LoRA 训练集</h2></div><small>图片与 Caption 全部持久化</small></header><div><label><span>训练集标题</span><input maxLength={191} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：角色立绘训练集" /></label><label><span>训练类型</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as DesktopTrainingDatasetCreateInput["type"] })}><option value="character">角色</option><option value="style">画风</option><option value="concept">概念</option></select></label><label><span>触发词</span><input value={triggerText} onChange={(event) => setTriggerText(event.target.value)} placeholder="建议使用唯一、无语义的英文词" /></label><button disabled={busy || !form.title.trim()} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" /> : <FolderPlus />}创建训练集</button></div></section><div className="training-workspace"><aside className="section-card training-dataset-list"><header><strong>训练集</strong><small>{datasets.length} 个</small></header>{datasets.length ? datasets.map((dataset) => <button key={dataset.id} className={dataset.id === selectedId ? "active" : ""} onClick={() => setSelectedId(dataset.id)}><span><strong>{dataset.title}</strong><small>{trainingTypeLabel(dataset.type)} · {dataset.assets.length} 张</small></span><b className={`is-${dataset.status}`}>{trainingStatusLabel(dataset.status)}</b></button>) : <div className="empty-block">创建第一个本地训练集</div>}</aside><section className="section-card training-editor">{selected ? <><header><div><span>{trainingTypeLabel(selected.type)} · {selected.triggerWords.join(", ") || "未设置触发词"}</span><h2>{selected.title}</h2></div><div className="training-editor-actions"><button disabled={busy || selected.assets.length >= 200} onClick={() => void addImages()}><Upload />导入图片</button><button disabled={busy || selected.assets.length < 5 || missingCaptions > 0 || unavailableAssets > 0 || selected.status === "confirmed"} onClick={() => void confirm()}><BookOpenCheck />确认训练集</button></div></header><div className="training-gate"><span><strong>{selected.assets.length}/200 张</strong><small>{unavailableAssets ? `${unavailableAssets} 张文件缺失或已变化` : missingCaptions ? `${missingCaptions} 张缺少 Caption` : selected.assets.length >= 5 ? "全部 Caption 已填写" : `还需 ${5 - selected.assets.length} 张图片`}</small></span><b className={`is-${selected.status}`}>{trainingStatusLabel(selected.status)}</b></div>{selected.assets.length ? <div className="training-asset-list">{selected.assets.map((asset) => <TrainingAssetRow key={asset.id} datasetId={selected.id} asset={asset} onUpdated={onUpdated} onError={onError} />)}</div> : <div className="empty-block">导入 5–200 张 PNG、JPEG 或 WebP 开始整理训练集</div>}</> : <div className="empty-block">从左侧选择训练集</div>}</section></div></div>;
}

/** 单图编辑器独立保存草稿，其他图片保存成功时不会覆盖尚未提交的输入。 */
function TrainingAssetRow({ datasetId, asset, onUpdated, onError }: { datasetId: string; asset: DesktopTrainingDatasetView["assets"][number]; onUpdated: (dataset: DesktopTrainingDatasetView) => void; onError: (message: string) => void }) {
  const [caption, setCaption] = useState(asset.caption || "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setCaption(asset.caption || ""), [asset.caption]);
  const changed = caption.trim() !== (asset.caption || "").trim();
  const save = async () => {
    if (busy || !changed) return;
    setBusy(true);
    try { onUpdated(await updateDesktopTrainingCaption({ datasetId, assetId: asset.id, caption: caption.trim() || null })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <article className={asset.available ? "" : "is-missing"}><div className="training-asset-image">{asset.available ? <img loading="lazy" src={convertFileSrc(asset.path)} alt={asset.fileName} /> : <div><AlertTriangle /><span>文件缺失</span></div>}<span>{asset.width}×{asset.height}</span></div><div className="training-asset-caption"><header><strong>{asset.fileName}</strong><small>{asset.sha256.slice(0, 12)} · {formatResourceBytes(asset.byteSize)}</small></header><textarea value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="使用英文逗号分隔准确标签；人工保存后不会被后台改写" /><footer><span className={asset.available ? asset.confirmed ? "confirmed" : "pending" : "missing"}>{asset.available ? asset.confirmed ? "已确认" : asset.caption ? "待重新确认" : "缺少 Caption" : "文件缺失或已变化"}</span><button disabled={!changed || busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" /> : <Save />}{busy ? "保存中" : "保存 Caption"}</button></footer></div></article>;
}

/** 原生文件选择字段只展示已选路径，不允许网页侧直接读取文件内容。 */
function FilePicker({ label, value, onPick }: { label: string; value: string; onPick: () => void }) { return <label className="file-picker"><span>{label}</span><div><input readOnly value={value} placeholder="选择 .safetensors 文件" /><button onClick={onPick}>选择</button></div></label>; }

/** 总览页只展示真实检测与本地数据，不模拟未接入的生成结果。 */
function OverviewPage({ state, runtimeBusy, onRuntimeAction }: { state: DesktopBootstrapView; runtimeBusy: boolean; onRuntimeAction: (action: "start" | "stop" | "selfTest") => void }) {
  const gpu = state.environment.gpus[0];
  const capability = state.environment.capabilities;
  return <div className="desktop-page"><section className="overview-hero"><div><span>LOCAL COMPUTE</span><h1>{gpu?.name || "等待可用 GPU"}</h1><p>本地计算与网页钱包隔离。环境通过自检后才开放生成和训练，结果将进入持久化图库同步队列。</p></div><StatusSeal status={state.environment.status} /></section><RuntimeControlCard runtime={state.runtime} installed={state.environment.runtime.installed} busy={runtimeBusy} onAction={onRuntimeAction} /><section className="capability-grid"><CapabilityCard label="本地生成" ready={capability.inference} text={capability.inference ? "Runtime 与底模均已就绪" : "等待 GPU、Runtime 与底模就绪"} /><CapabilityCard label="LoRA 训练" ready={capability.training} text={capability.training ? "训练 Runtime 可用" : "训练入口保持锁定"} /><CapabilityCard label="自动打标" ready={capability.captioning} text={capability.captioning ? "打标 Runtime 可用" : "仍可手动整理标签"} /><CapabilityCard label="模型管理" ready={capability.modelManagement} text="支持本地目录和文件哈希管理" /></section><section className="metric-grid"><Metric Icon={MemoryStick} label="GPU 显存" value={gpu ? `${formatBytes(gpu.memoryFreeBytes)} / ${formatBytes(gpu.memoryTotalBytes)}` : "未检测到"} /><Metric Icon={Cpu} label="处理器" value={`${state.environment.cpu.name} · ${state.environment.cpu.logicalCores} 线程`} /><Metric Icon={Database} label="系统内存" value={`${formatBytes(state.environment.memory.availableBytes)} 可用`} /><Metric Icon={UploadCloud} label="待同步图库" value={`${state.pendingGallerySyncCount} 项`} /></section></div>;
}

/** Runtime 控制卡展示真实 PID、回环端口与自检入口，不直接暴露 ComfyUI 页面。 */
function RuntimeControlCard({ runtime, installed, busy, onAction }: { runtime: DesktopRuntimeStatusView; installed: boolean; busy: boolean; onAction: (action: "start" | "stop" | "selfTest") => void }) {
  const active = ["starting", "ready", "stopping"].includes(runtime.status);
  return <section className={`runtime-control is-${runtime.status}`}><div className="runtime-control-icon">{runtime.status === "ready" ? <Activity /> : <Power />}</div><div className="runtime-control-copy"><span>COMFYUI RUNTIME</span><strong>{runtimeProcessLabel(runtime.status)}</strong><small>{runtime.pid ? `PID ${runtime.pid} · 127.0.0.1:${runtime.port}` : runtime.error || (installed ? "已安装，等待启动和自检" : "请先在资源安装页完成 Runtime 安装")}</small></div><div className="runtime-actions"><button disabled={busy || !installed || active} onClick={() => onAction("start")}>{busy ? <LoaderCircle className="spin" /> : <Power />}启动</button><button disabled={busy || !installed || runtime.status !== "ready"} onClick={() => onAction("selfTest")}><FlaskConical />完整自检</button><button disabled={busy || !active} onClick={() => onAction("stop")}><Power />停止</button></div></section>;
}

/** 环境页展示完整问题和硬件明细，便于用户按具体原因修复。 */
function EnvironmentPage({ report }: { report: DesktopEnvironmentReport }) {
  return <div className="desktop-page"><section className="section-card"><header><div><span>ENVIRONMENT REPORT</span><h2>本机能力检测</h2></div><small>{new Date(report.checkedAt).toLocaleString("zh-CN")}</small></header><div className="environment-summary"><div><Cpu /><span><small>系统</small><strong>{report.os.name} · {report.os.arch}{report.os.build ? ` · ${report.os.build}` : ""}</strong></span></div><div><MemoryStick /><span><small>内存</small><strong>{formatBytes(report.memory.totalBytes)}</strong></span></div><div><HardDrive /><span><small>Runtime</small><strong>{runtimeLabel(report.runtime.status)}</strong></span></div></div></section>{report.issues.length > 0 && <section className="issue-list">{report.issues.map((issue) => <article className={`is-${issue.severity}`} key={issue.code}><AlertTriangle /><div><strong>{issue.title}</strong><p>{issue.message}</p><span>{issue.action}</span></div></article>)}</section>}<section className="section-card"><header><div><span>GPU INVENTORY</span><h2>图形设备</h2></div><small>{report.gpus.length} 个</small></header>{report.gpus.length ? <div className="gpu-list">{report.gpus.map((gpu) => <article key={gpu.uuid}><div><strong>{gpu.name}</strong><span>{gpu.vendor} · 驱动 {gpu.driverVersion}</span></div><dl><div><dt>空闲显存</dt><dd>{formatBytes(gpu.memoryFreeBytes)}</dd></div><div><dt>总显存</dt><dd>{formatBytes(gpu.memoryTotalBytes)}</dd></div><div><dt>计算能力</dt><dd>{gpu.computeCapability || "-"}</dd></div><div><dt>利用率</dt><dd>{gpu.utilizationPercent === null ? "-" : `${gpu.utilizationPercent}%`}</dd></div></dl></article>)}</div> : <div className="empty-block">当前未检测到受支持的 NVIDIA GPU</div>}</section><section className="section-card"><header><div><span>STORAGE</span><h2>本地磁盘</h2></div></header><div className="disk-list">{report.disks.map((disk) => <article key={disk.name}><HardDrive /><span><strong>{disk.name}</strong><small>{disk.fileSystem || "未知文件系统"}</small></span><b>{formatBytes(disk.availableBytes)} 可用</b></article>)}</div></section></div>;
}

/** 资源页只开放真实签名目录中的项目，并展示断点、来源和校验状态。 */
function ResourcesPage({ catalog, progress, installProgress, loading, bulkBusy, onReload, onInstallRequired, onDownload, onInstall }: { catalog: DesktopResourceCatalogView | null; progress: Record<string, DesktopResourceDownloadView>; installProgress: Record<string, DesktopResourceInstallView>; loading: boolean; bulkBusy: boolean; onReload: () => void; onInstallRequired: () => void; onDownload: (resourceId: string) => void; onInstall: (resourceId: string) => void }) {
  const pendingRequired = catalog?.resources.filter((resource) => resource.required && !resource.installed).length || 0;
  return <div className="desktop-page"><section className="section-card resource-card"><header><div><span>RESOURCE CHANNEL</span><h2>依赖与模型资源</h2></div><div className="resource-header-actions"><button className="resource-reload" disabled={loading || bulkBusy} onClick={onReload}>{loading ? <LoaderCircle className="spin" /> : <RefreshCw />}刷新签名目录</button><button className="resource-install-all" disabled={!catalog?.configured || pendingRequired === 0 || bulkBusy} onClick={onInstallRequired}>{bulkBusy ? <LoaderCircle className="spin" /> : <Download />}{bulkBusy ? "正在安装" : pendingRequired ? `安装全部必需资源（${pendingRequired}）` : "必需资源已齐全"}</button></div></header>{!catalog ? <div className="empty-block">正在读取资源发布状态</div> : !catalog.configured ? <div className="resource-unconfigured"><ShieldCheck /><div><strong>资源发布通道尚未配置</strong><span>{catalog.message}</span><small>安装入口保持关闭，避免下载未登记或未签名的文件。</small></div></div> : <><div className="resource-channel-status"><ShieldCheck /><span><strong>{catalog.message}</strong><small>密钥 {catalog.keyId} · 有效至 {catalog.expiresAt ? new Date(catalog.expiresAt).toLocaleString("zh-CN") : "-"}</small></span></div>{catalog.resources.length ? <div className="resource-list">{catalog.resources.map((resource) => { const current = progress[resource.id]; const installing = installProgress[resource.id]; const downloadBusy = current && ["queued", "downloading", "verifying"].includes(current.status); const installBusy = installing && ["verifying", "installing", "switching"].includes(installing.status); const busy = downloadBusy || installBusy; const sourceAvailable = resource.sourceKinds.length > 0; const percent = installBusy ? installing.progress : current ? Math.min(100, Math.round(current.downloadedBytes / current.totalBytes * 100)) : resource.downloaded ? 100 : 0; const progressText = installBusy ? `${installStatusLabel(installing.status)} · ${installing.progress}%` : current ? `${downloadStatusLabel(current.status)} · ${percent}%${current.bytesPerSecond ? ` · ${formatResourceBytes(current.bytesPerSecond)}/s` : ""}` : ""; const action = resource.installed ? "installed" : resource.downloaded ? "install" : "download"; return <article key={resource.id}>{resource.installed ? <PackageCheck /> : <PackageOpen />}<div className="resource-info"><strong>{resource.fileName}</strong><span>{resourceKindLabel(resource.kind)} · {resource.version} · 下载 {formatResourceBytes(resource.byteSize)} · 安装 {formatResourceBytes(resource.installedSize)} · {sourceAvailable ? resource.sourceKinds.map(sourceKindLabel).join(" / ") : "当前来源设置下不可用"}</span>{(current || installing) && <div className="resource-progress"><i style={{ width: `${percent}%` }} /><small>{progressText || (resource.installed ? "已安装" : "等待操作")}</small></div>}</div><button disabled={bulkBusy || Boolean(busy) || resource.installed || (!resource.downloaded && !sourceAvailable)} onClick={() => action === "install" ? onInstall(resource.id) : onDownload(resource.id)}>{busy ? <LoaderCircle className="spin" /> : resource.installed ? <CheckCircle2 /> : action === "install" ? <PackageCheck /> : <Download />}{resource.installed ? "已安装" : installBusy ? "安装中" : downloadBusy ? "下载中" : action === "install" ? "安装" : sourceAvailable ? "下载" : "无来源"}</button></article>; })}</div> : <div className="empty-block">签名目录中没有适用于当前 Windows 架构的资源</div>}</>}</section></div>;
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
function pageTitle(page: DesktopPage): string { return { generate: "本地生成", jobs: "任务记录", models: "本地模型", loras: "LoRA 仓库", training: "LoRA 训练", overview: "本机概览", environment: "环境检测", resources: "资源安装", sync: "图库同步", settings: "本地设置" }[page]; }
/** LoRA 类型统一使用中文外显，数据库和契约仍保存稳定英文枚举。 */
function loraTypeLabel(type: string): string { return { style: "画风", character: "角色", concept: "概念", clothing: "服装", pose: "姿势", other: "其他" }[type] || type; }
function trainingTypeLabel(type: DesktopTrainingDatasetView["type"]): string { return { character: "角色", style: "画风", concept: "概念" }[type]; }
function trainingStatusLabel(status: DesktopTrainingDatasetView["status"]): string { return { draft: "整理中", review_ready: "可确认", confirmed: "已确认" }[status]; }
function runtimeLabel(status: DesktopEnvironmentReport["runtime"]["status"]): string { return { not_installed: "未安装", installed_unverified: "等待自检", ready: "运行正常", broken: "需要修复" }[status]; }
function syncStatusLabel(status: DesktopGallerySyncItem["status"]): string { return { queued: "等待上传", waiting_network: "等待网络", waiting_auth: "等待登录", uploading: "上传中", committing: "正在提交", synced: "已同步", privacy_pending: "权限待同步", paused: "已暂停", failed_retryable: "等待重试", failed_final: "同步失败", remote_deleted: "网页已删除" }[status]; }
/** 主题选项使用简短中文标签供按钮标题和辅助技术读取。 */
function themeModeLabel(mode: DesktopSettings["themeMode"]): string { return { system: "跟随系统", dark: "深色主题", light: "亮色主题" }[mode]; }
function resourceKindLabel(kind: string): string { return { runtime: "运行环境", model: "底模", lora: "LoRA", captioner: "打标模型", trainer: "训练组件" }[kind] || kind; }
function sourceKindLabel(kind: string): string { return { official: "官方", mirror: "主站镜像" }[kind] || kind; }
function downloadStatusLabel(status: DesktopResourceDownloadView["status"]): string { return { queued: "排队中", downloading: "下载中", verifying: "校验中", downloaded: "已完成", failed: "失败" }[status]; }
function installStatusLabel(status: DesktopResourceInstallView["status"]): string { return { verifying: "校验缓存", installing: "安装中", switching: "切换版本", installed: "已安装", rolled_back: "已回滚", failed: "安装失败" }[status]; }
function runtimeProcessLabel(status: DesktopRuntimeStatusView["status"]): string { return { stopped: "已停止", starting: "正在启动", ready: "运行中", stopping: "正在停止", failed: "运行异常" }[status]; }
function localJobStatusLabel(status: DesktopLocalJobView["status"]): string { return { queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消" }[status]; }
function formatResourceBytes(value: number): string { if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KiB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`; return `${(value / 1024 ** 3).toFixed(2)} GiB`; }
function formatBytes(value: number): string { if (value <= 0) return "0 GB"; return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error || "桌面端操作失败"); }
