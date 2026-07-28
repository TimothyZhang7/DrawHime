/**
 * 请求日志中间件：按路径分级输出，减少开发刷屏。
 *
 * 日志级别规则：
 *   debug  — 轮询接口（/admin/* /internal/* /generations/tasks）、图片请求（/images/*）
 *   info   — 普通页面请求（/gallery /templates /auth/me /qq/status 等）
 *   warn   — HTTP 4xx
 *   error  — HTTP 5xx
 *
 * debug 级仅 LOG_LEVEL=debug 时可见；生产环境 LOG_LEVEL=info 时静默。
 * 图片请求和轮询请求在 debug 级别下也做合并，每 30s 一条汇总。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';

/** debug 级路径前缀（轮询 + 图片），仅开发调试可见 */
const DEBUG_PREFIXES = [
  '/admin/',
  '/api/generations/tasks',
  '/api/images/',
  '/internal/',
  '/generations/tasks',
  '/images/',
  '/api/wsproxy/my-bots',
  '/wsproxy/my-bots',
  '/api/recharge/shop',
  '/recharge/shop',
];

/** 合并窗口（毫秒），debug 级请求同 key 在此窗口内合并为一条 */
const MERGE_WINDOW_MS = 30000;

/** 待合并计数器 */
const mergeBuckets = new Map<string, { count: number; firstAt: number; lastMs: number; lastStatus: number }>();

function logLevel(path: string, status: number): 'debug' | 'info' | 'warn' | 'error' {
  if (status >= 500) return 'error';
  // 内部轮询/认领接口的 404/409 多为预期探测结果，保留 403 鉴权失败为 warn，避免巡检日志被正常探测淹没。
  if (status >= 400 && path.startsWith('/internal/') && status !== 403) return 'debug';
  if (status >= 400) return 'warn';
  if (DEBUG_PREFIXES.some(p => path.startsWith(p))) return 'debug';
  return 'info';
}

/** 定时刷新合并计数器 */
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of mergeBuckets) {
    if (now - b.firstAt >= MERGE_WINDOW_MS) {
      logger.debug({ merged: true, count: b.count, lastMs: b.lastMs, windowMs: now - b.firstAt }, key);
      mergeBuckets.delete(key);
    }
  }
}, MERGE_WINDOW_MS).unref();

function getRequestId(req: IncomingMessage): string {
  return String(req.headers['x-request-id'] ?? req.headers['x-trace-id'] ?? `req_${Date.now().toString(36)}`);
}

export function createRequestLogger(serviceName: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const start = Date.now();
    const requestId = getRequestId(req);
    const originalEnd = res.end.bind(res);

    res.end = function (...args: Parameters<ServerResponse['end']>) {
      const ms = Date.now() - start;
      const status = res.statusCode;
      const method = req.method ?? 'GET';
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;

      if (path === '/health') return originalEnd(...args);

      const level = logLevel(path, status);

      if (level === 'debug') {
        // debug 级请求合并输出
        const key = `${method} ${path} ${status}`;
        const b = mergeBuckets.get(key);
        if (b) { b.count++; b.lastMs = ms; }
        else mergeBuckets.set(key, { count: 1, firstAt: Date.now(), lastMs: ms, lastStatus: status });
      } else {
        // info/warn/error 级逐条输出
        const meta = { method, path, statusCode: status, durationMs: ms, requestId, service: serviceName };
        if (level === 'warn') logger.warn(meta, `${method} ${path} ${status} ${ms}ms`);
        else if (level === 'error') logger.error(meta, `${method} ${path} ${status} ${ms}ms`);
        else logger.info(meta, `${method} ${path} ${status} ${ms}ms`);
      }
      return originalEnd(...args);
    } as typeof res.end;

    (req as IncomingMessage & { requestId: string }).requestId = requestId;
    next();
  };
}
