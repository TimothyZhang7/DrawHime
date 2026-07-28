/**
 * 本文件实现两层重试编排：请求级同站重试 + 任务级换站重试。
 *
 * 重试层级：
 * 1. 请求级同站重试（SiteRequestRetry）：包裹单次上游 fetch，处理网络/超时/连接错误
 * 2. 任务级换站重试（TaskRetryOrchestrator）：选择站点 → 执行 → 判断 → 换站或停止
 *
 * 重试规则必须遵守：
 * - docs/architecture.md 与 standards/interfaces/README.md：retryInfo 契约、可重试/不可重试错误
 * - specs/README.md：DRAW-030 到 DRAW-036
 */
import { calcRetryDelay, isNonRetryableError, isRetryableError, normalizeErrorMessage, summarizeGenerationFailure } from '@aiimage/core-utils';
import type { DrawingGenerateRequest } from '@aiimage/shared-contracts';
import { fetchDrawingConfig, recordSiteFailure, reportSubTask, resetSiteFailure, updateTaskStatus } from '../../infrastructure/http/backend-client.js';
import { callUpstreamImageApi, UpstreamApiCallError, type UpstreamImageResult } from '../image-api/upstream-image-client.js';
import { callUpstreamVideoApi, type UpstreamVideoResult } from '../video-api/upstream-video-client.js';
import type { ApiSiteConfig, SiteSelectionResult } from '../site-selection/site-selection-types.js';
import { buildPromptCacheKey } from '@aiimage/core-utils';
import { SiteSelectionService } from '../site-selection/site-selection-service.js';

/** 校验任务是否仍处于 running 状态（防外部清理后 Worker 继续执行） */
async function checkTaskStillRunning(taskId: string): Promise<boolean> {
  try {
    const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
    const res = await fetch(`${BACKEND_URL}/internal/worker/task-status?taskId=${encodeURIComponent(taskId)}`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { status: string } };
    return data.ok === true && data.data?.status === 'running';
  } catch { return true; /* 查询失败不阻塞，继续处理 */ }
}

/** 重试配置，来自全局 AI 绘图配置或环境变量默认值；任务尝试上限由请求自身携带。 */
export type RetryConfig = {
  /** 重试范围：single_site 只同站重试，all_enabled 可换站。 */
  retryScope: 'single_site' | 'all_enabled';
  /** 站点选择模式。 */
  siteSelectionMode: 'weighted' | 'random';
  /** 是否忽略可重试判定，对更多业务错误也换站。 */
  ignoreErrors: boolean;
  /** 请求级站点内重试次数，范围 0-10。 */
  siteRequestRetries: number;
  /** 同站请求重试等待毫秒。 */
  siteRequestDelayMs: number;
  /** 上游 API 请求超时兜底毫秒；站点 timeoutSec 有效时不使用该值。 */
  requestTimeoutMs: number;
  /** 是否开启了请求级重试（大于 0 表示开启）。 */
  get hasSiteRequestRetry(): boolean;
};

/** 重试编排结果，包含所有尝试信息和最终状态。 */
export type RetryResult = {
  /** 最终状态。 */
  success: boolean;
  /** 成功时的图片结果。 */
  imageResult?: UpstreamImageResult;
  /** 成功时的视频结果。 */
  videoResult?: UpstreamVideoResult;
  /** 最终使用站点。 */
  finalSite?: ApiSiteConfig;
  /** 最终使用模型。 */
  finalModel?: string;
  /** retryInfo 中的尝试记录。 */
  attempts: RetryAttemptRecord[];
  /** 总耗时毫秒。 */
  totalLatencyMs: number;
};

/** 单次尝试记录，用于构造 retryInfo。 */
export type RetryAttemptRecord = {
  attempt: number;
  siteId: number;
  siteName: string;
  model: string;
  retryCount: number;
  status: 'success' | 'failed';
  retryable: boolean;
  nextAction: 'stop' | 'switch_site' | 'same_site';
  error?: string;
  latencyMs: number;
};

