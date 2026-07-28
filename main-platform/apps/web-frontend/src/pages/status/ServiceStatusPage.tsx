/** 服务状态页：展示 backend 公开状态接口返回的真实健康检查、任务、站点、Bot 和平台统计。 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  PublicServiceHealthView,
  PublicSiteRuntimeView,
  PublicSourceSummary,
  PublicStatusRange,
  PublicStatusResponse,
} from '@aiimage/shared-contracts';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle,
  Clock,
  Database,
  Image,
  RefreshCw,
  Server,
  TrendingUp,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import { api } from '../../lib/api';
import { Seo } from '../../components/Seo';

const RANGES: Array<{ key: PublicStatusRange; label: string }> = [
  { key: '1h', label: '1 小时' },
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
];

const SOURCE_LABELS: Record<string, string> = {
  web: '网页',
  bot: 'QQ Bot',
  api: 'API',
};

/** 旧版状态接口结构；用于生产前后端短暂不一致时兜底归一化展示。 */
type LegacyStatusPayload = {
  range?: PublicStatusRange;
  services?: Array<{
    name?: string;
    label?: string;
    ok?: boolean;
    statusCode?: number | null;
    version?: string;
    uptimeSec?: number;
    latencyMs?: number | null;
    error?: string | null;
  }>;
  sites?: Array<{
    id?: number;
    name?: string;
    isEnabled?: boolean;
    consecutiveFailures?: number;
    totalCalls?: number;
    successCount?: number;
    avgLatencyMs?: number;
    autoDisabledUntil?: string | null;
    autoDisabledReason?: string | null;
  }>;
  stats?: {
    total?: number;
    success?: number;
    failed?: number;
    successRate?: string | number | null;
  };
};

