/**
 * 本文件实现桌面端首次初始化、后续启动、环境检测和必需依赖的单页入口。
 */
import type { DesktopBootstrapView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView } from "@drawhime/contracts";
import { Activity, AlertTriangle, CheckCircle2, Cpu, Download, HardDrive, LoaderCircle, MemoryStick, PackageCheck, Power, RefreshCw, ShieldCheck } from "lucide-react";
import { coreResources, dependencySummary, ResourceAction, visibleEnvironmentIssues } from "./ResourceCenter";

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
  const dependenciesReady = Boolean(catalog?.configured && resources.length > 0 && resources.every((resource) => resource.installed));
  const initialized = dependenciesReady && state.environment.runtime.status === "ready";
  const running = state.runtime.status === "ready" && initialized;
  const transitioning = phase !== null || ["starting", "stopping"].includes(state.runtime.status);
  const blockingIssue = visibleEnvironmentIssues(state.environment).find((issue) => issue.severity === "critical" && issue.code !== "runtime_broken") || null;
  const gpu = state.environment.gpus[0];
  const primaryLabel = startupButtonLabel(phase, state.runtime.status, initialized);
  return <div className="desktop-page startup-page">
    <section className={`startup-command is-${running ? "running" : initialized ? "ready" : blockingIssue ? "blocked" : "pending"}`}>
      <div className="startup-command-copy"><span>LOCAL STARTUP</span><h1>{running ? "本地核心正在运行" : initialized ? "本地核心已准备完成" : "首次使用，只需初始化一次"}</h1><p>{running ? "生成、自动打标和 LoRA 训练已连接到本机 GPU。" : initialized ? "必需依赖和完整自检均已通过，点击启动即可恢复本地服务。" : "程序会依次检测电脑、安装必需依赖、完成自检并自动启动。后续打开只需点击启动。"}</p><div className="startup-live-state">{running ? <Activity /> : blockingIssue ? <AlertTriangle /> : initialized ? <CheckCircle2 /> : <ShieldCheck />}<span>{running ? runtimeEndpoint(state) : blockingIssue?.title || (phase ? startupPhaseDetail(phase) : initialized ? "初始化已完成" : "等待开始初始化")}</span></div></div>
      <button className="startup-primary" disabled={transitioning || running || Boolean(blockingIssue)} onClick={onPrimary}>{transitioning ? <LoaderCircle className="spin" /> : running ? <Activity /> : initialized ? <Power /> : <Download />}<span>{primaryLabel}</span><small>{running ? "服务可用" : initialized ? "启动本地服务" : "检测、安装并启动"}</small></button>
    </section>

    <section className="startup-stages" aria-label="启动准备状态">
      <StageCard index="01" label="环境检测" state={blockingIssue ? "error" : "ready"} value={blockingIssue ? "需处理" : "已检测"} detail={gpu?.name || "等待 NVIDIA GPU"} />
      <StageCard index="02" label="必需依赖" state={dependenciesReady ? "ready" : summary.downloading ? "active" : "pending"} value={dependenciesReady ? "已加载" : summary.downloading ? "下载中" : `${summary.loaded}/${resources.length || 6}`} detail={dependenciesReady ? "Runtime、组件与 Anima Base" : `${summary.waiting} 项等待下载`} />
      <StageCard index="03" label="本地核心" state={running ? "ready" : phase === "starting" || phase === "self_testing" ? "active" : initialized ? "pending" : "locked"} value={running ? "运行中" : initialized ? "待启动" : phase === "self_testing" ? "自检中" : phase === "starting" ? "启动中" : "等待初始化"} detail={running ? runtimeEndpoint(state) : "完成前两步后自动启动"} />
    </section>

    <div className="startup-detail-grid">
      <section className="startup-panel dependency-panel"><header><div><span>REQUIRED FILES</span><h2>必需依赖</h2></div><div className="startup-panel-actions"><button onClick={onOpenQueue}><Download />下载队列</button><button className="primary" disabled={!catalog?.configured || summary.waiting === 0 || bulkBusy} onClick={onInstallRequired}>{bulkBusy ? <LoaderCircle className="spin" /> : <PackageCheck />}{bulkBusy ? "正在补齐" : summary.waiting ? `补齐缺失依赖（${summary.waiting}）` : "依赖已齐全"}</button></div></header><div className="startup-dependency-list">{resources.length ? resources.map((resource) => <article key={resource.id}><PackageCheck /><div><strong>{dependencyName(resource)}</strong><span>{formatResourceSize(resource.byteSize)}</span></div><div className="startup-dependency-actions"><b className={resource.installed ? "is-ready" : isBusy(resource.id, progress, installProgress) ? "is-active" : "is-pending"}>{resource.installed ? "已加载" : isBusy(resource.id, progress, installProgress) ? "处理中" : resource.downloaded ? "待安装" : "待下载"}</b><ResourceAction resource={resource} current={progress[resource.id]} installing={installProgress[resource.id]} bulkBusy={bulkBusy} onDownload={onDownload} onPause={onPause} onInstall={onInstall} /></div></article>) : <div className="startup-panel-empty">正在读取签名依赖清单</div>}</div></section>

      <section className="startup-panel environment-panel"><header><div><span>DEVICE CHECK</span><h2>当前电脑</h2></div><button disabled={checking || Boolean(phase)} onClick={onRecheck}>{checking ? <LoaderCircle className="spin" /> : <RefreshCw />}重新检测</button></header><div className="startup-device"><div className="startup-gpu"><Cpu /><span><small>图形设备</small><strong>{gpu?.name || "未检测到受支持的 GPU"}</strong></span></div><dl><div><dt><MemoryStick />显存</dt><dd>{gpu ? `${formatBytes(gpu.memoryFreeBytes)} / ${formatBytes(gpu.memoryTotalBytes)}` : "-"}</dd></div><div><dt><Cpu />处理器</dt><dd>{state.environment.cpu.logicalCores} 线程</dd></div><div><dt><HardDrive />系统内存</dt><dd>{formatBytes(state.environment.memory.totalBytes)}</dd></div></dl></div>{blockingIssue ? <div className="startup-blocking"><AlertTriangle /><div><strong>{blockingIssue.title}</strong><span>{blockingIssue.message}</span></div></div> : <div className="startup-check-ok"><CheckCircle2 /><span>硬件和系统满足当前启动条件</span></div>}</section>
    </div>
  </div>;
}

