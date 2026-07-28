/** 本文件定义钱包模块内部输入、输出和错误类型，不直接暴露数据库模型。 */

/** 钱包参与方，web 表示网页账号，bot 表示 QQ Bot 入口。 */
export type WalletActor = 'web' | 'bot';

/** 钱包拥有者类型，必须与 shared-contracts 的 WalletOwnerType 保持一致。 */
export type WalletOwnerType = 'user' | 'qq';

/** 生成扣费输入；taskId 必须是已在同一事务中创建的主任务 ID。 */
export type WalletChargeInput = {
  actor: WalletActor;
  userId?: number;
  qqNumber?: bigint;
  taskId: string;
  amount: number;
  source: 'web' | 'bot';
};

/** 钱包扣费结果，供生成任务旧字段和 Bot 返回卡片兼容使用。 */
export type WalletChargeResult = {
  chargedSource: 'free' | 'paid' | 'mixed';
  chargedAmount: string;
  freeUsed: string;
  paidUsed: string;
  freeBalance: string;
  paidBalance: string;
};

/** 钱包模块错误，路由层按 kind 映射 HTTP 状态码。 */
export class WalletError extends Error {
  constructor(
    /** 错误类别：余额不足、参数错误或绑定冲突。 */
    public readonly kind: 'insufficient_balance' | 'invalid_request' | 'conflict',
    message: string,
    /** 附加数据，如余额不足时的当前余额。 */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}
