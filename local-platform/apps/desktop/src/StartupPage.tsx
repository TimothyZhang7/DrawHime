/**
 * 本文件实现桌面端首次初始化、后续启动、环境检测和必需依赖的单页入口。
 */
import type { DesktopBootstrapView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView } from "@drawhime/contracts";
import { Activity, AlertTriangle, CheckCircle2, Cpu, Download, HardDrive, LoaderCircle, MemoryStick, PackageCheck, Power, RefreshCw, ShieldCheck } from "lucide-react";
import { coreDependencyProblem, coreResources, dependencySummary, ResourceAction, visibleEnvironmentIssues } from "./ResourceCenter";

/** 启动流程阶段用于按钮和页面状态实时同步。 */
export type StartupPhase = "checking" | "installing" | "starting" | "self_testing" | null;

interface StartupPageProps {
  state: DesktopBootstrapView;
  catalog: DesktopResourceCatalogView | null;
  progress: Record<string, DesktopResourceDownloadView>;
  installProgress: Record<string, DesktopResourceInstallView>;
  phase: StartupPhase;
  checking: boolean;
  bulkBusy: boolean;
  onPrimary: () => void;
  onRecheck: () => void;
  onOpenQueue: () => void;
  onInstallRequired: () => void;
  onDownload: (resourceId: string) => void;
  onPause: (resourceId: string) => void;
  onInstall: (resourceId: string) => void;
}

