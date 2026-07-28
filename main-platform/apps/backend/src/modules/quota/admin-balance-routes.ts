/**
 * 本文件注册管理员余额调整路由：增减 QQ 付费余额。
 * 所有接口需要 admin JWT。
 */
import type { IncomingMessage } from 'node:http';
import { Prisma } from '@prisma/client';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { QuotaService } from './quota-service.js';
import { QuotaRepository } from './quota-repository.js';
import { QuotaError } from './quota-types.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { WalletService } from '../wallet/wallet-service.js';
import { invalidateWalletCache, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheAdminWalletList } from '../../shared/cache/cache-policies.js';
import { isBotAdminQqNumber } from '../bot/bot-admin-config.js';

const quotaService = new QuotaService();
const walletService = new WalletService();
const prisma = getPrismaClient();

export function createAdminBalanceRoutes(): Route[] {
  return [
    { method: 'GET', path: '/admin/balance/accounts', handle: listAccounts },
    { method: 'GET', path: '/admin/balance/wallets', handle: listWallets },
    { method: 'GET', path: '/admin/balance/:qqNumber', handle: getBalance },
    { method: 'POST', path: '/admin/balance/adjust', handle: adjustBalance },
    { method: 'POST', path: '/admin/balance/wallet-adjust', handle: adjustWalletBalance },
    { method: 'POST', path: '/internal/balance/adjust', handle: internalAdjustBalance },
    { method: 'POST', path: '/admin/balance/reset-free/:qqNumber', handle: resetFreeBalance },
    { method: 'POST', path: '/admin/balance/reset-free-wallet/:walletId', handle: resetWalletFreeBalance },
    { method: 'POST', path: '/admin/balance/reset-free-all', handle: resetAllFreeBalances },
  ];
}

/** 管理员调整 QQ 余额（增减）。 */
async function adjustBalance(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const admin = authenticateAdmin(req);
  if (!admin) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });

  const body = await readJsonBody<{ qqNumber?: string; amount?: number; reason?: string }>(req);
  const qqStr = String(body.qqNumber ?? '').trim();
  const amount = Number(body.amount ?? 0);

  if (!/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }
  if (amount === 0 || !Number.isFinite(amount)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '调整金额不能为 0' });
  }

  try {
    const newBalance = await quotaService.adjustBalance(BigInt(qqStr), amount);
    const action = amount > 0 ? '增加' : '减少';
    invalidateWalletCache([`qq:${qqStr}`]);
    return sendJson(res, 200, {
      ok: true,
      data: {
        qqNumber: qqStr,
        action: `${action} ${Math.abs(amount).toFixed(2)} 元`,
        newBalance,
        reason: String(body.reason ?? ''),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '调整失败';
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message });
  }
}

/** 管理员按钱包 ID 调整付费余额；新后台优先使用该接口，避免把 Web 钱包误当 QQ 余额。 */
async function adjustWalletBalance(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const admin = authenticateAdmin(req);
  if (!admin) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });

  const body = await readJsonBody<{ walletId?: number; amount?: number; reason?: string }>(req);
  const walletId = Number(body.walletId ?? 0);
  const amount = Number(body.amount ?? 0);
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '钱包 ID 不正确' });
  }
  if (amount === 0 || !Number.isFinite(amount)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '调整金额不能为 0' });
  }
  try {
    const newBalance = await walletService.adjustPaidBalanceByWalletId(walletId, amount);
    invalidateWalletCache();
    return sendJson(res, 200, {
      ok: true,
      data: {
        walletId,
        action: `${amount > 0 ? '增加' : '减少'} ${Math.abs(amount).toFixed(2)} 元`,
        newBalance,
        reason: String(body.reason ?? ''),
      },
    });
  } catch (error) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error instanceof Error ? error.message : '调整失败' });
  }
}

