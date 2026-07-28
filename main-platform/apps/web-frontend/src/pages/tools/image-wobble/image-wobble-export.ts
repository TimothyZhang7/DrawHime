/** 本文件实现局部抖动工具的 GIF Worker 录制会话、MP4 能力探测和安全文件命名。 */

/** 用户可选择的动画导出格式。 */
export type WobbleExportFormat = 'gif' | 'mp4';

/** GIF 录制阶段进度。 */
export interface WobbleGifProgress {
  /** 当前阶段。 */
  phase: 'recording' | 'encoding';
  /** 0-1 进度。 */
  progress: number;
}

/** 可停止或取消的 GIF 录制会话。 */
export interface WobbleGifRecordingSession {
  /** 正常结束捕获并等待已提交帧编码。 */
  stop(): void;
  /** 立即终止 Worker，供页面卸载或换图时清理。 */
  cancel(): void;
  /** 最终 GIF Blob。 */
  result: Promise<Blob>;
}

type GifWorkerResponse =
  | { type: 'progress'; encodedFrames: number }
  | { type: 'done'; bytes: ArrayBuffer }
  | { type: 'error'; message: string };

const MAX_GIF_EDGE = 640;

/** 选择浏览器真实支持的 MP4 MediaRecorder MIME；不回退到 WebM。 */
export function selectWobbleMp4MimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=h264', 'video/mp4'];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? null;
}

/** 按用户选择的真实格式生成安全下载文件名。 */
export function buildWobbleFilename(filename: string, format: WobbleExportFormat): string {
  const basename = filename.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'image';
  return `${basename}_wobble.${format}`;
}

/** 启动 GIF 捕获；最长边限制为 640，控制移动端内存和最终文件体积。 */
export function startWobbleGifRecording(
  canvas: HTMLCanvasElement,
  durationSeconds: number,
  fps: number,
  onProgress: (progress: WobbleGifProgress) => void,
): WobbleGifRecordingSession {
  const normalizedFps = Math.max(5, Math.min(15, Math.round(fps)));
  const durationMs = Math.max(250, durationSeconds * 1000);
  const scale = Math.min(1, MAX_GIF_EDGE / Math.max(canvas.width, canvas.height));
  const width = Math.max(2, Math.round(canvas.width * scale));
  const height = Math.max(2, Math.round(canvas.height * scale));
  const captureCanvas = document.createElement('canvas');
  captureCanvas.width = width;
  captureCanvas.height = height;
  const context = captureCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error('无法创建 GIF 捕获画布');

  const worker = new Worker(new URL('./image-wobble-gif.worker.ts', import.meta.url), { type: 'module' });
  const delayMs = Math.max(20, Math.round(1000 / normalizedFps));
  const expectedFrames = Math.max(1, Math.ceil(durationMs / delayMs));
  let capturedFrames = 0;
  let encodedFrames = 0;
  let stopped = false;
  let settled = false;
  let intervalId = 0;
  let timeoutId = 0;
  let resolveResult: (blob: Blob) => void = () => undefined;
  let rejectResult: (reason: Error) => void = () => undefined;
  const result = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const cleanup = () => {
    if (intervalId) window.clearInterval(intervalId);
    if (timeoutId) window.clearTimeout(timeoutId);
  };
  const fail = (reason: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    worker.terminate();
    rejectResult(reason);
  };
  const captureFrame = () => {
    if (stopped) return;
    context.drawImage(canvas, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    capturedFrames += 1;
    worker.postMessage({ type: 'frame', pixels: image.data.buffer }, [image.data.buffer]);
    onProgress({ phase: 'recording', progress: Math.min(1, capturedFrames / expectedFrames) });
  };
  const stop = () => {
    if (stopped || settled) return;
    stopped = true;
    cleanup();
    onProgress({ phase: 'encoding', progress: capturedFrames ? Math.min(1, encodedFrames / capturedFrames) : 0 });
    worker.postMessage({ type: 'finish' });
  };

  worker.onmessage = (event: MessageEvent<GifWorkerResponse>) => {
    if (event.data.type === 'progress') {
      encodedFrames = event.data.encodedFrames;
      if (stopped) onProgress({ phase: 'encoding', progress: capturedFrames ? Math.min(1, encodedFrames / capturedFrames) : 0 });
      return;
    }
    if (event.data.type === 'error') {
      fail(new Error(event.data.message));
      return;
    }
    if (settled) return;
    settled = true;
    cleanup();
    worker.terminate();
    resolveResult(new Blob([event.data.bytes], { type: 'image/gif' }));
  };
  worker.onerror = (event) => fail(new Error(event.message || 'GIF Worker 运行失败'));
  worker.postMessage({ type: 'init', width, height, delayMs });
  captureFrame();
  intervalId = window.setInterval(captureFrame, delayMs);
  timeoutId = window.setTimeout(stop, durationMs);

  return {
    stop,
    cancel: () => fail(new Error('GIF 录制已取消')),
    result,
  };
}
