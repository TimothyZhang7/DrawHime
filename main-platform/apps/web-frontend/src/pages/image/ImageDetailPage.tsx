/** 图片详情页 */
import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type SyntheticEvent } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Heart, Eye, Download, Image, Info, AlertTriangle, Lock, Trash2, Unlock, Tags, Layers3 } from 'lucide-react';
import { api } from '../../lib/api';
import { ConfirmDialog, type ConfirmDialogTone } from '../../components/common/ConfirmDialog';
import { ImageLightbox } from '../../components/image/ImageLightbox';
import { resolveMediaUrl, resolvePlayableVideoUrl } from '../../lib/media';
import { formatDrawingModelNameByMap, useDrawingModelDisplayMap } from '../../lib/drawingModelDisplay';
import { GalleryTags } from '../../components/gallery/GalleryTags';
import { ViewportVideoPreview } from '../../components/media/ViewportVideoPreview';
import { ImagePromptCard } from './ImagePromptCard';
import type { GalleryImageAssetView, GalleryImageDetailView, GalleryItemView, GalleryLocalModelLoraMetadataView } from '@aiimage/shared-contracts';
import './ImageDetailPage.css';

/** 图片详情页的所有者待确认动作；确认后才会执行隐私切换或删除。 */
type ImageDetailConfirmAction = {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  tone: ConfirmDialogTone;
  run: () => Promise<void>;
};

/** 主图组件：先显式解码原图，解码完成后把原图淡入到缩略图上方，避免白闪或长期停留在模糊图。 */
function FullImage({ src, thumb, alt, onNaturalSize, onError }: { src: string; thumb: string; alt: string; onNaturalSize?: (size: string) => void; onError?: () => void }) {
  const [fullReady, setFullReady] = useState(false);
  const onNaturalSizeRef = useRef(onNaturalSize);
  const onErrorRef = useRef(onError);
  const sameImage = src === thumb;

  useEffect(() => {
    onNaturalSizeRef.current = onNaturalSize;
    onErrorRef.current = onError;
  }, [onNaturalSize, onError]);

  useEffect(() => {
    setFullReady(sameImage);
    if (sameImage) return;

    let active = true;
    let reported = false;
    const preload = new window.Image();

    /** 原图必须完成浏览器解码后再展示，避免插入 DOM 时出现白色闪烁。 */
    const finish = async () => {
      if (reported) return;
      reported = true;
      try {
        await preload.decode?.();
      } catch {
        // decode 在部分浏览器或缓存状态下可能抛错；onload 已成功时仍可继续展示。
      }
      if (!active) return;
      if (preload.naturalWidth > 0 && preload.naturalHeight > 0) {
        onNaturalSizeRef.current?.(`${preload.naturalWidth}X${preload.naturalHeight}`);
      }
      setFullReady(true);
    };

    preload.onload = () => { void finish(); };
    preload.onerror = () => {
      if (active) onErrorRef.current?.();
    };
    preload.src = src;
    if (preload.complete && preload.naturalWidth > 0) void finish();

    return () => {
      active = false;
      preload.onload = null;
      preload.onerror = null;
    };
  }, [sameImage, src, thumb]);

  /** 原图加载完成后读取真实像素尺寸，避免父组件额外发起一次 Image 请求。 */
  const handleFullLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      onNaturalSize?.(`${image.naturalWidth}X${image.naturalHeight}`);
    }
    setFullReady(true);
  };

  if (sameImage) {
    return (
      <img
        src={src}
        alt={alt}
        loading="eager"
        decoding="async"
        fetchPriority="high"
        className="w-full object-contain"
        style={{ maxHeight: '80vh' }}
        onLoad={handleFullLoad}
        onError={onError}
      />
    );
  }

  return (
    <div className={`image-detail-full-stage${fullReady ? ' is-full-ready' : ''}`}>
      <img
        src={thumb}
        alt={alt}
        loading="eager"
        decoding="async"
        fetchPriority="high"
        className="image-detail-thumb-layer"
        aria-hidden={fullReady}
      />
      {fullReady && (
        <img
          src={src}
          alt={alt}
          loading="eager"
          decoding="async"
          fetchPriority="high"
          className="image-detail-full-layer"
          onError={onError}
        />
      )}
    </div>
  );
}

type Detail = GalleryImageDetailView;

/** 本地模型 LoRA 类型的中文外显。 */
function formatLocalModelLoraType(type: NonNullable<GalleryImageDetailView['localModel']>['loras'][number]['type']): string {
  const labels = { style: '风格', character: '角色', concept: '概念', clothing: '服装', pose: '姿势', object: '物体', slider: '调节器', other: '其他' } as const;
  return labels[type];
}

