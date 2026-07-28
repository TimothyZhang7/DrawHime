/** 本文件封装 backend 对 wsproxy 端点和 Bot 连接表的数据库访问。 */
import type { Prisma, PrismaClient } from '@prisma/client';

/** wsproxy 端点创建输入，tokenHash 必须由服务层先计算完成。 */
export type CreateWsproxyEndpointInput = {
  userId: number;
  pathSuffix: string;
  tokenHash: string;
  expiresAt: Date;
};

/** Bot 活跃登记输入，selfId 使用 bigint 避免 QQ 号超过 JS 安全整数后丢精度。 */
export type MarkBotSeenInput = {
  pathSuffix?: string;
  selfId: bigint;
  nickname?: string;
};

/** wsproxy 仓储只做数据库读写，不包含 token 明文生成或 HTTP 响应拼装。 */
export class WsproxyAdminRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** 创建 wsproxy 动态端点；数据库唯一约束负责兜底防重复。 */
  createEndpoint(input: CreateWsproxyEndpointInput) {
    return this.prisma.wsProxyEndpoint.create({
      data: {
        userId: input.userId,
        pathSuffix: input.pathSuffix,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
      select: endpointSelect,
    });
  }

  /** 查询用户最近创建的端点，用于前端展示当前可用配置。 */
  findLatestEndpointByUserId(userId: number) {
    return this.prisma.wsProxyEndpoint.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: endpointSelect,
    });
  }

  /** 按路径后缀查询端点及所属用户，用于动态 WebSocket 建连校验。 */
  findEndpointForClaim(pathSuffix: string) {
    return this.prisma.wsProxyEndpoint.findUnique({
      where: { pathSuffix },
      select: {
        ...endpointSelect,
        tokenHash: true,
        userId: true,
      },
    });
  }

  /** 标记端点已被使用；成功绑定后的端点可长期复用。 */
  markEndpointUsed(endpointId: number) {
    return this.prisma.wsProxyEndpoint.update({
      where: { id: endpointId },
      data: { used: true },
      select: endpointSelect,
    });
  }

  /** 在短事务中绑定端点 self_id 并更新 Bot 在线状态，避免端点与连接状态不一致。 */
  async markBotSeen(input: MarkBotSeenInput) {
    // wsproxy 心跳/重连可能和消息计数、解绑等同时更新同一 Bot 行；MySQL 1020 属于瞬时并发冲突，短退避重试可避免把在线登记打成 500。
    return withBotConnectionRetry(() => this.prisma.$transaction(async (tx) => {
      const endpoint = input.pathSuffix
        ? await tx.wsProxyEndpoint.findUnique({
          where: { pathSuffix: input.pathSuffix },
          select: { id: true, userId: true, usedBySelfId: true },
        })
        : null;

      // 动态端点已绑定其他 Bot 时拒绝覆盖，防止一个端点被多个 self_id 争抢。
      if (endpoint?.usedBySelfId && endpoint.usedBySelfId !== input.selfId) {
        throw new Error('端点已绑定其他 Bot');
      }

      if (endpoint) {
        await tx.wsProxyEndpoint.update({
          where: { id: endpoint.id },
          data: { used: true, usedBySelfId: input.selfId },
        });
      }

      const updateData: Record<string, unknown> = {
        qqNumber: input.selfId,
        status: 'online',
        lastSeenAt: new Date(),
      };
      if (input.nickname) updateData.nickname = input.nickname;

      await tx.botConnection.upsert({
        where: { selfId: input.selfId },
        update: updateData,
        create: {
          qqNumber: input.selfId,
          selfId: input.selfId,
          status: 'online',
          connectedAt: new Date(),
          lastSeenAt: new Date(),
          nickname: input.nickname ?? '',
        },
      });

      return { accepted: true as const };
    }));
  }
}

/** 端点列表和详情统一字段选择，确保不返回 tokenHash。 */
export const endpointSelect = {
  id: true,
  pathSuffix: true,
  expiresAt: true,
  used: true,
  usedBySelfId: true,
  createdAt: true,
} satisfies Prisma.WsProxyEndpointSelect;

/** 对 Bot 连接状态的瞬时并发写冲突做短重试，避免 wsproxy 高频登记导致 500。 */
async function withBotConnectionRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableBotConnectionError(error) || index === attempts - 1) throw error;
      lastError = error;
      await sleep(25 * (index + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Bot 连接状态更新失败');
}

/** 只重试数据库瞬时并发冲突，业务冲突和鉴权错误保持原样返回。 */
function isRetryableBotConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Record has changed since last read') || message.includes("table 'bot_connections'");
}

/** 简单短退避，避免并发更新持续撞同一行。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
