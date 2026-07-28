/**
 * 本文件实现管理后台用户管理业务用例：列表、详情、角色编辑、删除。
 * 所有操作需要 admin 角色，由路由层校验。
 */
import { Prisma } from '@prisma/client';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { AdminError } from './admin-sites-service.js';

/** 用户列表查询参数。 */
type UserListQuery = {
  page: number;
  pageSize: number;
  search?: string;
  role?: string;
  bound?: string;
};

/** 管理端钱包摘要，用于展示 Web 钱包和 QQ 钱包的独立余额来源。 */
type AdminWalletSummary = {
  walletId: number;
  ownerType: 'user' | 'qq';
  ownerKey: string;
  label: string;
  freeBalance: string;
  paidBalance: string;
  totalBalance: string;
};

/** 管理端用户视图，含绑定、钱包聚合和统计信息。 */
type AdminUserView = {
  id: number;
  username: string;
  email: string;
  role: string;
  emailVerified: boolean;
  qqNumber: string | null;
  freeBalance: string;
  paidBalance: string;
  totalBalance: string;
  wallets: AdminWalletSummary[];
  taskCount?: number;
  templateCount?: number;
  createdAt: string;
};

/** 管理端用户详情。 */
type AdminUserDetail = AdminUserView & {
  generationCount: number;
  attemptCount: number;
};

/** 用户管理服务。 */
export class AdminUserService {
  private readonly prisma = getPrismaClient();

