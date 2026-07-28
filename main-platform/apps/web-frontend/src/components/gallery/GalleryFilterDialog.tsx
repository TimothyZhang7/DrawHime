/** 本文件提供公开图库筛选弹窗，集中设置生成类型、排序和标签筛选范围。 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search, Tags, X } from 'lucide-react';
import type { GalleryImageToImageKind, GalleryPopularTagView, GalleryTagMatchMode } from '@aiimage/shared-contracts';
import './GalleryFilterDialog.css';

export type GalleryFilterDialogValue = {
  /** 生成模式筛选。 */
  mode: string;
  /** 图生图细分筛选。 */
  i2iKind?: GalleryImageToImageKind;
  /** 图库排序方式。 */
  sort: string;
  /** 已选择的中文标签名或 slug。 */
  tags: string[];
  /** 标签匹配范围。 */
  tagMatch: GalleryTagMatchMode;
};

type GalleryFilterDialogProps = {
  /** 弹窗是否打开。 */
  open: boolean;
  /** 当前 URL 中生效的筛选值。 */
  value: GalleryFilterDialogValue;
  /** 热门标签列表，颜色和权重都来自后端真实标签。 */
  popularTags: GalleryPopularTagView[];
  /** 热门标签是否已经完成加载。 */
  popularTagsLoaded: boolean;
  /** 热门标签加载是否失败。 */
  popularTagsError: boolean;
  /** 应用筛选。 */
  onApply: (value: GalleryFilterDialogValue) => void;
  /** 关闭弹窗。 */
  onClose: () => void;
};

const MODE_OPTIONS: Array<{ key: string; label: string; mode: string; i2iKind?: GalleryImageToImageKind }> = [
  { key: 'all', label: '全部', mode: '' },
  { key: 'text-to-image', label: '文生图', mode: 'text-to-image' },
  { key: 'image-to-image', label: '图生图', mode: 'image-to-image' },
  { key: 'image-to-image-describe', label: '描述生成', mode: 'image-to-image', i2iKind: 'describe' },
  { key: 'image-to-image-replace', label: '替换生成', mode: 'image-to-image', i2iKind: 'replace' },
  // 视频任务沿用 backend 的真实 mode，筛选时不混入图片细分条件。
  { key: 'text-to-video', label: '文生视频', mode: 'text-to-video' },
  { key: 'image-to-video', label: '参考图视频', mode: 'image-to-video' },
] as const;

const SORT_OPTIONS = [
  { key: 'latest', label: '最新' },
  { key: 'popular', label: '热门' },
  { key: 'random', label: '随机' },
] as const;

const TAG_MATCH_OPTIONS: Array<{ key: GalleryTagMatchMode; label: string }> = [
  { key: 'any', label: '任一标签' },
  { key: 'all', label: '同时包含' },
];

