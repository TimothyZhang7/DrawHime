/**
 * 本文件实现 Web 用户公开主页查询，只返回公开资料、公开成功作品和聚合统计。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  UserPublicProfileImage,
  UserPublicProfileResponse,
  UserPublicProfileStats,
  UserPublicProfileUser,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { buildAvatarUrl } from './user-avatar-service.js';

/** 公开主页分页上限，避免单个用户作品页一次拉取过多图片。 */
const MAX_PUBLIC_PROFILE_PAGE_SIZE = 48;
/** 公开主页默认分页大小。 */
const DEFAULT_PUBLIC_PROFILE_PAGE_SIZE = 24;

/** 任务图片配置；真实文件名只信任 Worker 写入的 system_configs.task_image_*。 */
type TaskImageConfig = {
  imageFilename?: string;
  thumbnailFilename?: string;
};

/** 公开主页图片基础行，来自 generation_tasks + system_configs。 */
type UserPublicImageRow = {
  id: string;
  prompt: string;
  mode: string;
  source: string;
  createdAt: Date;
  imageConfig: string;
};

/** 公开主页聚合统计行。 */
type UserPublicStatsRow = {
  publicImageCount: bigint | number | null;
  likeCount: bigint | number | null;
  viewCount: bigint | number | null;
  latestImageAt: Date | string | null;
};

/** 公开主页查询参数。 */
export type UserPublicProfileQuery = {
  /** 页码，从 1 开始。 */
  page: number;
  /** 每页数量。 */
  pageSize: number;
};

/** 用户公开主页服务。 */
export class UserPublicProfileService {
  private readonly prisma: PrismaClient = getPrismaClient();

