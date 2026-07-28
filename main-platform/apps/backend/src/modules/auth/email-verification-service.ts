/**
 * 本文件实现邮箱验证和密码重置业务用例。
 *
 * 约束：
 * - 验证 token 和重置 token 只存 SHA-256 哈希
 * - 发送邮件通过 notification-worker 异步投递
 * - 防用户枚举：忘记密码/重发验证对所有输入返回相同文案
 * - 发送冷却：1 分钟间隔 + 每邮箱 3 次/10 分钟
 * - 符合 specs/README.md AUTH-013 到 AUTH-022
 */
import { createHash, randomBytes } from 'node:crypto';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import type { VerifyEmailResponse } from '@aiimage/shared-contracts';
import { getAppBaseUrl } from '../../shared/config/config-service.js';
import { ReferralService } from '../referral/referral-service.js';

type EmailVerificationResult = VerifyEmailResponse & { userId: number };

/** 邮箱验证 token 有效期（24 小时）。 */
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** 密码重置 token 有效期（24 小时）。 */
const RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** 邮箱验证服务。 */
export class EmailVerificationService {
  private readonly prisma = getPrismaClient();
  private readonly referralService = new ReferralService();

  /**
   * 生成邮箱验证 token 并存储哈希。
   * @returns 明文 token（用于构造验证链接）
   */
  async createVerificationToken(userId: number): Promise<string> {
    const token = generateToken();
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

    // 清理该用户的旧验证 token
    await this.prisma.emailVerification.deleteMany({ where: { userId } });

    await this.prisma.emailVerification.create({
      data: { userId, tokenHash, expiresAt },
    });

    return token;
  }

  /**
   * 验证邮箱 token。
   * @param token 用户点击链接中的明文 token
   * @returns 是否验证成功
   */
  async verifyEmail(token: string): Promise<EmailVerificationResult | null> {
    const tokenHash = sha256(token);
    const now = new Date();

    const record = await this.prisma.emailVerification.findFirst({
      where: { tokenHash, expiresAt: { gt: now } },
    });

    if (!record) return null;

    // 事务中验证邮箱、删除已使用 token，并触发邀请奖励；跨设备验证只依赖数据库邀请关系。
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerified: true },
      });
      await tx.emailVerification.delete({ where: { id: record.id } });
      const reward = await this.referralService.rewardReferralIfEligibleTx(tx, record.userId);
      return { ...(reward ?? { message: '邮箱已验证' }), userId: record.userId };
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });

    return result;
  }

  /**
   * 已登录用户重发验证邮件。
   * 旧 token 全部失效，生成新 token。
   */
  async resendVerification(userId: number): Promise<{ token: string; email: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerified: true },
    });
    if (!user) throw new VerificationError('not_found', '用户不存在');
    if (user.emailVerified) throw new VerificationError('invalid_request', '邮箱已验证');
    if (isPlaceholderEmail(user.email)) throw new VerificationError('invalid_request', '当前未绑定邮箱，请先绑定邮箱');

    const token = await this.createVerificationToken(userId);
    return { token, email: user.email };
  }

  /**
   * 生成密码重置 token 并存储哈希。
   * 无论邮箱是否注册都返回相同提示（防用户枚举）。
   */
  async createPasswordResetToken(email: string): Promise<{ token: string; userId: number } | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true, email: true },
    });
    if (!user) return null;
    if (isPlaceholderEmail(user.email)) return null;

    const token = generateToken();
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    // 清理旧重置 token
    await this.prisma.passwordReset.deleteMany({ where: { userId: user.id } });
    await this.prisma.passwordReset.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    return { token, userId: user.id };
  }

  /**
   * 重置密码：验证 token → 更新密码哈希 → 删除已用 token。
   */
  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const tokenHash = sha256(token);
    const now = new Date();

    const record = await this.prisma.passwordReset.findFirst({
      where: { tokenHash, expiresAt: { gt: now } },
    });

    if (!record) return false;

    const { hashPassword } = await import('./password.js');
    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      }),
      this.prisma.passwordReset.delete({ where: { id: record.id } }),
    ]);

    return true;
  }

  /**
   * 通知 Worker 发送验证邮件。
   * 当前阶段直接调用 notification-worker HTTP 接口。
   */
  async notifyVerificationEmail(email: string, token: string): Promise<void> {
    // 邮件链接使用后台 app_base_url，避免生产域名调整后仍沿用启动环境变量。
    const appBaseUrl = await getAppBaseUrl();
    const verifyUrl = `${appBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;
    await this.sendEmailNotification(email, 'verification', verifyUrl, `email:verify:${sha256(token).slice(0, 16)}`);
  }

  /**
   * 通知 Worker 发送密码重置邮件。
   */
  async notifyPasswordResetEmail(email: string, token: string): Promise<void> {
    // 密码重置链接同样读取后台配置，保证后台面板配置真实生效。
    const appBaseUrl = await getAppBaseUrl();
    const resetUrl = `${appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.sendEmailNotification(email, 'password-reset', resetUrl, `email:reset:${sha256(token).slice(0, 16)}`);
  }

  /** 调用 notification-worker 内部接口发送邮件。 */
  private async sendEmailNotification(to: string, type: string, url: string, idempotencyKey: string): Promise<void> {
    const workerUrl = process.env.NOTIFICATION_WORKER_URL ?? 'http://localhost:3015';
    try {
      await fetch(`${workerUrl}/internal/send-email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
        },
        body: JSON.stringify({ to, type, url, idempotencyKey }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[backend] [EMAIL] 通知 Worker 发送邮件失败: to=${to} type=${type} error=${msg}`);
    }
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** 内部占位邮箱只用于满足数据库唯一必填约束，不能用于发验证或重置邮件。 */
function isPlaceholderEmail(email: string): boolean {
  return email.toLowerCase().endsWith('@unbound.aiimage.local');
}

export class VerificationError extends Error {
  constructor(public readonly kind: 'not_found' | 'invalid_request' | 'expired', message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}
