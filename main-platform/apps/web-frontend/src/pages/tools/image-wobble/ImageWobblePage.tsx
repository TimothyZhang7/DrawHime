/** 本页面实现“局部抖动”工具：本地涂抹遮罩、实时 WebGL 形变和浏览器录制导出。 */
import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, Brush, Download, Eraser, FileVideo2, ImagePlus, Loader2, PaintBucket, Play, Redo2, RotateCcw, Sparkles, Undo2, Waves, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Seo } from '../../../components/Seo';
import { downloadBlob } from '../image-splitter/image-splitter';
import { useToolsConfig } from '../useToolsConfig';
import {
  loadWobbleImage,
  WOBBLE_PRESETS,
  WobbleRenderer,
  type LoadedWobbleImage,
  type WobbleAutoMotion,
  type WobbleGravityDirection,
  type WobblePhysicsParameters,
} from './image-wobble';
import { useWobbleExport } from './useWobbleExport';
import './ImageWobblePage.css';

type EditorMode = 'mask' | 'preview';
type BrushMode = 'paint' | 'erase';
type EditableParameters = WobblePhysicsParameters & { autoMotion: WobbleAutoMotion; autoIntensity: number; periodMs: number };
/** 拖拽回弹的运行时状态，不进入 React 高频渲染。 */
type MotionState = {
  x: number;
  y: number;
  dragging: boolean;
  startClientX: number;
  startClientY: number;
};

const DEFAULT_PRESET = WOBBLE_PRESETS[0];
const DEFAULT_AUTOMATION = { autoMotion: 'none' as const, autoIntensity: 50, periodMs: 1000 };
const MAX_MASK_HISTORY = 8;