/** 统一展示 Runtime 实际权重，保留必要精度并兼容历史缺失值。 */
function formatLocalModelLoraStrength(strength: number | null): string {
  if (strength == null) return '-';
  return Number(strength.toFixed(3)).toString();
}

/** 使用主站鉴权代理加载 LoRA 封面，私密作品也不会把服务凭证或对象存储地址暴露给浏览器。 */
function LocalModelLoraCover({ coverUrl, title }: { coverUrl: string; title: string }) {
  const [source, setSource] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    const accessToken = localStorage.getItem('token') ?? '';
    void fetch(resolveMediaUrl(coverUrl), {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return;
      objectUrl = URL.createObjectURL(await response.blob());
      setSource(objectUrl);
    }).catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [coverUrl]);
  return <div className="image-local-lora-cover">{source ? <img src={source} alt={`${title} 封面`} /> : <Layers3 size={20} />}</div>;
}

export function ImageDetailPage() {
  const { id } = useParams<{ id: string }>();
  const modelDisplayMap = useDrawingModelDisplayMap();
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [likePending, setLikePending] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [selectedImageId, setSelectedImageId] = useState<string>('');
  const [actualImageSize, setActualImageSize] = useState<string | null>(null);
  const [authorAvatarFailed, setAuthorAvatarFailed] = useState(false);
  const [ownerActionPending, setOwnerActionPending] = useState(false);
  const [ownerConfirmAction, setOwnerConfirmAction] = useState<ImageDetailConfirmAction | null>(null);
  const [liveLoras, setLiveLoras] = useState<GalleryLocalModelLoraMetadataView[]>([]);
  const navigate = useNavigate();

  /** 返回上一级；无历史时回退到图库 */
  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/gallery');
  };

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setImgError(false);
    setActualImageSize(null);
    setAuthorAvatarFailed(false);
    api<Detail>(`/api/images/${id}/detail`).then(d => {
      if (d.ok && d.data) {
        const detail = d.data;
        setData(detail);
        const selected = detail.images.find((image) => image.id === detail.selectedImageId) ?? detail.images[0];
        setSelectedImageId(selected?.id ?? detail.taskId);
        setLiked(selected?.liked ?? detail.liked);
        setLikeCount(selected?.likeCount ?? detail.likeCount);
      }
      setLoading(false);
    });
    api<{ recorded: boolean; viewCount: number }>(`/api/images/${id}/view`, { method: 'POST' }).then(result => {
      if (!result.ok || !result.data) return;
      setData(prev => prev ? updateDetailImage(prev, prev.selectedImageId || prev.taskId, { viewCount: result.data!.viewCount }) : prev);
    });
  }, [id]);

  const finalImages = data?.images?.length ? data.images : data ? [{
    id: data.taskId,
    imageUrl: data.imageUrl,
    thumbnailUrl: data.thumbnailUrl,
    mediaType: data.mediaType,
    videoUrl: data.videoUrl,
    duration: data.duration,
    resolution: data.resolution,
    aspectRatio: data.aspectRatio,
    likeCount: data.likeCount,
    viewCount: data.viewCount,
    liked: data.liked,
    model: data.model ?? null,
    siteName: data.siteName ?? null,
    size: data.size ?? null,
    quality: data.quality ?? null,
    latencyMs: data.latencyMs ?? null,
    tags: data.tags,
  } satisfies GalleryImageAssetView] : [];
  const currentImage = finalImages.find((image) => image.id === selectedImageId) ?? finalImages[0];
  const currentImageIndex = Math.max(0, finalImages.findIndex((image) => image.id === currentImage?.id));
  const localModelTaskId = data?.localModel ? data.taskId : '';
  const liveLoraByVersionId = useMemo(() => new Map(liveLoras.map((lora) => [lora.loraVersionId, lora])), [liveLoras]);

  useEffect(() => {
    setLiveLoras([]);
    if (!localModelTaskId) return;
    let active = true;
    const refresh = () => {
      void api<{ loras: GalleryLocalModelLoraMetadataView[]; negativePrompt: string | null }>(`/api/images/${localModelTaskId}/loras`, { cache: 'no-store' }).then((result) => {
        if (!active || !result.ok || !result.data) return;
        setLiveLoras(result.data.loras);
        // 历史本地模型作品通过独立平台实时元数据补齐负面提示词，新快照已有值时保持主站权威值。
        setData((previous) => previous
          ? { ...previous, negativePrompt: previous.negativePrompt || result.data!.negativePrompt }
          : previous);
      });
    };
    refresh();
    // 页面停留期间定时刷新并在重新聚焦时立即同步，LoRA 改名后无需重载图库详情。
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [localModelTaskId]);

  /** 切换批次内最终图时同步互动数据，并记录当前单图浏览。 */
  const selectFinalImage = useCallback((image: GalleryImageAssetView) => {
    if (!image.id || image.id === selectedImageId) return;
    setSelectedImageId(image.id);
    setLiked(image.liked);
    setLikeCount(image.likeCount);
    setImgError(false);
    setActualImageSize(image.size ?? null);
    void api<{ recorded: boolean; viewCount: number }>(`/api/images/${image.id}/view`, { method: 'POST' }).then(result => {
      if (!result.ok || !result.data) return;
      setData(prev => prev ? updateDetailImage(prev, image.id, { viewCount: result.data!.viewCount }) : prev);
    });
  }, [selectedImageId]);

  /** 主图左右按钮用于在同一批次的最终生成图之间循环切换，并复用单图浏览记录链路。 */
  const stepFinalImage = useCallback((direction: -1 | 1) => {
    if (finalImages.length <= 1) return;
    const nextIndex = (currentImageIndex + direction + finalImages.length) % finalImages.length;
    const nextImage = finalImages[nextIndex];
    if (nextImage) selectFinalImage(nextImage);
  }, [currentImageIndex, finalImages, selectFinalImage]);

  /** 点赞/取消点赞 */
  const toggleLike = useCallback(async () => {
    if (!currentImage?.id || likePending) return;
    setLikePending(true);
    const method = liked ? 'DELETE' : 'POST';
    const d = await api<{ liked: boolean; likeCount: number }>(`/api/images/${currentImage.id}/like`, { method });
    if (d.ok && d.data) {
      setLiked(d.data.liked);
      setLikeCount(d.data.likeCount);
      setData(prev => prev ? updateDetailImage(prev, currentImage.id, { liked: d.data!.liked, likeCount: d.data!.likeCount }) : prev);
    }
    setLikePending(false);
  }, [currentImage?.id, liked, likePending]);

  /** 下载当前图片或视频原文件。 */
  const handleDownload = useCallback(async () => {
    const mediaUrl = currentImage?.videoUrl || currentImage?.imageUrl;
    if (!mediaUrl) return;
    try {
      const res = await fetch(currentImage?.videoUrl ? resolvePlayableVideoUrl(mediaUrl) : resolveMediaUrl(mediaUrl));
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentImage.id}.${currentImage?.videoUrl ? 'mp4' : 'png'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch { /* 下载失败静默忽略 */ }
  }, [currentImage]);

  /** 执行图片所有者已经二次确认的操作，后端仍会再次校验所有权。 */
  const runOwnerConfirmAction = useCallback(async () => {
    if (!ownerConfirmAction || ownerActionPending) return;
    setOwnerActionPending(true);
    try {
      await ownerConfirmAction.run();
      setOwnerConfirmAction(null);
    } finally {
      setOwnerActionPending(false);
    }
  }, [ownerConfirmAction, ownerActionPending]);

  /** 当前用户管理自己的图片：二次确认后切换隐私，最终权限仍由后端校验。 */
  const togglePrivacy = useCallback(() => {
    if (!data || !currentImage?.id || ownerActionPending) return;
    const nextPrivate = !data.isPrivate;
    const mediaLabel = currentImage.videoUrl ? '视频' : '图片';
    const mediaObject = currentImage.videoUrl ? '这段视频' : '这张图片';
    setOwnerConfirmAction({
      title: nextPrivate ? `设为私密${mediaLabel}` : `设为公开${mediaLabel}`,
      message: nextPrivate
        ? `设为私密后，其他用户将无法在公开图库或详情页查看${mediaObject}。`
        : `设为公开后，${mediaObject}会重新进入公开可见范围，其他用户可以浏览详情。`,
      confirmLabel: nextPrivate ? '确认私密' : '确认公开',
      tone: nextPrivate ? 'warning' : 'default',
      run: async () => {
        const result = await api('/api/generations/privacy', {
          method: 'PATCH',
          body: JSON.stringify({ ids: [currentImage.id], isPrivate: nextPrivate }),
        });
        if (result.ok) setData(prev => prev ? { ...prev, isPrivate: nextPrivate } : prev);
      },
    });
  }, [currentImage?.id, currentImage?.videoUrl, data?.isPrivate, ownerActionPending]);

  /** 删除自己的图片会删除对应生成记录；二次确认和后端所有权校验都通过后再返回上一页。 */
  const deleteImage = useCallback(() => {
    if (!currentImage?.id || ownerActionPending) return;
    const mediaLabel = currentImage.videoUrl ? '视频' : '图片';
    const mediaObject = currentImage.videoUrl ? '这段视频' : '这张图片';
    setOwnerConfirmAction({
      title: `删除${mediaLabel}`,
      message: `确认删除${mediaObject}？删除后对应生成记录也会移除，此操作不可恢复。`,
      confirmLabel: '确认删除',
      tone: 'danger',
      run: async () => {
        const result = await api('/api/generations', {
          method: 'DELETE',
          body: JSON.stringify({ ids: [currentImage.id] }),
        });
        if (result.ok) goBack();
      },
    });
  }, [currentImage?.id, currentImage?.videoUrl, ownerActionPending]);

  /* ====== 预览列表（必须在所有 return 前，保持 hooks 顺序） ====== */
  // 本地模型作品的输入资产语义是 LoRA，详情灯箱不再混入普通参考图列表。
  const refSrcs = data?.localModel ? [] : (data?.sourceImageUrls || []).map(resolveMediaUrl);
  const finalPreviewImages = finalImages.filter((image) => image.mediaType !== 'video' && image.imageUrl);
  const finalPreviewSrcs = finalPreviewImages.map((image) => resolveMediaUrl(image.imageUrl)).filter(Boolean);
  const allPreviews = [...finalPreviewSrcs, ...refSrcs].filter(Boolean);

  /* ====== 加载骨架 ====== */
  if (loading) return (
    <div className="animate-fade-in">
      <div className="skeleton mb-4" style={{ width: 80, height: 20 }} />
      <div className="flex flex-col lg:flex-row gap-5">
        <div className="flex-1"><div className="skeleton" style={{ aspectRatio: '1', maxHeight: '75vh', width: '100%' }} /></div>
        <div className="lg:w-[340px] flex flex-col gap-4">
          <div className="card"><div className="skeleton h-6 w-12 mb-2" /><div className="skeleton h-14 mb-3" /><div className="grid grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i}><div className="skeleton h-2.5 w-8 mb-1.5" /><div className="skeleton h-3.5 w-16" /></div>)}</div></div>
          <div className="card"><div className="skeleton h-10" /></div>
          <div className="skeleton h-4 w-36" />
        </div>
      </div>
    </div>
  );

  /* ====== 空/错误 ====== */
  if (!data) return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-text-2">
      <AlertTriangle size={32} />
      <span className="text-sm">作品不存在或已删除</span>
      <button onClick={goBack} className="btn btn-outline btn-sm mt-2">返回上一级</button>
    </div>
  );

  const authorSource = normalizeAuthorSource(data.authorSource ?? data.source);
  const authorName = data.authorName || data.username || (data.qqNumber ? `QQ ${data.qqNumber}` : '未知作者');
  const authorInitial = getAuthorInitial(authorName);
  const authorAvatarSource = data.authorAvatarSource ?? (data.authorAvatarUrl?.includes('q.qlogo.cn') ? 'qq' : data.authorAvatarUrl ? 'web' : 'initial');
  const isLocalModelDetail = Boolean(data.localModel);
  const currentModel = data.localModel?.modelDisplayName || formatDrawingModelNameByMap(currentImage?.model ?? data.model, modelDisplayMap);
  const currentSiteName = currentImage?.siteName ?? data.siteName;
  const currentLatencyMs = currentImage?.latencyMs ?? data.latencyMs;
  const currentViewCount = currentImage?.viewCount ?? data.viewCount;
  const currentTags = currentImage?.tags?.length ? currentImage.tags : data.tags;
  const isVideoDetail = currentImage?.mediaType === 'video' && Boolean(currentImage.videoUrl);
  const isUpscaleDetail = isImageUpscaleDetail(data);
  const referenceTitle = isUpscaleDetail ? '放大前原图' : '参考图';

  /* ====== 正常内容 ====== */
  return (
    <div className="animate-fade-in">
      {/* 返回链接 — 回到上一级页面 */}
      <button onClick={goBack} className="inline-flex items-center gap-1 text-sm text-text-2 hover:text-text mb-4" style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>
        <ArrowLeft size={14} />返回上一级
      </button>

      <div className="flex flex-col lg:flex-row gap-5">
        {/* ====== 左侧：图片展示区 ====== */}
        <div className="flex-1 flex flex-col gap-3">
          {/* 主图 — 缩略图懒加载，原图就绪后切换 */}
          <div className={`card image-detail-main-card overflow-hidden flex items-center justify-center${isVideoDetail ? '' : ' cursor-zoom-in'}`}
            style={{ padding: 0, background: '#e8eaef' }}
            onClick={() => { if (!isVideoDetail && currentImage?.imageUrl) { setPreviewIdx(currentImageIndex); setPreviewOpen(true); } }}>
            {isVideoDetail && currentImage?.videoUrl ? (
              <video
                key={currentImage.id}
                className="image-detail-main-video"
                src={resolvePlayableVideoUrl(currentImage.videoUrl)}
                controls
                playsInline
                preload="metadata"
                onClick={(event) => event.stopPropagation()}
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  if (video.videoWidth > 0 && video.videoHeight > 0) setActualImageSize(`${video.videoWidth}X${video.videoHeight}`);
                }}
              />
            ) : !imgError && currentImage?.imageUrl ? (
              <FullImage
                key={currentImage.id}
                src={resolveMediaUrl(currentImage.imageUrl)}
                thumb={resolveMediaUrl(currentImage.thumbnailUrl || currentImage.imageUrl)}
                alt={data.prompt}
                onNaturalSize={setActualImageSize}
                onError={() => setImgError(true)}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 py-24 text-text-2">
                {imgError ? <AlertTriangle size={40} /> : <Image size={40} />}
                <span className="text-sm">{imgError ? '图片加载失败' : '暂无图片'}</span>
              </div>
            )}
            {finalImages.length > 1 && (
              <>
                <button
                  type="button"
                  className="image-detail-nav-button is-prev"
                  onClick={(event) => { event.stopPropagation(); stepFinalImage(-1); }}
                  aria-label="上一个最终结果"
                  title="上一个最终结果"
                >
                  <ChevronLeft size={22} />
                </button>
                <button
                  type="button"
                  className="image-detail-nav-button is-next"
                  onClick={(event) => { event.stopPropagation(); stepFinalImage(1); }}
                  aria-label="下一个最终结果"
                  title="下一个最终结果"
                >
                  <ChevronRight size={22} />
                </button>
              </>
            )}
          </div>

          {/* 批次最终结果：图片和视频都在详情页聚合展示，缩略图用于快速切换。 */}
          {finalImages.length > 1 && (
            <div className="image-final-strip" aria-label="批次最终结果">
              <div className="image-final-strip-head">
                <span>最终结果</span>
                <strong>{currentImageIndex + 1} / {finalImages.length}</strong>
              </div>
              <div className="image-final-strip-grid">
                {finalImages.map((image, index) => (
                  <button
                    key={image.id}
                    type="button"
                    className={`image-final-thumb${image.id === currentImage?.id ? ' is-active' : ''}`}
                    onClick={() => selectFinalImage(image)}
                    title={`最终结果 ${index + 1}`}
                  >
                    {image.mediaType === 'video' && image.videoUrl
                      ? <ViewportVideoPreview src={image.videoUrl} posterSrc={image.thumbnailUrl || image.imageUrl} priority={index < 4} />
                      : <img src={resolveMediaUrl(image.thumbnailUrl || image.imageUrl)} alt="" loading={index < 4 ? 'eager' : 'lazy'} decoding="async" />}
                    <span>{index + 1}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 本地模型作品展示任务固化的 LoRA 列表，普通作品继续展示真实参考图。 */}
          {data.localModel ? (
            <div className="card image-local-lora-card">
              <div className="image-local-lora-head">
                <h3 className="card-title flex items-center gap-1.5">
                  <Layers3 size={14} />使用的 LoRA
                </h3>
                <span>{data.localModel.loras.length} 个</span>
              </div>
              {data.localModel.loras.length > 0 ? (
                <div className="image-local-lora-list">
                  {data.localModel.loras.map((lora) => {
                    const liveLora = liveLoraByVersionId.get(lora.loraVersionId);
                    const currentTitle = liveLora?.title || lora.title;
                    const currentType = liveLora?.type || lora.type;
                    return (
                      <a key={lora.loraVersionId} href={lora.detailUrl} className="image-local-lora-item" title={`打开 ${currentTitle} 的 LoRA 详情`}>
                        <LocalModelLoraCover coverUrl={lora.coverUrl} title={currentTitle} />
                        <div className="image-local-lora-overlay">
                          <div className="image-local-lora-meta">
                            <span className={`image-local-lora-type is-${currentType}`}>{formatLocalModelLoraType(currentType)}</span>
                            <span className="image-local-lora-strength">权重 <strong>{formatLocalModelLoraStrength(lora.strength)}</strong></span>
                          </div>
                          <strong className="image-local-lora-title" title={currentTitle}>{currentTitle}</strong>
                        </div>
                      </a>
                    );
                  })}
                </div>
              ) : (
                <div className="image-local-lora-empty">该任务未使用 LoRA</div>
              )}
            </div>
          ) : data.sourceImageUrls && data.sourceImageUrls.length > 0 && (
            <div className={`card image-reference-card${isUpscaleDetail ? ' is-upscale' : ''}`}>
              <h3 className="card-title flex items-center gap-1.5 mb-3">
                <Image size={14} />{referenceTitle}
                <span className="text-xs text-text-2 font-normal">· {data.sourceImageUrls.length} 张</span>
              </h3>
              {isUpscaleDetail && currentImage ? (
                <>
                  {/* 图片放大详情优先展示放大前原图和放大后结果，避免用户只看到最终图而找不到原始输入。 */}
                  <div className="image-upscale-compare">
                    <button
                      type="button"
                      className="image-upscale-compare-panel is-before"
                      onClick={() => { setPreviewIdx(finalPreviewImages.length); setPreviewOpen(true); }}
                      title="查看放大前原图"
                    >
                      <img src={resolveMediaUrl(data.sourceImageUrls[0])} alt="放大前原图" loading="eager" decoding="async" />
                      <span>放大前</span>
                    </button>
                    <button
                      type="button"
                      className="image-upscale-compare-panel is-after"
                      onClick={() => { setPreviewIdx(currentImageIndex); setPreviewOpen(true); }}
                      title="查看放大后结果"
                    >
                      <img src={resolveMediaUrl(currentImage.thumbnailUrl || currentImage.imageUrl)} alt="放大后结果" loading="eager" decoding="async" />
                      <span>放大后</span>
                    </button>
                  </div>
                  {data.sourceImageUrls.length > 1 && (
                    <div className="image-reference-extra-grid">
                      {data.sourceImageUrls.slice(1).map((url, i) => {
                        const refIndex = i + 1;
                        const displayUrl = resolveMediaUrl(url);
                        return (
                          <button key={url} type="button" onClick={() => { setPreviewIdx(finalPreviewImages.length + refIndex); setPreviewOpen(true); }}
                            className="image-reference-thumb"
                            title={`查看放大前原图 ${refIndex + 1}`}>
                            <img src={displayUrl} alt={`放大前原图 ${refIndex + 1}`} loading="lazy" decoding="async"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            <span>#{refIndex + 1}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {data.sourceImageUrls.map((url, i) => {
                    const displayUrl = resolveMediaUrl(url);
                    return (
                      <button key={i} onClick={() => { setPreviewIdx(finalPreviewImages.length + i); setPreviewOpen(true); }}
                        className="block aspect-square rounded-lg border border-border bg-bg overflow-hidden relative group cursor-zoom-in"
                        style={{ padding: 0, border: 'none', appearance: 'none', background: 'transparent' }}
                        title={`参考图 ${i + 1} — 点击查看大图`}>
                        <img src={displayUrl} alt={`参考图 ${i + 1}`} loading={i < 2 ? 'eager' : 'lazy'} decoding="async" fetchPriority="auto"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        <span className="absolute bottom-1 left-1 text-white text-[10px] font-bold px-1.5 py-0.5 rounded"
                          style={{ background: 'rgba(0,0,0,0.6)' }}>#{i + 1}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ====== 右侧：信息面板 ====== */}
        <div className="lg:w-[340px] flex flex-col gap-4">
          {/* 正面和负面提示词复用同一卡片交互，负面提示词仅在用户实际填写后展示。 */}
          <ImagePromptCard label="提示词" modalTitle="完整提示词" copyLabel="复制提示词" value={data.prompt} />
          {data.negativePrompt?.trim() && (
            <ImagePromptCard label="负面提示词" modalTitle="完整负面提示词" copyLabel="复制负面提示词" value={data.negativePrompt} />
          )}

          {/* 作者信息 */}
          <div className="card image-author-card">
            <div className={`image-author-avatar is-${authorSource} is-avatar-${authorAvatarSource}`}>
              {data.authorAvatarUrl && !authorAvatarFailed && (
                <img
                  src={resolveMediaUrl(data.authorAvatarUrl)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  onError={() => setAuthorAvatarFailed(true)}
                />
              )}
              <span>{authorInitial}</span>
            </div>
            <div className="image-author-body">
              <span className="image-author-label">作者</span>
              {data.userId ? (
                <Link to={`/users/${data.userId}`} className={`image-author-name is-${authorSource}`} title={authorName}>{authorName}</Link>
              ) : (
                <strong className={`image-author-name is-${authorSource}`} title={authorName}>{authorName}</strong>
              )}
            </div>
          </div>

          {/* 作品信息 */}
          <div className="card">
            <h3 className="card-title flex items-center gap-1.5 mb-3">
              <Info size={14} />作品信息
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div><span className="text-[11px] text-text-2">模型</span><div className="text-xs font-medium mt-0.5">{currentModel || '-'}</div></div>
              <div><span className="text-[11px] text-text-2">尺寸</span><div className="text-xs font-medium mt-0.5">{actualImageSize || '读取中'}</div></div>
              {!isLocalModelDetail && <div><span className="text-[11px] text-text-2">站点</span><div className="text-xs font-medium mt-0.5">{currentSiteName || '-'}</div></div>}
              <div><span className="text-[11px] text-text-2">来源</span><div className="text-xs font-medium mt-0.5">{formatGenerationSource(data.source)}</div></div>
              {!isLocalModelDetail && <div><span className="text-[11px] text-text-2">模式</span><div className="text-xs font-medium mt-0.5">{formatGenerationMode(data.mode)}</div></div>}
              {isVideoDetail && <div><span className="text-[11px] text-text-2">视频规格</span><div className="text-xs font-medium mt-0.5">{currentImage?.resolution ?? '-'} · {currentImage?.duration ?? '-'} 秒 · {currentImage?.aspectRatio ?? '-'}</div></div>}
              <div><span className="text-[11px] text-text-2">隐私</span><div className="text-xs font-medium mt-0.5">{data.isPrivate ? '私密' : '公开'}</div></div>
              {currentLatencyMs != null && <div><span className="text-[11px] text-text-2">耗时</span><div className="text-xs font-medium mt-0.5">{currentLatencyMs >= 1000 ? `${(currentLatencyMs / 1000).toFixed(1)}s` : `${currentLatencyMs}ms`}</div></div>}
              <div><span className="text-[11px] text-text-2">ID</span><div className="text-xs font-medium mt-0.5 font-mono truncate" title={currentImage?.id ?? data.taskId}>{(currentImage?.id ?? data.taskId).slice(-16)}</div></div>
              <div><span className="text-[11px] text-text-2">创建时间</span><div className="text-xs font-medium mt-0.5">{data.createdAt?.slice(0, 19).replace('T', ' ')}</div></div>
              <div><span className="text-[11px] text-text-2">{isLocalModelDetail ? 'LoRA 数量' : '参考图'}</span><div className="text-xs font-medium mt-0.5">{isLocalModelDetail ? `${data.localModel?.loras.length ?? 0} 个` : `${data.sourceImageUrls?.length || 0} 张`}</div></div>
              <div><span className="text-[11px] text-text-2">最终结果</span><div className="text-xs font-medium mt-0.5">{finalImages.length} 个</div></div>
            </div>
          </div>

          {currentTags && currentTags.length > 0 && (
            <div className="card image-detail-tags-card">
              <h3 className="card-title flex items-center gap-1.5 mb-3">
                <Tags size={14} />标签
              </h3>
              <GalleryTags tags={currentTags} size="normal" />
            </div>
          )}

          {/* 互动操作 */}
          <div className="card">
            <div className="flex items-center gap-3">
              <button
                onClick={toggleLike}
                disabled={likePending}
                className="btn btn-outline btn-sm flex items-center gap-1.5 flex-1"
              >
                <Heart
                  size={14}
                  className={liked ? 'text-error' : 'text-text-2'}
                  fill={liked ? 'currentColor' : 'none'}
                  style={{ transition: 'color .15s, fill .15s' }}
                />
                <span className="font-medium">{likeCount}</span>
              </button>
              <button
                onClick={handleDownload}
                className="btn btn-sm flex items-center gap-1.5 flex-1"
              >
                <Download size={14} />{isVideoDetail ? '下载视频' : '下载原图'}
              </button>
            </div>
            {data.canManage && (
              <div className="image-owner-actions">
                <button
                  onClick={togglePrivacy}
                  disabled={ownerActionPending}
                  className="btn btn-outline btn-sm flex items-center gap-1.5 flex-1"
                >
                  {data.isPrivate ? <Unlock size={14} /> : <Lock size={14} />}
                  {data.isPrivate ? '设为公开' : '设为私密'}
                </button>
                <button
                  onClick={deleteImage}
                  disabled={ownerActionPending}
                  className="btn btn-danger btn-sm flex items-center gap-1.5 flex-1"
                >
                  <Trash2 size={14} />删除{isVideoDetail ? '视频' : '图片'}
                </button>
              </div>
            )}
            <div className="flex items-center gap-1.5 mt-3 text-xs text-text-2">
              <Eye size={13} />
              <span>{currentViewCount} 次浏览</span>
            </div>
          </div>

        </div>
      </div>

      {/* ====== 同期作品 ====== */}
      {data.siblings && data.siblings.length > 0 && (
        <div className="mt-6">
          <h3 className="card-title flex items-center gap-1.5 mb-3">
            <Image size={14} />同期作品
            <span className="text-xs text-text-2 font-normal">· {data.siblings.length} 张</span>
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {data.siblings.map((s, index) => (
              <Link
                key={s.id}
                to={`/image/${s.id}`}
                className="card-interactive card overflow-hidden block no-underline"
                style={{ padding: 0 }}
              >
                <div className="aspect-square overflow-hidden bg-bg flex items-center justify-center">
                  {s.mediaType === 'video' && s.videoUrl ? (
                    <ViewportVideoPreview src={s.videoUrl} posterSrc={s.thumbnailUrl || s.imageUrl} priority={index < 4} className="w-full h-full object-cover" />
                  ) : (s.thumbnailUrl || s.imageUrl) ? (
                    <img
                      src={resolveMediaUrl(s.thumbnailUrl || s.imageUrl)}
                      alt=""
                      className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                      loading={index < 4 ? 'eager' : 'lazy'}
                      decoding="async"
                      fetchPriority="auto"
                    />
                  ) : (
                    <Image size={20} className="text-text-2" />
                  )}
                </div>
                <div className="p-2">
                  <div className="text-[11px] text-text-2 line-clamp-1">{s.prompt.slice(0, 40)}</div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ====== 图片预览弹窗（与图库子页面共用同一套灯箱） ====== */}
      <ImageLightbox
        open={previewOpen && allPreviews.length > 0}
        images={allPreviews.map((src, index) => {
          const final = finalPreviewImages[index];
          const refIndex = index - finalPreviewImages.length + 1;
          return {
            src,
            title: final ? `生成图片 ${index + 1} / ${finalImages.length}` : `${isUpscaleDetail ? '放大前原图' : '参考图'} ${refIndex} / ${refSrcs.length}`,
            downloadName: final ? `${final.id}.png` : `ref_${refIndex}.png`,
            alt: final ? data.prompt : `${isUpscaleDetail ? '放大前原图' : '参考图'} ${refIndex}`,
          };
        })}
        index={previewIdx}
        onIndexChange={setPreviewIdx}
        onClose={() => setPreviewOpen(false)}
      />
      <ConfirmDialog
        open={Boolean(ownerConfirmAction)}
        title={ownerConfirmAction?.title ?? ''}
        message={ownerConfirmAction?.message}
        confirmLabel={ownerConfirmAction?.confirmLabel ?? '确认'}
        tone={ownerConfirmAction?.tone}
        pending={ownerActionPending}
        onConfirm={runOwnerConfirmAction}
        onCancel={() => { if (!ownerActionPending) setOwnerConfirmAction(null); }}
      />
    </div>
  );
}

/** 识别图片放大详情；仅使用现有详情字段，避免为了展示新增接口字段。 */
function isImageUpscaleDetail(detail: Pick<Detail, 'mode' | 'prompt' | 'model'>): boolean {
  if (detail.mode !== 'image-to-image') return false;
  const text = `${detail.prompt ?? ''} ${detail.model ?? ''}`.toLowerCase();
  return text.includes('图片放大') || text.includes('image-upscale') || text.includes('upscale') || text.includes('realesrgan');
}

/** 规范化作者来源，避免后端历史值污染 CSS class。 */
function normalizeAuthorSource(source?: string | null): 'web' | 'bot' | 'api' | 'other' {
  if (source === 'web' || source === 'bot' || source === 'api') return source;
  return 'other';
}

/** 生产已关闭 workflow，历史来源值统一作为其他来源展示，不在界面暴露已下线名称。 */
function formatGenerationSource(source?: string | null): string {
  if (source === 'bot') return 'QQ Bot';
  if (source === 'api') return 'API';
  if (source === 'web') return 'Web';
  return '其他';
}

/** 把图片与视频任务模式转换为统一中文展示。 */
function formatGenerationMode(mode?: string | null): string {
  if (mode === 'image-to-image') return '图生图';
  if (mode === 'text-to-image') return '文生图';
  if (mode === 'image-to-video') return '参考图视频';
  if (mode === 'text-to-video') return '文生视频';
  return mode || '-';
}

/** 作者头像首字符兜底，支持中文昵称。 */
function getAuthorInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? 'U').toUpperCase();
}

/** 更新详情页某张最终图的互动状态，同时保持顶层选中图字段兼容旧展示逻辑。 */
function updateDetailImage(detail: Detail, imageId: string, patch: Partial<GalleryImageAssetView>): Detail {
  const images = detail.images.map((image) => image.id === imageId ? { ...image, ...patch } : image);
  const selected = images.find((image) => image.id === imageId);
  return {
    ...detail,
    images,
    ...(selected && (detail.selectedImageId === imageId || detail.taskId === imageId)
      ? {
          taskId: selected.id,
          imageUrl: selected.imageUrl,
          thumbnailUrl: selected.thumbnailUrl,
          mediaType: selected.mediaType,
          videoUrl: selected.videoUrl,
          duration: selected.duration,
          resolution: selected.resolution,
          aspectRatio: selected.aspectRatio,
          likeCount: selected.likeCount,
          viewCount: selected.viewCount,
          liked: selected.liked,
          tags: selected.tags ?? detail.tags,
        }
      : {}),
  };
}
