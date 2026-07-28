/**
 * 管理端充值总览：发行/兑换汇总、14天趋势、付费用户数、兑换流水、批次统计。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

const prisma = getPrismaClient();

export function createRechargeOverviewRoutes(): Route[] {
  return [
    { method: 'GET', path: '/admin/recharge/overview', handle: overview },
  ];
}

async function overview(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });

  const day14Ago = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [totalIssued, totalRedeemed, totalUnused, redeemedUsers, recentRedeems, batches] = await Promise.all([
    // 累计发行总额
    prisma.rechargeCard.aggregate({ _sum: { amount: true } }),
    // 累计兑换总额
    prisma.rechargeCard.aggregate({ where: { status: 'used' }, _sum: { amount: true } }),
    // 未使用卡密总额
    prisma.rechargeCard.aggregate({ where: { status: 'unused' }, _sum: { amount: true } }),
    // 付费用户数（有兑换记录的去重用户）
    prisma.rechargeCard.groupBy({ by: ['redeemedById'], where: { status: 'used', redeemedById: { not: null } }, _count: true }),
    // 最近 20 条兑换记录
    prisma.rechargeCard.findMany({ where: { status: 'used' }, orderBy: { redeemedAt: 'desc' }, take: 20,
      select: { id:true, amount:true, redeemedQq:true, redeemedById:true, redeemedWalletId:true, redeemedAt:true, batchId:true,
        redeemedBy: { select: { username: true, email: true } } } }),
    // 全部批次
    prisma.rechargeBatch.findMany({ orderBy: { createdAt: 'desc' },
      select: { id:true, amount:true, count:true, fileName:true, createdAt:true,
        cards: { where: { status: 'used' }, select: { id:true } } } }),
  ]);

  // 14天趋势（按日期聚合）
  const trendMap = new Map<string, { issued: number; redeemed: number }>();
  const allCards14d = await prisma.rechargeCard.findMany({
    where: { createdAt: { gte: day14Ago } },
    select: { amount: true, status: true, createdAt: true },
  });
  for (const card of allCards14d) {
    const date = card.createdAt.toISOString().slice(0, 10);
    const entry = trendMap.get(date) ?? { issued: 0, redeemed: 0 };
    const amt = Number(card.amount);
    entry.issued += amt;
    if (card.status === 'used') entry.redeemed += amt;
    trendMap.set(date, entry);
  }
  const trend = Array.from(trendMap.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([date, data]) => ({
    date, issued: data.issued.toFixed(2), redeemed: data.redeemed.toFixed(2),
  }));

  return sendJson(res, 200, { ok: true, data: {
    totalIssued: (totalIssued._sum.amount?.toNumber() ?? 0).toFixed(2),
    totalRedeemed: (totalRedeemed._sum.amount?.toNumber() ?? 0).toFixed(2),
    totalUnused: (totalUnused._sum.amount?.toNumber() ?? 0).toFixed(2),
    redeemedUserCount: redeemedUsers.length,
    recentRedeems: recentRedeems.map((r) => ({
      id: r.id, amount: r.amount.toFixed(2), qqNumber: r.redeemedQq?.toString(),
      // QQ 兑换一定带 redeemedQq；网页兑换只带 redeemedById/user 钱包，后台据此区分入口。
      redeemSource: r.redeemedQq ? 'qq' : 'web',
      redeemedById: r.redeemedById,
      redeemedWalletId: r.redeemedWalletId,
      redeemerLabel: r.redeemedQq ? `QQ ${r.redeemedQq.toString()}` : (r.redeemedBy?.username ?? r.redeemedBy?.email ?? (r.redeemedById ? `用户 ${r.redeemedById}` : '-')),
      redeemedAt: r.redeemedAt ? formatChinaDateTime(r.redeemedAt) : null, batchId: r.batchId,
    })),
    trend,
    batchStats: batches.map((b) => ({
      id: b.id, amount: b.amount.toFixed(2), count: b.count, usedCount: b.cards.length,
      fileName: b.fileName, createdAt: formatChinaDateTime(b.createdAt),
    })),
  }});
}

function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { const p = verifyAccessToken(token); return p.role === 'admin' ? p : undefined; } catch { return undefined; }
}
function formatChinaDateTime(d: Date): string {
  return new Date(d.getTime() + 8*60*60*1000).toISOString().replace('Z','+08:00');
}
