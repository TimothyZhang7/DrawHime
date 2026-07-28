/** 个人中心页面：展示我的图片、生成记录、分页选择器和任务详情弹窗。 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Routes, Route, NavLink, Navigate, Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  ExternalLink,
  Hash,
  Image,
  List,
  Loader2,
  Lock,
  Trash2,
  Unlock,
  X,
  Video,
} from 'lucide-react';
import { api } from '../../lib/api';
import type { GalleryBulkDownloadResponse } from '@aiimage/shared-contracts';
import { ConfirmDialog, type ConfirmDialogTone } from '../../components/common/ConfirmDialog';
import { config } from '../../lib/config';
import { resolveMediaUrl, resolvePlayableVideoUrl } from '../../lib/media';
import { formatDrawingModelNameByMap, useDrawingModelDisplayMap } from '../../lib/drawingModelDisplay';
import { SubTaskTimeline, isRealUpstreamAttempt, type SubTaskTimelineItem } from './SubTaskTimeline';
import { PrivacyPreferencePanel } from './PrivacyPreferencePanel';
import { ViewportVideoPreview } from '../../components/media/ViewportVideoPreview';
import './PersonalPage.css';

const PERSONAL_GALLERY_PAGE_SIZE = 36;
const PERSONAL_RECORD_PAGE_SIZE = 20;
/** 个人图片页当前页缩略图全部立即排队，前 12 张提高优先级。 */
const PERSONAL_IMAGE_HIGH_PRIORITY_COUNT = 12;
/** 生成记录页只提升前几张缩略图，避免记录列表文字交互被图片请求拖慢。 */
const PERSONAL_RECORD_HIGH_PRIORITY_COUNT = 6;

type GenItem = {
  id: string;
  clientRequestId?: string;
  batchId?: string;
  batchIndex?: number;
  batchTotal?: number;
  prompt: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  mediaType?: 'image' | 'video';
  videoUrl?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  status: string;
  source?: string;
  mode: string;
  model?: string;
  siteName?: string;
  qqNumber?: string;
  userId?: number;
  isPrivate: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  error?: string;
  sourceImageUrls?: string[];
  subTasks?: SubTaskTimelineItem[];
  chargedSource?: string;
  chargedAmount?: string;
  chargedFreeAmount?: string;
  chargedPaidAmount?: string;
};

type GenerationListPayload = {
  items: GenItem[];
  total: number;
  page?: number;
  pageSize?: number;
};

/** 个人图片页的待确认动作；保存文案和真实执行函数，确认后才会调用后端接口。 */
type PersonalConfirmAction = {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  tone: ConfirmDialogTone;
  run: () => Promise<void>;
};

const STATUS_LABELS: Record<string, string> = {
  success: '成功',
  failed: '失败',
  running: '生成中',
  finalizing: '收尾中',
  queued: '等待中',
  skipped: '已跳过',
};

const MODE_LABELS: Record<string, string> = {
  'text-to-image': '文生图',
  'image-to-image': '图生图',
  'text-to-video': '文生视频',
  'image-to-video': '参考图视频',
};

const SOURCE_LABELS: Record<string, string> = {
  web: '网页',
  bot: 'Bot',
  api: 'API',
};

function labelOf(map: Record<string, string>, value?: string) {
  return value ? map[value] ?? value : '-';
}

function statusClass(status: string) {
  if (status === 'success') return 'is-success';
  if (status === 'failed') return 'is-error';
  if (status === 'running' || status === 'finalizing') return 'is-active';
  return 'is-muted';
}

/** 外显入口统一使用批次 ID；单张图和批次都应按外显实体进行管理操作。 */
function getVisibleImageEntryId(item: Pick<GenItem, 'id' | 'batchId' | 'batchTotal'>) {
  return item.batchId && (item.batchTotal ?? 1) > 1 ? item.batchId : item.id;
}

/** 个人图片页的批量操作入口；多图批次必须按外显批次 ID 操作，单图仍按真实任务 ID 操作。 */
function getPersonalGalleryActionId(item: Pick<GenItem, 'id' | 'batchId' | 'batchTotal'>) {
  return getVisibleImageEntryId(item);
}

/** 按批次展开后的任务视图，前端只负责切换展示，不再自己拼接单图详情。 */
type TaskBatchDetail = {
  tasks: GenItem[];
  selectedTaskId: string;
};