/** 局部抖动页面。 */
export function ImageWobblePage() {
  const { getToolConfig } = useToolsConfig();
  const toolConfig = getToolConfig('image-wobble');
  const enabled = toolConfig?.enabled !== false;
  const maxFileSizeMb = toolConfig?.maxFileSizeMb ?? 30;
  const [loaded, setLoaded] = useState<LoadedWobbleImage | null>(null);
  const [mode, setMode] = useState<EditorMode>('mask');
  const [brushMode, setBrushMode] = useState<BrushMode>('paint');
  const [brushSize, setBrushSize] = useState(6);
  const [brushStrength, setBrushStrength] = useState(1);
  const [maskCoverage, setMaskCoverage] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState<string>(DEFAULT_PRESET.id);
  const [parameters, setParameters] = useState<EditableParameters>({ ...DEFAULT_PRESET.parameters, ...DEFAULT_AUTOMATION });
  const [draggingFile, setDraggingFile] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);
  const [rendererReady, setRendererReady] = useState(false);
  const [error, setError] = useState('');
  const [, setHistoryVersion] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WobbleRenderer | null>(null);
  const latestBitmapRef = useRef<ImageBitmap | null>(null);
  const animationFrameRef = useRef(0);
  const parametersRef = useRef(parameters);
  const modeRef = useRef(mode);
  const lastMaskPointRef = useRef<{ x: number; y: number } | null>(null);
  const historyRef = useRef<{ past: ImageData[]; future: ImageData[] }>({ past: [], future: [] });
  const motionRef = useRef<MotionState>({ x: 0, y: 0, dragging: false, startClientX: 0, startClientY: 0 });
  const {
    exportFormat, recordDuration, recordFps, recording, encodingGif, encodingProgress,
    recordingResult, mp4Supported, setRecordDuration, setRecordFps, startRecording,
    stopRecording, changeExportFormat, clearRecordingResult,
  } = useWobbleExport({
    canvasRef: renderCanvasRef,
    filename: loaded?.filename ?? 'image',
    maskCoverage,
    onStartPreview: () => setMode('preview'),
    onRequireMask: () => setMode('mask'),
    onError: setError,
  });

  useEffect(() => { parametersRef.current = parameters; }, [parameters]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => () => {
    cancelAnimationFrame(animationFrameRef.current);
    latestBitmapRef.current?.close();
    rendererRef.current?.dispose();
  }, []);

  useEffect(() => {
    if (!loaded || !renderCanvasRef.current || !maskCanvasRef.current) return;
    setRendererReady(false);
    const maskCanvas = maskCanvasRef.current;
    maskCanvas.width = loaded.width;
    maskCanvas.height = loaded.height;
    const renderer = new WobbleRenderer(renderCanvasRef.current);
    renderer.loadImage(loaded.bitmap, loaded.width, loaded.height);
    renderer.updateMask(maskCanvas);
    rendererRef.current = renderer;
    setRendererReady(true);
    return () => {
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [loaded]);

  useEffect(() => {
    if (!rendererReady) return;
    const renderFrame = (now: number) => {
      const currentMotion = motionRef.current;
      const currentParameters = parametersRef.current;
      const previewing = modeRef.current === 'preview';
      rendererRef.current?.render(now / 1000, {
        ...currentParameters,
        motionX: previewing ? currentMotion.x : 0,
        motionY: previewing ? currentMotion.y : 0,
        dragging: previewing && currentMotion.dragging,
        active: previewing,
      });
      animationFrameRef.current = requestAnimationFrame(renderFrame);
    };
    animationFrameRef.current = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [rendererReady]);

  /** 读取并初始化用户选择的本地静态图片。 */
  const handleFile = async (file: File | null) => {
    setDraggingFile(false);
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(file.type)) {
      setError('请选择 PNG、JPEG、WebP 或 AVIF 静态图片。');
      return;
    }
    if (file.size > maxFileSizeMb * 1024 * 1024) {
      setError(`图片大小不能超过 ${maxFileSizeMb}MB。`);
      return;
    }
    setLoadingImage(true);
    setError('');
    try {
      const next = await loadWobbleImage(file);
      latestBitmapRef.current?.close();
      latestBitmapRef.current = next.bitmap;
      clearRecordingResult();
      historyRef.current = { past: [], future: [] };
      setHistoryVersion((value) => value + 1);
      setMaskCoverage(0);
      setMode('mask');
      resetMotionState(motionRef.current);
      setLoaded(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '图片读取失败');
    } finally {
      setLoadingImage(false);
    }
  };

  /** 拖入图片时显示明确的替换反馈。 */
  const handleFileDrag = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!loadingImage) setDraggingFile(true);
  };

  /** 接收拖入的第一张静态图片。 */
  const handleFileDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDraggingFile(false);
    if (loadingImage) return;
    void handleFile(Array.from(event.dataTransfer.files).find((file) => file.type.startsWith('image/')) ?? null);
  };

  /** 在涂抹开始前保存完整遮罩，支持有限步数的真实撤销。 */
  const saveMaskHistory = () => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    historyRef.current.past.push(context.getImageData(0, 0, canvas.width, canvas.height));
    if (historyRef.current.past.length > MAX_MASK_HISTORY) historyRef.current.past.shift();
    historyRef.current.future = [];
    setHistoryVersion((value) => value + 1);
  };

  /** 开始涂抹或擦除遮罩。 */
  const beginMaskStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (mode !== 'mask') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    saveMaskHistory();
    lastMaskPointRef.current = null;
    paintMask(event);
  };

  /** 根据指针位置连续绘制带柔边的遮罩圆点。 */
  const paintMask = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) && event.buttons === 0) return;
    const canvas = event.currentTarget;
    const context = canvas.getContext('2d');
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const point = { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
    const radius = Math.max(1, brushSize / 100 * Math.min(canvas.width, canvas.height) / 2);
    const previous = lastMaskPointRef.current ?? point;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(2, radius * 0.3)));
    for (let index = 0; index <= steps; index += 1) {
      const ratio = index / steps;
      drawMaskDot(context, previous.x + (point.x - previous.x) * ratio, previous.y + (point.y - previous.y) * ratio, radius, brushStrength, brushMode);
    }
    lastMaskPointRef.current = point;
  };

  /** 完成一次遮罩笔画并同步到 GPU。 */
  const finishMaskStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    lastMaskPointRef.current = null;
    syncMask();
  };

  /** 同步遮罩纹理并估算覆盖率。 */
  const syncMask = () => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    rendererRef.current?.updateMask(canvas);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const sampleStep = Math.max(4, Math.floor(pixels.length / 40000 / 4) * 4);
    let active = 0;
    let total = 0;
    for (let index = 3; index < pixels.length; index += sampleStep) {
      if (pixels[index] > 12) active += 1;
      total += 1;
    }
    setMaskCoverage(total ? active / total : 0);
  };

  /** 执行整张填充、反转或清空操作。 */
  const transformMask = (action: 'fill' | 'invert' | 'clear') => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    saveMaskHistory();
    if (action === 'clear') context.clearRect(0, 0, canvas.width, canvas.height);
    else if (action === 'fill') {
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < imageData.data.length; index += 4) {
        imageData.data[index] = 255;
        imageData.data[index + 1] = 255;
        imageData.data[index + 2] = 255;
        imageData.data[index + 3] = 255 - imageData.data[index + 3];
      }
      context.putImageData(imageData, 0, 0);
    }
    syncMask();
  };

  /** 撤销或重做遮罩编辑。 */
  const restoreMaskHistory = (direction: 'undo' | 'redo') => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const source = direction === 'undo' ? historyRef.current.past : historyRef.current.future;
    const target = direction === 'undo' ? historyRef.current.future : historyRef.current.past;
    const snapshot = source.pop();
    if (!snapshot) return;
    target.push(context.getImageData(0, 0, canvas.width, canvas.height));
    context.putImageData(snapshot, 0, 0);
    setHistoryVersion((value) => value + 1);
    syncMask();
  };

  /** 应用预设并保留为可继续细调的真实参数。 */
  const applyPreset = (presetId: string) => {
    const preset = WOBBLE_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setSelectedPreset(preset.id);
    setParameters((current) => ({ ...current, ...preset.parameters }));
  };

  /** 开始拖动预览图，为局部区域注入运动量。 */
  const beginPreviewDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (mode !== 'preview') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const motion = motionRef.current;
    motion.dragging = true;
    motion.startClientX = event.clientX;
    motion.startClientY = event.clientY;
  };

  /** 按原版 0.32 增益和 0.08 最大行程计算拖动输入。 */
  const movePreviewDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const motion = motionRef.current;
    if (!motion.dragging) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const shortSide = Math.max(1, Math.min(rect.width, rect.height));
    const limited = clampVector({
      x: (event.clientX - motion.startClientX) / shortSide * 0.32,
      y: (event.clientY - motion.startClientY) / shortSide * 0.32,
    }, 0.08);
    motion.x = limited.x;
    motion.y = limited.y;
  };

  /** 松开拖动后清空目标，由模拟器内部的真实 frame 弹簧自然回弹。 */
  const finishPreviewDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const motion = motionRef.current;
    motion.dragging = false;
    motion.x = 0;
    motion.y = 0;
  };

  /** 下载当前预览帧为 PNG。 */
  const downloadSnapshot = () => {
    const canvas = renderCanvasRef.current;
    if (!canvas || !loaded) return;
    canvas.toBlob((blob) => {
      if (!blob) return setError('当前帧导出失败');
      downloadBlob(blob, `${loaded.filename.replace(/\.[^.]+$/, '')}_wobble-frame.png`);
    }, 'image/png');
  };

  /** 清空当前图片和编辑状态。 */
  const clearImage = () => {
    latestBitmapRef.current?.close();
    latestBitmapRef.current = null;
    setLoaded(null);
    setMaskCoverage(0);
    setError('');
    historyRef.current = { past: [], future: [] };
    setHistoryVersion((value) => value + 1);
    clearRecordingResult();
    resetMotionState(motionRef.current);
  };

  if (!enabled) {
    return <div className="wobble-shell"><Seo title="局部抖动" description="绘图姬 DrawHime 局部抖动工具。" path="/tools/image-wobble" /><div className="tool-disabled"><h1>局部抖动</h1><p>该工具当前未开放。</p><Link to="/tools" className="btn btn-outline btn-sm"><ArrowLeft size={14} />返回工具中心</Link></div></div>;
  }

  return (
    <div className="wobble-shell">
      <Seo title="局部抖动" description="在浏览器本地涂抹图片区域，制作柔软弹跳、漂浮或颤动动画并录制导出。" path="/tools/image-wobble" />
      <Link to="/tools" className="tool-back-strip"><ArrowLeft size={14} />返回工具中心</Link>
      <header className="wobble-hero">
        <div><span><Waves size={15} />浏览器本地动态工坊</span><h1>局部抖动</h1><p>涂出想动的地方，再拖一拖。软体形变、遮罩和视频录制全部留在当前设备。</p></div>
        <div className="wobble-privacy"><Sparkles size={17} /><strong>零上传</strong><small>图片 · 遮罩 · 视频</small></div>
      </header>

      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/avif" hidden onChange={(event) => void handleFile(event.target.files?.[0] ?? null)} />
      {!loaded ? (
        <button type="button" className={`wobble-dropzone${draggingFile ? ' is-dragging' : ''}`} onClick={() => fileInputRef.current?.click()} onDragEnter={handleFileDrag} onDragOver={handleFileDrag} onDragLeave={() => setDraggingFile(false)} onDrop={handleFileDrop}>
          <span className="wobble-drop-orbit"><span /><ImagePlus size={30} /></span>
          <strong>{loadingImage ? '正在准备工作画布…' : draggingFile ? '松开载入图片' : '选择或拖入一张图片'}</strong>
          <small>PNG / JPEG / WebP / AVIF · 最大 {maxFileSizeMb}MB · 动图请先转换为静态图片</small>
        </button>
      ) : (
        <>
          <nav className="wobble-mode-tabs" aria-label="工具步骤">
            <button type="button" className={mode === 'mask' ? 'is-active' : ''} onClick={() => setMode('mask')}><Brush size={16} />1. 涂抹区域</button>
            <button type="button" className={mode === 'preview' ? 'is-active' : ''} onClick={() => setMode('preview')}><Play size={16} />2. 预览与导出</button>
          </nav>

          <div className="wobble-workbench">
            <section className="wobble-stage-card" onDragEnter={handleFileDrag} onDragOver={handleFileDrag} onDragLeave={() => setDraggingFile(false)} onDrop={handleFileDrop}>
              <div className="wobble-stage-topline">
                <div><strong>{loaded.filename}</strong><span>{loaded.sourceWidth}×{loaded.sourceHeight}{loaded.width !== loaded.sourceWidth ? ` · 工作尺寸 ${loaded.width}×${loaded.height}` : ''}</span></div>
                <button type="button" onClick={clearImage} title="移除图片"><X size={16} /></button>
              </div>
              <div className={`wobble-canvas-stage is-${mode}${draggingFile ? ' is-file-over' : ''}`} style={{ aspectRatio: `${loaded.width} / ${loaded.height}`, width: `min(100%, calc(70vh * ${loaded.width / loaded.height}))` }}>
                <canvas ref={renderCanvasRef} className="wobble-render-canvas" onPointerDown={beginPreviewDrag} onPointerMove={movePreviewDrag} onPointerUp={finishPreviewDrag} onPointerCancel={finishPreviewDrag} />
                <canvas ref={maskCanvasRef} className="wobble-mask-canvas" onPointerDown={beginMaskStroke} onPointerMove={paintMask} onPointerUp={finishMaskStroke} onPointerCancel={finishMaskStroke} />
                {!rendererReady && <div className="wobble-stage-loading"><Loader2 size={24} className="animate-spin" />准备 WebGL</div>}
                {draggingFile && <div className="wobble-stage-drop">松开替换图片</div>}
              </div>
              <div className="wobble-stage-caption"><span>{mode === 'mask' ? '在图片上涂抹需要活动的部分' : '按住图片拖动，松开后观察回弹'}</span><strong>覆盖约 {Math.round(maskCoverage * 100)}%</strong></div>
            </section>

            <aside className="wobble-controls">
              {mode === 'mask' ? (
                <section className="wobble-panel">
                  <div className="wobble-panel-heading"><span>区域画笔</span><small>柔边会让形变自然衔接</small></div>
                  <div className="wobble-segmented"><button type="button" className={brushMode === 'paint' ? 'is-active' : ''} onClick={() => setBrushMode('paint')}><Brush size={15} />涂抹</button><button type="button" className={brushMode === 'erase' ? 'is-active' : ''} onClick={() => setBrushMode('erase')}><Eraser size={15} />擦除</button></div>
                  <RangeControl label="画笔粗细" value={brushSize} min={1} max={20} step={1} suffix="%" onChange={setBrushSize} />
                  <RangeControl label="画笔强度" value={brushStrength} min={0} max={1} step={0.01} suffix="" format={(value) => `${Math.round(value * 100)}%`} onChange={setBrushStrength} />
                  <div className="wobble-mask-actions">
                    <button type="button" onClick={() => transformMask('fill')}><PaintBucket size={15} />全部涂满</button>
                    <button type="button" onClick={() => transformMask('invert')}><RotateCcw size={15} />反转区域</button>
                    <button type="button" onClick={() => restoreMaskHistory('undo')} disabled={!historyRef.current.past.length}><Undo2 size={15} />撤销</button>
                    <button type="button" onClick={() => restoreMaskHistory('redo')} disabled={!historyRef.current.future.length}><Redo2 size={15} />重做</button>
                    <button type="button" className="is-wide" onClick={() => transformMask('clear')}><X size={15} />清空遮罩</button>
                  </div>
                  <button type="button" className="wobble-next" onClick={() => setMode('preview')} disabled={maskCoverage <= 0.001}>开始抖动 <Play size={16} /></button>
                </section>
              ) : (
                <section className="wobble-panel">
                  <div className="wobble-panel-heading"><span>动作预设</span><small>选择后仍可继续细调</small></div>
                  <div className="wobble-presets">{WOBBLE_PRESETS.map((preset) => <button type="button" key={preset.id} className={selectedPreset === preset.id ? 'is-active' : ''} onClick={() => applyPreset(preset.id)}><strong>{preset.label}</strong><small>{preset.description}</small></button>)}</div>
                  <div className="wobble-parameters">
                    <RangeControl label="输入强度" value={parameters.inputStrength} min={0} max={100} step={1} onChange={(value) => updateParameter('inputStrength', value)} />
                    <RangeControl label="伸展" value={parameters.stretch} min={0} max={100} step={1} onChange={(value) => updateParameter('stretch', value)} />
                    <RangeControl label="回弹" value={parameters.bounce} min={0} max={100} step={1} onChange={(value) => updateParameter('bounce', value)} />
                    <RangeControl label="稳定" value={parameters.damping} min={0} max={100} step={1} onChange={(value) => updateParameter('damping', value)} />
                    <RangeControl label="整体感" value={parameters.cohesion} min={0} max={100} step={1} onChange={(value) => updateParameter('cohesion', value)} />
                    <RangeControl label="随机感" value={parameters.variation} min={0} max={100} step={1} onChange={(value) => updateParameter('variation', value)} />
                    <label className="wobble-select"><span>重力方向</span><select value={parameters.gravityDirection} onChange={(event) => updateParameter('gravityDirection', event.target.value as WobbleGravityDirection)}><option value="none">无</option><option value="down">下</option><option value="up">上</option><option value="left">左</option><option value="right">右</option></select></label>
                    <RangeControl label="重力强度" value={parameters.gravityStrength} min={0} max={2} step={0.1} suffix="G" onChange={(value) => updateParameter('gravityStrength', value)} />
                    <label className="wobble-select"><span>自动晃动</span><select value={parameters.autoMotion} onChange={(event) => updateParameter('autoMotion', event.target.value as WobbleAutoMotion)}><option value="none">关闭</option><option value="sway">左右摇摆</option><option value="hop">上下跳跃</option><option value="orbit">圆周旋转</option></select></label>
                    <RangeControl label="自动晃动强度" value={parameters.autoIntensity} min={0} max={100} step={1} onChange={(value) => updateParameter('autoIntensity', value)} />
                    <RangeControl label="自动晃动周期" value={parameters.periodMs} min={200} max={1800} step={25} suffix="ms" onChange={(value) => updateParameter('periodMs', value)} />
                  </div>
                </section>
              )}

              <section className="wobble-panel wobble-export-panel">
                <div className="wobble-panel-heading"><span>录制并保存</span><small>{mp4Supported ? 'GIF 与 MP4 均可用' : '当前浏览器仅支持 GIF 导出'}</small></div>
                <div className="wobble-format-toggle" aria-label="导出格式">
                  <button type="button" className={exportFormat === 'gif' ? 'is-active' : ''} onClick={() => changeExportFormat('gif')} disabled={recording || encodingGif}><strong>GIF</strong><small>通用循环动图</small></button>
                  <button type="button" className={exportFormat === 'mp4' ? 'is-active' : ''} onClick={() => changeExportFormat('mp4')} disabled={!mp4Supported || recording || encodingGif}><strong>MP4</strong><small>{mp4Supported ? '高画质视频' : '浏览器不支持'}</small></button>
                </div>
                <div className="wobble-record-settings"><label><span>时长</span><select value={recordDuration} onChange={(event) => setRecordDuration(Number(event.target.value))} disabled={recording || encodingGif}><option value={2}>2 秒</option><option value={4}>4 秒</option><option value={6}>6 秒</option></select></label><label><span>帧率</span><select value={recordFps} onChange={(event) => setRecordFps(Number(event.target.value))} disabled={recording || encodingGif}>{exportFormat === 'gif' ? <><option value={8}>8 FPS</option><option value={12}>12 FPS</option><option value={15}>15 FPS</option></> : <><option value={30}>30 FPS</option><option value={60}>60 FPS</option></>}</select></label></div>
                <button type="button" className={`wobble-record${recording ? ' is-recording' : ''}`} onClick={recording ? stopRecording : startRecording} disabled={!rendererReady || encodingGif}>{encodingGif ? <><Loader2 size={17} className="animate-spin" />正在编码 GIF {Math.round(encodingProgress * 100)}%</> : recording ? <><span className="wobble-record-dot" />停止录制</> : <><FileVideo2 size={17} />录制 {exportFormat.toUpperCase()}</>}</button>
                <button type="button" className="wobble-snapshot" onClick={downloadSnapshot} disabled={!rendererReady}><Download size={15} />保存当前帧 PNG</button>
                {recordingResult && <div className="wobble-result">{recordingResult.format === 'gif' ? <img src={recordingResult.url} alt="GIF 动图预览" /> : <video src={recordingResult.url} controls autoPlay loop muted playsInline />}<div><span>{recordingResult.format.toUpperCase()} · {(recordingResult.blob.size / 1024 / 1024).toFixed(2)}MB</span><button type="button" onClick={() => downloadBlob(recordingResult.blob, recordingResult.filename)}><Download size={15} />下载 {recordingResult.format.toUpperCase()}</button></div></div>}
              </section>
              {error && <div className="wobble-error">{error}</div>}
            </aside>
          </div>
        </>
      )}
    </div>
  );

  /** 修改单个动作参数时标记为自定义，防止预设高亮误导。 */
  function updateParameter<Key extends keyof EditableParameters>(key: Key, value: EditableParameters[Key]) {
    setSelectedPreset('custom');
    setParameters((current) => ({ ...current, [key]: value }));
  }
}

