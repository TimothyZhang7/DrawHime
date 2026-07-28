/** 本组件负责在图片拆分工具中展示当前登录用户的成功生成图片，并返回原图地址供工具载入。 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, Image, Loader2, X } from 'lucide-react';
import { api } from '../../../lib/api';
import { resolveMediaUrl } from '../../../lib/media';

const PICKER_PAGE_SIZE = 18;

/** 拆图工具可选择的个人图片记录，imageUrl 必须指向原图。 */
export type GalleryPickerImage = {
  id: string;
  prompt?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  createdAt?: string;
};

type GalleryPickerPayload = {
  items: GalleryPickerImage[];
  total: number;
  page?: number;
  pageSize?: number;
};

type GalleryImagePickerProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (image: GalleryPickerImage) => void;
};

/** 当前用户图片选择弹窗：只列成功任务，选择时要求存在原图 imageUrl。 */
export function GalleryImagePicker({ open, onClose, onSelect }: GalleryImagePickerProps) {
  const [items, setItems] = useState<GalleryPickerImage[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const requestSeq = useRef(0);
  const totalPages = Math.max(1, Math.ceil(total / PICKER_PAGE_SIZE));

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setLoaded(false);
      return;
    }

    let alive = true;
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoading(true);
    setLoaded(false);
    setError('');

    void api<GalleryPickerPayload>(`/api/generations?pageSize=${PICKER_PAGE_SIZE}&page=${page}&status=success`)
      .then((result) => {
        if (!alive || requestSeq.current !== seq) return;
        if (result.ok && result.data) {
          setItems((result.data.items ?? []).filter((item) => Boolean(item.imageUrl)));
          setTotal(result.data.total ?? 0);
          return;
        }
        setItems([]);
        setTotal(0);
        setError(result.message || '图片记录读取失败');
      })
      .finally(() => {
        if (!alive || requestSeq.current !== seq) return;
        setLoading(false);
        setLoaded(true);
      });

    return () => {
      alive = false;
    };
  }, [open, page]);

  useEffect(() => {
    if (open) setPage(1);
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    // 弹窗打开时锁定页面滚动，保持选择器始终以浏览器视口居中展示。
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  const showInitialLoading = !loaded && loading;
  const dialog = (
    <div className="tool-gallery-picker-overlay" onClick={onClose}>
      <section className="tool-gallery-picker" role="dialog" aria-modal="true" aria-label="从我的图片选择" onClick={(event) => event.stopPropagation()}>
        <header className="tool-gallery-picker-head">
          <div>
            <h3>选择我的图片</h3>
            <span>{loading ? '正在读取我的图片' : '选择后会载入该记录的原图'}</span>
          </div>
          <button type="button" className="tool-gallery-picker-close" onClick={onClose} aria-label="关闭选择器">
            <X size={16} />
          </button>
        </header>

        {showInitialLoading ? (
          <div className="tool-gallery-picker-state"><Loader2 size={16} className="animate-spin" />正在读取我的图片</div>
        ) : error ? (
          <div className="tool-gallery-picker-state is-error">{error}</div>
        ) : items.length === 0 ? (
          <div className="tool-gallery-picker-state"><Image size={18} />暂无可选择图片</div>
        ) : (
          <div className="tool-gallery-picker-grid">
            {items.map((item) => (
              <button key={item.id} type="button" className="tool-gallery-picker-card" onClick={() => onSelect(item)}>
                <span className="tool-gallery-picker-thumb">
                  {item.thumbnailUrl || item.imageUrl ? (
                    <img src={resolveMediaUrl(item.thumbnailUrl || item.imageUrl)} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <Image size={18} />
                  )}
                </span>
                <span className="tool-gallery-picker-info">
                  <strong>{item.prompt?.slice(0, 36) || '未命名图片'}</strong>
                  <small>{item.createdAt?.slice(0, 10) || ''}</small>
                </span>
                <span className="tool-gallery-picker-check"><Check size={13} /></span>
              </button>
            ))}
            {loading && (
              <div className="tool-gallery-picker-refreshing">
                <Loader2 size={14} className="animate-spin" />正在刷新
              </div>
            )}
          </div>
        )}

        <footer className="tool-gallery-picker-footer">
          <button type="button" className="btn btn-sm btn-outline" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            <ChevronLeft size={13} />上一页
          </button>
          <span>{page} / {totalPages}</span>
          <button type="button" className="btn btn-sm btn-outline" disabled={page >= totalPages || loading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
            下一页<ChevronRight size={13} />
          </button>
        </footer>
      </section>
    </div>
  );

  // 选择器必须挂到 body，避免受工具页面滚动容器、sticky 区域或祖先 transform 影响定位。
  return typeof document === 'undefined' ? null : createPortal(dialog, document.body);
}
