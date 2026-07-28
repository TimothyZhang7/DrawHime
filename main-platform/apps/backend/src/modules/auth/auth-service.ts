/** 本文件实现认证用例，HTTP 请求/响应类型规范见/standards/interfaces/auth.md。 */

import type { AuthServiceSession, AuthUser, LoginRequest, RegisterRequest, UserRole } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { hashPassword, verifyPassword } from './password.js';
import { signAccessToken } from './jwt.js';
import { ReferralService } from '../referral/referral-service.js';
import { buildAvatarUrl } from '../users/user-avatar-service.js';

const UNBOUND_EMAIL_DOMAIN = 'unbound.aiimage.local';

/** 认证服务只返回领域对象，不直接拼 HTTP 响应，避免业务层伪造接口结构。 */
export class AuthService {
  private readonly prisma = getPrismaClient();
  private readonly referralService = new ReferralService();

  /** 注册用户并签发会话；首个用户自动获得 admin 角色，重复用户名或邮箱会抛出冲突错误。 */
  async register(body: RegisterRequest): Promise<AuthServiceSession> {
    const passwordHash = await hashPassword(body.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const exists = await tx.user.findFirst({
        where: { OR: [{ username: body.username }, { email: body.email }] },
        select: { id: true },
      });
      // 注册必须先查重，避免唯一约束错误直接暴露为 500。
      if (exists) throw new Error('用户名或邮箱已存在');

      // 用户表为空时，首个注册者自动获得 admin 角色。
      const userCount = await tx.user.count();
      const role = userCount === 0 ? 'admin' : 'user';

      const created = await tx.user.create({
        data: {
          username: body.username.trim(),
          email: body.email.trim().toLowerCase(),
          passwordHash,
          role,
        },
        select: userSelect,
      });
      // 注册邀请码只绑定邀请关系，奖励必须等邮箱验证事务成功后才发放。
      await this.referralService.createReferralForRegisteredUserTx(tx, created.id, body.inviteCode, 'register');
      return created;
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
    return { user: mapCurrentUser(user), token: await signAccessToken({ sub: user.id, role: normalizeUserRole(user.role) }) };
  }

  /** 校验账号密码并签发会话；错误信息保持模糊，避免账号枚举。 */
  async login(body: LoginRequest): Promise<AuthServiceSession> {
    const account = body.account.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: body.account.trim() }, { email: account }] },
      select: { ...userSelect, passwordHash: true },
    });
    // 登录失败统一返回同一中文错误，避免泄露账号是否存在。
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new Error('账号或密码错误');
    }
    return { user: mapCurrentUser(user), token: await signAccessToken({ sub: user.id, role: normalizeUserRole(user.role) }) };
  }

  /** 查询当前用户资料，路由层负责把结果包装为 CurrentUserResponse。 */
  async currentUser(userId: number): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user) throw new Error('用户不存在');
    return mapCurrentUser(user);
  }

  /** 已登录用户修改密码：验证旧密码 → 更新为新密码哈希。 */
  async changePassword(userId: number, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user) throw new Error('用户不存在');
    if (!(await verifyPassword(oldPassword, user.passwordHash))) {
      throw new Error('旧密码不正确');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword) },
    });
  }

  /** 绑定新的未验证邮箱；只允许未验证或未绑定邮箱账号修改，避免绕过已验证邮箱的账号安全边界。 */
  async bindEmail(userId: number, email: string): Promise<AuthUser> {
    const normalizedEmail = normalizeRealEmail(email);
    if (!normalizedEmail) throw new AuthEmailError('invalid_email', '邮箱格式不正确');
    const user = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, emailVerified: true },
      });
      if (!current) throw new AuthEmailError('not_found', '用户不存在');
      // 已验证邮箱不可在此接口直接替换，后续如做换绑必须增加二次验证流程。
      if (current.emailVerified) throw new AuthEmailError('verified_email', '邮箱已验证，不能直接换绑');
      const exists = await tx.user.findFirst({
        where: { email: normalizedEmail, id: { not: userId } },
        select: { id: true },
      });
      if (exists) throw new AuthEmailError('email_conflict', '邮箱已被其他账号使用');
      await tx.emailVerification.deleteMany({ where: { userId } });
      await tx.passwordReset.deleteMany({ where: { userId } });
      return tx.user.update({
        where: { id: userId },
        data: { email: normalizedEmail, emailVerified: false },
        select: userSelect,
      });
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
    return mapCurrentUser(user);
  }

  /** 解绑未验证邮箱；数据库仍写入内部占位邮箱，对外表现为未绑定，避免破坏 users.email 唯一必填约束。 */
  async unbindUnverifiedEmail(userId: number): Promise<AuthUser> {
    const user = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, emailVerified: true },
      });
      if (!current) throw new AuthEmailError('not_found', '用户不存在');
      if (current.emailVerified) throw new AuthEmailError('verified_email', '邮箱已验证，不能解绑');
      if (isPlaceholderEmail(current.email)) throw new AuthEmailError('email_unbound', '当前未绑定邮箱');
      // 邮箱解绑是账号关键分支：只清理邮箱验证和重置 token，不触碰用户余额、QQ 绑定、任务或邀请关系。
      await tx.emailVerification.deleteMany({ where: { userId } });
      await tx.passwordReset.deleteMany({ where: { userId } });
      return tx.user.update({
        where: { id: userId },
        data: { email: buildPlaceholderEmail(userId), emailVerified: false },
        select: userSelect,
      });
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
    return mapCurrentUser(user);
  }
}