/** 管理员查询某 QQ 的余额详情。 */
async function getBalance(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const admin = authenticateAdmin(req);
  if (!admin) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });

  const qqStr = params?.qqNumber ?? '';
  if (!/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }
  const qqNumber = BigInt(qqStr);
  const summary = await quotaService.getBalanceSummary(qqNumber);

  // 查询最近兑换记录
  const recentRedeems = await prisma.rechargeCard.findMany({
    where: { redeemedQq: qqNumber, status: 'used' },
    orderBy: { redeemedAt: 'desc' },
    take: 10,
    select: { amount: true, redeemedAt: true, batchId: true, redeemedQq: true, redeemedWalletId: true },
  });

  return sendJson(res, 200, {
    ok: true,
    data: {
      qqNumber: qqStr,
      paidBalance: summary.paidBalance,
      freeBalance: summary.freeBalance,
      recentRedeems: recentRedeems.map((r) => ({
        amount: r.amount.toFixed(2),
        redeemSource: r.redeemedQq ? 'qq' : 'web',
        redeemedWalletId: r.redeemedWalletId,
        redeemedAt: r.redeemedAt ? formatChinaDateTime(r.redeemedAt) : null,
        batchId: r.batchId,
      })),
    },
  });
}

/** 内部接口：Bot 服务使用 service token 调整余额，同时必须校验操作者 QQ 管理员权限。 */
async function internalAdjustBalance(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  const body = await readJsonBody<{ qqNumber?: string; amount?: number; reason?: string; operatorQqNumber?: string }>(req);
  const operatorQqStr = String(body.operatorQqNumber ?? '').trim();
  const qqStr = String(body.qqNumber ?? '').trim();
  const amount = Number(body.amount ?? 0);

  // Bot 管理命令是余额关键链路；后端必须兜底校验操作者 QQ，不能只信任 bot-service 前置判断。
  if (!await isBotAdminQqNumber(operatorQqStr)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要 QQ 管理员权限' });
  }
  if (!/^\d{5,}$/.test(qqStr)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  if (amount === 0) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '调整金额不能为 0' });

  const quotaService = new QuotaService();
  try {
    const balance = await quotaService.adjustBalance(BigInt(qqStr), amount);
    invalidateWalletCache([`qq:${qqStr}`]);
    return sendJson(res, 200, { ok: true, data: { qqNumber: qqStr, amount, balance } });
  } catch (error) {
    if (error instanceof QuotaError) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error.message });
    throw error;
  }
}

function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    const payload = verifyAccessToken(token);
    return payload.role === 'admin' ? payload : undefined;
  } catch { return undefined; }
}

/** 校验服务间 token */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}

/** 重置指定 QQ 的免费余额；配置项保存每日总额，QQ 钱包只取一半。 */
async function resetFreeBalance(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const qqStr = params?.qqNumber ?? '';
  if (!/^\d{5,}$/.test(qqStr)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  const dailyAmount = await getDailyFreeAmount();
  const val = await walletService.resetQqFreeBalance(BigInt(qqStr), dailyAmount);
  invalidateWalletCache([`qq:${qqStr}`]);
  return sendJson(res, 200, { ok: true, data: { qqNumber: qqStr, freeBalance: val } });
}

/** 重置指定钱包免费余额；Web/QQ 独立钱包各取每日总额的一半。 */
async function resetWalletFreeBalance(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const walletId = Number(params?.walletId ?? '0');
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '钱包 ID 不正确' });
  const dailyAmount = await getDailyFreeAmount();
  try {
    const freeBalance = await walletService.resetFreeBalanceByWalletId(walletId, dailyAmount);
    invalidateWalletCache();
    return sendJson(res, 200, { ok: true, data: { walletId, freeBalance } });
  } catch (error) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error instanceof Error ? error.message : '重置失败' });
  }
}

