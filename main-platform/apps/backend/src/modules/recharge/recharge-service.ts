/**
 * 本文件实现卡密生成、兑换和批次管理业务用例。
 *
 * 约束：
 * - 卡密只存 SHA-256 哈希，明文只在生成响应和批次文件中出现
 * - 兑换事务：条件更新 status='unused' → 增加对应身份钱包付费余额
 * - 并发防重复兑换：status='unused' 条件保证最多一次成功
 * - Web 兑换归属 user 钱包；Bot 兑换归属 QQ 钱包，绑定只影响共享可见余额
 * - 符合 specs/README.md RCH-001 到 RCH-010
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { WalletService } from '../wallet/wallet-service.js';
import {
  DEFAULT_BATCH_COUNT,
  MAX_BATCH_COUNT,
  SUPPORTED_AMOUNTS,
  RechargeError,
  type GenerateCardsResult,
  type RechargeBatchView,
  type RedeemResult,
} from './recharge-types.js';
import { CONFIG_KEYS, getString } from '../../shared/config/config-service.js';

/** 卡密文件存放目录，相对于 backend 工作目录。 */
const BATCH_DIR = join(process.cwd(), 'modules', 'recharge', 'card-batches');
import { mkdirSync, existsSync } from 'node:fs';
if (!existsSync(BATCH_DIR)) mkdirSync(BATCH_DIR, { recursive: true });

/** 充值服务，负责卡密生成、兑换和批次管理。 */
export class RechargeService {
  private readonly prisma = getPrismaClient();
  private readonly walletService = new WalletService();

