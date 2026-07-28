/** 通用图片灯箱：复用图库详情页的大图预览、缩放、拖拽、下载和键盘操作。 */
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import './ImageLightbox.css';

/** 灯箱最小缩放倍数，1 表示完整适配窗口。 */
const LIGHTBOX_MIN_ZOOM = 1;
/** 灯箱最大缩放倍数，限制滚轮误操作导致图片过度放大。 */
const LIGHTBOX_MAX_ZOOM = 6;
/** 每一格滚轮缩放倍率。 */
const LIGHTBOX_ZOOM_STEP = 1.14;

/** 灯箱图片变换状态。 */
type LightboxTransform = { zoom: number; x: number; y: number };

/** 灯箱手势状态，支持单指拖动和双指缩放。 */
type LightboxGestureState = {
  pointers: Map<number, { x: number; y: number }>;
  mode: 'idle' | 'drag' | 'pinch';
  dragPointerId?: number;
  dragStartX?: number;
  dragStartY?: number;
  dragStartTransform?: LightboxTransform;
  pinchStartDistance?: number;
  pinchStartZoom?: number;
  pinchCenterX?: number;
  pinchCenterY?: number;
};

/** 灯箱中可预览的单张图片。 */
export type ImageLightboxItem = {
  src: string;
  title: string;
  downloadName: string;
  alt?: string;
};

type ImageLightboxProps = {
  open: boolean;
  images: ImageLightboxItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
};

