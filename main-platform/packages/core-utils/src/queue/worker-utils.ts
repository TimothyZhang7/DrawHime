/** 本文件提供 Worker 任务相关的纯函数工具，不含数据库或 HTTP 依赖。 */
import { randomBytes } from 'node:crypto';

/**
 * 生成幂等任务键，格式为 domain:action:uniqueId。
 * 调用方传入领域和动作，由工具函数生成稳定后缀。
 */
export function createIdempotencyKey(domain: string, action: string, uniqueId: string): string {
  const safeDomain = domain.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const safeAction = action.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const safeId = uniqueId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `${safeDomain}:${safeAction}:${safeId}`;
}

/**
 * 生成任务唯一 ID，使用时间戳和随机数避免冲突。
 */
export function createTaskId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex');
  return `${prefix}_${ts}_${rand}`.slice(0, 64);
}

/**
 * 判断错误是否可重试。
 * 网络错误、超时、临时服务不可用可重试；参数错误、资源不存在不可重试。
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const retryablePatterns = [
    // 英文网络/超时错误
    'econnrefused', 'enotfound', 'econnreset', 'etimedout', 'econnaborted',
    'abort', 'timeout', 'socket hang up', 'network',
    '429', '502', '503', '504',
    'connection', 'fetch failed', 'eai_again', 'temporarily', 'unavailable',
    // 中文超时/网络错误模式
    '超时', '网络', '连接失败', '无法连接', '拒绝连接',
    '地址无法解析', '暂时不可用', '服务不可用', '上游',
  ];
  return retryablePatterns.some((pattern) => message.includes(pattern));
}

/**
 * 判断错误是否不可重试，参数错误和资源不存在等情况必须直接失败。
 */
export function isNonRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const nonRetryablePatterns = [
    'quota_insufficient',
    'insufficient_balance',
    'not found',
    'not_bound',
    'forbidden',
    'unauthorized',
    'bad request',
    'invalid',
    'model_text_only',
    'model_edit_only',
    'prohibited_content',
    'content_filter',
    'safety filter',
    'safety_filter',
    'policy violation',
    'content policy',
    'request blocked',
    'prompt',
    'reference image',
    'qq number',
    // 中文不可重试错误
    '额度不足', '余额不足', '缺少 prompt', 'prompt 不能为空', 'prompt 过长',
    '参考图最多支持', '参考图数据无效', '缺少有效的 qq',
    '内容审核', '安全策略', '违规内容',
  ];
  return nonRetryablePatterns.some((pattern) => message.includes(pattern));
}

/**
 * 将任意错误转为结构化错误消息，避免日志中出现 undefined。
 */
export function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知错误';
}