/** 默认重试配置：优先从 backend system_configs 读取，环境变量兜底。 */
export async function getDefaultRetryConfig(): Promise<RetryConfig> {
  // 尝试从 backend 读取运行时配置
  let dbConfig: Record<string, unknown> | null = null;
  try {
    dbConfig = await fetchDrawingConfig();
  } catch { /* backend 不可达时使用环境变量兜底 */ }

  // siteRequestRetries 专用于同站网络级重试，独立于站点切换次数；配置读取失败时也不重复打慢模型请求。
  const siteRequestRetries = Number(dbConfig?.siteRequestRetries ?? process.env.DRAWING_SITE_REQUEST_RETRIES ?? '0');
  return {
    retryScope: (dbConfig?.retryScope ?? process.env.DRAWING_RETRY_SCOPE ?? 'all_enabled') as 'single_site' | 'all_enabled',
    // 默认使用按权重均衡随机，避免 weighted 旧默认导致高权重站点长期固定排第一。
    siteSelectionMode: (dbConfig?.siteSelectionMode ?? process.env.DRAWING_SITE_SELECTION_MODE ?? 'random') as 'weighted' | 'random',
    ignoreErrors: (dbConfig?.ignoreErrors ?? process.env.DRAWING_IGNORE_ERRORS === 'true') as boolean,
    siteRequestRetries,
    siteRequestDelayMs: Number(dbConfig?.siteRequestDelayMs ?? process.env.DRAWING_SITE_REQUEST_DELAY_MS ?? '500'),
    // 配置读取失败时使用生产慢图模型安全默认值，避免 gpt-image-2 被 30 秒过早中断。
    requestTimeoutMs: Number(dbConfig?.requestTimeoutMs ?? process.env.DRAWING_REQUEST_TIMEOUT_MS ?? '125000'),
    get hasSiteRequestRetry(): boolean { return siteRequestRetries > 0; },
  };
}

/**
 * 任务级重试编排器。
 * 每轮选一个站点 → 执行图片生成（可选请求级同站重试）→ 失败后判断换站或停止。
 */
export class RetryOrchestrator {
  /** 注入站点选择服务，候选列表由 selectCandidates 产生。 */
  constructor(private readonly siteSelector: SiteSelectionService) {}

