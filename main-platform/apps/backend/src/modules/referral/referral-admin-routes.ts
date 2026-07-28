/** 本文件注册后台邀请码运营接口，只做真实审计查询和邀请码禁用状态管理。 */
import type { IncomingMessage } from 'node:http';
import { Prisma } from '@prisma/client';
import {
  ApiErrorCode,
  type AdminInviteCodeListResponse,
  type AdminInviteCodeStatusRequest,
  type AdminInviteCodeView,
  type AdminReferralOverviewResponse,
  type AdminReferralRelationListResponse,
  type AdminReferralRelationView,
} from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { getAppBaseUrl } from '../../shared/config/config-service.js';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';

const prisma = getPrismaClient();

type InviteCodeStatusFilter = 'all' | 'enabled' | 'disabled';
type ReferralRelationStatusFilter = 'all' | 'none' | 'pending_email' | 'rewarded';

/** 创建后台邀请运营路由；必须由 backend 持有数据库最终读写。 */
export function createReferralAdminRoutes(): Route[] {
  return [
    { method: 'GET', path: '/admin/referrals/overview', handle: getReferralOverview },
    { method: 'GET', path: '/admin/referrals/invite-codes', handle: listInviteCodes },
    { method: 'GET', path: '/admin/referrals/relations', handle: listReferralRelations },
    { method: 'PATCH', path: '/admin/referrals/invite-codes/:userId', handle: updateInviteCodeStatus },
  ];
}

/** 管理员查看邀请奖励全局总览，不读取任何钱包明细。 */
async function getReferralOverview(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return forbidden(res);
  const [inviteCodeTotal, disabledInviteCodeCount, relationTotal, rewardedRelationCount, pendingRelationCount, rewardAgg, latestRewarded] = await Promise.all([
    prisma.userInviteCode.count(),
    prisma.userInviteCode.count({ where: { disabledAt: { not: null } } }),
    prisma.userReferral.count(),
    prisma.userReferral.count({ where: { status: 'rewarded' } }),
    prisma.userReferral.count({ where: { status: { not: 'rewarded' } } }),
    prisma.userReferral.aggregate({
      where: { status: 'rewarded' },
      _sum: { inviterRewardAmount: true, inviteeRewardAmount: true },
    }),
    prisma.userReferral.findFirst({
      where: { rewardedAt: { not: null } },
      orderBy: { rewardedAt: 'desc' },
      select: { rewardedAt: true },
    }),
  ]);
  const inviterReward = toMoney(rewardAgg._sum.inviterRewardAmount);
  const inviteeReward = toMoney(rewardAgg._sum.inviteeRewardAmount);
  const data: AdminReferralOverviewResponse = {
    inviteCodeTotal,
    enabledInviteCodeCount: inviteCodeTotal - disabledInviteCodeCount,
    disabledInviteCodeCount,
    relationTotal,
    rewardedRelationCount,
    pendingRelationCount,
    totalInviterReward: inviterReward.toFixed(2),
    totalInviteeReward: inviteeReward.toFixed(2),
    totalReward: toMoney(inviterReward + inviteeReward).toFixed(2),
    latestRewardedAt: latestRewarded?.rewardedAt?.toISOString(),
  };
  return sendJson(res, 200, { ok: true, data });
}

/** 管理员分页查看邀请码；搜索范围包含用户名、邮箱和邀请码。 */
async function listInviteCodes(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return forbidden(res);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { page, pageSize, skip } = readPagination(url);
  const status = readInviteCodeStatus(url.searchParams.get('status'));
  const search = normalizeSearch(url.searchParams.get('search'));
  const where: Prisma.UserInviteCodeWhereInput = {
    ...(status === 'enabled' ? { disabledAt: null } : {}),
    ...(status === 'disabled' ? { disabledAt: { not: null } } : {}),
    ...(search ? {
      OR: [
        { code: { contains: search } },
        { user: { username: { contains: search } } },
        { user: { email: { contains: search } } },
      ],
    } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.userInviteCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      select: {
        userId: true,
        code: true,
        createdAt: true,
        disabledAt: true,
        user: { select: { username: true, email: true, emailVerified: true } },
      },
    }),
    prisma.userInviteCode.count({ where }),
  ]);
  const userIds = items.map((item) => item.userId);
  const stats = userIds.length ? await prisma.userReferral.groupBy({
    by: ['inviterUserId', 'status'],
    where: { inviterUserId: { in: userIds } },
    _count: { _all: true },
    _sum: { inviterRewardAmount: true },
  }) : [];
  const statsMap = buildInviteStatsMap(stats);
  const appBaseUrl = await getAppBaseUrl();
  const data: AdminInviteCodeListResponse = {
    items: items.map((item) => toInviteCodeView(item, appBaseUrl, statsMap.get(item.userId))),
    total,
    page,
    pageSize,
  };
  return sendJson(res, 200, { ok: true, data });
}

/** 管理员分页查看邀请关系；状态和搜索均来自真实邀请表。 */
async function listReferralRelations(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return forbidden(res);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { page, pageSize, skip } = readPagination(url);
  const status = readRelationStatus(url.searchParams.get('status'));
  const search = normalizeSearch(url.searchParams.get('search'));
  const where: Prisma.UserReferralWhereInput = {
    ...(status === 'pending_email' || status === 'rewarded' ? { status } : {}),
    ...(search ? {
      OR: [
        { inviteCode: { contains: search } },
        { inviter: { username: { contains: search } } },
        { inviter: { email: { contains: search } } },
        { invitee: { username: { contains: search } } },
        { invitee: { email: { contains: search } } },
      ],
    } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.userReferral.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      select: {
        id: true,
        inviteCode: true,
        source: true,
        status: true,
        inviterRewardAmount: true,
        inviteeRewardAmount: true,
        createdAt: true,
        updatedAt: true,
        rewardedAt: true,
        inviter: { select: { id: true, username: true, email: true, emailVerified: true } },
        invitee: { select: { id: true, username: true, email: true, emailVerified: true } },
      },
    }),
    prisma.userReferral.count({ where }),
  ]);
  const data: AdminReferralRelationListResponse = {
    items: items.map(toReferralRelationView),
    total,
    page,
    pageSize,
  };
  return sendJson(res, 200, { ok: true, data });
}