  /** 分页查询用户列表，支持搜索和筛选。 */
  async listUsers(query: UserListQuery) {
    const take = Math.min(query.pageSize || 20, 50);
    const skip = (Math.max(1, query.page) - 1) * take;

    const where: Prisma.UserWhereInput = {};
    if (query.search) {
      const search = query.search.trim();
      const or: Prisma.UserWhereInput[] = [
        { username: { contains: search } },
        { email: { contains: search } },
      ];
      if (/^\d+$/.test(search)) {
        // QQ 号搜索只有纯数字时才转 BigInt，避免管理员搜索邮箱或用户名时抛运行时异常。
        or.push({ qqBinding: { qqNumber: BigInt(search) } });
      }
      where.OR = or;
    }
    if (query.role) where.role = query.role;
    if (query.bound === 'true') where.qqBinding = { isNot: null };
    if (query.bound === 'false') where.qqBinding = { is: null };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true, username: true, email: true, role: true, emailVerified: true, createdAt: true,
          qqBinding: { select: { qqNumber: true } },
          _count: { select: { generationTasks: true, templates: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const walletMap = await this.loadAccessibleWalletMap(users.map((u) => ({
      id: u.id,
      qqNumber: u.qqBinding?.qqNumber ?? null,
    })));

    return {
      items: users.map((u) => {
        const qq = u.qqBinding?.qqNumber?.toString() ?? null;
        const wallets = walletMap.get(u.id) ?? [];
        const total = sumWallets(wallets);
        return {
          id: u.id,
          username: u.username,
          email: u.email,
          role: u.role,
          emailVerified: u.emailVerified,
          qqNumber: qq,
          paidBalance: total.paidBalance,
          freeBalance: total.freeBalance,
          totalBalance: total.totalBalance,
          wallets,
          taskCount: u._count.generationTasks,
          templateCount: u._count.templates,
          createdAt: formatChinaDateTime(u.createdAt),
        };
      }),
      total,
      page: query.page,
      pageSize: take,
    };
  }

  /** 获取用户详情，含余额和统计。 */
  async getUserDetail(userId: number): Promise<AdminUserDetail | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        emailVerified: true,
        createdAt: true,
        qqBinding: { select: { qqNumber: true } },
        _count: { select: { generationTasks: true, templates: true } },
      },
    });
    if (!user) return null;

    const walletMap = await this.loadAccessibleWalletMap([{ id: user.id, qqNumber: user.qqBinding?.qqNumber ?? null }]);
    const wallets = walletMap.get(user.id) ?? [];
    const total = sumWallets(wallets);

    // 统计任务尝试次数
    const attemptCount = await this.prisma.generationSubTask.count({
      where: { task: { userId }, kind: 'upstream_attempt' },
    });

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified,
      qqNumber: user.qqBinding?.qqNumber?.toString() ?? null,
      paidBalance: total.paidBalance,
      freeBalance: total.freeBalance,
      totalBalance: total.totalBalance,
      wallets,
      generationCount: user._count.generationTasks,
      templateCount: user._count.templates,
      attemptCount,
      createdAt: formatChinaDateTime(user.createdAt),
    };
  }

  /** 通用更新用户信息。 */
  async updateUser(userId: number, input: { email?: string; username?: string; emailVerified?: boolean }): Promise<AdminUserView> {
    const data: Record<string, unknown> = {};
    if (input.email !== undefined) data.email = input.email;
    if (input.username !== undefined) data.username = input.username;
    if (input.emailVerified !== undefined) data.emailVerified = input.emailVerified;
    if (Object.keys(data).length === 0) throw new AdminError('invalid_request', '没有可更新的字段');

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, username: true, email: true, role: true, emailVerified: true, createdAt: true,
        qqBinding: { select: { qqNumber: true } } },
    });
    const walletMap = await this.loadAccessibleWalletMap([{ id: user.id, qqNumber: user.qqBinding?.qqNumber ?? null }]);
    const wallets = walletMap.get(user.id) ?? [];
    const total = sumWallets(wallets);
    return { id: user.id, username: user.username, email: user.email, role: user.role,
      emailVerified: user.emailVerified, qqNumber: user.qqBinding?.qqNumber?.toString() ?? null,
      freeBalance: total.freeBalance, paidBalance: total.paidBalance, totalBalance: total.totalBalance, wallets,
      createdAt: formatChinaDateTime(user.createdAt) };
  }

  /** 编辑用户角色。 */
  async updateRole(userId: number, role: 'admin' | 'user'): Promise<AdminUserView> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { role },
      select: {
        id: true, username: true, email: true, role: true,
        emailVerified: true, createdAt: true,
        qqBinding: { select: { qqNumber: true } },
      },
    });
    const walletMap = await this.loadAccessibleWalletMap([{ id: user.id, qqNumber: user.qqBinding?.qqNumber ?? null }]);
    const wallets = walletMap.get(user.id) ?? [];
    const total = sumWallets(wallets);
    return {
      id: user.id, username: user.username, email: user.email,
      role: user.role, emailVerified: user.emailVerified,
      qqNumber: user.qqBinding?.qqNumber?.toString() ?? null,
      freeBalance: total.freeBalance,
      paidBalance: total.paidBalance,
      totalBalance: total.totalBalance,
      wallets,
      createdAt: formatChinaDateTime(user.createdAt),
    };
  }

  /** 删除用户（软删除标记，不物理删除）。 */
  async deleteUser(userId: number): Promise<void> {
    // 当前阶段用邮箱添加 deleted_ 前缀做软删除标记
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        email: `deleted_${Date.now()}_${userId}@deleted.local`,
        username: `deleted_${userId}`,
      },
    });
  }

  /** 批量读取用户当前可访问的钱包：Web 自有钱包 + active 绑定的 QQ 钱包。 */
  private async loadAccessibleWalletMap(users: Array<{ id: number; qqNumber: bigint | null }>): Promise<Map<number, AdminWalletSummary[]>> {
    if (users.length === 0) return new Map();
    const userIds = users.map((user) => user.id);
    const activeLinks = await this.prisma.walletLink.findMany({
      where: { status: 'active', userId: { in: userIds } },
      select: { userId: true, qqNumber: true, activeUserKey: true, activeQqKey: true },
    });
    const qqKeys = new Set<string>();
    for (const user of users) if (user.qqNumber) qqKeys.add(user.qqNumber.toString());
    for (const link of activeLinks) qqKeys.add(link.qqNumber.toString());

    const wallets = await this.prisma.wallet.findMany({
      where: {
        OR: [
          { ownerType: 'user', ownerKey: { in: userIds.map(String) } },
          ...(qqKeys.size > 0 ? [{ ownerType: 'qq', ownerKey: { in: [...qqKeys] } }] : []),
        ],
      },
      select: { id: true, ownerType: true, ownerKey: true, freeBalance: true, paidBalance: true },
    });
    const walletByIdentity = new Map(wallets.map((wallet) => [`${wallet.ownerType}:${wallet.ownerKey}`, wallet]));
    const linkByUserId = new Map(activeLinks.map((link) => [link.userId, link]));
    const result = new Map<number, AdminWalletSummary[]>();
    for (const user of users) {
      const items: AdminWalletSummary[] = [];
      const userWallet = walletByIdentity.get(`user:${user.id}`);
      if (userWallet) items.push(toWalletSummary(userWallet, '网页钱包'));
      const linkedQq = linkByUserId.get(user.id)?.qqNumber ?? user.qqNumber;
      const qqWallet = linkedQq ? walletByIdentity.get(`qq:${linkedQq.toString()}`) : undefined;
      if (qqWallet) items.push(toWalletSummary(qqWallet, `QQ 钱包 ${linkedQq?.toString() ?? ''}`.trim()));
      result.set(user.id, items);
    }
    return result;
  }
}

function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** 将钱包记录转换为后台展示结构，金额统一保留两位小数。 */
function toWalletSummary(wallet: { id: number; ownerType: string; ownerKey: string; freeBalance: Prisma.Decimal; paidBalance: Prisma.Decimal }, label: string): AdminWalletSummary {
  const free = Math.max(0, wallet.freeBalance.toNumber());
  const paid = Math.max(0, wallet.paidBalance.toNumber());
  return {
    walletId: wallet.id,
    ownerType: wallet.ownerType === 'qq' ? 'qq' : 'user',
    ownerKey: wallet.ownerKey,
    label,
    freeBalance: free.toFixed(2),
    paidBalance: paid.toFixed(2),
    totalBalance: (free + paid).toFixed(2),
  };
}

/** 汇总用户可访问钱包余额；列表和详情共用，避免 Web/QQ 双端口径不一致。 */
function sumWallets(wallets: AdminWalletSummary[]) {
  const total = wallets.reduce((acc, wallet) => ({
    free: acc.free + Number(wallet.freeBalance),
    paid: acc.paid + Number(wallet.paidBalance),
  }), { free: 0, paid: 0 });
  return {
    freeBalance: total.free.toFixed(2),
    paidBalance: total.paid.toFixed(2),
    totalBalance: (total.free + total.paid).toFixed(2),
  };
}
