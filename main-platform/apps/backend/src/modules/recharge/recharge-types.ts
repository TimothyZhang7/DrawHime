/**
 * 本文件定义充值模块的共享类型和错误类。
 */

/** 充值业务错误，路由层按 kind 映射为 HTTP 状态码。 */
export class RechargeError extends Error {
  constructor(
    public readonly kind: 'invalid_request' | 'not_bound' | 'not_found' | 'forbidden' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'RechargeError';
  }
}

/** 支持的充值额度列表，单位元。 */
export const SUPPORTED_AMOUNTS = [5, 10, 25, 50, 100, 150] as const;

/** 默认每批卡密数量。 */
export const DEFAULT_BATCH_COUNT = 100;

/** 最大每批卡密数量。 */
export const MAX_BATCH_COUNT = 1000;

/** 批次视图。 */
export type RechargeBatchView = {
  id: number;
  amount: string;
  count: number;
  usedCount: number;
  fileName: string;
  createdByUsername: string;
  createdAt: string;
};

/** 兑换结果。 */
export type RedeemResult = {
  amount: number;
  newBalance: string;
  redeemedAt: string;
  walletId?: number;
};

/** 生成卡密结果。 */
export type GenerateCardsResult = {
  batch: RechargeBatchView;
  codes: string[];
};

/** 充值总览。 */
export type RechargeOverview = {
  totalIssued: string;
  totalRedeemed: string;
  totalUnused: string;
  redeemedUserCount: number;
  recentRedeems: unknown[];
  trend: { date: string; issued: string; redeemed: string }[];
  batchStats: RechargeBatchView[];
};
