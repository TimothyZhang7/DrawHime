/**
 * 本文件实现站点选择服务，包括候选筛选、短窗口均衡、加权随机和分钟窗口判断。
 * 站点选择规则必须遵守 docs/architecture.md、docs/services.md 和 standards/interfaces/README.md。
 *
 * 选择流程：
 * 1. 筛选：isEnabled=true、autoDisabledUntil 已过期、并发未满、模型匹配、分钟窗口内
 * 2. 排序：按有效权重做短窗口均衡随机，避免单站点长期连续命中
 * 3. 占用：只对最终选中的站点占用分钟桶，候选筛选不会消耗未选站点配额
 */
import type {
  ApiSiteConfig,
  SiteModelOption,
  SiteSelectionMode,
  SiteSelectionResult,
} from './site-selection-types.js';
import { resolveMaxReferenceImages, resolveReferenceImageField, resolveReferenceImageOverflowStrategy, supportsCombinedReferenceImage, supportsDrawingAspectRatio, type DrawingAspectRatio, type DrawingMode } from '@aiimage/shared-contracts';

/** 并发站点计数器接口，由 drawing-worker-app 注入 Redis 或内存实现。 */
export type SiteConcurrencyCounter = {
  /** 读取当前分钟桶计数，仅用于候选负载估算，不改变站点配额。 */
  get(siteId: number, minuteBucket: string): Promise<number>;
  /** 原子占用当前分钟桶；返回占用后的计数，null 表示站点超过宽容硬上限。 */
  tryAcquire(siteId: number, minuteBucket: string, allowedConcurrency: number): Promise<number | null>;
};

/** 已排除的站点 ID 集合，换站重试时会排除已失败的站点。 */
export type ExcludedSites = Set<number>;

/** 单个站点最近选择记录，用于进程内短窗口公平性计算。 */
type RecentSiteSelection = {
  /** 被选中的站点 ID。 */
  siteId: number;
  /** 选择发生时间戳。 */
  selectedAt: number;
};

/** 选择历史窗口毫秒：窗口过短会抖动，过长会影响权重调整的响应速度。 */
const BALANCE_WINDOW_MS = Number(process.env.DRAWING_SITE_BALANCE_WINDOW_MS ?? '300000');
/** 进程内历史最多保留条数，避免长期运行时内存无界增长。 */
const BALANCE_HISTORY_LIMIT = Number(process.env.DRAWING_SITE_BALANCE_HISTORY_LIMIT ?? '500');
/** 同一站点默认最多连续命中次数；达到后大幅降权，让其他可用站点获得调度机会。 */
const MAX_CONSECUTIVE_SELECTIONS = Math.max(1, Number(process.env.DRAWING_SITE_MAX_CONSECUTIVE_SELECTIONS ?? '3'));
/** 加权随机的最小权重，避免 0 权重导致抽样异常，同时不影响连续命中上限的打断效果。 */
const MIN_RANDOM_WEIGHT = 0.000001;
/** 单站点并发宽容比例：正常上限外允许少量突发，避免短时间内所有候选被硬拒绝。 */
const CONCURRENCY_OVERAGE_RATIO = clamp(Number(process.env.DRAWING_SITE_CONCURRENCY_OVERAGE_RATIO ?? '0.2'), 0, 1);
/** 单站点并发最小宽容数；设为 0 可完全关闭固定宽容名额。 */
const CONCURRENCY_OVERAGE_MIN = Math.max(0, Number(process.env.DRAWING_SITE_CONCURRENCY_OVERAGE_MIN ?? '1'));
/** 单站点并发最大宽容数，防止高并发站点因比例配置过大而突发失控。 */
const CONCURRENCY_OVERAGE_MAX = Math.max(0, Number(process.env.DRAWING_SITE_CONCURRENCY_OVERAGE_MAX ?? '3'));
/** 全局短窗口选择历史；只记录实际占用成功的站点，不记录未命中的候选。 */
const recentSelections: RecentSiteSelection[] = [];

/**
 * 站点选择服务，纯业务逻辑，不直接依赖 Redis 或 MySQL。
 * 并发计数和站点配置由调用方注入。
 */
export class SiteSelectionService {
  /** 注入并发计数器，用于判断每站每分钟的并发上限。 */
  constructor(private readonly concurrencyCounter: SiteConcurrencyCounter) {}

