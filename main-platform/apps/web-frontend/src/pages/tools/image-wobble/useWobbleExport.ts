/** 本文件集中管理局部抖动 GIF/MP4 录制状态、资源清理和结果发布。 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { recordToolUsage } from '../toolUsage';
import {
  buildWobbleFilename,
  selectWobbleMp4MimeType,
  startWobbleGifRecording,
  type WobbleExportFormat,
  type WobbleGifRecordingSession,
} from './image-wobble';

/** GIF 或 MP4 导出结果。 */
export interface WobbleRecordingResult {
  /** 本地对象 URL。 */
  url: string;
  /** 真实二进制结果。 */
  blob: Blob;
  /** 安全下载文件名。 */
  filename: string;
  /** 真实 MIME。 */
  mimeType: string;
  /** 用户选择的格式。 */
  format: WobbleExportFormat;
}

/** 导出 Hook 输入。 */
export interface UseWobbleExportOptions {
  /** WebGL 输出画布。 */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** 当前图片文件名。 */
  filename: string;
  /** 当前遮罩覆盖率。 */
  maskCoverage: number;
  /** 开始录制前切到预览态。 */
  onStartPreview(): void;
  /** 遮罩为空时切回涂抹态。 */
  onRequireMask(): void;
  /** 显示用户可见错误。 */
  onError(message: string): void;
}

/** 页面消费的导出控制器。 */
export interface WobbleExportController {
  exportFormat: WobbleExportFormat;
  recordDuration: number;
  recordFps: number;
  recording: boolean;
  encodingGif: boolean;
  encodingProgress: number;
  recordingResult: WobbleRecordingResult | null;
  mp4Supported: boolean;
  setRecordDuration(value: number): void;
  setRecordFps(value: number): void;
  startRecording(): void;
  stopRecording(): void;
  changeExportFormat(format: WobbleExportFormat): void;
  clearRecordingResult(): void;
}

