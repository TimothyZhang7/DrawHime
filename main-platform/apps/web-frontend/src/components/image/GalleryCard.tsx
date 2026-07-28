/** 图库图片卡片 */
import { Link } from 'react-router-dom';
import { Images, Heart, Eye } from 'lucide-react';
import { resolveMediaUrl } from '../../lib/media';

type Props = { id: string; prompt: string; imageUrl: string; thumbnailUrl?: string; likeCount: number; viewCount: number };

export function GalleryCard({ id, prompt, imageUrl, thumbnailUrl, likeCount, viewCount }: Props) {
  return (
    <Link to={`/image/${id}`} className="group block no-underline overflow-hidden" style={{ background: 'var(--color-surface)' }}>
      <div className="aspect-square flex items-center justify-center overflow-hidden" style={{ background: 'var(--color-bg)' }}>
        {imageUrl ? (
          <img src={resolveMediaUrl(thumbnailUrl || imageUrl)} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="eager" decoding="async" fetchPriority="auto" />
        ) : (
          <Images size={24} className="text-text-2" />
        )}
      </div>
      <div className="px-1.5 py-2">
        <div className="text-[11px] text-text-2 leading-snug line-clamp-1">{prompt.slice(0, 60)}</div>
        <div className="flex items-center gap-3 mt-1 text-[10px] text-text-2">
          <span className="flex items-center gap-0.5"><Heart size={10} />{likeCount}</span>
          <span className="flex items-center gap-0.5"><Eye size={10} />{viewCount}</span>
        </div>
      </div>
    </Link>
  );
}

export function GallerySkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="overflow-hidden" style={{ background: 'var(--color-surface)' }}>
          <div className="aspect-square skeleton" style={{ borderRadius: 0 }} />
          <div className="px-1.5 py-2"><div className="skeleton h-2.5 mb-1.5" /><div className="skeleton h-1.5 w-2/3" /></div>
        </div>
      ))}
    </div>
  );
}