/** 公开图库筛选弹窗；内部状态只在应用后写回 URL，取消不会影响当前列表。 */
export function GalleryFilterDialog({
  open,
  value,
  popularTags,
  popularTagsLoaded,
  popularTagsError,
  onApply,
  onClose,
}: GalleryFilterDialogProps) {
  const [draft, setDraft] = useState<GalleryFilterDialogValue>(value);
  const [tagKeyword, setTagKeyword] = useState('');

  useEffect(() => {
    if (!open) return;
    setDraft(value);
    setTagKeyword('');
  }, [open, value]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const selectedSet = useMemo(() => new Set(draft.tags), [draft.tags]);
  const filteredTags = useMemo(() => {
    const keyword = tagKeyword.trim().toLowerCase();
    if (!keyword) return popularTags;
    return popularTags.filter((tag) => (
      tag.name.toLowerCase().includes(keyword) || tag.slug.toLowerCase().includes(keyword)
    ));
  }, [popularTags, tagKeyword]);

  if (!open || typeof document === 'undefined') return null;

  const toggleTag = (tag: GalleryPopularTagView) => {
    setDraft((current) => {
      const exists = current.tags.includes(tag.name) || current.tags.includes(tag.slug);
      const nextTags = exists
        ? current.tags.filter((item) => item !== tag.name && item !== tag.slug)
        : [...current.tags, tag.name].slice(0, 8);
      return { ...current, tags: nextTags };
    });
  };

  const clearDraft = () => {
    setDraft({ mode: '', sort: 'latest', tags: [], tagMatch: 'any', i2iKind: undefined });
    setTagKeyword('');
  };

  const currentModeKey = buildModeOptionKey(draft);

  const dialog = (
    <div className="gallery-filter-overlay" onMouseDown={onClose}>
      <section className="gallery-filter-dialog" role="dialog" aria-modal="true" aria-label="图库筛选" onMouseDown={(event) => event.stopPropagation()}>
        <header className="gallery-filter-head">
          <div className="gallery-filter-title">
            <span><Tags size={16} /></span>
            <strong>筛选图库</strong>
          </div>
          <button type="button" className="gallery-filter-icon-button" onClick={onClose} aria-label="关闭筛选"><X size={16} /></button>
        </header>

        <div className="gallery-filter-body">
          <div className="gallery-filter-control-column">
            <section className="gallery-filter-section">
              <div className="gallery-filter-section-title">生成类型</div>
              <div className="gallery-filter-mode-grid">
                {MODE_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={currentModeKey === option.key ? 'is-active' : ''}
                    onClick={() => setDraft((current) => ({ ...current, mode: option.mode, i2iKind: option.i2iKind }))}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="gallery-filter-section">
              <div className="gallery-filter-section-title">排序</div>
              <div className="gallery-filter-segment">
                {SORT_OPTIONS.map((option) => (
                  <button key={option.key} type="button" className={draft.sort === option.key ? 'is-active' : ''} onClick={() => setDraft((current) => ({ ...current, sort: option.key }))}>
                    {option.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="gallery-filter-section">
              <div className="gallery-filter-section-title">标签范围</div>
              <div className="gallery-filter-segment is-two">
                {TAG_MATCH_OPTIONS.map((option) => (
                  <button key={option.key} type="button" className={draft.tagMatch === option.key ? 'is-active' : ''} onClick={() => setDraft((current) => ({ ...current, tagMatch: option.key }))}>
                    {option.label}
                  </button>
                ))}
              </div>
            </section>
          </div>

          <section className="gallery-filter-section gallery-filter-tag-section">
            <div className="gallery-filter-tag-toolbar">
              <div className="gallery-filter-section-title">标签</div>
              <div className="gallery-filter-tag-search">
                <Search size={13} />
                <input value={tagKeyword} onChange={(event) => setTagKeyword(event.target.value)} placeholder="搜索标签" />
              </div>
            </div>
            <div className="gallery-filter-tag-grid">
              {filteredTags.length > 0 ? filteredTags.map((tag) => {
                const active = selectedSet.has(tag.name) || selectedSet.has(tag.slug);
                return (
                  <button
                    key={tag.slug || tag.name}
                    type="button"
                    className={`gallery-filter-tag${active ? ' is-active' : ''}`}
                    style={{ backgroundColor: tag.color.bg, color: tag.color.text, borderColor: tag.color.border }}
                    onClick={() => toggleTag(tag)}
                    title={`${tag.name} · ${tag.count} 张`}
                  >
                    <span>{tag.name}</span>
                    <em>{tag.count}</em>
                    <i aria-hidden="true">{active ? <Check size={12} /> : null}</i>
                  </button>
                );
              }) : (
                <span className="gallery-filter-empty">{popularTagsLoaded ? (popularTagsError ? '标签暂不可用' : '无匹配标签') : '标签加载中'}</span>
              )}
            </div>
          </section>
        </div>

        <footer className="gallery-filter-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={clearDraft}>清空</button>
          <button type="button" className="btn btn-sm" onClick={() => onApply(draft)}>应用筛选</button>
        </footer>
      </section>
    </div>
  );

  return createPortal(dialog, document.body);
}

/** 根据当前筛选值解析生成类型按钮高亮；图生图细分优先于通用图生图。 */
function buildModeOptionKey(value: GalleryFilterDialogValue): string {
  if (value.mode === 'image-to-image' && value.i2iKind === 'describe') return 'image-to-image-describe';
  if (value.mode === 'image-to-image' && value.i2iKind === 'replace') return 'image-to-image-replace';
  if (value.mode === 'image-to-image') return 'image-to-image';
  if (value.mode === 'text-to-image') return 'text-to-image';
  if (value.mode === 'text-to-video') return 'text-to-video';
  if (value.mode === 'image-to-video') return 'image-to-video';
  return 'all';
}
