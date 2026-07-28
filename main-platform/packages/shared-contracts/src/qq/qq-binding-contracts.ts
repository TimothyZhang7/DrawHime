/** 本文件定义 QQ 绑定、余额摘要和 Bot 服务间验证绑定的共享契约。 */
import type { ApiDataResponse, ApiMessageResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';
import type { WalletBalanceView } from '../wallet/wallet-contracts.js';

/** QQ 余额摘要；金额用字符串返回，避免小数精度丢失。 */
export type QqBalanceData = {
  qqNumber: string;
  paidBalance: string;
  freeBalance: string;
  /** 可访问总余额；旧调用方可继续自行用 free + paid 计算。 */
  totalBalance?: string;
  /** Bot 入口自己的 QQ 钱包，绑定 Web 后仍然独立存在。 */
  primaryWallet?: WalletBalanceView;
  /** 已绑定 Web 用户钱包；未绑定时为空，不与 QQ 钱包物理合并。 */
  linkedWallet?: WalletBalanceView;
  /** 绑定的 Web 用户 ID，用于 Bot 图片卡片展示身份来源。 */
  linkedUserId?: number;
  /** 绑定的 Web 用户名，用于 Bot 图片卡片展示身份来源。 */
  linkedUsername?: string;
};

/** 生成 QQ 绑定验证码响应。 */
export type QqGenerateKeyResponse = {
  verificationKey: string;
  expiresAt: string;
};

/** 当前用户 QQ 绑定状态响应；未绑定时不返回余额。 */
export type QqBindingStatusResponse = {
  bound: boolean;
  qqNumber?: string;
  balance?: QqBalanceData;
};

/** 用户解绑 QQ 响应；解绑不删除 QQ 余额。 */
export type QqUnbindResponse = {
  unbound: true;
};

/** Bot 服务间验证 QQ 绑定请求，qqNumber 必须来自 OneBot 事件。 */
export type QqVerifyBindingRequest = {
  verificationKey: string;
  qqNumber: string;
};

/** Bot 服务间验证 QQ 绑定成功响应。 */
export type QqVerifyBindingResponse = {
  verified: true;
  qqNumber: string;
  balance: QqBalanceData;
  username?: string;
  userId?: number;
};

/** Bot 服务间查询 QQ 余额请求，qqNumber 必须来自 OneBot 事件。 */
export type QqBalanceQueryRequest = {
  qqNumber: string;
};

/** Bot 服务间查询 QQ 余额响应，直接复用 QQ 余额摘要。 */
export type QqBalanceQueryResponse = QqBalanceData;

/** Bot 服务间登记 QQ 用户触达请求；qqNumber 必须来自 OneBot 事件 user_id。 */
export type QqTouchRequest = {
  qqNumber: string;
};

/** Bot 服务间登记 QQ 用户触达响应；只确认建档，不返回余额细节。 */
export type QqTouchResponse = {
  touched: true;
  qqNumber: string;
};

/** 生成 QQ 绑定验证码端点契约。 */
export type QqGenerateKeyEndpoint = ApiEndpointContract<undefined, ApiDataResponse<QqGenerateKeyResponse>>;

/** 查询当前用户 QQ 绑定状态端点契约。 */
export type QqStatusEndpoint = ApiEndpointContract<undefined, ApiDataResponse<QqBindingStatusResponse>>;

/** 用户解绑 QQ 端点契约。 */
export type QqUnbindEndpoint = ApiEndpointContract<undefined, ApiDataResponse<QqUnbindResponse> | ApiMessageResponse>;

/** Bot 服务间验证 QQ 绑定端点契约。 */
export type QqVerifyBindingEndpoint = ApiEndpointContract<QqVerifyBindingRequest, ApiDataResponse<QqVerifyBindingResponse>>;

/** Bot 服务间查询 QQ 余额端点契约。 */
export type QqBalanceQueryEndpoint = ApiEndpointContract<QqBalanceQueryRequest, ApiDataResponse<QqBalanceQueryResponse>>;

/** Bot 服务间登记 QQ 用户触达端点契约。 */
export type QqTouchEndpoint = ApiEndpointContract<QqTouchRequest, ApiDataResponse<QqTouchResponse>>;
