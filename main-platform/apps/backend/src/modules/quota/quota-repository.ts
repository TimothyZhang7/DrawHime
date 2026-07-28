/**
 * 余额仓储 — 免费余额 + 付费余额，优先消耗免费余额。
 */
import type { PrismaClient } from '@prisma/client';

export type DeductBalanceInput = { qqNumber: bigint; amount: number; };
export type DeductBalanceResult = {
  chargedSource: 'free' | 'paid' | 'mixed';
  freeUsed: string;
  paidUsed: string;
  freeBalance: string;
  paidBalance: string;
};
export type RefundBalanceInput = { qqNumber: bigint; freeAmount: number; paidAmount: number; };

export class QuotaRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** 扣费：优先免费余额 → 付费余额（精度：2位小数） */
  async deductBalance(input: DeductBalanceInput): Promise<DeductBalanceResult | null> {
    const price = Math.round(Math.max(0, input.amount) * 100) / 100;
    return this.prisma.$transaction(async (tx) => {
      const quota = await tx.qqQuota.findUnique({
        where: { qqNumber: input.qqNumber },
        select: { paidBalance: true, freeBalance: true },
      });
      const free = Math.round(Math.max(0, quota?.freeBalance.toNumber() ?? 0) * 100) / 100;
      const paid = Math.round(Math.max(0, quota?.paidBalance.toNumber() ?? 0) * 100) / 100;
      const total = Math.round((free + paid) * 100) / 100;
      if (total < price) return null;

      let freeUse = 0, paidUse = 0;
      if (free >= price) { freeUse = price; }
      else { freeUse = free; paidUse = Math.round((price - free) * 100) / 100; }

      const updated = await tx.qqQuota.upsert({
        where: { qqNumber: input.qqNumber },
        update: { freeBalance: { decrement: freeUse }, paidBalance: { decrement: paidUse } },
        create: { qqNumber: input.qqNumber, freeBalance: -freeUse, paidBalance: -paidUse },
        select: { freeBalance: true, paidBalance: true },
      });
      return {
        chargedSource: freeUse > 0 && paidUse > 0 ? 'mixed' : freeUse > 0 ? 'free' : 'paid',
        freeUsed: freeUse.toFixed(2),
        paidUsed: paidUse.toFixed(2),
        freeBalance: (Math.round(Math.max(0, updated.freeBalance.toNumber()) * 100) / 100).toFixed(2),
        paidBalance: (Math.round(Math.max(0, updated.paidBalance.toNumber()) * 100) / 100).toFixed(2),
      };
    }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 10000 });
  }

  /** 退款：按来源退回免费/付费余额（精度：2位小数） */
  async refundBalance(input: RefundBalanceInput): Promise<void> {
    const { qqNumber, freeAmount, paidAmount } = input;
    const f = Math.round(Math.max(0, freeAmount) * 100) / 100;
    const p = Math.round(Math.max(0, paidAmount) * 100) / 100;
    if (f + p <= 0) return;
    await this.prisma.qqQuota.upsert({
      where: { qqNumber },
      update: { freeBalance: { increment: f }, paidBalance: { increment: p } },
      create: { qqNumber, freeBalance: f, paidBalance: p },
    });
  }

  async getBalances(qqNumber: bigint) {
    const q = await this.prisma.qqQuota.findUnique({
      where: { qqNumber }, select: { freeBalance: true, paidBalance: true },
    });
    const free = Math.round(Math.max(0, q?.freeBalance.toNumber() ?? 0) * 100) / 100;
    const paid = Math.round(Math.max(0, q?.paidBalance.toNumber() ?? 0) * 100) / 100;
    return { freeBalance: free.toFixed(2), paidBalance: paid.toFixed(2) };
  }

  async getPaidBalance(qqNumber: bigint): Promise<string> {
    const q = await this.prisma.qqQuota.findUnique({ where: { qqNumber }, select: { paidBalance: true } });
    return (Math.round(Math.max(0, q?.paidBalance.toNumber() ?? 0) * 100) / 100).toFixed(2);
  }

  async getFreeBalance(qqNumber: bigint): Promise<string> {
    const q = await this.prisma.qqQuota.findUnique({ where: { qqNumber }, select: { freeBalance: true } });
    return (Math.round(Math.max(0, q?.freeBalance.toNumber() ?? 0) * 100) / 100).toFixed(2);
  }

  /** 确保指定 QQ 存在余额行；首次触达余额系统时初始化当天免费额度，已存在时不重置余额。 */
  async ensureBalanceRow(qqNumber: bigint, initialFreeBalance = 0): Promise<void> {
    await this.prisma.qqQuota.upsert({
      where: { qqNumber },
      update: {},
      create: { qqNumber, freeBalance: Math.max(0, initialFreeBalance) },
    });
  }

  /** 重置单个 QQ 的免费余额为配置值 */
  async resetFreeBalance(qqNumber: bigint, dailyAmount: number): Promise<string> {
    const amt = Math.max(0, dailyAmount);
    await this.prisma.qqQuota.upsert({
      where: { qqNumber },
      update: { freeBalance: amt },
      create: { qqNumber, freeBalance: amt },
    });
    return amt.toFixed(2);
  }

  /** 查询所有已知用户 QQ：余额表、历史任务、网页绑定、充值兑换都按 QQ 归并。 */
  async listKnownUserQqNumbers(): Promise<bigint[]> {
    const [quotas, tasks, bindings, redeems, modelPrefs, privacyPrefs] = await Promise.all([
      this.prisma.qqQuota.findMany({ select: { qqNumber: true } }),
      this.prisma.generationTask.findMany({ distinct: ['qqNumber'], select: { qqNumber: true } }),
      this.prisma.qqBinding.findMany({ where: { qqNumber: { not: null } }, select: { qqNumber: true } }),
      this.prisma.rechargeCard.findMany({
        where: { redeemedQq: { not: null } },
        distinct: ['redeemedQq'],
        select: { redeemedQq: true },
      }),
      this.prisma.userModelPref.findMany({ where: { qqNumber: { not: null } }, select: { qqNumber: true } }),
      this.prisma.qqImagePrivacyPref.findMany({ select: { qqNumber: true } }),
    ]);
    const seen = new Map<string, bigint>();
    const add = (value: bigint | null | undefined) => {
      if (!value || value <= 0n) return;
      seen.set(value.toString(), value);
    };
    for (const row of quotas) add(row.qqNumber);
    for (const row of tasks) add(row.qqNumber);
    for (const row of bindings) add(row.qqNumber);
    for (const row of redeems) add(row.redeemedQq);
    for (const row of modelPrefs) add(row.qqNumber);
    for (const row of privacyPrefs) add(row.qqNumber);
    return [...seen.values()];
  }

  /** 补齐所有已知 QQ 的余额行；免费余额默认给 0，避免后台列表漏掉未绑定网页但有任务历史的 QQ。 */
  async ensureKnownUserQuotaRows(defaultFreeBalance = 0): Promise<number> {
    const qqNumbers = await this.listKnownUserQqNumbers();
    if (qqNumbers.length === 0) return 0;
    const existing = await this.prisma.qqQuota.findMany({
      where: { qqNumber: { in: qqNumbers } },
      select: { qqNumber: true },
    });
    const existingSet = new Set(existing.map((item) => item.qqNumber.toString()));
    const missing = qqNumbers.filter((qqNumber) => !existingSet.has(qqNumber.toString()));
    if (missing.length === 0) return 0;
    const result = await this.prisma.qqQuota.createMany({
      data: missing.map((qqNumber) => ({ qqNumber, freeBalance: Math.max(0, defaultFreeBalance) })),
      skipDuplicates: true,
    });
    return result.count;
  }

  /** 每日零点：按 QQ 维度重置所有已知用户的免费余额，不能只覆盖已绑定网页的用户。 */
  async resetAllFreeBalances(dailyAmount: number): Promise<number> {
    const amt = Math.max(0, dailyAmount);
    const qqNumbers = await this.listKnownUserQqNumbers();
    if (qqNumbers.length === 0) return 0;
    await this.ensureKnownUserQuotaRows(amt);
    const result = await this.prisma.qqQuota.updateMany({
      where: { qqNumber: { in: qqNumbers } },
      data: { freeBalance: amt },
    });
    return result.count;
  }
}
