/** 本文件负责校验 QQ 绑定相关请求体，接口类型来源于/standards/interfaces/qq-binding.md。 */
import type { QqBalanceQueryRequest, QqTouchRequest, QqVerifyBindingRequest } from '@aiimage/shared-contracts';

/** 校验 QQ 绑定验证码格式，避免异常长字符串进入数据库查询。 */
export function isValidVerificationKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{6,16}$/.test(value.trim());
}

/** 校验 QQ 号格式；QQ 号来自 OneBot user_id，必须是正整数数字字符串。 */
export function isValidQqNumber(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{4,19}$/.test(value.trim());
}

/** 校验 Bot 服务间 QQ 绑定请求体。 */
export function validateQqVerifyBindingRequest(body: unknown): body is QqVerifyBindingRequest {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Partial<QqVerifyBindingRequest>;
  return isValidVerificationKey(candidate.verificationKey) && isValidQqNumber(candidate.qqNumber);
}

/** 校验 Bot 服务间 QQ 余额查询请求体，查询接口只接受 OneBot 事件中的 QQ 号。 */
export function validateQqBalanceQueryRequest(body: unknown): body is QqBalanceQueryRequest {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Partial<QqBalanceQueryRequest>;
  return isValidQqNumber(candidate.qqNumber);
}

/** 校验 Bot 服务间 QQ 触达建档请求体；触达只接受 OneBot 事件 user_id。 */
export function validateQqTouchRequest(body: unknown): body is QqTouchRequest {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Partial<QqTouchRequest>;
  return isValidQqNumber(candidate.qqNumber);
}
