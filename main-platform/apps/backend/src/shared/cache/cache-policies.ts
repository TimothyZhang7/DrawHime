/**
 * 本文件集中管理 backend 读取接口的缓存策略。
 *
 * 路由层只负责鉴权、参数解析和响应；缓存 key、TTL、tag、动态终态判断都在这里维护，
 * 避免各业务文件散落硬编码缓存规则。
 */
import { backendCache, hashCacheParts, type BackendCacheResult } from './cache-service.js';
import type { LeaderboardRange, PublicStatusRange, UserTaskLeaderboardKind } from '@aiimage/shared-contracts';

/** 任务轮询缓存值的最小结构，用于根据运行状态动态选择 TTL。 */
export type TaskPollingCacheValue = {
  /** 任务列表；运行中任务必须短 TTL，终态任务可以稍长 TTL。 */
  tasks: Array<{ status?: string }>;
};

/** 缓存当前 Web 用户钱包状态；余额写入通过 wallet/user tag 主动失效。 */
export function cacheWebWalletStatus<T>(userId: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`wallet:web:${userId}`, { ttlMs: 1000, tags: ['wallet', `user:${userId}`] }, loader);
}

/** 缓存用户任务分页列表；创建、状态变化、删除和隐私修改会失效该用户任务列表。 */
export function cacheUserGenerationList<T>(userId: number, query: unknown, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(
    `generations:user:${userId}:${hashCacheParts(query)}`,
    // “我的记录”是分页列表，实时状态由 /api/generations/tasks 负责；列表适度延长 TTL 可显著减少重复分页查询。
    { ttlMs: 5000, tags: [`task-list:user:${userId}`] },
    loader,
  );
}

/** 缓存前台任务轮询；运行中任务 1 秒内刷新，纯终态任务延长到 30 秒。 */
export function cacheUserTasks<T extends TaskPollingCacheValue>(userId: number, taskIds: string[], loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  const sortedIds = sortIds(taskIds);
  return backendCache.getOrSet(
    `tasks:user:${userId}:${hashCacheParts(sortedIds)}`,
    {
      ttlMs: (value) => hasOnlyTerminalTasks(value.tasks) ? 30_000 : 1000,
      tags: [`task-list:user:${userId}`, ...sortedIds.map((id) => `task:${id}`)],
    },
    loader,
  );
}

/** 缓存 Bot 内部任务轮询；不带用户权限边界，但必须包含完整任务 ID 集合。 */
export function cacheInternalTasks<T extends TaskPollingCacheValue>(taskIds: string[], loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  const sortedIds = sortIds(taskIds);
  return backendCache.getOrSet(
    `tasks:internal:${hashCacheParts(sortedIds)}`,
    {
      ttlMs: (value) => hasOnlyTerminalTasks(value.tasks) ? 30_000 : 1000,
      tags: ['task-list:admin', ...sortedIds.map((id) => `task:${id}`)],
    },
    loader,
  );
}

/** 缓存公开图库基础列表；不包含当前用户点赞态，因此所有访问者可共享同一份图库缓存。 */
export function cacheGalleryList<T>(query: unknown, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(
    `gallery:list:${hashCacheParts(query)}`,
    // 图库首屏允许短时间返回旧列表并后台刷新；新图、隐私、删除仍通过 gallery tag 主动失效。
    { ttlMs: 30_000, staleMs: 120_000, tags: ['gallery'] },
    loader,
  );
}

/** 缓存公开图库热门标签；打标写入、新图、隐私变化和删除都会随 gallery tag 失效。 */
export function cacheGalleryPopularTags<T>(limit: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(
    `gallery:popular-tags:${limit}`,
    { ttlMs: 60_000, staleMs: 180_000, tags: ['gallery'] },
    loader,
  );
}

/** 缓存图库详情；按 viewer 区分权限和点赞状态。 */
export function cacheImageDetail<T>(filename: string, viewerUserId: number | undefined, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(
    `image:detail:${hashCacheParts({ filename, viewer: viewerUserId ?? 0 })}`,
    { ttlMs: 5000, tags: ['gallery', `image:${filename}`] },
    loader,
  );
}

