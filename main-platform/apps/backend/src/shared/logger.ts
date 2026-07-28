/**
 * 结构化日志服务：开发环境使用美化输出，生产环境输出 NDJSON。
 * 替换所有 console.log/warn/error 为 logger.info/warn/error。
 *
 * 用法：
 *   import { logger } from '../shared/logger.js';
 *   logger.info({ userId: 1, action: 'login' }, '用户登录成功');
 *   logger.warn({ siteId: 3, error: 'timeout' }, '上游超时');
 *   logger.error({ err, taskId }, '任务处理失败');
 */
import pino from 'pino';

/** 日志级别：开发 debug，生产 info */
/** 默认 info 级别；debug 仅显示轮询/图片请求，开发排障时设 LOG_LEVEL=debug */
const level = process.env.LOG_LEVEL ?? 'info';

/** 创建 Pino 日志实例 */
export const logger = pino({
  level,
  // 开发环境美化输出
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
  // 生产环境 NDJSON
  formatters: {
    level(label) { return { level: label }; },
  },
  // 基础字段自动添加
  base: {
    service: 'backend',
    env: process.env.NODE_ENV ?? 'development',
  },
  // 时间戳格式
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** 请求日志快捷方法：记录 HTTP 请求 */
export function logRequest(method: string, path: string, statusCode: number, durationMs: number, extra?: Record<string, unknown>) {
  const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  logger[level]({ method, path, statusCode, durationMs, ...extra }, `${method} ${path} ${statusCode} ${durationMs}ms`);
}

/** 创建带请求上下文的子 logger */
export function createRequestLogger(requestId: string) {
  return logger.child({ requestId });
}