/** 管理 GIF Worker 和 MP4 MediaRecorder 的完整生命周期。 */
export function useWobbleExport(options: UseWobbleExportOptions): WobbleExportController {
  const [recordDuration, setRecordDuration] = useState(4);
  const [exportFormat, setExportFormat] = useState<WobbleExportFormat>(() => selectWobbleMp4MimeType() ? 'mp4' : 'gif');
  const [recordFps, setRecordFps] = useState(() => selectWobbleMp4MimeType() ? 30 : 12);
  const [recording, setRecording] = useState(false);
  const [encodingGif, setEncodingGif] = useState(false);
  const [encodingProgress, setEncodingProgress] = useState(0);
  const [recordingResult, setRecordingResult] = useState<WobbleRecordingResult | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const gifRecordingRef = useRef<WobbleGifRecordingSession | null>(null);
  const recordTimerRef = useRef(0);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordingUrlRef = useRef('');
  const aliveRef = useRef(true);
  const mp4Supported = selectWobbleMp4MimeType() !== null;

  useEffect(() => () => {
    aliveRef.current = false;
    if (recordTimerRef.current) window.clearTimeout(recordTimerRef.current);
    gifRecordingRef.current?.cancel();
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    recordStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
  }, []);

  /** 清理上一次对象 URL 和结果。 */
  const clearRecordingResult = () => {
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    recordingUrlRef.current = '';
    setRecordingResult(null);
  };

  /** 发布统一结果并记录一次工具使用。 */
  const publishRecordingResult = (blob: Blob, format: WobbleExportFormat, mimeType: string) => {
    if (!blob.size) {
      options.onError('录制结果为空，请重试。');
      return;
    }
    const url = URL.createObjectURL(blob);
    recordingUrlRef.current = url;
    setRecordingResult({ url, blob, filename: buildWobbleFilename(options.filename, format), mimeType, format });
    recordToolUsage('image-wobble');
  };

  /** 启动独立 Worker GIF 捕获。 */
  const startGifRecording = (canvas: HTMLCanvasElement) => {
    try {
      setEncodingGif(false);
      setEncodingProgress(0);
      const session = startWobbleGifRecording(canvas, recordDuration, recordFps, (progress) => {
        if (!aliveRef.current) return;
        if (progress.phase === 'recording') {
          setRecording(true);
          setEncodingGif(false);
          return;
        }
        setRecording(false);
        setEncodingGif(true);
        setEncodingProgress(progress.progress);
      });
      gifRecordingRef.current = session;
      setRecording(true);
      void session.result.then((blob) => {
        if (aliveRef.current) publishRecordingResult(blob, 'gif', 'image/gif');
      }).catch((reason) => {
        if (!aliveRef.current || reason instanceof Error && reason.message === 'GIF 录制已取消') return;
        options.onError(reason instanceof Error ? reason.message : 'GIF 编码失败');
      }).finally(() => {
        if (!aliveRef.current) return;
        if (gifRecordingRef.current === session) gifRecordingRef.current = null;
        setRecording(false);
        setEncodingGif(false);
        setEncodingProgress(0);
      });
    } catch (reason) {
      options.onError(reason instanceof Error ? reason.message : '无法开始 GIF 录制');
      setRecording(false);
      setEncodingGif(false);
    }
  };

  /** 启动浏览器原生 MP4 录制。 */
  const startMp4Recording = (canvas: HTMLCanvasElement, mimeType: string) => {
    try {
      const stream = canvas.captureStream(recordFps);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => options.onError('浏览器 MP4 录制失败，请降低帧率后重试。');
      recorder.onstop = () => {
        if (recordTimerRef.current) window.clearTimeout(recordTimerRef.current);
        stream.getTracks().forEach((track) => track.stop());
        recordStreamRef.current = null;
        recorderRef.current = null;
        if (!aliveRef.current) return;
        setRecording(false);
        publishRecordingResult(new Blob(chunks, { type: mimeType }), 'mp4', mimeType);
      };
      recordStreamRef.current = stream;
      recorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
      recordTimerRef.current = window.setTimeout(() => recorder.state === 'recording' && recorder.stop(), recordDuration * 1000);
    } catch (reason) {
      options.onError(reason instanceof Error ? reason.message : '无法开始 MP4 录制');
      recordStreamRef.current?.getTracks().forEach((track) => track.stop());
      setRecording(false);
    }
  };

  /** 校验遮罩和格式后开始录制。 */
  const startRecording = () => {
    const canvas = options.canvasRef.current;
    if (!canvas) return;
    if (options.maskCoverage <= 0.001) {
      options.onError('请先涂出需要抖动的区域。');
      options.onRequireMask();
      return;
    }
    clearRecordingResult();
    options.onError('');
    options.onStartPreview();
    if (exportFormat === 'gif') {
      startGifRecording(canvas);
      return;
    }
    const mimeType = selectWobbleMp4MimeType();
    if (!mimeType || typeof canvas.captureStream !== 'function') {
      options.onError('当前浏览器不支持 MP4 录制，请选择 GIF。');
      return;
    }
    startMp4Recording(canvas, mimeType);
  };

  /** 手动结束当前捕获。 */
  const stopRecording = () => {
    gifRecordingRef.current?.stop();
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  /** 切换格式并恢复对应推荐帧率。 */
  const changeExportFormat = (format: WobbleExportFormat) => {
    if (recording || encodingGif || format === 'mp4' && !mp4Supported) return;
    setExportFormat(format);
    setRecordFps(format === 'gif' ? 12 : 30);
    clearRecordingResult();
    options.onError('');
  };

  return {
    exportFormat,
    recordDuration,
    recordFps,
    recording,
    encodingGif,
    encodingProgress,
    recordingResult,
    mp4Supported,
    setRecordDuration,
    setRecordFps,
    startRecording,
    stopRecording,
    changeExportFormat,
    clearRecordingResult,
  };
}
