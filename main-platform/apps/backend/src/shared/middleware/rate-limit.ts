/**
 * 限流工具：所有限流参数从数据库 system_configs 读取，管理后台可实时调整。
 * 环境变量仅用于开发兜底，生产环境应通过管理面板配置。
 *
 * 配置来源：CONFIG_KEYS 中的 rate_limit_* 系列，持久化在 system_configs 表。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { sendJson } from '@aiimage/core-utils';
import { getString, CONFIG_KEYS } from '../config/config-service.js';

/** 内存计数器存储 */
const stores = new Map<string, Map<string, { count: number; resetAt: number }>>();

/** 定期清理过期条目 */
setInterval(() => {
  const now = Date.now();
  for (const store of stores.values()) {
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }
}, 60_000).unref();

/** 限流维度 → 数据库配置键（从 system_configs 读取，env 兜底） */
const LIMIT_KEYS: Record<string, { maxKey: string; maxDefault: string; windowKey: string; windowDefault: string }> = {
  login:     { maxKey: CONFIG_KEYS.rateLimitLoginMax.key,         maxDefault: CONFIG_KEYS.rateLimitLoginMax.default,
               windowKey: CONFIG_KEYS.rateLimitLoginWindowMs.key,   windowDefault: CONFIG_KEYS.rateLimitLoginWindowMs.default },
  register:  { maxKey: CONFIG_KEYS.rateLimitRegisterMax.key,       maxDefault: CONFIG_KEYS.rateLimitRegisterMax.default,
               windowKey: CONFIG_KEYS.rateLimitRegisterWindowMs.key, windowDefault: CONFIG_KEYS.rateLimitRegisterWindowMs.default },
  redeem:    { maxKey: CONFIG_KEYS.rateLimitRedeemMax.key,          maxDefault: CONFIG_KEYS.rateLimitRedeemMax.default,
               windowKey: CONFIG_KEYS.rateLimitRedeemWindowMs.key,   windowDefault: CONFIG_KEYS.rateLimitRedeemWindowMs.default },
  forgotPwd: { maxKey: CONFIG_KEYS.rateLimitForgotPwdMax.key,       maxDefault: CONFIG_KEYS.rateLimitForgotPwdMax.default,
               windowKey: CONFIG_KEYS.rateLimitForgotPwdWindowMs.key, windowDefault: CONFIG_KEYS.rateLimitForgotPwdWindowMs.default },
  resendVerify: { maxKey: CONFIG_KEYS.rateLimitResendVerifyMax.key,       maxDefault: CONFIG_KEYS.rateLimitResendVerifyMax.default,
               windowKey: CONFIG_KEYS.rateLimitResendVerifyWindowMs.key,   windowDefault: CONFIG_KEYS.rateLimitResendVerifyWindowMs.default },
  resendVerifyEmail: { maxKey: CONFIG_KEYS.rateLimitResendVerifyEmailMax.key,       maxDefault: CONFIG_KEYS.rateLimitResendVerifyEmailMax.default,
               windowKey: CONFIG_KEYS.rateLimitResendVerifyEmailWindowMs.key,   windowDefault: CONFIG_KEYS.rateLimitResendVerifyEmailWindowMs.default },
};

/**
 * 检查请求是否超限。超限时自动发送 429 并返回 false。
 * 限流参数从数据库读取，管理后台修改后 60 秒内生效。
 */
export async function checkRateLimit(req: IncomingMessage, res: ServerResponse, limitKey: string): Promise<boolean> {
  const keys = LIMIT_KEYS[limitKey];
  if (!keys) return true; // 未知限流类型直接放行

  // 限流属于安全边界，必须异步读取 system_configs，不能只依赖启动时环境变量兜底。
  const maxRequests = Number.parseInt(await getString(keys.maxKey, keys.maxDefault), 10);
  const windowMs = Number.parseInt(await getString(keys.windowKey, keys.windowDefault), 10);

  if (!stores.has(limitKey)) stores.set(limitKey, new Map());
  const store = stores.get(limitKey)!;
  const key = extractKey(req, limitKey);
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  if (entry.count <= maxRequests) return true;

  sendJson(res, 429, { ok: false, code: ApiErrorCode.RateLimited, message: '操作过于频繁，请稍后再试' });
  return false;
}

function extractKey(req: IncomingMessage, prefix: string): string {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '0.0.0.0');
  return `${prefix}:${ip.split(',')[0].trim()}`;
}
