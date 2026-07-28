/** 本文件提供图库中文标签渲染组件，统一处理权重排序、固定配色和标签筛选跳转。 */
import type { MouseEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GalleryTagView } from '@aiimage/shared-contracts';
import './GalleryTags.css';

type GalleryTagsProps = {
  /** 后端返回的标签列表，已按权重降序；组件仍会兜底排序。 */
  tags?: GalleryTagView[];
  /** 最多展示数量；详情页可不传以展示全部。 */
  limit?: number;
  /** 组件尺寸。 */
  size?: 'compact' | 'normal';
  /** 额外 className。 */
  className?: string;
  /** 当前筛选中的标签名或 slug，用于热门标签入口高亮。 */
  activeTag?: string;
  /** 当前筛选中的多个标签名或 slug，用于新图库筛选高亮。 */
  activeTags?: string[];
  /** 是否展示公开使用数量。 */
  showCount?: boolean;
  /** 是否根据容器宽度显示 +N 省略标签。 */
  showOmit?: boolean;
  /** 启用省略时最多展示行数。 */
  maxRows?: number;
  /** 容器宽度未测量前兜底展示数量。 */
  fallbackVisibleCount?: number;
  /** 自定义标签点击行为；图库页用它接入多标签筛选 URL，详情页保留默认跳转。 */
  onTagClick?: (tag: GalleryTagView) => void;
};

/** 图库标签列表；点击标签进入公开图库精确筛选。 */
export function GalleryTags({
  tags = [],
  limit,
  size = 'compact',
  className = '',
  activeTag = '',
  activeTags = [],
  showCount = false,
  showOmit = false,
  maxRows = 1,
  fallbackVisibleCount = 2,
  onTagClick,
}: GalleryTagsProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const sorted = useMemo(() => [...tags]
    .sort((left, right) => right.weight - left.weight || left.name.localeCompare(right.name, 'zh-Hans-CN'))
    .slice(0, limit ?? tags.length), [limit, tags]);
  const layout = useMemo(() => {
    if (!showOmit) return { visible: sorted, omitted: [] };
    return calculateResponsiveTagLayout(sorted, containerWidth, {
      maxRows,
      fallbackVisibleCount,
      tagGap: size === 'compact' ? 4 : 5,
      tagFontSize: size === 'compact' ? 11 : 12,
      omitMinWidth: size === 'compact' ? 34 : 38,
      safetyOffset: 2,
    });
  }, [containerWidth, fallbackVisibleCount, maxRows, showOmit, size, sorted]);
  const visible = layout.visible;
  const omitted = layout.omitted;
  const activeTagSet = useMemo(() => new Set(activeTags.filter(Boolean)), [activeTags]);

  // 卡片标签需要按真实容器宽度决定是否显示 +N，避免不同屏宽下撑破卡片。
  useEffect(() => {
    if (!showOmit) return undefined;
    const element = containerRef.current;
    if (!element) return undefined;
    const updateWidth = () => setContainerWidth(element.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showOmit, sorted.length]);

  if (visible.length === 0 && omitted.length === 0) return null;

  const openTag = (event: MouseEvent<HTMLButtonElement>, tag: GalleryTagView) => {
    event.preventDefault();
    event.stopPropagation();
    if (onTagClick) {
      onTagClick(tag);
      return;
    }
    navigate(`/gallery?tags=${encodeURIComponent(tag.name)}`);
  };

  return (
    <div ref={containerRef} className={`gallery-tags is-${size}${showOmit ? ' with-omit' : ''} ${className}`.trim()}>
      {visible.map((tag) => {
        const tagWithCount = tag as GalleryTagView & { count?: number };
        const count = typeof tagWithCount.count === 'number' ? tagWithCount.count : null;
        const active = activeTag === tag.name || activeTag === tag.slug || activeTagSet.has(tag.name) || activeTagSet.has(tag.slug);
        return (
        <button
          key={tag.slug || tag.name}
          type="button"
          className={`gallery-tag-chip weight-${tag.weight >= 85 ? 'high' : tag.weight >= 65 ? 'mid' : 'low'}${active ? ' is-active' : ''}`}
          style={{
            backgroundColor: tag.color.bg,
            color: tag.color.text,
            borderColor: tag.color.border,
          }}
          onClick={(event) => openTag(event, tag)}
          title={count ? `${tag.name} · ${count} 张公开图 · 权重 ${tag.weight}` : `${tag.name} · 权重 ${tag.weight}`}
        >
          {tag.name}
          {showCount && count ? <span className="gallery-tag-count">{count}</span> : null}
        </button>
        );
      })}
      {showOmit && omitted.length > 0 ? (
        <span className="gallery-tag-chip gallery-tag-omit" title={omitted.map((item) => item.name).join('、')}>
          +{omitted.length}
        </span>
      ) : null}
    </div>
  );
}

type ResponsiveTagLayoutOptions = {
  maxRows: number;
  fallbackVisibleCount: number;
  tagGap: number;
  tagFontSize: number;
  omitMinWidth: number;
  safetyOffset: number;
};

/** 根据容器宽度计算两行标签和省略标签；逻辑参考 V2 首页卡片标签布局。 */
function calculateResponsiveTagLayout(
  tags: GalleryTagView[],
  containerWidth: number,
  options: ResponsiveTagLayoutOptions,
): { visible: GalleryTagView[]; omitted: GalleryTagView[] } {
  if (tags.length === 0) return { visible: [], omitted: [] };
  const availableWidth = Math.floor(containerWidth - options.safetyOffset);
  if (availableWidth <= 0) {
    const visible = tags.slice(0, options.fallbackVisibleCount);
    return { visible, omitted: tags.slice(visible.length) };
  }

  const tagWidths = tags.map((tag) => estimateTagWidth(tag.name, options.tagFontSize));
  for (let count = tags.length; count >= 0; count--) {
    const omittedCount = tags.length - count;
    const widths = tagWidths.slice(0, count);
    if (omittedCount > 0) widths.push(Math.max(options.omitMinWidth, estimateTagWidth(`+${omittedCount}`, options.tagFontSize)));
    if (fitsRows(widths, availableWidth, options.tagGap, options.maxRows)) {
      return { visible: tags.slice(0, count), omitted: tags.slice(count) };
    }
  }

  return { visible: [], omitted: tags };
}

/** 估算标签宽度；中文按全宽字估算，英文数字按窄字估算，保证布局稳定且不依赖 Canvas。 */
function estimateTagWidth(text: string, fontSize: number): number {
  const contentWidth = Array.from(text).reduce((sum, char) => (
    /[\u4e00-\u9fff]/.test(char) ? sum + fontSize : sum + fontSize * 0.62
  ), 0);
  return Math.ceil(contentWidth + 14);
}

/** 判断一组标签宽度能否在指定行数内放入容器。 */
function fitsRows(widths: number[], containerWidth: number, gap: number, maxRows: number): boolean {
  if (widths.length === 0) return true;
  let rows = 1;
  let rowWidth = 0;
  for (const rawWidth of widths) {
    const width = Math.min(rawWidth, containerWidth);
    const nextWidth = rowWidth === 0 ? width : rowWidth + gap + width;
    if (rowWidth > 0 && nextWidth > containerWidth) {
      rows++;
      rowWidth = width;
      if (rows > maxRows) return false;
    } else {
      rowWidth = nextWidth;
    }
  }
  return true;
}
