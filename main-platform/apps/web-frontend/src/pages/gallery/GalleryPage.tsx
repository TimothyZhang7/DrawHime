/** 公开图库 — URL 分页绑定 + 懒加载缩略图 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { resolveMediaUrl } from '../../lib/media';
import { Seo } from '../../components/Seo';
import { Images, Search, Sparkles, Heart, Eye, X, RefreshCw, AlertTriangle, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, SlidersHorizontal } from 'lucide-react';
import type { GalleryImageAssetView, GalleryImageToImageKind, GalleryItemView, GalleryPopularTagView, GalleryPopularTagsResponse, GalleryTagMatchMode, GalleryTagView } from '@aiimage/shared-contracts';
import { GalleryTags } from '../../components/gallery/GalleryTags';
import { GalleryFilterDialog, type GalleryFilterDialogValue } from '../../components/gallery/GalleryFilterDialog';
import { formatDrawingModelNameByMap, useDrawingModelDisplayMap } from '../../lib/drawingModelDisplay';
import { ViewportVideoPreview } from '../../components/media/ViewportVideoPreview';

const PAGE_SIZE = 36;
const GALLERY_CLIENT_CACHE_TTL_MS = 30_000;
/** 只让首屏图片立即排队加载，后续缩略图交给浏览器懒加载，避免图库一次性抢占过多连接。 */
const GALLERY_HIGH_PRIORITY_IMAGE_COUNT = 12;
/** 图库标签筛选最多 8 个，和 backend SQL 限制保持一致。 */
const GALLERY_MAX_FILTER_TAGS = 8;

type Img = GalleryItemView;
type GalleryResponse = { items: Img[]; total: number; page: number; pageSize: number; totalPages: number };
type GalleryClientCacheEntry = { expiresAt: number; data: GalleryResponse };

const GALLERY_SORT_LABELS: Record<string, string> = { latest: '最新', popular: '热门', random: '随机' };
const GALLERY_MODE_LABELS: Record<string, string> = {
  'text-to-image': '文生图',
  'image-to-image': '图生图',
  'text-to-video': '文生视频',
  'image-to-video': '参考图视频',
};
const GALLERY_I2I_KIND_LABELS: Record<GalleryImageToImageKind, string> = { describe: '图生图/描述生成', replace: '图生图/替换生成' };

/** 公开图库未登录态短时内存缓存；只保存在当前页面会话中，不落 localStorage，避免跨账号展示旧点赞态。 */
const galleryClientCache = new Map<string, GalleryClientCacheEntry>();

function buildQuickPages(page: number, totalPages: number): number[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  let s = page - 3, e = page + 3;
  if (s < 1) { e += 1 - s; s = 1; }
  if (e > totalPages) { s -= e - totalPages; e = totalPages; }
  return Array.from({ length: Math.max(1, e - s + 1) }, (_, i) => Math.max(1, s) + i);
}

