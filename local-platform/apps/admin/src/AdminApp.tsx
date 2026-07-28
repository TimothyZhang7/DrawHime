/**
 * 本文件实现独立本地模型管理端，展示真实服务、模型、LoRA 与全局任务数据。
 */
import type { AdminModelUpdateRequest, AdminRuntimeConfigUpdateRequest, AdminRuntimeOverviewView, AdminWorkflowUpdateRequest, InferenceJobView, InferenceLoraView, InferenceModelView, LocalPlatformSessionView, PlatformOverviewView, TrainingDatasetView, TrainingJobView } from "@drawhime/contracts";
import { Boxes, BrainCircuit, Cpu, Gauge, Layers3, LogOut, Menu, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const apiBase = (import.meta.env.VITE_LOCAL_API_BASE || "/local-model-api").replace(/\/$/, "");
const pages = [{ id: "overview", label: "运行总览", icon: Gauge }, { id: "jobs", label: "推理任务", icon: Sparkles }, { id: "training", label: "训练管理", icon: BrainCircuit }, { id: "gpu", label: "GPU 主机", icon: Cpu }, { id: "models", label: "模型资产", icon: Boxes }, { id: "loras", label: "LoRA 仓库", icon: Layers3 }] as const;
type PageId = typeof pages[number]["id"];

/** 本地模型管理应用。 */
export function AdminApp() {
  const [session, setSession] = useState<LocalPlatformSessionView | null>(null);
  const [overview, setOverview] = useState<PlatformOverviewView | null>(null);
  const [models, setModels] = useState<InferenceModelView[]>([]);
  const [loras, setLoras] = useState<InferenceLoraView[]>([]);
  const [jobs, setJobs] = useState<InferenceJobView[]>([]);
  const [trainingJobs, setTrainingJobs] = useState<TrainingJobView[]>([]);
  const [datasets, setDatasets] = useState<TrainingDatasetView[]>([]);
  const [runtime, setRuntime] = useState<AdminRuntimeOverviewView | null>(null);
  const [page, setPage] = useState<PageId>("overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const localSession = await restoreAdminSession();
      if (!localSession?.identity.roles.includes("admin")) { setSession(null); return; }
      setSession(localSession);
      const headers = { authorization: `Bearer ${localSession.sessionToken}` };
      const [overviewPayload, modelPayload, loraPayload, jobPayload, runtimePayload, trainingPayload, datasetPayload] = await Promise.all([
        requestJson<PlatformOverviewView>("/v1/system/overview"),
        requestJson<{ models: InferenceModelView[] }>("/v1/models", headers),
        requestJson<{ loras: InferenceLoraView[] }>("/v1/loras", headers),
        requestJson<{ jobs: InferenceJobView[] }>("/v1/inference/jobs?scope=all&limit=100", headers),
        requestJson<AdminRuntimeOverviewView>("/v1/admin/runtime", headers),
        requestJson<{ jobs: TrainingJobView[] }>("/v1/training/jobs?scope=all", headers),
        requestJson<{ datasets: TrainingDatasetView[] }>("/v1/training/datasets?scope=all", headers),
      ]);
      setOverview(overviewPayload); setModels(modelPayload.models); setLoras(loraPayload.loras); setJobs(jobPayload.jobs); setRuntime(runtimePayload); setTrainingJobs(trainingPayload.jobs); setDatasets(datasetPayload.datasets); setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "管理数据加载失败");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    /** 管理端使用与主站相同的 768px 抽屉断点。 */
    const updateViewport = () => setIsMobile(window.innerWidth < 768);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);
  const dependencies = useMemo(() => overview?.services.flatMap((service) => service.dependencies.map((dependency) => ({ ...dependency, service: service.service }))) ?? [], [overview]);
  const updateRuntime = async (path: string, body: unknown) => {
    if (!session) return;
    try { setRuntime(await mutateJson<AdminRuntimeOverviewView>(path, session.sessionToken, body)); setError(""); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "运行配置更新失败"); }
  };

  if (loading && !session) return <div className="auth-gate"><RefreshCw className="spin" /><strong>正在验证主站管理员身份</strong></div>;
  if (!session) return <div className="auth-gate"><ShieldCheck /><strong>需要主站管理员身份</strong><span>请先登录绘图姬管理后台，再从导航进入。</span><a href="/" target="_blank" rel="noreferrer">打开管理后台</a></div>;

  /** 页面切换同时关闭手机端抽屉，避免遮住新内容。 */
  const selectPage = (nextPage: PageId) => { setPage(nextPage); setMobileSidebarOpen(false); };

  return <div className={`admin-shell${sidebarCollapsed && !isMobile ? " collapsed" : ""}`}>
    {isMobile && mobileSidebarOpen && <button className="admin-sidebar-backdrop" onClick={() => setMobileSidebarOpen(false)} aria-label="关闭管理导航" />}
    <aside className={isMobile && mobileSidebarOpen ? "mobile-open" : ""}>
      <a className="admin-brand" href="/" target="_blank" rel="noreferrer"><img src="/favicon-32x32.png" alt="" /><div><strong>绘图姬</strong><small>本地模型管理</small></div></a>
      <nav><span>本地模型平台</span>{pages.map(({ id, label, icon: Icon }) => <button key={id} title={label} className={page === id ? "active" : ""} onClick={() => selectPage(id)}><Icon size={16} /><b>{label}</b></button>)}</nav>
      <div className="admin-user"><ShieldCheck size={16} /><span>{session.identity.displayName}<small>主站管理员</small></span></div>
      {isMobile && <button className="admin-sidebar-close" onClick={() => setMobileSidebarOpen(false)}><X size={15} />关闭菜单</button>}
    </aside>
    <div className="admin-content">
      <header className="admin-topbar"><button onClick={() => isMobile ? setMobileSidebarOpen((value) => !value) : setSidebarCollapsed((value) => !value)} aria-label={isMobile ? "打开管理导航" : "折叠管理导航"}>{isMobile && mobileSidebarOpen ? <X size={18} /> : <Menu size={18} />}</button><div><span>{session.identity.displayName}</span><a href="/" title="返回主站管理后台"><LogOut size={14} />返回主站</a></div></header>
      <main><header><div><span>LOCAL MODEL ADMIN</span><h1>{pages.find((item) => item.id === page)?.label}</h1></div><button onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />刷新</button></header>{error && <div className="admin-error">{error}</div>}{page === "overview" && <OverviewPage overview={overview} dependencies={dependencies} jobs={jobs} models={models} loras={loras} />}{page === "jobs" && <JobsPage jobs={jobs} />}{page === "training" && <TrainingAdminPage jobs={trainingJobs} datasets={datasets} runtime={runtime} />}{page === "gpu" && <GpuPage runtime={runtime} onUpdate={updateRuntime} />}{page === "models" && <ModelsPage runtime={runtime} onUpdate={updateRuntime} />}{page === "loras" && <LorasPage loras={loras} />}</main>
    </div>
  </div>;
}

