/** 本文件提供公开排行榜接口，所有统计只读取真实生成主任务表，不统计子任务或上游尝试。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, type Route } from '@aiimage/core-utils';
import { Prisma } from '@prisma/client';
import type {
  LeaderboardRange,
  UserTaskLeaderboardItem,
  UserTaskLeaderboardKind,
  UserTaskLeaderboardResponse,
  UserTaskLeaderboardSourceCount,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheUserTaskLeaderboard } from '../../shared/cache/cache-policies.js';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { buildAvatarUrl } from '../users/user-avatar-service.js';

const prisma = getPrismaClient();
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type TopUserTaskRow = {
  accountKey: string;
  accountType: string;
  userId: bigint | number | null;
  qqNumber: bigint | number | null;
  totalTasks: bigint | number;
  successTasks: bigint | number | null;
  failedTasks: bigint | number | null;
};

type SourceTaskRow = {
  accountKey: string;
  source: string | null;
  tasks: bigint | number;
};

type LeaderboardSummaryRow = {
  totalUsers: bigint | number | null;
  totalTasks: bigint | number | null;
};

type RankedUserTaskRow = TopUserTaskRow & {
  rank: bigint | number;
};

type LeaderboardUserProfile = {
  username: string;
  avatarUrl: string | null;
  qqAvatarUrl: string | null;
};

/** 创建排行榜公开路由。 */
export function createLeaderboardRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/leaderboards/users/tasks', handle: getUserTaskLeaderboard },
  ];
}

/** 读取用户任务排行榜；公开接口只返回昵称和聚合数量，避免泄露邮箱、QQ 等身份字段。 */
async function getUserTaskLeaderboard(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const kind = normalizeKind(url.searchParams.get('kind'));
  const range = normalizeRange(url.searchParams.get('range'));
  const limit = normalizeLimit(url.searchParams.get('limit'));
  const currentUserId = readOptionalUserId(req);

  const cached = await cacheUserTaskLeaderboard(kind, range, limit, () => buildUserTaskLeaderboard(kind, range, limit));
  const response = currentUserId
    ? await withCurrentUserRank(cached.value, currentUserId, range)
    : cached.value;
  // 登录态响应包含当前用户排名，不能让浏览器或共享缓存当作公共榜单响应复用。
  if (currentUserId && !res.headersSent) res.setHeader('Cache-Control', 'private, no-store');
  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: response });
}

/** 构建用户任务排行榜响应。 */
async function buildUserTaskLeaderboard(kind: UserTaskLeaderboardKind, range: LeaderboardRange, limit: number): Promise<UserTaskLeaderboardResponse> {
  const until = new Date();
  const since = range === 'all' ? null : new Date(until.getTime() - rangeToMs(range));

  const [topRows, summaryRows] = await Promise.all([
    prisma.$queryRaw<TopUserTaskRow[]>(Prisma.sql`
      SELECT
        normalized.accountKey,
        normalized.accountType,
        MAX(normalized.userId) AS userId,
        MAX(normalized.qqNumber) AS qqNumber,
        COUNT(*) AS totalTasks,
        SUM(CASE WHEN normalized.status = 'success' THEN 1 ELSE 0 END) AS successTasks,
        SUM(CASE WHEN normalized.status = 'failed' THEN 1 ELSE 0 END) AS failedTasks
      FROM (${buildNormalizedTaskSelectSql(since)}) normalized
      GROUP BY normalized.accountKey, normalized.accountType
      ORDER BY totalTasks DESC, successTasks DESC, normalized.accountKey ASC
      LIMIT ${limit}
    `),
    prisma.$queryRaw<LeaderboardSummaryRow[]>(Prisma.sql`
      SELECT COUNT(DISTINCT normalized.accountKey) AS totalUsers, COUNT(*) AS totalTasks
      FROM (${buildNormalizedTaskSelectSql(since)}) normalized
    `),
  ]);

  const accountKeys = topRows.map((row) => row.accountKey).filter(Boolean);
  const userIds = [...new Set(topRows.map((row) => toNullableNumber(row.userId)).filter((id): id is number => typeof id === 'number' && id > 0))];
  const [users, sourceRows] = await Promise.all([
    userIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            username: true,
            avatarFilename: true,
            qqBinding: { select: { qqNumber: true, verified: true } },
          },
        })
      : Promise.resolve([]),
    accountKeys.length > 0
      ? prisma.$queryRaw<SourceTaskRow[]>(Prisma.sql`
          SELECT normalized.accountKey, normalized.source, COUNT(*) AS tasks
          FROM (${buildNormalizedTaskSelectSql(since)}) normalized
          WHERE normalized.accountKey IN (${Prisma.join(accountKeys)})
          GROUP BY normalized.accountKey, normalized.source
        `)
      : Promise.resolve([]),
  ]);

  const usersById = new Map(users.map((user) => [user.id, {
    username: user.username,
    avatarUrl: buildAvatarUrl(user.avatarFilename),
    qqAvatarUrl: user.qqBinding?.verified && user.qqBinding.qqNumber ? buildQqAvatarUrl(user.qqBinding.qqNumber.toString()) : null,
  } satisfies LeaderboardUserProfile]));
  const sourcesByAccount = groupSourceRows(sourceRows);
  const items: UserTaskLeaderboardItem[] = topRows.map((row, index) => mapLeaderboardRow(row, index + 1, usersById, sourcesByAccount));

  const summary = summaryRows[0] ?? { totalUsers: 0, totalTasks: 0 };
  return {
    summary: {
      kind,
      range,
      since: since?.toISOString() ?? null,
      until: until.toISOString(),
      limit,
      totalUsers: toNumber(summary.totalUsers),
      totalTasks: toNumber(summary.totalTasks),
    },
    items,
  };
}

