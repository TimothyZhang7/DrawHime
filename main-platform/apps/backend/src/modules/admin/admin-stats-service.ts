/**
 * 本文件实现管理后台仪表盘统计和趋势数据查询。
 *
 * 约束：
 * - 所有查询走索引，禁止全表扫描
 * - 趋势数据按桶（hour/day）聚合
 * - 风险指标从实时数据计算
 * - 符合 specs/README.md ADM-001 到 ADM-003
 */
import { Prisma } from '@prisma/client';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

/** 仪表盘统计数据。 */
type AdminStats = {
  totalUsers: number;
  verifiedUsers: number;
  boundQQCount: number;
  totalGenerations: number;
  successRate24h: string;
  avgLatency24hMs: number;
  enabledSites: number;
  disabledSites: number;
  riskAlerts: { type: string; message: string; count: number }[];
  totalSites: number;
  queuedTasks: number;
  runningTasks: number;
  failedTasks24h: number;
};

/** 趋势数据桶。 */
type TrendBucket = {
  timestamp: string;
  total: number;
  success: number;
  failed: number;
  running: number;
};

type TrendCountRow = {
  bucket: string;
  status: string;
  count: bigint | number;
};

/** 管理统计服务，只做只读查询，不写数据。 */
export class AdminStatsService {
  private readonly prisma = getPrismaClient();

  /** 获取仪表盘概览统计。 */
  async getStats(): Promise<AdminStats> {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      verifiedUsers,
      boundQQCount,
      totalGenerations,
      recentStatusRows,
      sites,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { emailVerified: true } }),
      this.prisma.qqBinding.count({ where: { verified: true } }),
      this.prisma.generationTask.count(),
      // 24h 成功率只需要按状态计数，避免把所有任务行拉进 Node 内存。
      this.prisma.generationTask.groupBy({
        by: ['status'],
        where: { createdAt: { gte: dayAgo } },
        _count: { _all: true },
      }),
      this.prisma.apiSite.findMany({
        select: { isEnabled: true, consecutiveFailures: true, autoDisabledUntil: true },
      }),
    ]);

    // 计算 24h 成功率
    const total24h = recentStatusRows.reduce((sum, row) => sum + row._count._all, 0);
    const success24h = recentStatusRows.find((row) => row.status === 'success')?._count._all ?? 0;
    const successRate = total24h > 0 ? ((success24h / total24h) * 100).toFixed(1) + '%' : 'N/A';

    // 站点统计
    const enabledSites = sites.filter((s) => s.isEnabled).length;
    const disabledSites = sites.filter((s) => !s.isEnabled).length;

    // 风险指标
    const riskAlerts: AdminStats['riskAlerts'] = [];
    const unverifiedCount = totalUsers - verifiedUsers;
    if (unverifiedCount > 0) {
      riskAlerts.push({ type: 'unverified_users', message: `${unverifiedCount} 个用户未验证邮箱`, count: unverifiedCount });
    }
    const autoDisabled = sites.filter((s) => s.autoDisabledUntil && new Date(s.autoDisabledUntil) > now);
    if (autoDisabled.length > 0) {
      riskAlerts.push({ type: 'site_disabled', message: `${autoDisabled.length} 个站点被自动禁用`, count: autoDisabled.length });
    }
    // 高故障站点告警（连续失败 >= 3 但尚未自动禁用）
    const highFailureSites = sites.filter((s) => (s.consecutiveFailures ?? 0) >= 3 && !autoDisabled.includes(s));
    if (highFailureSites.length > 0) {
      riskAlerts.push({ type: 'high_failure', message: `${highFailureSites.length} 个站点连续失败 ≥3 次`, count: highFailureSites.length });
    }

    // 任务队列统计
    const dayAgo2 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [queuedTasks, runningTasks, failedTasks24h] = await Promise.all([
      this.prisma.generationTask.count({ where: { status: 'queued' } }),
      this.prisma.generationTask.count({ where: { status: { in: ['running', 'finalizing'] } } }),
      this.prisma.generationTask.count({ where: { status: 'failed', createdAt: { gte: dayAgo2 } } }),
    ]);

    return {
      totalUsers, verifiedUsers, boundQQCount, totalGenerations,
      successRate24h: successRate, avgLatency24hMs: 0,
      enabledSites, disabledSites, totalSites: enabledSites + disabledSites,
      riskAlerts, queuedTasks, runningTasks, failedTasks24h,
    };
  }

  /** 获取趋势数据，支持 6h/24h/7d 时间范围。 */
  async getTrends(days: number = 7): Promise<{ buckets: TrendBucket[]; interval: 'hour' | 'day' }> {
    const interval = days <= 1 ? 'hour' : 'day';
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const bucketExpr = interval === 'hour'
      ? Prisma.sql`DATE_FORMAT(created_at, '%Y-%m-%dT%H:00:00.000+08:00')`
      : Prisma.sql`DATE_FORMAT(created_at, '%Y-%m-%dT00:00:00.000+08:00')`;
    const rows = await this.prisma.$queryRaw<TrendCountRow[]>(Prisma.sql`
      SELECT ${bucketExpr} AS bucket, status, COUNT(*) AS count
      FROM generation_tasks
      WHERE created_at >= ${since}
      GROUP BY bucket, status
      ORDER BY bucket ASC
    `);

    // 按时间桶聚合
    const bucketMap = new Map<string, { total: number; success: number; failed: number; running: number }>();

    for (const row of rows) {
      const key = row.bucket;
      const count = Number(row.count);
      const bucket = bucketMap.get(key) ?? { total: 0, success: 0, failed: 0, running: 0 };
      bucket.total += count;
      if (row.status === 'success') bucket.success += count;
      if (row.status === 'failed') bucket.failed += count;
      if (row.status === 'running' || row.status === 'finalizing') bucket.running += count;
      bucketMap.set(key, bucket);
    }

    const buckets: TrendBucket[] = Array.from(bucketMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([timestamp, data]) => ({ timestamp, ...data }));

    return { buckets, interval };
  }
}
