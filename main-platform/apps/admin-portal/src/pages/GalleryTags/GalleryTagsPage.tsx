/**
 * 本文件实现管理后台图库标签页。
 *
 * 职责：
 * - 展示图库中文标签、自动打标队列和真实配置状态。
 * - 允许管理员触发少量真实打标任务，便于排查生产标签为何暂未出现在用户端。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Play, RefreshCw, Tags, XCircle } from 'lucide-react';
import type {
  AdminGalleryTagOverviewResponse,
  AdminGalleryTaggingJobView,
  AdminGalleryTaggingRunResponse,
  GalleryPopularTagView,
  GalleryTaggingJobStatus,
} from '@aiimage/shared-contracts';
import { api } from '../../api/client';
import Toast from '../../components/Toast';

type ToastState = { type: 'success' | 'error'; message: string };

/** 管理后台图库标签页。 */
export function GalleryTagsPage() {
  const [overview, setOverview] = useState<AdminGalleryTagOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [savingAttempts, setSavingAttempts] = useState(false);
  const [maxAttemptsInput, setMaxAttemptsInput] = useState('5');
  const [toast, setToast] = useState<ToastState | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setRefreshing(true);
      if (!overview) setLoading(true);
    }
    const result = await api<AdminGalleryTagOverviewResponse>('/admin/gallery-tags/overview');
    if (result.ok && result.data) {
      setOverview(result.data);
      setMaxAttemptsInput(String(result.data.config.maxAttempts));
    } else {
      setToast({ type: 'error', message: result.message ?? '读取图库标签状态失败' });
    }
    if (!silent) {
      setLoading(false);
      setRefreshing(false);
    }
  }, [overview]);

  /** 手动触发一小批真实打标任务；处理完成后刷新统计，避免页面展示旧状态。 */
  const runTagging = useCallback(async () => {
    setRunning(true);
    const result = await api<AdminGalleryTaggingRunResponse>('/admin/gallery-tags/run?limit=3', { method: 'POST' });
    if (result.ok && result.data) {
      setToast({
        type: result.data.failed > 0 ? 'error' : 'success',
        message: `已处理 ${result.data.processed} 个，成功 ${result.data.succeeded}，失败 ${result.data.failed}，跳过 ${result.data.skipped}`,
      });
      await load(true);
    } else {
      setToast({ type: 'error', message: result.message ?? '触发图库打标失败' });
    }
    setRunning(false);
  }, [load]);

  /** 保存标签生成失败重试次数；只写 system_configs 配置项，backend 下一轮处理队列时即时读取。 */
  const saveMaxAttempts = useCallback(async () => {
    const nextValue = clampInteger(maxAttemptsInput, 1, 20);
    setSavingAttempts(true);
    const result = await api('/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gallery_auto_tag_max_attempts: String(nextValue) }),
    });
    if (result.ok) {
      setToast({ type: 'success', message: `失败重试次数已保存为 ${nextValue} 次` });
      setMaxAttemptsInput(String(nextValue));
      await load(true);
    } else {
      setToast({ type: 'error', message: result.message ?? '保存失败重试次数失败' });
    }
    setSavingAttempts(false);
  }, [load, maxAttemptsInput]);

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const statusCount = useMemo(() => {
    const map = new Map<GalleryTaggingJobStatus, number>();
    overview?.jobsByStatus.forEach((item) => map.set(item.status, item.count));
    return map;
  }, [overview]);

  const latestFailure = overview?.latestJobs.find((job) => job.status === 'failed' && job.error)?.error ?? null;

  if (loading && !overview) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-text-2">
        <Loader2 size={24} className="animate-spin text-indigo-600" />
        <span className="ml-3">加载图库标签状态...</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1480px] space-y-5">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

      <header className="rounded-lg border border-slate-200 bg-white px-4 py-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-950 text-white shadow-lg shadow-slate-950/15">
              <Tags size={22} />
            </div>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-black tracking-tight text-slate-900">图库标签</h2>
                <StatusPill ok={overview?.config.enabled === true} okText="自动打标已启用" badText="自动打标未启用" />
                <StatusPill ok={overview?.config.hasBaseUrl === true && overview?.config.hasApiKey === true} okText="上游配置完整" badText="上游配置缺失" />
              </div>
              <p className="max-w-4xl text-sm leading-6 text-slate-500">
                后台展示真实标签字典、公开图库打标覆盖率和最近队列错误。标签为空时，用户端会显示生成中状态。
              </p>
              {latestFailure && (
                <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  <AlertTriangle size={14} className="flex-shrink-0" />
                  <span className="truncate">最近失败：{latestFailure}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void load(false)} className="btn btn-sm btn-outline flex items-center gap-1.5" disabled={refreshing || running}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              刷新
            </button>
            <button onClick={() => void runTagging()} className="btn btn-sm flex items-center gap-1.5" disabled={running || overview?.config.enabled !== true}>
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              处理 3 个
            </button>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        <MetricCard label="标签总数" value={overview?.tagCount ?? 0} />
        <MetricCard label="标签关联" value={overview?.taskTagCount ?? 0} />
        <MetricCard label="公开已打标" value={overview?.publicTaggedTaskCount ?? 0} tone="good" />
        <MetricCard label="公开待打标" value={overview?.publicUntaggedTaskCount ?? 0} tone={(overview?.publicUntaggedTaskCount ?? 0) > 0 ? 'warn' : 'normal'} />
        <MetricCard label="失败队列" value={statusCount.get('failed') ?? 0} tone={(statusCount.get('failed') ?? 0) > 0 ? 'bad' : 'normal'} />
        <MetricCard label="待处理队列" value={(statusCount.get('pending') ?? 0) + (statusCount.get('running') ?? 0)} />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.95fr_1.2fr]">
        <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">配置摘要</h3>
              <p className="text-xs text-slate-500">只展示是否配置，不返回 API Key 明文。</p>
            </div>
            {overview?.config.enabled ? <CheckCircle2 size={18} className="text-emerald-600" /> : <XCircle size={18} className="text-rose-500" />}
          </div>
          {overview?.config ? (
            <div className="mt-4 grid gap-2 text-xs">
              <ConfigRow label="启用状态" value={overview.config.enabled ? '启用' : '未启用'} ok={overview.config.enabled} />
              <ConfigRow label="私密图打标" value={overview.config.includePrivate ? '允许' : '不发送'} ok={!overview.config.includePrivate} />
              <ConfigRow label="模型" value={overview.config.model} />
              <ConfigRow label="API Base" value={overview.config.hasBaseUrl ? '已配置' : '未配置'} ok={overview.config.hasBaseUrl} />
              <ConfigRow label="API Key" value={overview.config.hasApiKey ? '已配置' : '未配置'} ok={overview.config.hasApiKey} />
              <ConfigRow label="复用图片反推" value={overview.config.usesImageReverseFallback ? '是' : '否'} />
              <ConfigRow label="上游超时" value={`${overview.config.timeoutSec} 秒`} />
              <ConfigRow label="标签上限" value={`${overview.config.maxTags} 个`} />
              <ConfigRow label="失败重试" value={`${overview.config.maxAttempts} 次`} />
              <ConfigRow label="置信度阈值" value={`${overview.config.minConfidence}`} />
              <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
                <label className="block text-xs font-semibold text-slate-600" htmlFor="gallery-tag-max-attempts">标签生成失败重试次数</label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    id="gallery-tag-max-attempts"
                    type="number"
                    min={1}
                    max={20}
                    value={maxAttemptsInput}
                    onChange={(event) => setMaxAttemptsInput(event.target.value)}
                    className="h-9 w-24 rounded-md border border-slate-200 px-2 text-sm font-bold text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                  />
                  <button
                    type="button"
                    onClick={() => void saveMaxAttempts()}
                    disabled={savingAttempts}
                    className="btn btn-sm btn-outline flex items-center gap-1.5"
                  >
                    {savingAttempts ? <Loader2 size={13} className="animate-spin" /> : null}
                    保存
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-slate-500">范围 1-20 次。失败任务达到该次数后会保留失败状态，不再自动重试。</p>
              </div>
            </div>
          ) : (
            <EmptyBox text="未读取到配置状态" />
          )}
        </article>

        <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">公开热门标签</h3>
              <p className="text-xs text-slate-500">只统计公开、成功且有最终图的任务。</p>
            </div>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500">
              {overview?.popularTags.length ?? 0} 个
            </span>
          </div>
          <div className="mt-4">
            {overview?.popularTags.length ? (
              <div className="flex flex-wrap gap-2">
                {overview.popularTags.map((tag) => <TagChip key={tag.slug} tag={tag} />)}
              </div>
            ) : (
              <EmptyBox text="公开图库暂未产生热门标签" />
            )}
          </div>
        </article>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900">队列状态</h3>
            <p className="text-xs text-slate-500">失败任务会保留错误摘要，跳过任务通常是私密图或无有效标签。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['pending', 'running', 'failed', 'skipped', 'success'] as GalleryTaggingJobStatus[]).map((status) => (
              <StatusCount key={status} status={status} count={statusCount.get(status) ?? 0} />
            ))}
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          {overview?.latestJobs.length ? (
            <table className="min-w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-semibold">状态</th>
                  <th className="py-2 pr-3 font-semibold">任务 ID</th>
                  <th className="py-2 pr-3 font-semibold">尝试</th>
                  <th className="py-2 pr-3 font-semibold">模型</th>
                  <th className="py-2 pr-3 font-semibold">错误</th>
                  <th className="py-2 pr-3 font-semibold">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {overview.latestJobs.map((job) => <JobRow key={job.id} job={job} />)}
              </tbody>
            </table>
          ) : (
            <EmptyBox text="暂无打标队列记录" />
          )}
        </div>
      </section>
    </div>
  );
}

