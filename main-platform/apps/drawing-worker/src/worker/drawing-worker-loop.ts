/**
 * 本文件实现 drawing-worker 的主循环：从 backend 轮询拉取任务 → 抢占 → 执行绘图 → 回写结果。
 *
 * 任务消费遵循 at-least-once 语义，所有写操作通过 backend 受保护接口幂等执行。
 *
 * 流程：
 * 1. GET /internal/worker/pending-tasks → 获取 queued 任务列表
 * 2. POST /internal/worker/claim-task → 条件更新抢占（queued→running）
 * 3. 调用重试编排器执行绘图（含站点选择+上游调用+两层重试）
 * 4. POST /internal/worker/report-subtask → 回写每次尝试结果
 * 5. POST /internal/worker/finalize-task → 回写主任务最终状态
 */
import type { ApiSiteRuntimeConfigResponse, DrawingGenerateRequest } from '@aiimage/shared-contracts';
import { summarizeGenerationFailure } from '@aiimage/core-utils';
import { RetryOrchestrator, getDefaultRetryConfig } from '../modules/retry/retry-orchestrator.js';
import {
  fetchDrawingConfig,
  reportSubTask,
  updateTaskStatus,
} from '../infrastructure/http/backend-client.js';
import { getSiteMinute, tryAcquireSiteMinute } from '../infrastructure/redis/redis-client.js';
import { downloadImageWithLimit, uploadMediaImage, uploadMediaVideo } from '../modules/media/media-upload-client.js';
import type { ApiSiteConfig } from '../modules/site-selection/site-selection-types.js';
import { SiteSelectionService } from '../modules/site-selection/site-selection-service.js';

/** Backend 内部地址。 */
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
/** 轮询间隔毫秒，从 backend system_configs 读取，60s 刷新。 */
const DEFAULT_POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '500');
/** 服务间 token。 */
const SERVICE_TOKEN = process.env.WS_PROXY_TOKEN ?? '';

/** 主循环运行标记。 */
let running = true;

/** Worker 健康统计。 */
export const workerHealth = {
  processed: 0, succeeded: 0, failed: 0, dead: 0, inProgress: 0,
};

/** 进程内站点并发分钟桶计数器。 */
const minuteCounters = new Map<string, number>();

/** 正在处理中的任务 ID 集合，防止并发重复处理。 */
const processingTasks = new Set<string>();

/** drawing-service 推送的任务队列（push 优先于 poll，减少延迟）。 */
const pushQueue: DrawingGenerateRequest[] = [];

/** 最大并发任务数 — 从环境变量读取，默认按站点并发上限。 */
const MAX_CONCURRENT = Number(process.env.WORKER_MAX_CONCURRENT ?? '20');
/** 参考图任务输入版上限；外部/data 来源转存前先压缩到 3MB 内。 */
const REFERENCE_TASK_INPUT_MAX_BYTES = Number(process.env.REFERENCE_TASK_INPUT_MAX_BYTES ?? String(3 * 1024 * 1024));
/** drawing-worker 接收历史外部参考图的原始上限；media-service 会再压缩为 3MB 任务输入版。 */
const REFERENCE_SOURCE_MAX_BYTES = Number(process.env.REFERENCE_SOURCE_UPLOAD_MAX_BYTES ?? String(20 * 1024 * 1024));
/** worker 到 media-service 的图片上传超时；二进制直传避免 base64 膨胀后仍给生成图留足时间。 */
const MEDIA_UPLOAD_TIMEOUT_MS = Number(process.env.WORKER_MEDIA_UPLOAD_TIMEOUT_MS ?? '30000');

/** 返回推送队列当前大小（用于健康检查）。 */
export function getPushQueueSize(): number { return pushQueue.length; }

/** 向推送队列添加任务（由 HTTP 端点调用）。最多缓存 20 个防止内存泄漏。 */
export function enqueuePushedTask(task: DrawingGenerateRequest): boolean {
  if (processingTasks.has(task.taskId) || pushQueue.some(t => t.taskId === task.taskId)) {
    return false; // 已在处理中或已在队列
  }
  if (pushQueue.length >= Number(process.env.WORKER_PUSH_QUEUE_MAX ?? '20')) return false;
  pushQueue.push(task);
  return true;
}

/**
 * 启动 drawing-worker 主循环。
 * 循环内每次迭代：拉取任务 → 抢占 → 执行 → 上报。
 */