function StageCard({ index, label, state, value, detail }: { index: string; label: string; state: "ready" | "active" | "pending" | "locked" | "error"; value: string; detail: string }) { return <article className={`is-${state}`}><i>{index}</i><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>; }
function startupButtonLabel(phase: StartupPhase, runtimeStatus: DesktopBootstrapView["runtime"]["status"], initialized: boolean): string { if (phase === "checking") return "正在检测"; if (phase === "installing") return "正在初始化"; if (phase === "starting" || runtimeStatus === "starting") return "启动中"; if (phase === "self_testing") return "正在自检"; if (runtimeStatus === "ready" && initialized) return "运行中"; return initialized ? "启动" : "初始化"; }
function startupPhaseDetail(phase: Exclude<StartupPhase, null>): string { return { checking: "正在检测系统和签名清单", installing: "正在安装必需依赖", starting: "正在启动本地 Runtime", self_testing: "正在执行完整推理与训练自检" }[phase]; }
function runtimeEndpoint(state: DesktopBootstrapView): string { return state.runtime.port ? `本机端口 ${state.runtime.port}${state.runtime.pid ? ` · PID ${state.runtime.pid}` : ""}` : "本地 Runtime 已就绪"; }
function isBusy(resourceId: string, progress: Record<string, DesktopResourceDownloadView>, installProgress: Record<string, DesktopResourceInstallView>): boolean { return Boolean(progress[resourceId] && ["queued", "downloading", "verifying"].includes(progress[resourceId]!.status)) || Boolean(installProgress[resourceId] && ["verifying", "installing", "switching"].includes(installProgress[resourceId]!.status)); }
function dependencyName(resource: DesktopResourceCatalogView["resources"][number]): string { if (resource.kind === "runtime") return "本地 Runtime"; if (resource.kind === "captioner") return "自动打标组件"; if (resource.kind === "trainer") return "LoRA 训练组件"; return resource.modelRegistration?.role === "primary" ? "Anima Base 底模" : resource.modelRegistration?.role === "text_encoder" ? "Anima Base 文本编码器" : "Anima Base VAE"; }
function formatResourceSize(value: number): string { return value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024 ** 3).toFixed(2)} GiB`; }
function formatBytes(value: number): string { return value > 0 ? `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB` : "0 GB"; }