export function GalleryPage() {
  const [params, setParams] = useSearchParams();
  const modelDisplayMap = useDrawingModelDisplayMap();
  const page = Number(params.get('page') ?? '1');
  const sortParam = params.get('sort') ?? 'latest';
  const sort = normalizeGallerySort(sortParam);
  const filter = params.get('mode') ?? '';
  const i2iKind = parseGalleryImageToImageKind(params.get('i2iKind'));
  const search = params.get('search') ?? '';
  const selectedTags = useMemo(() => parseGallerySelectedTags(params), [params]);
  const tagMatch: GalleryTagMatchMode = params.get('tagMatch') === 'all' ? 'all' : 'any';

  const [images, setImages] = useState<Img[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(search);
  const [jumpInput, setJumpInput] = useState('');
  const [popularTags, setPopularTags] = useState<GalleryPopularTagView[]>([]);
  const [popularTagsLoaded, setPopularTagsLoaded] = useState(false);
  const [popularTagsError, setPopularTagsError] = useState(false);
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const requestSeq = useRef(0);

  const updateParam = useCallback((key: string, value: string) => {
    setParams(prev => { const n = new URLSearchParams(prev); if (value) n.set(key, value); else n.delete(key); if (key !== 'page') n.delete('page'); return n; });
  }, [setParams]);
  const submitSearch = useCallback(() => {
    updateParam('search', searchInput.trim());
  }, [searchInput, updateParam]);

  const applyGalleryFilters = useCallback((value: GalleryFilterDialogValue) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (value.mode) next.set('mode', value.mode);
      else next.delete('mode');
      if (value.mode === 'image-to-image' && value.i2iKind) next.set('i2iKind', value.i2iKind);
      else next.delete('i2iKind');
      if (value.sort && value.sort !== 'latest') next.set('sort', value.sort);
      else next.delete('sort');
      const tags = normalizeGalleryTags(value.tags);
      next.delete('tag');
      if (tags.length > 0) {
        next.set('tags', tags.join(','));
        next.set('tagMatch', value.tagMatch);
      } else {
        next.delete('tags');
        next.delete('tagMatch');
      }
      next.delete('page');
      return next;
    });
    setFilterDialogOpen(false);
  }, [setParams]);

  const selectSingleTag = useCallback((tagView: GalleryTagView) => {
    applyGalleryFilters({ mode: filter, i2iKind, sort, tags: [tagView.name], tagMatch: 'any' });
    window.scrollTo(0, 0);
  }, [applyGalleryFilters, filter, i2iKind, sort]);

  const clearTag = useCallback((tagName: string) => {
    applyGalleryFilters({ mode: filter, i2iKind, sort, tags: selectedTags.filter((item) => item !== tagName), tagMatch });
  }, [applyGalleryFilters, filter, i2iKind, selectedTags, sort, tagMatch]);

  const applyGalleryData = useCallback((data: GalleryResponse) => {
    setImages(data.items);
    setTotalPages(data.totalPages || Math.ceil((data.total || 0) / PAGE_SIZE));
    setTotalItems(data.total || 0);
  }, []);

  const fetch = useCallback(async () => {
    const seq = ++requestSeq.current;
    const qs = new URLSearchParams({ sort, page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) qs.set('search', search);
    if (filter) qs.set('mode', filter);
    if (filter === 'image-to-image' && i2iKind) qs.set('i2iKind', i2iKind);
    if (selectedTags.length > 0) {
      qs.set('tags', selectedTags.join(','));
      qs.set('tagMatch', tagMatch);
    }
    const cacheKey = qs.toString();
    const canUseClientCache = !localStorage.getItem('token');
    const cached = canUseClientCache ? readGalleryClientCache(cacheKey) : undefined;
    if (cached) {
      applyGalleryData(cached);
      setLoading(false);
      setError(null);
    } else {
      setLoading(true);
      setError(null);
    }
    try {
      const d = await api<GalleryResponse>(`/api/gallery?${qs}`);
      if (seq !== requestSeq.current) return;
      if (d.ok && d.data) {
        applyGalleryData(d.data);
        if (canUseClientCache) writeGalleryClientCache(cacheKey, d.data);
      } else setError(d.message || '加载失败');
    } catch {
      if (seq === requestSeq.current && !cached) setError('网络错误');
    }
    if (seq === requestSeq.current) setLoading(false);
  }, [page, sort, filter, i2iKind, search, selectedTags, tagMatch, applyGalleryData]);

  useEffect(() => { fetch(); }, [fetch]);
  useEffect(() => { setSearchInput(search); }, [search]);
  useEffect(() => {
    let cancelled = false;
    // 热门标签只用于公开图库导航；接口失败时展示轻量状态，不能影响图库主列表。
    api<GalleryPopularTagsResponse>('/api/gallery/tags/popular?limit=500')
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.data) {
          setPopularTags(result.data.tags);
          setPopularTagsError(false);
        } else {
          setPopularTagsError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setPopularTagsError(true);
      })
      .finally(() => {
        if (!cancelled) setPopularTagsLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  const goPage = (p: number) => { if (p < 1 || p > totalPages) return; updateParam('page', String(p)); window.scrollTo(0, 0); };
  const filterValue = useMemo<GalleryFilterDialogValue>(() => ({
    mode: filter,
    i2iKind,
    sort,
    tags: selectedTags,
    tagMatch,
  }), [filter, i2iKind, selectedTags, sort, tagMatch]);
  const filterSummary = useMemo(() => buildGalleryFilterSummary(filterValue), [filterValue]);
  const activeFilterCount = (filter ? 1 : 0) + (sort !== 'latest' ? 1 : 0) + selectedTags.length;

  return (
    <div className="gallery-page animate-fade-in">
      <Seo title="公开图库" description="浏览绘图姬 DrawHime 公开 AI 图片作品，支持搜索、标签、排序、文生图和图生图筛选。" path="/gallery" />
      <div className="flex flex-col gap-3 mb-4">
        <div className="gallery-top-row flex items-center justify-between gap-4 flex-wrap">
          <h1 className="gallery-title page-title flex items-center gap-2"><Images size={20} />图库</h1>
          {/* 图库搜索行使用专用尺寸，确保输入框和搜索按钮在桌面与手机端都水平对齐。 */}
          <div className="gallery-search-wrap flex gap-2 flex-1" style={{ maxWidth: 620 }}>
            <div className="gallery-search-field input flex-1 flex items-center gap-2">
              <Search size={14} className="text-text-2 flex-shrink-0" />
              <input placeholder="搜索用户名、QQ、提示词、模型、站点..." value={searchInput} onChange={e => setSearchInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submitSearch()}
                className="flex-1" style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13 }} />
              {search && <button onClick={() => updateParam('search', '')}><X size={14} className="text-text-2" /></button>}
            </div>
            <button className="gallery-search-button btn btn-sm" onClick={submitSearch}>搜索</button>
            <button className={`gallery-filter-trigger btn btn-outline btn-sm${activeFilterCount > 0 ? ' is-active' : ''}`} onClick={() => setFilterDialogOpen(true)}>
              <SlidersHorizontal size={14} />
              筛选{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
            </button>
          </div>
        </div>
        <div className="gallery-filter-summary">
          {filterSummary.map((item) => (
            <span key={item.key} className="gallery-filter-summary-chip">{item.label}</span>
          ))}
          {selectedTags.map((tagName) => (
            <button key={tagName} type="button" className="gallery-filter-summary-chip is-tag" onClick={() => clearTag(tagName)} title="清除此标签">
              标签：{tagName}<X size={12} />
            </button>
          ))}
          {filterSummary.length === 0 && selectedTags.length === 0 ? (
            <span className="gallery-filter-summary-empty">全部公开作品</span>
          ) : (
            <button type="button" className="gallery-filter-summary-clear" onClick={() => applyGalleryFilters({ mode: '', sort: 'latest', tags: [], tagMatch: 'any', i2iKind: undefined })}>清空筛选</button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="gallery-card-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="gallery-card-shell is-loading overflow-hidden">
              {/* 骨架屏必须复用最终卡片的三段式结构，避免加载态高度折叠后造成页面跳动。 */}
              <div className="gallery-card-cover gallery-card-cover-skeleton skeleton" />
              <div className="gallery-card-info gallery-card-info-skeleton">
                <div className="skeleton gallery-card-title-skeleton" />
                <div className="gallery-card-meta-line gallery-card-meta-skeleton">
                  <span className="skeleton gallery-card-mode-skeleton" />
                  <em aria-hidden="true">·</em>
                  <span className="skeleton gallery-card-model-skeleton" />
                </div>
              </div>
              <div className="gallery-card-tags-area gallery-card-tags-skeleton">
                <span className="skeleton gallery-card-tag-skeleton" />
                <span className="skeleton gallery-card-tag-skeleton is-short" />
                <span className="skeleton gallery-card-tag-skeleton is-wide" />
                <span className="skeleton gallery-card-tag-skeleton" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-text-2">
          <AlertTriangle size={32} /><span className="text-sm">{error}</span>
          <button onClick={fetch} className="btn btn-sm flex items-center gap-1.5"><RefreshCw size={13} />重试</button>
        </div>
      ) : images.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-text-2">
          <Sparkles size={32} /><span className="text-sm">暂无图片</span><Link to="/" className="btn btn-sm mt-2">开始创作</Link>
        </div>
      ) : (
        <>
          <div className="gallery-card-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {images.map((img, index) => {
              // AI 标题只用于封面展示；为空时仍回退到提示词清洗标题。
              const cardTitle = img.title?.trim() || buildGalleryCardTitle(img.prompt);
              const modeLabel = buildGalleryModeLabel(img);
              // 本地模型作品直接使用任务发布时固化的外显名，不能套用主站模型映射或显示为自动模型。
              const modelLabel = img.localModel?.modelDisplayName || formatDrawingModelNameByMap(img.model, modelDisplayMap) || '自动模型';
              const localLoraCount = img.localModel?.loras.length ?? null;
              const modeTone = buildGalleryModeTone(img);
              const isUpscale = isImageUpscaleGalleryItem(img);
              const cover = (
                <div className="gallery-card-cover flex items-center justify-center overflow-hidden relative" style={{ background: 'var(--color-bg)' }}>
                  <GalleryCardPreview img={img} priority={index < GALLERY_HIGH_PRIORITY_IMAGE_COUNT} />
                  {img.galleryKind === 'batch' && img.itemCount > 1 && (
                    <span className="gallery-card-batch-badge">x{img.itemCount}</span>
                  )}
                  <div className="gallery-card-hover-stats pointer-events-none">
                    <div className="gallery-card-hover-stats-inner">
                      <span className="flex items-center gap-1"><Heart size={12} />{img.likeCount}</span>
                      <span className="flex items-center gap-1"><Eye size={12} />{img.viewCount}</span>
                    </div>
                  </div>
                </div>
              );
              return (
              <div key={img.id} className={`gallery-card-shell group block overflow-hidden relative${isUpscale ? ' is-upscale' : ''}`}>
                {/* 图库视频封面不展示播放控件，整张封面保持统一的详情跳转交互。 */}
                <Link to={`/image/${img.id}`} className="block no-underline">{cover}</Link>
                <Link to={`/image/${img.id}`} className="gallery-card-info no-underline" title={`${cardTitle} · ${modeLabel} · ${modelLabel}`}>
                  <strong className="gallery-card-title-line">{cardTitle}</strong>
                  <span className="gallery-card-meta-line">
                    {localLoraCount != null ? (
                      // 本地作品不再占用四字类型标签，直接突出真实模型名和 LoRA 数量。
                      <><i className="is-local-model">{modelLabel}</i><em aria-hidden="true">·</em><span className="gallery-card-lora-count">{localLoraCount} LoRA</span></>
                    ) : (
                      <><b className={modeTone}>{modeLabel}</b><em aria-hidden="true">·</em><i>{modelLabel}</i></>
                    )}
                  </span>
                </Link>
                <div className="gallery-card-tags-area">
                  <GalleryTags tags={img.tags} activeTags={selectedTags} showOmit maxRows={2} fallbackVisibleCount={3} className="gallery-card-tags" onTagClick={selectSingleTag} />
                </div>
              </div>
            ); })}
          </div>

          {/* 分页器 — V2 风格 */}
          {totalPages > 1 && (() => { const qp = buildQuickPages(page, totalPages); return (
            <div className="card flex flex-col gap-3 p-3 mt-6" style={{ borderRadius: 8 }}>
              <div className="text-xs text-text-2 text-center">第 {page} 页 / 共 {totalPages} 页 · {totalItems} 张图片</div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs" disabled={page <= 1} onClick={() => goPage(1)}><ChevronsLeft size={14} /></button>
                <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs" disabled={page <= 1} onClick={() => goPage(page - 1)}><ChevronLeft size={14} /></button>
                {qp.map((n, i) => (
                  <button key={`qp-${i}-${n}`}
                    className={`btn btn-sm !h-8 !w-9 !px-0 text-xs ${n === page ? 'bg-primary text-white' : 'btn-outline'}`}
                    disabled={n === page} onClick={() => goPage(n)}>{n}</button>
                ))}
                <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs" disabled={page >= totalPages} onClick={() => goPage(page + 1)}><ChevronRight size={14} /></button>
                <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs" disabled={page >= totalPages} onClick={() => goPage(totalPages)}><ChevronsRight size={14} /></button>
                <div className="flex items-center gap-1.5 ml-1">
                  <input className="input !h-8 !w-16 text-center text-xs" inputMode="numeric" pattern="[0-9]*" placeholder="页码"
                    value={jumpInput} onChange={e => setJumpInput(e.target.value.replace(/[^\d]/g, ''))}
                    onKeyDown={e => { if (e.key === 'Enter') { const n = Number(jumpInput); if (n >= 1 && n <= totalPages) { goPage(n); setJumpInput(''); } } }} />
                  <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs"
                    disabled={!jumpInput} onClick={() => { const n = Number(jumpInput); if (n >= 1 && n <= totalPages) { goPage(n); setJumpInput(''); } }}>跳转</button>
                </div>
              </div>
            </div>
          ); })()}
        </>
      )}
      <GalleryFilterDialog
        open={filterDialogOpen}
        value={filterValue}
        popularTags={popularTags}
        popularTagsLoaded={popularTagsLoaded}
        popularTagsError={popularTagsError}
        onApply={applyGalleryFilters}
        onClose={() => setFilterDialogOpen(false)}
      />
    </div>
  );
}