/** 任务详情页优先展示的任务顺序：按批次内序号，其次按创建时间兜底。 */
function sortDetailTasks(tasks: GenItem[]): GenItem[] {
  return [...tasks].sort((left, right) => {
    const leftIndex = left.batchIndex ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = right.batchIndex ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

/** 生成详情页的批次摘要，保证 n>1 时用户能看见整批真实链路。 */
function buildTaskBatchSummary(tasks: GenItem[]) {
  const total = tasks.length;
  const successCount = tasks.filter((item) => item.status === 'success').length;
  const failedCount = tasks.filter((item) => item.status === 'failed').length;
  const activeCount = tasks.filter((item) => item.status === 'queued' || item.status === 'running' || item.status === 'finalizing').length;
  return { total, successCount, failedCount, activeCount };
}

/** 拉取批次真实任务明细；批次入口会展开为整批单图，单图入口则退化成单任务。 */
async function loadTaskBatch(task: GenItem): Promise<TaskBatchDetail | null> {
  const d = await api<{ tasks: GenItem[] }>(`/api/generations/tasks?ids=${encodeURIComponent(getVisibleImageEntryId(task))}`);
  if (!d.ok || !d.data?.tasks?.length) return null;
  const tasks = sortDetailTasks(d.data.tasks);
  return {
    tasks,
    selectedTaskId: pickPreferredDetailTaskId(tasks),
  };
}

/** 任务详情默认选中最新成功图；若没有成功图，则回退到第一张真实任务。 */
function pickPreferredDetailTaskId(tasks: GenItem[]): string {
  const latestSuccess = [...tasks].reverse().find((item) => item.status === 'success' && (item.imageUrl || item.thumbnailUrl || item.videoUrl));
  return latestSuccess?.id ?? tasks[0]?.id ?? '';
}

/** 任务详情主任务对象取当前选中项，避免 n>1 时只展示首图。 */
function getSelectedDetailTask(batch: TaskBatchDetail | null): GenItem | null {
  if (!batch) return null;
  return batch.tasks.find((item) => item.id === batch.selectedTaskId) ?? batch.tasks[0] ?? null;
}

function formatDateTime(value?: string) {
  if (!value) return '-';
  return value.slice(0, 19).replace('T', ' ');
}

function formatDuration(ms?: number) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function buildQuickPages(page: number, totalPages: number): number[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  let start = page - 3;
  let end = page + 3;
  if (start < 1) {
    end += 1 - start;
    start = 1;
  }
  if (end > totalPages) {
    start -= end - totalPages;
    end = totalPages;
  }
  return Array.from({ length: Math.max(1, end - Math.max(1, start) + 1) }, (_, i) => Math.max(1, start) + i);
}

function usePageParam() {
  const [params, setParams] = useSearchParams();
  const rawPage = Number(params.get('page') ?? '1');
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  /** 分页状态写入 URL，用户刷新或复制链接时仍能回到当前页。 */
  const setPage = useCallback((nextPage: number) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (nextPage <= 1) next.delete('page');
      else next.set('page', String(nextPage));
      return next;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [setParams]);

  return [page, setPage] as const;
}

export function PersonalPage() {
  const location = useLocation();
  const [galleryBatchMode, setGalleryBatchMode] = useState(false);
  const isGalleryRoute = location.pathname.includes('/personal/gallery');

  useEffect(() => {
    if (!isGalleryRoute) setGalleryBatchMode(false);
  }, [isGalleryRoute]);

  return (
    <div className="personal-page animate-fade-in">
      <h1 className="page-title mb-5 flex items-center gap-2"><Image size={20} />我的内容</h1>
      <PrivacyPreferencePanel />
      <div className="personal-tabs-row">
        <div className="personal-tabs">
          <NavLink to="/personal/gallery" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>我的图片</NavLink>
          <NavLink to="/personal/generations" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>生成记录</NavLink>
        </div>
        {isGalleryRoute && (
          <button
            type="button"
            className={`personal-batch-mode-button ${galleryBatchMode ? 'is-active' : ''}`}
            onClick={() => setGalleryBatchMode(value => !value)}
          >
            {galleryBatchMode ? <X size={13} /> : <Check size={13} />}
            {galleryBatchMode ? '退出批量' : '批量操作'}
          </button>
        )}
      </div>
      <Routes>
        <Route path="gallery" element={<PersonalGallery batchMode={galleryBatchMode} onBatchModeChange={setGalleryBatchMode} />} />
        <Route path="generations" element={<PersonalGenerations />} />
        <Route path="generations/:taskId" element={<PersonalGenerationDetailPage />} />
        <Route path="*" element={<Navigate to="/personal/gallery" replace />} />
      </Routes>
    </div>
  );
}

function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 640px)').matches : false
  ));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return isMobile;
}