/** 公开服务状态页面。 */
export function ServiceStatusPage() {
  const [data, setData] = useState<PublicStatusResponse | null>(null);
  const [range, setRange] = useState<PublicStatusRange>('24h');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async (silent = false) => {
      if (!silent) setLoading(true);
      const result = await api<unknown>(`/api/status?range=${range}`);
      if (!alive) return;
      const normalized = result.ok ? normalizeStatusPayload(result.data, range) : null;
      if (normalized) {
        setData(removeRetiredFeatureStatusTraces(normalized));
        setError('');
      } else {
        setError(result.message ?? '状态数据加载失败');
      }
      setLoading(false);
    };

    // 状态页是公开看板，30 秒自动刷新即可；接口本身还有 5 秒后端缓存保护数据库。
    void load(false);
    const timer = window.setInterval(() => void load(true), 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [range]);

  const serviceSummary = useMemo(() => {
    const services = data?.services ?? [];
    const online = services.filter((service) => service.ok).length;
    const latencies = services
      .map((service) => service.latencyMs)
      .filter((latency): latency is number => typeof latency === 'number' && latency >= 0);
    const avgLatency = latencies.length > 0
      ? Math.round(latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length)
      : null;
    return { total: services.length, online, avgLatency };
  }, [data?.services]);

  if (loading && !data) {
    return <div className="text-center py-16 text-text-2">加载状态数据...</div>;
  }

  if (!data) {
    return (
      <div className="text-center py-16 text-text-2">
        {error || '无法获取状态数据'}
      </div>
    );
  }

  const activeTasks = data.tasks.queued + data.tasks.running + data.tasks.finalizing;
  const taskRateColor = getRateColor(data.tasks.successRate);
  const generatedAt = formatDateTime(data.generatedAt);
  const since = formatDateTime(data.since);

  return (
    <div className="animate-fade-in">
      <Seo title="服务状态" description="查看绘图姬 DrawHime 后端、绘图站点、Bot、任务成功率和平台运行状态。" path="/status" />
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="page-title flex items-center gap-2"><Activity size={20} />服务状态</h1>
          <div className="text-xs text-text-2 mt-1">统计区间：{since} 至 {generatedAt}</div>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-2">
          <RefreshCw size={13} />
          <span>30 秒自动刷新</span>
          {error && <span className="text-error">{error}</span>}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <StatCard label="服务在线" value={`${serviceSummary.online}/${serviceSummary.total}`} color={serviceSummary.online === serviceSummary.total ? '#10b981' : '#f59e0b'} icon={<Server size={16} />} />
        <StatCard label="本期任务" value={formatNumber(data.tasks.total)} icon={<BarChart3 size={16} />} />
        <StatCard label="终态成功率" value={formatPercent(data.tasks.successRate)} color={taskRateColor} icon={<TrendingUp size={16} />} />
        <StatCard label="本期进行中" value={formatNumber(activeTasks)} color={activeTasks > 0 ? '#6366f1' : undefined} icon={<Clock size={16} />} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_.85fr] gap-4 mb-5">
        <Panel title="任务状态分布" icon={<Database size={15} />}>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            <MetricBox label="总数" value={formatNumber(data.tasks.total)} />
            <MetricBox label="成功" value={formatNumber(data.tasks.success)} color="#10b981" />
            <MetricBox label="失败" value={formatNumber(data.tasks.failed)} color={data.tasks.failed > 0 ? '#ef4444' : undefined} />
            <MetricBox label="排队" value={formatNumber(data.tasks.queued)} />
            <MetricBox label="运行" value={formatNumber(data.tasks.running)} />
            <MetricBox label="收尾" value={formatNumber(data.tasks.finalizing)} />
          </div>
        </Panel>

        <Panel title="平台概览" icon={<Users size={15} />}>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-2 gap-2">
            <MetricBox label="注册用户" value={formatNumber(data.platform.users)} />
            <MetricBox label="已验证邮箱" value={formatNumber(data.platform.verifiedUsers)} />
            <MetricBox label="公开作品" value={formatNumber(data.platform.publicImages)} icon={<Image size={13} />} />
            <MetricBox label="启用站点" value={formatNumber(data.platform.enabledSites)} icon={<Zap size={13} />} />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_.85fr] gap-4 mb-6">
        <Panel title="服务节点" icon={<Server size={15} />} extra={serviceSummary.avgLatency === null ? undefined : `平均探活 ${formatLatency(serviceSummary.avgLatency)}`}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {data.services.map((service) => <ServiceNode key={service.name} service={service} />)}
          </div>
        </Panel>

        <Panel title="来源与 Bot" icon={<Bot size={15} />}>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <MetricBox label="Bot 总数" value={formatNumber(data.bots.total)} />
            <MetricBox label="在线" value={formatNumber(data.bots.online)} color="#10b981" />
            <MetricBox label="封禁" value={formatNumber(data.bots.banned)} color={data.bots.banned > 0 ? '#ef4444' : undefined} />
          </div>
          <div className="space-y-2">
            {data.sources.length > 0
              ? data.sources.map((source) => <SourceRow key={source.source} source={source} />)
              : <div className="text-xs text-text-2 py-3 text-center">当前区间暂无来源数据</div>}
          </div>
        </Panel>
      </div>

      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-2"><Zap size={14} />绘图站点运行统计</h2>
        <div className="flex gap-0 border border-border rounded-lg overflow-hidden bg-surface">
          {RANGES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setRange(item.key)}
              className="text-xs px-3 py-1.5 font-medium border-0 cursor-pointer transition-colors"
              style={{ background: range === item.key ? 'var(--color-primary)' : 'transparent', color: range === item.key ? '#fff' : 'var(--color-text-2)' }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {data.sites.map((site) => <SiteCard key={site.id} site={site} />)}
      </div>
      {data.sites.length === 0 && <div className="text-center py-12 text-text-2 text-sm">暂无站点数据</div>}
    </div>
  );
}