/** 训练任务、数据集、尝试、参数和计费状态管理视图。 */
function TrainingAdminPage({ jobs, datasets, runtime }: { jobs: TrainingJobView[]; datasets: TrainingDatasetView[]; runtime: AdminRuntimeOverviewView | null }) {
  return <><section className="summary-grid"><Summary label="预留 / 等待" value={`${runtime?.trainingQueue.reserving ?? 0} / ${runtime?.trainingQueue.ready ?? 0}`} /><Summary label="训练中" value={String(runtime?.trainingQueue.running ?? 0)} tone="purple" /><Summary label="保存结果" value={String(runtime?.trainingQueue.evaluating ?? 0)} /><Summary label="成功 / 失败" value={`${runtime?.trainingQueue.succeeded ?? 0} / ${runtime?.trainingQueue.failed ?? 0}`} tone="green" /></section><section className="panel"><div className="panel-title"><div><h2>训练任务</h2><p>完整显示固化参数、计费、Runtime 尝试和输出 LoRA</p></div><span>{jobs.length}</span></div><div className="training-admin-list">{jobs.map((job) => <details key={job.id}><summary><div><strong>{job.title}</strong><small>{job.id} · {job.datasetTitle}</small></div><Status ok={job.status === "succeeded"} label={`${job.status} · ${Math.round(job.progress)}%`} /><time>{new Date(job.createdAt).toLocaleString("zh-CN")}</time></summary><div className="training-admin-detail"><dl><div><dt>基础模型</dt><dd>{job.baseModelDisplayName}</dd></div><div><dt>计费</dt><dd>{job.billing ? `¥${job.billing.amount} · ${job.billing.status}` : "-"}</dd></div><div><dt>输出 LoRA</dt><dd>{job.outputLoraVersionId || "-"}</dd></div><div><dt>错误</dt><dd>{job.errorMessage || "-"}</dd></div></dl><pre>{JSON.stringify(job.parameters, null, 2)}</pre><div className="attempt-list">{job.attempts.map((attempt) => <article key={attempt.id}><strong>第 {attempt.attemptNumber} 次 · {attempt.status}</strong><small>{attempt.runtimeJobId || "无 Runtime ID"}</small>{attempt.errorMessage && <em>{attempt.errorMessage}</em>}</article>)}</div></div></details>)}</div></section><section className="panel"><div className="panel-title"><div><h2>训练数据集</h2><p>数据集归属、图片数量与训练锁定状态</p></div><span>{datasets.length}</span></div><div className="dataset-admin-grid">{datasets.map((dataset) => <article key={dataset.id}><span>{dataset.ownerDisplayName}</span><h3>{dataset.title}</h3><p>{dataset.assets.length} 张图片 · {dataset.trainingJobCount} 个任务</p><small>{dataset.status} · {new Date(dataset.updatedAt).toLocaleString("zh-CN")}</small></article>)}</div></section></>;
}