function PersonalGallery({
  batchMode,
  onBatchModeChange,
}: {
  batchMode: boolean;
  onBatchModeChange: (enabled: boolean) => void;
}) {
  const [items, setItems] = useState<GenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [total, setTotal] = useState(0);
  const [page, setPage] = usePageParam();
  const [confirmAction, setConfirmAction] = useState<PersonalConfirmAction | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState('');
  const [downloadPending, setDownloadPending] = useState(false);
  const [downloadMode, setDownloadMode] = useState<'single' | 'bulk' | ''>('');
  const totalPages = Math.max(1, Math.ceil(total / PERSONAL_GALLERY_PAGE_SIZE));

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const d = await api<GenerationListPayload>(`/api/generations?pageSize=${PERSONAL_GALLERY_PAGE_SIZE}&page=${page}&status=success`);
    if (d.ok && d.data) {
      setItems(d.data.items ?? []);
      setTotal(d.data.total ?? 0);
    }
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  useEffect(() => {
    setSelected(new Set());
  }, [page]);

  useEffect(() => {
    if (!batchMode) setSelected(new Set());
  }, [batchMode]);

  /** 执行用户已经二次确认的批量/单张图片操作。 */
  const runConfirmedAction = async () => {
    if (!confirmAction || actionPending) return;
    setActionPending(true);
    try {
      await confirmAction.run();
      setConfirmAction(null);
    } finally {
      setActionPending(false);
    }
  };

  /** 切换公开状态前必须二次确认；后端仍会按当前用户校验图片所有权。 */
  const togglePrivacy = (id: string, isPrivate: boolean) => {
    const nextPrivate = !isPrivate;
    setConfirmAction({
      title: nextPrivate ? '设为私密图片' : '设为公开图片',
      message: nextPrivate
        ? '设为私密后，其他用户将无法在公开图库或详情页查看这张图片。'
        : '设为公开后，这张图片会重新进入公开可见范围，其他用户可以浏览详情。',
      confirmLabel: nextPrivate ? '确认私密' : '确认公开',
      tone: nextPrivate ? 'warning' : 'default',
      run: async () => {
        const d = await api('/api/generations/privacy', { method: 'PATCH', body: JSON.stringify({ ids: [id], isPrivate: nextPrivate }) });
        if (d.ok) setItems(prev => prev.map(i => i.id === id ? { ...i, isPrivate: nextPrivate } : i));
      },
    });
  };

  /** 个人图片页单张/批次操作统一入口；批次 ID 会交由后端展开为整批任务。 */
  const toggleGalleryPrivacy = (item: GenItem) => {
    togglePrivacy(getPersonalGalleryActionId(item), item.isPrivate);
  };

  const deleteOne = (id: string) => {
    setConfirmAction({
      title: '删除图片',
      message: '确认删除这张图片？删除后对应生成记录也会移除，此操作不可恢复。',
      confirmLabel: '确认删除',
      tone: 'danger',
      run: async () => {
        const d = await api('/api/generations', { method: 'DELETE', body: JSON.stringify({ ids: [id] }) });
        if (d.ok) await fetchItems();
      },
    });
  };

  /** 删除入口同样按外显实体处理，批次删除会由后端展开整批真实任务。 */
  const deleteGalleryItem = (item: GenItem) => {
    deleteOne(getPersonalGalleryActionId(item));
  };

  const batchDelete = () => {
    if (selected.size === 0) return;
    const ids = [...selected];
    setConfirmAction({
      title: '批量删除图片',
      message: <>确认删除选中的 <strong>{ids.length}</strong> 张图片？删除后对应生成记录也会移除，此操作不可恢复。</>,
      confirmLabel: `删除 ${ids.length} 张`,
      tone: 'danger',
      run: async () => {
        const d = await api('/api/generations', { method: 'DELETE', body: JSON.stringify({ ids }) });
        if (d.ok) {
          setSelected(new Set());
          onBatchModeChange(false);
          await fetchItems();
        }
      },
    });
  };

  const batchPrivacy = (isPrivate: boolean) => {
    if (selected.size === 0) return;
    const ids = [...selected];
    const selectedIds = new Set(ids);
    setConfirmAction({
      title: isPrivate ? '批量设为私密' : '批量设为公开',
      message: isPrivate
        ? <>确认将选中的 <strong>{ids.length}</strong> 张图片设为私密？其他用户将无法继续查看这些图片。</>
        : <>确认将选中的 <strong>{ids.length}</strong> 张图片设为公开？这些图片会重新进入公开可见范围。</>,
      confirmLabel: isPrivate ? '确认私密' : '确认公开',
      tone: isPrivate ? 'warning' : 'default',
      run: async () => {
        const d = await api('/api/generations/privacy', { method: 'PATCH', body: JSON.stringify({ ids, isPrivate }) });
        if (d.ok) {
          setItems(prev => prev.map(i => selectedIds.has(i.id) ? { ...i, isPrivate } : i));
          setSelected(new Set());
          onBatchModeChange(false);
        }
      },
    });
  };

  /** 下载选中媒体：单个结果直接下载原文件，多张图片才让 backend 生成临时 zip。 */
  const batchDownload = async () => {
    if (selected.size === 0 || downloadPending) return;
    const ids = [...selected];
    const selectedItems = ids.map((id) => items.find((item) => item.id === id)).filter((item): item is GenItem => Boolean(item));
    if (ids.length > 1 && selectedItems.some((item) => Boolean(item.videoUrl))) {
      setDownloadStatus('视频结果请单独选择下载，图片仍可批量打包');
      return;
    }
    setDownloadPending(true);
    try {
      if (ids.length === 1) {
        setDownloadMode('single');
        const image = items.find(item => item.id === ids[0]);
        if (!image) {
          setDownloadStatus('下载失败，未找到选中的图片');
          return;
        }
        setDownloadStatus(image.videoUrl ? '下载中，正在拉取视频...' : '下载中，正在拉取原图...');
        await downloadSingleMedia(image);
        setDownloadStatus('下载已开始');
        return;
      }

      setDownloadMode('bulk');
      setDownloadStatus('打包中，后端正在整理选中的原图...');
      const created = await api<GalleryBulkDownloadResponse>('/api/gallery/bulk-downloads', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      if (!created.ok || !created.data) {
        setDownloadStatus(created.message || '打包失败，请稍后重试');
        return;
      }
      const expiresText = formatDateTime(created.data.expiresAt);
      setDownloadStatus(`打包完成，下载开始。文件会临时保留到 ${expiresText}`);
      await downloadArchive(created.data);
      setDownloadStatus(created.data.skippedCount > 0
        ? `下载已开始，${created.data.skippedCount} 张因文件暂不可用被跳过`
        : '下载已开始');
    } catch {
      setDownloadStatus('下载失败，请稍后重试');
    } finally {
      setDownloadPending(false);
      setDownloadMode('');
    }
  };

  /** 当前页全选只选择已加载的图片，跨页选择容易误删，暂不做跨页批量。 */
  const toggleSelectAll = () => {
    setSelected(prev => prev.size === items.length ? new Set() : new Set(items.map(item => item.id)));
  };

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (loading && items.length === 0) {
    return <EmptyState icon={<Loader2 size={16} className="animate-spin" />} text="加载中..." />;
  }

  if (!loading && items.length === 0) {
    return <EmptyState icon={<Image size={28} />} text="暂无图片" />;
  }

  return (
    <div>
      {batchMode && (
      <div className="personal-batch-bar">
        <div className="personal-batch-summary">
          <span className="text-sm font-medium">批量操作</span>
          <span className="text-xs text-text-2">已选 {selected.size} / 当前页 {items.length} 张</span>
        </div>
        <div className="personal-batch-actions">
          <button disabled={items.length === 0 || actionPending} onClick={toggleSelectAll} className="btn btn-outline btn-sm flex items-center gap-1">
            <Check size={12} />{selected.size === items.length ? '取消全选' : '全选当前页'}
          </button>
          <button disabled={selected.size === 0 || actionPending || downloadPending} onClick={() => batchPrivacy(true)} className="btn btn-outline btn-sm flex items-center gap-1"><Lock size={12} />批量私密</button>
          <button disabled={selected.size === 0 || actionPending || downloadPending} onClick={() => batchPrivacy(false)} className="btn btn-outline btn-sm flex items-center gap-1"><Unlock size={12} />批量公开</button>
          <button disabled={selected.size === 0 || actionPending || downloadPending} onClick={batchDownload} className="btn btn-outline btn-sm flex items-center gap-1">
            {downloadPending ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {downloadPending ? (downloadMode === 'single' ? '下载中' : '打包中') : selected.size === 1 ? '下载图片' : '批量下载'}
          </button>
          <button disabled={selected.size === 0 || actionPending || downloadPending} onClick={batchDelete} className="btn btn-danger btn-sm flex items-center gap-1"><Trash2 size={12} />批量删除</button>
        </div>
        {downloadStatus && <div className="personal-batch-download-status">{downloadStatus}</div>}
      </div>
      )}

      <div className={`personal-grid ${loading ? 'is-loading' : ''} ${batchMode ? 'is-batch-mode' : ''}`}>
        {items.map((img, index) => (
          <div
            key={img.id}
            className={`group relative overflow-hidden card-interactive card personal-gallery-card ${selected.has(img.id) ? 'personal-selected-card' : ''} ${batchMode ? 'is-selectable' : ''}`}
            style={{ padding: 0 }}
          >
            {batchMode && (
            <div className="absolute top-2 left-2 z-20">
              <button
                onClick={() => toggle(img.id)}
                className={`personal-check ${selected.has(img.id) ? 'is-checked' : ''}`}
                aria-label={selected.has(img.id) ? '取消选择' : '选择图片'}
              >
                {selected.has(img.id) && <Check size={12} color="#fff" />}
              </button>
            </div>
            )}
            <div className="personal-card-actions absolute top-2 right-2 z-10 flex gap-1">
              <button onClick={() => toggleGalleryPrivacy(img)} className="personal-float-action" aria-label={img.isPrivate ? '公开图片' : '设为私密'}>
                {img.isPrivate ? <Lock size={12} color="#f59e0b" /> : <Unlock size={12} color="#fff" />}
              </button>
              <button onClick={() => deleteGalleryItem(img)} className="personal-float-action" aria-label="删除图片">
                <Trash2 size={12} color="#fff" />
              </button>
            </div>
            {batchMode ? (
            <button
              type="button"
              className="personal-gallery-select-surface aspect-square flex items-center justify-center bg-bg overflow-hidden relative no-underline"
              onClick={() => toggle(img.id)}
              aria-pressed={selected.has(img.id)}
              aria-label={selected.has(img.id) ? '取消选择图片' : '选择图片'}
            >
              {img.videoUrl ? (
                <ViewportVideoPreview src={img.videoUrl} posterSrc={img.thumbnailUrl || img.imageUrl} priority={index < PERSONAL_IMAGE_HIGH_PRIORITY_COUNT} className="w-full h-full object-cover relative z-10" />
              ) : img.thumbnailUrl || img.imageUrl ? (
                <img
                  src={resolveMediaUrl(img.thumbnailUrl || img.imageUrl)}
                  alt=""
                  loading="eager"
                  decoding="async"
                  fetchPriority={index < PERSONAL_IMAGE_HIGH_PRIORITY_COUNT ? 'high' : 'auto'}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 relative z-10"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : null}
              <Image size={24} className="text-text-2 absolute" style={{ opacity: 0.3 }} />
            </button>
            ) : (
            img.videoUrl ? (
            <Link to={`/personal/generations/${getVisibleImageEntryId(img)}`} className="aspect-square flex items-center justify-center bg-bg overflow-hidden relative no-underline">
              <ViewportVideoPreview src={img.videoUrl} posterSrc={img.thumbnailUrl || img.imageUrl} priority={index < PERSONAL_IMAGE_HIGH_PRIORITY_COUNT} className="w-full h-full object-cover relative z-10" />
              <Image size={24} className="text-text-2 absolute" style={{ opacity: 0.3 }} />
            </Link>
            ) : (
            <Link to={`/image/${getVisibleImageEntryId(img)}`} className="aspect-square flex items-center justify-center bg-bg overflow-hidden relative no-underline">
              {img.thumbnailUrl || img.imageUrl ? (
                <img
                  src={resolveMediaUrl(img.thumbnailUrl || img.imageUrl)}
                  alt=""
                  loading="eager"
                  decoding="async"
                  fetchPriority={index < PERSONAL_IMAGE_HIGH_PRIORITY_COUNT ? 'high' : 'auto'}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 relative z-10"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : null}
              <Image size={24} className="text-text-2 absolute" style={{ opacity: 0.3 }} />
            </Link>
            )
            )}
            <div className="p-2">
              <div className="text-[11px] text-text-2 line-clamp-2 leading-snug">{img.prompt?.slice(0, 80)}</div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-text-2">
                {img.isPrivate && <span className="flex items-center gap-0.5 text-warning"><Lock size={9} />私密</span>}
                <span>{img.createdAt?.slice(0, 10)}</span>
                {img.videoUrl && <Link to={`/personal/generations/${getVisibleImageEntryId(img)}`} className="personal-video-detail-link">查看详情</Link>}
              </div>
            </div>
          </div>
        ))}
      </div>

      <PersonalPagination
        page={page}
        total={total}
        pageSize={PERSONAL_GALLERY_PAGE_SIZE}
        onPageChange={setPage}
      />
      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmAction?.title ?? ''}
        message={confirmAction?.message}
        confirmLabel={confirmAction?.confirmLabel ?? '确认'}
        tone={confirmAction?.tone}
        pending={actionPending}
        onConfirm={runConfirmedAction}
        onCancel={() => { if (!actionPending) setConfirmAction(null); }}
      />
    </div>
  );
}

function PersonalGenerations() {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const [items, setItems] = useState<GenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [detailBatch, setDetailBatch] = useState<TaskBatchDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = usePageParam();

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const d = await api<GenerationListPayload>(`/api/generations?pageSize=${PERSONAL_RECORD_PAGE_SIZE}&page=${page}`);
    if (d.ok && d.data) {
      setItems(d.data.items ?? []);
      setTotal(d.data.total ?? 0);
    }
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const openDetail = async (task: GenItem) => {
    // 手机端详情内容较长，进入独立页面避免弹窗定位和滚动层级冲突。
    if (isMobile) {
      navigate(`/personal/generations/${getVisibleImageEntryId(task)}`);
      return;
    }
    setDetailBatch(null);
    setDetailLoading(true);
    const batch = await loadTaskBatch(task);
    setDetailBatch(batch);
    setDetailLoading(false);
  };

  if (loading && items.length === 0) {
    return <EmptyState icon={<Loader2 size={16} className="animate-spin" />} text="加载中..." />;
  }

  if (!loading && items.length === 0) {
    return <EmptyState icon={<List size={28} />} text="暂无生成记录" />;
  }

  return (
    <div>
      <div className={`personal-record-list ${loading ? 'is-loading' : ''}`}>
        {items.map((gen, index) => (
          <div
            key={gen.id}
            className="personal-record-card"
            role="button"
            tabIndex={0}
            onClick={() => openDetail(gen)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openDetail(gen);
              }
            }}
          >
            <div className="personal-record-thumb">
              {gen.status === 'failed' ? (
                <AlertTriangle size={18} className="text-error" />
              ) : gen.videoUrl ? (
                <Video size={18} className="text-primary" />
              ) : gen.thumbnailUrl || gen.imageUrl ? (
                <img
                  src={resolveMediaUrl(gen.thumbnailUrl || gen.imageUrl)}
                  alt=""
                  loading={index < PERSONAL_RECORD_HIGH_PRIORITY_COUNT ? 'eager' : 'lazy'}
                  decoding="async"
                  fetchPriority={index < PERSONAL_RECORD_HIGH_PRIORITY_COUNT ? 'high' : 'auto'}
                  className="w-full h-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <Image size={16} className="text-text-2" />
              )}
            </div>
            <div className="personal-record-main">
              <div className="personal-record-prompt">{gen.prompt?.slice(0, 120) || '-'}</div>
              <div className="personal-record-meta">
                <span className={`personal-status ${statusClass(gen.status)}`}>{labelOf(STATUS_LABELS, gen.status)}</span>
                <span>{labelOf(SOURCE_LABELS, gen.source)}</span>
                <span>{labelOf(MODE_LABELS, gen.mode)}</span>
                <span>{formatDateTime(gen.createdAt)}</span>
              </div>
              {gen.error && <div className="personal-record-error">{gen.error.slice(0, 120)}</div>}
            </div>
          </div>
        ))}
      </div>

      <PersonalPagination
        page={page}
        total={total}
        pageSize={PERSONAL_RECORD_PAGE_SIZE}
        onPageChange={setPage}
      />

      {detailBatch && (
        <TaskDetailModal batch={detailBatch} loading={detailLoading} onClose={() => setDetailBatch(null)} />
      )}
    </div>
  );
}

/** 带当前登录态下载后端临时 zip，并触发浏览器保存。 */
async function downloadArchive(archive: GalleryBulkDownloadResponse) {
  const token = localStorage.getItem('token') ?? '';
  const response = await fetch(`${config.apiBase}${archive.downloadUrl}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('下载失败');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = archive.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** 单个媒体结果直接下载；视频不进入图片 zip 链路。 */
async function downloadSingleMedia(image: GenItem) {
  const url = image.videoUrl || image.imageUrl || image.thumbnailUrl;
  if (!url) {
    throw new Error('媒体地址缺失');
  }
  const token = localStorage.getItem('token') ?? '';
  const response = await fetch(image.videoUrl ? resolvePlayableVideoUrl(url) : resolveMediaUrl(url), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('下载失败');
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = buildDownloadFilename(image, url);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}

/** 生成单图下载文件名，优先保留原始扩展名。 */
function buildDownloadFilename(image: GenItem, url: string): string {
  const rawName = url.split('/').pop() || image.id;
  const match = rawName.match(/\.(png|jpe?g|webp|gif|avif|bmp|tiff?|mp4)$/i);
  const ext = match ? `.${match[1]!.toLowerCase().replace('jpeg', 'jpg')}` : '.png';
  return `${image.id}${ext}`;
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="text-center py-16 text-text-2 flex flex-col items-center gap-3">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function PersonalPagination({
  page,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const [jumpInput, setJumpInput] = useState('');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const quickPages = buildQuickPages(page, totalPages);

  useEffect(() => {
    setJumpInput('');
  }, [page]);

  const jump = () => {
    const nextPage = Number(jumpInput);
    if (nextPage >= 1 && nextPage <= totalPages) onPageChange(nextPage);
  };

  if (total <= pageSize && totalPages <= 1) return null;

  return (
    <div className="personal-pagination">
      <div className="personal-pagination-summary">
        第 {page} 页 / 共 {totalPages} 页 · 共 {total} 条
      </div>
      <div className="personal-pagination-controls">
        <button className="personal-page-button" disabled={page <= 1} onClick={() => onPageChange(1)} aria-label="第一页"><ChevronsLeft size={14} /></button>
        <button className="personal-page-button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页"><ChevronLeft size={14} /></button>
        {quickPages.map((item) => (
          <button
            key={item}
            className={`personal-page-button is-number ${item === page ? 'is-current' : ''}`}
            disabled={item === page}
            onClick={() => onPageChange(item)}
          >
            {item}
          </button>
        ))}
        <button className="personal-page-button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label="下一页"><ChevronRight size={14} /></button>
        <button className="personal-page-button" disabled={page >= totalPages} onClick={() => onPageChange(totalPages)} aria-label="最后一页"><ChevronsRight size={14} /></button>
        <div className="personal-page-jump">
          <input
            className="input"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="页码"
            value={jumpInput}
            onChange={event => setJumpInput(event.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={event => {
              if (event.key === 'Enter') jump();
            }}
          />
          <button className="personal-page-button is-jump" disabled={!jumpInput} onClick={jump}>跳转</button>
        </div>
      </div>
    </div>
  );
}

function PersonalGenerationDetailPage() {
  const navigate = useNavigate();
  const { taskId } = useParams();
  const [batch, setBatch] = useState<TaskBatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchTask = async () => {
      if (!taskId) {
        setError('任务不存在');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError('');
      // 独立详情页按外显 ID 拉完整详情；批次入口由后端展开为同一任务下的真实子图。
      const d = await api<{ tasks: GenItem[] }>(`/api/generations/tasks?ids=${encodeURIComponent(taskId)}`);
      if (cancelled) return;
      if (d.ok && d.data?.tasks?.length) {
        const tasks = sortDetailTasks(d.data.tasks);
        setBatch({
          tasks,
          selectedTaskId: pickPreferredDetailTaskId(tasks),
        });
      } else {
        setError(d.message || '未找到任务详情');
      }
      setLoading(false);
    };
    fetchTask();
    return () => { cancelled = true; };
  }, [taskId]);

  const task = getSelectedDetailTask(batch);
  const selectedTaskId = batch?.selectedTaskId ?? '';

  return (
    <div className="personal-task-page">
      <div className="personal-task-page-top">
        <button className="btn btn-outline btn-sm" onClick={() => navigate('/personal/generations')}>返回记录</button>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2>任务详情</h2>
            {task && <span className={`personal-status ${statusClass(task.status)}`}>{labelOf(STATUS_LABELS, task.status)}</span>}
            {loading && <Loader2 size={14} className="animate-spin text-text-2" />}
          </div>
          <p><Hash size={12} />{task ? getVisibleImageEntryId(task) : taskId || '-'}</p>
        </div>
      </div>

      {loading && !task ? (
        <EmptyState icon={<Loader2 size={16} className="animate-spin" />} text="加载任务详情中..." />
      ) : error ? (
        <EmptyState icon={<AlertTriangle size={24} />} text={error} />
      ) : batch && task ? (
        <div className="personal-task-page-body">
          <TaskBatchDetailBody
            batch={batch}
            selectedTaskId={selectedTaskId}
            onSelectTask={(id) => setBatch((current) => current ? { ...current, selectedTaskId: id } : current)}
          />
        </div>
      ) : null}
    </div>
  );
}

function TaskDetailModal({ batch, loading, onClose }: { batch: TaskBatchDetail; loading: boolean; onClose: () => void }) {
  const [selectedTaskId, setSelectedTaskId] = useState(batch.selectedTaskId);

  useEffect(() => {
    setSelectedTaskId(batch.selectedTaskId);
  }, [batch.selectedTaskId]);
  const selectedTask = batch.tasks.find((item) => item.id === selectedTaskId) ?? batch.tasks[0];

  const modal = (
    <div className="personal-task-modal-overlay" onClick={onClose}>
      <div className="personal-task-modal" onClick={event => event.stopPropagation()}>
        <div className="personal-task-modal-header">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3>任务详情</h3>
              <span className={`personal-status ${statusClass(selectedTask?.status ?? 'queued')}`}>{labelOf(STATUS_LABELS, selectedTask?.status)}</span>
              {loading && <Loader2 size={14} className="animate-spin text-text-2" />}
            </div>
          <p><Hash size={12} />{getVisibleImageEntryId(selectedTask ?? batch.tasks[0])}</p>
          </div>
          <button onClick={onClose} className="personal-modal-close" aria-label="关闭"><X size={16} /></button>
        </div>

        <div className="personal-task-modal-body">
          <TaskBatchDetailBody
            batch={batch}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
          />
        </div>
      </div>
    </div>
  );

  // 桌面端任务详情弹窗必须挂到 body，避免被个人页容器或滚动层影响定位基准。
  return createPortal(modal, document.body);
}

function TaskBatchDetailBody({ batch, selectedTaskId, onSelectTask }: { batch: TaskBatchDetail; selectedTaskId: string; onSelectTask: (taskId: string) => void }) {
  const modelDisplayMap = useDrawingModelDisplayMap();
  const task = batch.tasks.find((item) => item.id === selectedTaskId) ?? batch.tasks[0];
  const attempts = useMemo(() => task?.subTasks?.filter(isRealUpstreamAttempt) ?? [], [task?.subTasks]);
  const failedAttempts = attempts.filter(item => item.status === 'failed').length;
  /** 批次的真实最终媒体列表，图片和视频都使用任务自身持久化地址。 */
  const finalImages = useMemo(() => collectBatchFinalImages(batch.tasks), [batch.tasks]);
  const derivedSite = useMemo(() => {
    const values = [...new Set(attempts.map(item => item.siteName).filter(Boolean))];
    return task?.siteName || values.join(' / ') || '-';
  }, [attempts, task?.siteName]);
  const derivedModel = useMemo(() => {
    const values = [...new Set(attempts.map(item => item.model).filter(Boolean))];
    const raw = task?.model || values.join(' / ');
    return raw ? raw.split(' / ').map(item => formatDrawingModelNameByMap(item, modelDisplayMap)).join(' / ') : '-';
  }, [attempts, modelDisplayMap, task?.model]);
  const elapsedMs = task?.startedAt && task?.finishedAt
    ? Math.max(0, new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime())
    : undefined;
  const resultUrl = task?.imageUrl || task?.thumbnailUrl;
  const videoUrl = task?.videoUrl;
  const batchSummary = buildTaskBatchSummary(batch.tasks);

  return (
    <>
      {batch.tasks.length > 1 && (
        <div className="personal-task-batch-tabs">
          {batch.tasks.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`personal-task-batch-tab ${item.id === task?.id ? 'is-active' : ''}`}
              onClick={() => onSelectTask(item.id)}
            >
              <span>n={item.batchIndex ?? 1}</span>
              <strong>{labelOf(STATUS_LABELS, item.status)}</strong>
            </button>
          ))}
        </div>
      )}

      {finalImages.length > 1 && (
        <section className="personal-task-section personal-task-final-strip-section">
          <h4>批次最终结果 ({finalImages.length} 个)</h4>
          <div className="personal-task-final-strip" aria-label="批次最终结果切换">
            {finalImages.map((image) => (
              <button
                key={image.id}
                type="button"
                className={`personal-task-final-thumb ${image.id === task?.id ? 'is-active' : ''} ${image.status}`}
                onClick={() => onSelectTask(image.id)}
              >
                {image.videoUrl ? (
                  <ViewportVideoPreview src={image.videoUrl} posterSrc={image.thumbnailUrl || image.imageUrl} />
                ) : image.thumbnailUrl || image.imageUrl ? (
                  <img
                    src={resolveMediaUrl(image.thumbnailUrl || image.imageUrl)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    fetchPriority="auto"
                    onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <Image size={14} />
                )}
                <span>n={image.batchIndex ?? 1}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="personal-task-layout">
        <div className="personal-task-preview">
          <div className="personal-task-preview-title">生成结果</div>
          <div className="personal-task-image-box">
            {videoUrl ? (
              <video src={resolvePlayableVideoUrl(videoUrl)} controls playsInline preload="metadata" />
            ) : resultUrl ? (
              <img src={resolveMediaUrl(resultUrl)} alt="" loading="eager" decoding="async" fetchPriority="high" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            ) : task?.status === 'failed' ? (
              <div className="personal-task-empty-result"><AlertTriangle size={26} />本次任务失败，暂无生成结果</div>
            ) : (
              <div className="personal-task-empty-result"><Image size={26} />暂无生成结果</div>
            )}
          </div>
          {task?.status === 'success' && (resultUrl || videoUrl) && (
          <Link to={`/image/${getVisibleImageEntryId(task)}`} className="btn btn-sm personal-gallery-entry">
            <ExternalLink size={13} />进入图库详情
          </Link>
          )}
          {batchSummary.total > 1 && (
            <div className="personal-task-batch-summary">
              <span>共 {batchSummary.total} 个结果</span>
              <span>成功 {batchSummary.successCount}</span>
              <span>失败 {batchSummary.failedCount}</span>
              <span>进行中 {batchSummary.activeCount}</span>
            </div>
          )}
        </div>

        <div className="personal-task-info">
          <div className="personal-task-fields">
            <InfoCell label="来源" value={labelOf(SOURCE_LABELS, task?.source)} />
            <InfoCell label="模式" value={labelOf(MODE_LABELS, task?.mode)} />
            <InfoCell label="隐私" value={task?.isPrivate ? '私密' : '公开'} />
            <InfoCell label="站点" value={derivedSite} />
            <InfoCell label="模型" value={derivedModel} />
            <InfoCell label="总耗时" value={formatDuration(elapsedMs)} />
            {videoUrl && <InfoCell label="视频规格" value={`${task?.resolution ?? '-'} · ${task?.duration ?? '-'} 秒 · ${task?.aspectRatio ?? '-'}`} />}
            <InfoCell label="尝试次数" value={String(attempts.length || '-')} />
            <InfoCell label="失败次数" value={String(failedAttempts || '-')} />
            <InfoCell label="创建" value={formatDateTime(task?.createdAt)} />
            <InfoCell label="开始" value={formatDateTime(task?.startedAt)} />
            <InfoCell label="完成" value={formatDateTime(task?.finishedAt)} />
            <InfoCell label="QQ" value={task?.qqNumber || '-'} />
          </div>

          <section className="personal-task-section">
            <h4>提示词</h4>
            <div className="personal-task-prompt">{task?.prompt || '-'}</div>
          </section>

          {task?.error && (
            <section className="personal-task-section">
              <h4>错误</h4>
              <div className="personal-task-error">{task.error}</div>
            </section>
          )}
        </div>
      </div>

      {task && <SubTaskTimeline taskStatus={task.status} subTasks={task.subTasks} formatModelName={(value) => formatDrawingModelNameByMap(value, modelDisplayMap)} />}

      {task?.sourceImageUrls && task.sourceImageUrls.length > 0 && (
        <section className="personal-task-section">
          <h4>参考图 ({task.sourceImageUrls.length} 张)</h4>
          <div className="personal-reference-grid">
            {task.sourceImageUrls.map((url, index) => (
              <a key={`${url}-${index}`} href={resolveMediaUrl(url)} target="_blank" rel="noopener noreferrer">
                <img src={resolveMediaUrl(url)} alt="" loading="eager" decoding="async" fetchPriority={index === 0 ? 'high' : 'auto'} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </a>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** 提取批次中真实可展示的最终媒体，图片和视频都按批次顺序返回。 */
function collectBatchFinalImages(tasks: GenItem[]) {
  return tasks
    .filter((item) => Boolean(item.imageUrl || item.thumbnailUrl || item.videoUrl))
    .sort((left, right) => {
      const leftIndex = left.batchIndex ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = right.batchIndex ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    });
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="personal-info-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