/** 归一化状态接口响应；新结构直接使用，旧结构补齐字段后展示，避免部署窗口期数据错位。 */
function normalizeStatusPayload(value: unknown, selectedRange: PublicStatusRange): PublicStatusResponse | null {
  if (isPublicStatusResponse(value)) return value;
  if (!isRecord(value)) return null;
  const legacy = value as LegacyStatusPayload;
  if (!legacy.stats && !Array.isArray(legacy.services) && !Array.isArray(legacy.sites)) return null;

  const total = toNonNegativeInteger(legacy.stats?.total);
  const success = toNonNegativeInteger(legacy.stats?.success);
  const failed = toNonNegativeInteger(legacy.stats?.failed);
  const generatedAt = new Date().toISOString();
  const since = new Date(Date.now() - rangeToMs(selectedRange)).toISOString();

  return {
    range: legacy.range ?? selectedRange,
    since,
    generatedAt,
    services: normalizeLegacyServices(legacy.services),
    tasks: {
      total,
      queued: 0,
      running: 0,
      finalizing: 0,
      success,
      failed,
      terminalTotal: success + failed,
      successRate: parsePercent(legacy.stats?.successRate, success + failed > 0 ? (success / (success + failed)) * 100 : null),
    },
    sources: [],
    sites: normalizeLegacySites(legacy.sites),
    bots: { total: 0, online: 0, offline: 0, banned: 0 },
    platform: {
      users: 0,
      verifiedUsers: 0,
      publicImages: 0,
      enabledSites: (legacy.sites ?? []).filter((site) => site.isEnabled === true && !isFutureDate(site.autoDisabledUntil)).length,
    },
  };
}

/** 判断是否已经是新版公开状态响应。 */
function isPublicStatusResponse(value: unknown): value is PublicStatusResponse {
  if (!isRecord(value)) return false;
  return (value.range === '1h' || value.range === '24h' || value.range === '7d')
    && typeof value.generatedAt === 'string'
    && typeof value.since === 'string'
    && Array.isArray(value.services)
    && isRecord(value.tasks)
    && Array.isArray(value.sources)
    && Array.isArray(value.sites)
    && isRecord(value.bots)
    && isRecord(value.platform);
}

/** 归一化旧版服务健康节点，补齐新版页面需要的字段。 */
function normalizeLegacyServices(services: LegacyStatusPayload['services']): PublicServiceHealthView[] {
  return (services ?? []).map((service) => ({
    name: service.name ?? 'unknown',
    label: service.label ?? SERVICE_LABELS[service.name ?? ''] ?? service.name ?? '未知服务',
    ok: service.ok === true,
    statusCode: typeof service.statusCode === 'number' ? service.statusCode : service.ok === true ? 200 : null,
    version: service.version ?? '',
    uptimeSec: toNonNegativeInteger(service.uptimeSec),
    latencyMs: typeof service.latencyMs === 'number' ? Math.max(0, service.latencyMs) : null,
    error: service.error ?? null,
  }));
}

/** 归一化旧版站点统计；旧接口只有生命周期字段，因此本期尝试显示为累计调用。 */
function normalizeLegacySites(sites: LegacyStatusPayload['sites']): PublicSiteRuntimeView[] {
  return (sites ?? []).map((site) => {
    const lifetimeCalls = toNonNegativeInteger(site.totalCalls);
    const lifetimeSuccess = toNonNegativeInteger(site.successCount);
    const activeAutoDisabledUntil = isFutureDate(site.autoDisabledUntil) ? site.autoDisabledUntil ?? null : null;
    return {
      id: typeof site.id === 'number' ? site.id : 0,
      name: site.name ?? '未命名站点',
      isEnabled: site.isEnabled === true,
      weight: 0,
      maxConcurrency: 0,
      consecutiveFailures: toNonNegativeInteger(site.consecutiveFailures),
      autoDisabledUntil: activeAutoDisabledUntil,
      autoDisabledReason: activeAutoDisabledUntil ? site.autoDisabledReason ?? null : null,
      lifetimeCalls,
      lifetimeSuccess,
      lifetimeAvgLatencyMs: toNonNegativeInteger(site.avgLatencyMs),
      attempts: lifetimeCalls,
      success: lifetimeSuccess,
      failed: Math.max(0, lifetimeCalls - lifetimeSuccess),
      active: 0,
      // 旧接口没有当前区间终态尝试，只能用生命周期成功率作为兼容展示。
      successRate: lifetimeCalls > 0 ? (lifetimeSuccess / lifetimeCalls) * 100 : null,
      avgLatencyMs: typeof site.avgLatencyMs === 'number' ? Math.max(0, site.avgLatencyMs) : null,
    };
  });
}

/** 服务标识到中文名称的兜底映射。 */
const SERVICE_LABELS: Record<string, string> = {
  backend: '后端',
  'drawing-service': '绘图调度',
  'drawing-worker': '绘图 Worker',
  'media-service': '媒体存储',
  'bot-service': 'Bot 服务',
  'bot-renderer': '卡片渲染',
  'wsproxy-service': 'WS 代理',
  'notification-worker': '邮件通知',
  'ops-worker': '运维 Worker',
};

