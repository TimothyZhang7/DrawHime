/**
 * 本文件实现桌面端首个可运行工作区：真实环境检测、持续 GPU 阻断提示、本地设置和图库同步队列查看。
 */
import type { DesktopBootstrapView, DesktopEnvironmentReport, DesktopGallerySyncItem, DesktopSettings } from "@drawhime/contracts";
import { AlertTriangle, CheckCircle2, Cpu, Database, FolderCog, Gauge, HardDrive, Image, LoaderCircle, MemoryStick, RefreshCw, Settings2, ShieldCheck, UploadCloud } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { inspectDesktopEnvironment, listDesktopGallerySyncQueue, loadDesktopBootstrap, saveDesktopSettings } from "./desktop-api";

type DesktopPage = "overview" | "environment" | "sync" | "settings";

const navigation = [
  { id: "overview" as const, label: "本机概览", Icon: Gauge },
  { id: "environment" as const, label: "环境检测", Icon: Cpu },
  { id: "sync" as const, label: "图库同步", Icon: UploadCloud },
  { id: "settings" as const, label: "本地设置", Icon: Settings2 },
];

/** 桌面应用根组件始终保留环境异常横幅，并周期复检 GPU 是否仍可用。 */
export function App() {
  const [page, setPage] = useState<DesktopPage>("overview");
  const [bootstrap, setBootstrap] = useState<DesktopBootstrapView | null>(null);
  const [queue, setQueue] = useState<DesktopGallerySyncItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => { void loadDesktopBootstrap().then(async (state) => { setBootstrap(state); setQueue(await listDesktopGallerySyncQueue()); }).catch((error) => setMessage(errorMessage(error))).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setInterval(() => void recheck(true), 60_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void recheck(true); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [bootstrap]);

  /** 快速复检结果立即覆盖旧状态，GPU 恢复前警告不会消失。 */
  const recheck = async (quiet = false) => {
    if (!quiet) setChecking(true);
    try { const environment = await inspectDesktopEnvironment(); setBootstrap((current) => current ? { ...current, environment } : current); if (!quiet) setMessage("环境检测已更新"); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { if (!quiet) setChecking(false); }
  };

  if (loading || !bootstrap) return <div className="desktop-loading"><LoaderCircle className="spin" /><strong>正在建立本地工作区</strong><span>{message || "读取硬件、磁盘与本地数据库"}</span></div>;
  const critical = bootstrap.environment.issues.find((issue) => issue.severity === "critical") || bootstrap.environment.issues[0];
  return <div className="desktop-shell">
    <aside className="desktop-sidebar"><header><div className="desktop-mark">D</div><div><strong>DrawHime</strong><span>DESKTOP</span></div></header><nav>{navigation.map(({ id, label, Icon }) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={17} />{label}{id === "environment" && bootstrap.environment.status !== "ready" && <i />}</button>)}</nav><footer><span>本地核心</span><strong>{bootstrap.environment.status === "ready" ? "运行正常" : "需要处理"}</strong></footer></aside>
    <main className="desktop-main">
      <header className="desktop-topbar"><div><span>本地模型工作站</span><strong>{pageTitle(page)}</strong></div><button onClick={() => void recheck()} disabled={checking}>{checking ? <LoaderCircle className="spin" /> : <RefreshCw />}重新检测</button></header>
      {bootstrap.environment.status !== "ready" && critical && <section className={`environment-banner is-${critical.severity}`}><AlertTriangle /><div><strong>{critical.title}</strong><span>{critical.message}</span></div><button onClick={() => setPage("environment")}>{critical.action}</button></section>}
      {message && <div className="desktop-notice">{message}<button onClick={() => setMessage("")}>×</button></div>}
      {page === "overview" && <OverviewPage state={bootstrap} />}
      {page === "environment" && <EnvironmentPage report={bootstrap.environment} />}
      {page === "sync" && <SyncPage items={queue} />}
      {page === "settings" && <SettingsPage value={bootstrap.settings} onSaved={(settings) => { setBootstrap((current) => current ? { ...current, settings } : current); setMessage("本地设置已保存"); }} onError={setMessage} />}
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
  return <div className="desktop-page"><section className="section-card"><header><div><span>ENVIRONMENT REPORT</span><h2>本机能力检测</h2></div><small>{new Date(report.checkedAt).toLocaleString("zh-CN")}</small></header><div className="environment-summary"><div><Cpu /><span><small>系统</small><strong>{report.os.name} · {report.os.arch}</strong></span></div><div><MemoryStick /><span><small>内存</small><strong>{formatBytes(report.memory.totalBytes)}</strong></span></div><div><HardDrive /><span><small>Runtime</small><strong>{runtimeLabel(report.runtime.status)}</strong></span></div></div></section>{report.issues.length > 0 && <section className="issue-list">{report.issues.map((issue) => <article className={`is-${issue.severity}`} key={issue.code}><AlertTriangle /><div><strong>{issue.title}</strong><p>{issue.message}</p><span>{issue.action}</span></div></article>)}</section>}<section className="section-card"><header><div><span>GPU INVENTORY</span><h2>图形设备</h2></div><small>{report.gpus.length} 个</small></header>{report.gpus.length ? <div className="gpu-list">{report.gpus.map((gpu) => <article key={gpu.uuid}><div><strong>{gpu.name}</strong><span>{gpu.vendor} · 驱动 {gpu.driverVersion}</span></div><dl><div><dt>空闲显存</dt><dd>{formatBytes(gpu.memoryFreeBytes)}</dd></div><div><dt>总显存</dt><dd>{formatBytes(gpu.memoryTotalBytes)}</dd></div><div><dt>计算能力</dt><dd>{gpu.computeCapability || "-"}</dd></div><div><dt>利用率</dt><dd>{gpu.utilizationPercent === null ? "-" : `${gpu.utilizationPercent}%`}</dd></div></dl></article>)}</div> : <div className="empty-block">当前未检测到受支持的 NVIDIA GPU</div>}</section><section className="section-card"><header><div><span>STORAGE</span><h2>本地磁盘</h2></div></header><div className="disk-list">{report.disks.map((disk) => <article key={disk.name}><HardDrive /><span><strong>{disk.name}</strong><small>{disk.fileSystem || "未知文件系统"}</small></span><b>{formatBytes(disk.availableBytes)} 可用</b></article>)}</div></section></div>;
}

/** 图库同步页读取真实 SQLite 队列，离线队列不会因关闭窗口而丢失。 */
function SyncPage({ items }: { items: DesktopGallerySyncItem[] }) {
  return <div className="desktop-page"><section className="section-card"><header><div><span>GALLERY OUTBOX</span><h2>网页图库同步</h2></div><small>{items.length} 项</small></header>{items.length ? <div className="sync-list">{items.map((item) => <article key={item.id}><Image /><div><strong>{item.localTaskId}</strong><span>{item.privacy === "private" ? "私有" : "公开"} · {syncStatusLabel(item.status)}</span></div><small>{item.galleryItemId || item.artifactSha256.slice(0, 12)}</small></article>)}</div> : <div className="empty-block">本机暂时没有等待同步的生成结果</div>}</section></div>;
}

/** 设置页把隐私、目录和上传策略真实保存到本机 SQLite。 */
function SettingsPage({ value, onSaved, onError }: { value: DesktopSettings; onSaved: (settings: DesktopSettings) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState(value);
  const [busy, setBusy] = useState(false);
  const changed = useMemo(() => JSON.stringify(form) !== JSON.stringify(value), [form, value]);
  const save = async () => { setBusy(true); try { onSaved(await saveDesktopSettings(form)); } catch (error) { onError(errorMessage(error)); } finally { setBusy(false); } };
  return <div className="desktop-page"><section className="section-card settings-card"><header><div><span>LOCAL SETTINGS</span><h2>存储与隐私</h2></div><ShieldCheck /></header><div className="settings-grid"><label><span>默认图库权限</span><select value={form.defaultPrivacy} onChange={(event) => setForm({ ...form, defaultPrivacy: event.target.value as DesktopSettings["defaultPrivacy"] })}><option value="private">私有</option><option value="public">公开</option></select><small>每次生成仍可单独覆盖</small></label><label><span>上传并发数</span><select value={form.uploadConcurrency} onChange={(event) => setForm({ ...form, uploadConcurrency: Number(event.target.value) })}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select><small>弱网环境建议 1–2</small></label><PathField label="模型目录" value={form.modelRoot} onChange={(modelRoot) => setForm({ ...form, modelRoot })} /><PathField label="作品目录" value={form.outputRoot} onChange={(outputRoot) => setForm({ ...form, outputRoot })} /><PathField label="Runtime 目录" value={form.runtimeRoot} onChange={(runtimeRoot) => setForm({ ...form, runtimeRoot })} /><label className="settings-check"><input type="checkbox" checked={form.wifiOnly} onChange={(event) => setForm({ ...form, wifiOnly: event.target.checked })} /><span>仅在非计费网络同步图库</span></label></div><footer><button disabled={!changed || busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" /> : <FolderCog />}{busy ? "保存中" : "保存本地设置"}</button></footer></section></div>;
}

/** 目录输入保持明确文本，保存时由本地核心创建并验证写权限。 */
function PathField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="path-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
/** 单项能力卡统一显示真实开放或锁定状态。 */
function CapabilityCard({ label, ready, text }: { label: string; ready: boolean; text: string }) { return <article className={ready ? "is-ready" : "is-locked"}>{ready ? <CheckCircle2 /> : <AlertTriangle />}<div><strong>{label}</strong><span>{text}</span></div></article>; }
/** 总览指标保持紧凑并适配长硬件名称。 */
function Metric({ Icon, label, value }: { Icon: typeof Cpu; label: string; value: string }) { return <article><Icon /><span><small>{label}</small><strong>{value}</strong></span></article>; }
/** 环境状态印章突出当前是否可执行 GPU 任务。 */
function StatusSeal({ status }: { status: DesktopEnvironmentReport["status"] }) { return <div className={`status-seal is-${status}`}><span>ENV</span><strong>{status === "ready" ? "READY" : status.toUpperCase()}</strong></div>; }
function pageTitle(page: DesktopPage): string { return { overview: "本机概览", environment: "环境检测", sync: "图库同步", settings: "本地设置" }[page]; }
function runtimeLabel(status: DesktopEnvironmentReport["runtime"]["status"]): string { return { not_installed: "未安装", installed_unverified: "等待自检", ready: "运行正常", broken: "需要修复" }[status]; }
function syncStatusLabel(status: DesktopGallerySyncItem["status"]): string { return { queued: "等待上传", waiting_network: "等待网络", waiting_auth: "等待登录", uploading: "上传中", committing: "正在提交", synced: "已同步", privacy_pending: "权限待同步", paused: "已暂停", failed_retryable: "等待重试", failed_final: "同步失败", remote_deleted: "网页已删除" }[status]; }
function formatBytes(value: number): string { if (value <= 0) return "0 GB"; return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error || "桌面端操作失败"); }
