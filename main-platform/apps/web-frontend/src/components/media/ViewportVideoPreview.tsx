/** 本文件负责列表型视频的静态首帧封面与悬浮按需播放，避免页面初始下载 MP4。 */
import { useEffect, useRef, useState } from 'react';
import { resolveMediaUrl, resolvePlayableVideoUrl } from '../../lib/media';

type ViewportVideoPreviewProps = {
  /** backend 返回的站内或绝对视频地址。 */
  src: string;
  /** 调用页面提供的布局样式。 */
  className?: string;
  /** 是否展示可点击的原生播放控件；启用后不再强制悬停播放。 */
  controls?: boolean;
  /** media-service 预先生成的首帧封面地址。 */
  posterSrc?: string;
  /** 首屏卡片可提高封面图片请求优先级。 */
  priority?: boolean;
};

/** 无控件列表只加载封面，桌面精确指针悬浮时才挂载视频；详情播放器保持原生控件。 */
export function ViewportVideoPreview({ src, className, controls = false, posterSrc, priority = false }: ViewportVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [canHover, setCanHover] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);

  useEffect(() => {
    if (controls) return;
    // 触摸设备和减少动态效果的用户只保留静态封面，避免误触下载或自动运动。
    const query = window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
    const sync = () => {
      setCanHover(query.matches);
      if (!query.matches) setPreviewActive(false);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [controls]);

  useEffect(() => {
    if (!previewActive) return;
    void videoRef.current?.play().catch(() => { /* 浏览器延迟自动播放时继续显示静态首帧。 */ });
  }, [previewActive]);

  useEffect(() => {
    setPreviewActive(false);
  }, [src]);

  if (controls) {
    return (
      <video
        ref={videoRef}
        src={resolvePlayableVideoUrl(src)}
        poster={posterSrc ? resolveMediaUrl(posterSrc) : undefined}
        controls
        playsInline
        preload="metadata"
        className={className}
      />
    );
  }

  const startPreview = () => {
    if (canHover) setPreviewActive(true);
  };

  const stopPreview = () => {
    videoRef.current?.pause();
    // 立即卸载 src 可中止离屏卡片的后续 Range 请求，并释放解码器和视频缓冲。
    setPreviewActive(false);
  };

  return (
    <span className={`viewport-video-preview ${className ?? ''}`} onMouseEnter={startPreview} onMouseLeave={stopPreview}>
      {posterSrc ? (
        <img
          src={resolveMediaUrl(posterSrc)}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={priority ? 'high' : 'auto'}
          className="viewport-video-preview-poster"
        />
      ) : <span className="viewport-video-preview-empty" aria-hidden="true" />}
      {previewActive && (
        <video
          ref={videoRef}
          src={resolvePlayableVideoUrl(src)}
          muted
          loop
          autoPlay
          playsInline
          preload="metadata"
          className="viewport-video-preview-player"
          aria-hidden="true"
        />
      )}
    </span>
  );
}