/** 隐藏已下线功能的历史聚合值，避免公开状态页继续展示废弃入口。 */
function removeRetiredFeatureStatusTraces(value: PublicStatusResponse): PublicStatusResponse {
  return {
    ...value,
    services: value.services.filter((service) => service.name !== 'workflow-service'),
    sources: value.sources.filter((source) => source.source !== 'workflow'),
  };
}

/** 状态页通用分组面板。 */
function Panel({ title, icon, extra, children }: { title: string; icon: ReactNode; extra?: string; children: ReactNode }) {
  return (
    <section className="card" style={{ padding: '16px' }}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold flex items-center gap-2">{icon}{title}</h2>
        {extra && <span className="text-[11px] text-text-2">{extra}</span>}
      </div>
      {children}
    </section>
  );
}

/** 顶部概览指标卡。 */
function StatCard({ label, value, color, icon }: { label: string; value: string; color?: string; icon: ReactNode }) {
  return (
    <div className="card text-center" style={{ padding: '16px 12px' }}>
      <div className="flex justify-center mb-1" style={{ color: color ?? 'var(--color-text-2)' }}>{icon}</div>
      <div className="text-xs text-text-2 mb-0.5">{label}</div>
      <div className="text-xl font-bold" style={{ color: color ?? 'var(--color-text)' }}>{value}</div>
    </div>
  );
}

/** 小型数字指标块。 */
function MetricBox({ label, value, color, icon }: { label: string; value: string; color?: string; icon?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-bg/40 px-3 py-2 min-w-0">
      <div className="flex items-center gap-1 text-[11px] text-text-2 mb-0.5">{icon}{label}</div>
      <div className="text-base font-bold truncate" style={{ color: color ?? 'var(--color-text)' }}>{value}</div>
    </div>
  );
}

/** 单个服务节点健康卡。 */
function ServiceNode({ service }: { service: PublicServiceHealthView }) {
  const uptime = service.ok && service.uptimeSec > 0 ? formatUptime(service.uptimeSec) : '';
  return (
    <div className="rounded-lg border border-border bg-bg/35 px-3 py-3 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-1" style={{ background: service.ok ? 'var(--color-success)' : 'var(--color-error)' }} />
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-semibold truncate">{service.label}</span>
        {service.ok ? <CheckCircle size={16} className="text-success" /> : <XCircle size={16} className="text-error" />}
      </div>
      <div className="text-[11px] text-text-2">{service.ok ? (uptime || '在线') : service.error || '离线'}</div>
      <div className="text-[11px] text-text-2 mt-1 flex justify-between gap-2">
        <span>{service.version || '无版本'}</span>
        <span>{service.latencyMs === null ? '-' : formatLatency(service.latencyMs)}</span>
      </div>
    </div>
  );
}

/** 按来源展示任务真实成功/失败分布。 */
function SourceRow({ source }: { source: PublicSourceSummary }) {
  const successRate = source.success + source.failed > 0 ? (source.success / (source.success + source.failed)) * 100 : null;
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="text-xs font-semibold">{SOURCE_LABELS[source.source] ?? source.source}</span>
        <span className="text-[11px] text-text-2">共 {formatNumber(source.total)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <span className="text-success">成功 {formatNumber(source.success)}</span>
        <span className={source.failed > 0 ? 'text-error' : 'text-text-2'}>失败 {formatNumber(source.failed)}</span>
        <span className="text-text-2">终态率 {successRate === null ? '-' : `${successRate.toFixed(1)}%`}</span>
      </div>
    </div>
  );
}