/** 解析 URL 中的新旧标签筛选参数，并去重限制数量。 */
function parseGallerySelectedTags(params: URLSearchParams): string[] {
  const rawTags = [
    ...params.getAll('tags').flatMap((value) => value.split(',')),
    params.get('tag') ?? '',
  ];
  return normalizeGalleryTags(rawTags);
}

/** 归一化前端标签筛选列表，和后端最多 8 个标签的规则保持一致。 */
function normalizeGalleryTags(tags: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of tags) {
    const tag = rawTag.replace(/\s+/g, ' ').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= GALLERY_MAX_FILTER_TAGS) break;
  }
  return result;
}

/** 归一化排序参数，非法历史值回退最新。 */
function normalizeGallerySort(value: string): string {
  return value === 'popular' || value === 'random' ? value : 'latest';
}

/** 归一化图生图细分筛选，非法值忽略。 */
function parseGalleryImageToImageKind(value: string | null): GalleryImageToImageKind | undefined {
  return value === 'describe' || value === 'replace' ? value : undefined;
}

/** 构建筛选摘要 chip，只展示非默认筛选。 */
function buildGalleryFilterSummary(value: GalleryFilterDialogValue): Array<{ key: string; label: string }> {
  const items: Array<{ key: string; label: string }> = [];
  if (value.mode === 'image-to-image' && value.i2iKind) {
    items.push({ key: 'mode', label: GALLERY_I2I_KIND_LABELS[value.i2iKind] });
  } else if (value.mode) {
    items.push({ key: 'mode', label: GALLERY_MODE_LABELS[value.mode] ?? value.mode });
  }
  if (value.sort !== 'latest') items.push({ key: 'sort', label: GALLERY_SORT_LABELS[value.sort] ?? value.sort });
  if (value.tags.length > 1) items.push({ key: 'tagMatch', label: value.tagMatch === 'all' ? '同时包含' : '任一标签' });
  return items;
}

