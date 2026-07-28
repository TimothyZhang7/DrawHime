/** 本文件提供 backend 进程内读穿缓存、singleflight 和主动失效能力。 */
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/** 缓存命中状态，用于响应头和巡查日志。 */
export type BackendCacheStatus = 'hit' | 'miss' | 'stale' | 'bypass';

/** 缓存项配置；tag 用于写接口成功后的主动失效。 */
export type BackendCacheOptions<T> = {
  /** 基础 TTL 毫秒；可按 loader 返回值动态计算。 */
  ttlMs: number | ((value: T) => number);
  /** 该缓存项关联的失效标签。 */
  tags?: string[];
  /** 允许返回过期旧值的毫秒数；只适合图库、统计、配置这类弱实时读取。 */
  staleMs?: number;
  /** 为 true 时跳过缓存，只执行 loader。 */
  bypass?: boolean;
};

/** 缓存读取结果。 */
export type BackendCacheResult<T> = {
  /** 业务数据。 */
  value: T;
  /** 本次读取的缓存状态。 */
  status: BackendCacheStatus;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  staleExpiresAt: number;
  tags: string[];
};

/** backend L1 缓存；当前仅进程内，Redis L2 后续按文档扩展。 */
class BackendCacheService {
  private readonly maxEntries = Math.max(100, Number(process.env.BACKEND_CACHE_MAX_ENTRIES ?? '2000'));
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly flights = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private bypasses = 0;
  private staleHits = 0;
  private backgroundRefreshes = 0;
  private singleflightJoins = 0;

  /** 读穿缓存；同 key 并发 miss 会合并为一次 loader 调用。 */
  async getOrSet<T>(key: string, options: BackendCacheOptions<T>, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
    if (options.bypass || isCacheDisabled()) {
      this.bypasses += 1;
      return { value: await loader(), status: 'bypass' };
    }

    const now = Date.now();
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    if (existing && existing.expiresAt > now) {
      this.hits += 1;
      return { value: existing.value, status: 'hit' };
    }
    if (existing && existing.staleExpiresAt > now) {
      this.staleHits += 1;
      // 弱实时接口允许先返回旧值，并在后台刷新；失败时保留旧值到 stale 窗口结束。
      this.refreshStaleEntry(key, options, loader);
      return { value: existing.value, status: 'stale' };
    }
    if (existing) this.deleteKey(key);

    const inflight = this.flights.get(key) as Promise<T> | undefined;
    if (inflight) {
      this.singleflightJoins += 1;
      this.hits += 1;
      return { value: await inflight, status: 'hit' };
    }

    this.misses += 1;
    const flight = loader();
    this.flights.set(key, flight);
    try {
      const value = await flight;
      const ttlMs = resolveTtl(options.ttlMs, value);
      if (ttlMs > 0) this.set(key, value, ttlMs, options.tags ?? [], options.staleMs ?? 0);
      return { value, status: 'miss' };
    } finally {
      this.flights.delete(key);
    }
  }

  /** 按 tag 主动失效缓存；余额、任务、配置等写接口成功后必须调用。 */
  invalidateTags(tags: string[]): void {
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (!keys) continue;
      for (const key of [...keys]) this.deleteKey(key);
      this.tagIndex.delete(tag);
    }
  }

  /** 按 tag 软失效缓存；有 stale 窗口的弱实时读取会先返回旧值并后台刷新，没有 stale 的项仍会被删除。 */
  softInvalidateTags(tags: string[]): void {
    const now = Date.now();
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (!keys) continue;
      for (const key of [...keys]) {
        const entry = this.entries.get(key);
        if (!entry) continue;
        if (entry.staleExpiresAt > now) {
          entry.expiresAt = Math.min(entry.expiresAt, now - 1);
        } else {
          this.deleteKey(key);
        }
      }
    }
  }

  /** 清空全部缓存；用于巡查或未来管理接口。 */
  clear(): void {
    this.entries.clear();
    this.tagIndex.clear();
    this.flights.clear();
  }

  /** 返回缓存运行统计，方便后端巡查。 */
  getStats() {
    return {
      entries: this.entries.size,
      flights: this.flights.size,
      hits: this.hits,
      misses: this.misses,
      bypasses: this.bypasses,
      staleHits: this.staleHits,
      backgroundRefreshes: this.backgroundRefreshes,
      singleflightJoins: this.singleflightJoins,
      maxEntries: this.maxEntries,
      disabled: isCacheDisabled(),
    };
  }

  private set<T>(key: string, value: T, ttlMs: number, tags: string[], staleMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      const firstKey = this.entries.keys().next().value as string | undefined;
      if (firstKey) this.deleteKey(firstKey);
    }
    const normalizedTags = [...new Set(tags.filter(Boolean))];
    const expiresAt = Date.now() + addJitter(ttlMs);
    this.entries.set(key, { value, expiresAt, staleExpiresAt: expiresAt + Math.max(0, staleMs), tags: normalizedTags });
    for (const tag of normalizedTags) {
      const keys = this.tagIndex.get(tag) ?? new Set<string>();
      keys.add(key);
      this.tagIndex.set(tag, keys);
    }
  }

  private deleteKey(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    for (const tag of entry.tags) {
      const keys = this.tagIndex.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) this.tagIndex.delete(tag);
    }
  }

  private refreshStaleEntry<T>(key: string, options: BackendCacheOptions<T>, loader: () => Promise<T>): void {
    if (this.flights.has(key)) return;
    this.backgroundRefreshes += 1;
    const flight = loader();
    this.flights.set(key, flight);
    flight.then((value) => {
      const ttlMs = resolveTtl(options.ttlMs, value);
      if (ttlMs > 0) this.set(key, value, ttlMs, options.tags ?? [], options.staleMs ?? 0);
    }).catch(() => {
      // 后台刷新失败不影响用户当前响应；下一次请求仍可在 stale 窗口内拿旧值。
    }).finally(() => {
      this.flights.delete(key);
    });
  }
}