  /**
   * 网页卡密兑换：用户输入明文 → SHA-256 → 条件更新 → 增加 user 钱包余额。
   * 任何一步失败都不会部分成功。
   */
  async redeemCard(code: string, userId: number): Promise<RedeemResult> {
    const codeHash = sha256(code.trim().toUpperCase());
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const card = await tx.rechargeCard.findFirst({
        where: { codeHash, status: 'unused' },
        select: { id: true, amount: true },
      });
      if (!card) throw new RechargeError('invalid_request', '卡密无效或已被使用');

      // 条件抢占卡密，避免并发事务都读到 unused 后重复入账。
      const claimed = await tx.rechargeCard.updateMany({
        where: { id: card.id, status: 'unused' },
        data: { status: 'redeeming', redeemedAt: now },
      });
      if (claimed.count !== 1) throw new RechargeError('invalid_request', '卡密无效或已被使用');

      const cardAmount = Number(card.amount);
      const wallet = await this.walletService.addPaidBalanceToUserTx(tx, userId, cardAmount, card.id);
      await tx.rechargeCard.update({
        where: { id: card.id },
        data: {
          status: 'used',
          redeemedById: userId,
          redeemedWalletId: wallet.id,
          redeemedAt: now,
        },
      });

      return {
        amount: cardAmount,
        newBalance: wallet.paidBalance.toFixed(2),
        redeemedAt: now.toISOString(),
        walletId: wallet.id,
      };
    }, {
      isolationLevel: 'ReadCommitted',
      maxWait: 5000,
      timeout: 10000,
    });
  }

  /**
   * QQ 卡密兑换：Bot 用户不需要网页绑定，余额进入 QQ 钱包。
   * 任何一步失败都不会部分成功。
   */
  async redeemCardForQq(code: string, qqNumber: bigint, userId: number | null = null): Promise<RedeemResult> {
    const codeHash = sha256(code.trim().toUpperCase());
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      // 步骤 1：条件更新卡密状态（防并发重复兑换）
      const card = await tx.rechargeCard.findFirst({
        where: { codeHash, status: 'unused' },
        select: { id: true, amount: true },
      });

      if (!card) {
        throw new RechargeError('invalid_request', '卡密无效或已被使用');
      }

      // 条件抢占卡密，避免并发事务都读到 unused 后重复入账。
      const claimed = await tx.rechargeCard.updateMany({
        where: { id: card.id, status: 'unused' },
        data: { status: 'redeeming', redeemedAt: now },
      });
      if (claimed.count !== 1) throw new RechargeError('invalid_request', '卡密无效或已被使用');

      const cardAmount = Number(card.amount);

      // 步骤 2：增加 QQ 钱包付费余额，同时镜像旧 qq_quotas。
      const wallet = await this.walletService.addPaidBalanceToQqTx(tx, qqNumber, cardAmount, card.id);

      // 步骤 3：标记已使用；条件查询已保证并发下最多一个事务能进入这里。
      await tx.rechargeCard.update({
        where: { id: card.id },
        data: {
          status: 'used',
          redeemedById: userId,
          redeemedQq: qqNumber,
          redeemedWalletId: wallet.id,
          redeemedAt: now,
        },
      });

      return {
        amount: cardAmount,
        newBalance: wallet.paidBalance.toFixed(2),
        redeemedAt: now.toISOString(),
        walletId: wallet.id,
      };
    }, {
      isolationLevel: 'ReadCommitted',
      maxWait: 5000,
      timeout: 10000,
    });
  }

  /**
   * 管理员生成卡密批次。
   * 生成随机卡密 → SHA-256 存数据库 → 明文写入批次文件 → 返回明文列表。
   */
  async generateCards(amountInput: number | undefined, countInput: number | undefined, createdById: number): Promise<GenerateCardsResult> {
    const supportedAmounts = await readSupportedAmounts();
    const defaultCount = await readBoundedInt(CONFIG_KEYS.rechargeDefaultBatchCount.key, DEFAULT_BATCH_COUNT, 1, MAX_BATCH_COUNT);
    const maxBatchCount = await readBoundedInt(CONFIG_KEYS.rechargeMaxBatchCount.key, MAX_BATCH_COUNT, 1, 50_000);
    const amount = amountInput ?? supportedAmounts[0] ?? 10;
    const count = countInput ?? defaultCount;
    if (!supportedAmounts.includes(amount)) {
      throw new RechargeError('invalid_request', `不支持的充值额度，仅支持：${supportedAmounts.join('/')} 元`);
    }
    if (count < 1 || count > maxBatchCount) {
      throw new RechargeError('invalid_request', `批次数量必须在 1-${maxBatchCount} 之间`);
    }

    const codes: string[] = [];
    const cardData: { codeHash: string; amount: number; code: string }[] = [];

    // 步骤 1：生成卡密（格式：YUKI-<额度>R-<随机>）
    for (let i = 0; i < count; i++) {
      const code = generateCardCode(amount);
      const codeHash = sha256(code);
      codes.push(code);
      cardData.push({ codeHash, amount, code });
    }

    // 步骤 2：创建批次记录
    const fileName = `batch_${amount}y_${count}x_${Date.now().toString(36)}.txt`;
    const batch = await this.prisma.rechargeBatch.create({
      data: {
        amount,
        count,
        fileName,
        createdById,
      },
    });

    // 步骤 3：批量写入卡密记录（存哈希）
    await this.prisma.rechargeCard.createMany({
      data: cardData.map((c) => ({
        batchId: batch.id,
        amount: c.amount,
        codeHash: c.codeHash,
        status: 'unused',
      })),
    });

    // 步骤 4：写入批次文件（明文）
    const fileContent = codes.join('\n') + '\n';
    await writeFile(join(BATCH_DIR, fileName), fileContent, 'utf8');

    return {
      batch: {
        id: batch.id,
        amount: amount.toFixed(2),
        count,
        usedCount: 0,
        fileName,
        createdByUsername: '', // 由路由层补全用户名
        createdAt: formatChinaDateTime(batch.createdAt),
      },
      codes,
    };
  }

  /** 查询批次列表。 */
  async listBatches(page: number, pageSize: number): Promise<{ items: RechargeBatchView[]; total: number }> {
    const take = Math.min(pageSize || 20, 50);
    const skip = (Math.max(1, page) - 1) * take;

    const [batches, total] = await Promise.all([
      this.prisma.rechargeBatch.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          createdBy: { select: { username: true } },
          _count: { select: { cards: { where: { status: 'used' } } } },
        },
      }),
      this.prisma.rechargeBatch.count(),
    ]);

    return {
      items: batches.map((b) => ({
        id: b.id,
        amount: b.amount.toFixed(2),
        count: b.count,
        usedCount: b._count.cards,
        fileName: b.fileName,
        createdByUsername: b.createdBy.username,
        createdAt: formatChinaDateTime(b.createdAt),
      })),
      total,
    };
  }

  /** 获取批次文件名，用于下载。 */
  async getBatchFileName(batchId: number): Promise<string> {
    const batch = await this.prisma.rechargeBatch.findUnique({
      where: { id: batchId },
      select: { fileName: true },
    });
    if (!batch) throw new RechargeError('not_found', '批次不存在');
    return batch.fileName;
  }

  /** 获取商店 URL 配置。 */
  async getShopUrl(): Promise<string> {
    const config = await this.prisma.systemConfig.findUnique({ where: { key: 'recharge_shop_url' } });
    return config?.value ?? '';
  }
}

/** SHA-256 哈希函数，用于卡密存储。 */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 生成卡密明文：格式 YUKI-<额度>R-<8位随机>。
 * 例如：YUKI-10R-A3B7C9D1
 */
function generateCardCode(amount: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return `YUKI-${amount}R-${random}`;
}

/** 格式化中国时区时间。 */
function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** 从后台配置读取可生成的卡密面额，配置异常时回退到代码默认值。 */
async function readSupportedAmounts(): Promise<number[]> {
  const raw = await getString(CONFIG_KEYS.rechargeSupportedAmounts.key, CONFIG_KEYS.rechargeSupportedAmounts.default);
  const values = raw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.round(item * 100) / 100);
  const unique = [...new Set(values)];
  return unique.length > 0 ? unique : [...SUPPORTED_AMOUNTS];
}

/** 读取整数配置并限制范围，避免后台误填导致一次生成过多卡密。 */
async function readBoundedInt(key: string, fallback: number, min: number, max: number): Promise<number> {
  const raw = await getString(key, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
