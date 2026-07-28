/**
 * 仪表盘 — 系统总览
 * 统计卡片行 + 最近任务表格 + 服务健康列表
 * 纯 Tailwind CSS, lucide-react 图标, 无 antd
 */
import { useState, useEffect } from 'react';
import {
  TrendingUp, Users, CheckCircle, Image,
  Server, AlertTriangle, Activity, Loader2, RefreshCw,
} from 'lucide-react';
import { api } from '../../api/client';
import Toast from '../../components/Toast';
import { useAdminRuntimeConfig } from '../../app/runtime-config';

/* ---------- 类型定义 ---------- */

interface TrendBucket {
  timestamp: string;
  total: number;
  success: number;
  failed: number;
}

interface ServiceHealth {
  name: string;
  ok: boolean;
  uptimeSec: number;
}

interface GenerationItem {
  id: string;
  qqNumber?: string;
  source?: string;
  status?: string;
  prompt?: string;
  createdAt?: string;
}

interface StatsData {
  totalUsers?: number;
  verifiedUsers?: number;
  boundQQCount?: number;
  totalGenerations?: number;
  queuedTasks?: number;
  runningTasks?: number;
  failedTasks24h?: number;
  successRate24h?: string;
  enabledSites?: number;
  riskAlerts?: { message: string }[];
}

interface TrendResponse {
  buckets: TrendBucket[];
}

interface HealthResponse {
  services: ServiceHealth[];
}

interface GenerationsResponse {
  items: GenerationItem[];
}

/* ---------- 统计卡片定义 ---------- */

const STAT_CARDS: { label: string; key: keyof StatsData; icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; color: string }[] = [
  { label: '总用户', key: 'totalUsers', icon: Users, color: 'text-indigo-600 bg-indigo-50' },
  { label: '已验证', key: 'verifiedUsers', icon: CheckCircle, color: 'text-emerald-600 bg-emerald-50' },
  { label: '已绑QQ', key: 'boundQQCount', icon: Users, color: 'text-sky-600 bg-sky-50' },
  { label: '总生成', key: 'totalGenerations', icon: Image, color: 'text-violet-600 bg-violet-50' },
  { label: '排队中', key: 'queuedTasks', icon: Activity, color: 'text-amber-600 bg-amber-50' },
  { label: '运行中', key: 'runningTasks', icon: TrendingUp, color: 'text-blue-600 bg-blue-50' },
  { label: '24h失败', key: 'failedTasks24h', icon: AlertTriangle, color: 'text-red-600 bg-red-50' },
  { label: '24h成功率', key: 'successRate24h', icon: TrendingUp, color: 'text-teal-600 bg-teal-50' },
  { label: '启用站点', key: 'enabledSites', icon: Server, color: 'text-cyan-600 bg-cyan-50' },
];

/* ---------- 辅助函数 ---------- */

