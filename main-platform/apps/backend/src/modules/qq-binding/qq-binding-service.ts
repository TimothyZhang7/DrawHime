/** 本文件实现 QQ 绑定、解绑、余额摘要和 Bot 服务间验证绑定用例。 */
import { randomBytes } from 'node:crypto';
import type {
  QqBalanceData,
  QqBalanceQueryRequest,
  QqBalanceQueryResponse,
  QqBindingStatusResponse,
  QqGenerateKeyResponse,
  QqTouchRequest,
  QqTouchResponse,
  QqUnbindResponse,
  QqVerifyBindingRequest,
  QqVerifyBindingResponse,
} from '@aiimage/shared-contracts';
import { Prisma } from '@prisma/client';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { WalletService } from '../wallet/wallet-service.js';
import { QqBindingRepository } from './qq-binding-repository.js';
import { QqBindingError } from './qq-binding-types.js';

const BINDING_KEY_TTL_MS = 10 * 60 * 1000;

/** QQ 绑定服务负责业务规则和事务编排，路由层只负责鉴权与响应。 */
export class QqBindingService {
  private readonly repository = new QqBindingRepository(getPrismaClient());
  private readonly walletService = new WalletService();

  /** 为当前网页用户生成绑定 key；已绑定用户不能覆盖既有 QQ 关系。 */
  async generateKey(userId: number): Promise<QqGenerateKeyResponse> {
    const existing = await this.repository.findBindingByUserId(userId);
    // 已完成绑定的用户必须先解绑，避免生成新 key 覆盖真实 QQ 关系。
    if (existing?.verified && existing.qqNumber) {
      throw new QqBindingError('already_bound', '当前账号已绑定 QQ，请先解绑后再生成新的绑定验证码');
    }

    // 验证码有唯一约束，极低概率冲突时最多重试 3 次，不能把数据库唯一错误暴露给用户。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const key = createVerificationKey();
      const expiresAt = new Date(Date.now() + BINDING_KEY_TTL_MS);
      try {
        await this.repository.upsertBindingKey({
          userId,
          verificationKey: key,
          keyExpiresAt: expiresAt,
        });
        return {
          verificationKey: key,
          expiresAt: formatChinaDateTime(expiresAt),
        };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || attempt === 3) {
          throw error;
        }
      }
    }

    throw new QqBindingError('internal_error', '生成 QQ 绑定验证码失败');
  }

  /** 查询当前网页用户的 QQ 绑定状态和余额摘要；未绑定时不返回余额。 */
  async getStatus(userId: number): Promise<QqBindingStatusResponse> {
    const binding = await this.repository.findBindingByUserId(userId);
    if (!binding?.verified || !binding.qqNumber) {
      return { bound: false };
    }

    const balance = await this.buildBalanceData(binding.qqNumber);
    return {
      bound: true,
      qqNumber: binding.qqNumber.toString(),
      balance,
    };
  }

  /** 解绑当前网页账号；不删除 QQ 余额和每日用量，保证 Bot 侧余额继续可用。 */
  async unbind(userId: number): Promise<QqUnbindResponse> {
    const binding = await this.repository.findBindingByUserId(userId);
    if (!binding?.verified || !binding.qqNumber) {
      throw new QqBindingError('not_bound', '当前账号尚未绑定 QQ');
    }

    await this.repository.unbindUser(userId, createRetiredVerificationKey());
    return { unbound: true };
  }

  /** Bot 服务间验证绑定 key；QQ 号必须来自 OneBot 事件 user_id。 */
  async verifyBinding(body: QqVerifyBindingRequest): Promise<QqVerifyBindingResponse> {
    const verificationKey = body.verificationKey.trim().toUpperCase();
    const qqNumber = parseQqNumber(body.qqNumber);
    const now = new Date();
    const binding = await this.repository.findActiveBindingByKey(verificationKey, now);
    // 不区分“不存在”和“已过期”，避免 Bot 端枚举有效验证码。
    if (!binding) {
      throw new QqBindingError('key_not_found', '绑定验证码不存在或已过期');
    }

    const existingQqBinding = await this.repository.findVerifiedBindingByQqNumber(qqNumber);
    // 同一个 QQ 已绑定其他网页用户时必须拒绝，避免余额可见权被抢占。
    if (existingQqBinding && existingQqBinding.userId !== binding.userId) {
      throw new QqBindingError('qq_already_bound', '该 QQ 已绑定其他网页账号');
    }

    try {
      const verified = await this.repository.verifyBindingInTransaction(
        binding.id,
        verificationKey,
        qqNumber,
        now,
        0,
      );
      if (!verified) {
        throw new QqBindingError('key_not_found', '绑定验证码不存在或已过期');
      }
    } catch (error) {
      if (error instanceof QqBindingError) throw error;
      // 唯一约束冲突通常来自并发绑定同一 QQ，必须转为可理解的冲突错误。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new QqBindingError('qq_already_bound', '该 QQ 已绑定其他网页账号');
      }
      throw error;
    }

    const user = await this.repository.findUserById(binding.userId);
    return {
      verified: true,
      qqNumber: qqNumber.toString(),
      balance: await this.buildBalanceData(qqNumber),
      username: user?.username ?? undefined,
      userId: binding.userId,
    };
  }

  /** Bot 服务间按 QQ 号查询余额；不要求网页绑定，但会补齐余额行以纳入后台列表和每日重置。 */
  async queryBalance(body: QqBalanceQueryRequest): Promise<QqBalanceQueryResponse> {
    const qqNumber = parseQqNumber(body.qqNumber);
    return this.buildBalanceData(qqNumber);
  }

  /** 构造 QQ 余额摘要 */
  /** Bot 服务间登记 QQ 用户触达；只补齐余额权威行，不重置既有免费/付费余额。 */
  async touchQq(body: QqTouchRequest): Promise<QqTouchResponse> {
    const qqNumber = parseQqNumber(body.qqNumber);
    await this.walletService.getQqBalanceSummary(qqNumber);
    return {
      touched: true,
      qqNumber: qqNumber.toString(),
    };
  }

  private async buildBalanceData(qqNumber: bigint): Promise<QqBalanceData> {
    const quota = await this.walletService.getQqBalanceSummary(qqNumber);
    const binding = quota.linkedWallet ? await this.repository.findVerifiedBindingByQqNumber(qqNumber) : null;
    const user = binding?.userId ? await this.repository.findUserById(binding.userId) : null;
    return {
      qqNumber: qqNumber.toString(),
      paidBalance: quota.paidBalance,
      freeBalance: quota.freeBalance,
      totalBalance: quota.totalBalance,
      // Bot 余额响应带出钱包来源，图片卡片可展示“QQ 钱包 / Web 钱包”互通但不合并的真实结构。
      primaryWallet: quota.primaryWallet,
      linkedWallet: quota.linkedWallet,
      linkedUserId: binding?.userId,
      linkedUsername: user?.username ?? undefined,
    };
  }
}

/** 生成 8 位大写字母数字验证码，满足规范要求的 6-16 位范围。 */
function createVerificationKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

/** 生成解绑后的废弃验证码，配合过期时间让旧 key 立即失效且保持唯一约束。 */
function createRetiredVerificationKey() {
  return `X${randomBytes(7).toString('hex').slice(0, 15).toUpperCase()}`.slice(0, 16);
}

/** 将 QQ 字符串转为 bigint；请求格式已在 validation 中限制为正整数字符串。 */
function parseQqNumber(value: string) {
  try {
    return BigInt(value.trim());
  } catch {
    throw new QqBindingError('invalid_request', 'QQ 号格式不正确');
  }
}

/** 获取中国日期的零点 Date，用于匹配 MySQL DATE 字段。 */
function getChinaDateOnly() {
  const chinaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(chinaNow.getUTCFullYear(), chinaNow.getUTCMonth(), chinaNow.getUTCDate()));
}

/** 将 Date 格式化为 YYYY-MM-DD，避免前端按本地时区二次换算。 */
function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** 将 Date 格式化为中国时区 ISO 字符串，满足 接口时间格式约束。 */
function formatChinaDateTime(date: Date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}
