/** Redis 客户端 — 用于分布式站点并发计数，支持多 Worker 实例协同。Redis 不可用时降级为内存计数。 */
import { Redis } from 'ioredis';

let redisInstance: Redis | null = null;

/** 获取 Redis 客户端单例，连接失败返回 null。 */
export function getRedisClient(): Redis | null {
  if (redisInstance) return redisInstance;
  try {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    redisInstance = new Redis(url, {
      keyPrefix: (process.env.REDIS_KEY_PREFIX ?? 'aiimage:v3') + ':',
      commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? '300'),
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? '1000'),
      maxRetriesPerRequest: Number(process.env.REDIS_MAX_RETRIES ?? '1'),
      lazyConnect: true,
    });
    redisInstance.on('error', () => {
      redisInstance?.disconnect();
      redisInstance = null; // 降级为 null
    });
    return redisInstance;
  } catch {
    return null;
  }
}

/** 读取 Redis 当前分钟站点计数；失败时返回 null，由调用方降级内存。 */
export async function getSiteMinute(siteId: number): Promise<number | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `worker:site:${siteId}:minute:${minuteBucket}`;
    const value = await redis.get(key);
    return Number.parseInt(value ?? '0', 10) || 0;
  } catch {
    return null;
  }
}

/** Redis 原子占用当前分钟站点配额；undefined 表示 Redis 不可用，null 表示超过宽容硬上限。 */
export async function tryAcquireSiteMinute(siteId: number, allowedConcurrency: number): Promise<number | null | undefined> {
  const redis = getRedisClient();
  if (!redis) return undefined;
  try {
    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `worker:site:${siteId}:minute:${minuteBucket}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 120); // 120 秒后自动清理
    if (allowedConcurrency > 0 && count > allowedConcurrency) {
      // 超过站点当前分钟宽容硬上限时撤销本次占用，避免探测失败也污染分钟桶。
      await redis.decr(key);
      return null;
    }
    return count;
  } catch {
    return undefined;
  }
}
