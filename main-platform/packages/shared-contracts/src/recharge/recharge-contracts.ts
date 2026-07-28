/** 本文件定义充值/卡密跨程序接口契约，供 backend、Bot 和前端共享。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';

/** Bot 服务间按 QQ 兑换卡密请求；qqNumber 必须来自 OneBot 事件 user_id。 */
export type BotRechargeRedeemRequest = {
  qqNumber: string;
  code: string;
};

/** 卡密兑换结果；金额用字符串返回，避免跨端小数精度差异。 */
export type RechargeRedeemResponse = {
  /** Bot 兑换时返回 QQ 号；Web 未绑定 QQ 兑换时为空。 */
  qqNumber?: string;
  /** 实际入账的钱包 ID。 */
  walletId?: number;
  amount: string;
  paidBalance: string;
  redeemedAt: string;
};

/** Bot 服务间按 QQ 兑换卡密端点契约。 */
export type BotRechargeRedeemEndpoint = ApiEndpointContract<BotRechargeRedeemRequest, ApiDataResponse<RechargeRedeemResponse>>;