/** 单个绘图站点在当前区间和生命周期内的统计卡。 */
function SiteCard({ site }: { site: PublicSiteRuntimeView }) {
  const status = getSiteStatus(site);
  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: status.color, flexShrink: 0 }} />
          <span className="text-sm font-semibold truncate">{site.name}</span>
        </div>
        <span className="text-[11px] font-medium px-2 py-0.5 rounded flex-shrink-0" style={{ background: status.color + '20', color: status.color }}>
          {status.text}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-y-3 gap-x-2 text-center">
        <Metric label="本期尝试" value={formatNumber(site.attempts)} />
        <Metric label="本期成功率" value={formatPercent(site.successRate)} color={getRateColor(site.successRate)} />
        <Metric label="本期耗时" value={formatLatency(site.avgLatencyMs)} />
        <Metric label="成功/失败" value={`${formatNumber(site.success)}/${formatNumber(site.failed)}`} color={site.failed > 0 ? '#f59e0b' : '#10b981'} />
        <Metric label="运行中" value={formatNumber(site.active)} color={site.active > 0 ? '#6366f1' : undefined} />
        <Metric label="连续失败" value={formatNumber(site.consecutiveFailures)} color={site.consecutiveFailures > 0 ? '#ef4444' : undefined} />
      </div>

      <div className="mt-3 pt-3 border-t border-border grid grid-cols-3 gap-2 text-center">
        <Metric label="权重" value={formatNumber(site.weight)} />
        <Metric label="并发" value={formatNumber(site.maxConcurrency)} />
        <Metric label="累计成功率" value={formatPercent(site.lifetimeCalls > 0 ? (site.lifetimeSuccess / site.lifetimeCalls) * 100 : null)} />
      </div>

      {site.autoDisabledUntil && (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-warning rounded px-2.5 py-1.5" style={{ background: 'var(--color-warning-soft)' }}>
          <AlertTriangle size={11} />
          <span className="truncate">自动禁用至 {formatDateTime(site.autoDisabledUntil)}</span>
        </div>
      )}
      {site.autoDisabledReason && !site.autoDisabledUntil && (
        <div className="mt-3 text-[11px] text-text-2 truncate">{site.autoDisabledReason}</div>
      )}
    </div>
  );
}

/** 站点卡片内的小指标。 */
function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-text-2 mb-0.5 truncate">{label}</div>
      <div className="text-sm font-bold truncate" style={{ color: color ?? 'var(--color-text)' }}>{value}</div>
    </div>
  );
}

/** 根据站点真实运行数据推断公开健康状态。 */
function getSiteStatus(site: PublicSiteRuntimeView): { text: string; color: string } {
  if (!site.isEnabled) return { text: '已停用', color: '#9ca3af' };
  if (site.autoDisabledUntil) return { text: '自动禁用', color: '#f59e0b' };
  if (site.consecutiveFailures >= 3) return { text: '异常', color: '#ef4444' };
  if (site.active > 0) return { text: '运行中', color: '#6366f1' };
  if (site.successRate === null) return { text: '待观察', color: '#64748b' };
  if (site.successRate >= 95) return { text: '健康', color: '#10b981' };
  if (site.successRate >= 80) return { text: '波动', color: '#f59e0b' };
  return { text: '异常', color: '#ef4444' };
}

/** 百分比颜色分级。 */
function getRateColor(rate: number | null): string | undefined {
  if (rate === null) return undefined;
  if (rate >= 95) return '#10b981';
  if (rate >= 80) return '#f59e0b';
  return '#ef4444';
}

/** 格式化百分比，空值显示短横线。 */
function formatPercent(rate: number | null): string {
  return rate === null ? '-' : `${rate.toFixed(1)}%`;
}

/** 格式化整数统计值。 */
function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

/** 格式化延迟。 */
function formatLatency(ms: number | null): string {
  if (ms === null || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** 格式化服务运行时间。 */
function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

/** 格式化状态页时间戳。 */
function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 判断 unknown 是否为对象记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 转换非负整数统计值，异常值按 0 处理。 */
function toNonNegativeInteger(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

/** 解析百分比，旧接口可能返回 "54.2%" 字符串。 */
function parsePercent(value: unknown, fallback: number | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === 'string') {
    const numeric = Number(value.replace('%', ''));
    if (Number.isFinite(numeric)) return Math.max(0, numeric);
  }
  return fallback;
}

/** 判断时间字符串是否在当前时间之后。 */
function isFutureDate(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.now();
}

/** 状态页范围转换为毫秒，用于旧接口兜底 since 字段。 */
function rangeToMs(value: PublicStatusRange): number {
  if (value === '1h') return 60 * 60 * 1000;
  if (value === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}
