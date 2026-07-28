/** 本文件实现公开用户主页，可通过 /users/:id 查看指定 Web 用户的公开作品。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { UserPublicProfileImage, UserPublicProfileResponse } from '@aiimage/shared-contracts';
import { ArrowLeft, CalendarDays, Copy, Eye, Heart, Image, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { getAvatarInitial } from '../../lib/avatar';
import { resolveMediaUrl } from '../../lib/media';
import { formatDrawingModelNameByMap, useDrawingModelDisplayMap } from '../../lib/drawingModelDisplay';
import { Seo } from '../../components/Seo';
import './UserPublicProfilePage.css';

const PROFILE_PAGE_SIZE = 24;

/** 公开用户主页。 */
export function UserPublicProfilePage() {
  const { id } = useParams<{ id: string }>();
  const modelDisplayMap = useDrawingModelDisplayMap();
  const userId = Number(id);
  const [data, setData] = useState<UserPublicProfileResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const requestSeq = useRef(0);

  const load = useCallback(async (nextPage = page) => {
    if (!Number.isInteger(userId) || userId <= 0) {
      setData(null);
      setError('用户 ID 不正确');
      setLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    const result = await api<UserPublicProfileResponse>(`/api/users/${userId}/public-profile?page=${nextPage}&pageSize=${PROFILE_PAGE_SIZE}`);
    if (seq !== requestSeq.current) return;
    if (result.ok && result.data) {
      setData(result.data);
      setPage(result.data.page);
      setError('');
    } else {
      setData(null);
      setError(result.message || '用户主页加载失败');
    }
    setLoading(false);
  }, [page, userId]);

  useEffect(() => {
    setPage(1);
    void load(1);
  }, [id]);

  /** 复制当前用户主页固定链接。 */
  const copyProfileLink = useCallback(async () => {
    const url = `${window.location.origin}/users/${userId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }, [userId]);

  if (loading && !data) {
    return (
      <div className="user-profile-page animate-fade-in">
        <Seo title="用户主页" description="查看绘图姬 DrawHime 用户公开主页、公开作品和公开图片统计。" path={`/users/${id ?? ''}`} />
        <div className="user-profile-skeleton-head card">
          <div className="skeleton user-profile-skeleton-avatar" />
          <div className="user-profile-skeleton-copy">
            <div className="skeleton h-7 w-48" />
            <div className="skeleton h-3 w-72" />
          </div>
        </div>
        <div className="user-profile-stat-grid">
          {Array.from({ length: 4 }).map((_, index) => <div key={index} className="card"><div className="skeleton h-4 mb-3" /><div className="skeleton h-7 w-2/3" /></div>)}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="user-profile-page animate-fade-in">
        <Seo title="用户不存在" description="该绘图姬 DrawHime 用户主页不存在或暂不可访问。" path={`/users/${id ?? ''}`} index={false} />
        <div className="user-profile-empty card">
          <XCircle size={32} />
          <strong>{error}</strong>
          <div className="user-profile-empty-actions">
            <Link to="/gallery" className="btn btn-outline btn-sm"><ArrowLeft size={13} />返回图库</Link>
            <button type="button" className="btn btn-sm" onClick={() => void load(1)}><RefreshCw size={13} />重试</button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const avatarInitial = getAvatarInitial(data.user.username);
  const profileDescription = `${data.user.username} 在绘图姬 DrawHime 的公开主页，展示 ${data.stats.publicImageCount} 张公开 AI 图片作品。`;

  return (
    <div className="user-profile-page animate-fade-in">
      <Seo title={`${data.user.username} 的主页`} description={profileDescription} path={`/users/${data.user.id}`} />
      <section className="user-profile-hero card">
        <Link to="/gallery" className="user-profile-back"><ArrowLeft size={14} />图库</Link>
        <div className={`user-profile-avatar is-${data.user.avatarSource}`}>
          {data.user.avatarUrl && <img src={resolveMediaUrl(data.user.avatarUrl)} alt="" loading="eager" decoding="async" />}
          <span>{avatarInitial}</span>
        </div>
        <div className="user-profile-identity">
          <div className="user-profile-kicker">用户主页</div>
          <h1>{data.user.username}</h1>
          <div className="user-profile-meta">
            <span>ID {data.user.id}</span>
            <span><CalendarDays size={12} />加入于 {formatDate(data.user.createdAt)}</span>
          </div>
        </div>
        <button type="button" className="btn btn-outline btn-sm user-profile-copy" onClick={copyProfileLink}>
          <Copy size={13} />{copied ? '已复制' : '复制链接'}
        </button>
      </section>

      <section className="user-profile-stat-grid">
        <StatCard label="公开作品" value={formatNumber(data.stats.publicImageCount)} icon={<Image size={16} />} tone="primary" />
        <StatCard label="累计点赞" value={formatNumber(data.stats.likeCount)} icon={<Heart size={16} />} tone="rose" />
        <StatCard label="累计浏览" value={formatNumber(data.stats.viewCount)} icon={<Eye size={16} />} tone="green" />
        <StatCard label="最近公开" value={data.stats.latestImageAt ? formatDate(data.stats.latestImageAt) : '-'} icon={<CalendarDays size={16} />} tone="amber" compact />
      </section>

      <section className="user-profile-gallery card">
        <div className="user-profile-gallery-head">
          <div>
            <strong>公开作品</strong>
            <span>{data.total} 张公开图片 · 第 {data.page} / {data.totalPages} 页</span>
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void load(page)} disabled={loading}>
            {loading ? <Loader2 size={13} className="user-profile-spin" /> : <RefreshCw size={13} />}
            刷新
          </button>
        </div>

        {data.images.length === 0 ? (
          <div className="user-profile-empty is-inline">
            <Image size={30} />
            <span>该用户暂无公开作品</span>
          </div>
        ) : (
          <div className="user-profile-grid">
            {data.images.map((item, index) => <UserImageCard key={item.id} image={item} priority={index < 8} modelDisplayMap={modelDisplayMap} />)}
          </div>
        )}

        {data.totalPages > 1 && (
          <div className="user-profile-pagination">
            <button type="button" className="btn btn-outline btn-sm" disabled={data.page <= 1 || loading} onClick={() => void load(data.page - 1)}>上一页</button>
            <span>{data.page} / {data.totalPages}</span>
            <button type="button" className="btn btn-outline btn-sm" disabled={!data.hasMore || loading} onClick={() => void load(data.page + 1)}>下一页</button>
          </div>
        )}
      </section>
    </div>
  );
}

/** 公开主页统计卡片。 */
function StatCard({
  label,
  value,
  icon,
  tone,
  compact = false,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  tone: 'primary' | 'rose' | 'green' | 'amber';
  compact?: boolean;
}) {
  return (
    <div className={`user-profile-stat card is-${tone}`}>
      <div className="user-profile-stat-icon">{icon}</div>
      <span>{label}</span>
      <strong className={compact ? 'is-compact' : ''} title={value}>{value}</strong>
    </div>
  );
}

/** 用户公开作品卡片。 */
function UserImageCard({ image, priority, modelDisplayMap }: { image: UserPublicProfileImage; priority: boolean; modelDisplayMap: Map<string, string> }) {
  return (
    <Link to={`/image/${image.id}`} className="user-profile-image-card">
      <div className="user-profile-image-thumb">
        <img
          src={resolveMediaUrl(image.thumbnailUrl || image.imageUrl)}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={priority ? 'high' : 'auto'}
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
        <div className="user-profile-image-overlay">
          <span><Heart size={12} />{formatNumber(image.likeCount)}</span>
          <span><Eye size={12} />{formatNumber(image.viewCount)}</span>
        </div>
      </div>
      <div className="user-profile-image-info">
        <span className="user-profile-image-tags">
          <b>{formatModeLabel(image.mode)}</b>
          <i>{formatSourceLabel(image.source)}</i>
        </span>
        <strong>{image.prompt || '无提示词'}</strong>
        <small>{formatDrawingModelNameByMap(image.model, modelDisplayMap) || '-'} · {formatDate(image.createdAt)}</small>
      </div>
    </Link>
  );
}

/** 格式化整数。 */
function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

/** 格式化公开日期。 */
function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 生成模式中文展示。 */
function formatModeLabel(mode: string): string {
  if (mode === 'image-to-image') return '图生图';
  if (mode === 'text-to-image') return '文生图';
  return mode;
}

/** 生成来源中文展示。 */
function formatSourceLabel(source: string): string {
  if (source === 'bot') return 'Bot';
  if (source === 'web') return '网页';
  if (source === 'api') return 'API';
  return source || '未知';
}
