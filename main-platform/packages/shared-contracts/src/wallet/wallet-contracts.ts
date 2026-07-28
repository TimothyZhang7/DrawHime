/** 本文件定义 Web/QQ 独立钱包、绑定共享余额和扣费摘要的共享契约。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';

/** 钱包拥有者类型；user 表示网页账号，qq 表示 QQ Bot 身份。 */
export type WalletOwnerType = 'user' | 'qq';

/** 单个钱包余额摘要；金额使用字符串避免跨端小数精度丢失。 */
export type WalletBalanceView = {
  /** 钱包 ID，由 backend 生成。 */
  walletId: number;
  /** 钱包归属身份类型。 */
  ownerType: WalletOwnerType;
  /** ownerType=user 时为 userId，ownerType=qq 时为 qqNumber。 */
  ownerKey: string;
  /** 免费余额。 */
  freeBalance: string;
  /** 付费余额。 */
  paidBalance: string;
};

/** 当前登录 Web 用户可访问的钱包和合计余额。 */
export type WalletStatusResponse = {
  /** 当前网页用户自己的 user 钱包。 */
  primaryWallet: WalletBalanceView;
  /** 已绑定 QQ 钱包；未绑定时为空。 */
  linkedWallet?: WalletBalanceView;
  /** 是否已绑定 QQ。 */
  linkedQqNumber?: string;
  /** 可访问钱包的免费余额合计。 */
  freeBalance: string;
  /** 可访问钱包的付费余额合计。 */
  paidBalance: string;
  /** 可访问总余额。 */
  totalBalance: string;
};

/** 钱包流水类型；覆盖免费发放、充值、扣费、退款、后台调整和邀请奖励。 */
export type WalletLedgerType = 'daily_free' | 'recharge' | 'charge' | 'refund' | 'admin_adjust' | 'referral_reward';

/** 钱包流水余额类型；free 为免费余额，paid 为付费余额。 */
export type WalletBalanceKind = 'free' | 'paid';

/** 钱包流水来源；用于前端区分网页、Bot、后台和系统自动行为。 */
export type WalletLedgerSource = 'web' | 'bot' | 'admin' | 'system';

/** 用户可见钱包流水行；仅包含当前用户可访问钱包，不暴露其他身份。 */
export type WalletLedgerEntryView = {
  /** 钱包流水 ID。 */
  id: number;
  /** 钱包 ID。 */
  walletId: number;
  /** 钱包归属身份类型。 */
  ownerType: WalletOwnerType;
  /** 钱包归属身份键。 */
  ownerKey: string;
  /** 钱包展示名称。 */
  walletLabel: string;
  /** 流水业务类型。 */
  type: WalletLedgerType;
  /** 免费或付费余额。 */
  balanceKind: WalletBalanceKind;
  /** 流水来源。 */
  source: WalletLedgerSource;
  /** 流水金额；收入为正，扣费为负。 */
  amount: string;
  /** 本条流水写入后的免费余额。 */
  freeBalanceAfter: string;
  /** 本条流水写入后的付费余额。 */
  paidBalanceAfter: string;
  /** 关联任务 ID。 */
  taskId?: string;
  /** 关联卡密 ID；仅展示 ID，不返回卡密明文或哈希。 */
  rechargeCardId?: number;
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
};

/** 钱包流水筛选条件；全部为空时返回当前用户可访问钱包的完整流水。 */
export type WalletLedgerListQuery = {
  /** 页码，从 1 开始。 */
  page?: number;
  /** 每页数量，后端会限制最大值。 */
  pageSize?: number;
  /** 流水类型筛选。 */
  type?: WalletLedgerType | 'all';
  /** 免费/付费余额筛选。 */
  balanceKind?: WalletBalanceKind | 'all';
  /** 渠道/来源筛选。 */
  source?: WalletLedgerSource | 'all';
  /** 开始日期，格式 YYYY-MM-DD。 */
  dateFrom?: string;
  /** 结束日期，格式 YYYY-MM-DD。 */
  dateTo?: string;
};

/** 当前登录 Web 用户可访问钱包流水分页。 */
export type WalletLedgerListResponse = {
  /** 当前页流水。 */
  items: WalletLedgerEntryView[];
  /** 流水总数。 */
  total: number;
  /** 当前页码。 */
  page: number;
  /** 每页数量。 */
  pageSize: number;
  /** 总页数。 */
  totalPages: number;
};

/** 钱包状态端点契约。 */
export type WalletStatusEndpoint = ApiEndpointContract<undefined, ApiDataResponse<WalletStatusResponse>>;

/** 钱包流水端点契约；GET 查询参数使用 WalletLedgerListQuery。 */
export type WalletLedgerListEndpoint = ApiEndpointContract<WalletLedgerListQuery, ApiDataResponse<WalletLedgerListResponse>>;