/** 在公共缓存榜单外追加当前登录用户排名，避免把个性化数据写入公共缓存。 */
async function withCurrentUserRank(base: UserTaskLeaderboardResponse, userId: number, range: LeaderboardRange): Promise<UserTaskLeaderboardResponse> {
  const item = await buildCurrentUserRank(userId, range);
  return {
    ...base,
    currentUser: {
      item,
      includedInItems: Boolean(item && base.items.some((row) => row.accountKey === item.accountKey)),
    },
  };
}

/** 构建当前登录用户在完整聚合榜单中的真实排名；不依赖前端当前 limit。 */
async function buildCurrentUserRank(userId: number, range: LeaderboardRange): Promise<UserTaskLeaderboardItem | null> {
  const until = new Date();
  const since = range === 'all' ? null : new Date(until.getTime() - rangeToMs(range));
  const accountKey = `user:${userId}`;
  const rows = await prisma.$queryRaw<RankedUserTaskRow[]>(Prisma.sql`
    SELECT ranked.*
    FROM (
      SELECT grouped.*, ROW_NUMBER() OVER (ORDER BY grouped.totalTasks DESC, grouped.successTasks DESC, grouped.accountKey ASC) AS rank
      FROM (
        SELECT
          normalized.accountKey,
          normalized.accountType,
          MAX(normalized.userId) AS userId,
          MAX(normalized.qqNumber) AS qqNumber,
          COUNT(*) AS totalTasks,
          SUM(CASE WHEN normalized.status = 'success' THEN 1 ELSE 0 END) AS successTasks,
          SUM(CASE WHEN normalized.status = 'failed' THEN 1 ELSE 0 END) AS failedTasks
        FROM (${buildNormalizedTaskSelectSql(since)}) normalized
        GROUP BY normalized.accountKey, normalized.accountType
      ) grouped
    ) ranked
    WHERE ranked.accountKey = ${accountKey}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;

  const [users, sourceRows] = await Promise.all([
    prisma.user.findMany({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        avatarFilename: true,
        qqBinding: { select: { qqNumber: true, verified: true } },
      },
    }),
    prisma.$queryRaw<SourceTaskRow[]>(Prisma.sql`
      SELECT normalized.accountKey, normalized.source, COUNT(*) AS tasks
      FROM (${buildNormalizedTaskSelectSql(since)}) normalized
      WHERE normalized.accountKey = ${accountKey}
      GROUP BY normalized.accountKey, normalized.source
    `),
  ]);
  const usersById = new Map(users.map((user) => [user.id, {
    username: user.username,
    avatarUrl: buildAvatarUrl(user.avatarFilename),
    qqAvatarUrl: user.qqBinding?.verified && user.qqBinding.qqNumber ? buildQqAvatarUrl(user.qqBinding.qqNumber.toString()) : null,
  } satisfies LeaderboardUserProfile]));
  const sourcesByAccount = groupSourceRows(sourceRows);
  return mapLeaderboardRow(row, toNumber(row.rank), usersById, sourcesByAccount);
}

/** 将数据库聚合行转换为公开排行榜行，统一 top 列表和当前用户排名的字段口径。 */
function mapLeaderboardRow(
  row: TopUserTaskRow,
  rank: number,
  usersById: Map<number, LeaderboardUserProfile>,
  sourcesByAccount: Map<string, UserTaskLeaderboardSourceCount[]>,
): UserTaskLeaderboardItem {
  const userId = toNullableNumber(row.userId);
  const qqNumber = toNullableString(row.qqNumber);
  const totalTasks = toNumber(row.totalTasks);
  const successTasks = toNumber(row.successTasks);
  const failedTasks = toNumber(row.failedTasks);
  const accountType = normalizeAccountType(row.accountType);
  const avatar = buildPublicAvatar(accountType, userId, qqNumber, usersById);
  return {
    rank,
    accountKey: row.accountKey,
    accountType,
    userId,
    qqNumberMasked: accountType === 'qq' && qqNumber ? maskQqNumber(qqNumber) : undefined,
    nickname: buildPublicNickname(accountType, userId, qqNumber, usersById),
    avatarUrl: avatar.url,
    avatarSource: avatar.source,
    totalTasks,
    successTasks,
    failedTasks,
    activeTasks: Math.max(0, totalTasks - successTasks - failedTasks),
    sourceCounts: sourcesByAccount.get(row.accountKey) ?? [],
  };
}

/** 按用户聚合来源拆分，并稳定排序常用来源。 */
function groupSourceRows(rows: SourceTaskRow[]): Map<string, UserTaskLeaderboardSourceCount[]> {
  const map = new Map<string, UserTaskLeaderboardSourceCount[]>();
  for (const row of rows) {
    const source = normalizeSource(row.source);
    const list = map.get(row.accountKey) ?? [];
    list.push({ source, label: sourceLabel(source), tasks: toNumber(row.tasks) });
    map.set(row.accountKey, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => sourceOrder(a.source) - sourceOrder(b.source) || b.tasks - a.tasks || a.source.localeCompare(b.source));
  }
  return map;
}

/** 构建主任务范围条件；排行榜只统计可归属到 Web 用户或 QQ 用户的真实主任务。 */
function buildTaskRangeWhereSql(since: Date | null): Prisma.Sql {
  if (!since) return Prisma.sql`(t.user_id IS NOT NULL OR t.qq_number IS NOT NULL)`;
  return Prisma.sql`(t.user_id IS NOT NULL OR t.qq_number IS NOT NULL) AND t.created_at >= ${since}`;
}

/** 归一化任务归属：优先 Web 用户；未绑定 QQ 的公开账号键使用哈希，禁止泄露完整 QQ。 */
function buildNormalizedTaskSelectSql(since: Date | null): Prisma.Sql {
  const whereSql = buildTaskRangeWhereSql(since);
  return Prisma.sql`
    SELECT
      CASE
        WHEN COALESCE(t.user_id, qb.user_id) IS NOT NULL THEN CONCAT('user:', COALESCE(t.user_id, qb.user_id))
        ELSE CONCAT('qq:', SHA2(CAST(t.qq_number AS CHAR), 256))
      END AS accountKey,
      CASE
        WHEN COALESCE(t.user_id, qb.user_id) IS NOT NULL THEN 'web'
        ELSE 'qq'
      END AS accountType,
      COALESCE(t.user_id, qb.user_id) AS userId,
      CASE
        WHEN COALESCE(t.user_id, qb.user_id) IS NULL THEN t.qq_number
        ELSE NULL
      END AS qqNumber,
      LOWER(COALESCE(t.source, 'other')) AS source,
      t.status AS status
    FROM generation_tasks t
    LEFT JOIN qq_bindings qb ON qb.qq_number = t.qq_number AND qb.verified = true
    WHERE ${whereSql}
  `;
}

/** 规范化排行榜类型，当前只开放最多调用。 */
function normalizeKind(value: string | null): UserTaskLeaderboardKind {
  return value === 'most_tasks' ? value : 'most_tasks';
}

/** 规范化排行榜时间范围。 */
function normalizeRange(value: string | null): LeaderboardRange {
  if (value === '7d' || value === '30d' || value === 'all') return value;
  return '24h';
}

/** 限制返回数量，避免公开接口被大 limit 拖慢数据库。 */
function normalizeLimit(value: string | null): number {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

/** 将统计范围转换为毫秒。 */
function rangeToMs(range: Exclude<LeaderboardRange, 'all'>): number {
  if (range === '7d') return 7 * 24 * 60 * 60 * 1000;
  if (range === '30d') return 30 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

/** 规范化来源字段，空值统一归入 other。 */
function normalizeSource(value: string | null): string {
  const source = String(value ?? '').trim().toLowerCase();
  return source || 'other';
}

/** 来源中文名称。 */
function sourceLabel(source: string): string {
  if (source === 'web') return '网页';
  if (source === 'bot') return 'Bot';
  if (source === 'api') return 'API';
  return '其他';
}

/** 常用来源展示顺序。 */
function sourceOrder(source: string): number {
  if (source === 'web') return 1;
  if (source === 'bot') return 2;
  if (source === 'api') return 4;
  return 99;
}

/** 账号类型兜底，避免数据库异常值传到前端。 */
function normalizeAccountType(value: string): 'web' | 'qq' {
  return value === 'qq' ? 'qq' : 'web';
}

/** 生成公开昵称：Web 用用户名，未绑定 QQ 只展示脱敏 Bot 用户标识。 */
function buildPublicNickname(accountType: 'web' | 'qq', userId: number | null, qqNumber: string | null, usersById: Map<number, LeaderboardUserProfile>): string {
  if (accountType === 'web' && userId) return usersById.get(userId)?.username || `用户${userId}`;
  if (accountType === 'qq' && qqNumber) return `QQ用户 ${maskQqNumber(qqNumber)}`;
  return '未知用户';
}

/** 生成排行榜头像：Web 账号优先本地头像，其次已绑定 QQ；未绑定 Bot 用户使用 QQ 头像服务。 */
function buildPublicAvatar(
  accountType: 'web' | 'qq',
  userId: number | null,
  qqNumber: string | null,
  usersById: Map<number, LeaderboardUserProfile>,
): { url: string | null; source: 'web' | 'qq' | 'initial' } {
  if (accountType === 'web' && userId) {
    const profile = usersById.get(userId);
    if (profile?.avatarUrl) return { url: profile.avatarUrl, source: 'web' };
    if (profile?.qqAvatarUrl) return { url: profile.qqAvatarUrl, source: 'qq' };
  }
  if (accountType === 'qq' && qqNumber) return { url: buildQqAvatarUrl(qqNumber), source: 'qq' };
  return { url: null, source: 'initial' };
}

/** 构建 QQ 头像 URL；只用于公开头像展示，不参与钱包、绑定或扣费逻辑。 */
function buildQqAvatarUrl(qqNumber: string): string {
  return `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(qqNumber)}&spec=100`;
}

/** 公开接口允许匿名访问；有有效 JWT 时才追加当前用户排名，失效 token 不让公开榜单报错。 */
function readOptionalUserId(req: IncomingMessage): number | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    const payload = verifyAccessToken(token);
    return payload.sub;
  } catch {
    return undefined;
  }
}

/** QQ 号只展示尾号，公开榜单不返回完整 QQ。 */
function maskQqNumber(value: string): string {
  const tail = value.slice(-4);
  return tail ? `****${tail}` : '****';
}

/** Prisma raw 聚合可能返回 bigint，转换为可空数字。 */
function toNullableNumber(value: bigint | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numeric = toNumber(value);
  return numeric > 0 ? numeric : null;
}

/** Prisma raw 聚合可能返回 bigint，转换为可空字符串。 */
function toNullableString(value: bigint | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? String(Math.floor(numeric)) : null;
}

/** Prisma raw 聚合可能返回 bigint，统一转为安全整数。 */
function toNumber(value: bigint | number | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}
