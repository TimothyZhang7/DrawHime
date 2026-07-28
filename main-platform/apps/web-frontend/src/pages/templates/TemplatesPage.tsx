/** 模板列表 — 全部 / 我的 / 收藏 / 副本四个选项卡，使用与图库一致的 URL 分页控件。 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { resolveMediaUrl } from '../../lib/media';
import { Layout, Heart, Plus, Loader2, User as UserIcon, Copy, Search, X, Trash2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

type Tpl = {
  id: number; name: string; description: string; promptTemplate: string;
  defaultValues?: string; sourceTemplateId?: number;
  coverImageUrls: string[]; isPublic: boolean;
  isFavorited: boolean; favoriteCount: number;
  userId: number; username: string; createdAt: string;
};

const TABS = [
  { key: 'all', label: '全部模板' },
  { key: 'mine', label: '我的模板' },
  { key: 'favorites', label: '我的收藏' },
  { key: 'copies', label: '我的副本' },
] as const;

const TEMPLATE_PAGE_SIZE = 20;

/** 生成图库同款、围绕当前页的连续页码。 */
function buildQuickPages(page: number, totalPages: number): number[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  let start = page - 3;
  let end = page + 3;
  if (start < 1) { end += 1 - start; start = 1; }
  if (end > totalPages) { start -= end - totalPages; end = totalPages; }
  return Array.from({ length: Math.max(1, end - Math.max(1, start) + 1) }, (_, index) => Math.max(1, start) + index);
}