/** 从提示词生成图库卡片单行标题；只做展示清洗，不改变原始提示词和详情页内容。 */
function buildGalleryCardTitle(prompt: string): string {
  const normalized = prompt
    .replace(/\s+/g, ' ')
    .replace(/^\/?(绘图|画图|生成|draw|imagine)\s*/i, '')
    .replace(/^(prompt|提示词)[:：]\s*/i, '')
    .replace(/\b(masterpiece|best quality|high quality|ultra detailed|8k)\b[,， ]*/gi, '')
    .trim();
  const firstLine = normalized.split(/[\n。；;|]/).find((item) => item.trim())?.trim() ?? '';
  return firstLine || '未命名作品';
}

/** 构建图库卡片生成类型文案；图生图进一步用提示词正则区分描述生成和替换生成。 */
function buildGalleryModeLabel(item: Img): string {
  if (item.localModel) return '本地模型';
  if (isImageUpscaleGalleryItem(item)) return '图片放大';
  if (item.mode === 'text-to-video') return '文生视频';
  if (item.mode === 'image-to-video') return '参考图视频';
  if (item.mode !== 'image-to-image') return '文生图';
  return `图生图/${classifyImageToImagePrompt(item.prompt)}`;
}

/** 给生成类型附加稳定样式分支，只影响卡片视觉层级，不改变筛选逻辑。 */
function buildGalleryModeTone(item: Img): string {
  if (item.localModel) return 'is-local';
  if (isImageUpscaleGalleryItem(item)) return 'is-upscale';
  if (item.mediaType === 'video') return 'is-video';
  if (item.mode !== 'image-to-image') return 'is-text';
  return classifyImageToImagePrompt(item.prompt) === '替换生成' ? 'is-replace' : 'is-describe';
}