  /**
   * 执行带重试的绘图任务。
   * @param task 当前生成任务
   * @param sites 所有可用站点配置
   * @param config 重试配置
   */
  async execute(
    task: DrawingGenerateRequest,
    sites: ApiSiteConfig[],
    config?: RetryConfig,
  ): Promise<RetryResult> {
    const cfg = config ?? await getDefaultRetryConfig();
    // 模型级尝试上限已在任务创建时固化，运行中修改模型配置不应改变当前任务行为。
    const maxAttempts = Math.min(Math.max(Math.trunc(Number(task.maxAttempts)) || 3, 1), 10);
    const startTime = Date.now();
    const attempts: RetryAttemptRecord[] = [];
    const excludedSiteIds = new Set<number>();
    let lockedSingleSiteId: number | null = null;
    // 任务模式已经由 backend 与 drawing-service 双重校验，站点筛选必须保留视频模式。
    const drawingMode = task.mode;

    let finalResult: { success: boolean; imageResult?: UpstreamImageResult; videoResult?: UpstreamVideoResult; finalSite?: ApiSiteConfig; finalModel?: string } = {
      success: false,
    };

    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
      // 每次尝试前校验任务是否仍可执行（防被外部清理 kill 后继续跑）
      const currentStatus = await checkTaskStillRunning(task.taskId);
      if (!currentStatus) {
        console.log(`[orchestrator] 任务 ${task.taskId} 已被外部终止，停止重试`);
        break;
      }

      // 单站点重试必须锁定首轮站点；全部站点重试才传入已失败站点并尽可能切换。
      const selectableSites = cfg.retryScope === 'single_site' && lockedSingleSiteId !== null
        ? sites.filter((candidateSite) => candidateSite.id === lockedSingleSiteId)
        : sites;
      const candidates = await this.siteSelector.selectCandidates(
        selectableSites,
        cfg.siteSelectionMode,
        drawingMode,
        task.preferredModel,
        attemptNo > 1 && cfg.retryScope === 'all_enabled' ? excludedSiteIds : undefined,
        task.sourceImageUrls?.length ?? 0,
        task.aspectRatio,
      );

      if (candidates.length === 0) {
        // 无可用站点
        const referenceImageCount = task.sourceImageUrls?.length ?? 0;
        const errorMsg = attemptNo === 1
          ? task.aspectRatio && task.aspectRatio !== 'auto'
            ? `没有支持 ${task.aspectRatio} 画幅的可用模型站点`
            : (drawingMode === 'image-to-image' || drawingMode === 'image-to-video') && referenceImageCount > 0
            ? `没有可完整处理 ${referenceImageCount} 张参考图的可用模型`
            : '没有可用的绘图站点'
          : '所有可用站点均已尝试失败';
        await this.recordFailedAttempt(task.taskId, attemptNo, attempts, 'stop', errorMsg);
        attempts.push({
          attempt: attemptNo,
          siteId: 0,
          siteName: 'none',
          model: 'none',
          retryCount: 0,
          status: 'failed',
          retryable: false,
          nextAction: 'stop',
          error: errorMsg,
          latencyMs: Date.now() - startTime,
        });
        break;
      }

      const selected = candidates[0];
      const site = selected.site;
      const model = selected.model;
      if (cfg.retryScope === 'single_site' && lockedSingleSiteId === null) {
        lockedSingleSiteId = site.id;
      }

      // 执行图片或视频生成（请求级同站重试包裹）
      const attemptStart = Date.now();
      try {
        const { imageResult, videoResult, actualRetries } = await this.executeWithSiteRequestRetry(
          selected,
          task,
          cfg,
        );

        // 上游可能以最接近的可用尺寸返回图片；保留真实产物并由任务详情展示实际尺寸，不能把可用图片误判为失败。

        const latencyMs = Date.now() - attemptStart;
        // 成功记录（retryCount 为同站内实际重试次数，非配置上限）
        attempts.push({
          attempt: attemptNo,
          siteId: site.id,
          siteName: site.name,
          model,
          retryCount: actualRetries,
          status: 'success',
          retryable: false,
          nextAction: 'stop',
          latencyMs,
        });

        // 站点成功：重置连续故障计数
        resetSiteFailure(site.id, latencyMs).catch(() => { /* 重置失败不影响主流程 */ });

        // 向 backend 上报成功子任务（非阻塞）
        reportSubTask(task.taskId, 'upstream_attempt', 'success', {
          attemptNo,
          siteId: site.id,
          siteName: site.name,
          model,
          latencyMs,
          startedAt: new Date(attemptStart).toISOString(),
          finishedAt: new Date().toISOString(),
        });

        // 上游成功只代表拿到原始图片；主任务成功必须等 worker 保存本地文件并完成外显投递后再写入。
        finalResult = { success: true, imageResult, videoResult, finalSite: site, finalModel: model };
        break;
      } catch (error) {
        const latencyMs = Date.now() - attemptStart;
        const errorMessage = normalizeErrorMessage(error);
        const upstreamCallError = error instanceof UpstreamApiCallError ? error : null;
        const rawError = upstreamCallError?.rawError ?? (error instanceof Error ? error.message : String(error));

        // 判断是否可重试：后台 ignoreErrors 开启时继续按配置扩大重试范围。
        const retryable = cfg.ignoreErrors
          || ((!isNonRetryableError(error))
            && (isRetryableError(error))
            && (!upstreamCallError || upstreamCallError.retryable));

        // 站点故障：记录到 backend，达到阈值自动禁用
        recordSiteFailure(site.id, errorMessage, latencyMs).catch(() => { /* 记录失败不影响主流程 */ });

        // 决定重试方向
        const nextAction = !retryable ? 'stop'
          : cfg.retryScope === 'single_site' ? 'same_site'
          : 'switch_site';

        // 只有换站时才排除当前站点；同站重试保留站点在候选列表中
        if (nextAction === 'switch_site') {
          excludedSiteIds.add(site.id);
        }

        attempts.push({
          attempt: attemptNo,
          siteId: site.id,
          siteName: site.name,
          model,
          retryCount: 0,
          status: 'failed',
          retryable,
          nextAction,
          error: errorMessage,
          latencyMs,
        });

        // 向 backend 上报失败子任务（非阻塞，含脱敏 rawError）
        reportSubTask(task.taskId, 'upstream_attempt', 'failed', {
          attemptNo,
          siteId: site.id,
          siteName: site.name,
          model,
          retryable,
          nextAction,
          latencyMs,
          error: errorMessage,
          rawError,
          startedAt: new Date(attemptStart).toISOString(),
          finishedAt: new Date().toISOString(),
        });

        if (!retryable) {
          // 不可重试错误直接失败
          await updateTaskStatus(task.taskId, 'failed', errorMessage);
          break;
        }

        if (nextAction === 'stop' || attemptNo >= maxAttempts) {
          // 重试预算耗尽时必须从真实上游尝试错误归纳用户原因，不能把“重试次数已用完”当失败原因。
          const failureSummary = summarizeGenerationFailure({
            taskError: errorMessage,
            mode: task.mode,
            subTasks: attempts.map((attempt) => ({
              kind: 'upstream_attempt',
              status: attempt.status,
              error: attempt.error,
            })),
          });
          await updateTaskStatus(task.taskId, 'failed', failureSummary);
          break;
        }

        // 继续下一轮（换站或同站）
        if (nextAction === 'switch_site') {
          reportSubTask(task.taskId, 'site_switch', 'running', {
            attemptNo: attemptNo + 1,
            siteName: site.name,
            nextAction: 'switch_site',
            startedAt: new Date().toISOString(),
          }).catch(() => {});
        } else {
          reportSubTask(task.taskId, 'same_site_retry', 'running', {
            attemptNo: attemptNo + 1,
            siteId: site.id,
            siteName: site.name,
            nextAction: 'same_site',
            startedAt: new Date().toISOString(),
          }).catch(() => {});
        }
        // 任务级重试必须等待上游恢复；503/429 等服务拥塞错误不能在同一秒内耗尽全部次数。
        const retryDelayMs = calculateTaskRetryDelayMs(error, attemptNo, cfg.siteRequestDelayMs);
        console.log(`[orchestrator] 任务 ${task.taskId} 第 ${attemptNo} 次失败，等待 ${retryDelayMs}ms 后重试`);
        await sleep(retryDelayMs);
      }
    }