function statusBadgeClasses(status: string): string {
  switch (status) {
    case 'success': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'failed': return 'bg-red-50 text-red-700 border-red-200';
    case 'running': return 'bg-blue-50 text-blue-700 border-blue-200';
    default: return 'bg-gray-50 text-gray-600 border-gray-200';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'success': return '成功';
    case 'failed': return '失败';
    case 'running': return '生成中';
    default: return status || '-';
  }
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function maxTrendValue(trend: TrendBucket[]): number {
  return Math.max(1, ...trend.map((t) => t.total));
}

/* ---------- 组件 ---------- */

export function DashboardPage() {
  const { pollIntervalSec } = useAdminRuntimeConfig();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [trend, setTrend] = useState<TrendBucket[]>([]);
  const [recent, setRecent] = useState<GenerationItem[]>([]);
  const [svcHealth, setSvcHealth] = useState<ServiceHealth[]>([]);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const load = async () => {
    const results = await Promise.allSettled([
      api<StatsData>('/admin/stats'),
      api<TrendResponse>('/admin/stats/trends?days=7'),
      api<GenerationsResponse>('/admin/generations?pageSize=10'),
      api<HealthResponse>('/admin/health/services'),
    ]);

    const [statsR, trendR, recentR, healthR] = results;

    if (statsR.status === 'fulfilled' && statsR.value.ok) {
      setStats(statsR.value.data ?? null);
    } else {
      const msg = statsR.status === 'rejected'
        ? (statsR.reason instanceof Error ? statsR.reason.message : '获取统计数据失败')
        : statsR.value.message ?? '获取统计数据失败';
      setToast({ message: msg, type: 'error' });
    }

    if (trendR.status === 'fulfilled' && trendR.value.ok) {
      setTrend(trendR.value.data?.buckets ?? []);
    }

    if (recentR.status === 'fulfilled' && recentR.value.ok) {
      setRecent(recentR.value.data?.items ?? []);
    }

    if (healthR.status === 'fulfilled' && healthR.value.ok) {
      setSvcHealth(healthR.value.data?.services ?? []);
    } else {
      const msg = healthR.status === 'rejected'
        ? (healthR.reason instanceof Error ? healthR.reason.message : '获取服务健康状态失败')
        : healthR.value.message ?? '获取服务健康状态失败';
      if (!toast) setToast({ message: msg, type: 'error' });
    }
  };

  /* 自动刷新间隔来自后台系统设置，避免配置页保存后仪表盘仍固定 30 秒。 */
  useEffect(() => {
    load();
    const timer = setInterval(load, pollIntervalSec * 1000);
    return () => clearInterval(timer);
  }, [pollIntervalSec]);

  /* 首次加载中 */
  if (!stats) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="animate-spin h-8 w-8 text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-[1400px] mx-auto">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-800">系统总览</h2>
          <p className="text-xs text-gray-400 mt-0.5">每{pollIntervalSec}秒自动刷新</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {/* 统计卡片行 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {STAT_CARDS.map((card) => {
          const Icon = card.icon;
          const value = stats[card.key];
          const display = card.key === 'successRate24h'
            ? (value != null ? `${value}%` : '-')
            : String(value ?? '-');
          return (
            <div
              key={card.key}
              className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="flex items-center gap-3">
                <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${card.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] text-gray-400 font-medium truncate">{card.label}</div>
                  <div className="text-lg font-bold text-gray-800 tabular-nums">{display}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 风险提示 */}
      {stats.riskAlerts && stats.riskAlerts.length > 0 && (
        <div className="flex items-start gap-3 border border-amber-300 bg-amber-50 rounded-xl p-4">
          <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-amber-800">风险提示</div>
            <div className="text-xs text-amber-700 mt-0.5">
              {stats.riskAlerts.map((a) => a.message).join('；')}
            </div>
          </div>
        </div>
      )}

      {/* 中间两列：趋势图 + 服务健康 */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* 7天趋势 */}
        {trend.length > 0 && (
          <div className="lg:col-span-3 bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 text-sm font-semibold text-gray-700 border-b border-gray-100 flex items-center gap-2">
              <TrendingUp size={15} className="text-indigo-500" />
              7天生成趋势
            </div>
            <div className="p-4">
              <div className="flex gap-1 items-end h-[140px]">
                {trend.map((t, i) => {
                  const max = maxTrendValue(trend);
                  const successPct = Math.max(2, (t.success / max) * 100);
                  const failedPct = Math.max(2, (t.failed / max) * 100);
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
                      <div className="w-full flex flex-col justify-end gap-px" style={{ height: 110 }}>
                        <div
                          style={{ height: `${successPct}%` }}
                          className="bg-indigo-500 min-h-[2px] w-full rounded-t-sm"
                          title={`成功: ${t.success}`}
                        />
                        <div
                          style={{ height: `${failedPct}%` }}
                          className="bg-red-200 min-h-[2px] w-full"
                          title={`失败: ${t.failed}`}
                        />
                      </div>
                      <span className="text-[10px] text-gray-400 tabular-nums">
                        {t.timestamp?.slice(5, 10)}
                      </span>
                    </div>
                  );
                })}
              </div>
              {/* 图例 */}
              <div className="flex items-center justify-center gap-4 mt-3">
                <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
                  <span className="w-2.5 h-2.5 rounded-sm bg-indigo-500 inline-block" />
                  成功
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
                  <span className="w-2.5 h-2.5 rounded-sm bg-red-200 inline-block" />
                  失败
                </span>
              </div>
            </div>
          </div>
        )}

        {/* 服务健康 */}
        <div className={`bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden ${trend.length > 0 ? 'lg:col-span-2' : 'lg:col-span-5'}`}>
          <div className="px-4 py-3 text-sm font-semibold text-gray-700 border-b border-gray-100 flex items-center gap-2">
            <Server size={15} className="text-emerald-500" />
            服务健康
          </div>
          <div className="p-4">
            {svcHealth.length === 0 ? (
              <div className="text-xs text-gray-400 py-2">暂无服务数据</div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {svcHealth.map((s) => (
                  <li key={s.name} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          s.ok ? 'bg-emerald-400' : 'bg-red-400'
                        }`}
                      />
                      <span className="text-sm text-gray-700 capitalize truncate">
                        {s.name.replace(/-/g, ' ')}
                      </span>
                    </div>
                    <span
                      className={`text-xs font-medium flex-shrink-0 ml-2 ${
                        s.ok ? 'text-emerald-600' : 'text-red-600'
                      }`}
                    >
                      {s.ok ? formatUptime(s.uptimeSec) : '离线'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* 最近任务表格 */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 text-sm font-semibold text-gray-700 border-b border-gray-100 flex items-center gap-2">
          <Activity size={15} className="text-violet-500" />
          最近任务
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50 text-gray-500">
                <th className="text-left px-4 py-2.5 font-medium w-[110px]">ID</th>
                <th className="text-left px-4 py-2.5 font-medium w-[100px] hidden sm:table-cell">QQ</th>
                <th className="text-left px-4 py-2.5 font-medium w-[60px] hidden md:table-cell">来源</th>
                <th className="text-left px-4 py-2.5 font-medium w-[80px]">状态</th>
                <th className="text-left px-4 py-2.5 font-medium">提示词</th>
                <th className="text-left px-4 py-2.5 font-medium w-[150px] hidden lg:table-cell">时间</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-10 text-gray-400">
                    暂无近期任务
                  </td>
                </tr>
              ) : (
                recent.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-gray-400">
                      {r.id?.slice(0, 14) ?? '-'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 tabular-nums hidden sm:table-cell">
                      {r.qqNumber ?? '-'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 hidden md:table-cell">
                      {r.source === 'web' ? '网页' : r.source === 'bot' ? 'Bot' : (r.source ?? '-')}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-medium ${statusBadgeClasses(r.status ?? '')}`}
                      >
                        {statusLabel(r.status ?? '')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 truncate max-w-[240px]">
                      {r.prompt?.slice(0, 50) ?? '-'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 font-mono text-[11px] hidden lg:table-cell">
                      {r.createdAt?.slice(0, 19) ?? '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
