/** 本文件定义公开状态页接口契约，所有字段均来自真实服务健康检查或数据库聚合统计。 */
import type { ApiDataResponse } from './api-response.js';
import type { ApiEndpointContract } from './api-contract.js';

/** 状态页支持的统计时间范围。 */
export type PublicStatusRange = '1h' | '24h' | '7d';

/** 单个后端服务的公开健康状态。 */
export type PublicServiceHealthView = {
  /** 服务标识，必须与服务清单保持一致。 */
  name: string;
  /** 页面展示名称。 */
  label: string;
  /** 服务是否健康。 */
  ok: boolean;
  /** HTTP 探活状态码；backend 自身为 200。 */
  statusCode: number | null;
  /** 服务版本。 */
  version: string;
  /** 进程运行秒数。 */
  uptimeSec: number;
  /** 探活耗时毫秒。 */
  latencyMs: number | null;
  /** 最近一次探活错误，健康时为空。 */
  error: string | null;
};

/** 绘图任务状态分布，按主任务真实 status 聚合。 */
export type PublicTaskStatusSummary = {
  /** 所选时间范围内创建的任务总数。 */
  total: number;
  /** 排队任务数。 */
  queued: number;
  /** 运行中任务数。 */
  running: number;
  /** Bot 投递收尾中的任务数。 */
  finalizing: number;
  /** 成功任务数。 */
  success: number;
  /** 失败任务数。 */
  failed: number;
  /** 终态任务数，只包含 success 和 failed。 */
  terminalTotal: number;
  /** 终态成功率百分比；无终态任务时为 null。 */
  successRate: number | null;
};

/** 按来源统计任务分布。 */
export type PublicSourceSummary = {
  /** 任务来源，如 web、bot。 */
  source: string;
  /** 来源任务总数。 */
  total: number;
  /** 成功任务数。 */
  success: number;
  /** 失败任务数。 */
  failed: number;
};

/** 单个绘图站点在当前时间范围内的真实尝试统计。 */
export type PublicSiteRuntimeView = {
  /** 站点 ID。 */
  id: number;
  /** 站点名称。 */
  name: string;
  /** 是否启用。 */
  isEnabled: boolean;
  /** 调度权重。 */
  weight: number;
  /** 配置的单分钟并发上限。 */
  maxConcurrency: number;
  /** 连续失败次数。 */
  consecutiveFailures: number;
  /** 自动禁用截止时间。 */
  autoDisabledUntil: string | null;
  /** 自动禁用原因。 */
  autoDisabledReason: string | null;
  /** 全生命周期调用次数，来自 api_sites。 */
  lifetimeCalls: number;
  /** 全生命周期成功次数，来自 api_sites。 */
  lifetimeSuccess: number;
  /** 全生命周期平均延迟，来自 api_sites。 */
  lifetimeAvgLatencyMs: number;
  /** 所选时间范围内上游尝试总数。 */
  attempts: number;
  /** 所选时间范围内上游成功数。 */
  success: number;
  /** 所选时间范围内上游失败数。 */
  failed: number;
  /** 所选时间范围内上游运行/排队数。 */
  active: number;
  /** 所选时间范围内终态上游尝试成功率；无终态尝试时为 null。 */
  successRate: number | null;
  /** 所选时间范围内平均上游耗时毫秒。 */
  avgLatencyMs: number | null;
};

/** Bot 连接概览。 */
export type PublicBotSummary = {
  /** Bot 记录总数。 */
  total: number;
  /** 在线 Bot 数。 */
  online: number;
  /** 离线 Bot 数。 */
  offline: number;
  /** 被封禁 Bot 数。 */
  banned: number;
};

/** 平台公开运营概览。 */
export type PublicPlatformSummary = {
  /** 注册用户数。 */
  users: number;
  /** 已验证邮箱用户数。 */
  verifiedUsers: number;
  /** 公开图库可见作品数。 */
  publicImages: number;
  /** 可用绘图站点数。 */
  enabledSites: number;
};

/** 公开状态接口响应体。 */
export type PublicStatusResponse = {
  /** 当前统计范围。 */
  range: PublicStatusRange;
  /** 范围开始时间。 */
  since: string;
  /** 服务器生成本统计的时间。 */
  generatedAt: string;
  /** 服务健康汇总。 */
  services: PublicServiceHealthView[];
  /** 主任务状态分布。 */
  tasks: PublicTaskStatusSummary;
  /** 按任务来源聚合。 */
  sources: PublicSourceSummary[];
  /** 站点运行统计。 */
  sites: PublicSiteRuntimeView[];
  /** Bot 连接概览。 */
  bots: PublicBotSummary;
  /** 平台公开概览。 */
  platform: PublicPlatformSummary;
};

/** 公开状态接口契约。 */
export type PublicStatusEndpoint = ApiEndpointContract<undefined, ApiDataResponse<PublicStatusResponse>>;