export async function startDrawingWorkerLoop(): Promise<void> {
  const siteSelector = new SiteSelectionService({
    async get(siteId: number, _minuteBucket: string): Promise<number> {
      // 候选评估只读当前分钟负载，不占用未选站点的并发配额。
      const redisCount = await getSiteMinute(siteId);
      if (redisCount !== null) return redisCount;
      const key = `site-${siteId}-${_minuteBucket}`;
      return minuteCounters.get(key) ?? 0;
    },
    async tryAcquire(siteId: number, _minuteBucket: string, allowedConcurrency: number): Promise<number | null> {
      // 最终选中后才尝试占用配额；Redis 不可用时降级为进程内计数，保证单 Worker 下仍有保护。
      const redisCount = await tryAcquireSiteMinute(siteId, allowedConcurrency);
      if (redisCount !== undefined) return redisCount;
      const key = `site-${siteId}-${_minuteBucket}`;
      const current = (minuteCounters.get(key) ?? 0) + 1;
      if (allowedConcurrency > 0 && current > allowedConcurrency) return null;
      minuteCounters.set(key, current);
      setTimeout(() => minuteCounters.delete(key), 120_000);
      return current;
    },
  });

  const orchestrator = new RetryOrchestrator(siteSelector);
  let retryConfig = await getDefaultRetryConfig();
  // 从配置获取轮询间隔
  let pollMs = DEFAULT_POLL_MS;
  let staleTaskMinutes = 30;
  try {
    const cfg = await fetchDrawingConfig();
    if (cfg?.pollIntervalMs) pollMs = Number(cfg.pollIntervalMs);
    if (cfg?.staleTaskMinutes) staleTaskMinutes = Number(cfg.staleTaskMinutes);
  } catch { /* 使用默认值 */ }

  console.log('[drawing-worker] Worker 主循环已启动，轮询间隔', pollMs, 'ms，超时', staleTaskMinutes, '分钟');

  // 每 60 秒刷新一次配置（管理后台修改后自动生效）
  let lastConfigRefresh = Date.now();
  const CONFIG_REFRESH_INTERVAL_MS = 60_000;

  while (running) {
    // 定期刷新运行时配置
    if (Date.now() - lastConfigRefresh > CONFIG_REFRESH_INTERVAL_MS) {
      try {
        retryConfig = await getDefaultRetryConfig();
        const cfg = await fetchDrawingConfig();
        if (cfg?.pollIntervalMs) pollMs = Number(cfg.pollIntervalMs);
        if (cfg?.staleTaskMinutes) staleTaskMinutes = Number(cfg.staleTaskMinutes);
      } catch { /* 保持旧配置 */ }
      lastConfigRefresh = Date.now();
    }
    try {
      // 步骤 0：清理过期 stuck 任务（Worker 崩溃恢复）
      cleanupStaleTasks(staleTaskMinutes).catch(() => { /* 清理失败不影响主流程 */ });

      // 步骤 1：优先消费 drawing-service 推送的任务队列，再轮询 backend
      let pendingTasks = drainPushQueue();
      if (pendingTasks.length === 0) {
        pendingTasks = await fetchPendingTasks();
      }
      // 限制每轮处理上限，与并发容量对齐
      const maxPerCycle = Number(process.env.WORKER_MAX_PER_CYCLE ?? String(MAX_CONCURRENT));
      if (pendingTasks.length > maxPerCycle) {
        pendingTasks = pendingTasks.slice(0, maxPerCycle);
      }
      if (pendingTasks.length === 0) {
        // 无待处理任务且无进行中任务时才休眠；有进行中任务时立即重试填充槽位
        if (processingTasks.size === 0) await sleep(pollMs);
        continue;
      }

      // 步骤 2：获取站点配置（优先从 backend 内部接口拉取）
      const sites = await fetchSiteConfigs();

      // 步骤 3-4：并行处理任务（受并发上限限制）
      const availableSlots = Math.max(0, MAX_CONCURRENT - processingTasks.size);
      const tasksToProcess = pendingTasks.slice(0, availableSlots);
      if (tasksToProcess.length === 0) {
        await sleep(pollMs);
        continue;
      }

      // 异步启动可用任务槽位后立即回到轮询，避免长耗时上游调用阻塞后续 pending 任务抢占。
      for (const taskReq of tasksToProcess) {
        void processOneTask(taskReq, sites, retryConfig, orchestrator).catch((error) => {
          console.warn('[drawing-worker] 单任务处理入口异常', error instanceof Error ? error.message : error);
        });
      }
    } catch (error) {
      // 外层 catch 防止单个异常导致 Worker 退出
      console.warn('[drawing-worker] 主循环异常，等待重试', error instanceof Error ? error.message : error);
      await sleep(pollMs);
    }
  }
}

