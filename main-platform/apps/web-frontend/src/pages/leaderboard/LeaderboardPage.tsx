/** 排行榜页面：展示公开用户主任务调用排行，后续可扩展更多榜单类型。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  LeaderboardRange,
  UserTaskLeaderboardItem,
  UserTaskLeaderboardKind,
  UserTaskLeaderboardResponse,
} from '@aiimage/shared-contracts';
import { Award, BarChart3, Clock, Loader2, RefreshCw, Trophy, Users, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { getAvatarInitial } from '../../lib/avatar';
import { useAuth } from '../../providers/AuthProvider';
import { Seo } from '../../components/Seo';
import './LeaderboardPage.css';

type LeaderboardSortKey = 'rank' | 'nickname' | 'totalTasks' | 'successTasks' | 'failedTasks' | 'activeTasks' | 'successRate' | 'webTasks' | 'qqTasks';
type LeaderboardSortDirection = 'asc' | 'desc';

const RANGE_OPTIONS: Array<{ key: LeaderboardRange; label: string }> = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: 'all', label: '全部' },
];

const KIND_OPTIONS: Array<{ key: UserTaskLeaderboardKind; label: string }> = [
  { key: 'most_tasks', label: '最多调用' },
];

const LIMIT_OPTIONS = [20, 50, 100];

const LEADERBOARD_COLUMNS: Array<{ key: LeaderboardSortKey; label: string; numeric: boolean }> = [
  { key: 'rank', label: '排名', numeric: true },
  { key: 'nickname', label: '用户', numeric: false },
  { key: 'totalTasks', label: '总任务', numeric: true },
  { key: 'successTasks', label: '成功', numeric: true },
  { key: 'failedTasks', label: '失败', numeric: true },
  { key: 'activeTasks', label: '进行中', numeric: true },
  { key: 'successRate', label: '成功率', numeric: true },
  { key: 'webTasks', label: '网页', numeric: true },
  { key: 'qqTasks', label: 'QQ', numeric: true },
];

/** 用户任务排行榜页面。 */
export function LeaderboardPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const range = normalizeRange(params.get('range'));
  const kind = normalizeKind(params.get('kind'));
  const limit = normalizeLimit(params.get('limit'));
  const [data, setData] = useState<UserTaskLeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>('rank');
  const [sortDirection, setSortDirection] = useState<LeaderboardSortDirection>('asc');
  const requestSeq = useRef(0);

  const load = useCallback(async (silent = false) => {
    const seq = ++requestSeq.current;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    const qs = new URLSearchParams({ kind, range, limit: String(limit) });
    const result = await api<UserTaskLeaderboardResponse>(`/api/leaderboards/users/tasks?${qs}`);
    if (seq !== requestSeq.current) return;
    if (result.ok && result.data) {
      setData(result.data);
      setError('');
    } else {
      setError(result.message || '排行榜加载失败');
    }
    setLoading(false);
  }, [kind, range, limit]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const topItem = data?.items[0] ?? null;
  const successRate = useMemo(() => {
    if (!data || data.summary.totalTasks <= 0) return null;
    const success = data.items.reduce((sum, item) => sum + item.successTasks, 0);
    const failed = data.items.reduce((sum, item) => sum + item.failedTasks, 0);
    const terminal = success + failed;
    return terminal > 0 ? (success / terminal) * 100 : null;
  }, [data]);
  const sortedItems = useMemo(() => {
    if (!data) return [];
    return sortLeaderboardItems(data.items, sortKey, sortDirection);
  }, [data, sortKey, sortDirection]);

  const updateParam = (key: string, value: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(key, value);
      return next;
    });
  };

  const updateSort = (key: LeaderboardSortKey) => {
    setSortKey((currentKey) => {
      if (currentKey === key) {
        setSortDirection((currentDirection) => currentDirection === 'asc' ? 'desc' : 'asc');
        return currentKey;
      }
      setSortDirection(key === 'rank' || key === 'nickname' ? 'asc' : 'desc');
      return key;
    });
  };

  return (
    <div className="leaderboard-page animate-fade-in">
      <Seo title="排行榜" description="查看绘图姬 DrawHime 用户任务排行榜，按 24 小时、7 天、30 天和全部时间统计主任务调用次数。" path="/leaderboard" />
      <div className="leaderboard-head">
        <div>
          <h1 className="page-title flex items-center gap-2"><Trophy size={21} />排行榜</h1>
          <div className="leaderboard-subtitle">按生成主任务统计，不包含上游重试或子任务尝试。</div>
        </div>
        <button type="button" className="btn btn-outline btn-sm flex items-center gap-1.5" onClick={() => void load(false)} disabled={loading}>
          {loading ? <Loader2 size={13} className="leaderboard-spin" /> : <RefreshCw size={13} />}
          刷新
        </button>
      </div>

      <section className="leaderboard-filter card">
        <div className="leaderboard-filter-group">
          <span className="leaderboard-filter-label">榜单</span>
          <div className="leaderboard-segment">
            {KIND_OPTIONS.map((item) => (
              <button key={item.key} type="button" className={kind === item.key ? 'is-active' : ''} onClick={() => updateParam('kind', item.key)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="leaderboard-filter-group">
          <span className="leaderboard-filter-label">范围</span>
          <div className="leaderboard-segment">
            {RANGE_OPTIONS.map((item) => (
              <button key={item.key} type="button" className={range === item.key ? 'is-active' : ''} onClick={() => updateParam('range', item.key)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <label className="leaderboard-limit">
          <span>显示</span>
          <select className="input" value={limit} onChange={(event) => updateParam('limit', event.target.value)}>
            {LIMIT_OPTIONS.map((item) => <option key={item} value={item}>前 {item}</option>)}
          </select>
        </label>
      </section>

      {loading && !data ? (
        <LeaderboardSkeleton />
      ) : error && !data ? (
        <div className="leaderboard-empty card">
          <XCircle size={30} />
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => void load(false)}>重试</button>
        </div>
      ) : data ? (
        <>
          <CurrentUserRankCard user={user} data={data} range={range} />

          <div className="leaderboard-summary-grid">
            <SummaryCard label="上榜用户" value={formatNumber(data.summary.totalUsers)} icon={<Users size={16} />} />
            <SummaryCard label="本期主任务" value={formatNumber(data.summary.totalTasks)} icon={<BarChart3 size={16} />} />
            <SummaryCard label="榜首" value={topItem ? topItem.nickname : '-'} hint={topItem ? `${formatNumber(topItem.totalTasks)} 次` : undefined} icon={<Award size={16} />} />
            <SummaryCard label="Top 终态成功率" value={successRate === null ? '-' : `${successRate.toFixed(1)}%`} icon={<Clock size={16} />} />
          </div>

          <div className="leaderboard-time-row">
            <span>统计时间：{formatRange(data.summary.since, data.summary.until)}</span>
            {error && <span className="text-error">{error}</span>}
          </div>

          {data.items.length > 0 ? (
            <section className="leaderboard-table-card card">
              <div className="leaderboard-table-head">
                <strong>用户任务排行</strong>
                <span>按总主任务数降序，成功数作为同分排序参考</span>
              </div>
              <div className="leaderboard-table" role="table" aria-label="用户任务排行榜">
                <div className="leaderboard-row leaderboard-row-head" role="row">
                  {LEADERBOARD_COLUMNS.map((column) => (
                    <span key={column.key} role="columnheader" aria-sort={sortKey === column.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className={`leaderboard-sort-button${column.numeric ? ' is-numeric' : ''}${sortKey === column.key ? ' is-active' : ''}`} onClick={() => updateSort(column.key)}>
                        {column.label}
                        <span aria-hidden="true">{sortKey === column.key ? (sortDirection === 'asc' ? '▲' : '▼') : '↕'}</span>
                      </button>
                    </span>
                  ))}
                </div>
                {sortedItems.map((item) => <LeaderboardRow key={item.accountKey} item={item} />)}
              </div>
            </section>
          ) : (
            <div className="leaderboard-empty card">
              <Trophy size={30} />
              <span>当前范围暂无任务数据</span>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/** 当前登录用户排名独立区域；排名由 backend 在完整榜单上计算，不受当前 limit 影响。 */
function CurrentUserRankCard({
  user,
  data,
  range,
}: {
  user: { username: string } | null;
  data: UserTaskLeaderboardResponse;
  range: LeaderboardRange;
}) {
  const current = data.currentUser;
  const item = current?.item ?? null;
  const successRate = item ? calcSuccessRate(item) : null;

  if (!user) {
    return (
      <section className="leaderboard-me-card card is-guest">
        <div className="leaderboard-me-copy">
          <span>我的排名</span>
          <strong>登录后查看当前排名</strong>
          <small>会按当前筛选范围统计你的网页账号和已绑定 QQ Bot 任务。</small>
        </div>
        <Link to="/login" className="btn btn-sm">登录</Link>
      </section>
    );
  }

  if (!item) {
    return (
      <section className="leaderboard-me-card card is-empty">
        <div className="leaderboard-me-copy">
          <span>我的排名</span>
          <strong>当前范围暂无排名</strong>
          <small>{rangeLabel(range)} 内还没有可统计的主任务。</small>
        </div>
        <Link to="/" className="btn btn-sm">去生成</Link>
      </section>
    );
  }

  return (
    <section className="leaderboard-me-card card">
      <div className="leaderboard-me-rank">#{item.rank}</div>
      <LeaderboardAvatar item={item} />
      <div className="leaderboard-me-copy">
        <span>我的排名 · {rangeLabel(range)}</span>
        <strong>{item.nickname}</strong>
        <small>{current?.includedInItems ? '已显示在下方榜单中' : '未进入当前页展示上限，但已计算完整排名'}</small>
      </div>
      <div className="leaderboard-me-stats">
        <span><b>{formatNumber(item.totalTasks)}</b>总任务</span>
        <span><b>{formatNumber(item.successTasks)}</b>成功</span>
        <span><b>{successRate === null ? '-' : `${successRate.toFixed(1)}%`}</b>成功率</span>
      </div>
    </section>
  );
}

/** 单行排行榜展示。 */
function LeaderboardRow({ item }: { item: UserTaskLeaderboardItem }) {
  const topRankClass = item.rank <= 3 ? ` is-top-three is-rank-${item.rank}` : '';
  const webTasks = getChannelTaskCount(item, 'web');
  const qqTasks = getChannelTaskCount(item, 'qq');
  const successRate = calcSuccessRate(item);
  return (
    <div className={`leaderboard-row${topRankClass}`} role="row">
      <span className="leaderboard-rank" data-rank={item.rank}>#{item.rank}</span>
      <span className="leaderboard-user">
        <LeaderboardAvatar item={item} />
        <span className="leaderboard-name-wrap">
          {item.userId ? (
            <Link to={`/users/${item.userId}`} className="leaderboard-name">{item.nickname}</Link>
          ) : (
            <span className="leaderboard-name">{item.nickname}</span>
          )}
        </span>
      </span>
      <span className="leaderboard-number is-strong">{formatNumber(item.totalTasks)}</span>
      <span className="leaderboard-number text-success">{formatNumber(item.successTasks)}</span>
      <span className={item.failedTasks > 0 ? 'leaderboard-number text-error' : 'leaderboard-number text-text-2'}>{formatNumber(item.failedTasks)}</span>
      <span className="leaderboard-number text-text-2">{formatNumber(item.activeTasks)}</span>
      <span className="leaderboard-number">{formatPercent(successRate)}</span>
      <span className="leaderboard-number leaderboard-source-number is-web">{formatNumber(webTasks)}</span>
      <span className="leaderboard-number leaderboard-source-number is-qq">{formatNumber(qqTasks)}</span>
      <div className="leaderboard-mobile-card" aria-hidden="true">
        <div className="leaderboard-mobile-main">
          <span className="leaderboard-mobile-rank">#{item.rank}</span>
          <LeaderboardAvatar item={item} />
          <span className="leaderboard-mobile-name">{item.nickname}</span>
          <span className="leaderboard-mobile-total">{formatNumber(item.totalTasks)}</span>
        </div>
        <div className="leaderboard-mobile-metrics">
          <span><small>成功</small><b>{formatNumber(item.successTasks)}</b></span>
          <span><small>失败</small><b>{formatNumber(item.failedTasks)}</b></span>
          <span><small>进行中</small><b>{formatNumber(item.activeTasks)}</b></span>
          <span><small>成功率</small><b>{formatPercent(successRate)}</b></span>
          <span><small>网页</small><b>{formatNumber(webTasks)}</b></span>
          <span><small>QQ</small><b>{formatNumber(qqTasks)}</b></span>
        </div>
      </div>
    </div>
  );
}

/** 排行榜头像：接口优先返回 Web/QQ 头像，图片失败时本地降级到首字符。 */
function LeaderboardAvatar({ item }: { item: UserTaskLeaderboardItem }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initial = getAvatarInitial(item.nickname);
  return (
    <span className={`leaderboard-avatar is-${item.avatarSource}`} aria-hidden="true">
      {item.avatarUrl && !imageFailed && <img src={item.avatarUrl} alt="" loading="lazy" onError={() => setImageFailed(true)} />}
      <span>{initial}</span>
    </span>
  );
}

/** 顶部汇总卡片。 */
function SummaryCard({ label, value, hint, icon }: { label: string; value: string; hint?: string; icon: ReactNode }) {
  return (
    <div className="leaderboard-summary-card card">
      <div className="leaderboard-summary-icon">{icon}</div>
      <div>
        <div className="leaderboard-summary-label">{label}</div>
        <div className="leaderboard-summary-value" title={value}>{value}</div>
        {hint && <div className="leaderboard-summary-hint">{hint}</div>}
      </div>
    </div>
  );
}

/** 首屏骨架屏。 */
function LeaderboardSkeleton() {
  return (
    <div className="leaderboard-skeleton">
      <div className="leaderboard-summary-grid">
        {Array.from({ length: 4 }).map((_, index) => <div key={index} className="card"><div className="skeleton h-4 mb-3" /><div className="skeleton h-7 w-2/3" /></div>)}
      </div>
      <div className="card">
        {Array.from({ length: 8 }).map((_, index) => <div key={index} className="skeleton h-9 mb-2" />)}
      </div>
    </div>
  );
}

/** URL 参数范围兜底。 */
function normalizeRange(value: string | null): LeaderboardRange {
  if (value === '7d' || value === '30d' || value === 'all') return value;
  return '24h';
}

/** URL 参数榜单类型兜底。 */
function normalizeKind(value: string | null): UserTaskLeaderboardKind {
  return value === 'most_tasks' ? value : 'most_tasks';
}

/** URL 参数数量兜底。 */
function normalizeLimit(value: string | null): number {
  const numeric = Number(value ?? 50);
  if (!Number.isFinite(numeric)) return 50;
  if (numeric <= 20) return 20;
  if (numeric <= 50) return 50;
  return 100;
}

/** 格式化整数。 */
function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

/** 按固定展示列统计渠道任务数；QQ 列兼容后端当前 bot 来源命名。 */
function getChannelTaskCount(item: UserTaskLeaderboardItem, channel: 'web' | 'qq'): number {
  const acceptedSources = channel === 'web' ? ['web'] : ['bot', 'qq'];
  return item.sourceCounts
    .filter((source) => acceptedSources.includes(source.source))
    .reduce((sum, source) => sum + source.tasks, 0);
}

/** 按当前表头排序当前已加载榜单；后端真实 rank 保持原值，只调整展示顺序。 */
function sortLeaderboardItems(items: UserTaskLeaderboardItem[], sortKey: LeaderboardSortKey, direction: LeaderboardSortDirection): UserTaskLeaderboardItem[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const left = getSortValue(a, sortKey);
    const right = getSortValue(b, sortKey);
    const compared = typeof left === 'string' && typeof right === 'string'
      ? left.localeCompare(right, 'zh-CN')
      : Number(left) - Number(right);
    if (compared !== 0) return compared * multiplier;
    return a.rank - b.rank;
  });
}

/** 提取排序值，来源列使用固定渠道统计，成功率按终态任务计算。 */
function getSortValue(item: UserTaskLeaderboardItem, sortKey: LeaderboardSortKey): number | string {
  if (sortKey === 'nickname') return item.nickname;
  if (sortKey === 'successRate') return calcSuccessRate(item) ?? -1;
  if (sortKey === 'webTasks') return getChannelTaskCount(item, 'web');
  if (sortKey === 'qqTasks') return getChannelTaskCount(item, 'qq');
  return item[sortKey];
}

/** 当前排名卡的时间范围中文标签。 */
function rangeLabel(range: LeaderboardRange): string {
  const option = RANGE_OPTIONS.find((item) => item.key === range);
  return option?.label ?? '24 小时';
}

/** 计算单个用户的终态成功率，进行中任务不参与分母。 */
function calcSuccessRate(item: UserTaskLeaderboardItem): number | null {
  const terminal = item.successTasks + item.failedTasks;
  return terminal > 0 ? (item.successTasks / terminal) * 100 : null;
}

/** 成功率展示；没有终态任务时不显示伪百分比。 */
function formatPercent(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}%`;
}

/** 格式化排行榜统计区间。 */
function formatRange(since: string | null, until: string): string {
  const end = formatDateTime(until);
  if (!since) return `全部历史 至 ${end}`;
  return `${formatDateTime(since)} 至 ${end}`;
}

/** 格式化日期时间。 */
function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