  /** 查询指定用户公开主页；不存在时返回 null。 */
  async getProfile(userId: number, query: UserPublicProfileQuery): Promise<UserPublicProfileResponse | null> {
    const page = normalizePositiveInteger(query.page, 1);
    const pageSize = Math.min(
      MAX_PUBLIC_PROFILE_PAGE_SIZE,
      Math.max(1, normalizePositiveInteger(query.pageSize, DEFAULT_PUBLIC_PROFILE_PAGE_SIZE)),
    );
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        avatarFilename: true,
        createdAt: true,
        qqBinding: { select: { qqNumber: true, verified: true } },
      },
    });
    if (!user) return null;

    // 公开主页是弱实时读接口：图片、点赞、浏览互不依赖，全部并行降低页面首屏等待。
    const [stats, images] = await Promise.all([
      this.readStats(userId),
      this.readImages(userId, page, pageSize),
    ]);
    const total = stats.publicImageCount;
    return {
      user: buildPublicUser({
        id: user.id,
        username: user.username,
        avatarFilename: user.avatarFilename,
        createdAt: user.createdAt,
        qqNumber: user.qqBinding?.verified ? user.qqBinding.qqNumber?.toString() ?? null : null,
      }),
      stats,
      images,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: (page - 1) * pageSize + images.length < total,
    };
  }

  /** 读取公开成功图片统计；只统计有 task_image 配置的成功公开任务。 */
  private async readStats(userId: number): Promise<UserPublicProfileStats> {
    const rows = await this.prisma.$queryRaw<UserPublicStatsRow[]>(Prisma.sql`
      SELECT
        COUNT(DISTINCT t.id) AS publicImageCount,
        COUNT(DISTINCT il.id) AS likeCount,
        COUNT(DISTINCT iv.id) AS viewCount,
        MAX(t.created_at) AS latestImageAt
      FROM generation_tasks t
      INNER JOIN system_configs c ON c.\`key\` = CONCAT('task_image_', t.id)
      LEFT JOIN image_likes il ON il.image_id = t.id
      LEFT JOIN image_views iv ON iv.image_id = t.id
      WHERE t.user_id = ${userId}
        AND t.status = 'success'
        AND t.is_private = 0
        AND c.value LIKE '%imageFilename%'
    `);
    const row = rows[0];
    return {
      publicImageCount: toNumber(row?.publicImageCount),
      likeCount: toNumber(row?.likeCount),
      viewCount: toNumber(row?.viewCount),
      latestImageAt: row?.latestImageAt ? formatChinaDateTime(new Date(row.latestImageAt)) : null,
    };
  }

  /** 读取当前页公开作品，并补齐点赞、浏览和模型展示字段。 */
  private async readImages(userId: number, page: number, pageSize: number): Promise<UserPublicProfileImage[]> {
    const offset = (page - 1) * pageSize;
    const rows = await this.prisma.$queryRaw<UserPublicImageRow[]>(Prisma.sql`
      SELECT
        t.id,
        t.prompt,
        t.mode,
        t.source,
        t.created_at AS createdAt,
        c.value AS imageConfig
      FROM generation_tasks t
      INNER JOIN system_configs c ON c.\`key\` = CONCAT('task_image_', t.id)
      WHERE t.user_id = ${userId}
        AND t.status = 'success'
        AND t.is_private = 0
        AND c.value LIKE '%imageFilename%'
      ORDER BY t.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const parsedRows = rows
      .map((row) => ({ row, config: parseTaskImageConfig(row.imageConfig) }))
      .filter((item): item is { row: UserPublicImageRow; config: Required<Pick<TaskImageConfig, 'imageFilename'>> & TaskImageConfig } => Boolean(item.config?.imageFilename));
    if (parsedRows.length === 0) return [];

    const taskIds = parsedRows.map((item) => item.row.id);
    const [likeCounts, viewCounts, attemptRows] = await Promise.all([
      this.prisma.imageLike.groupBy({
        by: ['imageId'],
        where: { imageId: { in: taskIds } },
        _count: { imageId: true },
      }),
      this.prisma.imageView.groupBy({
        by: ['imageId'],
        where: { imageId: { in: taskIds } },
        _count: { imageId: true },
      }),
      this.prisma.generationSubTask.findMany({
        where: { taskId: { in: taskIds }, kind: 'upstream_attempt' },
        orderBy: [{ taskId: 'asc' }, { sequence: 'asc' }],
        select: { taskId: true, status: true, model: true },
      }),
    ]);
    const likeMap = new Map(likeCounts.map((item) => [item.imageId, item._count.imageId]));
    const viewMap = new Map(viewCounts.map((item) => [item.imageId, item._count.imageId]));
    const modelMap = new Map<string, string | null>();
    for (const attempt of attemptRows) {
      const current = modelMap.get(attempt.taskId);
      // 成功尝试优先；没有成功尝试时保留第一条带模型记录作为兜底展示。
      if (attempt.status === 'success' || current === undefined) {
        modelMap.set(attempt.taskId, attempt.model ?? null);
      }
    }

    return parsedRows.map(({ row, config }) => ({
      id: row.id,
      prompt: row.prompt.slice(0, 200),
      mode: row.mode,
      source: row.source,
      model: modelMap.get(row.id) ?? null,
      imageUrl: `/images/${config.imageFilename}`,
      thumbnailUrl: config.thumbnailFilename ? `/images/${config.thumbnailFilename}` : `/images/${config.imageFilename}?thumb=1`,
      likeCount: likeMap.get(row.id) ?? 0,
      viewCount: viewMap.get(row.id) ?? 0,
      createdAt: formatChinaDateTime(new Date(row.createdAt)),
    }));
  }
}

/** 构建公开用户资料；QQ 号只用于头像 URL，不作为字段返回。 */
function buildPublicUser(input: {
  id: number;
  username: string;
  avatarFilename: string | null;
  qqNumber: string | null;
  createdAt: Date;
}): UserPublicProfileUser {
  const webAvatar = buildAvatarUrl(input.avatarFilename);
  const qqAvatar = input.qqNumber ? buildQqAvatarUrl(input.qqNumber) : null;
  return {
    id: input.id,
    username: input.username,
    avatarUrl: webAvatar ?? qqAvatar,
    avatarSource: webAvatar ? 'web' : qqAvatar ? 'qq' : 'initial',
    createdAt: formatChinaDateTime(input.createdAt),
  };
}

/** 解析任务图片配置；损坏配置直接跳过，避免公开主页展示断链图片。 */
function parseTaskImageConfig(value: string): TaskImageConfig | null {
  try {
    const parsed = JSON.parse(value) as TaskImageConfig;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.imageFilename !== 'string' || !isSafeMediaFilename(parsed.imageFilename)) return null;
    const thumbnailFilename = typeof parsed.thumbnailFilename === 'string' && isSafeMediaFilename(parsed.thumbnailFilename)
      ? parsed.thumbnailFilename
      : undefined;
    return { imageFilename: parsed.imageFilename, thumbnailFilename };
  } catch {
    return null;
  }
}

/** 构建 QQ 头像 URL；只用于头像回退展示，不暴露完整 QQ 字段。 */
function buildQqAvatarUrl(qqNumber: string): string {
  return `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(qqNumber)}&spec=100`;
}

/** 安全短文件名校验，避免损坏配置构造任意路径。 */
function isSafeMediaFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}

/** 格式化中国时区时间。 */
function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** 转换数据库聚合数字；MySQL COUNT 可能返回 bigint。 */
function toNumber(value: bigint | number | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

/** 读取正整数参数，不合法时使用默认值。 */
function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
