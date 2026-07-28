/**
 * 余额服务 — 免费余额 + 付费余额，优先消耗免费余额。
 */
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { WalletService } from '../wallet/wallet-service.js';
import { WalletError } from '../wallet/wallet-types.js';
import { QuotaRepository } from './quota-repository.js';
import { QuotaError } from './quota-types.js';

export class QuotaService {
  private readonly prisma = getPrismaClient();
  private readonly repository = new QuotaRepository(this.prisma);
  private readonly walletService = new WalletService();

  /** 生成前扣费：免费余额优先 → 付费余额（精度：2位小数） */
  async chargeForGeneration(qqNumber: bigint, pricePerGen: number) {
    // 新 QQ 第一次从 Bot 绘图入口进入时也必须获得当天免费额度，否则会因为没有余额行而被误判余额不足。
    await this.ensureDailyFreeBalanceRow(qqNumber);
    const price = Math.round(pricePerGen * 100) / 100;
    const result = await this.repository.deductBalance({ qqNumber, amount: price });
    if (!result) {
      const { freeBalance, paidBalance } = await this.repository.getBalances(qqNumber);
      throw new QuotaError('insufficient_balance',
        `余额不足：需要 ${price.toFixed(2)} 元，免费 ${freeBalance} + 付费 ${paidBalance}`,
        { freeBalance, paidBalance });
    }
    return {
      chargedSource: result.chargedSource,
      chargedAmount: (Math.round((Number(result.freeUsed) + Number(result.paidUsed)) * 100) / 100).toFixed(2),
      freeUsed: result.freeUsed,
      paidUsed: result.paidUsed,
      freeBalance: result.freeBalance,
      paidBalance: result.paidBalance,
    };
  }

  /** 失败退款 */
  async refundForFailedGeneration(qqNumber: bigint, freeAmount: number, paidAmount: number) {
    await this.repository.refundBalance({ qqNumber, freeAmount, paidAmount });
  }

  /** 查询余额 */
  async getBalanceSummary(qqNumber: bigint) {
    // 余额查询是 QQ 用户触达系统的入口之一；这里落库后，后台列表和每日重置才能覆盖该 QQ。
    await this.ensureDailyFreeBalanceRow(qqNumber);
    return this.repository.getBalances(qqNumber);
  }

  /** 管理员调整付费余额（精度：2位小数） */
  async adjustBalance(qqNumber: bigint, amount: number): Promise<string> {
    try {
      return await this.walletService.adjustQqPaidBalance(qqNumber, amount);
    } catch (error) {
      // 管理端旧路由仍按 QuotaError 映射 HTTP 状态，这里只转换错误类型，不吞掉真实异常。
      if (error instanceof WalletError) {
        throw new QuotaError(error.kind === 'insufficient_balance' ? 'insufficient_balance' : 'invalid_request', error.message, error.details);
      }
      throw error;
    }
  }

  /** 首次触达余额系统时创建余额行，已存在用户不会被这个流程重置免费余额。 */
  private async ensureDailyFreeBalanceRow(qqNumber: bigint): Promise<void> {
    const daily = await this.getDailyFreeAmount();
    await this.repository.ensureBalanceRow(qqNumber, daily);
  }

  /** 读取每日免费额度配置；配置异常时保留既有默认值，避免余额入口整体不可用。 */
  async getDailyFreeAmount(): Promise<number> {
    try {
      const row = await this.prisma.systemConfig.findUnique({
        where: { key: 'free_balance_daily' },
        select: { value: true },
      });
      return Math.max(0, Number(row?.value ?? '1.2'));
    } catch {
      return 1.2;
    }
  }
}
