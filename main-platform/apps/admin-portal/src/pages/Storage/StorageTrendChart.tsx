/** 本文件实现后台存储变化折线图；数据只来自本页真实轮询快照。 */
import { formatBytes, formatChartTime, formatRelativeTime, formatSignedBytes } from './storage-format';
import { STORAGE_TREND_RANGES, storageTrendRangeLabel } from './storage-history';
import type { LocalStorageDeltaPoint, LocalStorageHistoryPoint, LocalStorageSnapshot, LocalStorageTrendRangeKey } from './storage-types';
import { InlineStat } from './StoragePrimitives';

/** 后台存储趋势图组件。 */
export function StorageTrendChart({
  points,
  history,
  persistedCount,
  latest,
  now,
  range,
  onRangeChange,
}: {
  points: LocalStorageDeltaPoint[];
  history: LocalStorageHistoryPoint[];
  persistedCount: number;
  latest: LocalStorageSnapshot;
  now: number;
  range: LocalStorageTrendRangeKey;
  onRangeChange: (range: LocalStorageTrendRangeKey) => void;
}) {
  const width = 720;
  const height = 240;
  const padding = { top: 22, right: 22, bottom: 34, left: 62 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = points.flatMap((point) => [point.diskDeltaBytes, point.mediaDeltaBytes, point.refDeltaBytes]);
  const maxAbs = Math.max(1, ...values.map((value) => Math.abs(value)));
  const latestPoint = points[points.length - 1] ?? null;
  const scaleX = (index: number) => padding.left + (points.length <= 1 ? plotWidth : (index / (points.length - 1)) * plotWidth);
  const scaleY = (value: number) => padding.top + plotHeight / 2 - (value / maxAbs) * (plotHeight / 2 - 12);
  const zeroY = scaleY(0);
  const diskPath = buildLinePath(points.map((point, index) => [scaleX(index), scaleY(point.diskDeltaBytes)]));
  const mediaPath = buildLinePath(points.map((point, index) => [scaleX(index), scaleY(point.mediaDeltaBytes)]));
  const refPath = buildLinePath(points.map((point, index) => [scaleX(index), scaleY(point.refDeltaBytes)]));

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-900">本地存储变化</h3>
          <p className="text-xs leading-5 text-slate-500">浏览器保留最近 24 小时真实轮询快照，可按区间查看磁盘、媒体目录和参考图每轮增减。</p>
        </div>
        <div className="flex flex-col items-start gap-2 lg:items-end">
          <div className="flex flex-wrap gap-1 rounded-full border border-slate-200 bg-slate-50 p-1 text-xs">
            {STORAGE_TREND_RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onRangeChange(item.key)}
                className={`rounded-full px-3 py-1.5 font-bold transition ${range === item.key ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-500 hover:bg-white hover:text-slate-900'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <LegendDot color="bg-slate-900" label="磁盘已用" value={latestPoint ? formatSignedBytes(latestPoint.diskDeltaBytes) : '等待采样'} />
            <LegendDot color="bg-indigo-500" label="媒体目录" value={latestPoint ? formatSignedBytes(latestPoint.mediaDeltaBytes) : '等待采样'} />
            <LegendDot color="bg-emerald-500" label="参考图" value={latestPoint ? formatSignedBytes(latestPoint.refDeltaBytes) : '等待采样'} />
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        {points.length > 0 ? (
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="本地存储变化折线图" className="block h-[260px] w-full">
            <rect width={width} height={height} fill="#f8fafc" />
            {[0.25, 0.5, 0.75].map((ratio) => {
              const y = padding.top + plotHeight * ratio;
              return <line key={ratio} x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="4 6" />;
            })}
            <line x1={padding.left} x2={width - padding.right} y1={zeroY} y2={zeroY} stroke="#94a3b8" strokeWidth={1.5} />
            <text x={padding.left - 10} y={scaleY(maxAbs) + 4} textAnchor="end" className="fill-slate-400 text-[11px]">{formatBytes(maxAbs)}</text>
            <text x={padding.left - 10} y={zeroY + 4} textAnchor="end" className="fill-slate-400 text-[11px]">0</text>
            <text x={padding.left - 10} y={scaleY(-maxAbs) + 4} textAnchor="end" className="fill-slate-400 text-[11px]">-{formatBytes(maxAbs)}</text>
            {diskPath && <path d={diskPath} fill="none" stroke="#0f172a" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />}
            {mediaPath && <path d={mediaPath} fill="none" stroke="#6366f1" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />}
            {refPath && <path d={refPath} fill="none" stroke="#10b981" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />}
            {points.map((point, index) => (
              <g key={`${point.sampledAtMs}-${index}`}>
                <circle cx={scaleX(index)} cy={scaleY(point.diskDeltaBytes)} r={3.5} fill="#0f172a" />
                <circle cx={scaleX(index)} cy={scaleY(point.mediaDeltaBytes)} r={3.5} fill="#6366f1" />
                <circle cx={scaleX(index)} cy={scaleY(point.refDeltaBytes)} r={3.5} fill="#10b981" />
              </g>
            ))}
            <text x={padding.left} y={height - 12} className="fill-slate-400 text-[11px]">{formatChartTime(points[0]?.sampledAtMs)}</text>
            <text x={width - padding.right} y={height - 12} textAnchor="end" className="fill-slate-400 text-[11px]">{formatChartTime(points[points.length - 1]?.sampledAtMs)}</text>
          </svg>
        ) : (
          <div className="flex h-[260px] items-center justify-center px-4 text-center text-sm text-slate-500">
            当前 {storageTrendRangeLabel(range)} 区间内等待下一次轮询后显示变化趋势。当前值：磁盘已用 {formatBytes(latest.usedBytes)}，媒体目录 {formatBytes(latest.mediaBytes)}，参考图 {formatBytes(latest.refBytes)}。
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500">
        <InlineStat label="当前区间采样点" value={`${history.length}`} />
        <InlineStat label="本地保留" value={`${persistedCount}`} />
        <InlineStat label="当前磁盘已用" value={formatBytes(latest.usedBytes)} />
        <InlineStat label="当前媒体目录" value={formatBytes(latest.mediaBytes)} />
        <InlineStat label="当前参考图" value={formatBytes(latest.refBytes)} />
        <InlineStat label="页面时间" value={formatRelativeTime(new Date(now).toISOString(), now)} />
      </div>
    </section>
  );
}

/** 将折线坐标转成 SVG path。 */
function buildLinePath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
}

/** 趋势图图例项。 */
function LegendDot({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-slate-600">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      <span>{label}</span>
      <strong className="font-black tabular-nums text-slate-900">{value}</strong>
    </span>
  );
}
