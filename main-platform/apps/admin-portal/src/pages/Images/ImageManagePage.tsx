/** 图片管理 — 浏览公开图片 + 删除 + 切换私密 (Tailwind + 原生图片网格) */
import { useState, useEffect } from 'react';
import { Lock, RefreshCw, Search, Trash2, Unlock } from 'lucide-react';
import { api } from '../../api/client';

const BASE = import.meta.env.VITE_API_BASE ?? '';
const PAGE_SIZE = 20;

type ImageRec = Record<string, unknown>;

/** 将后端图片地址规范为管理后台可访问地址，兼容历史远端直链和站内短路径。 */
function toImageUrl(url?: string): string {
  const value = String(url ?? '').trim();
  if (!value) return '';
  if (value.startsWith('data:') || value.startsWith('http://') || value.startsWith('https://')) return value;
  return `${BASE}${value.startsWith('/') ? value : `/images/${value}`}`;
}

/* ====== 简易 Toast（固定右下角，2.5s 自动消失） ====== */
function Toast({ text, type, done }: { text: string; type: 'success' | 'error'; done: () => void }) {
  useEffect(() => { const id = setTimeout(done, 2500); return () => clearTimeout(id); }, [done]);
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold shadow-lg animate-fade-in ${type === 'success' ? 'bg-success text-white' : 'bg-error text-white'}`}>
      <span>{text}</span>
      <button onClick={done} className="ml-1 opacity-70 hover:opacity-100 text-base leading-none">&times;</button>
    </div>
  );
}

/* ====== 简易确认弹窗 ====== */
function ConfirmModal({ title, onOk, onCancel }: { title: string; onOk: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }}>
      <div className="card p-6 w-80 animate-fade-in">
        <p className="text-sm mb-5">{title}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="btn btn-sm btn-outline">取消</button>
          <button onClick={onOk} className="btn btn-sm btn-danger">确定</button>
        </div>
      </div>
    </div>
  );
}

/* ====== 状态标签 ====== */
const STATUS_COLOR: Record<string, string> = { success: 'badge-success', failed: 'badge-error' };
function StatusBadge({ s }: { s: string }) {
  return <span className={`badge ${STATUS_COLOR[s] ?? 'badge-primary'}`}>{s}</span>;
}
function PrivacyBadge({ priv }: { priv: boolean }) {
  return <span className={`badge ${priv ? 'badge-error' : 'badge-success'}`}>{priv ? '私密' : '公开'}</span>;
}

/** 管理后台会话失效时直接提示，避免继续以为空白页是数据问题。 */
function AuthExpiredBanner() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-sm gap-3">
      <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-amber-700">
        <Lock size={14} />
        管理后台登录已失效
      </div>
      <div className="text-text-2 text-xs text-center">后台令牌无效时不会继续展示旧数据，请重新登录后刷新页面。</div>
    </div>
  );
}

/* ====== 主组件 ====== */
export function ImageManagePage() {
  const [images, setImages] = useState<ImageRec[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [delId, setDelId] = useState<string | null>(null); // 待删除 ID（触发确认弹窗）

  const fetchPage = async (p = 1) => {
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) });
    if (status) params.set('status', status);
    if (search.trim()) params.set('search', search.trim());
    const d = await api(`/admin/generations?${params}`);
    if (d.ok) {
      const data = d.data as { items: []; total: number };
      setImages(data.items ?? []);
      setTotal(data.total ?? 0);
      setPage(p);
    } else {
      setLoadError(d.message ?? '图库列表加载失败');
    }
    setLoading(false);
  };

  useEffect(() => { fetchPage(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toastOk = (t: string) => setToast({ text: t, type: 'success' });
  const toastErr = (t: string) => setToast({ text: t, type: 'error' });

  /** 删除图片记录 */
  const doDelete = async (id: string) => {
    const d = await api(`/admin/generations/${id}`, { method: 'DELETE' });
    if (d.ok) { toastOk('已删除'); fetchPage(page); }
    else toastErr(d.message ?? '删除失败');
  };

  /** 切换私密状态（直接执行，无需确认） */
  const togglePrivacy = async (id: string, isPrivate: boolean) => {
    const d = await api(`/admin/generations/${id}/privacy`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], isPrivate: !isPrivate }),
    });
    if (d.ok) { toastOk(isPrivate ? '已设为公开' : '已设为私密'); fetchPage(page); }
    else toastErr(d.message ?? '操作失败');
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  /* 分页按钮编号（含省略号） */
  const pageNums: (number | '...')[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageNums.push(i);
  } else {
    pageNums.push(1);
    if (page > 3) pageNums.push('...');
    const s = Math.max(2, page - 1);
    const e = Math.min(totalPages - 1, page + 1);
    for (let i = s; i <= e; i++) pageNums.push(i);
    if (page < totalPages - 2) pageNums.push('...');
    pageNums.push(totalPages);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部标题栏 */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">图片管理</h2>
            <span className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-text-2">共 {total} 条</span>
          </div>
          <p className="mt-1 text-xs text-text-2">查看生成图片、切换公开/私密和删除记录。</p>
        </div>
        <button onClick={() => fetchPage(page)} className="btn btn-sm btn-outline self-start lg:self-auto">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="card flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="input w-auto !w-32">
            <option value="">全部状态</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
            <option value="running">生成中</option>
            <option value="queued">排队</option>
          </select>
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-2" />
            <input
              placeholder="搜索提示词"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchPage(1)}
              className="input w-full pl-9 lg:w-72"
            />
          </div>
          <button onClick={() => fetchPage(1)} className="btn btn-sm btn-outline">
            <Search size={14} />
            搜索
          </button>
        </div>
        <div className="text-xs text-text-2">当前页 {Math.min(page, totalPages)} / {totalPages}，每页 {PAGE_SIZE} 条</div>
      </div>

      {/* ── 图片网格 ── */}
      <div className="card">
        {loading && images.length === 0 ? (
          <div className="flex items-center justify-center py-24 text-text-2 text-sm">加载中...</div>
        ) : loadError?.includes('权限') || loadError?.includes('登录') ? (
          <AuthExpiredBanner />
        ) : loadError && images.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-sm gap-3">
            <div className="rounded-full border border-red-100 bg-red-50 px-3 py-1 text-red-700">{loadError}</div>
            <button onClick={() => fetchPage(page)} className="btn btn-sm btn-outline">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              重新加载
            </button>
          </div>
        ) : images.length === 0 ? (
          <div className="flex items-center justify-center py-24 text-text-2 text-sm">暂无数据</div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {images.map(img => {
                const id = img.id as string;
                const imageUrl = img.imageUrl as string | undefined;
                const prompt = img.prompt as string;
                const st = img.status as string;
                const mode = img.mode as string;
                const isPrivate = !!img.isPrivate;
                const createdAt = (img.createdAt as string)?.slice(0, 19) ?? '';

                return (
                  <div
                    key={id}
                    className="group overflow-hidden rounded-2xl border bg-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    {/* 预览图 */}
                    <div className="relative aspect-square overflow-hidden bg-slate-100">
                      {imageUrl ? (
                        <img
                          src={toImageUrl(imageUrl)}
                          alt={prompt?.slice(0, 30)}
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                          loading="lazy"
                        />
                      ) : (
                        <span className="absolute inset-0 flex items-center justify-center text-xs text-soft">无预览</span>
                      )}
                      <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
                        <StatusBadge s={st} />
                        <PrivacyBadge priv={isPrivate} />
                      </div>
                    </div>
                    {/* 信息区 */}
                    <div className="space-y-3 p-4">
                      <div className="min-h-[2.75rem] text-[11px] leading-5 text-text-2 break-words line-clamp-3">{prompt?.slice(0, 100) || '-'}</div>
                      <div className="flex flex-wrap items-center gap-2 text-[10px] text-soft">
                        <span className="rounded-full bg-slate-100 px-2 py-1">{mode === 'image-to-image' ? '图生图' : '文生图'}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-1">{st || '-'}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-1">{createdAt}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button onClick={() => togglePrivacy(id, isPrivate)} className="btn btn-sm btn-outline">
                          {isPrivate ? <Unlock size={14} /> : <Lock size={14} />}
                          {isPrivate ? '公开' : '私密'}
                        </button>
                        <button onClick={() => setDelId(id)} className="btn btn-sm btn-danger">
                          <Trash2 size={14} />
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 加载更多骨架 */}
            {loading && images.length > 0 && (
              <div className="flex items-center justify-center py-6 text-text-2 text-sm">加载中...</div>
            )}

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="flex flex-wrap items-center justify-center gap-2 mt-6 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
                <button disabled={page <= 1} onClick={() => fetchPage(page - 1)} className="btn btn-sm btn-outline">上一页</button>
                {pageNums.map((p, i) =>
                  p === '...' ? (
                    <span key={`dots-${i}`} className="text-soft text-xs px-1">...</span>
                  ) : (
                    <button key={p} onClick={() => fetchPage(p)}
                      className={`btn btn-sm ${p === page ? '' : 'btn-outline'}`}
                      style={p === page ? { background: 'var(--color-primary)', color: '#fff', borderColor: 'var(--color-primary)' } : undefined}>
                      {p}
                    </button>
                  )
                )}
                <button disabled={page >= totalPages} onClick={() => fetchPage(page + 1)} className="btn btn-sm btn-outline">下一页</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 全局 Toast */}
      {toast && <Toast text={toast.text} type={toast.type} done={() => setToast(null)} />}

      {/* 删除确认弹窗 */}
      {delId && (
        <ConfirmModal
          title="确定删除该图片记录？"
          onOk={async () => { await doDelete(delId); setDelId(null); }}
          onCancel={() => setDelId(null)}
        />
      )}
    </div>
  );
}