  /**
   * 选择生成站点，返回排序后的候选列表。
   * @param sites 所有可用站点配置
   * @param mode 选择模式：weighted 或 random
   * @param drawingMode 图片或视频生成模式
   * @param preferredModel 用户偏好模型，空则用站点默认
   * @param excludedSiteIds 已排除的站点（本次重试中已失败的站点）
   * @param referenceImageCount 当前任务真实参考图数量
   * @param aspectRatio 用户显式选择的画幅比例
   */
  async selectCandidates(
    sites: ApiSiteConfig[],
    mode: SiteSelectionMode,
    drawingMode: DrawingMode,
    preferredModel?: string,
    excludedSiteIds?: ExcludedSites,
    referenceImageCount = drawingMode === 'image-to-image' || drawingMode === 'image-to-video' ? 1 : 0,
    aspectRatio?: DrawingAspectRatio,
  ): Promise<SiteSelectionResult[]> {
    const now = new Date();
    const nowMs = now.getTime();
    const chinaHour = (now.getUTCHours() + 8) % 24;
    const chinaMinute = chinaHour * 60 + now.getMinutes();
    const minuteBucket = formatMinuteBucket(chinaMinute);

    const primaryCandidates: SiteSelectionResult[] = [];
    const fallbackCandidates: SiteSelectionResult[] = [];
    const excluded = excludedSiteIds ?? new Set<number>();

    for (const site of sites) {
      // 步骤 1：基本筛选 — 未启用或手动停用直接跳过
      if (!site.isEnabled) continue;

      // 步骤 2：自动禁用检查 — 超过 autoDisabledUntil 才恢复
      if (site.autoDisabledUntil && new Date(site.autoDisabledUntil) > now) continue;

      // 步骤 3：已排除站点检查 — 换站重试时优先完全排除，只有无新站点可用时才 fallback。
      const isExcluded = excluded.has(site.id);

      // 步骤 4：模型匹配 — 找到可用的模型选项
      const modelMatch = this.matchModel(site, drawingMode, preferredModel);
      if (!modelMatch) continue;

      // 显式比例只能路由到声明支持的站点模型，避免已知会忽略 size/aspect_ratio 的代理返回错误画幅。
      if (!supportsDrawingAspectRatio(modelMatch, aspectRatio)) continue;

      // 图生图候选必须完整容纳全部参考图；只支持单图的模型不能接收多图任务。
      const maxReferenceImages = resolveMaxReferenceImages(modelMatch);
      const referenceImageOverflowStrategy = resolveReferenceImageOverflowStrategy({
        maxReferenceImages,
        referenceImageOverflowStrategy: modelMatch.referenceImageOverflowStrategy,
      });
      const canCombineOverflow = supportsCombinedReferenceImage(modelMatch.apiMode) && maxReferenceImages === 1 && referenceImageOverflowStrategy === 'combine';
      if ((drawingMode === 'image-to-image' || drawingMode === 'image-to-video')
        && (referenceImageCount < 1 || maxReferenceImages === 0 || (referenceImageCount > maxReferenceImages && !canCombineOverflow))) continue;

      // 步骤 5：分钟窗口检查 — 当前分钟必须在模型可用窗口内
      if (!this.isWithinMinuteWindow(modelMatch, chinaMinute % (24 * 60))) continue;

      // 步骤 6：并发检查 + 获取当前计数。这里只读不占用，避免未选中的候选站点消耗分钟配额。
      let siteCurrent = 0;
      const allowedConcurrency = getAllowedConcurrency(site.maxConcurrency);
      if (site.maxConcurrency > 0) {
        siteCurrent = await this.concurrencyCounter.get(site.id, minuteBucket);
        if (siteCurrent >= allowedConcurrency) continue;
      }

      // 步骤 7：计算有效权重；超过正常上限但未超过宽容硬上限时保留候选并降低权重。
      const remaining = Math.max(0, site.maxConcurrency - siteCurrent);
      let effectiveWeight = site.weight * (1 + remaining / Math.max(1, site.maxConcurrency));
      if (site.maxConcurrency > 0 && siteCurrent >= site.maxConcurrency) effectiveWeight *= 0.25;
      if (isExcluded) effectiveWeight *= 0.15;

      const candidate = {
        site,
        model: modelMatch.name,
        modelType: modelMatch.type,
        apiMode: modelMatch.apiMode,
        maxReferenceImages,
        referenceImageField: resolveReferenceImageField(modelMatch),
        referenceImageOverflowStrategy,
        effectiveWeight,
      };

      if (isExcluded) fallbackCandidates.push(candidate);
      else primaryCandidates.push(candidate);
    }

    // 步骤 8：候选分层 — 换站重试优先使用未失败站点；未失败站点竞态占满时再回退到已失败站点。
    if (primaryCandidates.length === 0 && fallbackCandidates.length === 0) return [];

    // 步骤 9：排序 — weighted 兼容旧配置，但实际也走按权重均衡随机，避免长期固定同一个站点。
    const primaryOrdered = balancedWeightedShuffle(primaryCandidates, nowMs, mode);
    const fallbackOrdered = balancedWeightedShuffle(fallbackCandidates, nowMs, mode);
    const ordered = [...primaryOrdered, ...fallbackOrdered];

    // 步骤 10：最终占用 — 只为实际选中的站点占用并发配额；竞态占满时继续尝试下一候选层。
    for (let i = 0; i < ordered.length; i += 1) {
      const selected = ordered[i];
      if (!selected) continue;
      if (selected.site.maxConcurrency > 0) {
        const allowedConcurrency = getAllowedConcurrency(selected.site.maxConcurrency);
        const acquiredCount = await this.concurrencyCounter.tryAcquire(selected.site.id, minuteBucket, allowedConcurrency);
        if (acquiredCount === null) continue;
        const remaining = Math.max(0, selected.site.maxConcurrency - acquiredCount);
        selected.effectiveWeight = selected.site.weight * (1 + remaining / Math.max(1, selected.site.maxConcurrency));
        if (acquiredCount > selected.site.maxConcurrency) selected.effectiveWeight *= 0.25;
      }
      recordSiteSelection(selected.site.id, nowMs);
      return [selected, ...ordered.filter((_, index) => index !== i)];
    }

    return [];
  }

