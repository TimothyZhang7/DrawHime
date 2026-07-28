/** 本文件实现用户邀请关系、邀请码生成和邮箱验证后的双方付费余额奖励。 */
import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ApplyReferralResponse, ReferralMeResponse, VerifyEmailResponse } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { CONFIG_KEYS } from '../../shared/config/config-service.js';
import { WalletService } from '../wallet/wallet-service.js';

/** 邀请业务错误；路由层按 kind 映射 HTTP 状态码。 */
export class ReferralError extends Error {
  constructor(public readonly kind: 'invalid_request' | 'conflict' | 'not_found' | 'disabled', message: string) {
    super(message);
    this.name = 'ReferralError';
  }
}

type TxClient = Prisma.TransactionClient;
type ReferralSource = 'register' | 'recharge' | 'link';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const DEFAULT_MAX_SINGLE_REWARD = 100;

/** 邀请服务只通过 WalletService 写余额，避免绕过钱包流水审计。 */
export class ReferralService {
  private readonly prisma = getPrismaClient();
  private readonly walletService = new WalletService();

  /** 查询充值页邀请模块所需信息，并懒生成当前用户邀请码。 */
  async getMyReferralInfo(userId: number): Promise<ReferralMeResponse> {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.ensureInviteCodeTx(tx, userId);
      const [myReferral, statsRows, user] = await Promise.all([
        tx.userReferral.findUnique({
          where: { inviteeUserId: userId },
          select: {
            status: true,
            inviteCode: true,
            rewardedAt: true,
            inviterUserId: true,
            inviter: { select: { username: true } },
          },
        }),
        tx.userReferral.findMany({
          where: { inviterUserId: userId },
          select: { status: true, inviterRewardAmount: true },
        }),
        tx.user.findUnique({ where: { id: userId }, select: { id: true } }),
      ]);
      if (!user) throw new ReferralError('not_found', '用户不存在');
      const config = await this.readRewardConfigTx(tx);
      const totalReward = statsRows
        .filter((item) => item.status === 'rewarded')
        .reduce((sum, item) => toMoney(sum + toMoney(item.inviterRewardAmount)), 0);
      return {
        inviteCode: code,
        inviteUrl: buildInviteUrl(code, config.inviteUrlTemplate, config.appBaseUrl),
        referralEnabled: config.enabled,
        inviterRewardAmount: config.inviterReward.toFixed(2),
        inviteeRewardAmount: config.inviteeReward.toFixed(2),
        myReferral: myReferral ? {
          status: myReferral.status === 'rewarded' ? 'rewarded' : 'pending_email',
          inviterUsername: myReferral.inviter.username,
          inviterUserId: myReferral.inviterUserId,
          inviteCode: myReferral.inviteCode,
          rewardedAt: myReferral.rewardedAt?.toISOString(),
        } : { status: 'none' },
        stats: {
          totalInvited: statsRows.length,
          rewardedCount: statsRows.filter((item) => item.status === 'rewarded').length,
          pendingCount: statsRows.filter((item) => item.status !== 'rewarded').length,
          totalReward: totalReward.toFixed(2),
        },
      };
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 登录用户使用邀请码；已验证邮箱则立即发奖，否则等待邮箱验证事务触发。 */
  async applyReferralCode(userId: number, rawCode: string, source: ReferralSource = 'recharge'): Promise<ApplyReferralResponse> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { emailVerified: true } });
      const existing = await tx.userReferral.findUnique({
        where: { inviteeUserId: userId },
        select: {
          id: true,
          status: true,
          inviteCode: true,
          inviterRewardAmount: true,
          inviteeRewardAmount: true,
          inviter: { select: { username: true } },
        },
      });
      if (existing) {
        // 已使用过邀请码时直接返回当前状态，避免用户重复点击时把正常流程误判为冲突。
        if (user.emailVerified && existing.status !== 'rewarded') {
          await this.rewardReferralIfEligibleTx(tx, userId);
        }
        const latest = await tx.userReferral.findUniqueOrThrow({
          where: { inviteeUserId: userId },
          select: {
            status: true,
            inviterRewardAmount: true,
            inviteeRewardAmount: true,
            inviter: { select: { username: true } },
          },
        });
        return {
          status: latest.status === 'rewarded' ? 'rewarded' : 'pending_email',
          inviterUsername: latest.inviter.username,
          rewarded: latest.status === 'rewarded',
          inviterRewardAmount: toMoney(latest.inviterRewardAmount).toFixed(2),
          inviteeRewardAmount: toMoney(latest.inviteeRewardAmount).toFixed(2),
        };
      }
      await this.createReferralTx(tx, userId, rawCode, source);
      const reward = user.emailVerified ? await this.rewardReferralIfEligibleTx(tx, userId) : undefined;
      const latest = await tx.userReferral.findUniqueOrThrow({
        where: { inviteeUserId: userId },
        select: {
          status: true,
          inviterRewardAmount: true,
          inviteeRewardAmount: true,
          inviter: { select: { username: true } },
        },
      });
      return {
        status: latest.status === 'rewarded' ? 'rewarded' : 'pending_email',
        inviterUsername: latest.inviter.username,
        rewarded: Boolean(reward?.referralRewarded),
        inviterRewardAmount: toMoney(latest.inviterRewardAmount).toFixed(2),
        inviteeRewardAmount: toMoney(latest.inviteeRewardAmount).toFixed(2),
      };
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 注册事务内绑定邀请码；只创建 pending 关系，不在邮箱验证前发奖。 */
  async createReferralForRegisteredUserTx(tx: TxClient, inviteeUserId: number, rawCode: string | undefined, source: ReferralSource = 'register') {
    if (!rawCode?.trim()) return undefined;
    return this.createReferralTx(tx, inviteeUserId, rawCode, source);
  }

  /** 邮箱验证事务内发放邀请奖励；已经发放过时返回空结果，保证重复验证不重复入账。 */
  async rewardReferralIfEligibleTx(tx: TxClient, inviteeUserId: number): Promise<VerifyEmailResponse | undefined> {
    const config = await this.readRewardConfigTx(tx);
    if (!config.enabled) return undefined;
    const referral = await tx.userReferral.findUnique({
      where: { inviteeUserId },
      select: {
        id: true,
        inviteeUserId: true,
        inviterUserId: true,
        status: true,
        inviterRewardAmount: true,
        inviteeRewardAmount: true,
      },
    });
    if (!referral || referral.status === 'rewarded') return undefined;

    // 关键分支：锁定邀请记录和双方钱包，避免并发验证或手动兑换导致重复奖励。
    await tx.$queryRaw<{ id: number }[]>(Prisma.sql`SELECT id FROM user_referrals WHERE id = ${referral.id} FOR UPDATE`);
    const locked = await tx.userReferral.findUniqueOrThrow({
      where: { id: referral.id },
      select: { id: true, inviteeUserId: true, inviterUserId: true, status: true },
    });
    if (locked.status === 'rewarded') return undefined;

    const inviterReward = config.inviterReward;
    const inviteeReward = config.inviteeReward;
    const now = new Date();
    await this.walletService.addReferralRewardToUserTx(tx, locked.inviterUserId, inviterReward, {
      referralId: locked.id,
      role: 'inviter',
      counterpartyUserId: locked.inviteeUserId,
    });
    await this.walletService.addReferralRewardToUserTx(tx, locked.inviteeUserId, inviteeReward, {
      referralId: locked.id,
      role: 'invitee',
      counterpartyUserId: locked.inviterUserId,
    });
    await tx.userReferral.update({
      where: { id: locked.id },
      data: {
        status: 'rewarded',
        inviterRewardAmount: inviterReward,
        inviteeRewardAmount: inviteeReward,
        rewardedAt: now,
      },
    });
    return {
      message: '邮箱已验证',
      referralRewarded: true,
      inviterRewardAmount: inviterReward.toFixed(2),
      inviteeRewardAmount: inviteeReward.toFixed(2),
    };
  }

  /** 根据邀请码创建邀请关系；每个用户只能有一条关系。 */
  private async createReferralTx(tx: TxClient, inviteeUserId: number, rawCode: string, source: ReferralSource) {
    const config = await this.readRewardConfigTx(tx);
    if (!config.enabled) throw new ReferralError('disabled', '邀请奖励暂未开启');
    const code = normalizeInviteCode(rawCode);
    if (!code) throw new ReferralError('invalid_request', '邀请码格式不正确');

    const existing = await tx.userReferral.findUnique({ where: { inviteeUserId }, select: { id: true } });
    if (existing) throw new ReferralError('conflict', '当前账号已经使用过邀请码');

    const inviteCode = await tx.userInviteCode.findUnique({
      where: { code },
      select: { userId: true, disabledAt: true },
    });
    if (!inviteCode || inviteCode.disabledAt) throw new ReferralError('not_found', '邀请码不存在或已失效');
    if (inviteCode.userId === inviteeUserId) throw new ReferralError('invalid_request', '不能使用自己的邀请码');

    try {
      return await tx.userReferral.create({
        data: {
          inviteeUserId,
          inviterUserId: inviteCode.userId,
          inviteCode: code,
          source,
          status: 'pending_email',
          inviterRewardAmount: config.inviterReward,
          inviteeRewardAmount: config.inviteeReward,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ReferralError('conflict', '当前账号已经使用过邀请码');
      throw error;
    }
  }

  /** 确保用户拥有可展示的邀请码；并发生成冲突时重试。 */
  private async ensureInviteCodeTx(tx: TxClient, userId: number) {
    const existing = await tx.userInviteCode.findUnique({ where: { userId }, select: { code: true } });
    if (existing) return existing.code;
    for (let i = 0; i < 8; i++) {
      const code = generateInviteCode();
      try {
        const created = await tx.userInviteCode.create({ data: { userId, code }, select: { code: true } });
        return created.code;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
    }
    throw new ReferralError('conflict', '邀请码生成失败，请稍后重试');
  }

  /** 读取邀请奖励配置；默认双方各 0.50 元，金额最终仍写入付费余额。 */
  private async readRewardConfigTx(tx: TxClient) {
    const rows = await tx.systemConfig.findMany({
      where: {
        key: {
          in: [
            'referral_enabled',
            'referral_inviter_reward_paid',
            'referral_invitee_reward_paid',
            'referral_max_single_reward_paid',
            'referral_invite_url_template',
            CONFIG_KEYS.appBaseUrl.key,
          ],
        },
      },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const maxSingleReward = clampRewardLimit(map.get('referral_max_single_reward_paid'), DEFAULT_MAX_SINGLE_REWARD);
    return {
      enabled: map.get('referral_enabled') !== 'false',
      maxSingleReward,
      inviterReward: clampRewardAmount(map.get('referral_inviter_reward_paid'), 0.5, maxSingleReward),
      inviteeReward: clampRewardAmount(map.get('referral_invitee_reward_paid'), 0.5, maxSingleReward),
      inviteUrlTemplate: normalizeInviteUrlTemplate(map.get('referral_invite_url_template')),
      appBaseUrl: normalizeAppBaseUrl(map.get(CONFIG_KEYS.appBaseUrl.key)),
    };
  }
}

/** 邀请码归一化；只允许短码，完整链接需要前端解析后传 code。 */
export function normalizeInviteCode(value: string | undefined) {
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(code) ? code : '';
}

function generateInviteCode() {
  return Array.from(randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function clampRewardAmount(value: string | undefined, fallback: number, max: number) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.min(max, toMoney(numeric));
}

function clampRewardLimit(value: string | undefined, fallback: number) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(10000, toMoney(numeric));
}

function normalizeInviteUrlTemplate(value: string | undefined) {
  const template = String(value ?? '').trim();
  if (!template) return '';
  return template.slice(0, 500);
}

function buildInviteUrl(code: string, template: string, appBaseUrl: string) {
  // 后台可配置完整 URL 或相对路径模板；必须包含 {code} 才按模板替换，否则回退到稳定注册链接。
  const encoded = encodeURIComponent(code);
  const fallback = `${appBaseUrl}/login?tab=register&invite=${encoded}`;
  if (!template.includes('{code}')) return fallback;
  const replaced = template.replaceAll('{code}', encoded);
  if (/^https?:\/\//i.test(replaced)) return replaced;
  if (replaced.startsWith('/')) return `${appBaseUrl}${replaced}`;
  return fallback;
}

function toMoney(value: number | string | Prisma.Decimal) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : value.toNumber();
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) / 100;
}

/** 邀请链接使用后台 app_base_url；没有配置时才回退环境变量和生产域名。 */
function normalizeAppBaseUrl(value: string | undefined) {
  return (value || process.env.APP_BASE_URL || 'https://www.xanime.ink').replace(/\/+$/, '');
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