    // 收尾：将所有 running 状态的 site_switch/same_site_retry 子任务标记为跳过
    reportSubTask(task.taskId, 'site_switch', 'skipped', {
      error: finalResult.success ? undefined : '重试已终止',
      finishedAt: new Date().toISOString(),
    }).catch(() => {});

    return {
      ...finalResult,
      attempts,
      totalLatencyMs: Date.now() - startTime,
    };
  }

  /**
   * 请求级同站重试：包裹单次上游 fetch。
   * 只处理网络/超时/连接类错误的短等待重试。
   */
  private async executeWithSiteRequestRetry(
    selected: SiteSelectionResult,
    task: DrawingGenerateRequest,
    config: RetryConfig,
  ): Promise<{ imageResult?: UpstreamImageResult; videoResult?: UpstreamVideoResult; actualRetries: number }> {
    const maxRetries = config.siteRequestRetries;
    let lastError: unknown;
    const site = selected.site;
    const model = selected.model;
    // 同一来源身份跨任务使用稳定哈希键，既支持渠道亲和，又不向上游暴露用户 ID 或 QQ 号。
    const promptCacheKey = buildPromptCacheKey({
      source: task.source,
      userId: task.userId,
      qqNumber: task.qqNumber,
      clientRequestId: task.clientRequestId,
    });

    for (let retryNo = 0; retryNo <= maxRetries; retryNo++) {
      try {
        if (task.mode === 'text-to-video' || task.mode === 'image-to-video') {
          if (!task.duration || !task.resolution || !task.aspectRatio || task.aspectRatio === 'auto') {
            throw new UpstreamApiCallError('视频生成参数不完整', 'missing duration/resolution/aspect_ratio', false, 400);
          }
          if (selected.apiMode !== 'grok_video_generation') {
            throw new UpstreamApiCallError('当前站点模型未配置 Grok 视频格式', `video apiMode=${selected.apiMode ?? 'undefined'}`, false, 400);
          }
          const videoResult = await callUpstreamVideoApi(site, model, {
            prompt: task.prompt,
            mode: task.mode,
            sourceImageUrls: task.sourceImageUrls,
            duration: task.duration,
            aspectRatio: task.aspectRatio,
            resolution: task.resolution,
          }, config.requestTimeoutMs);
          return { videoResult, actualRetries: retryNo };
        }
        const imageResult = await callUpstreamImageApi(site, model, {
          prompt: task.prompt,
          mode: task.mode,
          sourceImageUrls: task.sourceImageUrls,
          size: task.size,
          aspectRatio: task.aspectRatio,
          quality: task.quality,
          lora: task.lora,
          promptCacheKey,
        }, config.requestTimeoutMs, selected.apiMode, selected.referenceImageField, selected.maxReferenceImages, selected.referenceImageOverflowStrategy);
        return { imageResult, actualRetries: retryNo };
      } catch (error) {
        lastError = error;
        // 未开启 ignoreErrors 时，HTTP 4xx 明确错误不做请求级重试；开启后按配置忽略所有上游错误继续尝试。
        if (!config.ignoreErrors && error instanceof UpstreamApiCallError && error.statusCode && error.statusCode < 500 && error.statusCode !== 429) {
          throw error;
        }
        if (!config.ignoreErrors && isNonRetryableError(error)) throw error;
        // 等待后重试（最小延迟，避免阻塞并发槽位过久）
        if (retryNo < maxRetries) {
          await sleep(Math.min(config.siteRequestDelayMs, 1000));
        }
      }
    }
    throw lastError;
  }

  /** 记录最终失败尝试到 attempts 数组，用于后端重建 retryInfo。 */
  private async recordFailedAttempt(
    taskId: string,
    attemptNo: number,
    attempts: RetryAttemptRecord[],
    nextAction: RetryAttemptRecord['nextAction'],
    error: string,
  ): Promise<void> {
    attempts.push({
      attempt: attemptNo,
      siteId: 0,
      siteName: 'none',
      model: 'none',
      retryCount: 0,
      status: 'failed',
      retryable: false,
      nextAction,
      error,
      latencyMs: 0,
    });
    await updateTaskStatus(taskId, 'failed', error);
  }
}

/** 异步等待指定毫秒数。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 计算任务级重试退避：服务拥塞至少从 5 秒起步，其他错误沿用后台基础等待。
 * Retry-After 优先级最高，但单次等待最多 10 分钟，避免异常响应永久占用任务。
 */
export function calculateTaskRetryDelayMs(error: unknown, attemptNo: number, configuredBaseDelayMs: number): number {
  const upstreamError = error instanceof UpstreamApiCallError ? error : null;
  const statusCode = upstreamError?.statusCode;
  const isServiceBusy = statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
  const configuredBase = Number.isFinite(configuredBaseDelayMs) ? configuredBaseDelayMs : 2000;
  const baseDelayMs = isServiceBusy
    ? Math.max(5000, configuredBase)
    : Math.max(500, configuredBase);
  const exponentialDelayMs = baseDelayMs * (2 ** Math.max(0, attemptNo - 1));
  return Math.min(10 * 60_000, Math.max(exponentialDelayMs, upstreamError?.retryAfterMs ?? 0));
}
