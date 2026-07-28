/** 本页面展示当前账号的图片反推持久化历史，并可打开任一记录查看完整结构化结果。 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, History, Loader2, RefreshCw, ScanSearch } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ImageReverseJobListResponse, ImageReverseJobStatus, ImageReverseJobView, ImageReverseMode } from '@aiimage/shared-contracts';
import { Seo } from '../../../components/Seo';
import { api } from '../../../lib/api';
import { fetchImageReverseSource } from './imageReverseApi';
import './ImageReverseHistoryPage.css';

type HistoryFilter = 'all' | 'running' | 'succeeded' | 'failed';

/** 图片反推历史记录页面。 */
export function ImageReverseHistoryPage() {
  const [jobs, setJobs] = useState<ImageReverseJobView[]>([]);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const hasActive = jobs.some((job) => job.status === 'queued' || job.status === 'running');
  const filteredJobs = useMemo(() => {
    if (filter === 'all') return jobs;
    if (filter === 'running') return jobs.filter((job) => job.status === 'queued' || job.status === 'running');
    return jobs.filter((job) => job.status === filter);
  }, [filter, jobs]);
  const counts = useMemo(() => ({
    all: jobs.length,
    running: jobs.filter((job) => job.status === 'queued' || job.status === 'running').length,
    succeeded: jobs.filter((job) => job.status === 'succeeded').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
  }), [jobs]);

  /** 从 backend 获取数据库历史；轮询刷新也复用该入口。 */
  const loadJobs = async (silent = false) => {
    if (!silent) setRefreshing(true);
    const response = await api<ImageReverseJobListResponse>('/api/tools/image-reverse/jobs');
    if (response.ok && response.data) {
      setJobs(response.data.jobs);
      setError('');
    } else if (!silent) {
      setError(response.message ?? '反推记录读取失败');
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
    <div className="reverse-history-page">
      <Seo title="反推记录" description="查看当前账号的图片反推任务进度和历史结果。" path="/reverse/history" />
      <header className="reverse-history-hero">
        <div className="reverse-history-hero-copy">
          <Link to="/reverse" className="reverse-history-back"><ArrowLeft size={15} />返回反推</Link>
          <span className="reverse-history-kicker"><History size={15} />Reverse Archive</span>
          <h1>反推记录</h1>
          <p>源图、提取参数、运行状态与结构化结果均由后端持久化。刷新页面或更换设备后仍可继续查看。</p>
        </div>
        <div className="reverse-history-ledger" aria-label="反推记录统计">
          <div><strong>{counts.all}</strong><span>全部记录</span></div>
          <div><strong>{counts.running}</strong><span>处理中</span></div>
          <div><strong>{counts.succeeded}</strong><span>已完成</span></div>
        </div>
      </header>

      <section className="reverse-history-toolbar">
        <div className="reverse-history-filters" role="tablist" aria-label="记录状态筛选">
          {HISTORY_FILTERS.map((item) => (
            <button key={item.value} type="button" className={filter === item.value ? 'is-active' : ''} onClick={() => setFilter(item.value)}>
              {item.label}<span>{item.value === 'all' ? counts.all : item.value === 'running' ? counts.running : counts[item.value]}</span>
            </button>
          ))}
        </div>
        <button type="button" className="reverse-history-refresh" onClick={() => void loadJobs()} disabled={refreshing}>
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />刷新
        </button>
      </section>

      {error && <div className="reverse-history-alert">{error}</div>}
      {loading ? (
        <div className="reverse-history-loading"><Loader2 size={22} className="animate-spin" />正在读取后端记录</div>
      ) : filteredJobs.length > 0 ? (
        <section className="reverse-history-grid" aria-label="图片反推历史列表">
          {filteredJobs.map((job, index) => <ReverseHistoryCard key={job.id} job={job} index={index} />)}
        </section>
      ) : (
        <div className="reverse-history-empty">
          <ScanSearch size={28} />
          <strong>{jobs.length === 0 ? '还没有反推记录' : '当前筛选下没有记录'}</strong>
          <span>提交一次图片反推后，源图和结果会出现在这里。</span>
          <Link to="/reverse">开始反推</Link>
        </div>
      )}
    </div>
  );
}

/** 单条反推历史卡片。 */
function ReverseHistoryCard({ job, index }: { job: ImageReverseJobView; index: number }) {
  const mode = MODE_META[job.mode];
  return (
    <article className="reverse-history-card" style={{ '--history-index': index } as CSSProperties}>
      <ReverseHistoryPreview job={job} />
      <div className="reverse-history-card-body">
        <div className="reverse-history-card-topline">
          <span className={`reverse-history-status is-${job.status}`}>{formatStatus(job.status)}</span>
          <span className="reverse-history-mode" style={{ '--mode-color': mode.color } as CSSProperties}>{mode.label}</span>
        </div>
        <h2 title={job.sourceFileName}>{job.sourceFileName}</h2>
        <p>{job.resultSummary || job.error || job.progressText}</p>
        <ReverseHistoryAnalysisSummary job={job} />
        <dl>
          <div><dt>尺寸</dt><dd>{job.sourceWidth} × {job.sourceHeight}</dd></div>
          <div><dt>模型</dt><dd>{job.model}</dd></div>
          <div><dt>创建</dt><dd>{formatDateTime(job.createdAt)}</dd></div>
        </dl>
        <div className="reverse-history-progress" aria-label={job.progressText}>
          <span style={{ width: `${job.progress}%` }} />
        </div>
        <Link to={`/reverse?job=${encodeURIComponent(job.id)}`} className="reverse-history-open">
          {job.status === 'succeeded' ? '查看完整结果' : job.status === 'failed' ? '查看失败详情' : '继续查看进度'}
          <span>↗</span>
        </Link>
      </div>
    </article>
  );
}

/** 展示数据库中独立保存的轻量分析摘要，不触发完整结果 JSON 查询。 */
function ReverseHistoryAnalysisSummary({ job }: { job: ImageReverseJobView }) {
  const summary = job.analysisSummary;
  if (!summary) {
    if (job.mode !== 'tags' || (job.status !== 'queued' && job.status !== 'running')) return null;
    return <div className="reverse-history-analysis"><span>请求管线 · {job.options.analysisMode === 'hybrid' ? '视觉 + WD14' : '视觉'}</span></div>;
  }
  return (
    <div className="reverse-history-analysis" aria-label="分析摘要">
      <span>{summary.pipeline === 'hybrid' ? '混合管线' : '视觉管线'}</span>
      {summary.providers.map((provider) => <span key={provider.provider} className={`is-${provider.status}`} title={`${provider.label}：${formatProviderStatus(provider.status)}`}>{provider.label} {formatProviderStatus(provider.status)}</span>)}
      <span>{summary.evidenceCount} 条证据</span>
      {summary.conflictCount > 0 && <span className="is-warning">{summary.conflictCount} 组冲突</span>}
      {summary.warningCount > 0 && <span className="is-warning">{summary.warningCount} 条提示</span>}
      {summary.animaPromptAvailable && <span className="is-anima">Anima 可带入</span>}
    </div>
  );
}

/** 进入视口后才鉴权读取轻量预览，避免历史较多时同时下载全部图片。 */
function ReverseHistoryPreview({ job }: { job: ImageReverseJobView }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState('');

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let objectUrl = '';
    const controller = new AbortController();
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void fetchImageReverseSource(job.previewUrl, controller.signal).then((blob) => {
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

  return (
    <div className="reverse-history-preview" ref={rootRef}>
      {url ? <img src={url} alt={job.sourceFileName} loading="lazy" /> : <ScanSearch size={26} />}
      <span>{MODE_META[job.mode].serial}</span>
    </div>
  );
}

const HISTORY_FILTERS: Array<{ value: HistoryFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '处理中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' },
];

const MODE_META: Record<ImageReverseMode, { label: string; serial: string; color: string }> = {
  description: { label: '综合描述', serial: 'DSC', color: '#2563eb' },
  prompt: { label: '绘图 Prompt', serial: 'PMT', color: '#0891b2' },
  character: { label: '角色档案', serial: 'CHR', color: '#7c3aed' },
  tags: { label: '模型标签', serial: 'TAG', color: '#d97706' },
  edit: { label: '编辑方案', serial: 'EDT', color: '#db2777' },
};

function formatStatus(status: ImageReverseJobStatus): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '识图中';
  if (status === 'succeeded') return '已完成';
  return '失败';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function formatProviderStatus(status: 'succeeded' | 'skipped' | 'failed'): string {
  if (status === 'succeeded') return '成功';
  if (status === 'failed') return '降级';
  return '跳过';
}
