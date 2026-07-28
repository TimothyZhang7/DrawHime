/** 本文件提供后台存储页的通用小组件；组件只展示真实接口数据。 */
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cleanupStatusLabel, formatBytes, formatDuration, formatRelativeTime, formatSignedCount } from './storage-format';
import type { LocalStorageSnapshot } from './storage-types';

/** 本地存储状态徽标。 */
export function StatusPill({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
      {ok ? okText : badText}
    </span>
  );
}

/** 顶部行内指标。 */
export function InlineStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5">
      <span className="text-slate-400">{label}</span>
      <strong className="font-semibold text-slate-900">{value}</strong>
    </span>
  );
}

/** 关键数值卡片。 */
export function StatTile({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Icon size={14} />
        {label}
      </div>
      <div className="mt-2 text-lg font-black text-slate-900 tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] text-slate-400">{sub}</div>
    </div>
  );
}

/** 小型指标徽标。 */
export function MetricBadge({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      <Icon size={14} className="text-slate-500" />
      <span>{label}</span>
      <strong className="text-slate-900 tabular-nums">{value}</strong>
    </div>
  );
}

/** 磁盘容量使用条。 */
export function UsageBar({ percent }: { percent: number }) {
  const tone = percent >= 90 ? 'bg-red-500' : percent >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="h-3 overflow-hidden rounded-full bg-white/10">
      <div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

/** 本轮变化提示块。 */
export function MiniTrend({ label, value, tone }: { label: string; value: string; tone: 'warn' | 'good' | 'neutral' }) {
  const cls = tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800' : tone === 'good' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-800';
  return (
    <div className={`rounded-lg border px-3 py-3 ${cls}`}>
      <div className="text-[11px] text-current/70">{label}</div>
      <div className="mt-1 text-base font-black tabular-nums">{value}</div>
    </div>
  );
}

/** 告警提示框。 */
export function WarningBox({ message, compact = false }: { message: string; compact?: boolean }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 ${compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm'}`}>
      <AlertTriangle size={compact ? 14 : 16} className="mt-0.5 flex-shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/** 空态提示。 */
export function EmptyText({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-slate-200 py-10 text-center text-xs text-slate-400">{text}</div>;
}

/** 紧凑键值行。 */
export function CompactRow({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'warn' | 'good' }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs">
      <span className="text-slate-500">{label}</span>
      <span className={`font-bold tabular-nums ${tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : 'text-slate-800'}`}>{value}</span>
    </div>
  );
}

/** 累计数字和本轮变化行。 */
export function NumberRow({ label, value, delta, tone = 'normal' }: { label: string; value: number; delta: number; tone?: 'normal' | 'warn' }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <span className="text-slate-500">{label}</span>
      <span className={`font-black tabular-nums ${tone === 'warn' ? 'text-amber-700' : 'text-slate-900'}`}>{value}</span>
      <span className={`tabular-nums ${delta > 0 ? 'text-amber-600' : delta < 0 ? 'text-emerald-600' : 'text-slate-400'}`}>{formatSignedCount(delta)}</span>
    </div>
  );
}

/** 服务端点健康卡片。 */
export function EndpointCard({
  title,
  ok,
  statusCode,
  latencyMs,
  error,
  summary,
}: {
  title: string;
  ok: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  error?: string | null;
  summary: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
          {ok ? <CheckCircle2 size={16} className="text-emerald-500" /> : <AlertTriangle size={16} className="text-amber-500" />}
          {title}
        </div>
        <StatusPill ok={ok} okText="正常" badText="异常" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <CompactRow label="HTTP" value={statusCode ? String(statusCode) : '-'} />
        <CompactRow label="耗时" value={latencyMs != null ? `${latencyMs} ms` : '-'} />
      </div>
      <div className="mt-2 text-[11px] text-slate-400">{summary}</div>
      {error && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">{error}</div>}
    </div>
  );
}

/** 最近一轮本地维护摘要卡。 */
export function CleanupRoundCard({ snapshot, now }: { snapshot: LocalStorageSnapshot; now: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-bold text-slate-900">最近一轮本地维护</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {cleanupStatusLabel(snapshot.cleanupLastStatus)} · {formatDuration(snapshot.cleanupLastDurationMs)} · {formatRelativeTime(snapshot.cleanupLastRunAt, now)}
          </div>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${cleanupStatusClass(snapshot.cleanupLastStatus)}`}>
          {cleanupStatusLabel(snapshot.cleanupLastStatus)}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <CompactRow label="释放文件" value={`${snapshot.cleanupLastDeleted}`} tone={snapshot.cleanupLastDeleted > 0 ? 'good' : 'normal'} />
        <CompactRow label="保护文件" value={`${snapshot.protectedFiles}`} />
        <CompactRow label="跳过维护" value={`${snapshot.cleanupSkipped}`} />
        <CompactRow label="失败次数" value={`${snapshot.cleanupFailed}`} tone={snapshot.cleanupFailed > 0 ? 'warn' : 'normal'} />
      </div>
    </div>
  );
}

/** 清理状态对应的颜色。 */
function cleanupStatusClass(status: LocalStorageSnapshot['cleanupLastStatus']): string {
  if (status === 'success') return 'bg-emerald-50 text-emerald-700';
  if (status === 'partial' || status === 'failed') return 'bg-amber-50 text-amber-700';
  return 'bg-slate-100 text-slate-600';
}

/** 当前值小卡片，用于本地存储事实总览。 */
export function LocalFactCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-base font-black text-slate-900 tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}

/** 本地存储目录容量摘要。 */
export function LocalCapacitySummary({ snapshot }: { snapshot: LocalStorageSnapshot }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-950 p-4 text-white">
      <div className="text-xs text-slate-400">根文件系统已用</div>
      <div className="mt-2 text-4xl font-black tabular-nums">{snapshot.usedPercent.toFixed(1)}%</div>
      <div className="mt-2 text-xs leading-5 text-slate-300">
        <div>已用 {formatBytes(snapshot.usedBytes)}</div>
        <div>可用 {formatBytes(snapshot.freeBytes)}</div>
        <div>总量 {formatBytes(snapshot.totalBytes)}</div>
      </div>
      <div className="mt-4">
        <UsageBar percent={snapshot.usedPercent} />
      </div>
    </div>
  );
}
