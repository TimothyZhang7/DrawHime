/**
 * 本文件生成绘图上游使用的稳定 prompt_cache_key，用于支持网关渠道亲和。
 */
import { createHash } from 'node:crypto';

/** 生成渠道亲和键所需的最小任务身份。 */
export type PromptCacheKeyIdentity = {
  /** 任务来源，用于隔离 Web 与 Bot 身份域。 */
  source: string;
  /** Web 用户 ID。 */
  userId?: number;
  /** Bot 或绑定任务的 QQ 号。 */
  qqNumber?: string;
  /** 无身份任务的稳定请求兜底。 */
  clientRequestId: string;
};

/**
 * 生成不暴露用户标识的稳定渠道亲和键。
 * 同一来源和身份跨任务保持一致，重试与后续请求可继续命中同一上游渠道。
 */
export function buildPromptCacheKey(identity: PromptCacheKeyIdentity): string {
  const source = identity.source.trim().toLowerCase() || 'unknown';
  const qqNumber = identity.qqNumber?.trim();
  const rawIdentity = source === 'web' && Number.isSafeInteger(identity.userId)
    ? `web:user:${identity.userId}`
    : (source === 'bot' || source === 'qq') && qqNumber
      ? `bot:qq:${qqNumber}`
      : Number.isSafeInteger(identity.userId)
        ? `${source}:user:${identity.userId}`
        : qqNumber
          ? `${source}:qq:${qqNumber}`
          : `${source}:request:${identity.clientRequestId.trim()}`;
  const digest = createHash('sha256').update(rawIdentity).digest('hex').slice(0, 32);
  return `aih_v1_${digest}`;
}