/** 概览数值卡片。 */
function MetricCard({ label, value, tone = 'normal' }: { label: string; value: number; tone?: 'normal' | 'good' | 'warn' | 'bad' }) {
  const toneClass = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-rose-600' : 'text-slate-900';
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-[11px] font-semibold text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-black tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

/** 配置行。 */
function ConfigRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
      <span className="text-slate-500">{label}</span>
      <span className={`min-w-0 truncate font-bold ${ok === false ? 'text-rose-600' : ok === true ? 'text-emerald-600' : 'text-slate-800'}`}>{value}</span>
    </div>
  );
}

/** 热门标签胶囊，使用后端首次创建时固定的配色。 */
function TagChip({ tag }: { tag: GalleryPopularTagView }) {
  return (
    <span
      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border px-2.5 text-xs font-bold"
      style={{ background: tag.color.bg, color: tag.color.text, borderColor: tag.color.border }}
      title={`${tag.name} · 权重 ${tag.weight}`}
    >
      <span className="truncate">{tag.name}</span>
      <span style={{ opacity: 0.7 }}>{tag.count}</span>
    </span>
  );
}

/** 队列状态计数胶囊。 */
function StatusCount({ status, count }: { status: GalleryTaggingJobStatus; count: number }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${statusClass(status)}`}>
      {statusLabel(status)} {count}
    </span>
  );
}

/** 最近任务表格行。 */
function JobRow({ job }: { job: AdminGalleryTaggingJobView }) {
  return (
    <tr className="border-b border-slate-100 align-top last:border-0">
      <td className="py-2 pr-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${statusClass(job.status)}`}>{statusLabel(job.status)}</span></td>
      <td className="py-2 pr-3 font-mono text-[11px] text-slate-700">{job.taskId}</td>
      <td className="py-2 pr-3 tabular-nums text-slate-600">{job.attemptCount}</td>
      <td className="py-2 pr-3 text-slate-600">{job.model ?? '-'}</td>
      <td className="max-w-[460px] py-2 pr-3 text-slate-600">{job.error ?? '-'}</td>
      <td className="py-2 pr-3 whitespace-nowrap text-slate-500">{formatDate(job.updatedAt)}</td>
    </tr>
  );
}

/** 空状态。 */
function EmptyBox({ text }: { text: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-500">
      {text}
    </div>
  );
}

/** 状态指示。 */
function StatusPill({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{ok ? okText : badText}</span>;
}

function statusLabel(status: GalleryTaggingJobStatus): string {
  const map: Record<GalleryTaggingJobStatus, string> = { pending: '待处理', running: '处理中', success: '成功', failed: '失败', skipped: '跳过' };
  return map[status];
}

function statusClass(status: GalleryTaggingJobStatus): string {
  if (status === 'success') return 'bg-emerald-50 text-emerald-700';
  if (status === 'failed') return 'bg-rose-50 text-rose-700';
  if (status === 'skipped') return 'bg-slate-100 text-slate-600';
  if (status === 'running') return 'bg-indigo-50 text-indigo-700';
  return 'bg-amber-50 text-amber-700';
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 读取管理员输入的整数配置并限制范围，避免空值或超范围写入生产配置。 */
function clampInteger(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}