/** 重置所有已知钱包的免费余额；返回值必须展示实际单钱包金额。 */
async function resetAllFreeBalances(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const dailyAmount = await getDailyFreeAmount();
  const count = await walletService.resetAllKnownFreeBalances(dailyAmount);
  invalidateWalletCache();
  return sendJson(res, 200, { ok: true, data: { count, freeBalance: (Math.max(0, dailyAmount) / 2).toFixed(2) } });
}

/** 读取每日免费余额总额配置；Web/QQ 钱包独立发放时由调用方拆半。 */
async function getDailyFreeAmount(): Promise<number> {
  try {
    const row = await prisma.systemConfig.findUnique({ where: { key: 'free_balance_daily' }, select: { value: true } });
    return Math.max(0, Number(row?.value ?? '1.2'));
  } catch { return 1.2; }
}

/** QQ 账户列表：展示所有有配额的 QQ 的使用情况 */
async function listAccounts(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? '20'), 100);
  const search = url.searchParams.get('search') ?? '';

  const repo = new QuotaRepository(prisma);
  if (/^\d{5,}$/.test(search.trim())) {
    // 管理员精确搜索 QQ 时也视为一次受控触达，补齐历史缺失的余额行，避免真实 QQ 在列表中查不到。
    await repo.ensureBalanceRow(BigInt(search.trim()), await getDailyFreeAmount());
  }
  await repo.ensureKnownUserQuotaRows(0);
  const allKnownQqNumbers = await repo.listKnownUserQqNumbers();
  const matchedQqNumbers = search && /^\d+$/.test(search)
    ? allKnownQqNumbers.filter((qqNumber) => qqNumber.toString() === search)
    : allKnownQqNumbers;
  matchedQqNumbers.sort((a, b) => b.toString().localeCompare(a.toString(), 'en', { numeric: true }));
  const total = matchedQqNumbers.length;
  const qqNums = matchedQqNumbers.slice((page - 1) * pageSize, page * pageSize);
  const quotas = qqNums.length > 0
    ? await prisma.qqQuota.findMany({ where: { qqNumber: { in: qqNums } } })
    : [];
  const quotaMap = new Map(quotas.map((q) => [q.qqNumber.toString(), q]));

  // 批量查询绑定和任务统计；余额列表必须以 QQ 全集为主，未绑定网页的 QQ 也要展示。
  const [bindings, taskCounts] = await Promise.all([
    qqNums.length > 0 ? prisma.qqBinding.findMany({
      where: { qqNumber: { in: qqNums } },
      select: { qqNumber: true, verified: true, user: { select: { username: true, id: true } } },
    }) : [],
    qqNums.length > 0 ? prisma.generationTask.groupBy({
      by: ['qqNumber'], where: { qqNumber: { in: qqNums } }, _count: { id: true },
    }) : [],
  ]);

  let attemptMap = new Map<string, number>();
  if (qqNums.length > 0) {
    const attempts = await prisma.generationSubTask.findMany({
      where: { kind: 'upstream_attempt', task: { qqNumber: { in: qqNums } } },
      select: { id: true, task: { select: { qqNumber: true } } },
    });
    for (const a of attempts) {
      const qq = a.task?.qqNumber?.toString();
      if (qq) attemptMap.set(qq, (attemptMap.get(qq) || 0) + 1);
    }
  }

  const bindingMap = new Map(bindings.filter(b => b.qqNumber).map(b => [b.qqNumber!.toString(), b]));
  const taskMap = new Map(taskCounts.filter(t => t.qqNumber).map(t => [t.qqNumber!.toString(), t._count.id]));

  const items = qqNums.map((qqNumber) => {
    const qq = qqNumber.toString();
    const quota = quotaMap.get(qq);
    const binding = bindingMap.get(qq);
    return {
      qqNumber: qq,
      freeBalance: Math.max(0, quota?.freeBalance.toNumber() ?? 0).toFixed(2),
      paidBalance: Math.max(0, quota?.paidBalance.toNumber() ?? 0).toFixed(2),
      taskCount: taskMap.get(qq) ?? 0,
      attemptCount: attemptMap.get(qq) ?? 0,
      boundUsername: binding?.user?.username ?? null,
      boundUserId: binding?.user?.id ?? null,
      bindingVerified: binding?.verified ?? false,
    };
  });

  return sendJson(res, 200, { ok: true, data: { items, total, page, pageSize } });
}