/** 通用参数滑杆，统一展示数值和可访问标签。 */
function RangeControl(props: { label: string; value: number; min: number; max: number; step: number; suffix?: string; format?: (value: number) => string; onChange: (value: number) => void }) {
  return <label className="wobble-range"><span><strong>{props.label}</strong><output>{props.format ? props.format(props.value) : `${props.value.toFixed(props.step < 1 ? 2 : 0)}${props.suffix ?? ''}`}</output></span><input type="range" value={props.value} min={props.min} max={props.max} step={props.step} onChange={(event) => props.onChange(Number(event.target.value))} /></label>;
}

/** 绘制与原版一致的硬边圆形遮罩笔刷点。 */
function drawMaskDot(context: CanvasRenderingContext2D, x: number, y: number, radius: number, strength: number, mode: BrushMode): void {
  context.save();
  context.globalCompositeOperation = mode === 'paint' ? 'source-over' : 'destination-out';
  context.fillStyle = `rgba(255,255,255,${strength})`;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/** 按向量长度限制拖拽行程，避免对角拖动超过横向上限。 */
function clampVector(point: { x: number; y: number }, maximumLength: number): { x: number; y: number } {
  const length = Math.hypot(point.x, point.y);
  if (length <= maximumLength || length === 0) return point;
  const scale = maximumLength / length;
  return { x: point.x * scale, y: point.y * scale };
}

/** 清空软体运动状态，避免换图继承上张图片的速度。 */
function resetMotionState(state: MotionState): void {
  Object.assign(state, { x: 0, y: 0, dragging: false, startClientX: 0, startClientY: 0 });
}