/** 缓存系统配置全集。 */
export function cacheConfigAll<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('config:all', { ttlMs: 30_000, tags: ['config'] }, loader);
}

/** 缓存单个系统配置项。 */
export function cacheConfigItem<T>(key: string, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`config:item:${hashCacheParts(key)}`, { ttlMs: 30_000, tags: ['config'] }, loader);
}

/** 缓存 AI 绘图配置。 */
export function cacheAiImageConfig<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('config:ai-image', { ttlMs: 30_000, tags: ['config'] }, loader);
}

/** 缓存用户端工具配置；后台工具设置保存后随 config tag 失效。 */
export function cacheToolsConfig<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('config:tools', { ttlMs: 30_000, tags: ['config'] }, loader);
}

/** 缓存 Worker/Bot 运行时绘图配置。 */
export function cacheDrawingRuntimeConfig<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('config:drawing-runtime', { ttlMs: 30_000, tags: ['config'] }, loader);
}

/** 缓存用户端公开绘图配置；返回形状不同于内部运行时配置，必须独立 key。 */
export function cachePublicDrawingConfig<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('config:drawing-public', { ttlMs: 30_000, tags: ['config'] }, loader);
}

/** 缓存全站公开外观配置；后台上传、删除或切换开关后随 config tag 失效。 */
export function cacheSiteAppearance<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('config:site-appearance', { ttlMs: 30_000, tags: ['config'] }, loader);
}

/** 缓存 Bot 命令配置。 */
export function cacheBotCommandConfigs<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('admin:command-configs', { ttlMs: 30_000, tags: ['config', 'bot'] }, loader);
}

/** 缓存 Bot 内部运行命令配置；返回形状不同于管理端配置，必须使用独立 key。 */
export function cacheInternalBotCommands<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('bot:commands', { ttlMs: 30_000, tags: ['config', 'bot'] }, loader);
}

/** 缓存可用绘图模型列表；站点或配置变化时失效。 */
export function cacheDrawingModels<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('drawing:models', { ttlMs: 60_000, tags: ['config', 'site'] }, loader);
}

/** 缓存充值商店配置；卡密兑换结果不缓存。 */
export function cacheRechargeShop<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('config:recharge-shop', { ttlMs: 30_000, tags: ['config'] }, loader);
}

/** 缓存当前用户模板列表；模板 CRUD 和收藏变化会失效 template tag。 */
export function cacheUserTemplateList<T>(userId: number, query: unknown, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(
    `templates:user:${userId}:${hashCacheParts(query)}`,
    { ttlMs: 15_000, tags: ['template', `user:${userId}`] },
    loader,
  );
}

/** 缓存模板详情；按 viewer 区分私有模板权限和收藏状态。 */
export function cacheTemplateDetail<T>(templateId: number, viewerUserId: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(
    `template:detail:${templateId}:viewer:${viewerUserId}`,
    { ttlMs: 15_000, tags: ['template', `template:${templateId}`, `user:${viewerUserId}`] },
    loader,
  );
}

/** 缓存用户资料；资料、QQ 绑定和邮箱状态变化后按 user tag 失效。 */
export function cacheUserProfile<T>(userId: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`user:profile:${userId}`, { ttlMs: 10_000, tags: [`user:${userId}`] }, loader);
}

/** 缓存当前登录用户摘要；前端启动会高频调用 /auth/me，资料或绑定变化按 user tag 失效。 */
export function cacheCurrentUser<T>(userId: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`auth:me:${userId}`, { ttlMs: 3000, tags: [`user:${userId}`] }, loader);
}

/** 缓存用户隐私偏好；隐私开关和 QQ 绑定变化后按 user tag 失效。 */
export function cacheUserPrivacy<T>(userId: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`user:privacy:${userId}`, { ttlMs: 5000, tags: [`user:${userId}`] }, loader);
}

/** 缓存当前用户背景图显示偏好；用户修改后按 user tag 立即失效。 */
export function cacheUserAppearance<T>(userId: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`user:appearance:${userId}`, { ttlMs: 30_000, tags: [`user:${userId}`] }, loader);
}

