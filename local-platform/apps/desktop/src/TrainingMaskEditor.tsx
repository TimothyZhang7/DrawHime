/**
 * 本文件实现训练图片手动 alpha 蒙版编辑器，保存时只向 Rust 核心提交 PNG 蒙版。
 */
import type { DesktopTrainingDatasetView } from "@drawhime/contracts";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, Eraser, LoaderCircle, Paintbrush, Redo2, RotateCcw, Save, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { saveDesktopTrainingManualMask } from "./desktop-api";

type TrainingAsset = DesktopTrainingDatasetView["assets"][number];

/** 手动编辑器保留原图，只生成与原图同尺寸的黑白 alpha 蒙版。 */
export function TrainingMaskEditor({ datasetId, asset, onSaved, onClose, onError }: { datasetId: string; asset: TrainingAsset; onSaved: (dataset: DesktopTrainingDatasetView) => void; onClose: () => void; onError: (message: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceRef = useRef<HTMLImageElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const historyIndexRef = useRef(-1);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"keep" | "erase">("erase");
  const [brushSize, setBrushSize] = useState(48);
  const [zoom, setZoom] = useState(1);
  const [edgePreview, setEdgePreview] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const mask = document.createElement("canvas");
      mask.width = image.naturalWidth;
      mask.height = image.naturalHeight;
      const context = mask.getContext("2d", { willReadFrequently: true });
      if (!context) { onError("当前 WebView 无法创建蒙版画布"); return; }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, mask.width, mask.height);
      sourceRef.current = image;
      maskRef.current = mask;
      historyRef.current = [context.getImageData(0, 0, mask.width, mask.height)];
      historyIndexRef.current = 0;
      setReady(true);
      setHistoryVersion((value) => value + 1);
      renderPreview(canvas, image, mask, edgePreview);
    };
    image.onerror = () => { if (!cancelled) onError("手动抠图无法读取训练原图"); };
    image.src = convertFileSrc(asset.path);
    return () => { cancelled = true; sourceRef.current = null; maskRef.current = null; historyRef.current = []; };
  }, [asset.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = sourceRef.current;
    const mask = maskRef.current;
    if (canvas && image && mask) renderPreview(canvas, image, mask, edgePreview);
  }, [edgePreview]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
  };
  const drawTo = (point: { x: number; y: number }) => {
    const mask = maskRef.current;
    const canvas = canvasRef.current;
    const source = sourceRef.current;
    if (!mask || !canvas || !source) return;
    const context = mask.getContext("2d", { willReadFrequently: true })!;
    const previous = lastPointRef.current || point;
    context.strokeStyle = mode === "keep" ? "#fff" : "#000";
    context.lineWidth = brushSize / zoom;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPointRef.current = point;
    renderPreview(canvas, source, mask, edgePreview);
  };
  const beginStroke = (event: React.PointerEvent<HTMLCanvasElement>) => { if (!ready) return; event.currentTarget.setPointerCapture(event.pointerId); drawingRef.current = true; lastPointRef.current = null; drawTo(pointFromEvent(event)); };
  const moveStroke = (event: React.PointerEvent<HTMLCanvasElement>) => { if (drawingRef.current) drawTo(pointFromEvent(event)); };
  const finishStroke = () => { if (!drawingRef.current) return; drawingRef.current = false; lastPointRef.current = null; pushHistory(maskRef.current!, historyRef, historyIndexRef); setHistoryVersion((value) => value + 1); };
  const restoreHistory = (nextIndex: number) => {
    const mask = maskRef.current; const canvas = canvasRef.current; const source = sourceRef.current;
    if (!mask || !canvas || !source || nextIndex < 0 || nextIndex >= historyRef.current.length) return;
    mask.getContext("2d", { willReadFrequently: true })!.putImageData(historyRef.current[nextIndex]!, 0, 0);
    historyIndexRef.current = nextIndex;
    setHistoryVersion((value) => value + 1);
    renderPreview(canvas, source, mask, edgePreview);
  };
  const save = async () => {
    const mask = maskRef.current;
    if (!mask || busy) return;
    setBusy(true);
    try {
      const encoded = mask.toDataURL("image/png").split(",", 2)[1];
      if (!encoded) throw new Error("生成 PNG 蒙版失败");
      onSaved(await saveDesktopTrainingManualMask({ datasetId, assetId: asset.id, maskPngBase64: encoded }));
      onClose();
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const canUndo = historyVersion >= 0 && historyIndexRef.current > 0;
  const canRedo = historyVersion >= 0 && historyIndexRef.current + 1 < historyRef.current.length;
  return <div className="training-mask-backdrop" role="dialog" aria-modal="true" aria-label={`手动抠图 ${asset.fileName}`}>
    <section className="training-mask-dialog">
      <header><div><span>MANUAL MASK</span><h2>手动抠图</h2><small>{asset.fileName} · {asset.width}×{asset.height}</small></div><button aria-label="关闭手动抠图" onClick={onClose}><X /></button></header>
      <div className="training-mask-toolbar">
        <div><button className={mode === "keep" ? "active" : ""} onClick={() => setMode("keep")}><Paintbrush />保留</button><button className={mode === "erase" ? "active" : ""} onClick={() => setMode("erase")}><Eraser />擦除</button></div>
        <label><span>画笔</span><input type="range" min={4} max={240} value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /><b>{brushSize}px</b></label>
        <div><button disabled={!canUndo} onClick={() => restoreHistory(historyIndexRef.current - 1)}><RotateCcw />撤销</button><button disabled={!canRedo} onClick={() => restoreHistory(historyIndexRef.current + 1)}><Redo2 />重做</button></div>
        <div><button onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}><ZoomOut /></button><b>{Math.round(zoom * 100)}%</b><button onClick={() => setZoom((value) => Math.min(3, value + 0.25))}><ZoomIn /></button></div>
        <label className="training-mask-edge"><input type="checkbox" checked={edgePreview} onChange={(event) => setEdgePreview(event.target.checked)} /><span>边缘预览</span></label>
      </div>
      <div className={`training-mask-stage ${edgePreview ? "is-edge" : ""}`}><canvas ref={canvasRef} style={{ width: `${asset.width * zoom}px`, height: `${asset.height * zoom}px` }} onPointerDown={beginStroke} onPointerMove={moveStroke} onPointerUp={finishStroke} onPointerCancel={finishStroke} /></div>
      <footer><span><Check />原图保持不变，保存后自动选择手动抠图版本</span><button className="secondary" onClick={onClose}>取消</button><button disabled={!ready || busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" /> : <Save />}{busy ? "正在保存" : "保存派生版本"}</button></footer>
    </section>
  </div>;
}

/** 只保留最近十个蒙版历史，避免长时间编辑无限占用内存。 */
function pushHistory(mask: HTMLCanvasElement, history: React.MutableRefObject<ImageData[]>, index: React.MutableRefObject<number>) {
  const context = mask.getContext("2d", { willReadFrequently: true })!;
  const next = history.current.slice(0, index.current + 1);
  next.push(context.getImageData(0, 0, mask.width, mask.height));
  if (next.length > 10) next.shift();
  history.current = next;
  index.current = next.length - 1;
}

/** 使用 destination-in 预览真实透明结果，边缘模式添加高对比背景。 */
function renderPreview(canvas: HTMLCanvasElement, source: HTMLImageElement, mask: HTMLCanvasElement, edgePreview: boolean) {
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (edgePreview) { context.fillStyle = "#ff3b30"; context.fillRect(0, 0, canvas.width, canvas.height); }
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(mask, 0, 0);
  context.globalCompositeOperation = "source-over";
}
