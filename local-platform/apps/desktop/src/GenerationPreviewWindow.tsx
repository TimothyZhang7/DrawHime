/**
 * 本文件实现独立原生生成预览窗口，仅订阅本地任务状态并提供窗口置顶控制。
 */
import type { DesktopLocalJobView } from "@drawhime/contracts";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderOpen, Image, Pin, PinOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { closeDesktopPreviewWindow, listenDesktopGalleryPreviewSelection, listenDesktopLocalJobUpdates, loadDesktopGalleryPreviewJob, loadDesktopLatestLocalJob, loadDesktopPreviewSettings, markDesktopGenerationPreviewReady, revealDesktopLocalJobArtifact, setDesktopGenerationPreviewAlwaysOnTop } from "./desktop-api";
import { applyDesktopDisplayScaleImmediately } from "./desktop-display-scale";

/** 独立窗口读取 SQLite 最近任务，并通过事件更新当前生成进度。 */
export function GenerationPreviewWindow() {
  const galleryMode = getCurrentWindow().label === "gallery-preview";
  const [latestJob, setLatestJob] = useState<DesktopLocalJobView | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    document.body.classList.add("preview-window-body");
    document.documentElement.classList.add("preview-window-document");
    let disposed = false;
    /** 隐藏窗口内只读取主题和最新任务，首帧样式完成后再一次性显示。 */
    const initialize = async () => {
      const [jobResult, settingsResult] = await Promise.allSettled([galleryMode ? loadDesktopGalleryPreviewJob() : loadDesktopLatestLocalJob(), loadDesktopPreviewSettings()]);
      if (disposed) return;
      const messages: string[] = [];
      if (jobResult.status === "fulfilled") setLatestJob(jobResult.value);
      else messages.push(errorMessage(jobResult.reason));
      if (settingsResult.status === "fulfilled") {
        const settings = settingsResult.value;
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const resolved = settings.themeMode === "system" ? (media.matches ? "dark" : "light") : settings.themeMode;
        document.documentElement.dataset.theme = resolved;
        document.documentElement.style.colorScheme = resolved;
        await applyDesktopDisplayScaleImmediately(settings.fontScale, settings.contentFontScale).catch((reason) => messages.push(errorMessage(reason)));
        await getCurrentWindow().setTheme(resolved).catch((reason) => messages.push(errorMessage(reason)));
      } else {
        messages.push(errorMessage(settingsResult.reason));
      }
      if (disposed) return;
      setError(messages.join("；"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!disposed) await markDesktopGenerationPreviewReady();
    };
    void initialize().catch((reason) => setError(errorMessage(reason)));
    return () => {
      disposed = true;
      document.body.classList.remove("preview-window-body");
      document.documentElement.classList.remove("preview-window-document");
    };
  }, [galleryMode]);
  useEffect(() => {
    const disposers: Array<() => void> = [];
    void listenDesktopLocalJobUpdates((job) => setLatestJob((current) => galleryMode ? current?.id === job.id ? job : current : !current || job.id === current.id || job.createdAt >= current.createdAt ? job : current)).then((dispose) => disposers.push(dispose)).catch((reason) => setError(errorMessage(reason)));
    if (galleryMode) void listenDesktopGalleryPreviewSelection(() => loadDesktopGalleryPreviewJob().then(setLatestJob).catch((reason) => setError(errorMessage(reason)))).then((dispose) => disposers.push(dispose)).catch((reason) => setError(errorMessage(reason)));
    return () => disposers.forEach((dispose) => dispose());
  }, [galleryMode]);

  /** 置顶只改变 Windows Z 序，关闭后窗口可自然切换到主窗口后方。 */
  const toggleAlwaysOnTop = async () => {
    try { setAlwaysOnTop(await setDesktopGenerationPreviewAlwaysOnTop(!alwaysOnTop)); setError(""); }
    catch (reason) { setError(errorMessage(reason)); }
  };

  /** 显式关闭按钮复用系统关闭事件，和标题栏关闭、主窗口开关保持同一生命周期。 */
  const closePreview = async () => {
    try { await closeDesktopPreviewWindow(); }
    catch (reason) { setError(errorMessage(reason)); }
  };

  /** 文件定位始终按任务 ID 交给 Rust 核心解析，预览 WebView 不直接提交磁盘路径。 */
  const revealImage = async () => {
    if (!latestJob?.artifact) return;
    try { await revealDesktopLocalJobArtifact(latestJob.id); setError(""); }
    catch (reason) { setError(errorMessage(reason)); }
  };

  return <main className="preview-window-root"><header><div><span>{galleryMode ? "IMAGE PREVIEW" : "LIVE PREVIEW"}</span><strong>{galleryMode ? "图片预览" : "生成预览"}</strong></div><div className="preview-window-actions">{latestJob?.artifact && <button type="button" onClick={() => void revealImage()} title="在文件管理器中定位图片"><FolderOpen /><span>文件位置</span></button>}<button type="button" className={alwaysOnTop ? "active" : ""} onClick={() => void toggleAlwaysOnTop()} title={alwaysOnTop ? "取消置顶，允许窗口位于主窗口后方" : "始终置于其他窗口上方"}>{alwaysOnTop ? <PinOff /> : <Pin />}<span>{alwaysOnTop ? "取消置顶" : "置顶"}</span></button><button type="button" className="preview-window-close" onClick={() => void closePreview()} title="关闭图片预览"><X /><span>关闭</span></button></div></header>{error && <p className="preview-window-error">{error}</p>}<section className="generation-preview"><div className="generation-preview-stage">{latestJob?.artifact ? <img src={convertFileSrc(latestJob.artifact.path)} alt={latestJob.prompt.slice(0, 80)} /> : <div className="generation-preview-empty"><Image /><strong>{latestJob ? jobStatusLabel(latestJob.status) : galleryMode ? "未选择图片" : "尚未提交任务"}</strong><span>{latestJob ? latestJob.error || `本地任务进度 ${latestJob.progress}%` : galleryMode ? "请从本机图库选择一张图片预览。" : "提交任务后，此处会持续展示状态与最终图片。"}</span></div>}{latestJob && !latestJob.artifact && <i><em style={{ width: `${latestJob.progress}%` }} /></i>}</div>{latestJob && <footer><div><span>状态</span><strong>{jobStatusLabel(latestJob.status)}</strong></div><div><span>模型</span><strong>{latestJob.modelDisplayName}</strong></div><div><span>输出</span><strong>{latestJob.parameters.width} × {latestJob.parameters.height}</strong></div><div><span>LoRA</span><strong>{latestJob.loras.length} 个</strong></div></footer>}</section></main>;
}

/** 本地任务状态使用稳定中文外显。 */
function jobStatusLabel(status: DesktopLocalJobView["status"]): string { return { queued: "排队中", running: "生成中", succeeded: "生成完成", failed: "生成失败", cancelled: "已取消" }[status]; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error || "读取生成预览失败"); }