/** 识别图片放大生成记录；只依赖已有图库字段，不改变接口筛选语义。 */
function isImageUpscaleGalleryItem(item: Pick<Img, 'mode' | 'prompt' | 'model'>): boolean {
  if (item.mode !== 'image-to-image') return false;
  const text = `${item.prompt ?? ''} ${item.model ?? ''}`.toLowerCase();
  return text.includes('图片放大') || text.includes('image-upscale') || text.includes('upscale') || text.includes('realesrgan');
}

/** 判断图生图提示词更像“替换局部”还是“按描述重绘”；只影响封面标签展示。 */
function classifyImageToImagePrompt(prompt: string): '替换生成' | '描述生成' {
  const text = prompt.replace(/\s+/g, '');
  const replacePattern = /(替换|换成|换为|改成|改为|改掉|修改为|变成|去掉|删除|移除|抹除|擦除|添加|增加|加上|把.+?(换|改|变|删|去|移除)|将.+?(换|改|变|删|去|移除))/i;
  if (replacePattern.test(text)) return '替换生成';
  return '描述生成';
}

/** 图库卡片预览：单图直接显示缩略图，多图批次显示紧凑拼图，保持旧字段兼容。 */
function GalleryCardPreview({ img, priority }: { img: Img; priority: boolean }) {
  const assets = img.galleryKind === 'batch' && img.images?.length > 1 ? img.images.slice(0, 4) : [img.images?.[0] ?? img];
  if (assets.length <= 1) {
    const asset = assets[0];
    const videoUrl = ('videoUrl' in asset ? asset.videoUrl : img.videoUrl) || undefined;
    const isVideo = ('mediaType' in asset ? asset.mediaType : img.mediaType) === 'video' && Boolean(videoUrl);
    const src = ('thumbnailUrl' in asset ? asset.thumbnailUrl : img.thumbnailUrl) || ('imageUrl' in asset ? asset.imageUrl : img.imageUrl);
    const isUpscale = isImageUpscaleGalleryItem(img);
    return isVideo ? (
      <>
        <ViewportVideoPreview
          src={videoUrl!}
          posterSrc={src}
          priority={priority}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
        />
        <span className="gallery-card-batch-badge">视频</span>
      </>
    ) : src ? (
      <>
        <img src={resolveMediaUrl(src)} alt="" loading={priority ? 'eager' : 'lazy'} decoding="async" fetchPriority={priority ? 'high' : 'auto'}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        {isUpscale && (
          <>
            <span className="gallery-card-upscale-ribbon">图片放大</span>
            <span className="gallery-card-upscale-after">放大后</span>
            <span className="gallery-card-upscale-corner" aria-hidden="true" />
          </>
        )}
      </>
    ) : <Images size={24} className="text-text-2 opacity-30" />;
  }
  return (
    <div className="grid grid-cols-2 grid-rows-2 w-full h-full gap-px bg-white/50">
      {assets.map((asset, assetIndex) => (
        <GalleryPreviewImage key={asset.id ?? assetIndex} asset={asset as GalleryImageAssetView} priority={priority && assetIndex < 2} />
      ))}
    </div>
  );
}