const userSelect = {
  id: true,
  username: true,
  email: true,
  role: true,
  emailVerified: true,
  avatarFilename: true,
  qqBinding: { select: { qqNumber: true, verified: true } },
} as const;

/** 将 Prisma 用户记录转换为共享契约中的 AuthUser，避免路由层重复拼字段。 */
function mapCurrentUser(user: {
  id: number;
  username: string;
  email: string;
  role: string;
  emailVerified: boolean;
  avatarFilename: string | null;
  qqBinding: { qqNumber: bigint | null; verified: boolean } | null;
}): AuthUser {
  const qqNumber = user.qqBinding?.verified && user.qqBinding.qqNumber
    ? user.qqBinding.qqNumber.toString()
    : undefined;
  const emailBound = !isPlaceholderEmail(user.email);
  return {
    id: user.id,
    username: user.username,
    email: emailBound ? user.email : '',
    emailBound,
    role: normalizeUserRole(user.role),
    emailVerified: emailBound && user.emailVerified,
    qqNumber,
    avatarUrl: buildAvatarUrl(user.avatarFilename),
  };
}

/** 归一化数据库角色字符串，防止脏值扩散到 JWT 和接口响应。 */
function normalizeUserRole(role: string): UserRole {
  return role === 'admin' ? 'admin' : 'user';
}

/** 生成内部占位邮箱；只用于满足数据库必填唯一约束，不作为真实邮箱外显或发信目标。 */
function buildPlaceholderEmail(userId: number): string {
  return `unbound_${userId}@${UNBOUND_EMAIL_DOMAIN}`;
}

/** 判断邮箱是否为内部占位邮箱，避免验证码、重置邮件或前端资料把它当成真实邮箱。 */
function isPlaceholderEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${UNBOUND_EMAIL_DOMAIN}`);
}

/** 归一化用户输入的新邮箱；禁止用户提交内部占位域。 */
function normalizeRealEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '';
  if (isPlaceholderEmail(value)) return '';
  return value;
}

export class AuthEmailError extends Error {
  constructor(public readonly kind: 'not_found' | 'invalid_email' | 'email_conflict' | 'verified_email' | 'email_unbound', message: string) {
    super(message);
    this.name = 'AuthEmailError';
  }
}
