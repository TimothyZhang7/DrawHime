/** 本文件封装 QQ 绑定与 QQ 余额相关数据库访问，业务判断保留在 service 层。 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { WalletService } from '../wallet/wallet-service.js';

const walletService = new WalletService();

/** QQ 绑定验证码写入输入；验证码明文只作为短期绑定凭据保存。 */
export type UpsertQqBindingKeyInput = {
  userId: number;
  verificationKey: string;
  keyExpiresAt: Date;
};

/** QQ 绑定仓储只做 Prisma 读写，不拼 HTTP 响应，不校验服务间 token。 */
export class QqBindingRepository {
  /** 注入 Prisma 单例，确保请求内不会创建新的数据库连接池。 */
  constructor(private readonly prisma: PrismaClient) {}

  /** 查询用户当前绑定摘要，用于生成 key 前判断和状态页展示。 */
  findBindingByUserId(userId: number) {
    return this.prisma.qqBinding.findUnique({
      where: { userId },
      select: qqBindingSelect,
    });
  }

  /** 查询指定 QQ 是否已被其他用户绑定，用于给服务层做冲突提示。 */
  findVerifiedBindingByQqNumber(qqNumber: bigint) {
    return this.prisma.qqBinding.findUnique({
      where: { qqNumber },
      select: qqBindingSelect,
    });
  }

  /** 按用户 ID 查询用户名（用于 Bot 绑定验证响应）。 */
  findUserById(userId: number) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
  }

  /** 写入或替换当前用户的待验证 key；已绑定状态由服务层先拦截。 */
  upsertBindingKey(input: UpsertQqBindingKeyInput) {
    return this.prisma.qqBinding.upsert({
      where: { userId: input.userId },
      update: {
        verificationKey: input.verificationKey,
        keyExpiresAt: input.keyExpiresAt,
        verified: false,
        qqNumber: null,
      },
      create: {
        userId: input.userId,
        verificationKey: input.verificationKey,
        keyExpiresAt: input.keyExpiresAt,
        verified: false,
      },
      select: qqBindingSelect,
    });
  }

  /** 查询未过期验证码记录；服务层负责判断不存在时返回中文业务错误。 */
  findActiveBindingByKey(verificationKey: string, now: Date) {
    return this.prisma.qqBinding.findFirst({
      where: {
        verificationKey,
        verified: false,
        keyExpiresAt: { gt: now },
      },
      select: qqBindingSelect,
    });
  }

  /** 在短事务中完成 QQ 绑定和余额行初始化，避免绑定成功但余额行缺失。 */
  async verifyBindingInTransaction(bindingId: number, verificationKey: string, qqNumber: bigint, now: Date, initialFreeBalance = 0) {
    return this.prisma.$transaction(async (tx) => {
      // 绑定更新必须带验证码、未验证和未过期条件，防止并发请求用旧查询结果覆盖新绑定。
      const updated = await tx.qqBinding.updateMany({
        where: {
          id: bindingId,
          verificationKey,
          verified: false,
          keyExpiresAt: { gt: now },
        },
        data: {
          qqNumber,
          verified: true,
        },
      });
      if (updated.count !== 1) return null;

      const binding = await tx.qqBinding.findUniqueOrThrow({
        where: { id: bindingId },
        select: qqBindingSelect,
      });

      // 余额行必须在同一事务内 upsert；新 QQ 使用当天免费额度初始化，解绑和重复绑定都不能重置既有余额。
      const quota = await tx.qqQuota.upsert({
        where: { qqNumber },
        update: {},
        create: {
          qqNumber,
          freeBalance: Math.max(0, initialFreeBalance),
          paidBalance: '0.00',
        },
        select: qqQuotaSelect,
      });
      // QQ 绑定和钱包共享关系必须同事务完成，避免绑定成功但余额不可共享。
      await walletService.linkUserAndQqTx(tx, binding.userId, qqNumber);

      return { binding, quota };
    });
  }

  /** 查询 QQ 余额；旧状态接口的只读路径已迁移到 QuotaService，这里仅保留仓储能力。 */
  findQuotaByQqNumber(qqNumber: bigint) {
    return this.prisma.qqQuota.findUnique({
      where: { qqNumber },
      select: qqQuotaSelect,
    });
  }

  /** 解绑只清除网页绑定关系并废弃旧 key，不删除 QQ 余额。 */
  async unbindUser(userId: number, retiredVerificationKey: string) {
    return this.prisma.$transaction(async (tx) => {
      const binding = await tx.qqBinding.update({
        where: { userId },
        data: {
          verified: false,
          qqNumber: null,
          verificationKey: retiredVerificationKey,
          keyExpiresAt: new Date(0),
        },
        select: qqBindingSelect,
      });
      // 解绑只关闭共享关系，不移动 user/qq 两个钱包的余额。
      await walletService.unlinkUserTx(tx, userId);
      return binding;
    });
  }
}

/** QQ 绑定统一字段选择，避免把无关用户字段带入服务层。 */
export const qqBindingSelect = {
  id: true,
  userId: true,
  qqNumber: true,
  verified: true,
  verificationKey: true,
  keyExpiresAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.QqBindingSelect;

/** QQ 余额统一字段选择；金额由服务层转换为字符串响应。 */
export const qqQuotaSelect = {
  qqNumber: true,
  paidBalance: true,
  freeBalance: true,
  updatedAt: true,
} satisfies Prisma.QqQuotaSelect;