/** 钱包列表：展示 Web/QQ 独立钱包、绑定关系、流水数和扣费分账数。 */
async function listWallets(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? '20'), 100);
  const ownerType = url.searchParams.get('ownerType') ?? '';
  const search = url.searchParams.get('search')?.trim() ?? '';

  const where: Prisma.WalletWhereInput = {};
  if (ownerType === 'user' || ownerType === 'qq') where.ownerType = ownerType;
  if (search) {
    where.OR = [
      { ownerKey: { contains: search } },
      { user: { username: { contains: search } } },
      { user: { email: { contains: search } } },
    ];
  }

  const cached = await cacheAdminWalletList(
    { page, pageSize, ownerType, search },
    async () => Promise.all([
    prisma.wallet.findMany({
      where,
      orderBy: [{ ownerType: 'asc' }, { updatedAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        ownerType: true,
        ownerKey: true,
        freeBalance: true,
        paidBalance: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, username: true, email: true, emailVerified: true } },
        _count: { select: { ledger: true, chargeRecords: true } },
      },
    }),
    prisma.wallet.count({ where }),
    prisma.walletLink.findMany({ where: { status: 'active' }, select: { userId: true, qqNumber: true, activeUserKey: true, activeQqKey: true } }),
    ]),
  );
  setBackendCacheHeader(res, cached.status);
  const [wallets, total, activeLinks] = cached.value;

  const linkedUsers = activeLinks.length > 0
    ? await prisma.user.findMany({
      where: { id: { in: [...new Set(activeLinks.map((link) => link.userId))] } },
      select: { id: true, username: true, email: true, emailVerified: true },
    })
    : [];
  const linkedUserMap = new Map(linkedUsers.map((user) => [user.id, user]));
  const linkByUser = new Map(activeLinks.filter(link => link.activeUserKey).map(link => [link.activeUserKey!, link]));
  const linkByQq = new Map(activeLinks.filter(link => link.activeQqKey).map(link => [link.activeQqKey!, link]));
  const items = wallets.map((wallet) => {
    const link = wallet.ownerType === 'user' ? linkByUser.get(wallet.ownerKey) : linkByQq.get(wallet.ownerKey);
    const linkedUser = link?.userId ? linkedUserMap.get(link.userId) : undefined;
    return {
      walletId: wallet.id,
      ownerType: wallet.ownerType,
      ownerKey: wallet.ownerKey,
      freeBalance: Math.max(0, wallet.freeBalance.toNumber()).toFixed(2),
      paidBalance: Math.max(0, wallet.paidBalance.toNumber()).toFixed(2),
      totalBalance: Math.max(0, wallet.freeBalance.toNumber() + wallet.paidBalance.toNumber()).toFixed(2),
      linkedUserId: link?.userId ?? (wallet.ownerType === 'user' ? wallet.user?.id ?? null : null),
      linkedUsername: wallet.ownerType === 'user' ? wallet.user?.username ?? null : linkedUser?.username ?? null,
      linkedQqNumber: link?.qqNumber?.toString() ?? (wallet.ownerType === 'qq' ? wallet.ownerKey : null),
      email: wallet.user?.email ?? linkedUser?.email ?? null,
      emailVerified: wallet.user?.emailVerified ?? linkedUser?.emailVerified ?? null,
      ledgerCount: wallet._count.ledger,
      chargeCount: wallet._count.chargeRecords,
      createdAt: formatChinaDateTime(wallet.createdAt),
      updatedAt: formatChinaDateTime(wallet.updatedAt),
    };
  });

  return sendJson(res, 200, { ok: true, data: { items, total, page, pageSize } });
}

function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}