/** 管理员禁用或恢复用户的邀请码；关键约束：不修改历史邀请关系和钱包流水。 */
async function updateInviteCodeStatus(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return forbidden(res);
  const userId = Number(params?.userId ?? 0);
  if (!Number.isInteger(userId) || userId <= 0) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '用户 ID 不正确' });
  }
  const body = await readJsonBody<AdminInviteCodeStatusRequest>(req);
  const disabled = Boolean(body.disabled);
  const updated = await prisma.userInviteCode.update({
    where: { userId },
    data: { disabledAt: disabled ? new Date() : null },
    select: {
      userId: true,
      code: true,
      createdAt: true,
      disabledAt: true,
      user: { select: { username: true, email: true, emailVerified: true } },
    },
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return null;
    throw error;
  });
  if (!updated) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '邀请码不存在' });
  const stats = await prisma.userReferral.groupBy({
    by: ['inviterUserId', 'status'],
    where: { inviterUserId: userId },
    _count: { _all: true },
    _sum: { inviterRewardAmount: true },
  });
  const appBaseUrl = await getAppBaseUrl();
  return sendJson(res, 200, { ok: true, data: toInviteCodeView(updated, appBaseUrl, buildInviteStatsMap(stats).get(userId)) });
}

function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    const payload = verifyAccessToken(token);
    return payload.role === 'admin' ? payload : undefined;
  } catch { return undefined; }
}

function forbidden(res: Parameters<typeof sendJson>[0]) {
  return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
}

function readPagination(url: URL) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize') ?? '20') || 20));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function readInviteCodeStatus(value: string | null): InviteCodeStatusFilter {
  return value === 'enabled' || value === 'disabled' ? value : 'all';
}

function readRelationStatus(value: string | null): ReferralRelationStatusFilter {
  return value === 'pending_email' || value === 'rewarded' ? value : 'all';
}

function normalizeSearch(value: string | null) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 80) : '';
}

function buildInviteStatsMap(rows: Array<{ inviterUserId: number; status: string; _count: { _all: number }; _sum: { inviterRewardAmount: Prisma.Decimal | null } }>) {
  const map = new Map<number, { invitedCount: number; rewardedCount: number; pendingCount: number; inviterRewardTotal: number }>();
  for (const row of rows) {
    const current = map.get(row.inviterUserId) ?? { invitedCount: 0, rewardedCount: 0, pendingCount: 0, inviterRewardTotal: 0 };
    current.invitedCount += row._count._all;
    if (row.status === 'rewarded') {
      current.rewardedCount += row._count._all;
      current.inviterRewardTotal = toMoney(current.inviterRewardTotal + toMoney(row._sum.inviterRewardAmount));
    } else {
      current.pendingCount += row._count._all;
    }
    map.set(row.inviterUserId, current);
  }
  return map;
}

function toInviteCodeView(
  item: { userId: number; code: string; createdAt: Date; disabledAt: Date | null; user: { username: string; email: string; emailVerified: boolean } },
  appBaseUrl: string,
  stats?: { invitedCount: number; rewardedCount: number; pendingCount: number; inviterRewardTotal: number },
): AdminInviteCodeView {
  return {
    userId: item.userId,
    username: item.user.username,
    email: item.user.email,
    emailVerified: item.user.emailVerified,
    code: item.code,
    inviteUrl: buildInviteUrl(item.code, appBaseUrl),
    disabledAt: item.disabledAt?.toISOString(),
    createdAt: item.createdAt.toISOString(),
    invitedCount: stats?.invitedCount ?? 0,
    rewardedCount: stats?.rewardedCount ?? 0,
    pendingCount: stats?.pendingCount ?? 0,
    inviterRewardTotal: (stats?.inviterRewardTotal ?? 0).toFixed(2),
  };
}

function toReferralRelationView(item: {
  id: number;
  inviteCode: string;
  source: string;
  status: string;
  inviterRewardAmount: Prisma.Decimal;
  inviteeRewardAmount: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
  rewardedAt: Date | null;
  inviter: { id: number; username: string; email: string; emailVerified: boolean };
  invitee: { id: number; username: string; email: string; emailVerified: boolean };
}): AdminReferralRelationView {
  return {
    id: item.id,
    inviteCode: item.inviteCode,
    source: item.source,
    status: item.status === 'rewarded' ? 'rewarded' : 'pending_email',
    inviter: item.inviter,
    invitee: item.invitee,
    inviterRewardAmount: toMoney(item.inviterRewardAmount).toFixed(2),
    inviteeRewardAmount: toMoney(item.inviteeRewardAmount).toFixed(2),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    rewardedAt: item.rewardedAt?.toISOString(),
  };
}

/** 后台邀请码列表使用 system_configs.app_base_url 生成链接，避免配置只保存不生效。 */
function buildInviteUrl(code: string, appBaseUrl: string) {
  return `${appBaseUrl}/login?tab=register&invite=${encodeURIComponent(code)}`;
}

function toMoney(value: number | string | Prisma.Decimal | null | undefined) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : value?.toNumber() ?? 0;
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) / 100;
}