/** 缓存 QQ 绑定状态；响应含余额摘要，因此只做极短 TTL 并跟随 wallet/user/config 失效。 */
export function cacheQqStatus<T>(userId: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`qq:status:user:${userId}`, { ttlMs: 1500, tags: ['wallet', 'config', `user:${userId}`] }, loader);
}

/** 缓存 Web 用户模型偏好；保存偏好后按 user tag 失效。 */
export function cacheUserModelPref<T>(userId: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`model-pref:user:${userId}`, { ttlMs: 60_000, tags: [`user:${userId}`] }, loader);
}

/** 缓存公开状态页数据；状态页允许秒级延迟，但必须定期回源取真实统计。 */
export function cachePublicStatus<T>(range: PublicStatusRange, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(
    `public:status:${range}`,
    // 状态页聚合查询较重，不能随每次任务状态写入失效；用短 TTL 和 stale 窗口吸收巡检/页面重复刷新。
    { ttlMs: 15_000, staleMs: 45_000, tags: ['status'] },
    loader,
  );
}

/** 缓存后台仪表盘概览；后台统计允许短延迟，写入路径仍以数据库为准。 */
export function cacheAdminStats<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('admin:stats:overview', { ttlMs: 10_000, staleMs: 30_000, tags: ['admin:stats'] }, loader);
}

/** 缓存后台趋势聚合；趋势桶查询不需要每次进入后台都重新扫描。 */
export function cacheAdminTrends<T>(days: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`admin:stats:trends:${days}`, { ttlMs: 60_000, staleMs: 180_000, tags: ['admin:stats'] }, loader);
}

/** 缓存后台服务健康摘要；短 TTL 避免仪表盘并发刷新反复探测内部服务。 */
export function cacheAdminServiceHealth<T>(loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet('admin:health:services', { ttlMs: 5000, staleMs: 15_000, tags: ['admin:health'] }, loader);
}

/** 缓存公开排行榜；排行榜是聚合查询，允许 30 秒延迟并随任务列表标签粗粒度失效。 */
export function cacheUserTaskLeaderboard<T>(kind: UserTaskLeaderboardKind, range: LeaderboardRange, limit: number, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(
    `public:leaderboard:user-tasks:${kind}:${range}:${limit}`,
    { ttlMs: 30_000, staleMs: 120_000, tags: ['leaderboard', 'task-list:admin'] },
    loader,
  );
}

/** 缓存后台钱包列表；任意钱包写入后粗粒度失效。 */
export function cacheAdminWalletList<T>(query: unknown, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`admin:balance:wallets:${hashCacheParts(query)}`, { ttlMs: 3000, tags: ['wallet'] }, loader);
}

/** 缓存后台 QQ 余额账户列表；余额调整、重置和绑定变化会失效 wallet/qq tag。 */
export function cacheAdminQqBalanceAccounts<T>(query: unknown, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`admin:balance:accounts:${hashCacheParts(query)}`, { ttlMs: 3000, tags: ['wallet'] }, loader);
}

/** 缓存后台任务列表；任务写入、状态变化和删除会失效 task-list:admin。 */
export function cacheAdminGenerationList<T>(query: unknown, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`admin:generations:${hashCacheParts(query)}`, { ttlMs: 3000, tags: ['task-list:admin'] }, loader);
}

/** 缓存后台任务详情；任务子状态、图片和本地媒体配置变化会按 task tag 失效。 */
export function cacheAdminGenerationDetail<T>(taskId: string, loader: () => Promise<T>): Promise<BackendCacheResult<T>> {
  return backendCache.getOrSet(`admin:generation:${hashCacheParts(taskId)}`, { ttlMs: 5000, tags: [`task:${taskId}`, 'task-list:admin'] }, loader);
}

function sortIds(ids: string[]): string[] {
  return [...ids].filter(Boolean).sort();
}

function hasOnlyTerminalTasks(tasks: Array<{ status?: string }>): boolean {
  return tasks.length > 0 && tasks.every((task) => task.status === 'success' || task.status === 'failed');
}
