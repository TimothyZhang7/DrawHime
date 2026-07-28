/** 本页面展示当前账号的图片放大持久化历史，并可打开任一记录继续查看进度或结果。 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, CheckCircle2, History, ImageUpscale, Loader2, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ImageUpscaleJobListResponse, ImageUpscaleJobStatus, ImageUpscaleJobView } from '@aiimage/shared-contracts';
import { Seo } from '../../../components/Seo';
import { api } from '../../../lib/api';
import { fetchImageUpscaleSource } from './imageUpscaleApi';
import './ImageUpscaleHistoryPage.css';

type HistoryFilter = 'all' | 'running' | 'succeeded' | 'failed';

/** 图片放大历史记录页面。 */
export function ImageUpscaleHistoryPage() {
  const [jobs, setJobs] = useState<ImageUpscaleJobView[]>([]);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const hasActive = jobs.some((job) => job.status === 'queued' || job.status === 'running');
  const filteredJobs = useMemo(() => jobs.filter((job) => matchesFilter(job.status, filter)), [filter, jobs]);
  const counts = useMemo(() => ({
    all: jobs.length,
    running: jobs.filter((job) => matchesFilter(job.status, 'running')).length,
    succeeded: jobs.filter((job) => job.status === 'succeeded').length,
    failed: jobs.filter((job) => matchesFilter(job.status, 'failed')).length,
    library: jobs.filter((job) => job.saveToLibrary).length,
  }), [jobs]);

  /** 从 backend 读取数据库历史；活动任务存在时同一入口负责轻量轮询。 */
  const loadJobs = async (silent = false) => {
    if (!silent) setRefreshing(true);
    const response = await api<ImageUpscaleJobListResponse>('/api/tools/image-upscale/jobs');
    if (response.ok && response.data) {
      setJobs(response.data.jobs);
      setError('');
    } else if (!silent) {
      setError(response.message ?? '图片放大记录读取失败');
    }
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    void loadJobs();
  }, []);

  useEffect(() => {
    if (!hasActive) return undefined;
    const timer = window.setInterval(() => void loadJobs(true), 3000);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  return (
    <div className="upscale-history-page">
      <Seo title="放大记录" description="查看当前账号的图片放大任务、持久化源图和图库保存状态。" path="/upscale/history" />
      <header className="upscale-history-hero">
        <div>
          <Link to="/tools/image-upscale" className="upscale-history-back"><ArrowLeft size={15} />返回图片放大</Link>
          <span className="upscale-history-kicker"><History size={15} />Upscale Ledger</span>
          <h1>放大记录</h1>
          <p>源图、模型、倍率、运行状态与结果均由后端持久化；刷新页面、更换设备或服务重启后仍可继续查看。</p>
        </div>
        <div className="upscale-history-ledger" aria-label="图片放大记录统计">
          <div><strong>{counts.all}</strong><span>全部记录</span></div>
          <div><strong>{counts.running}</strong><span>处理中</span></div>
          <div><strong>{counts.library}</strong><span>计划入图库</span></div>
        </div>
      </header>

      <section className="upscale-history-toolbar">
        <div className="upscale-history-filters" role="tablist" aria-label="记录状态筛选">
          {HISTORY_FILTERS.map((item) => (
            <button key={item.value} type="button" className={filter === item.value ? 'is-active' : ''} onClick={() => setFilter(item.value)}>
              {item.label}<span>{counts[item.value]}</span>
            </button>
          ))}
        </div>
        <button type="button" className="upscale-history-refresh" onClick={() => void loadJobs()} disabled={refreshing}>
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />刷新
        </button>
      </section>

      {error && <div className="upscale-history-alert">{error}</div>}
      {loading ? (
        <div className="upscale-history-loading"><Loader2 size={22} className="animate-spin" />正在读取后端记录</div>
      ) : filteredJobs.length > 0 ? (
        <section className="upscale-history-grid" aria-label="图片放大历史列表">
          {filteredJobs.map((job, index) => <UpscaleHistoryCard key={job.id} job={job} index={index} />)}
        </section>
      ) : (
        <div className="upscale-history-empty">
          <ImageUpscale size={28} />
          <strong>{jobs.length === 0 ? '还没有图片放大记录' : '当前筛选下没有记录'}</strong>
          <span>提交图片放大后，源图、进度和结果会保存在这里。</span>
          <Link to="/tools/image-upscale">开始放大</Link>
        </div>
      )}
    </div>
  );
}

/** 单条图片放大历史卡片。 */
function UpscaleHistoryCard({ job, index }: { job: ImageUpscaleJobView; index: number }) {
  return (
    <article className="upscale-history-card" style={{ '--history-index': index } as CSSProperties}>
      <UpscaleHistoryPreview job={job} />
      <div className="upscale-history-card-body">
        <div className="upscale-history-card-topline">
          <span className={`upscale-history-status is-${job.status}`}>{formatStatus(job.status)}</span>
          <span className="upscale-history-scale">{job.scale}×</span>
          {job.saveToLibrary && <span className="upscale-history-library"><CheckCircle2 size={11} />入图库</span>}
        </div>
        <h2 title={job.sourceFileName}>{job.sourceFileName}</h2>
        <p>{job.error || job.progressText}</p>
        <dl>
          <div><dt>源图</dt><dd>{formatDimensions(job.sourceWidth, job.sourceHeight)}</dd></div>
          <div><dt>模型</dt><dd>{job.model}</dd></div>
          <div><dt>创建</dt><dd>{formatDateTime(job.createdAt)}</dd></div>
        </dl>
        <div className="upscale-history-progress" aria-label={job.progressText}><span style={{ width: `${job.progress}%` }} /></div>
        <Link to={`/tools/image-upscale?job=${encodeURIComponent(job.id)}`} className="upscale-history-open">
          {job.status === 'succeeded' ? '查看放大结果' : job.status === 'failed' || job.status === 'cancelled' ? '查看任务详情' : '继续查看进度'}
          <span>↗</span>
        </Link>
      </div>
    </article>
  );
}

/** 进入视口后才鉴权读取轻量预览，避免一次下载全部私有源图。 */
function UpscaleHistoryPreview({ job }: { job: ImageUpscaleJobView }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState('');

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !job.previewUrl) return undefined;
    let objectUrl = '';
    const controller = new AbortController();
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void fetchImageUpscaleSource(job.previewUrl as string, controller.signal).then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      }).catch(() => undefined);
    }, { rootMargin: '320px' });
    observer.observe(root);
    return () => {
      observer.disconnect();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [job.id, job.previewUrl]);

  return <div className="upscale-history-preview" ref={rootRef}>{url ? <img src={url} alt={job.sourceFileName} loading="lazy" /> : <ImageUpscale size={28} />}<span>{job.scale}X</span></div>;
}

const HISTORY_FILTERS: Array<{ value: HistoryFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '处理中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败/结束' },
];

function matchesFilter(status: ImageUpscaleJobStatus, filter: HistoryFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return status === 'queued' || status === 'running';
  if (filter === 'failed') return status === 'failed' || status === 'cancelled';
  return status === 'succeeded';
}

function formatStatus(status: ImageUpscaleJobStatus): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '放大中';
  if (status === 'succeeded') return '已完成';
  if (status === 'cancelled') return '已结束';
  return '失败';
}

function formatDimensions(width?: number, height?: number): string {
  return width && height ? `${width} × ${height}` : '旧记录';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