  /**
   * 匹配站点模型：preferredModel 优先，否则使用站点默认模型。
   * 模型类型必须匹配绘图模式：text_to_image 只能文生图，image_to_image 只能图生图。
   */
  private matchModel(
    site: ApiSiteConfig,
    drawingMode: DrawingMode,
    preferredModel?: string,
  ): SiteModelOption | null {
    // 如果用户指定了模型，在所有站点模型选项中查找
    if (preferredModel) {
      const match = site.modelOptions.find(
        (opt) => (opt.name === preferredModel || opt.canonicalName === preferredModel)
          && opt.enabled
          && this.isModelTypeMatch(opt.type, drawingMode),
      );
      if (match) return match;
      // preferredModel 在该站点不可用，不 fallback 到默认模型（尊重用户指定）
      return null;
    }

    // 使用站点默认模型，检查类型匹配
    const defaultOption = site.modelOptions.find(
      (opt) => opt.name === site.model && opt.enabled && this.isModelTypeMatch(opt.type, drawingMode),
    );
    if (defaultOption) return defaultOption;

    // 默认模型不匹配时使用第一个匹配类型的启用模型
    return site.modelOptions.find(
      (opt) => opt.enabled && this.isModelTypeMatch(opt.type, drawingMode),
    ) ?? null;
  }

  /** 模型类型必须匹配绘图模式。 */
  private isModelTypeMatch(modelType: SiteModelOption['type'], drawingMode: DrawingMode): boolean {
    if (modelType === 'video') return drawingMode === 'text-to-video' || drawingMode === 'image-to-video';
    if (modelType === 'universal') return drawingMode === 'text-to-image' || drawingMode === 'image-to-image';
    if (modelType === 'text_to_image' && drawingMode === 'text-to-image') return true;
    if (modelType === 'image_to_image' && drawingMode === 'image-to-image') return true;
    return false;
  }

  /**
   * 检查当前分钟是否在模型可用窗口内。
   * availableMinuteStart 和 availableMinuteEnd 都是 0-59 的分钟数。
   * 空值表示全程可用。
   */
  private isWithinMinuteWindow(modelOpt: SiteModelOption, minuteOfDay: number): boolean {
    const hourMinute = minuteOfDay % 60;
    if (modelOpt.availableMinuteStart === undefined || modelOpt.availableMinuteEnd === undefined) {
      return true;
    }
    if (modelOpt.availableMinuteStart <= modelOpt.availableMinuteEnd) {
      return hourMinute >= modelOpt.availableMinuteStart && hourMinute < modelOpt.availableMinuteEnd;
    }
    // 跨小时窗口（如 50-10）
    return hourMinute >= modelOpt.availableMinuteStart || hourMinute < modelOpt.availableMinuteEnd;
  }
}

