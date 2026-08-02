/**
 * 本文件统一管理桌面 WebView 页面缩放与独立内容字体，避免根组件重复承担原生缩放队列。
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";

let pendingTimer: number | null = null;
let requestedScale: number | null = null;
let appliedScale: number | null = null;
let scaleQueue: Promise<void> = Promise.resolve();

/** 同步写入不会触发布局异常的显示变量，并清除旧版 CSS zoom 残留。 */
function applyDisplayVariables(fontScale: number, contentFontScale: number): void {
  document.documentElement.style.setProperty("--desktop-font-scale", String(fontScale));
  document.documentElement.style.setProperty("--desktop-content-font-scale", String(contentFontScale));
  document.documentElement.style.setProperty("--desktop-viewport-height", "100vh");
  document.getElementById("root")?.style.removeProperty("zoom");
}

/** 主窗口缩放按最后一次请求串行执行，避免快速选择多个档位造成 WebView 重复重排。 */
export function applyDesktopDisplayScale(fontScale: number, contentFontScale: number): void {
  applyDisplayVariables(fontScale, contentFontScale);
  requestedScale = fontScale;
  if (pendingTimer !== null) window.clearTimeout(pendingTimer);
  if (appliedScale === fontScale) return;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    const targetScale = requestedScale;
    if (targetScale === null || targetScale === appliedScale) return;
    scaleQueue = scaleQueue.catch(() => undefined).then(async () => {
      if (requestedScale !== targetScale) return;
      await getCurrentWebview().setZoom(targetScale);
      if (requestedScale === targetScale) appliedScale = targetScale;
    }).catch((reason) => console.error("设置页面缩放失败", reason));
  }, 80);
}

/** 独立预览窗口在显示首帧前立即应用缩放，避免窗口先闪现错误尺寸。 */
export async function applyDesktopDisplayScaleImmediately(fontScale: number, contentFontScale: number): Promise<void> {
  applyDisplayVariables(fontScale, contentFontScale);
  requestedScale = fontScale;
  await getCurrentWebview().setZoom(fontScale);
  appliedScale = fontScale;
}