/** 运行总览页面。 */
function OverviewPage({ overview, dependencies, jobs, models, loras }: { overview: PlatformOverviewView | null; dependencies: Array<{ service: string; name: string; ready: boolean; message: string; latencyMs: number | null }>; jobs: InferenceJobView[]; models: InferenceModelView[]; loras: InferenceLoraView[] }) {
  const success = jobs.filter((job) => job.status === "succeeded").length;
  return <><section className="summary-grid"><Summary label="服务就绪" value={`${overview?.services.filter((item) => item.ready).length ?? 0}/${overview?.services.length ?? 0}`} tone="green" /><Summary label="最近任务" value={String(jobs.length)} /><Summary label="生成成功" value={String(success)} tone="purple" /><Summary label="模型 / LoRA" value={`${models.length} / ${loras.length}`} /></section><section className="panel"><div className="panel-title"><div><h2>服务状态</h2><p>所有数据来自实时 readiness 检查</p></div><span>{overview?.phase ?? "-"}</span></div><div className="service-table"><div className="table-head"><span>服务</span><span>状态</span><span>依赖</span><span>采样时间</span></div>{overview?.services.map((service) => <div className="table-row" key={service.service}><strong>{service.service}</strong><Status ok={service.ready} label={service.ready ? "就绪" : "异常"} /><span>{service.dependencies.filter((item) => item.ready).length} / {service.dependencies.length}</span><time>{new Date(service.timestamp).toLocaleTimeString("zh-CN")}</time></div>)}</div></section><section className="panel"><div className="panel-title"><div><h2>依赖检查</h2><p>数据库、队列、存储、GPU 与主站集成</p></div></div><div className="dependency-grid">{dependencies.map((item, index) => <article key={`${item.service}-${item.name}-${index}`}><span>{item.service}</span><strong>{item.name}</strong><Status ok={item.ready} label={item.message} /><small>{item.latencyMs ?? 0} ms</small></article>)}</div></section></>;
}