/** 按短窗口选择历史调整有效权重；只做轻量惩罚，不改变站点配置中的长期权重比例。 */
function applyBalancePenalty(candidates: SiteSelectionResult[], nowMs: number): SiteSelectionResult[] {
  pruneRecentSelections(nowMs);
  if (candidates.length <= 1) return candidates.map((candidate) => ({ ...candidate }));

  const candidateIds = new Set(candidates.map((candidate) => candidate.site.id));
  const recentCounts = new Map<number, number>();
  let recentTotal = 0;
  let lastSiteId: number | null = null;
  let sameSiteStreak = 0;
  let streakClosed = false;

  for (let i = recentSelections.length - 1; i >= 0; i -= 1) {
    const item = recentSelections[i];
    if (!item || !candidateIds.has(item.siteId)) continue;
    recentCounts.set(item.siteId, (recentCounts.get(item.siteId) ?? 0) + 1);
    recentTotal += 1;
    if (lastSiteId === null) {
      lastSiteId = item.siteId;
      sameSiteStreak = 1;
    } else if (!streakClosed && item.siteId === lastSiteId) {
      sameSiteStreak += 1;
    } else {
      streakClosed = true;
    }
  }

  const totalWeight = candidates.reduce((sum, candidate) => sum + Math.max(0.01, candidate.effectiveWeight), 0);
  return candidates.map((candidate) => {
    const baseWeight = Math.max(0.01, candidate.effectiveWeight);
    const expectedShare = baseWeight / totalWeight;
    const recentCount = recentCounts.get(candidate.site.id) ?? 0;
    const expectedCount = (recentTotal + 1) * expectedShare;
    const deficit = expectedCount - recentCount;
    const deficitFactor = expectedCount > 0 ? deficit / expectedCount : 0;
    // 短窗口公平性：低于期望的站点轻微增强，超出期望的站点降低权重，避免单站点连续被抽中。
    const balanceMultiplier = clamp(1 + deficitFactor, 0.25, 2.5);
    // 连续命中同一站点时追加惩罚；达到上限后大幅降权，避免高权重站点把低权重站点长期饿死。
    const streakMultiplier = candidate.site.id === lastSiteId && sameSiteStreak > 0
      ? sameSiteStreak >= MAX_CONSECUTIVE_SELECTIONS
        ? MIN_RANDOM_WEIGHT
        : 1 / (1 + sameSiteStreak * 0.8)
      : 1;
    return {
      ...candidate,
      effectiveWeight: baseWeight * balanceMultiplier * streakMultiplier,
    };
  });
}

/** 按有效权重做短窗口均衡随机不放回排序，每个候选按调整后的权重比例随机选择。 */
function balancedWeightedShuffle(
  candidates: SiteSelectionResult[],
  nowMs: number,
  _mode: SiteSelectionMode,
): SiteSelectionResult[] {
  const adjusted = applyBalancePenalty(candidates, nowMs);
  return weightedShuffle(adjusted);
}

/** 按有效权重做加权随机不放回排序。 */
function weightedShuffle(candidates: SiteSelectionResult[]): SiteSelectionResult[] {
  if (candidates.length <= 1) return [...candidates];

  const result: SiteSelectionResult[] = [];
  const remaining = candidates.map((c) => ({ ...c }));

  while (remaining.length > 0) {
    const totalWeight = remaining.reduce((sum, c) => sum + Math.max(MIN_RANDOM_WEIGHT, c.effectiveWeight), 0);
    let rand = Math.random() * totalWeight;

    for (let i = 0; i < remaining.length; i++) {
      rand -= Math.max(MIN_RANDOM_WEIGHT, remaining[i].effectiveWeight);
      if (rand <= 0) {
        result.push(remaining.splice(i, 1)[0]);
        break;
      }
    }
  }

  return result;
}

/** 记录实际选中的站点，并限制历史数组长度。 */
function recordSiteSelection(siteId: number, nowMs: number): void {
  recentSelections.push({ siteId, selectedAt: nowMs });
  pruneRecentSelections(nowMs);
  if (recentSelections.length > BALANCE_HISTORY_LIMIT) {
    recentSelections.splice(0, recentSelections.length - BALANCE_HISTORY_LIMIT);
  }
}

/** 清理短窗口外的选择历史。 */
function pruneRecentSelections(nowMs: number): void {
  const cutoff = nowMs - Math.max(30_000, BALANCE_WINDOW_MS);
  while (recentSelections.length > 0 && (recentSelections[0]?.selectedAt ?? nowMs) < cutoff) {
    recentSelections.shift();
  }
}

/** 限制数值范围，避免短窗口惩罚把权重放大或压低到不可控。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 计算单站点宽容硬上限：正常并发 + 少量突发额度；maxConcurrency<=0 仍表示不限制。 */
function getAllowedConcurrency(maxConcurrency: number): number {
  if (maxConcurrency <= 0) return 0;
  const ratioExtra = Math.ceil(maxConcurrency * CONCURRENCY_OVERAGE_RATIO);
  const extra = Math.min(CONCURRENCY_OVERAGE_MAX, Math.max(CONCURRENCY_OVERAGE_MIN, ratioExtra));
  return maxConcurrency + extra;
}

/**
 * 格式化分钟桶 key：aiimage:v3:drawing:site-minute:<siteId>:<yyyyMMddHHmm>。
 * 用于 Redis 或内存并发计数，桶粒度为一分钟。
 */
export function formatMinuteBucket(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  const now = new Date();
  // 使用 UTC+8 日期
  const chinaDate = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const datePart = chinaDate.toISOString().slice(0, 10).replace(/-/g, '');
  const hoursStr = String(hours).padStart(2, '0');
  const minutesStr = String(minutes).padStart(2, '0');
  return `${datePart}${hoursStr}${minutesStr}`;
}