/** 启动页把首次安装和日常启动收敛成一个主操作，避免用户理解多个技术步骤。 */
export function StartupPage({ state, catalog, progress, installProgress, phase, checking, bulkBusy, onPrimary, onRecheck, onOpenQueue, onInstallRequired, onDownload, onPause, onInstall }: StartupPageProps) {
  const resources = coreResources(catalog);
  const summary = dependencySummary(resources, progress, installProgress);
  const dependencyProblem = coreDependencyProblem(catalog);
  const dependenciesReady = Boolean(catalog?.configured && !dependencyProblem && resources.length > 0 && resources.every((resource) => resource.installed));
  const initialized = dependenciesReady && state.environment.runtime.status === "ready";
  const running = state.runtime.status === "ready" && initialized;
  const transitioning = phase !== null || ["starting", "stopping"].includes(state.runtime.status);
  const environmentIssues = visibleEnvironmentIssues(state.environment);
  const blockingIssue = environmentIssues.find((issue) => issue.severity === "critical" && issue.code !== "runtime_broken") || null;
  // Windows 探测未知只呈现为短暂确认状态，不得使用红色“不支持”外观误导用户。
  const pendingSystemIssue = environmentIssues.find((issue) => issue.code === "windows_version_unknown") || null;
  const backend = state.environment.executionBackend;
  const gpu = backend.deviceIndex !== null ? state.environment.gpus.find((candidate) => candidate.backend === backend.id && candidate.index === backend.deviceIndex) : state.environment.gpus.find((candidate) => candidate.backend === backend.id && candidate.name === backend.adapterName) || state.environment.gpus.find((candidate) => candidate.backend === backend.id);
  const adapters = state.environment.displayAdapters;
  const primaryLabel = startupButtonLabel(phase, state.runtime.status, initialized);
  // 启动与依赖操作使用同一套可解释门禁，避免禁用按钮只呈现灰色而没有恢复路径。
  const primaryDisabledReason = transitioning ? startupPhaseDetail(phase || (state.runtime.status === "starting" ? "starting" : "checking")) : running ? "本地核心已经运行" : blockingIssue ? blockingIssue.message : dependencyProblem;
  const installDisabledReason = bulkBusy ? "正在处理必需依赖，请等待当前操作完成" : !catalog?.configured ? "签名依赖清单当前不可用" : dependencyProblem || (summary.waiting === 0 ? "必需依赖已经全部安装" : null);
  const recheckDisabledReason = checking ? "正在检测当前电脑" : phase ? "初始化流程进行中，完成后会自动刷新状态" : null;
  return <div className="desktop-page startup-page">
    {/* 主操作和阶段状态共享首屏横向空间，避免依赖详情被推到窗口底部。 */}
    <div className="startup-overview">
      <section className={`startup-command is-${running ? "running" : initialized ? "ready" : blockingIssue || dependencyProblem ? "blocked" : "pending"}`}>
        <div className="startup-command-copy"><span>LOCAL STARTUP</span><h1>{running ? "本地核心正在运行" : initialized ? "本地核心已准备完成" : dependencyProblem ? "当前显卡依赖尚未完整发布" : "首次使用，只需初始化一次"}</h1><p>{running ? `本地生成与自动打标已连接到 ${backendDisplayName(backend)}${backend.trainingSupported ? "，LoRA 训练可用" : ""}。` : initialized ? "必需依赖和完整自检均已通过，点击启动即可恢复本地服务。" : "程序会自动识别显卡、安装对应依赖、完成自检并启动；无需手动选择 CUDA 或 DirectML。"}</p><div className="startup-live-state">{running ? <Activity /> : blockingIssue || dependencyProblem ? <AlertTriangle /> : initialized ? <CheckCircle2 /> : <ShieldCheck />}<span>{running ? runtimeEndpoint(state) : blockingIssue?.title || dependencyProblem || (phase ? startupPhaseDetail(phase) : initialized ? "初始化已完成" : "等待开始初始化")}</span></div></div>
        <button className="startup-primary" disabled={Boolean(primaryDisabledReason)} title={primaryDisabledReason || (initialized ? "启动已经完成自检的本地核心" : "检测环境、补齐依赖并启动本地核心")} onClick={onPrimary}>{transitioning ? <LoaderCircle className="spin" /> : running ? <Activity /> : initialized ? <Power /> : <Download />}<span>{primaryLabel}</span><small>{running ? "服务可用" : initialized ? "启动本地服务" : "检测、安装并启动"}</small></button>
      </section>

      <section className="startup-stages" aria-label="启动准备状态">
        <StageCard index="01" label="环境检测" state={blockingIssue ? "error" : pendingSystemIssue ? "active" : "ready"} value={blockingIssue ? "需处理" : pendingSystemIssue ? "确认中" : backendDisplayName(backend)} detail={pendingSystemIssue?.title || gpu?.name || backend.adapterName || "等待可用 GPU"} />
        <StageCard index="02" label="必需依赖" state={dependencyProblem ? "error" : dependenciesReady ? "ready" : summary.downloading ? "active" : "pending"} value={dependencyProblem ? "清单不完整" : dependenciesReady ? "已加载" : summary.downloading ? "下载中" : `${summary.loaded}/${resources.length || 6}`} detail={dependencyProblem || (dependenciesReady ? "Runtime、组件与 Anima Base" : `${summary.waiting} 项等待下载`)} />
        <StageCard index="03" label="本地核心" state={running ? "ready" : phase === "starting" || phase === "self_testing" ? "active" : initialized ? "pending" : "locked"} value={running ? "运行中" : initialized ? "待启动" : phase === "self_testing" ? "自检中" : phase === "starting" ? "启动中" : "等待初始化"} detail={running ? runtimeEndpoint(state) : "完成前两步后自动启动"} />
      </section>
    </div>

    <div className="startup-detail-grid">
      <section className="startup-panel dependency-panel"><header><div><span>REQUIRED FILES</span><h2>必需依赖</h2></div><div className="startup-panel-actions"><button onClick={onOpenQueue} title="查看必需依赖的下载、校验和安装进度"><Download />下载队列</button><button className="primary" disabled={Boolean(installDisabledReason)} title={installDisabledReason || `串行补齐 ${summary.waiting} 项缺失依赖`} onClick={onInstallRequired}>{bulkBusy ? <LoaderCircle className="spin" /> : <PackageCheck />}{bulkBusy ? "正在补齐" : summary.waiting ? `补齐缺失依赖（${summary.waiting}）` : "依赖已齐全"}</button></div></header>{dependencyProblem && <div className="startup-blocking"><AlertTriangle /><div><strong>当前后端依赖不完整</strong><span>{dependencyProblem}</span></div></div>}<div className="startup-dependency-list">{resources.length ? resources.map((resource) => <article key={resource.id}><PackageCheck /><div><strong>{dependencyName(resource)}</strong><span>{formatResourceSize(resource.byteSize)}</span></div><div className="startup-dependency-actions"><b className={resource.installed ? "is-ready" : isBusy(resource.id, progress, installProgress) ? "is-active" : "is-pending"}>{resource.installed ? "已加载" : isBusy(resource.id, progress, installProgress) ? "处理中" : resource.downloaded ? "待安装" : "待下载"}</b><ResourceAction resource={resource} current={progress[resource.id]} installing={installProgress[resource.id]} bulkBusy={bulkBusy} onDownload={onDownload} onPause={onPause} onInstall={onInstall} /></div></article>) : <div className="startup-panel-empty">正在读取签名依赖清单</div>}</div></section>

      <section className="startup-panel environment-panel"><header><div><span>DEVICE CHECK</span><h2>当前电脑</h2></div><button disabled={Boolean(recheckDisabledReason)} title={recheckDisabledReason || "重新检测 Windows、GPU、显存和 Runtime 状态"} onClick={onRecheck}>{checking ? <LoaderCircle className="spin" /> : <RefreshCw />}重新检测</button></header><div className="startup-device"><div className="startup-gpu"><Cpu /><span><small>图形设备</small><strong>{gpu?.name || adapters[0]?.name || "未检测到图形设备"}</strong><em>{adapters.length ? adapters.map((adapter) => `${adapter.vendor} · ${adapter.supportedBackends.length ? adapter.supportedBackends.map(backendLabel).join(" / ") : "仅展示"}`).join(" / ") : "厂商未知"}</em></span></div><dl><div><dt><MemoryStick />显存</dt><dd>{gpu ? gpu.memoryReliable ? `${formatBytes(gpu.memoryFreeBytes)} / ${formatBytes(gpu.memoryTotalBytes)}` : "由 Runtime 自检" : "-"}</dd></div><div><dt><Cpu />处理器</dt><dd>{state.environment.cpu.logicalCores} 线程</dd></div><div><dt><HardDrive />系统内存</dt><dd>{formatBytes(state.environment.memory.totalBytes)}</dd></div></dl></div><div className="startup-compatibility"><AlertTriangle /><span>{backend.id === "amd_directml" ? "AMD 使用 DirectML 兼容模式：FP32 推理、CPU VAE、最高 512px、最多 1 个 LoRA；当前 Windows Trainer 不可用。" : backend.id === "nvidia_cuda" ? "NVIDIA 使用 CUDA 12.6 原生路径，支持本地生成；显存达到训练要求且 Trainer 完整时开放 LoRA 训练。" : "当前未找到可用的 NVIDIA CUDA 或 AMD DirectML 执行后端。"}</span></div>{blockingIssue ? <div className="startup-blocking"><AlertTriangle /><div><strong>{blockingIssue.title}</strong><span>{blockingIssue.message}</span></div></div> : pendingSystemIssue ? <div className="startup-pending"><LoaderCircle className="spin" /><div><strong>{pendingSystemIssue.title}</strong><span>{pendingSystemIssue.message}</span></div></div> : <div className="startup-check-ok"><CheckCircle2 /><span>硬件和系统满足当前启动条件</span></div>}</section>
    </div>
  </div>;
}

