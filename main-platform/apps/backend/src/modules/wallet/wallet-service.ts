/** 本文件实现 Web/QQ 独立钱包、绑定共享、扣费分账、幂等退款和充值入账。 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { LocalPlatformBillingReservationView, WalletBalanceKind, WalletBalanceView, WalletLedgerEntryView, WalletLedgerListQuery, WalletLedgerListResponse, WalletLedgerSource, WalletLedgerType, WalletStatusResponse } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { WalletError, type WalletChargeInput, type WalletChargeResult } from './wallet-types.js';

/** Prisma 事务客户端类型；所有余额最终写入都必须在事务内完成。 */
type TxClient = Prisma.TransactionClient;

/** 钱包记录的最小字段集合，用于扣费和响应转换。 */
type WalletRecord = {
  id: number;
  ownerType: string;
  ownerKey: string;
  userId: number | null;
  freeBalance: Prisma.Decimal;
  paidBalance: Prisma.Decimal;
};

/** 钱包服务负责余额权威写入；外部模块不能直接改 wallets 余额。 */
export class WalletService {
  private readonly prisma = getPrismaClient();

  /** 查询 Web 用户可访问余额；未绑定 QQ 也会创建并返回 user 钱包。 */
  async getWebStatus(userId: number): Promise<WalletStatusResponse> {
    return this.prisma.$transaction(async (tx) => {
      const wallets = await this.getAccessibleWalletsForUserTx(tx, userId);
      const primary = wallets[0];
      const linked = wallets.find((wallet) => wallet.ownerType === 'qq');
      return buildWalletStatus(primary, linked);
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 查询当前 Web 用户可访问钱包流水；只读接口必须先解析可访问钱包，避免泄露其他身份记录。 */
  async listWebLedger(userId: number, input: WalletLedgerListQuery): Promise<WalletLedgerListResponse> {
    const page = Number.isSafeInteger(input.page) && Number(input.page) > 0 ? Number(input.page) : 1;
    const pageSize = Math.min(100, Math.max(1, Number.isSafeInteger(input.pageSize) ? Number(input.pageSize) : 30));
    return this.prisma.$transaction(async (tx) => {
      const wallets = await this.getAccessibleWalletsForUserTx(tx, userId);
      const walletIds = wallets.map((wallet) => wallet.id);
      if (walletIds.length === 0) return { items: [], total: 0, page, pageSize, totalPages: 1 };
      const walletMap = new Map(wallets.map((wallet) => [wallet.id, wallet]));
      const where = buildLedgerWhere(walletIds, input);
      const [items, total] = await Promise.all([
        tx.walletLedger.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            walletId: true,
            type: true,
            amount: true,
            balanceKind: true,
            source: true,
            taskId: true,
            rechargeCardId: true,
            createdAt: true,
          },
        }),
        tx.walletLedger.count({ where }),
      ]);
      const balanceAfterMap = await buildLedgerBalanceAfterMap(tx, walletIds, items);
      return {
        items: items.map((item) => toWalletLedgerEntryView(item, walletMap.get(item.walletId), balanceAfterMap.get(item.id))),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      };
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 查询 QQ 入口可访问余额；绑定 Web 后返回 QQ 钱包 + user 钱包的合计。 */
  async getQqBalanceSummary(qqNumber: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const wallets = await this.getAccessibleWalletsForQqTx(tx, qqNumber);
      const primary = wallets[0];
      const linked = wallets.find((wallet) => wallet.ownerType === 'user');
      const total = sumWalletBalances(wallets);
      return {
        qqNumber: qqNumber.toString(),
        freeBalance: total.freeBalance,
        paidBalance: total.paidBalance,
        totalBalance: total.totalBalance,
        // Bot 余额卡片必须展示独立钱包来源；绑定只提供访问权，不把 QQ 和 Web 余额物理合并。
        primaryWallet: toWalletBalanceView(primary),
        linkedWallet: linked ? toWalletBalanceView(linked) : undefined,
      };
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 在事务内为生成任务扣费；先免费余额，再付费余额，并写入分账记录。 */
  async chargeForGenerationTx(tx: TxClient, input: WalletChargeInput): Promise<WalletChargeResult> {
    const price = toMoney(input.amount);
    if (price <= 0) {
      return { chargedSource: 'free', chargedAmount: '0.00', freeUsed: '0.00', paidUsed: '0.00', freeBalance: '0.00', paidBalance: '0.00' };
    }

    const wallets = input.actor === 'web'
      ? await this.getAccessibleWalletsForUserTx(tx, requiredNumber(input.userId, '缺少 Web 用户 ID'))
      : await this.getAccessibleWalletsForQqTx(tx, requiredBigInt(input.qqNumber, '缺少 QQ 号'));

    await lockWallets(tx, wallets.map((wallet) => wallet.id));
    const lockedWallets = await tx.wallet.findMany({
      where: { id: { in: wallets.map((wallet) => wallet.id) } },
      select: walletSelect,
    });
    const lockedMap = new Map(lockedWallets.map((wallet) => [wallet.id, wallet]));
    const ordered = wallets.map((wallet) => lockedMap.get(wallet.id)).filter((wallet): wallet is WalletRecord => Boolean(wallet));
    const beforeTotal = sumWalletNumbers(ordered);
    if (beforeTotal.free + beforeTotal.paid < price) {
      throw new WalletError('insufficient_balance',
        `余额不足：需要 ${price.toFixed(2)} 元，免费 ${beforeTotal.free.toFixed(2)} + 付费 ${beforeTotal.paid.toFixed(2)}`,
        { freeBalance: beforeTotal.free.toFixed(2), paidBalance: beforeTotal.paid.toFixed(2) });
    }

    const allocations = new Map<number, { wallet: WalletRecord; free: number; paid: number }>();
    let remaining = price;
    for (const wallet of ordered) {
      if (remaining <= 0) break;
      const freeUse = Math.min(toMoney(wallet.freeBalance), remaining);
      if (freeUse <= 0) continue;
      const item = allocations.get(wallet.id) ?? { wallet, free: 0, paid: 0 };
      item.free = toMoney(item.free + freeUse);
      allocations.set(wallet.id, item);
      remaining = toMoney(remaining - freeUse);
    }
    for (const wallet of ordered) {
      if (remaining <= 0) break;
      const paidUse = Math.min(toMoney(wallet.paidBalance), remaining);
      if (paidUse <= 0) continue;
      const item = allocations.get(wallet.id) ?? { wallet, free: 0, paid: 0 };
      item.paid = toMoney(item.paid + paidUse);
      allocations.set(wallet.id, item);
      remaining = toMoney(remaining - paidUse);
    }

    let totalFree = 0;
    let totalPaid = 0;
    for (const item of allocations.values()) {
      totalFree = toMoney(totalFree + item.free);
      totalPaid = toMoney(totalPaid + item.paid);
      await tx.wallet.update({
        where: { id: item.wallet.id },
        data: {
          freeBalance: { decrement: item.free },
          paidBalance: { decrement: item.paid },
        },
      });
      await mirrorQqWalletDelta(tx, item.wallet, -item.free, -item.paid);
      await tx.taskChargeAllocation.create({
        data: {
          taskId: input.taskId,
          walletId: item.wallet.id,
          freeAmount: item.free,
          paidAmount: item.paid,
        },
      });
      await createLedgerRows(tx, item.wallet.id, 'charge', input.source, input.taskId, undefined, -item.free, -item.paid);
    }

    const afterWallets = await tx.wallet.findMany({
      where: { id: { in: ordered.map((wallet) => wallet.id) } },
      select: walletSelect,
    });
    const afterTotal = sumWalletNumbers(afterWallets);
    return {
      chargedSource: totalFree > 0 && totalPaid > 0 ? 'mixed' : totalFree > 0 ? 'free' : 'paid',
      chargedAmount: toMoney(totalFree + totalPaid).toFixed(2),
      freeUsed: totalFree.toFixed(2),
      paidUsed: totalPaid.toFixed(2),
      freeBalance: afterTotal.free.toFixed(2),
      paidBalance: afterTotal.paid.toFixed(2),
    };
  }

  /** 为独立本地模型任务预留资金；主站事务内按当前可访问钱包顺序扣款并固化退款分账。 */
  async reserveForLocalPlatformTx(tx: TxClient, input: {
    walletOwnerType: 'user' | 'qq';
    userId?: number;
    qqNumber?: bigint;
    externalTaskId: string;
    idempotencyKey: string;
    priceVersionId: number;
    quantity: number;
    amount: number;
    currency: 'CNY';
  }): Promise<LocalPlatformBillingReservationView> {
    const existing = await tx.localPlatformBillingReservation.findFirst({
      where: { OR: [{ externalTaskId: input.externalTaskId }, { idempotencyKey: input.idempotencyKey }] },
      include: localPlatformReservationInclude,
    });
    if (existing) {
      const sameRequest = existing.externalTaskId === input.externalTaskId
        && existing.idempotencyKey === input.idempotencyKey
        && existing.userId === (input.userId ?? null)
        && existing.qqNumber === (input.qqNumber ?? null)
        && existing.priceVersionId === input.priceVersionId
        && toQuantity(existing.quantity) === toQuantity(input.quantity);
      if (!sameRequest) throw new WalletError('conflict', '本地模型计费幂等键已被其他请求使用');
      return toLocalPlatformReservationView(existing);
    }

    const amount = toMoney(input.amount);
    if (amount <= 0) throw new WalletError('invalid_request', '本地模型价格必须大于 0');
    // Bot 任务从 QQ 钱包视角读取“QQ 自己 + 已绑定网页钱包”，网页任务保持原有用户钱包视角。
    const wallets = input.walletOwnerType === 'qq'
      ? await this.getAccessibleWalletsForQqTx(tx, requiredBigInt(input.qqNumber, '缺少 QQ 号'))
      : await this.getAccessibleWalletsForUserTx(tx, requiredNumber(input.userId, '缺少用户 ID'));
    await lockWallets(tx, wallets.map((wallet) => wallet.id));
    const lockedWallets = await tx.wallet.findMany({
      where: { id: { in: wallets.map((wallet) => wallet.id) } },
      select: walletSelect,
    });
    const lockedMap = new Map(lockedWallets.map((wallet) => [wallet.id, wallet]));
    const ordered = wallets.map((wallet) => lockedMap.get(wallet.id)).filter((wallet): wallet is WalletRecord => Boolean(wallet));
    const before = sumWalletNumbers(ordered);
    if (before.free + before.paid < amount) {
      throw new WalletError('insufficient_balance', `余额不足：需要 ${amount.toFixed(2)} 元`, {
        freeBalance: before.free.toFixed(2),
        paidBalance: before.paid.toFixed(2),
      });
    }

    const reservation = await tx.localPlatformBillingReservation.create({
      data: {
        externalTaskId: input.externalTaskId,
        idempotencyKey: input.idempotencyKey,
        userId: input.userId ?? null,
        qqNumber: input.qqNumber ?? null,
        priceVersionId: input.priceVersionId,
        quantity: input.quantity,
        reservedAmount: amount,
        currency: input.currency,
        status: 'reserved',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });

    const allocations = new Map<number, { wallet: WalletRecord; free: number; paid: number }>();
    let remaining = amount;
    for (const wallet of ordered) {
      const free = Math.min(toMoney(wallet.freeBalance), remaining);
      if (free > 0) allocations.set(wallet.id, { wallet, free, paid: 0 });
      remaining = toMoney(remaining - free);
      if (remaining <= 0) break;
    }
    for (const wallet of ordered) {
      if (remaining <= 0) break;
      const paid = Math.min(toMoney(wallet.paidBalance), remaining);
      if (paid <= 0) continue;
      const allocation = allocations.get(wallet.id) ?? { wallet, free: 0, paid: 0 };
      allocation.paid = paid;
      allocations.set(wallet.id, allocation);
      remaining = toMoney(remaining - paid);
    }

    for (const allocation of allocations.values()) {
      await tx.wallet.update({
        where: { id: allocation.wallet.id },
        data: {
          freeBalance: { decrement: allocation.free },
          paidBalance: { decrement: allocation.paid },
        },
      });
      await mirrorQqWalletDelta(tx, allocation.wallet, -allocation.free, -allocation.paid);
      await tx.localPlatformBillingAllocation.create({
        data: {
          reservationId: reservation.id,
          walletId: allocation.wallet.id,
          freeAmount: allocation.free,
          paidAmount: allocation.paid,
        },
      });
      await createLedgerRows(tx, allocation.wallet.id, 'charge', input.walletOwnerType === 'qq' ? 'bot' : 'web', input.externalTaskId, undefined, -allocation.free, -allocation.paid, {
        kind: 'local_platform_reservation',
        reservationId: reservation.id,
      });
    }
    return toLocalPlatformReservationView(await tx.localPlatformBillingReservation.findUniqueOrThrow({
      where: { id: reservation.id },
      include: localPlatformReservationInclude,
    }));
  }

  /** 提交独立平台预留；资金已经扣除，本操作只幂等写入最终计费状态。 */
  async commitLocalPlatformReservationTx(tx: TxClient, reservationId: string, idempotencyKey: string): Promise<LocalPlatformBillingReservationView> {
    await lockLocalPlatformReservation(tx, reservationId);
    const reservation = await tx.localPlatformBillingReservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: localPlatformReservationInclude,
    });
    if (reservation.status === 'released') throw new WalletError('conflict', '已释放的预留不能提交');
    if (reservation.status === 'committed') {
      if (reservation.commitIdempotencyKey !== idempotencyKey) throw new WalletError('conflict', '提交幂等键与已完成请求不一致');
      return toLocalPlatformReservationView(reservation);
    }
    const updated = await tx.localPlatformBillingReservation.update({
      where: { id: reservationId },
      data: { status: 'committed', committedAt: new Date(), commitIdempotencyKey: idempotencyKey },
      include: localPlatformReservationInclude,
    });
    return toLocalPlatformReservationView(updated);
  }

  /** 释放独立平台预留；严格按固化分账退回原钱包并写退款流水。 */
  async releaseLocalPlatformReservationTx(tx: TxClient, reservationId: string, idempotencyKey: string, reason?: string): Promise<LocalPlatformBillingReservationView> {
    await lockLocalPlatformReservation(tx, reservationId);
    const reservation = await tx.localPlatformBillingReservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: localPlatformReservationInclude,
    });
    if (reservation.status === 'committed') throw new WalletError('conflict', '已提交的预留不能释放');
    if (reservation.status === 'released') {
      if (reservation.releaseIdempotencyKey !== idempotencyKey) throw new WalletError('conflict', '释放幂等键与已完成请求不一致');
      return toLocalPlatformReservationView(reservation);
    }
    await lockWallets(tx, reservation.allocations.map((allocation) => allocation.walletId));
    const now = new Date();
    for (const allocation of reservation.allocations) {
      const free = toMoney(allocation.freeAmount);
      const paid = toMoney(allocation.paidAmount);
      await tx.wallet.update({
        where: { id: allocation.walletId },
        data: { freeBalance: { increment: free }, paidBalance: { increment: paid } },
      });
      await mirrorQqWalletDelta(tx, allocation.wallet, free, paid);
      await createLedgerRows(tx, allocation.walletId, 'refund', 'system', reservation.externalTaskId, undefined, free, paid, {
        kind: 'local_platform_release',
        reservationId,
        reason: reason?.slice(0, 500) || '任务未完成',
      });
      await tx.localPlatformBillingAllocation.update({ where: { id: allocation.id }, data: { releasedAt: now } });
    }
    const updated = await tx.localPlatformBillingReservation.update({
      where: { id: reservationId },
      data: {
        status: 'released',
        releasedAt: now,
        releaseReason: reason?.slice(0, 500) || '任务未完成',
        releaseIdempotencyKey: idempotencyKey,
      },
      include: localPlatformReservationInclude,
    });
    return toLocalPlatformReservationView(updated);
  }

  /** 按任务分账记录幂等退款；返回是否找到可退款的新钱包分账。 */
  async refundTaskByAllocationsTx(tx: TxClient, taskId: string): Promise<boolean> {
    const allocations = await tx.taskChargeAllocation.findMany({
      where: { taskId, refundedAt: null },
      select: { id: true, walletId: true, freeAmount: true, paidAmount: true, wallet: { select: walletSelect } },
    });
    if (allocations.length === 0) return false;
    const now = new Date();
    await lockWallets(tx, allocations.map((item) => item.walletId));
    for (const item of allocations) {
      const free = toMoney(item.freeAmount);
      const paid = toMoney(item.paidAmount);
      if (free > 0 || paid > 0) {
        await tx.wallet.update({
          where: { id: item.walletId },
          data: { freeBalance: { increment: free }, paidBalance: { increment: paid } },
        });
        await mirrorQqWalletDelta(tx, item.wallet, free, paid);
        await createLedgerRows(tx, item.walletId, 'refund', 'system', taskId, undefined, free, paid);
      }
      await tx.taskChargeAllocation.update({ where: { id: item.id }, data: { refundedAt: now } });
    }
    return true;
  }

  /** 在事务内给 Web 用户钱包增加付费余额，用于网页卡密兑换。 */
  async addPaidBalanceToUserTx(tx: TxClient, userId: number, amount: number, rechargeCardId?: number) {
    const wallet = await this.ensureUserWalletTx(tx, userId);
    const paid = toMoney(amount);
    await tx.wallet.update({ where: { id: wallet.id }, data: { paidBalance: { increment: paid } } });
    await createLedgerRows(tx, wallet.id, 'recharge', 'web', undefined, rechargeCardId, 0, paid);
    const updated = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: walletSelect });
    return updated;
  }

  /** 在事务内给 Web 用户钱包增加邀请奖励付费余额；调用方必须先完成邀请关系幂等校验。 */
  async addReferralRewardToUserTx(tx: TxClient, userId: number, amount: number, metadata: Prisma.InputJsonObject) {
    const paid = toMoney(amount);
    const wallet = await this.ensureUserWalletTx(tx, userId);
    if (paid <= 0) return tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: walletSelect });
    await lockWallets(tx, [wallet.id]);
    await tx.wallet.update({ where: { id: wallet.id }, data: { paidBalance: { increment: paid } } });
    await createLedgerRows(tx, wallet.id, 'referral_reward', 'system', undefined, undefined, 0, paid, metadata);
    return tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: walletSelect });
  }

  /** 在事务内给 QQ 钱包增加付费余额，用于 Bot 卡密兑换和管理员调整。 */
  async addPaidBalanceToQqTx(tx: TxClient, qqNumber: bigint, amount: number, rechargeCardId?: number) {
    const wallet = await this.ensureQqWalletTx(tx, qqNumber);
    const paid = toMoney(amount);
    await tx.wallet.update({ where: { id: wallet.id }, data: { paidBalance: { increment: paid } } });
    await mirrorQqWalletDelta(tx, wallet, 0, paid);
    await createLedgerRows(tx, wallet.id, 'recharge', 'bot', undefined, rechargeCardId, 0, paid);
    const updated = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: walletSelect });
    return updated;
  }

  /** 绑定 Web 和 QQ 钱包；只建立共享关系，不合并余额。 */
  async linkUserAndQq(userId: number, qqNumber: bigint, ip?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.linkUserAndQqTx(tx, userId, qqNumber, ip);
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 在既有事务内建立 Web/QQ 钱包共享关系；调用方负责同事务更新 QQ 绑定表。 */
  async linkUserAndQqTx(tx: TxClient, userId: number, qqNumber: bigint, ip?: string): Promise<void> {
    await this.ensureUserWalletTx(tx, userId);
    await this.ensureQqWalletTx(tx, qqNumber);
    await tx.walletLink.updateMany({
      where: { OR: [{ activeUserKey: String(userId) }, { activeQqKey: qqNumber.toString() }] },
      data: { status: 'unbound', activeUserKey: null, activeQqKey: null, unboundAt: new Date(), unboundByIp: ip },
    });
    await tx.walletLink.create({
      data: {
        userId,
        qqNumber,
        status: 'active',
        activeUserKey: String(userId),
        activeQqKey: qqNumber.toString(),
        createdByIp: ip,
      },
    });
  }

  /** 解绑 Web 和 QQ 钱包；只关闭共享关系，不移动余额。 */
  async unlinkUser(userId: number, ip?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.unlinkUserTx(tx, userId, ip);
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 管理员重置指定 QQ 钱包免费余额；金额按双端规则使用每日总额的一半。 */
  async resetQqFreeBalance(qqNumber: bigint, dailyTotalAmount: number): Promise<string> {
    const amount = toMoney(Math.max(0, dailyTotalAmount) / 2);
    await this.prisma.$transaction(async (tx) => {
      const wallet = await this.ensureQqWalletTx(tx, qqNumber);
      await lockWallets(tx, [wallet.id]);
      const current = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: walletSelect });
      const freeDelta = toMoney(amount - toMoney(current.freeBalance));
      await tx.wallet.update({ where: { id: wallet.id }, data: { freeBalance: amount } });
      await tx.qqQuota.upsert({
        where: { qqNumber },
        update: { freeBalance: amount },
        create: { qqNumber, freeBalance: amount },
      });
      // 管理员免费余额重置属于受控调账，按差额写流水便于后续审计和恢复。
      await createLedgerRows(tx, wallet.id, 'admin_adjust', 'admin', undefined, undefined, freeDelta, 0);
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
    return amount.toFixed(2);
  }

  /** 管理员调整 QQ 付费余额；正数增加，负数扣除，旧 qq_quotas 同步镜像。 */
  async adjustQqPaidBalance(qqNumber: bigint, amount: number): Promise<string> {
    const delta = toMoney(amount);
    if (delta === 0) throw new WalletError('invalid_request', '调整金额不能为 0');
    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.ensureQqWalletTx(tx, qqNumber);
      await lockWallets(tx, [wallet.id]);
      const current = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: walletSelect });
      const paid = toMoney(current.paidBalance);
      if (delta < 0 && paid < Math.abs(delta)) {
        throw new WalletError('insufficient_balance', `余额不足：当前 ${paid.toFixed(2)} 元，无法扣除 ${Math.abs(delta).toFixed(2)} 元`);
      }
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { paidBalance: delta > 0 ? { increment: delta } : { decrement: Math.abs(delta) } },
      });
      await mirrorQqWalletDelta(tx, wallet, 0, delta);
      await createLedgerRows(tx, wallet.id, 'admin_adjust', 'admin', undefined, undefined, 0, delta);
      const updated = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: walletSelect });
      return toMoney(updated.paidBalance).toFixed(2);
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 管理员按钱包 ID 调整付费余额；支持 user/qq 钱包，QQ 钱包会同步旧 qq_quotas。 */
  async adjustPaidBalanceByWalletId(walletId: number, amount: number): Promise<string> {
    const delta = toMoney(amount);
    if (!Number.isSafeInteger(walletId) || walletId <= 0) throw new WalletError('invalid_request', '钱包 ID 不正确');
    if (delta === 0) throw new WalletError('invalid_request', '调整金额不能为 0');
    return this.prisma.$transaction(async (tx) => {
      await lockWallets(tx, [walletId]);
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: walletSelect });
      const paid = toMoney(wallet.paidBalance);
      if (delta < 0 && paid < Math.abs(delta)) {
        throw new WalletError('insufficient_balance', `余额不足：当前 ${paid.toFixed(2)} 元，无法扣除 ${Math.abs(delta).toFixed(2)} 元`);
      }
      await tx.wallet.update({
        where: { id: walletId },
        data: { paidBalance: delta > 0 ? { increment: delta } : { decrement: Math.abs(delta) } },
      });
      await mirrorQqWalletDelta(tx, wallet, 0, delta);
      await createLedgerRows(tx, wallet.id, 'admin_adjust', 'admin', undefined, undefined, 0, delta);
      const updated = await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: walletSelect });
      return toMoney(updated.paidBalance).toFixed(2);
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 管理员按钱包 ID 重置免费余额；每日总额仍按 Web/QQ 两端拆半。 */
  async resetFreeBalanceByWalletId(walletId: number, dailyTotalAmount: number): Promise<string> {
    if (!Number.isSafeInteger(walletId) || walletId <= 0) throw new WalletError('invalid_request', '钱包 ID 不正确');
    const amount = toMoney(Math.max(0, dailyTotalAmount) / 2);
    await this.prisma.$transaction(async (tx) => {
      await lockWallets(tx, [walletId]);
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: walletSelect });
      const freeDelta = toMoney(amount - toMoney(wallet.freeBalance));
      await tx.wallet.update({ where: { id: walletId }, data: { freeBalance: amount } });
      if (wallet.ownerType === 'qq') {
        await tx.qqQuota.upsert({
          where: { qqNumber: BigInt(wallet.ownerKey) },
          update: { freeBalance: amount },
          create: { qqNumber: BigInt(wallet.ownerKey), freeBalance: amount },
        });
      }
      await tx.dailyFreeGrant.createMany({
        data: [{ walletId, grantDate: getChinaDateOnly(), amount }],
        skipDuplicates: true,
      });
      // 管理员免费余额重置属于受控调账，按差额写流水便于后续审计和恢复。
      await createLedgerRows(tx, wallet.id, 'admin_adjust', 'admin', undefined, undefined, freeDelta, 0);
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
    return amount.toFixed(2);
  }

  /** 每日重置所有已知钱包免费余额；Web 和 QQ 钱包各获得每日总额的一半。 */
  async resetAllKnownFreeBalances(dailyTotalAmount: number): Promise<number> {
    const amount = toMoney(Math.max(0, dailyTotalAmount) / 2);
    return this.prisma.$transaction(async (tx) => {
      const users = await tx.user.findMany({ select: { id: true } });
      for (const user of users) await this.ensureUserWalletTx(tx, user.id);
      const qqNumbers = await this.listKnownQqNumbersTx(tx);
      for (const qqNumber of qqNumbers) await this.ensureQqWalletTx(tx, qqNumber);

      const walletsBeforeReset = await tx.wallet.findMany({ select: walletSelect });
      const result = await tx.wallet.updateMany({ data: { freeBalance: amount } });
      if (qqNumbers.length > 0) {
        await tx.qqQuota.updateMany({ where: { qqNumber: { in: qqNumbers } }, data: { freeBalance: amount } });
      }
      // 重置是运维行为，不依赖 daily_free_grants 幂等；写入 grant 标记避免同日懒发再追加一次。
      const today = getChinaDateOnly();
      if (walletsBeforeReset.length > 0) {
        await tx.dailyFreeGrant.createMany({
          data: walletsBeforeReset.map((wallet) => ({ walletId: wallet.id, grantDate: today, amount })),
          skipDuplicates: true,
        });
        for (const wallet of walletsBeforeReset) {
          const freeDelta = toMoney(amount - toMoney(wallet.freeBalance));
          // 每日统一重置免费余额也必须写流水；金额为差额，记录本次重置给用户带来的增减。
          await createLedgerRows(tx, wallet.id, 'daily_free', 'system', undefined, undefined, freeDelta, 0);
        }
      }
      return result.count;
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 30000 });
  }

  /** 在既有事务内关闭 Web/QQ 钱包共享关系；不会移动任何余额。 */
  async unlinkUserTx(tx: TxClient, userId: number, ip?: string): Promise<void> {
    await tx.walletLink.updateMany({
      where: { activeUserKey: String(userId), status: 'active' },
      data: { status: 'unbound', activeUserKey: null, activeQqKey: null, unboundAt: new Date(), unboundByIp: ip },
    });
  }

  /** 查询用户可访问钱包并惰性发放当日免费余额；顺序固定为 user 钱包优先。 */
  async getAccessibleWalletsForUserTx(tx: TxClient, userId: number): Promise<WalletRecord[]> {
    const userWallet = await this.ensureUserWalletTx(tx, userId);
    await this.ensureDailyFreeGrantTx(tx, userWallet);
    const link = await tx.walletLink.findFirst({
      where: { activeUserKey: String(userId), status: 'active' },
      select: { qqNumber: true },
    });
    if (!link) return [await tx.wallet.findUniqueOrThrow({ where: { id: userWallet.id }, select: walletSelect })];
    const qqWallet = await this.ensureQqWalletTx(tx, link.qqNumber);
    await this.ensureDailyFreeGrantTx(tx, qqWallet);
    return [
      await tx.wallet.findUniqueOrThrow({ where: { id: userWallet.id }, select: walletSelect }),
      await tx.wallet.findUniqueOrThrow({ where: { id: qqWallet.id }, select: walletSelect }),
    ];
  }

  /** 查询 QQ 可访问钱包并惰性发放当日免费余额；顺序固定为 QQ 钱包优先。 */
  async getAccessibleWalletsForQqTx(tx: TxClient, qqNumber: bigint): Promise<WalletRecord[]> {
    const qqWallet = await this.ensureQqWalletTx(tx, qqNumber);
    await this.ensureDailyFreeGrantTx(tx, qqWallet);
    const link = await tx.walletLink.findFirst({
      where: { activeQqKey: qqNumber.toString(), status: 'active' },
      select: { userId: true },
    });
    if (!link) return [await tx.wallet.findUniqueOrThrow({ where: { id: qqWallet.id }, select: walletSelect })];
    const userWallet = await this.ensureUserWalletTx(tx, link.userId);
    await this.ensureDailyFreeGrantTx(tx, userWallet);
    return [
      await tx.wallet.findUniqueOrThrow({ where: { id: qqWallet.id }, select: walletSelect }),
      await tx.wallet.findUniqueOrThrow({ where: { id: userWallet.id }, select: walletSelect }),
    ];
  }

  /** 确保 Web 用户钱包存在；新建钱包初始余额为 0，当日免费额度由 daily grant 单独发放。 */
  async ensureUserWalletTx(tx: TxClient, userId: number): Promise<WalletRecord> {
    const ownerKey = String(userId);
    const existing = await tx.wallet.findUnique({
      where: { ownerType_ownerKey: { ownerType: 'user', ownerKey } },
      select: walletSelect,
    });
    if (existing) {
      if (existing.userId === userId) return existing;
      // 只在历史数据缺少 user_id 或异常指向旧值时修正，避免每次查询余额都写 wallets 引发并发冲突。
      return tx.wallet.update({ where: { id: existing.id }, data: { userId }, select: walletSelect });
    }
    try {
      return await tx.wallet.create({
        data: { ownerType: 'user', ownerKey, userId },
        select: walletSelect,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // 并发首次访问同一 Web 用户时，唯一键冲突说明另一事务已创建钱包；直接回读即可。
      return tx.wallet.findUniqueOrThrow({ where: { ownerType_ownerKey: { ownerType: 'user', ownerKey } }, select: walletSelect });
    }
  }

  /** 确保 QQ 钱包存在；首次创建时从旧 qq_quotas 复制余额，避免历史余额丢失。 */
  async ensureQqWalletTx(tx: TxClient, qqNumber: bigint): Promise<WalletRecord> {
    const ownerKey = qqNumber.toString();
    const existing = await tx.wallet.findUnique({
      where: { ownerType_ownerKey: { ownerType: 'qq', ownerKey } },
      select: walletSelect,
    });
    if (existing) return existing;
    const legacy = await tx.qqQuota.findUnique({ where: { qqNumber }, select: { freeBalance: true, paidBalance: true } });
    const wallet = await createQqWalletFromLegacy(tx, ownerKey, legacy);
    const legacyHasBalance = legacy && (toMoney(legacy.freeBalance) > 0 || toMoney(legacy.paidBalance) > 0);
    if (legacyHasBalance) {
      // 只有迁移到非零旧余额时才阻止当天懒发，避免新 QQ 的 0 余额兼容行吞掉半额免费额度。
      await tx.dailyFreeGrant.createMany({
        data: [{ walletId: wallet.id, grantDate: getChinaDateOnly(), amount: 0 }],
        skipDuplicates: true,
      });
    }
    return wallet;
  }

  /** 汇总当前系统已知 QQ，供钱包迁移和每日重置覆盖未绑定 Bot 用户。 */
  private async listKnownQqNumbersTx(tx: TxClient): Promise<bigint[]> {
    const quotas = await tx.qqQuota.findMany({ select: { qqNumber: true } });
    const tasks = await tx.generationTask.findMany({ where: { qqNumber: { not: null } }, distinct: ['qqNumber'], select: { qqNumber: true } });
    const bindings = await tx.qqBinding.findMany({ where: { qqNumber: { not: null } }, select: { qqNumber: true } });
    const redeems = await tx.rechargeCard.findMany({ where: { redeemedQq: { not: null } }, distinct: ['redeemedQq'], select: { redeemedQq: true } });
    const modelPrefs = await tx.userModelPref.findMany({ where: { qqNumber: { not: null } }, select: { qqNumber: true } });
    const privacyPrefs = await tx.qqImagePrivacyPref.findMany({ select: { qqNumber: true } });
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

  /** 当日免费余额按端拆半发放；同一钱包同一天只发一次。 */
  async ensureDailyFreeGrantTx(tx: TxClient, wallet: WalletRecord): Promise<void> {
    const amount = await this.getDailyFreePerWallet();
    if (amount <= 0) return;
    const created = await tx.dailyFreeGrant.createMany({
      data: [{ walletId: wallet.id, grantDate: getChinaDateOnly(), amount }],
      skipDuplicates: true,
    });
    if (created.count !== 1) return;
    await tx.wallet.update({ where: { id: wallet.id }, data: { freeBalance: { increment: amount } } });
    await mirrorQqWalletDelta(tx, wallet, amount, 0);
    await createLedgerRows(tx, wallet.id, 'daily_free', 'system', undefined, undefined, amount, 0);
  }

  /** 读取每日免费总额度并按 Web/QQ 两端拆半，保留两位小数。 */
  private async getDailyFreePerWallet(): Promise<number> {
    try {
      const row = await this.prisma.systemConfig.findUnique({ where: { key: 'free_balance_daily' }, select: { value: true } });
      return toMoney(Math.max(0, Number(row?.value ?? '1.2')) / 2);
    } catch {
      return 0.6;
    }
  }
}

/** 钱包统一 select 字段，避免未来大字段被默认查询。 */
const walletSelect = {
  id: true,
  ownerType: true,
  ownerKey: true,
  userId: true,
  freeBalance: true,
  paidBalance: true,
} satisfies Prisma.WalletSelect;

/** 独立平台预留查询必须同时读取固化价格与原钱包分账，避免终态接口重新计算。 */
const localPlatformReservationInclude = {
  priceVersion: true,
  allocations: {
    orderBy: { id: 'asc' as const },
    include: { wallet: { select: walletSelect } },
  },
} satisfies Prisma.LocalPlatformBillingReservationInclude;

/** 独立平台预留及其固化关系的数据库载荷类型。 */
type LocalPlatformReservationRecord = Prisma.LocalPlatformBillingReservationGetPayload<{
  include: typeof localPlatformReservationInclude;
}>;

/** 从旧 QQ 额度创建 QQ 钱包；并发创建同一 QQ 时回读已创建的钱包，避免唯一键冲突冒泡。 */
async function createQqWalletFromLegacy(
  tx: TxClient,
  ownerKey: string,
  legacy: { freeBalance: Prisma.Decimal; paidBalance: Prisma.Decimal } | null,
): Promise<WalletRecord> {
  try {
    return await tx.wallet.create({
      data: {
        ownerType: 'qq',
        ownerKey,
        freeBalance: legacy?.freeBalance ?? 0,
        paidBalance: legacy?.paidBalance ?? 0,
      },
      select: walletSelect,
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return tx.wallet.findUniqueOrThrow({ where: { ownerType_ownerKey: { ownerType: 'qq', ownerKey } }, select: walletSelect });
  }
}

/** 判断 Prisma 唯一键冲突；钱包首次访问可能由多个请求同时触发创建。 */
function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 锁定钱包行，确保并发扣费、退款和充值不会互相覆盖。 */
async function lockWallets(tx: TxClient, walletIds: number[]) {
  if (walletIds.length === 0) return;
  await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT id FROM wallets WHERE id IN (${Prisma.join(walletIds)}) FOR UPDATE
  `);
}

/** 锁定独立平台预留行，确保提交与释放不会并发进入不同终态。 */
async function lockLocalPlatformReservation(tx: TxClient, reservationId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM local_platform_billing_reservations WHERE id = ${reservationId} FOR UPDATE
  `);
  if (rows.length === 0) throw new WalletError('invalid_request', '本地模型计费预留不存在');
}

/** 将独立平台预留数据库记录转换为不暴露钱包标识的共享契约视图。 */
function toLocalPlatformReservationView(reservation: LocalPlatformReservationRecord): LocalPlatformBillingReservationView {
  const allocation = reservation.allocations.reduce((total, item) => ({
    free: toMoney(total.free + toMoney(item.freeAmount)),
    paid: toMoney(total.paid + toMoney(item.paidAmount)),
  }), { free: 0, paid: 0 });
  return {
    reservationId: reservation.id,
    externalTaskId: reservation.externalTaskId,
    status: reservation.status === 'committed' ? 'committed' : reservation.status === 'released' ? 'released' : 'reserved',
    productCode: reservation.priceVersion.productCode,
    pricingVersion: reservation.priceVersion.pricingVersion,
    quantity: toQuantity(reservation.quantity),
    reservedAmount: toMoney(reservation.reservedAmount).toFixed(2),
    freeUsed: allocation.free.toFixed(2),
    paidUsed: allocation.paid.toFixed(2),
    currency: 'CNY',
    expiresAt: reservation.expiresAt?.toISOString(),
  };
}

/** QQ 钱包余额变化同步到旧 qq_quotas，兼容后台旧页面和未改造内部接口。 */
async function mirrorQqWalletDelta(tx: TxClient, wallet: WalletRecord, freeDelta: number, paidDelta: number) {
  if (wallet.ownerType !== 'qq') return;
  const qqNumber = BigInt(wallet.ownerKey);
  await tx.qqQuota.upsert({
    where: { qqNumber },
    update: {
      freeBalance: freeDelta >= 0 ? { increment: freeDelta } : { decrement: Math.abs(freeDelta) },
      paidBalance: paidDelta >= 0 ? { increment: paidDelta } : { decrement: Math.abs(paidDelta) },
    },
    create: {
      qqNumber,
      freeBalance: Math.max(0, freeDelta),
      paidBalance: Math.max(0, paidDelta),
    },
  });
}

/** 按免费/付费两种余额创建流水；0 金额不写，避免噪声。 */
async function createLedgerRows(
  tx: TxClient,
  walletId: number,
  type: string,
  source: string,
  taskId: string | undefined,
  rechargeCardId: number | undefined,
  freeAmount: number,
  paidAmount: number,
  metadata?: Prisma.InputJsonValue,
) {
  const data: Prisma.WalletLedgerCreateManyInput[] = [];
  if (freeAmount !== 0) data.push({ walletId, type, source, taskId, rechargeCardId, balanceKind: 'free', amount: freeAmount, metadata });
  if (paidAmount !== 0) data.push({ walletId, type, source, taskId, rechargeCardId, balanceKind: 'paid', amount: paidAmount, metadata });
  if (data.length > 0) await tx.walletLedger.createMany({ data });
}

/** 构造 Web 钱包状态响应。 */
function buildWalletStatus(primary: WalletRecord, linked?: WalletRecord): WalletStatusResponse {
  const wallets = linked ? [primary, linked] : [primary];
  const total = sumWalletBalances(wallets);
  return {
    primaryWallet: toWalletBalanceView(primary),
    linkedWallet: linked ? toWalletBalanceView(linked) : undefined,
    linkedQqNumber: linked?.ownerType === 'qq' ? linked.ownerKey : undefined,
    freeBalance: total.freeBalance,
    paidBalance: total.paidBalance,
    totalBalance: total.totalBalance,
  };
}

/** 将数据库钱包记录转换为共享契约视图。 */
function toWalletBalanceView(wallet: WalletRecord): WalletBalanceView {
  return {
    walletId: wallet.id,
    ownerType: wallet.ownerType === 'qq' ? 'qq' : 'user',
    ownerKey: wallet.ownerKey,
    freeBalance: toMoney(wallet.freeBalance).toFixed(2),
    paidBalance: toMoney(wallet.paidBalance).toFixed(2),
  };
}

/** 将钱包流水转换为前端可展示视图；缺失钱包时仍不抛出私有字段。 */
function toWalletLedgerEntryView(
  item: {
    id: number;
    walletId: number;
    type: string;
    amount: Prisma.Decimal;
    balanceKind: string;
    source: string;
    taskId: string | null;
    rechargeCardId: number | null;
    createdAt: Date;
  },
  wallet: WalletRecord | undefined,
  balanceAfter?: { freeBalanceAfter: string; paidBalanceAfter: string },
): WalletLedgerEntryView {
  const ownerType = wallet?.ownerType === 'qq' ? 'qq' : 'user';
  const ownerKey = wallet?.ownerKey ?? '';
  return {
    id: item.id,
    walletId: item.walletId,
    ownerType,
    ownerKey,
    walletLabel: ownerType === 'qq' ? `QQ 钱包 ${ownerKey}` : '网页钱包',
    type: normalizeLedgerType(item.type),
    balanceKind: item.balanceKind === 'paid' ? 'paid' : 'free',
    source: normalizeLedgerSource(item.source),
    amount: toMoney(item.amount).toFixed(2),
    freeBalanceAfter: balanceAfter?.freeBalanceAfter ?? '0.00',
    paidBalanceAfter: balanceAfter?.paidBalanceAfter ?? '0.00',
    taskId: item.taskId ?? undefined,
    rechargeCardId: item.rechargeCardId ?? undefined,
    createdAt: item.createdAt.toISOString(),
  };
}

/** 构造流水筛选条件；只允许白名单字段，避免前端参数影响其他钱包数据。 */
function buildLedgerWhere(walletIds: number[], input: WalletLedgerListQuery): Prisma.WalletLedgerWhereInput {
  const where: Prisma.WalletLedgerWhereInput = { walletId: { in: walletIds } };
  const type = normalizeLedgerTypeFilter(input.type);
  const balanceKind = normalizeBalanceKindFilter(input.balanceKind);
  const source = normalizeLedgerSourceFilter(input.source);
  if (type) where.type = type;
  if (balanceKind) where.balanceKind = balanceKind;
  if (source) where.source = source;
  const range = buildDateRange(input.dateFrom, input.dateTo);
  if (range) where.createdAt = range;
  return where;
}

/** 计算每条流水发生后的免费/付费余额；从当前钱包余额按倒序回推，避免改历史数据结构。 */
async function buildLedgerBalanceAfterMap(
  tx: TxClient,
  walletIds: number[],
  pageItems: Array<{ id: number; walletId: number }>,
): Promise<Map<number, { freeBalanceAfter: string; paidBalanceAfter: string }>> {
  if (pageItems.length === 0) return new Map();
  const minIdsByWallet = new Map<number, number>();
  for (const item of pageItems) {
    const current = minIdsByWallet.get(item.walletId);
    if (current === undefined || item.id < current) minIdsByWallet.set(item.walletId, item.id);
  }
  const [wallets, ledgerRows] = await Promise.all([
    tx.wallet.findMany({ where: { id: { in: walletIds } }, select: walletSelect }),
    tx.walletLedger.findMany({
      where: {
        OR: [...minIdsByWallet.entries()].map(([walletId, minId]) => ({ walletId, id: { gte: minId } })),
      },
      orderBy: [{ walletId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, walletId: true, amount: true, balanceKind: true },
    }),
  ]);
  const walletBalance = new Map(wallets.map((wallet) => [wallet.id, {
    free: toMoney(wallet.freeBalance),
    paid: toMoney(wallet.paidBalance),
  }]));
  const wanted = new Set(pageItems.map((item) => item.id));
  const result = new Map<number, { freeBalanceAfter: string; paidBalanceAfter: string }>();
  for (const row of ledgerRows) {
    const state = walletBalance.get(row.walletId) ?? { free: 0, paid: 0 };
    if (wanted.has(row.id)) {
      result.set(row.id, { freeBalanceAfter: state.free.toFixed(2), paidBalanceAfter: state.paid.toFixed(2) });
    }
    const amount = toMoney(row.amount);
    if (row.balanceKind === 'paid') state.paid = toMoney(state.paid - amount);
    else state.free = toMoney(state.free - amount);
    walletBalance.set(row.walletId, state);
  }
  return result;
}

/** 归一化流水类型筛选；all 或异常值表示不过滤。 */
function normalizeLedgerTypeFilter(type: WalletLedgerListQuery['type']): WalletLedgerType | undefined {
  if (type === 'daily_free' || type === 'recharge' || type === 'charge' || type === 'refund' || type === 'admin_adjust' || type === 'referral_reward') return type;
  return undefined;
}

/** 归一化余额类型筛选；all 或异常值表示不过滤。 */
function normalizeBalanceKindFilter(kind: WalletLedgerListQuery['balanceKind']): WalletBalanceKind | undefined {
  if (kind === 'free' || kind === 'paid') return kind;
  return undefined;
}

/** 归一化渠道筛选；all 或异常值表示不过滤。 */
function normalizeLedgerSourceFilter(source: WalletLedgerListQuery['source']): WalletLedgerSource | undefined {
  if (source === 'web' || source === 'bot' || source === 'admin' || source === 'system') return source;
  return undefined;
}

/** 日期筛选按中国时区自然日处理，dateTo 包含当天整日。 */
function buildDateRange(dateFrom?: string, dateTo?: string): Prisma.DateTimeFilter | undefined {
  const range: Prisma.DateTimeFilter = {};
  const from = parseChinaDateStart(dateFrom);
  const to = parseChinaDateEnd(dateTo);
  if (from) range.gte = from;
  if (to) range.lte = to;
  return Object.keys(range).length > 0 ? range : undefined;
}

/** 解析中国时区日期起点到 UTC Date。 */
function parseChinaDateStart(value?: string): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** 解析中国时区日期终点到 UTC Date。 */
function parseChinaDateEnd(value?: string): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T23:59:59.999+08:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** 归一化流水类型，数据库历史值异常时兜底为后台调整，避免前端崩溃。 */
function normalizeLedgerType(type: string): WalletLedgerEntryView['type'] {
  if (type === 'daily_free' || type === 'recharge' || type === 'charge' || type === 'refund' || type === 'admin_adjust' || type === 'referral_reward') return type;
  return 'admin_adjust';
}

/** 归一化流水来源，数据库历史值异常时兜底为 system。 */
function normalizeLedgerSource(source: string): WalletLedgerEntryView['source'] {
  if (source === 'web' || source === 'bot' || source === 'admin' || source === 'system') return source;
  return 'system';
}

/** 汇总钱包余额并格式化为字符串。 */
function sumWalletBalances(wallets: WalletRecord[]) {
  const total = sumWalletNumbers(wallets);
  return {
    freeBalance: total.free.toFixed(2),
    paidBalance: total.paid.toFixed(2),
    totalBalance: toMoney(total.free + total.paid).toFixed(2),
  };
}

/** 汇总钱包余额为 number，所有金额都保留两位小数。 */
function sumWalletNumbers(wallets: WalletRecord[]) {
  return wallets.reduce((acc, wallet) => ({
    free: toMoney(acc.free + toMoney(wallet.freeBalance)),
    paid: toMoney(acc.paid + toMoney(wallet.paidBalance)),
  }), { free: 0, paid: 0 });
}

/** 金额归一化到两位小数，Prisma Decimal、number 和 string 都走同一规则。 */
function toMoney(value: number | string | Prisma.Decimal) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : value.toNumber();
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) / 100;
}

/** 计费数量保留三位小数，与数据库精度一致，避免幂等比较误判。 */
function toQuantity(value: number | string | Prisma.Decimal) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : value.toNumber();
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 1000) / 1000;
}

/** 获取中国日期零点，匹配 MySQL DATE 字段的幂等键。 */
function getChinaDateOnly() {
  const chinaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(chinaNow.getUTCFullYear(), chinaNow.getUTCMonth(), chinaNow.getUTCDate()));
}

/** 读取必填 number；缺失时抛钱包参数错误，避免扣到错误身份。 */
function requiredNumber(value: number | undefined, message: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new WalletError('invalid_request', message);
  }
  return value;
}

/** 读取必填 bigint；缺失时抛钱包参数错误，避免扣到错误身份。 */
function requiredBigInt(value: bigint | undefined, message: string) {
  if (!value || value <= 0n) throw new WalletError('invalid_request', message);
  return value;
}