/** 图片灯箱组件：被图库详情页和生成页预览共用，确保交互与样式一致。 */
export function ImageLightbox({ open, images, index, onIndexChange, onClose }: ImageLightboxProps) {
  const [lightboxTransform, setLightboxTransform] = useState<LightboxTransform>({ zoom: 1, x: 0, y: 0 });
  const [lightboxDragging, setLightboxDragging] = useState(false);
  const lightboxStageRef = useRef<HTMLDivElement | null>(null);
  const lightboxImageRef = useRef<HTMLImageElement | null>(null);
  const lightboxGestureRef = useRef<LightboxGestureState>({ pointers: new Map(), mode: 'idle' });
  const activeIndex = Math.min(Math.max(index, 0), Math.max(images.length - 1, 0));
  const activeImage = images[activeIndex];

  /** 切换灯箱图片或重新打开时恢复完整适配，避免上一张图的缩放状态污染当前图。 */
  useEffect(() => {
    if (!open) return;
    setLightboxTransform({ zoom: 1, x: 0, y: 0 });
    setLightboxDragging(false);
    lightboxGestureRef.current = { pointers: new Map(), mode: 'idle' };
  }, [open, activeIndex]);

  /** 根据当前缩放和容器尺寸限制拖动范围，避免图片被拖到完全离开可视区域。 */
  const clampLightboxTransform = useCallback((next: LightboxTransform): LightboxTransform => {
    const stage = lightboxStageRef.current;
    const image = lightboxImageRef.current;
    if (!stage || !image || next.zoom <= LIGHTBOX_MIN_ZOOM + 0.001) return { zoom: 1, x: 0, y: 0 };
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const scaledWidth = image.offsetWidth * next.zoom;
    const scaledHeight = image.offsetHeight * next.zoom;
    const maxX = Math.max(0, (scaledWidth - stageWidth) / 2);
    const maxY = Math.max(0, (scaledHeight - stageHeight) / 2);
    return {
      zoom: next.zoom,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }, []);

  /** 灯箱内滚轮缩放：以鼠标悬浮位置为缩放中心，不影响页面其它区域滚动。 */
  const handleLightboxWheel = useCallback((event: globalThis.WheelEvent) => {
    const stage = lightboxStageRef.current;
    if (!stage) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = stage.getBoundingClientRect();
    const cursorX = event.clientX - rect.left - rect.width / 2;
    const cursorY = event.clientY - rect.top - rect.height / 2;
    const ratio = event.deltaY < 0 ? LIGHTBOX_ZOOM_STEP : 1 / LIGHTBOX_ZOOM_STEP;

    setLightboxTransform((current) => {
      const nextZoom = Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, current.zoom * ratio));
      if (Math.abs(nextZoom - LIGHTBOX_MIN_ZOOM) < 0.001) return { zoom: 1, x: 0, y: 0 };
      if (Math.abs(nextZoom - current.zoom) < 0.001) return current;

      const zoomRatio = nextZoom / current.zoom;
      return clampLightboxTransform({
        zoom: nextZoom,
        x: cursorX - (cursorX - current.x) * zoomRatio,
        y: cursorY - (cursorY - current.y) * zoomRatio,
      });
    });
  }, [clampLightboxTransform]);

  /** 只有缩放后才允许拖动；未缩放时拖拽不改变图片位置，避免误操作。 */
  const handleLightboxPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const gesture = lightboxGestureRef.current;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.pointers.size >= 2) {
      beginPinchGesture(gesture);
      setLightboxDragging(true);
      return;
    }
    gesture.mode = 'drag';
    gesture.dragPointerId = event.pointerId;
    gesture.dragStartX = event.clientX;
    gesture.dragStartY = event.clientY;
    gesture.dragStartTransform = lightboxTransform;
    setLightboxDragging(lightboxTransform.zoom > LIGHTBOX_MIN_ZOOM + 0.001);
  }, [lightboxTransform]);

  /** 拖动距离和当前缩放状态联动，并在每一帧限制到可视范围内。 */
  const handleLightboxPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const gesture = lightboxGestureRef.current;
    const point = gesture.pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;

    if (gesture.pointers.size >= 2) {
      if (gesture.mode !== 'pinch') {
        beginPinchGesture(gesture);
      }
      const [first, second] = [...gesture.pointers.values()];
      if (!first || !second || gesture.pinchStartDistance === undefined) return;
      const nextDistance = distanceBetween(first, second);
      const nextZoom = clampZoom((gesture.pinchStartZoom ?? 1) * (nextDistance / gesture.pinchStartDistance));
      const center = getPointCenter(first, second);
      setLightboxTransform(clampLightboxTransform({
        zoom: nextZoom,
        x: center.x - gesture.pinchCenterX! + (gesture.dragStartTransform?.x ?? lightboxTransform.x),
        y: center.y - gesture.pinchCenterY! + (gesture.dragStartTransform?.y ?? lightboxTransform.y),
      }));
      setLightboxDragging(true);
      return;
    }

    if (gesture.mode !== 'drag' || gesture.dragPointerId !== event.pointerId) return;
    const next = {
      zoom: gesture.dragStartTransform?.zoom ?? lightboxTransform.zoom,
      x: (gesture.dragStartTransform?.x ?? 0) + event.clientX - (gesture.dragStartX ?? event.clientX),
      y: (gesture.dragStartTransform?.y ?? 0) + event.clientY - (gesture.dragStartY ?? event.clientY),
    };
    setLightboxTransform(clampLightboxTransform(next));
  }, [clampLightboxTransform]);

  /** 结束拖动并释放 pointer 捕获，防止鼠标离开灯箱后状态残留。 */
  const stopLightboxDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const gesture = lightboxGestureRef.current;
    gesture.pointers.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (gesture.pointers.size === 0) {
      gesture.mode = 'idle';
      setLightboxDragging(false);
      return;
    }
    if (gesture.pointers.size === 1) {
      const [only] = [...gesture.pointers.entries()];
      if (only) {
        gesture.mode = 'drag';
        gesture.dragPointerId = only[0];
        gesture.dragStartX = only[1].x;
        gesture.dragStartY = only[1].y;
        gesture.dragStartTransform = lightboxTransform;
      }
      setLightboxDragging(lightboxTransform.zoom > LIGHTBOX_MIN_ZOOM + 0.001);
    }
  }, []);

  /** 原生 wheel 监听必须关闭 passive，才能把滚轮行为限制在灯箱图片区域内。 */
  useEffect(() => {
    if (!open) return;
    const stage = lightboxStageRef.current;
    if (!stage) return;
    stage.addEventListener('wheel', handleLightboxWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleLightboxWheel);
  }, [open, handleLightboxWheel]);

  /** 键盘快捷操作与图库详情页保持一致：Esc 关闭，左右键切换。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') onIndexChange(Math.max(0, activeIndex - 1));
      if (event.key === 'ArrowRight') onIndexChange(Math.min(images.length - 1, activeIndex + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, activeIndex, images.length, onClose, onIndexChange]);

  if (!open || images.length === 0 || !activeImage) return null;

  return createPortal(
    <div
      className="image-lightbox-overlay fixed inset-0 z-[100] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="image-lightbox-shell relative flex flex-col overflow-hidden"
        style={{
          background: 'rgba(18,18,20,0.55)',
          backdropFilter: 'blur(24px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.35)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 flex-shrink-0" style={{ background: 'transparent' }}>
          <span className="text-white/50 text-xs">{activeImage.title}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={event => {
                event.stopPropagation();
                const link = document.createElement('a');
                link.href = activeImage.src;
                link.download = activeImage.downloadName;
                link.click();
              }}
              className="flex items-center gap-1 text-white/50 hover:text-white/90 transition-colors"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 6 }}
              title="下载当前图片"
            >
              <Download size={15} />
            </button>
            <button
              onClick={onClose}
              className="text-white/50 hover:text-white/90 transition-colors flex-shrink-0"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
              aria-label="关闭图片预览"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div
          className={`image-lightbox-stage flex-1 flex items-center justify-center relative overflow-hidden ${lightboxTransform.zoom > LIGHTBOX_MIN_ZOOM + 0.001 ? 'is-zoomed' : ''} ${lightboxDragging ? 'is-dragging' : ''}`}
          ref={lightboxStageRef}
          onPointerDown={handleLightboxPointerDown}
          onPointerMove={handleLightboxPointerMove}
          onPointerUp={stopLightboxDrag}
          onPointerCancel={stopLightboxDrag}
          onPointerLeave={(event) => { if (lightboxDragging) stopLightboxDrag(event); }}
        >
          <img
            ref={lightboxImageRef}
            src={activeImage.src}
            alt={activeImage.alt ?? ''}
            className="image-lightbox-image object-contain"
            style={{
              transform: `translate3d(${lightboxTransform.x}px, ${lightboxTransform.y}px, 0) scale(${lightboxTransform.zoom})`,
            }}
          />

          {images.length > 1 && (
            <>
              <button
                type="button"
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); onIndexChange(activeIndex === 0 ? images.length - 1 : activeIndex - 1); }}
                className="image-lightbox-nav is-prev absolute left-2 flex items-center justify-center rounded-full transition-all"
                style={{
                  width: 34,
                  height: 34,
                  background: 'rgba(255,255,255,0.12)',
                  border: 'none',
                  cursor: 'pointer',
                }}
                aria-label="上一张图片"
              >
                <ChevronLeft size={20} color="#fff" />
              </button>
              <button
                type="button"
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); onIndexChange(activeIndex === images.length - 1 ? 0 : activeIndex + 1); }}
                className="image-lightbox-nav is-next absolute right-2 flex items-center justify-center rounded-full transition-all"
                style={{
                  width: 34,
                  height: 34,
                  background: 'rgba(255,255,255,0.12)',
                  border: 'none',
                  cursor: 'pointer',
                }}
                aria-label="下一张图片"
              >
                <ChevronRight size={20} color="#fff" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function beginPinchGesture(gesture: LightboxGestureState) {
  const [first, second] = [...gesture.pointers.values()];
  if (!first || !second) return;
  gesture.mode = 'pinch';
  gesture.pinchStartDistance = distanceBetween(first, second);
  gesture.pinchStartZoom = gesture.dragStartTransform?.zoom ?? 1;
  gesture.pinchCenterX = (first.x + second.x) / 2;
  gesture.pinchCenterY = (first.y + second.y) / 2;
  gesture.dragStartTransform = gesture.dragStartTransform ?? { zoom: 1, x: 0, y: 0 };
}

function distanceBetween(left: { x: number; y: number }, right: { x: number; y: number }) {
  return Math.max(1, Math.hypot(left.x - right.x, left.y - right.y));
}

function getPointCenter(left: { x: number; y: number }, right: { x: number; y: number }) {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function clampZoom(value: number) {
  return Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, value));
}
