/**
 * 本文件实现内存限流中间件：按 key 维度 + 滑动窗口计数。
 * 生产环境应替换为 Redis 实现以保证多副本一致性。
 *
 * 使用方式：
 * const limiter = createRateLimiter({ maxRequests: 15, windowMs: 60_000, keyFn: (req) => `login:${ip}` });
 * if (!limiter.check(req)) return 429;
 */
import type { IncomingMessage } from 'node:http';

/** 限流配置 */
type RateLimitConfig = {
  /** 窗口内最大请求数 */
  maxRequests: number;
  /** 窗口毫秒数 */
  windowMs: number;
  /** 从请求中提取限流 key */
  keyFn: (req: IncomingMessage) => string;
};

/** 内存限流存储：key → { count, resetAt } */
const stores = new Map<string, Map<string, { count: number; resetAt: number }>>();

/**
 * 创建限流检查器。
 * 每次请求调用 check()，返回 true 表示放行，false 表示超限。
 */
export function createRateLimiter(config: RateLimitConfig) {
  const storeKey = `${config.maxRequests}:${config.windowMs}`;
  if (!stores.has(storeKey)) stores.set(storeKey, new Map());
  const store = stores.get(storeKey)!;

  // 定期清理过期条目
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, 60_000).unref();

  return {
    check(req: IncomingMessage): boolean {
      const key = config.keyFn(req);
      const now = Date.now();
      const entry = store.get(key);
      if (!entry || now > entry.resetAt) {
        store.set(key, { count: 1, resetAt: now + config.windowMs });
        return true;
      }
      entry.count++;
      return entry.count <= config.maxRequests;
    },
    /** 获取当前窗口剩余次数（用于响应头） */
    remaining(req: IncomingMessage): number {
      const key = config.keyFn(req);
      const entry = store.get(key);
      if (!entry || Date.now() > entry.resetAt) return config.maxRequests;
      return Math.max(0, config.maxRequests - entry.count);
    },
  };
}

/** 预定义限流器 */
export const rateLimiters = {
  /** 登录/注册：15次/分钟/IP */
  login: createRateLimiter({
    maxRequests: 15,
    windowMs: 60_000,
    keyFn: (req) => {
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '0.0.0.0');
      return `login:${ip}`;
    },
  }),

  /** 卡密兑换：10次/分钟/用户（由路由层传入 userId） */
  redeem: createRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    keyFn: (req) => {
      const userId = (req as IncomingMessage & { _userId?: number })._userId ?? 0;
      return `redeem:${userId}`;
    },
  }),

  /** 生成请求：10次/分钟/QQ */
  generate: createRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    keyFn: (req) => {
      const qq = String((req as IncomingMessage & { _qqNumber?: string })._qqNumber ?? '0');
      return `generate:${qq}`;
    },
  }),
};