export function TemplatesPage() {
  const [params, setParams] = useSearchParams();
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [tab, setTab] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const rawPage = Number(params.get('page') ?? '1');
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const [total, setTotal] = useState(0);
  const [jumpInput, setJumpInput] = useState('');
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const totalPages = Math.max(1, Math.ceil(total / TEMPLATE_PAGE_SIZE));

  /** 分页状态写入 URL，刷新与分享链接仍停留在同一页。 */
  const setPageParam = useCallback((nextPage: number) => {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (nextPage <= 1) next.delete('page');
      else next.set('page', String(nextPage));
      return next;
    });
  }, [setParams]);

  const fetch = useCallback(async (requestedPage: number) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (tab === 'mine') params.set('my', 'true');
    if (tab === 'favorites') params.set('favorite', 'true');
    if (tab === 'copies') { params.set('my', 'true'); params.set('source', 'copies'); }
    if (search.trim()) params.set('search', search.trim());
    params.set('page', String(requestedPage));
    params.set('pageSize', String(TEMPLATE_PAGE_SIZE));
    const d = await api<{ items: Tpl[]; total: number; page: number; pageSize: number }>(`/api/templates?${params}`);
    if (d.ok && d.data) {
      const nextTotal = d.data.total ?? 0;
      const nextTotalPages = Math.max(1, Math.ceil(nextTotal / TEMPLATE_PAGE_SIZE));
      if (nextTotal > 0 && requestedPage > nextTotalPages) {
        setPageParam(nextTotalPages);
        return;
      }
      setTemplates(d.data.items ?? []);
      setTotal(nextTotal);
    }
    setLoading(false);
  }, [setPageParam, tab, search]);

  // 切换选项卡/搜索时重置
  useEffect(() => { void fetch(page); }, [fetch, page]);
  useEffect(() => { api<{ id: number }>('/auth/me').then(d => { if (d.ok && d.data) setCurrentUserId(d.data.id); }); }, []);

  const goPage = useCallback((nextPage: number) => {
    if (nextPage < 1 || nextPage > totalPages || nextPage === page) return;
    setPageParam(nextPage);
    window.scrollTo(0, 0);
  }, [page, setPageParam, totalPages]);
  const quickPages = useMemo(() => buildQuickPages(page, totalPages), [page, totalPages]);

  const toggleFav = async (id: number) => {
    const d = await api<{ favorited: boolean; favoriteCount: number }>(`/api/templates/${id}/favorite`, { method: 'POST' });
    if (d.ok) {
      setTemplates(prev => {
        const updated = prev.map(t => t.id === id ? { ...t, isFavorited: d.data!.favorited, favoriteCount: d.data!.favoriteCount } : t);
        // 收藏选项卡中取消收藏后立即从列表移除
        if (tab === 'favorites' && !d.data!.favorited) return updated.filter(t => t.id !== id);
        return updated;
      });
      if (tab === 'favorites') void fetch(page);
    }
  };

  const [deletingId, setDeletingId] = useState<number | null>(null);

  const deleteTemplate = async (t: Tpl) => {
    if (!window.confirm(`确定删除「${t.name}」？此操作不可撤销。`)) return;
    setDeletingId(t.id);
    try {
      const d = await api(`/api/templates/${t.id}`, { method: 'DELETE' });
      if (d.ok) {
        void fetch(page);
      } else {
        alert(d.message ?? '删除失败，请稍后重试');
      }
    } catch {
      alert('网络异常，请检查后端服务');
    }
    setDeletingId(null);
  };

  const togglePublic = async (t: Tpl) => {
    const next = !t.isPublic;
    // 乐观更新
    setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, isPublic: next } : x));
    const d = await api(`/api/templates/${t.id}`, {
      method: 'PUT',
      body: JSON.stringify({ isPublic: next }),
    });
    if (!d.ok) {
      // 回滚
      setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, isPublic: !next } : x));
      alert(d.message ?? '切换失败');
    }
  };

  const emptyText = () => {
    switch (tab) {
      case 'copies': return '还没有保存副本，在模板使用页点击"另存为副本"即可';
      case 'favorites': return '还没有收藏模板，点击心形图标收藏';
      case 'mine': return '你还没有创建模板';
      default: return '暂无公开模板';
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="page-title flex items-center gap-2"><Layout size={20} />模板</h1>
        <Link to="/templates/new" className="btn btn-sm flex items-center gap-1"><Plus size={14} />新建模板</Link>
      </div>

      {/* 搜索 */}
      <div className="mb-4">
        <div className="input flex items-center gap-2" style={{ maxWidth: 360 }}>
          <Search size={14} className="text-text-2 flex-shrink-0" />
          <input
            placeholder="搜索模板名称或提示词..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && setPageParam(1)}
            className="flex-1"
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13 }}
          />
          {search && (
            <button onClick={() => { setSearch(''); setPageParam(1); }} className="flex-shrink-0" style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>
              <X size={14} className="text-text-2 hover:text-text" />
            </button>
          )}
        </div>
      </div>

      {/* 选项卡 */}
      <div className="flex gap-0 border-b border-border mb-5 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.key} onClick={() => { setTab(t.key); setPageParam(1); }}
            className={`tab ${tab === t.key ? 'active' : ''}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* 内容 */}
      {loading ? (
        <div className="text-center py-16 text-text-2 flex items-center justify-center gap-2">
          <Loader2 size={16} className="animate-spin" />加载中...
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-16 text-text-2 flex flex-col items-center gap-3">
          <Layout size={28} />
          <span>{emptyText()}</span>
          <Link to="/templates/new" className="btn btn-sm">创建模板</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {templates.map(t => (
            <div key={t.id} className="card flex gap-4 group relative" style={{ padding: 0, overflow: 'hidden' }}>
              {/* 封面 — 占卡片高度主体 */}
              <Link to={`/templates/${t.id}`} className="flex-shrink-0 bg-bg flex items-center justify-center overflow-hidden no-underline"
                style={{ width: 140, minHeight: 150 }}>
                {t.coverImageUrls.length > 0 ? (
                  <img src={resolveMediaUrl(t.coverImageUrls[0])} alt="" loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <Layout size={32} className="text-text-2 opacity-30" />
                )}
              </Link>

              {/* 信息 — flex 列布局，让底部操作始终对齐 */}
              <div className="flex-1 min-w-0 py-3 pr-3 flex flex-col">
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <Link to={`/templates/${t.id}`} className="text-sm font-semibold hover:text-primary truncate">{t.name}</Link>
                  {t.sourceTemplateId && (
                    <span className="badge text-[10px] flex items-center gap-0.5" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning)' }}>
                      <Copy size={9} />副本
                    </span>
                  )}
                  {/* 公开/私密状态 + 切换 */}
                  {currentUserId === t.userId ? (
                    <button onClick={() => togglePublic(t)}
                      className="badge text-[10px] cursor-pointer border-0"
                      style={t.isPublic
                        ? { background: '#dcfce7', color: '#16a34a' }
                        : { background: '#f3f4f6', color: '#6b7280' }}
                      title={t.isPublic ? '点击设为私密' : '点击设为公开'}>
                      {t.isPublic ? '公开' : '私密'}
                    </button>
                  ) : (
                    t.isPublic && <span className="badge text-[10px]" style={{ background: '#dcfce7', color: '#16a34a' }}>公开</span>
                  )}
                </div>
                {/* 优先展示描述，描述为空才展示模板内容前几段 */}
                <div className="text-xs text-text-2 leading-relaxed mb-3 line-clamp-3 flex-1">
                  {(t.description || t.promptTemplate).slice(0, 160)}
                </div>
                {/* 作者 + 操作 — 始终在卡片底部 */}
                <div className="flex items-center justify-between text-xs text-text-2">
                  <span className="flex items-center gap-1"><UserIcon size={11} />{t.username}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggleFav(t.id)}
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
                      className={`flex items-center gap-1 ${t.isFavorited ? 'text-accent' : 'text-text-2 hover:text-accent'}`}>
                      <Heart size={12} fill={t.isFavorited ? 'currentColor' : 'none'} />{t.favoriteCount}
                    </button>
                    {currentUserId === t.userId && (
                      <button onClick={() => deleteTemplate(t)}
                        disabled={deletingId === t.id}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '1px 4px' }}
                        className="flex items-center gap-1 text-text-2 hover:text-error text-[11px]"
                        title="删除模板">
                        <Trash2 size={12} />{deletingId === t.id ? '删除中' : '删除'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* 模板分页器与图库保持一致：页码、首尾跳转和手动跳页都基于后端真实总数。 */}
      {!loading && totalPages > 1 && templates.length > 0 && (
        <div className="card flex flex-col gap-3 p-3 mt-6" style={{ borderRadius: 8 }}>
          <div className="text-xs text-text-2 text-center">第 {page} 页 / 共 {totalPages} 页 · {total} 个模板</div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs" disabled={page <= 1} onClick={() => goPage(1)}><ChevronsLeft size={14} /></button>
            <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs" disabled={page <= 1} onClick={() => goPage(page - 1)}><ChevronLeft size={14} /></button>
            {quickPages.map((number) => <button key={number} className={`btn btn-sm !h-8 !w-9 !px-0 text-xs ${number === page ? 'bg-primary text-white' : 'btn-outline'}`} disabled={number === page} onClick={() => goPage(number)}>{number}</button>)}
            <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs" disabled={page >= totalPages} onClick={() => goPage(page + 1)}><ChevronRight size={14} /></button>
            <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs" disabled={page >= totalPages} onClick={() => goPage(totalPages)}><ChevronsRight size={14} /></button>
            <div className="flex items-center gap-1.5 ml-1">
              <input className="input !h-8 !w-16 text-center text-xs" inputMode="numeric" pattern="[0-9]*" placeholder="页码" value={jumpInput} onChange={event => setJumpInput(event.target.value.replace(/[^\d]/g, ''))} onKeyDown={event => { if (event.key === 'Enter') { const target = Number(jumpInput); if (target >= 1 && target <= totalPages) { goPage(target); setJumpInput(''); } } }} />
              <button className="btn btn-outline btn-sm !h-8 !px-2 text-xs" disabled={!jumpInput} onClick={() => { const target = Number(jumpInput); if (target >= 1 && target <= totalPages) { goPage(target); setJumpInput(''); } }}>跳转</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
