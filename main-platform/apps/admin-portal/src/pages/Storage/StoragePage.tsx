/** 本文件实现管理后台存储页：以本地唯一媒体副本为底层展示容量、维护和趋势。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, FolderOpen, HardDrive, Image, Loader2, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import type { AdminStorageOverviewResponse, StoragePrefixStat, StorageSizeBucket } from '@aiimage/shared-contracts';
import { api } from '../../api/client';
import { useAdminRuntimeConfig } from '../../app/runtime-config';
import Toast from '../../components/Toast';
import { formatBytes, formatRelativeTime, formatSignedBytes, formatSignedCount, prefixLabel } from './storage-format';
import {
  appendStorageHistory,
  buildStorageDeltaPoints,
  diffSnapshot,
  evaluateLocalStorageHealth,
  filterStorageDeltaPointsByRange,
  filterStorageHistoryByRange,
  findPrefix,
  persistStorageHistory,
  readPersistedStorageHistory,
  snapshotFromOverview,
} from './storage-history';
import type { LocalStorageHistoryPoint, LocalStorageSnapshot, LocalStorageTrendRangeKey } from './storage-types';
import {
  CleanupRoundCard,
  CompactRow,
  EmptyText,
  EndpointCard,
  InlineStat,
  LocalCapacitySummary,
  LocalFactCard,
  MetricBadge,
  MiniTrend,
  NumberRow,
  StatTile,
  StatusPill,
  WarningBox,
} from './StoragePrimitives';
import { StorageTrendChart } from './StorageTrendChart';

type ToastState = { type: 'success' | 'error'; message: string };

/** 后台存储面板页面；不执行删除动作，只展示 backend 聚合的真实本地存储状态。 */
export function StoragePage() {
  const { pollIntervalSec } = useAdminRuntimeConfig();
  const [overview, setOverview] = useState<AdminStorageOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [trendRange, setTrendRange] = useState<LocalStorageTrendRangeKey>('24h');
  const lastSnapshotRef = useRef<LocalStorageSnapshot | null>(null);
  const [previousSnapshot, setPreviousSnapshot] = useState<LocalStorageSnapshot | null>(null);
  const [storageHistory, setStorageHistory] = useState<LocalStorageHistoryPoint[]>(() => readPersistedStorageHistory(Date.now()));

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setRefreshing(true);
      if (!lastSnapshotRef.current) setLoading(true);
    }
    const res = await api<AdminStorageOverviewResponse>('/admin/storage/overview');
    if (res.ok && res.data) {
      setPreviousSnapshot(lastSnapshotRef.current);
      const nextSnapshot = snapshotFromOverview(res.data);
      lastSnapshotRef.current = nextSnapshot;
      setStorageHistory((items) => {
        const nextHistory = appendStorageHistory(items, nextSnapshot, Date.now());
        persistStorageHistory(nextHistory);
        return nextHistory;
      });
      setOverview(res.data);
    } else {
      setToast({ type: 'error', message: res.message ?? '读取本地存储状态失败' });
    }
    if (!silent) {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  /* 存储状态轮询使用后台系统设置的间隔，避免后台配置只保存不生效。 */
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), pollIntervalSec * 1000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
    };
  }, [load, pollIntervalSec]);

  const mediaStats = overview?.media.stats ?? null;
  const cleanup = overview?.ops.cleanup ?? null;
  const prefixTotalBytes = useMemo(() => mediaStats?.prefixes.reduce((sum, item) => sum + item.bytes, 0) ?? 0, [mediaStats]);
  const sizeTotalBytes = useMemo(() => mediaStats?.sizeBuckets.reduce((sum, item) => sum + item.bytes, 0) ?? 0, [mediaStats]);
  const snapshot = useMemo(() => snapshotFromOverview(overview), [overview]);
  const delta = useMemo(() => diffSnapshot(previousSnapshot, snapshot), [previousSnapshot, snapshot]);
  const chainHealth = useMemo(() => evaluateLocalStorageHealth(snapshot, delta, Boolean(previousSnapshot)), [snapshot, delta, previousSnapshot]);
  const visibleStorageHistory = useMemo(() => filterStorageHistoryByRange(storageHistory, trendRange, now), [storageHistory, trendRange, now]);
  const trendPoints = useMemo(() => filterStorageDeltaPointsByRange(buildStorageDeltaPoints(storageHistory), trendRange, now), [storageHistory, trendRange, now]);

  if (loading && !overview) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <Loader2 className="animate-spin text-indigo-600" size={24} />
        <span className="ml-3 text-sm">加载本地存储状态...</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

      <header className="rounded-lg border border-slate-200 bg-white px-4 py-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-950 text-white shadow-lg shadow-slate-950/15">
              <HardDrive size={22} />
            </div>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-black tracking-tight text-slate-900">本地存储</h2>
                <StatusPill ok={snapshot.driver === 'local'} okText="本地唯一副本" badText="存储口径异常" />
                <StatusPill ok={chainHealth.servicesOk} okText="服务正常" badText="服务异常" />
                <StatusPill ok={chainHealth.cleanupOk} okText={chainHealth.cleanupText} badText={chainHealth.cleanupText} />
              </div>
              <p className="max-w-4xl text-sm leading-6 text-slate-500">
                当前生产媒体链路以本地目录为唯一副本，后台只展示 media-service 和 ops-worker 返回的真实容量、文件分布、保护状态与轮询变化。
              </p>
              <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                <InlineStat label="最后更新" value={formatRelativeTime(snapshot.checkedAt, now)} />
                <InlineStat label="媒体目录" value={snapshot.basePath ?? '-'} />
                <InlineStat label="本轮磁盘变化" value={formatSignedBytes(delta.usedBytes)} />
                <InlineStat label="参考图变化" value={formatSignedCount(delta.refFiles)} />
                <InlineStat label="清理失败变化" value={formatSignedCount(delta.cleanupFailed)} />
              </div>
            </div>
          </div>
          <button onClick={() => void load(false)} className="btn btn-sm btn-outline flex items-center gap-1.5 self-start" disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '刷新中' : '刷新'}
          </button>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.25fr_0.95fr]">
        <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">本地媒体目录</h3>
              <p className="text-xs text-slate-500">{mediaStats?.filesystem?.path ?? snapshot.basePath ?? '等待 media-service 返回路径'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <MetricBadge icon={FolderOpen} label="文件" value={`${snapshot.mediaFiles}`} />
              <MetricBadge icon={Image} label="参考图" value={`${snapshot.refFiles}`} />
              <MetricBadge icon={Database} label="生成原图" value={`${snapshot.imageFiles}`} />
            </div>
          </div>

          {mediaStats?.filesystem ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 md:grid-cols-[280px_1fr]">
                <LocalCapacitySummary snapshot={snapshot} />
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <StatTile icon={FolderOpen} label="媒体目录" value={formatBytes(snapshot.mediaBytes)} sub={`${snapshot.mediaFiles} 文件`} />
                  <StatTile icon={Image} label="参考图" value={formatBytes(snapshot.refBytes)} sub={`${snapshot.refFiles} 文件`} />
                  <StatTile icon={Database} label="生成原图" value={formatBytes(snapshot.imageBytes)} sub={`${snapshot.imageFiles} 文件`} />
                  <StatTile icon={ShieldCheck} label="缩略图" value={formatBytes(snapshot.thumbBytes)} sub={`${snapshot.thumbFiles} 文件`} />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <MiniTrend label="磁盘已用变化" value={formatSignedBytes(delta.usedBytes)} tone={delta.usedBytes > 0 ? 'warn' : delta.usedBytes < 0 ? 'good' : 'neutral'} />
                <MiniTrend label="媒体目录变化" value={formatSignedBytes(delta.mediaBytes)} tone={delta.mediaBytes > 0 ? 'warn' : delta.mediaBytes < 0 ? 'good' : 'neutral'} />
                <MiniTrend label="参考图变化" value={formatSignedBytes(delta.refBytes)} tone={delta.refBytes > 0 ? 'warn' : delta.refBytes < 0 ? 'good' : 'neutral'} />
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <LocalFactCard label="临时文件" value={`${snapshot.tempFiles}`} sub={`最大文件 ${formatBytes(snapshot.largestFileBytes)}`} />
                <LocalFactCard label="保护中文件" value={`${snapshot.protectedFiles}`} sub="queued/running/finalizing 或近期完成任务引用" />
                <LocalFactCard label="存储驱动" value={snapshot.driver} sub="生产应保持 local" />
              </div>
            </div>
          ) : (
            <WarningBox message={overview?.media.error ?? '未读取到本地文件系统容量'} />
          )}
        </article>

        <aside className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">本地维护状态</h3>
              <p className="text-xs text-slate-500">只展示保护、跳过、释放和失败，不提供浏览器侧删除入口。</p>
            </div>
            <StatusPill ok={chainHealth.cleanupOk} okText={chainHealth.cleanupText} badText={chainHealth.cleanupText} />
          </div>

          {cleanup ? (
            <div className="mt-4 space-y-3">
              <CleanupRoundCard snapshot={snapshot} now={now} />
              {chainHealth.message && <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">{chainHealth.message}</div>}
              <NumberRow label="维护运行次数" value={snapshot.cleanupRuns} delta={delta.cleanupRuns} />
              <NumberRow label="本地缓存已释放" value={snapshot.cacheDeleted} delta={delta.cacheDeleted} />
              <NumberRow label="参考图保护跳过" value={snapshot.referenceSkipped} delta={delta.referenceSkipped} />
              <NumberRow label="维护失败次数" value={snapshot.cleanupFailed} delta={delta.cleanupFailed} tone={snapshot.cleanupFailed > 0 ? 'warn' : 'normal'} />
              {snapshot.cleanupLastError && <WarningBox message={snapshot.cleanupLastError} compact />}
            </div>
          ) : (
            <WarningBox message={overview?.ops.error ?? '未读取到 ops-worker 本地维护状态'} />
          )}
        </aside>
      </section>

      <StorageTrendChart
        points={trendPoints}
        history={visibleStorageHistory}
        persistedCount={storageHistory.length}
        latest={snapshot}
        now={now}
        range={trendRange}
        onRangeChange={setTrendRange}
      />

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-bold text-slate-900">本地文件类型占用</h3>
          {mediaStats?.prefixes.length ? (
            <div className="space-y-3">
              {mediaStats.prefixes.map((item) => <PrefixRow key={item.prefix} item={item} totalBytes={prefixTotalBytes} />)}
            </div>
          ) : (
            <EmptyText text="暂无本地文件统计" />
          )}
        </article>

        <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-bold text-slate-900">本地文件大小分布</h3>
          {mediaStats?.sizeBuckets.length ? (
            <div className="space-y-3">
              {mediaStats.sizeBuckets.map((item) => <SizeBucketRow key={item.label} item={item} totalBytes={sizeTotalBytes} />)}
            </div>
          ) : (
            <EmptyText text="暂无大小分布" />
          )}
        </article>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">真实链路状态</h3>
            <p className="text-xs text-slate-500">浏览器只访问 backend 聚合接口，服务间 token 不会暴露到后台页面。</p>
          </div>
          <StatusPill ok={overview?.media.healthy === true && overview?.ops.healthy === true} okText="全部正常" badText="存在异常" />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <EndpointCard
            title="media-service 本地统计"
            ok={overview?.media.healthy === true}
            statusCode={overview?.media.statusCode}
            latencyMs={overview?.media.latencyMs}
            error={overview?.media.error}
            summary={`最近更新 ${formatRelativeTime(snapshot.checkedAt, now)}`}
          />
          <EndpointCard
            title="ops-worker 本地维护"
            ok={overview?.ops.healthy === true}
            statusCode={overview?.ops.statusCode}
            latencyMs={overview?.ops.latencyMs}
            error={overview?.ops.error}
            summary={`维护失败 ${snapshot.cleanupFailed} 次`}
          />
        </div>
      </section>
    </div>
  );
}

/** 文件名前缀占用行。 */
function PrefixRow({ item, totalBytes }: { item: StoragePrefixStat; totalBytes: number }) {
  const percent = totalBytes > 0 ? (item.bytes / totalBytes) * 100 : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-bold text-slate-700">{prefixLabel(item.prefix)}</span>
        <span className="text-slate-500 tabular-nums">{formatBytes(item.bytes)} / {item.count} 个</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-slate-900" style={{ width: `${item.count > 0 ? Math.max(1, percent) : 0}%` }} />
      </div>
    </div>
  );
}

/** 文件大小分布行。 */
function SizeBucketRow({ item, totalBytes }: { item: StorageSizeBucket; totalBytes: number }) {
  const percent = totalBytes > 0 ? (item.bytes / totalBytes) * 100 : 0;
  return (
    <div className="grid grid-cols-[88px_1fr_112px] items-center gap-3 text-xs">
      <span className="font-semibold text-slate-600">{item.label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-indigo-500" style={{ width: `${item.count > 0 ? Math.max(1, percent) : 0}%` }} />
      </div>
      <span className="text-right text-slate-500 tabular-nums">{item.count} / {formatBytes(item.bytes)}</span>
    </div>
  );
}