function StageCard({ index, label, state, value, detail }: { index: string; label: string; state: "ready" | "active" | "pending" | "locked" | "error"; value: string; detail: string }) { return <article className={`is-${state}`}><i>{index}</i><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>; }
function startupButtonLabel(phase: StartupPhase, runtimeStatus: DesktopBootstrapView["runtime"]["status"], initialized: boolean): string { if (phase === "checking") return "正在检测"; if (phase === "installing") return "正在初始化"; if (phase === "starting" || runtimeStatus === "starting") return "启动中"; if (phase === "self_testing") return "正在自检"; if (runtimeStatus === "ready" && initialized) return "运行中"; return initialized ? "启动" : "初始化"; }
function startupPhaseDetail(phase: Exclude<StartupPhase, null>): string { return { checking: "正在检测系统和签名清单", installing: "正在安装必需依赖", starting: "正在启动本地 Runtime", self_testing: "正在执行完整推理与训练自检" }[phase]; }
function runtimeEndpoint(state: DesktopBootstrapView): string { return state.runtime.port ? `本机端口 ${state.runtime.port}${state.runtime.pid ? ` · PID ${state.runtime.pid}` : ""}` : "本地 Runtime 已就绪"; }
function isBusy(resourceId: string, progress: Record<string, DesktopResourceDownloadView>, installProgress: Record<string, DesktopResourceInstallView>): boolean { return Boolean(progress[resourceId] && ["queued", "downloading", "verifying"].includes(progress[resourceId]!.status)) || Boolean(installProgress[resourceId] && ["verifying", "installing", "switching"].includes(installProgress[resourceId]!.status)); }
function dependencyName(resource: DesktopResourceCatalogView["resources"][number]): string { if (resource.kind === "runtime") return resource.runtimeProfile?.backend === "amd_directml" ? "AMD DirectML Runtime" : "NVIDIA CUDA Runtime"; if (resource.kind === "captioner") return "自动打标组件"; if (resource.kind === "trainer") return "LoRA 训练组件"; return resource.modelRegistration?.role === "primary" ? "Anima Base 底模" : resource.modelRegistration?.role === "text_encoder" ? "Anima Base 文本编码器" : "Anima Base VAE"; }
function backendLabel(backend: string): string { return backend === "amd_directml" ? "DirectML" : backend === "nvidia_cuda" ? "CUDA" : backend; }
function backendDisplayName(backend: DesktopBootstrapView["environment"]["executionBackend"]): string { return backend.deviceIndex === null ? backend.label : `${backend.label} · GPU ${backend.deviceIndex}`; }
function formatResourceSize(value: number): string { return value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024 ** 3).toFixed(2)} GiB`; }
function formatBytes(value: number): string { return value > 0 ? `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB` : "0 GB"; }