/** 多图卡片单张缩略图；失败时隐藏坏图，避免整张卡片断裂。 */
function GalleryPreviewImage({ asset, priority }: { asset: GalleryImageAssetView; priority: boolean }) {
  if (asset.mediaType === 'video' && asset.videoUrl) {
    return <ViewportVideoPreview src={asset.videoUrl} posterSrc={asset.thumbnailUrl || asset.imageUrl} priority={priority} className="w-full h-full object-cover" />;
  }
  const src = asset.thumbnailUrl || asset.imageUrl;
  return src ? (
    <img src={resolveMediaUrl(src)} alt="" loading={priority ? 'eager' : 'lazy'} decoding="async" fetchPriority={priority ? 'high' : 'auto'}
      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
  ) : <span className="flex items-center justify-center"><Images size={16} className="text-text-2 opacity-30" /></span>;
}

/** 读取未登录公开图库页面缓存；过期时同步清理，避免返回图库展示陈旧页面。 */
function readGalleryClientCache(key: string): GalleryResponse | undefined {
  const cached = galleryClientCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    galleryClientCache.delete(key);
    return undefined;
  }
  return cached.data;
}

/** 写入未登录公开图库页面缓存；限制容量，避免长时间浏览大量筛选页导致内存增长。 */
function writeGalleryClientCache(key: string, data: GalleryResponse): void {
  galleryClientCache.set(key, { data, expiresAt: Date.now() + GALLERY_CLIENT_CACHE_TTL_MS });
  if (galleryClientCache.size <= 20) return;
  const firstKey = galleryClientCache.keys().next().value as string | undefined;
  if (firstKey) galleryClientCache.delete(firstKey);
}