/** backend 全局缓存单例；Node 进程内共享。 */
export const backendCache = new BackendCacheService();

let galleryInvalidationHandler: (() => void) | undefined;

/** 写出缓存诊断头；不改变 no-store 动态响应策略。 */
export function setBackendCacheHeader(res: ServerResponse, status: BackendCacheStatus): void {
  if (!res.headersSent) res.setHeader('X-Backend-Cache', status);
}

/** 稳定生成缓存 key 的短哈希，避免把搜索词、token 或长 ID 直接写入 key。 */
export function hashCacheParts(parts: unknown): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex').slice(0, 24);
}

/** 成功写入后清理钱包相关缓存；金额变动宁可粗粒度失效，也不冒余额延迟风险。 */
export function invalidateWalletCache(tags: string[] = []): void {
  backendCache.invalidateTags(['wallet', ...tags]);
}

/** 成功写入后清理任务相关缓存。 */
export function invalidateTaskCache(taskIds: string[] = [], tags: string[] = []): void {
  backendCache.invalidateTags([
    'task-list:admin',
    ...taskIds.flatMap((id) => [`task:${id}`, `admin:generation:${hashCacheParts(id)}`]),
    ...tags,
  ]);
}

/** 成功写入后清理图库相关缓存；新图和标签写入可软失效，删除、隐私和后台管理必须硬失效。 */
export function invalidateGalleryCache(tags: string[] = [], options: { soft?: boolean } = {}): void {
  const allTags = ['gallery', ...tags];
  if (options.soft) backendCache.softInvalidateTags(allTags);
  else backendCache.invalidateTags(allTags);
  // 图库失效后允许业务层注册低优先级补热，不能在缓存层直接依赖图库服务，避免形成模块循环。
  galleryInvalidationHandler?.();
}

/** 注册图库缓存失效后的补热回调；只允许图库模块注册真实读取逻辑。 */
export function setGalleryCacheInvalidationHandler(handler: (() => void) | undefined): void {
  galleryInvalidationHandler = handler;
}

/** 只清理图片详情缓存，不影响图库列表；适合浏览计数这类弱一致写入。 */
export function invalidateImageCache(filenameOrTaskId: string): void {
  backendCache.invalidateTags([`image:${filenameOrTaskId}`]);
}

/** 成功写入用户资料、隐私、绑定或偏好后清理用户级缓存。 */
export function invalidateUserCache(userId: number, tags: string[] = []): void {
  backendCache.invalidateTags([`user:${userId}`, ...tags]);
}

/** 成功写入模板或收藏后清理模板列表和详情缓存。 */
export function invalidateTemplateCache(templateIds: number[] = [], tags: string[] = []): void {
  backendCache.invalidateTags(['template', ...templateIds.map((id) => `template:${id}`), ...tags]);
}

/** 成功写入后清理配置和 Bot 命令缓存。 */
export function invalidateConfigCacheTags(): void {
  backendCache.invalidateTags(['config', 'bot']);
}

/** 成功写入站点或模型选项后清理站点相关缓存，确保用户端模型列表即时刷新。 */
export function invalidateSiteCacheTags(): void {
  backendCache.invalidateTags(['site', 'config']);
}

function resolveTtl<T>(ttlMs: number | ((value: T) => number), value: T): number {
  const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
  return Number.isFinite(ttl) ? Math.max(0, ttl) : 0;
}

function addJitter(ttlMs: number): number {
  const jitter = Math.floor(ttlMs * 0.1 * Math.random());
  return ttlMs + jitter;
}

function isCacheDisabled(): boolean {
  return process.env.BACKEND_CACHE_DISABLED === 'true';
}

function stableStringify(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
