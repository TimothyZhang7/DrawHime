/** 我的图片 — 个人生成记录 */
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { resolveMediaUrl } from '../../lib/media';
import { Images, Heart, Eye, Loader2, Trash2, Lock, Globe } from 'lucide-react';

type Img = { id: string; batchId?: string; batchTotal?: number; prompt: string; imageUrl: string; thumbnailUrl?: string; likeCount: number; viewCount: number; status: string; isPrivate: boolean; error?: string; createdAt: string };
/** 旧我的图片页首屏缩略图优先级数量，避免大量图片同时抢占主图加载。 */
const MY_IMAGES_HIGH_PRIORITY_COUNT = 8;

export function MyImagesPage() {
  const [images, setImages] = useState<Img[]>([]);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  const fetch = useCallback(async () => {
    setLoading(true);
    const d = await api<{ items: Img[]; total: number }>(`/api/generations?page=${page}&pageSize=20${status ? `&status=${status}` : ''}`);
    if (d.ok) { setImages(d.data!.items); setTotal(d.data!.total); }
    setLoading(false);
  }, [status, page]);
  useEffect(() => { fetch(); }, [fetch]);

  const togglePrivacy = async (id: string, isPrivate: boolean) => {
    await api(`/api/generations/privacy`, { method: 'PATCH', body: JSON.stringify({ ids: [id], isPrivate: !isPrivate }) });
    setImages(prev => prev.map(i => i.id === id ? { ...i, isPrivate: !isPrivate } : i));
  };

  const deleteImage = async (id: string) => {
    await api(`/api/generations`, { method: 'DELETE', body: JSON.stringify({ ids: [id] }) });
    setImages(prev => prev.filter(i => i.id !== id));
  };

  const statusColor = (s: string) => s === 'success' ? 'var(--color-success)' : s === 'failed' ? 'var(--color-error)' : 'var(--color-primary)';
  const statusLabel = (s: string) => s === 'success' ? '成功' : s === 'failed' ? '失败' : s === 'running' ? '进行中' : '排队中';

  return (
    <div>
      <h1 className="page-title mb-5 flex items-center gap-2"><Images size={20} />我的图片</h1>
      <div className="flex gap-3 mb-5">
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="input" style={{ width: 120, cursor: 'pointer' }}>
          <option value="">全部</option><option value="success">成功</option><option value="failed">失败</option><option value="running">进行中</option>
        </select>
        <span className="text-sm text-text-2 flex items-center">共 {total} 张</span>
      </div>

      {loading ? <div className="text-center py-16 text-text-2 flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />加载中...</div>
        : images.length === 0 ? <div className="text-center py-16 text-text-2 flex flex-col items-center gap-3"><Images size={28} /><span>暂无图片</span><Link to="/" className="btn btn-sm">开始创作</Link></div>
          : <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {images.map((img, index) => (
              <div key={img.id} className="bg-surface border border-border">
                <Link to={`/image/${getVisibleImageEntryId(img)}`} className="block">
                  <div className="aspect-square bg-bg flex items-center justify-center overflow-hidden">
                    {img.thumbnailUrl ? <img src={resolveMediaUrl(img.thumbnailUrl)} alt="" className="w-full h-full object-cover" loading="eager" decoding="async" fetchPriority={index < MY_IMAGES_HIGH_PRIORITY_COUNT ? 'high' : 'auto'} /> : <Images size={24} className="text-text-2" />}
                  </div>
                </Link>
                <div className="p-2.5">
                  <div className="flex items-center gap-1 mb-1">
                    <span className="text-xs font-medium" style={{ color: statusColor(img.status) }}>{statusLabel(img.status)}</span>
                    <span className="flex-1" />
                    <button onClick={() => togglePrivacy(img.id, img.isPrivate)} title={img.isPrivate ? '设为公开' : '设为私密'} className="flex items-center">
                      {img.isPrivate ? <Lock size={11} className="text-text-2 hover:text-primary" /> : <Globe size={11} className="text-text-2 hover:text-primary" />}
                    </button>
                    <button onClick={() => deleteImage(img.id)} title="删除" className="flex items-center ml-1"><Trash2 size={11} className="text-text-2 hover:text-error" /></button>
                  </div>
                  <div className="text-xs text-text truncate">{img.prompt.slice(0, 50)}</div>
                  {img.error && <div className="text-xs text-error truncate mt-0.5">{img.error.slice(0, 30)}</div>}
                  <div className="flex justify-between mt-1.5 text-xs text-text-2">
                    <span className="flex items-center gap-1"><Heart size={10} />{img.likeCount}</span><span className="flex items-center gap-1"><Eye size={10} />{img.viewCount}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>}
      {total > 20 && <div className="flex justify-center mt-6 gap-2">
        <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="btn btn-outline btn-sm">上一页</button>
        <span className="text-sm text-text-2 flex items-center px-3">{page}/{Math.ceil(total / 20)}</span>
        <button onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total} className="btn btn-outline btn-sm">下一页</button>
      </div>}
    </div>
  );
}

/** 外显图片详情入口统一使用批次 ID；管理操作仍使用真实单图任务 ID。 */
function getVisibleImageEntryId(item: Pick<Img, 'id' | 'batchId' | 'batchTotal'>) {
  return item.batchId && (item.batchTotal ?? 1) > 1 ? item.batchId : item.id;
}