/** 消费 drawing-service 推送的任务队列（一次性取出全部）。 */
function drainPushQueue(): DrawingGenerateRequest[] {
  if (pushQueue.length === 0) return [];
  const maxPerCycle = Number(process.env.WORKER_MAX_PER_CYCLE ?? '5');
  const tasks = pushQueue.splice(0, Math.min(maxPerCycle, pushQueue.length));
  if (tasks.length > 0) console.log(`[drawing-worker] 消费推送队列: ${tasks.length} 个任务`);
  return tasks;
}

async function fetchPendingTasks(): Promise<DrawingGenerateRequest[]> {
  try {
    const res = await fetch(`${BACKEND_URL}/internal/worker/pending-tasks`, {
      headers: { 'x-service-token': SERVICE_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { tasks: DrawingGenerateRequest[] } };
    return data.ok === true ? data.data?.tasks ?? [] : [];
  } catch {
    return [];
  }
}

/** 从 backend 拉取站点配置。 */
async function fetchSiteConfigs(): Promise<ApiSiteConfig[]> {
  try {
    const res = await fetch(`${BACKEND_URL}/internal/sites/config`, {
      headers: { 'x-service-token': SERVICE_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    // 站点配置使用共享契约，避免兼容开关在跨服务传递时被遗漏。
    const data = await res.json().catch(() => ({})) as Partial<ApiSiteRuntimeConfigResponse>;
    return data.ok === true ? data.data?.sites ?? [] : [];
  } catch {
    return [];
  }
}

/** 处理单个任务：抢占 → 执行 → 回写（由并发池调用） */
async function processOneTask(
  taskReq: DrawingGenerateRequest,
  sites: ApiSiteConfig[],
  retryConfig: Awaited<ReturnType<typeof getDefaultRetryConfig>>,
  orchestrator: RetryOrchestrator,
): Promise<void> {
  if (!running) return;
  if (processingTasks.has(taskReq.taskId)) return;

  // 抢占请求发出前先占用本进程任务槽，避免轮询过快时重复对同一任务发起 claim。
  processingTasks.add(taskReq.taskId);
  let claimed = false;

  try {
    claimed = await claimTask(taskReq.taskId);
    if (!claimed) return;

    workerHealth.inProgress++;
    workerHealth.processed++;

    const result = await orchestrator.execute(taskReq as unknown as DrawingGenerateRequest, sites, retryConfig);
    if (result.success) {
      let generatedFilenames: string[] = [];
      if (result.imageResult) {
        generatedFilenames = await saveGeneratedImage(
          taskReq.taskId,
          result.imageResult.imageBuffer,
          result.imageResult.mimeType,
          taskReq.size,
          taskReq.quality,
        );
      }
      if (result.videoResult) {
        const videoFilename = await saveGeneratedVideo(taskReq.taskId, result.videoResult.videoBuffer, {
          duration: taskReq.duration,
          resolution: taskReq.resolution,
          aspectRatio: taskReq.aspectRatio,
          requestId: result.videoResult.requestId,
        });
        if (videoFilename) generatedFilenames = [videoFilename];
      }
      if (!generatedFilenames[0]) {
        // 图片必须先落到本地暂存并回写业务记录；否则不能把任务算作成功，避免图库和 Bot 看到“成功但没图”。
        const saveError = taskReq.mode === 'text-to-video' || taskReq.mode === 'image-to-video' ? '生成视频保存失败' : '生成图片保存失败';
        workerHealth.failed++;
        await updateTaskStatus(taskReq.taskId, 'failed', saveError);
        await reportFinalize(taskReq.taskId, 'failed', saveError);
        return;
      }
      workerHealth.succeeded++;
      await reportResultReady(taskReq.taskId);
      if (taskReq.source === 'bot' && taskReq.mode !== 'text-to-video' && taskReq.mode !== 'image-to-video') {
        // Bot 任务需要等最终原图消息发送成功后才由 bot-service 回调标记 success；此阶段仍保留本地原图作为外显源。
        await updateTaskStatus(taskReq.taskId, 'finalizing');
        // Bot 参考图来源通常是 QQ 临时外链，必须在任务完成后转存为站内 ref_ 文件，避免网页详情页加载过期外链。
        void recordReferenceImages(taskReq).catch((error) => {
          console.warn(`[drawing-worker] Bot 任务参考图本地转存失败: ${taskReq.taskId}`, error instanceof Error ? error.message : error);
        });
      } else {
        // Web 任务没有主动推送步骤，图片元数据写入且 /images 本地可读后即可成功。
        await updateTaskStatus(taskReq.taskId, 'success');
        await reportFinalize(taskReq.taskId, 'success');
        void recordReferenceImages(taskReq).catch((error) => {
          console.warn(`[drawing-worker] 成功任务参考图本地转存失败: ${taskReq.taskId}`, error instanceof Error ? error.message : error);
        });
      }
    } else {
      workerHealth.failed++;
      // 失败收尾也写入同一条短原因，避免详情时间线末尾继续展示“重试次数已用完”等泛化错误。
      const failureSummary = summarizeGenerationFailure({
        taskError: result.attempts[result.attempts.length - 1]?.error ?? '所有重试均已用完',
        mode: taskReq.mode,
        subTasks: result.attempts.map((attempt) => ({
          kind: 'upstream_attempt',
          status: attempt.status,
          error: attempt.error,
        })),
      });
      await reportFinalize(taskReq.taskId, 'failed', failureSummary);
      // 失败任务同样需要在收尾后转存参考图，任务详情外显链路不能长期依赖 QQ 临时外链。
      void recordReferenceImages(taskReq).catch((error) => {
        console.warn(`[drawing-worker] 失败任务参考图本地转存失败: ${taskReq.taskId}`, error instanceof Error ? error.message : error);
      });
    }
  } catch (error) {
    workerHealth.failed++;
    workerHealth.dead++;
    const errorMsg = error instanceof Error ? error.message : 'Worker 执行异常';
    await finalizeTask(taskReq.taskId, 'failed', errorMsg);
  } finally {
    if (claimed) workerHealth.inProgress--;
    processingTasks.delete(taskReq.taskId);
  }
}

/** 记录结果已可外显：原图和缩略图已保存在本地暂存，Bot/Web 可以通过 /images 读取。 */
async function reportResultReady(taskId: string): Promise<void> {
  try {
    await reportSubTask(taskId, 'result_ready', 'success', {
      finishedAt: new Date().toISOString(),
    });
  } catch {
    console.warn(`[drawing-worker] result-ready 回写失败: ${taskId}`);
  }
}

/** 条件更新抢占任务。 */
async function claimTask(taskId: string): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/internal/worker/claim-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
      body: JSON.stringify({ taskId }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { claimed: boolean } };
    return (data.ok === true && data.data?.claimed === true);
  } catch {
    return false;
  }
}

/** 仅追加 finalize 子任务（状态已由 orchestrator 更新）。 */
async function reportFinalize(taskId: string, status: 'success' | 'failed', error?: string): Promise<void> {
  try {
    await fetch(`${BACKEND_URL}/internal/worker/report-finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
      body: JSON.stringify({ taskId, status, error }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.warn(`[drawing-worker] report-finalize 失败: ${taskId}`);
  }
}

/** 向 backend 请求清理过期 stuck 的 running 任务（Worker 崩溃恢复）。 */
async function cleanupStaleTasks(staleMinutes: number): Promise<void> {
  if (staleMinutes <= 0) return;
  try {
    await fetch(`${BACKEND_URL}/internal/worker/cleanup-stale`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
      body: JSON.stringify({ staleTaskMinutes: staleMinutes }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* 清理失败不阻塞主循环 */ }
}

/** 回写任务最终状态 + 追加 finalize 子任务（异常兜底，orchestrator 未更新状态）。 */
async function finalizeTask(taskId: string, status: 'success' | 'failed', error?: string): Promise<void> {
  try {
    await fetch(`${BACKEND_URL}/internal/worker/finalize-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
      body: JSON.stringify({ taskId, status, error }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.warn(`[drawing-worker] finalize 失败: ${taskId}`);
  }
}

/** 通过 media-service 保存生成图片，生成缩略图，回写文件名到 backend。 */
async function saveGeneratedImage(taskId: string, imageBuffer: Buffer, mimeType: string, size?: string, quality?: string): Promise<string[]> {
  const MEDIA_URL = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
  try {
    // 步骤 1：二进制直传原图到 media-service；不传 maxBytes，确保最终生成原图不被压缩。
    const uploadData = await uploadMediaImage({
      buffer: imageBuffer,
      mimeType,
      prefix: 'img_',
      timeoutMs: MEDIA_UPLOAD_TIMEOUT_MS,
    });
    const imageFilename = uploadData.filename;

    // 步骤 2：生成缩略图
    let thumbnailFilename = '';
    if (imageFilename) {
      try {
        const thumbRes = await fetch(`${MEDIA_URL}/media/generate-thumbnail`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
          body: JSON.stringify({ sourceFilename: imageFilename }),
          signal: AbortSignal.timeout(10000),
        });
        const thumbData = await thumbRes.json().catch(() => ({})) as { ok?: boolean; data?: { filename: string } };
        thumbnailFilename = thumbData.data?.filename ?? '';
      } catch (e) { console.warn(`[drawing-worker] 缩略图生成失败: ${taskId}`, e instanceof Error ? e.message : e); }
    }

    // 步骤 3：回写图片文件名到 backend 任务记录
    if (imageFilename) {
      try {
        await fetch(`${BACKEND_URL}/internal/worker/report-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
          body: JSON.stringify({ taskId, imageFilename, thumbnailFilename, size: size || null, quality: quality || null }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) { console.warn(`[drawing-worker] report-image 失败: ${taskId}`, e instanceof Error ? e.message : e); }
    }

    // 生成图原图当前只保存在本地媒体目录，上传时不传 maxBytes，禁止压缩最终原图。
    console.log(`[drawing-worker] 图片已保存: ${taskId} → ${imageFilename}`);
    return [imageFilename, thumbnailFilename].filter(Boolean);
  } catch (error) {
    console.warn(`[drawing-worker] 图片保存失败: ${taskId}`, error instanceof Error ? error.message : error);
    return [];
  }
}

/** 保存生成视频并回写 backend；只有 media-service 和任务配置均成功才返回文件名。 */
async function saveGeneratedVideo(
  taskId: string,
  videoBuffer: Buffer,
  metadata: { duration?: number; resolution?: string; aspectRatio?: string; requestId: string },
): Promise<string> {
  try {
    const uploadData = await uploadMediaVideo({ buffer: videoBuffer, timeoutMs: Math.max(MEDIA_UPLOAD_TIMEOUT_MS, 60000) });
    const response = await fetch(`${BACKEND_URL}/internal/worker/report-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
      body: JSON.stringify({ taskId, videoFilename: uploadData.filename, thumbnailFilename: uploadData.thumbnailFilename, ...metadata }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string; data?: { saved?: boolean } };
    if (!response.ok || body.ok !== true || body.data?.saved !== true) {
      throw new Error(body.message || `视频任务回写失败：HTTP ${response.status}`);
    }
    console.log(`[drawing-worker] 视频已保存: ${taskId} → ${uploadData.filename}`);
    return uploadData.filename;
  } catch (error) {
    console.warn(`[drawing-worker] 视频保存失败: ${taskId}`, error instanceof Error ? error.message : error);
    return '';
  }
}

/** 转存用户上传的参考图：上传到 media-service 的本地 ref_ 文件并回写 backend。
 *  外部 API 在任务期间始终拿到原始输入；任务结束后每个参考图仅保留一个站内本地文件，不另外生成缩略图。 */
async function recordReferenceImages(taskReq: DrawingGenerateRequest): Promise<void> {
  const sourceImageUrls = taskReq.sourceImageUrls ?? [];
  if (sourceImageUrls.length === 0) return;

  const orderedFilenames: string[] = [];
  const localStatuses: ReferenceLocalStatus[] = [];

  for (const imageUrl of sourceImageUrls) {
    try {
      // 解码 base64 data URL（参考图在 DB 中是 data:image/...;base64,... 格式）
      let buffer: Buffer;
      let mimeType = 'image/png';
      if (imageUrl.startsWith('data:')) {
        const match = imageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          buffer = Buffer.from(match[2], 'base64');
        } else {
          continue; // 无法解析的跳过
        }
      } else if (imageUrl.startsWith('/images/')) {
        // 已预上传到 media-service 的参考图：直接记录本地短文件名。
        const filename = imageUrl.replace('/images/', '');
        const cleanFilename = extractSafeMediaFilename(filename);
        if (!cleanFilename) continue;
        orderedFilenames.push(cleanFilename);
        localStatuses.push(buildLocalReferenceStatus(cleanFilename));
        continue;
      } else if (!imageUrl.startsWith('data:') && !imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        // 纯文件名（前端预上传本地暂存），当前同样只保留本地短文件名。
        const cleanFilename = extractSafeMediaFilename(imageUrl);
        if (!cleanFilename) continue;
        orderedFilenames.push(cleanFilename);
        localStatuses.push(buildLocalReferenceStatus(cleanFilename));
        continue;
      } else {
        // URL（非 data:），下载后上传
        try {
          const downloaded = await downloadImageWithLimit({
            url: imageUrl,
            headers: buildExternalImageFetchHeaders(imageUrl),
            maxBytes: REFERENCE_SOURCE_MAX_BYTES,
            timeoutMs: 15000,
          });
          buffer = downloaded.buffer;
          mimeType = downloaded.mimeType;
        } catch { continue; }
      }

      if (buffer.length === 0 || buffer.length > REFERENCE_SOURCE_MAX_BYTES) continue;

      // 外部或 data 来源先生成 <=3MB task_input，并作为长期本地参考图使用；这里同样走二进制直传。
      const uploadData = await uploadMediaImage({
        buffer,
        mimeType,
        prefix: 'ref_',
        maxBytes: REFERENCE_TASK_INPUT_MAX_BYTES,
        timeoutMs: MEDIA_UPLOAD_TIMEOUT_MS,
      });
      const refFilename = uploadData.filename;
      if (refFilename) {
        const cleanFilename = extractSafeMediaFilename(refFilename);
        if (!cleanFilename) continue;
        orderedFilenames.push(cleanFilename);
        localStatuses.push(buildLocalReferenceStatus(cleanFilename, uploadData));
      }
    } catch { /* 单张参考图转存失败继续处理下一张。 */ }
  }

  // 回写完整参考图顺序到 backend；本地转存失败只影响状态，不允许把原始参考图列表压缩成成功子集。
  if (orderedFilenames.length > 0) {
    try {
      await fetch(`${BACKEND_URL}/internal/worker/report-ref-images`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
        body: JSON.stringify({ taskId: taskReq.taskId, filenames: orderedFilenames, statuses: localStatuses }),
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[drawing-worker] 参考图已回写: ${taskReq.taskId} → ${orderedFilenames.length} 张本地文件`);
    } catch { /* 回写失败不阻断 */ }
  }
}

type ReferenceLocalStatus = {
  filename: string;
  status: 'local' | 'missing';
  stored: boolean;
  originalSize?: number;
  size?: number;
  compressed?: boolean;
  storedAt?: string;
  error?: string;
};

/** 构建参考图本地存储状态；用于详情页和运维读取统一状态快照。 */
function buildLocalReferenceStatus(
  filename: string,
  uploadData?: { size?: number; originalSize?: number; compressed?: boolean },
): ReferenceLocalStatus {
  return {
    filename,
    status: 'local',
    stored: true,
    originalSize: uploadData?.originalSize,
    size: uploadData?.size,
    compressed: uploadData?.compressed === true,
    storedAt: new Date().toISOString(),
  };
}

/** 提取安全短文件名，兼容 /images/name 和纯短文件名。 */
function extractSafeMediaFilename(value: string): string {
  const candidate = value.trim().replace(/^\/images\//, '').split(/[?#]/, 1)[0] ?? '';
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(candidate) && !candidate.includes('..') && !candidate.includes('/') && !candidate.includes('\\')
    ? candidate
    : '';
}

/** 下载外部参考图时按来源补充必要请求头；QQ 临时图片缺少 Referer/User-Agent 时可能无法稳定下载。 */
function buildExternalImageFetchHeaders(imageUrl: string): Record<string, string> {
  try {
    const host = new URL(imageUrl).hostname;
    if (host === 'qq.com' || host.endsWith('.qq.com') || host === 'qpic.cn' || host.endsWith('.qpic.cn')) {
      return {
        Referer: 'https://qun.qq.com/',
        'User-Agent': 'Mozilla/5.0 DrawHimeBot/3.0',
      };
    }
  } catch { /* URL 解析失败时不附加来源头。 */ }
  return {};
}

/** 停止 Worker 主循环。 */
export function stopDrawingWorkerLoop(): void {
  running = false;
}

/** 注册优雅关闭信号处理 */
export function registerGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    console.log(`[drawing-worker] 收到 ${signal}，等待当前任务完成...`);
    running = false;
    // 给当前任务最多 30 秒完成
    setTimeout(() => {
      console.log('[drawing-worker] 强制退出');
      process.exit(0);
    }, 30_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** 返回运行状态。 */
export function isWorkerRunning(): boolean {
  return running;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