/** 推理任务管理页面，展开后展示固化参数、完整提示词、阶段和上游请求响应。 */
function JobsPage({ jobs }: { jobs: InferenceJobView[] }) {
  return <section className="panel"><div className="panel-title"><div><h2>最近 100 个任务</h2><p>点击任务可检查完整参数、执行阶段、Runtime 请求响应、计费和图库发布终态</p></div><span>{jobs.length}</span></div><div className="admin-job-list"><div className="table-head"><span>任务 / 提示词</span><span>状态</span><span>模型</span><span>创建时间</span></div>{jobs.map((job) => <details key={job.id}><summary><div className="job-name"><strong>{job.id}</strong><small>{job.requestedPrompt}</small></div><Status ok={job.status === "succeeded"} label={`${job.status} · ${Math.round(job.progress)}%`} /><span>{job.modelDisplayName}</span><time>{new Date(job.createdAt).toLocaleString("zh-CN")}</time></summary><div className="admin-job-detail"><dl><div><dt>来源</dt><dd>{job.source}</dd></div><div><dt>计费</dt><dd>{job.billing ? `¥${job.billing.amount} · ${job.billing.status}` : "-"}</dd></div><div><dt>图库</dt><dd>{job.publication ? publicationStatusLabel(job.publication.status) : "未发布"}</dd></div><div><dt>完成</dt><dd>{job.completedAt ? new Date(job.completedAt).toLocaleString("zh-CN") : "-"}</dd></div></dl><section><h3>用户提示词</h3><p>{job.requestedPrompt}</p></section><section><h3>最终提示词</h3><p>{job.effectivePrompt || "-"}</p></section>{job.artifacts[0] && <section><h3>生成产物</h3><p>{job.artifacts[0].width ?? "-"}×{job.artifacts[0].height ?? "-"} · {formatArtifactBytes(job.artifacts[0].byteSize)} · SHA-256 {job.artifacts[0].sha256}</p></section>}{job.publication && <section><h3>主站图库发布</h3><p>{publicationStatusLabel(job.publication.status)}{job.publication.errorMessage ? ` · ${job.publication.errorMessage}` : ""}</p>{job.publication.mainGalleryItemId && <a href={`/image/${job.publication.mainGalleryItemId}`} target="_blank" rel="noreferrer">打开主站图库详情</a>}</section>}<AdminJson title="完整参数 JSON" value={job.parameters} /><div className="admin-stage-list"><h3>执行阶段</h3>{job.stages.map((stage) => <article key={stage.id}><strong>#{stage.sequence} {stage.stageType} · {stage.status}</strong>{stage.errorMessage && <em>{stage.errorMessage}</em>}{stage.inputJson && <AdminJson title="输入 JSON" value={stage.inputJson} />}{stage.outputJson && <AdminJson title="输出 JSON" value={stage.outputJson} />}</article>)}</div><div className="admin-stage-list"><h3>Runtime 尝试</h3>{job.attempts.map((attempt) => <article key={attempt.id}><strong>第 {attempt.attemptNumber} 次 · {attempt.status} · {attempt.runtimeJobId || "无 Runtime ID"}</strong>{attempt.errorMessage && <em>{attempt.errorMessage}</em>}{attempt.requestJson && <AdminJson title="请求 JSON" value={attempt.requestJson} />}{attempt.responseJson && <AdminJson title="响应 JSON" value={attempt.responseJson} />}</article>)}</div>{job.errorMessage && <section className="admin-job-error"><h3>错误</h3><p>{job.errorCode ? `${job.errorCode}：` : ""}{job.errorMessage}</p></section>}</div></details>)}</div></section>;
}

/** 管理端可折叠 JSON 检查块。 */
function AdminJson({ title, value }: { title: string; value: Record<string, unknown> }) {
  return <details className="admin-json"><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

/** GPU 主机与真实设备状态页面。 */
function GpuPage({ runtime, onUpdate }: { runtime: AdminRuntimeOverviewView | null; onUpdate: (path: string, body: unknown) => Promise<void> }) {
  return <><section className="summary-grid"><Summary label="预留中" value={String(runtime?.queue.reserving ?? 0)} /><Summary label="排队中" value={String(runtime?.queue.ready ?? 0)} /><Summary label="推理 / 训练" value={`${runtime?.queue.running ?? 0} / ${runtime?.trainingQueue.running ?? 0}`} tone="purple" /><Summary label="累计成功" value={String(runtime?.queue.succeeded ?? 0)} tone="green" /></section><section className="asset-grid">{runtime?.gpuHosts.map((host) => <article className="panel asset gpu-asset" key={host.id}><span>{host.agentKey}</span><div className="asset-heading"><h2>{host.displayName}</h2><button className={host.active ? "toggle active" : "toggle"} onClick={() => void onUpdate(`/v1/admin/gpu-hosts/${host.id}`, { active: !host.active })}>{host.active ? "接收任务" : "已停用"}</button></div><p>Agent {host.agentVersion ?? "-"} · 心跳 {host.lastHeartbeatAt ? new Date(host.lastHeartbeatAt).toLocaleTimeString("zh-CN") : "无"}</p>{host.devices.map((device) => { const total = device.totalVramBytes / 1024 / 1024 / 1024; const free = (device.freeVramBytes ?? 0) / 1024 / 1024 / 1024; const activity = device.activeTrainingJobId ? `训练 ${device.activeTrainingJobId}` : device.activeLeaseJobId ? `推理 ${device.activeLeaseJobId}` : "空闲"; return <div className="gpu-device" key={device.id}><div><strong>{device.name}</strong><small>{activity}</small></div><div className="vram"><i style={{ width: `${Math.max(0, Math.min(100, 100 - free / total * 100))}%` }} /></div><small>{free.toFixed(1)} / {total.toFixed(1)} GB 可用 · {device.utilizationPercent?.toFixed(1) ?? "-"}% · {device.temperatureCelsius?.toFixed(0) ?? "-"}°C</small></div>; })}</article>)}</section></>;
}

/** 模型资产、全局提交冷却与模型级价格页面。 */
function ModelsPage({ runtime, onUpdate }: { runtime: AdminRuntimeOverviewView | null; onUpdate: (path: string, body: unknown) => Promise<void> }) { return <><RuntimeConfigEditor runtime={runtime} onUpdate={onUpdate} /><section className="asset-grid">{runtime?.models.map((model) => <ModelEditor key={model.id} model={model} onUpdate={onUpdate} />)}</section></>; }

/** 全平台用户提交冷却编辑器；只限制创建新任务，不让 GPU 在任务之间空转。 */
function RuntimeConfigEditor({ runtime, onUpdate }: { runtime: AdminRuntimeOverviewView | null; onUpdate: (path: string, body: unknown) => Promise<void> }) {
  const configuredSeconds = runtime?.settings.inferenceSubmissionCooldownSeconds ?? 180;
  const [cooldownMinutes, setCooldownMinutes] = useState(configuredSeconds / 60);
  useEffect(() => { setCooldownMinutes(configuredSeconds / 60); }, [configuredSeconds]);
  const save = () => {
    const body: AdminRuntimeConfigUpdateRequest = { inferenceSubmissionCooldownSeconds: Math.round(cooldownMinutes * 60) };
    return onUpdate("/v1/admin/runtime-config", body);
  };
  return <section className="panel runtime-config"><div><span>任务公平性</span><h2>用户提交冷却</h2><p>同一用户成功提交一个本地模型任务后，需要等待设定时间才能再次提交。GPU 会连续处理已经入队的不同用户任务。</p></div><label>冷却时间（分钟）<input type="number" min="0" max="60" step="0.5" value={cooldownMinutes} onChange={(event) => setCooldownMinutes(Number(event.target.value))} /></label><button className="save-button" onClick={() => void save()}>保存全局冷却</button></section>;
}

/** 单个模型的受控配置编辑器。 */
function ModelEditor({ model, onUpdate }: { model: AdminRuntimeOverviewView["models"][number]; onUpdate: (path: string, body: unknown) => Promise<void> }) {
  const defaults = model.defaultParameters;
  const [displayName, setDisplayName] = useState(model.displayName);
  const [description, setDescription] = useState(model.description ?? "");
  const [maxEdge, setMaxEdge] = useState(Number(defaults.maxEdge ?? 1536));
  const [maxAttempts, setMaxAttempts] = useState(Number(defaults.maxAttempts ?? 3));
  const [productCode, setProductCode] = useState(String(defaults.productCode ?? ""));
  const [pricingVersion, setPricingVersion] = useState(Number(defaults.pricingVersion ?? 1));
  const [priceCny, setPriceCny] = useState(String(defaults.priceCny ?? "0.05"));
  const [trainingProductCode, setTrainingProductCode] = useState(String(defaults.trainingProductCode ?? "local.anima-lora.training"));
  const [trainingPricingVersion, setTrainingPricingVersion] = useState(Number(defaults.trainingPricingVersion ?? 2));
  const [trainingPriceCny, setTrainingPriceCny] = useState(String(defaults.trainingPriceCny ?? "0.05"));
  const [promptEnhancementEnabled, setPromptEnhancementEnabled] = useState(defaults.promptEnhancementEnabled === true);
  const payload = (active: boolean): AdminModelUpdateRequest => ({ displayName, description: description || null, active, maxEdge, maxAttempts, productCode, pricingVersion, priceCny: Number(priceCny).toFixed(2), trainingProductCode, trainingPricingVersion, trainingPriceCny: Number(trainingPriceCny).toFixed(2), promptEnhancementEnabled });
  const save = () => onUpdate(`/v1/admin/models/${model.id}`, payload(model.active));
  const toggle = () => onUpdate(`/v1/admin/models/${model.id}`, payload(!model.active));
  return <article className="panel asset model-editor"><span>{model.family} · {model.version}</span><div className="asset-heading"><h2>{model.displayName}</h2><button className={model.active ? "toggle active" : "toggle"} onClick={() => void toggle()}>{model.active ? "已启用" : "已停用"}</button></div><div className="editor-grid"><label>外显名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label>图片价格版本<input type="number" min="1" value={pricingVersion} onChange={(event) => setPricingVersion(Number(event.target.value))} /></label><label>图片单价（元）<input value={priceCny} onChange={(event) => setPriceCny(event.target.value)} /></label><label>最大边<input type="number" min="512" max="2048" step="8" value={maxEdge} onChange={(event) => setMaxEdge(Number(event.target.value))} /></label><label>最大尝试<input type="number" min="1" max="10" value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} /></label><label>图片产品代码<input value={productCode} onChange={(event) => setProductCode(event.target.value)} /></label><label>训练价格版本<input type="number" min="1" value={trainingPricingVersion} onChange={(event) => setTrainingPricingVersion(Number(event.target.value))} /></label><label>训练计价单位（元）<input value={trainingPriceCny} onChange={(event) => setTrainingPriceCny(event.target.value)} /></label><label>训练产品代码<input value={trainingProductCode} onChange={(event) => setTrainingProductCode(event.target.value)} /></label></div><label className="model-capability"><span><strong>AI 提示增强</strong><small>允许用户在任务内执行一次 Anima 英文格式转换</small></span><button className={promptEnhancementEnabled ? "toggle active" : "toggle"} onClick={() => setPromptEnhancementEnabled((value) => !value)}>{promptEnhancementEnabled ? "已开放" : "已关闭"}</button></label><label className="editor-description">描述<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label><div className="workflow-list">{model.workflows.map((workflow) => <div className="workflow-row" key={workflow.id}><div><strong>{workflow.name} · v{workflow.version}</strong><small>{workflow.runtimeType} · {workflow.sha256.slice(0, 16)}…</small></div><button className={workflow.active ? "toggle active" : "toggle"} onClick={() => void onUpdate(`/v1/admin/workflows/${workflow.id}`, { active: !workflow.active } satisfies AdminWorkflowUpdateRequest)}>{workflow.active ? "工作流启用" : "工作流停用"}</button></div>)}</div><button className="save-button" onClick={() => void save()}>保存模型配置</button></article>;
}

/** LoRA 资产页面。 */
function LorasPage({ loras }: { loras: InferenceLoraView[] }) { return <section className="asset-grid">{loras.map((lora) => <article className="panel asset" key={lora.loraVersionId}><span>{lora.modelFamily} · {lora.type}</span><h2>{lora.title}</h2><p>{lora.description}</p><dl><div><dt>GPU 文件</dt><dd>{lora.fileName}</dd></div><div><dt>SHA-256</dt><dd>{lora.sha256.slice(0, 16)}…</dd></div></dl></article>)}</section>; }

/** 汇总数字卡。 */
function Summary({ label, value, tone = "blue" }: { label: string; value: string; tone?: string }) { return <article className={`summary ${tone}`}><span>{label}</span><strong>{value}</strong></article>; }

/** 状态标签。 */
function Status({ ok, label }: { ok: boolean; label: string }) { return <span className={ok ? "state ok" : "state"}><i />{label}</span>; }

/** 管理端格式化产物字节数，便于与对象存储和主站记录核对。 */
function formatArtifactBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return `${value} B`;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 管理端统一显示主站图库发布状态。 */
function publicationStatusLabel(status: NonNullable<InferenceJobView["publication"]>["status"]): string {
  return { pending: "等待同步", publishing: "同步中", published: "已发布", failed: "同步失败" }[status];
}

/** 恢复或交换主站管理员会话。 */
async function restoreAdminSession(): Promise<LocalPlatformSessionView | null> {
  const key = "drawhime_local_session"; const existing = localStorage.getItem(key);
  if (existing) { const current = await sessionRequest("/v1/auth/me", existing, "GET"); if (current) return current; localStorage.removeItem(key); }
  const mainToken = localStorage.getItem("admin_token"); if (!mainToken) return null;
  const exchanged = await sessionRequest("/v1/auth/session/exchange", mainToken, "POST"); if (exchanged) localStorage.setItem(key, exchanged.sessionToken); return exchanged;
}

/** 调用会话接口。 */
async function sessionRequest(path: string, token: string, method: "GET" | "POST") { try { const response = await fetch(`${apiBase}${path}`, { method, headers: { authorization: `Bearer ${token}` }, cache: "no-store" }); const payload = await response.json() as { ok?: boolean; data?: LocalPlatformSessionView }; return response.ok && payload.ok ? payload.data ?? null : null; } catch { return null; } }

/** 解析统一 JSON 响应。 */
async function requestJson<T>(path: string, headers?: HeadersInit): Promise<T> { const response = await fetch(`${apiBase}${path}`, { headers, cache: "no-store" }); const payload = await response.json() as { ok?: boolean; data?: T; message?: string }; if (!response.ok || payload.ok !== true || payload.data === undefined) throw new Error(payload.message || `HTTP ${response.status}`); return payload.data; }

/** 调用管理员 PATCH 接口并解析统一响应。 */
async function mutateJson<T>(path: string, token: string, body: unknown): Promise<T> { const response = await fetch(`${apiBase}${path}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); const payload = await response.json() as { ok?: boolean; data?: T; message?: string }; if (!response.ok || payload.ok !== true || payload.data === undefined) throw new Error(payload.message || `HTTP ${response.status}`); return payload.data; }
