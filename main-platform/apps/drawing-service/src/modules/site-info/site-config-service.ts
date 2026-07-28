/**
 * 本文件实现站点配置加载服务：从 backend 拉取 api_sites 配置并缓存。
 *
 * 约束：
 * - 站点配置缓存 30 秒，管理台修改后主动失效
 * - 站点 API Key 只在本服务内使用，不向调用方暴露
 * - backend 不可用时返回最后缓存，缓存为空的返回空列表
 * - 符合 specs/README.md DRAW-010 到 DRAW-017
 */
import type { ApiSiteRuntimeConfig, ApiSiteRuntimeConfigResponse } from '@aiimage/shared-contracts';

/** 缓存站点配置的数据结构。 */
type CachedSiteConfig = {
  sites: RawSiteConfig[];
  fetchedAt: number;
};

/** backend 返回的原始站点配置复用跨服务共享契约。 */
type RawSiteConfig = ApiSiteRuntimeConfig;

/** 缓存 TTL 毫秒（并发场景需快速感知站点状态变更）。 */
const CACHE_TTL_MS = 10_000;

/** 站点配置加载服务，带内存缓存。 */
export class SiteConfigService {
  private cache: CachedSiteConfig | null = null;
  /** backend 内部地址。 */
  private readonly backendUrl: string;

  constructor(backendUrl?: string) {
    this.backendUrl = backendUrl ?? process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  }

  /**
   * 获取所有站点配置（优先缓存）。
   * 缓存过期或为空时从 backend 重新拉取。
   */
  async getSites(): Promise<RawSiteConfig[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.sites;
    }
    try {
      const sites = await this.fetchSitesFromBackend();
      this.cache = { sites, fetchedAt: Date.now() };
      return sites;
    } catch {
      // backend 不可用时返回最后缓存
      return this.cache?.sites ?? [];
    }
  }

  /** 管理台修改站点后立即失效缓存。 */
  invalidateCache(): void {
    this.cache = null;
  }

  /** 从 backend 管理接口拉取站点配置。 */
  private async fetchSitesFromBackend(): Promise<RawSiteConfig[]> {
    const response = await fetch(`${this.backendUrl}/internal/sites/config`, {
      headers: {
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`backend 返回错误：${response.status}`);
    }

    const data = (await response.json()) as Partial<ApiSiteRuntimeConfigResponse>;
    return data.data?.sites ?? [];
  }

  /**
   * 获取启用的站点列表（过滤 isEnabled=true）。
   * 用于 drawing-worker 的站点选择候选。
   */
  async getEnabledSites(): Promise<RawSiteConfig[]> {
    const sites = await this.getSites();
    return sites.filter((s) => s.isEnabled);
  }
}

/** 全局单例站点配置服务。 */
export const siteConfigService = new SiteConfigService();
