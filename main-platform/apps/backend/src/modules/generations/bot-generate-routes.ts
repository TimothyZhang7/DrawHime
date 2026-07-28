/**
 * 本文件注册 Bot 绘图内部接口：bot-service 调用 backend 创建任务 + 扣费 + 投递 drawing-service。
 * Bot 侧不需要自己处理余额和绑定，统一走 backend 受保护接口。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, isDrawingAspectRatio, type BotAdminRuntimeConfig, type BotBatchResultResponse, type BotCommandConfig, type BotDeliveryTarget, type BotFinalizingTaskRecoveryResponse, type BotGenerationCreateRequest, type BotGenerationStatsBucket, type BotGenerationStatsResponse, type BotPendingBatchResultsResponse, type DrawingAspectRatio, type DrawingGenerateRequest, type DrawingMode, type DrawingVideoResolution } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { randomBytes } from 'node:crypto';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { submitDrawingTask } from '../../infrastructure/http/drawing-client.js';
import { WalletService } from '../wallet/wallet-service.js';
import { WalletError } from '../wallet/wallet-types.js';
import { GenerationsRepository } from './generations-repository.js';
import { GenerationsService } from './generations-service.js';
import {
  invalidateGalleryCache,
  invalidateTaskCache,
  invalidateWalletCache,
  setBackendCacheHeader,
} from '../../shared/cache/cache-service.js';
import { cacheInternalBotCommands } from '../../shared/cache/cache-policies.js';
import { assertGenerationSourceImagesAvailable, normalizeGenerationSourceImageUrls, SourceImageUnavailableError } from './source-image-utils.js';
import { readBotAdminQqNumbers } from '../bot/bot-admin-config.js';
import { resolveConfiguredModelMaxAttempts, resolveConfiguredModelName, resolveConfiguredModelPromptFormat, resolveConfiguredModelReferencePromptAssistEnabled, resolveConfiguredModelStoryboardEnabled } from './model-settings-service.js';
import { GalleryTaggingService } from '../gallery/gallery-tagging-service.js';
import { VideoStoryboardError, VideoStoryboardService } from './video-storyboard-service.js';
import { REFERENCE_PROMPT_ASSIST_MAX_IMAGES } from './reference-prompt-assist-service.js';
import { readEnabledModelNames } from './generation-model-utils.js';

const prisma = getPrismaClient();
const walletService = new WalletService();
const generationsRepository = new GenerationsRepository(prisma);
const generationsService = new GenerationsService();
const galleryTaggingService = new GalleryTaggingService();
const videoStoryboardService = new VideoStoryboardService(prisma);

/** drawing-service 地址（启动级配置，通过环境变量设置） */
const DRAWING_URL = process.env.DRAWING_SERVICE_URL ?? 'http://localhost:3005';
/** 默认单次生成价格从配置读取（管理后台 > env > 0.05） */
const DEFAULT_PRICE = Number.parseFloat(process.env.DRAWING_PRICE_PER_GEN ?? '0.05');

export function createBotGenerateRoutes(): Route[] {
  return [
    { method: 'POST', path: '/internal/bot/generate', handle: botGenerate },
    { method: 'POST', path: '/internal/bot/tasks/:taskId/delivered', handle: markBotTaskDelivered },
    { method: 'GET', path: '/internal/bot/batches/:batchId/result', handle: getBotBatchResult },
    { method: 'GET', path: '/internal/bot/pending-batches', handle: listPendingBotBatches },
    { method: 'POST', path: '/internal/bot/batches/:batchId/notification-claim', handle: claimBotBatchNotification },
    { method: 'POST', path: '/internal/bot/batches/:batchId/notification-sent', handle: markBotBatchNotificationSent },
    { method: 'GET', path: '/internal/bot/finalizing-tasks', handle: listFinalizingBotTasks },
    { method: 'GET', path: '/internal/bot/commands', handle: botCommands },
    { method: 'GET', path: '/internal/bot/admin-config', handle: botAdminConfig },
    { method: 'GET', path: '/internal/bot/site-stats', handle: botSiteStats },
    { method: 'GET', path: '/internal/bot/stats', handle: botGenerationStats },
  ];
}

/**
 * Bot 绘图入口：bot-service 通过本接口提交生成任务。
 * 流程：读取可选 QQ 绑定 → 按 QQ 扣费 → 创建主任务 → 投递 drawing-service → 返回任务信息。
 */
async function botGenerate(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }

  const body = await readJsonBody(req) as Partial<BotGenerationCreateRequest>;
  const qqStr = String(body.qqNumber ?? '').trim();
  const botSelfId = normalizeBotSelfId(body.botSelfId);
  const deliveryTarget = normalizeBotDeliveryTarget(body.deliveryTarget);
  const prompt = String(body.prompt ?? '').trim();
  const mode = normalizeBotDrawingMode(body.mode);
  const isVideoTask = mode === 'text-to-video' || mode === 'image-to-video';
  const sourceImageUrls = normalizeGenerationSourceImageUrls(body.sourceImageUrls);
  const referencePromptAssistRequested = mode === 'text-to-image' && body.referencePromptAssist === true;
  const count = isVideoTask ? 1 : await normalizeBotGenerationCount(body.count);

  if (!/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }
  if (!prompt) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '提示词不能为空' });
  }
  if (body.botSelfId !== undefined && !botSelfId) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'Bot selfId 格式不正确' });
  }
  if (body.deliveryTarget !== undefined && !deliveryTarget) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'Bot 投递目标格式不正确' });
  }
  if (isVideoTask && body.count !== undefined && body.count !== 1) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '视频任务每次只能生成 1 个结果' });
  }
  if (isVideoTask && (!Number.isSafeInteger(body.duration) || Number(body.duration) < 1 || Number(body.duration) > 15
    || !isBotVideoResolution(body.resolution)
    || !isBotVideoAspectRatio(body.aspectRatio))) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '视频参数不正确：时长 1-15 秒，分辨率 480p/720p/1080p，并使用支持的显式画幅' });
  }
  const maxPromptRow = await prisma.systemConfig.findUnique({ where: { key: 'drawing_max_prompt_length' }, select: { value: true } });
  const maxPrompt = Number(maxPromptRow?.value ?? '5000') || 5000;
  if (prompt.length > maxPrompt) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: `提示词过长（最多 ${maxPrompt} 字符）` });
  }
  if ((mode === 'image-to-image' || mode === 'image-to-video') && sourceImageUrls.length === 0) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: mode === 'image-to-video' ? '参考图视频至少需要 1 张参考图' : '图生图至少需要 1 张参考图' });
  }
  if (mode === 'text-to-video' && sourceImageUrls.length > 0) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '当前生成模式不接收参考图' });
  if (mode === 'text-to-image' && sourceImageUrls.length > REFERENCE_PROMPT_ASSIST_MAX_IMAGES) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: `AI 提示增强最多接受 ${REFERENCE_PROMPT_ASSIST_MAX_IMAGES} 张参考图` });
  }
  try {
    // Bot 本地化后的站内参考图必须在扣费前可读，避免清理竞态导致任务创建后立刻失败。
    await assertGenerationSourceImagesAvailable(sourceImageUrls);
  } catch (error) {
    if (error instanceof SourceImageUnavailableError) {
      return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error.message });
    }
    throw error;
  }

  const qqNumber = BigInt(qqStr);

  // 步骤 1：读取 QQ 绑定信息；Bot 绘图以 QQ 为余额归属，未绑定网页账号也允许生成。
  const binding = await prisma.qqBinding.findUnique({
    where: { qqNumber },
    select: { userId: true, verified: true, user: { select: { username: true } } },
  });
  const privacyPref = await prisma.qqImagePrivacyPref.findUnique({
    where: { qqNumber },
    select: { isPrivate: true },
  });
  // Bot 任务的公开/私密状态必须在创建任务时落库，并随提交响应返回，确保 QQ 回执展示真实任务状态。
  const isPrivate = privacyPref?.isPrivate ?? false;

  let chargeResult: { chargedSource: string; chargedAmount: string; freeUsed: string; paidUsed: string; freeBalance: string; paidBalance: string } | undefined;
  // 步骤 2：准备主任务 ID（短 ID：b_{ts36}_{r4}_{qq6}）
  const ts36 = Date.now().toString(36);
  const r4 = randomBytes(2).toString('hex');
  const taskId = `b_${ts36}_${r4}_${qqStr.slice(-6)}`;
  const clientRequestId = taskId;
  let effectivePrompt = prompt;

  try {
    const generationParams = await readBotGenerationParams(body as Record<string, unknown>);
    const enabledMainModels = await readEnabledModelNames(prisma);
    // 普通 Bot 绘图不得回流主站 ComfyUI；本地模型由独立平台的 Bot 路由负责。
    if (!generationParams.preferredModel || !enabledMainModels.has(generationParams.preferredModel)) {
      return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '当前模型在主站不可用；本地模型请使用独立平台命令' });
    }
    const [referencePromptAssistEnabled, promptFormat] = await Promise.all([
      resolveConfiguredModelReferencePromptAssistEnabled(prisma, generationParams.preferredModel),
      resolveConfiguredModelPromptFormat(prisma, generationParams.preferredModel),
    ]);
    if (body.referencePromptAssist === true && mode !== 'text-to-image') {
      return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'AI 提示增强只适用于文生图任务' });
    }
    if (referencePromptAssistRequested && !referencePromptAssistEnabled) {
      return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '当前文生图模型未开放 AI 提示增强' });
    }
    // Bot 对已开放模型默认开启；显式 false 仅用于内部兼容和排障。
    const referencePromptAssist = mode === 'text-to-image'
      && referencePromptAssistEnabled
      && body.referencePromptAssist !== false;
    if (mode === 'text-to-image' && sourceImageUrls.length > 0 && !referencePromptAssist) {
      return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '当前生成模式不接收参考图' });
    }
    const storyboardDesignEnabled = isVideoTask
      && body.storyboardDesign !== false
      && await resolveConfiguredModelStoryboardEnabled(prisma, generationParams.preferredModel);
    if (storyboardDesignEnabled) {
      // Bot 视频默认开启分镜；分镜失败发生在事务前，不创建任务也不扣 QQ 钱包。
      effectivePrompt = await videoStoryboardService.redesign({
        prompt,
        sourceImageUrls,
        duration: Number(generationParams.duration),
        aspectRatio: String(generationParams.aspectRatio),
        resolution: String(generationParams.resolution),
        maxPromptLength: maxPrompt,
      });
    }
    // QQ 与网页统一：增强任务先持久化并立即返回，AI 调用在任务时间线内异步执行一次。
    const promptAssistPending = referencePromptAssist;
    const fallbackPrice = Number(await readConfigString('drawing_price_per_gen', String(DEFAULT_PRICE)));
    // Bot 与 Web 必须按同一独立模型价格扣费，历史全局价格只作为未登记模型兜底。
    const modelPrice = await generationsRepository.resolveGenerationPrice({
      model: generationParams.preferredModel,
      mode,
      basePrice: fallbackPrice,
    });
    if (count > 1) {
      const batchId = taskId;
      const taskIds = createBatchTaskIds(batchId, count);
      const [{ preferredModel, size, quality, maxAttempts }, concurrency, stopAfterConsecutiveFailures] = await Promise.all([
        Promise.resolve(generationParams),
        readBoundedConfigNumber('drawing_multi_concurrency', 2, 1, count),
        readBoundedConfigNumber('drawing_multi_stop_after_consecutive_failures', 2, 1, count),
      ]);
      const batchResult = await generationsRepository.createBatchIdempotently({
        userId: binding?.verified ? binding.userId : null,
        qqNumber,
        source: 'bot',
        clientRequestId,
        batchId,
        taskIds,
        body: {
          mode,
          // 增强期间先保存用户原始提示词；成功后由统一异步链路原子替换为实际上游提示词。
          prompt: effectivePrompt,
          sourceImageUrls,
          isPrivate,
          model: preferredModel,
          size,
          quality,
          duration: generationParams.duration,
          resolution: generationParams.resolution,
          aspectRatio: generationParams.aspectRatio,
          storyboardDesign: storyboardDesignEnabled,
          count,
        },
        defaultImagePrivate: isPrivate,
        price: modelPrice,
        count,
        concurrency,
        stopAfterConsecutiveFailures,
        maxAttempts,
        effectivePrompt: undefined,
        referencePromptAssist,
        promptFormat,
        promptAssistPending,
      });
      if (botSelfId) {
        const routeSnapshot = { botSelfId, deliveryTarget, batchId, createdAt: new Date().toISOString() };
        await prisma.$transaction(async (tx) => {
          for (const item of batchResult.tasks) {
            await tx.systemConfig.upsert({
              where: { key: buildBotDeliveryRouteKey(item.id) },
              update: { value: JSON.stringify({ ...routeSnapshot, batchIndex: item.batchIndex }) },
              create: { key: buildBotDeliveryRouteKey(item.id), value: JSON.stringify({ ...routeSnapshot, batchIndex: item.batchIndex }) },
            });
          }
        });
      }
      const charged = await readLatestBotChargeSnapshot(batchResult.tasks.map((item) => item.id), qqNumber);
      if (batchResult.created && referencePromptAssist) {
        // 批次只执行一次共享增强，主任务已创建，QQ 提交回执不等待外部 AI。
        void generationsService.runPromptAssistAndDispatch(batchResult.tasks, {
          mode,
          prompt,
          sourceImageUrls,
          isPrivate,
          model: preferredModel,
          size,
          aspectRatio: generationParams.aspectRatio,
          quality,
          duration: generationParams.duration,
          resolution: generationParams.resolution,
          count,
          referencePromptAssist: true,
        }, promptFormat, maxAttempts, batchId);
      } else if (!referencePromptAssist) {
        for (const task of batchResult.tasks.filter((item) => item.status === 'queued')) {
          submitDrawingTask({
            taskId: task.id,
            clientRequestId: task.clientRequestId,
            source: 'bot',
            mode,
            prompt: effectivePrompt,
            qqNumber: qqStr,
            userId: binding?.verified ? binding.userId : undefined,
            sourceImageUrls,
            isPrivate,
            asyncSubmit: true,
            preferredModel,
            maxAttempts,
            size,
            quality,
          }).catch(() => { /* 投递失败降级到 worker polling */ });
        }
      }
      invalidateWalletCache([`qq:${qqStr}`, ...(binding?.verified ? [`user:${binding.userId}`] : [])]);
      invalidateTaskCache(batchResult.tasks.map((item) => item.id), ['task-list:admin']);
      return sendJson(res, 202, {
        ok: true,
        data: {
          accepted: true,
          taskId: batchResult.tasks[0].id,
          batchId,
          batchTotal: count,
          taskIds: batchResult.tasks.map((item) => item.id),
          clientRequestId,
          status: batchResult.tasks[0].status,
          charged: charged.amount > 0,
          chargedSource: charged.source,
          chargedAmount: charged.amount.toFixed(2),
          paidBalance: charged.paidBalance,
          freeBalance: charged.freeBalance,
          mode,
          prompt: prompt.slice(0, 200),
          preferredModel,
          maxAttempts,
          isPrivate,
          imageCount: sourceImageUrls.length,
          qqNumber: qqStr,
          bindingUsername: binding?.verified ? binding?.user?.username ?? null : null,
          bindingUserId: binding?.verified ? binding?.userId ?? null : null,
        },
      });
    }

    // 步骤 3：创建主任务 + 钱包扣费 + 分账记录必须在同一事务，避免失败后依赖补偿退款。
    const task = await prisma.$transaction(async (tx) => {
      const receivedAt = new Date();
      const created = await tx.generationTask.create({
        data: {
          id: taskId,
          clientRequestId,
          userId: binding?.userId ?? null,
          source: 'bot',
          mode,
          // 异步增强完成前保存用户原文，成功后统一固化实际提交提示词。
          prompt: effectivePrompt,
          qqNumber,
          // Bot 入口同样按确定性键去重，避免同一 QQ 图被多种 URL 形式重复扣入任务参考图。
          sourceImageUrls,
          isPrivate,
          status: promptAssistPending ? 'running' : 'queued',
          startedAt: promptAssistPending ? receivedAt : undefined,
          subTasks: {
            create: [
              { sequence: 1, kind: 'request_received', status: 'success', startedAt: receivedAt, finishedAt: receivedAt },
              ...(promptAssistPending ? [{
                sequence: 2,
                kind: 'prompt_assist',
                status: 'running',
                startedAt: receivedAt,
              }] : []),
            ],
          },
        },
        select: { id: true },
      });
      if (botSelfId) {
        // 关键投递链路：记录创建任务的 Bot selfId，服务重启或异步直推失败后仍能按原 Bot 补发最终图。
        await tx.systemConfig.upsert({
          where: { key: buildBotDeliveryRouteKey(created.id) },
          update: { value: JSON.stringify({ botSelfId, deliveryTarget, createdAt: new Date().toISOString() }) },
          create: { key: buildBotDeliveryRouteKey(created.id), value: JSON.stringify({ botSelfId, deliveryTarget, createdAt: new Date().toISOString() }) },
        });
      }
      const dispatchParams = JSON.stringify({
        model: generationParams.preferredModel,
        size: generationParams.size,
        quality: generationParams.quality,
        maxAttempts: generationParams.maxAttempts,
        duration: generationParams.duration,
        resolution: generationParams.resolution,
        aspectRatio: generationParams.aspectRatio,
        storyboardDesign: storyboardDesignEnabled,
        effectivePrompt: undefined,
        referencePromptAssist,
        promptFormat,
        count: 1,
      });
      // Bot 单图也必须在任务创建事务内固化调度参数；否则 worker 轮询兜底可能抢在 drawing-service 推送前执行并回退站点默认模型。
      await tx.systemConfig.upsert({
        where: { key: buildTaskGenerationParamsKey(created.id) },
        update: { value: dispatchParams },
        create: { key: buildTaskGenerationParamsKey(created.id), value: dispatchParams },
      });
      chargeResult = await walletService.chargeForGenerationTx(tx, {
        actor: 'bot',
        qqNumber,
        userId: binding?.userId ?? undefined,
        taskId: created.id,
        amount: modelPrice,
        source: 'bot',
      });
      return tx.generationTask.update({
        where: { id: created.id },
        data: {
          chargedSource: chargeResult.chargedSource,
          chargedAmount: chargeResult.chargedAmount,
          chargedFreeAmount: chargeResult.freeUsed,
          chargedPaidAmount: chargeResult.paidUsed,
        },
        select: { id: true, clientRequestId: true, status: true },
      });
    // 钱包可能由并发请求首次创建；ReadCommitted 可在唯一键冲突后回读已提交钱包，扣费仍由 FOR UPDATE 串行化。
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });

    if (!chargeResult) throw new Error('钱包扣费结果缺失');
    const charged = chargeResult;

    // 步骤 4：增强任务进入统一异步链路；普通任务直接投递 drawing-service。
    const { preferredModel, size, quality, maxAttempts, duration, resolution, aspectRatio } = generationParams;
    if (referencePromptAssist) {
      // 任务和扣费已经落库，调用方会立即收到 running；增强成功后才创建绘图调度记录。
      void generationsService.runPromptAssistAndDispatch([task], {
        mode,
        prompt,
        sourceImageUrls,
        isPrivate,
        model: preferredModel,
        size,
        quality,
        duration,
        resolution,
        aspectRatio,
        count: 1,
        referencePromptAssist: true,
      }, promptFormat, maxAttempts);
    } else {
      submitDrawingTask({
        taskId,
        clientRequestId,
        source: 'bot',
        mode,
        prompt: effectivePrompt,
        qqNumber: qqStr,
        sourceImageUrls,
        isPrivate,
        asyncSubmit: true,
        preferredModel,
        maxAttempts,
        size,
        quality,
        duration,
        resolution,
        aspectRatio,
      }).catch(() => { /* 投递失败降级到 worker polling */ });
    }

    // Bot 创建任务会扣 QQ 可访问余额，并改变任务列表和内部轮询结果。
    invalidateWalletCache([`qq:${qqStr}`, ...(binding?.userId ? [`user:${binding.userId}`] : [])]);
    invalidateTaskCache([taskId], ['task-list:admin']);

    return sendJson(res, 202, {
      ok: true,
      data: {
        accepted: true,
        taskId: task.id,
        clientRequestId: task.clientRequestId,
        status: task.status,
        charged: Number(charged.chargedAmount) > 0,
        chargedSource: charged.chargedSource,
        chargedAmount: charged.chargedAmount,
        paidBalance: charged.paidBalance,
        freeBalance: charged.freeBalance,
        mode,
        prompt: prompt.slice(0, 200),
        preferredModel,
        maxAttempts,
        duration,
        resolution,
        aspectRatio,
        isPrivate,
        imageCount: sourceImageUrls.length,
        qqNumber: qqStr,
        bindingUsername: binding?.user?.username ?? null,
        bindingUserId: binding?.userId ?? null,
      },
    });
  } catch (error) {
    if (error instanceof VideoStoryboardError) {
      return sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: error.message });
    }
    if (error instanceof WalletError) {
      return sendJson(res, error.kind === 'insufficient_balance' ? 402 : 400, {
        ok: false,
        code: error.kind === 'insufficient_balance' ? 'insufficient_balance' : ApiErrorCode.BadRequest,
        message: error.message,
        details: error.details,
      });
    }
    throw error;
  }
}

/** 规范化 Bot 多图张数；关闭多图或非法值时回退单图，后端始终是最终限制。 */
async function normalizeBotGenerationCount(value: unknown): Promise<number> {
  const requested = Number.isSafeInteger(value) ? Number(value) : 1;
  const enabled = await readConfigString('drawing_multi_enabled', 'true');
  if (requested <= 1 || enabled === 'false') return 1;
  const max = await readBoundedConfigNumber('drawing_multi_count_max', 4, 1, 20);
  return Math.min(Math.max(requested, 1), max);
}

/** 读取受限数字配置，避免异常后台值造成批次释放过多任务。 */
async function readBoundedConfigNumber(key: string, fallback: number, min: number, max: number): Promise<number> {
  const raw = await readConfigString(key, String(fallback));
  const parsed = Number(raw);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : fallback, min), max);
}

/** 读取 system_configs 字符串配置。 */
async function readConfigString(key: string, fallback: string): Promise<string> {
  const row = await prisma.systemConfig.findUnique({ where: { key }, select: { value: true } });
  return row?.value ?? fallback;
}

/** 读取 Bot 创建请求中的模型、图片参数和视频参数；缺失图片参数时回退系统默认配置。 */
async function readBotGenerationParams(raw: Record<string, unknown>): Promise<{ preferredModel?: string; size: string; aspectRatio?: DrawingAspectRatio; quality: string; maxAttempts: number; duration?: number; resolution?: DrawingVideoResolution }> {
  const [resolvedModel, defaultSize, defaultQuality] = await Promise.all([
    resolveConfiguredModelName(prisma, typeof raw.preferredModel === 'string' ? raw.preferredModel : undefined),
    readConfigString('drawing_default_size', 'auto'),
    readConfigString('drawing_default_quality', 'auto'),
  ]);
  const maxAttempts = await resolveConfiguredModelMaxAttempts(prisma, resolvedModel);
  return {
    // Bot 输入可以是真实模型 ID、外显名或别名；空值走后台模型设置中的默认模型。
    preferredModel: resolvedModel,
    size: typeof raw.size === 'string' && raw.size.trim() ? raw.size : defaultSize || 'auto',
    aspectRatio: isDrawingAspectRatio(raw.aspectRatio) ? raw.aspectRatio : undefined,
    quality: typeof raw.quality === 'string' && raw.quality.trim() ? raw.quality : defaultQuality || 'auto',
    maxAttempts,
    duration: Number.isSafeInteger(raw.duration) && Number(raw.duration) >= 1 && Number(raw.duration) <= 15 ? Number(raw.duration) : undefined,
    resolution: isBotVideoResolution(raw.resolution) ? raw.resolution : undefined,
  };
}

/** 读取批次任务创建时的调度参数快照；缺失时回退当前系统默认值。 */
async function readTaskGenerationParams(taskId: string) {
  const row = await prisma.systemConfig.findUnique({
    where: { key: buildTaskGenerationParamsKey(taskId) },
    select: { value: true },
  });
  const defaults = await readBotGenerationParams({});
  if (!row?.value) return defaults;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    return {
      preferredModel: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : defaults.preferredModel,
      size: typeof parsed.size === 'string' && parsed.size.trim() ? parsed.size : defaults.size,
      aspectRatio: isDrawingAspectRatio(parsed.aspectRatio) ? parsed.aspectRatio : undefined,
      quality: typeof parsed.quality === 'string' && parsed.quality.trim() ? parsed.quality : defaults.quality,
      maxAttempts: normalizeTaskMaxAttempts(parsed.maxAttempts),
      duration: Number.isSafeInteger(parsed.duration) && Number(parsed.duration) >= 1 && Number(parsed.duration) <= 15 ? Number(parsed.duration) : defaults.duration,
      resolution: isBotVideoResolution(parsed.resolution) ? parsed.resolution : defaults.resolution,
    };
  } catch {
    return defaults;
  }
}

/** 批次子任务 ID 保持短格式，避免超过 generation_tasks.id 长度。 */
function createBatchTaskIds(batchId: string, count: number): string[] {
  const base = batchId.slice(0, 56);
  return Array.from({ length: count }, (_, index) => `${base}_${String(index + 1).padStart(2, '0')}`);
}

/** 批次任务调度参数快照 key；只保存模型、尺寸和质量，不保存凭证或图片数据。 */
function buildTaskGenerationParamsKey(taskId: string) {
  return `task_generation_params_${taskId}`;
}

/** 历史 Bot 任务缺少模型尝试次数时按 3 次兼容，并限制异常快照值。 */
function normalizeTaskMaxAttempts(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(Math.trunc(parsed), 1), 10);
}

/** Bot 内部入口只接受共享契约声明的四种真实生成模式。 */
function normalizeBotDrawingMode(value: unknown): DrawingMode {
  if (value === 'image-to-image' || value === 'text-to-video' || value === 'image-to-video') return value;
  return 'text-to-image';
}

/** 校验 Bot 视频分辨率，避免未知字符串透传上游。 */
function isBotVideoResolution(value: unknown): value is DrawingVideoResolution {
  return value === '480p' || value === '720p' || value === '1080p';
}

/** 校验 Grok 视频已验证的七种显式画幅。 */
function isBotVideoAspectRatio(value: unknown): value is DrawingAspectRatio {
  return value === '1:1' || value === '16:9' || value === '9:16' || value === '4:3' || value === '3:4' || value === '3:2' || value === '2:3';
}

/** 多图批次提交响应需要展示总扣费和最新余额；金额仍以每个子任务的真实扣费字段汇总。 */
async function readLatestBotChargeSnapshot(taskIds: string[], qqNumber: bigint) {
  const rows = await prisma.generationTask.findMany({
    where: { id: { in: taskIds } },
    select: { chargedAmount: true },
  });
  const amount = rows.reduce((sum, task) => sum + Number(task.chargedAmount ?? '0'), 0);
  const balance = await walletService.getQqBalanceSummary(qqNumber);
  return {
    amount: Math.round(amount * 100) / 100,
    source: 'mixed',
    paidBalance: balance.paidBalance,
    freeBalance: balance.freeBalance,
  };
}

/** Bot 最终原图已发送给用户后回调：此时任务才允许从 finalizing 进入 success。 */
async function markBotTaskDelivered(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const taskId = params?.taskId ?? '';
  if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(taskId)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '任务 ID 不正确' });
  }

  const imageConfig = await prisma.systemConfig.findUnique({ where: { key: `task_image_${taskId}` }, select: { value: true } });
  if (!imageConfig?.value) {
    return sendJson(res, 409, { ok: false, code: ApiErrorCode.Conflict, message: '任务媒体尚未保存，不能确认投递' });
  }
  let isVideoResult = false;
  try {
    isVideoResult = (JSON.parse(imageConfig.value) as { mediaType?: string }).mediaType === 'video';
  } catch { /* 损坏配置仍由事务中的任务状态校验兜底，不能阻断历史图片确认。 */ }

  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string; source: string }[]>`
        SELECT id, status, source FROM generation_tasks WHERE id = ${taskId} FOR UPDATE
      `;
      const task = locked[0];
      if (!task) throw new Error('not_found');
      if (task.source !== 'bot') throw new Error('invalid_source');
      if (task.status === 'failed') throw new Error('failed_task');
      const existingDelivered = await tx.generationSubTask.findFirst({
        where: { taskId, kind: 'result_delivered', status: 'success' },
        select: { id: true },
      });
      if (task.status === 'success' && existingDelivered) {
        // 幂等分支：Bot/网络重试可能重复确认 delivered，不能重复追加 result_delivered/finalize。
        return;
      }
      if (task.status !== 'success') {
        // 成功终态必须在投递确认事务内写入，避免 Bot 消息失败时任务提前结束。
        await tx.generationTask.update({
          where: { id: taskId },
          data: { status: 'success', error: null, finishedAt: now },
        });
      }
      if (existingDelivered) {
        // 历史异常状态兜底：已有投递记录但主任务还不是 success 时，只补主任务终态，不重复写子任务。
        return;
      }
      const lastSub = await tx.generationSubTask.findFirst({
        where: { taskId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const nextSequence = (lastSub?.sequence ?? 0) + 1;
      await tx.generationSubTask.createMany({
        data: [
          {
            taskId,
            sequence: nextSequence,
            kind: 'result_delivered',
            status: 'success',
            finishedAt: now,
          },
          // 图片 finalizing 由 delivered 接口完成终态；视频已经由 Worker 写 success/finalize，不能重复追加 finalize。
          ...(task.status === 'success' ? [] : [{
            taskId,
            sequence: nextSequence + 1,
            kind: 'finalize',
            status: 'success' as const,
            finishedAt: now,
          }]),
        ],
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'not_found') return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '任务不存在' });
    if (message === 'invalid_source' || message === 'failed_task') return sendJson(res, 409, { ok: false, code: ApiErrorCode.Conflict, message: '当前任务状态不能确认投递' });
    throw error;
  }

  invalidateTaskCache([taskId], ['task-list:admin']);
  // Bot 成功交付新增公开作品时，图库列表可先返回 stale 并后台刷新，避免活跃群消息连续完成时打穿首屏缓存。
  invalidateGalleryCache([`image:${taskId}`], { soft: true });
  if (!isVideoResult) {
    // 图片 success 在 delivered 接口确认后异步入队；视频没有可供视觉打标的图片文件，不能创建无效 job。
    await galleryTaggingService.enqueueTask(taskId);
  }
  // Bot 任务的 success 由 delivered 接口写入，必须在这里推进批次，否则后续 deferred 任务不会释放。
  await advanceBotBatchAfterTerminal(taskId);
  return sendJson(res, 200, { ok: true, data: { delivered: true, taskId } });
}

/** Bot 多图批次释放下一批任务；每张图按创建时参数快照投递，单张失败不阻断后续释放。 */
async function advanceBotBatchAfterTerminal(taskId: string) {
  const result = await generationsRepository.advanceBatchAfterTaskTerminal(taskId);
  if (result.changedTaskIds.length > 0) invalidateTaskCache(result.changedTaskIds, ['task-list:admin']);
  // Bot 批次如果因连续失败停止 deferred，退款已经在仓储事务内完成，这里只做缓存刷新。
  if (result.refundedStoppedTasks) invalidateWalletCache();
  if (result.releasedTasks.length === 0) return;
  await Promise.allSettled(result.releasedTasks.map(async (task) => {
    const { preferredModel, size, aspectRatio, quality, maxAttempts } = await readTaskGenerationParams(task.id);
    await submitDrawingTask({
      taskId: task.id,
      clientRequestId: task.clientRequestId,
      source: 'bot',
      mode: task.mode,
      prompt: task.prompt,
      qqNumber: task.qqNumber,
      userId: task.userId,
      templateId: task.templateId,
      sourceImageUrls: task.sourceImageUrls,
      isPrivate: task.isPrivate,
      asyncSubmit: true,
      preferredModel,
      maxAttempts,
      size,
      aspectRatio,
      quality,
    });
  }));
}

/** 查询 Bot 多图批次最终回执所需数据；只在批次全部终态后由 bot-service 汇总发送一次。 */
async function getBotBatchResult(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const batchId = params?.batchId ?? '';
  if (!isSafeInternalId(batchId)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '批次 ID 不正确' });
  }

  const payload = await buildBotBatchResultPayload(batchId);
  if (!payload) {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: 'Bot 批次不存在' });
  }
  return sendJson(res, 200, { ok: true, data: payload });
}

/** 查询最近已终态但尚未发送最终汇总的 Bot 批次，供 bot-service 重启恢复补发。 */
async function listPendingBotBatches(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '20') || 20, 1), 50);
  const maxAgeMinutes = Math.min(Math.max(Number(url.searchParams.get('maxAgeMinutes') ?? '1440') || 1440, 5), 10080);
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const batches = await prisma.generationBatch.findMany({
    where: {
      source: 'bot',
      status: { in: ['success', 'partial_success', 'failed'] },
      finishedAt: { not: null },
      updatedAt: { gte: cutoff },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  const sentRows = batches.length > 0
    ? await prisma.systemConfig.findMany({
        where: { key: { in: batches.map((batch) => buildBotBatchNotificationSentKey(batch.id)) } },
        select: { key: true },
      })
    : [];
  const sentKeys = new Set(sentRows.map((row) => row.key));
  const payloads: BotBatchResultResponse[] = [];
  for (const batch of batches) {
    if (sentKeys.has(buildBotBatchNotificationSentKey(batch.id))) continue;
    const payload = await buildBotBatchResultPayload(batch.id);
    if (payload?.terminal && !payload.notificationSent) payloads.push(payload);
  }
  const data: BotPendingBatchResultsResponse = { batches: payloads };
  return sendJson(res, 200, { ok: true, data });
}

/** 构建 Bot 批次最终回执数据；单批次查询和重启补发列表必须使用同一口径。 */
async function buildBotBatchResultPayload(batchId: string): Promise<BotBatchResultResponse | null> {
  const batch = await prisma.generationBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      qqNumber: true,
      source: true,
      mode: true,
      prompt: true,
      status: true,
      count: true,
      successCount: true,
      failedCount: true,
      createdAt: true,
      finishedAt: true,
      tasks: {
        orderBy: { batchIndex: 'asc' },
        select: {
          id: true,
          batchIndex: true,
          status: true,
          mode: true,
          sourceImageUrls: true,
          error: true,
          createdAt: true,
          finishedAt: true,
          subTasks: {
            orderBy: { sequence: 'asc' },
            select: { kind: true, status: true, siteName: true, model: true },
          },
        },
      },
    },
  });
  if (!batch || batch.source !== 'bot' || !batch.qqNumber) return null;

  const [imageConfigs, routeConfigs, sentConfig, balance] = await Promise.all([
    prisma.systemConfig.findMany({
      where: { key: { in: batch.tasks.map((task) => `task_image_${task.id}`) } },
      select: { key: true, value: true },
    }),
    prisma.systemConfig.findMany({
      where: { key: { in: batch.tasks.map((task) => buildBotDeliveryRouteKey(task.id)) } },
      select: { key: true, value: true },
    }),
    prisma.systemConfig.findUnique({ where: { key: buildBotBatchNotificationSentKey(batch.id) }, select: { value: true } }),
    walletService.getQqBalanceSummary(batch.qqNumber),
  ]);
  const imageMap = new Map<string, string>();
  for (const config of imageConfigs) {
    try {
      const parsed = JSON.parse(config.value) as { imageFilename?: string };
      if (parsed.imageFilename) imageMap.set(config.key.replace('task_image_', ''), `/images/${parsed.imageFilename}`);
    } catch { /* 损坏图片配置不进入 Bot 汇总消息，避免发送错误图片。 */ }
  }
  const botSelfId = routeConfigs.map((config) => readBotSelfIdFromRouteConfig(config.value)).find(Boolean) ?? '';
  const deliveryTarget = routeConfigs.map((config) => readBotDeliveryTargetFromRouteConfig(config.value)).find(Boolean);
  const firstSourceImages = readSourceImageUrls(batch.tasks[0]?.sourceImageUrls);
  const tasks = batch.tasks.map((task) => {
    const lastAttempt = [...task.subTasks].reverse().find((item) => item.kind === 'upstream_attempt' && (item.siteName || item.model));
    return {
      id: task.id,
      batchIndex: task.batchIndex ?? 0,
      status: task.status as BotBatchResultResponse['tasks'][number]['status'],
      imageUrl: imageMap.get(task.id),
      siteName: lastAttempt?.siteName ?? undefined,
      model: lastAttempt?.model ?? undefined,
      error: task.error ?? undefined,
      createdAt: formatChinaDateTime(task.createdAt),
      finishedAt: task.finishedAt ? formatChinaDateTime(task.finishedAt) : undefined,
    };
  });
  const successCount = tasks.filter((task) => task.status === 'success' && task.imageUrl).length;
  const failedCount = tasks.filter((task) => task.status === 'failed').length;
  const terminal = tasks.length > 0 && tasks.every((task) => task.status === 'success' || task.status === 'failed');
  return {
    batchId: batch.id,
    terminal,
    notificationSent: Boolean(sentConfig?.value),
    status: batch.status as BotBatchResultResponse['status'],
    qqNumber: batch.qqNumber.toString(),
    botSelfId,
    deliveryTarget,
    prompt: batch.prompt.slice(0, 200),
    mode: batch.mode as BotBatchResultResponse['mode'],
    sourceImageCount: firstSourceImages.length,
    totalCount: batch.count,
    successCount,
    failedCount,
    createdAt: formatChinaDateTime(batch.createdAt),
    finishedAt: batch.finishedAt ? formatChinaDateTime(batch.finishedAt) : undefined,
    freeBalance: balance.freeBalance,
    paidBalance: balance.paidBalance,
    tasks,
  };
}

/** 抢占 Bot 批次最终回执发送权；发送失败不写 sent，锁过期后允许重试。 */
async function claimBotBatchNotification(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const batchId = params?.batchId ?? '';
  if (!isSafeInternalId(batchId)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '批次 ID 不正确' });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1000);
  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; source: string }>>`
      SELECT id, source FROM generation_batches WHERE id = ${batchId} FOR UPDATE
    `;
    const batch = locked[0];
    if (!batch || batch.source !== 'bot') return { status: 404 as const };
    const sent = await tx.systemConfig.findUnique({ where: { key: buildBotBatchNotificationSentKey(batchId) }, select: { value: true } });
    if (sent?.value) return { status: 200 as const, data: { claimed: false, sent: true } };
    const lock = await tx.systemConfig.findUnique({ where: { key: buildBotBatchNotificationClaimKey(batchId) }, select: { value: true } });
    const lockExpiresAt = readClaimExpiresAt(lock?.value);
    if (lockExpiresAt && lockExpiresAt.getTime() > now.getTime()) {
      return { status: 200 as const, data: { claimed: false, sent: false, expiresAt: formatChinaDateTime(lockExpiresAt) } };
    }
    await tx.systemConfig.upsert({
      where: { key: buildBotBatchNotificationClaimKey(batchId) },
      update: { value: JSON.stringify({ expiresAt: expiresAt.toISOString(), updatedAt: now.toISOString() }) },
      create: { key: buildBotBatchNotificationClaimKey(batchId), value: JSON.stringify({ expiresAt: expiresAt.toISOString(), updatedAt: now.toISOString() }) },
    });
    return { status: 200 as const, data: { claimed: true, sent: false, expiresAt: formatChinaDateTime(expiresAt) } };
  }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });

  if (result.status === 404) {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: 'Bot 批次不存在' });
  }
  return sendJson(res, 200, { ok: true, data: result.data });
}

/** 标记 Bot 批次最终回执已经发送；ACK 超时也按已处理记录，避免重复刷同一批图片。 */
async function markBotBatchNotificationSent(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const batchId = params?.batchId ?? '';
  if (!isSafeInternalId(batchId)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '批次 ID 不正确' });
  }
  const batch = await prisma.generationBatch.findUnique({ where: { id: batchId }, select: { id: true, source: true } });
  if (!batch || batch.source !== 'bot') {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: 'Bot 批次不存在' });
  }
  const now = new Date();
  await prisma.$transaction([
    prisma.systemConfig.upsert({
      where: { key: buildBotBatchNotificationSentKey(batchId) },
      update: { value: JSON.stringify({ sentAt: now.toISOString() }) },
      create: { key: buildBotBatchNotificationSentKey(batchId), value: JSON.stringify({ sentAt: now.toISOString() }) },
    }),
    prisma.systemConfig.deleteMany({ where: { key: buildBotBatchNotificationClaimKey(batchId) } }),
  ]);
  return sendJson(res, 200, { ok: true, data: { batchId, sent: true } });
}

/** 列出超时仍待 Bot 投递确认的图片或视频任务，用于 bot-service 重启后按原会话补发。 */
async function listFinalizingBotTasks(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const minAgeSeconds = Math.max(60, Number(url.searchParams.get('minAgeSeconds') ?? '300'));
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000);
  const tasks = await prisma.generationTask.findMany({
    where: {
      source: 'bot',
      updatedAt: { lt: cutoff },
      OR: [
        { status: 'finalizing' },
        {
          // 视频 Worker 会直接写 success；缺少 result_delivered 时仍需进入 Bot 重启补发链路。
          status: 'success',
          mode: { in: ['text-to-video', 'image-to-video'] },
          subTasks: { none: { kind: 'result_delivered', status: 'success' } },
        },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: 20,
    select: { id: true, qqNumber: true, prompt: true, mode: true, batchId: true, batchTotal: true, updatedAt: true },
  });
  const configs = await prisma.systemConfig.findMany({
    where: { key: { in: tasks.map((task) => `task_image_${task.id}`) } },
    select: { key: true, value: true },
  });
  const routeConfigs = await prisma.systemConfig.findMany({
    where: { key: { in: tasks.map((task) => buildBotDeliveryRouteKey(task.id)) } },
    select: { key: true, value: true },
  });
  const mediaMap = new Map<string, {
    mediaType: 'image' | 'video';
    imageUrl: string;
    videoUrl?: string;
    duration?: number;
    resolution?: '480p' | '720p' | '1080p';
    aspectRatio?: BotFinalizingTaskRecoveryResponse['tasks'][number]['aspectRatio'];
  }>();
  for (const config of configs) {
    try {
      const parsed = JSON.parse(config.value) as {
        mediaType?: 'image' | 'video';
        imageFilename?: string;
        videoFilename?: string;
        duration?: number;
        resolution?: '480p' | '720p' | '1080p';
        aspectRatio?: BotFinalizingTaskRecoveryResponse['tasks'][number]['aspectRatio'];
      };
      const taskId = config.key.replace('task_image_', '');
      if (parsed.mediaType === 'video' && parsed.videoFilename) {
        mediaMap.set(taskId, {
          mediaType: 'video',
          imageUrl: '',
          videoUrl: `/images/${parsed.videoFilename}`,
          duration: parsed.duration,
          resolution: parsed.resolution,
          aspectRatio: parsed.aspectRatio,
        });
      } else if (parsed.imageFilename) {
        mediaMap.set(taskId, { mediaType: 'image', imageUrl: `/images/${parsed.imageFilename}` });
      }
    } catch { /* 配置损坏时跳过，避免兜底投递错误媒体。 */ }
  }
  const botSelfIdMap = new Map<string, string>();
  const deliveryTargetMap = new Map<string, BotDeliveryTarget>();
  for (const config of routeConfigs) {
    const taskId = config.key.replace('task_bot_delivery_', '');
    const botSelfId = readBotSelfIdFromRouteConfig(config.value);
    if (botSelfId) botSelfIdMap.set(taskId, botSelfId);
    const deliveryTarget = readBotDeliveryTargetFromRouteConfig(config.value);
    if (deliveryTarget) deliveryTargetMap.set(taskId, deliveryTarget);
  }

  const data: BotFinalizingTaskRecoveryResponse = {
    tasks: tasks
      .filter((task) => task.qqNumber)
      .map((task) => {
        const media = mediaMap.get(task.id);
        return {
          taskId: task.id,
          qqNumber: task.qqNumber!.toString(),
          prompt: task.prompt.slice(0, 200),
          mode: task.mode as BotFinalizingTaskRecoveryResponse['tasks'][number]['mode'],
          batchId: task.batchId ?? undefined,
          batchTotal: task.batchTotal ?? undefined,
          mediaType: media?.mediaType,
          imageUrl: media?.imageUrl ?? '',
          videoUrl: media?.videoUrl,
          duration: media?.duration,
          resolution: media?.resolution,
          aspectRatio: media?.aspectRatio,
          botSelfId: botSelfIdMap.get(task.id) ?? '',
          deliveryTarget: deliveryTargetMap.get(task.id),
          updatedAt: task.updatedAt.toISOString(),
        };
      })
      .filter((task) => task.imageUrl || task.videoUrl),
  };
  return sendJson(res, 200, {
    ok: true,
    data,
  });
}

/** 任务级 Bot 投递路由快照 key；用于多 Bot 场景下恢复最终图补发目标。 */
function buildBotDeliveryRouteKey(taskId: string) {
  return `task_bot_delivery_${taskId}`;
}

/** Bot 批次最终回执发送锁 key；只用于消息防重，不影响任务终态。 */
function buildBotBatchNotificationClaimKey(batchId: string) {
  return `bot_batch_notify_claim_${batchId}`;
}

/** Bot 批次最终回执已发送 key；存在即表示同一批次不再重复发图。 */
function buildBotBatchNotificationSentKey(batchId: string) {
  return `bot_batch_notify_sent_${batchId}`;
}

/** 校验内部 ID，避免把任意字符串拼入 system_configs key 或 Prisma 查询。 */
function isSafeInternalId(value: string): boolean {
  return /^[a-zA-Z0-9:_-]{1,64}$/.test(value);
}

/** 读取发送锁过期时间；配置损坏时视为无锁，允许重新抢占。 */
function readClaimExpiresAt(value: string | undefined): Date | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { expiresAt?: unknown };
    if (typeof parsed.expiresAt !== 'string') return null;
    const date = new Date(parsed.expiresAt);
    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

/** 解析任务参考图 URL 数组；仅用于 Bot 汇总消息展示参考图数量。 */
function readSourceImageUrls(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

/** 规范化 Bot selfId；只接受 QQ 号形态，避免把群号或事件 ID 写入投递路由。 */
function normalizeBotSelfId(value: unknown): string {
  const text = String(value ?? '').trim();
  return /^\d{5,15}$/.test(text) ? text : '';
}

/** 从任务投递路由配置中读取 Bot selfId；配置损坏时返回空字符串并交给兜底逻辑处理。 */
function readBotSelfIdFromRouteConfig(value: string): string {
  try {
    const parsed = JSON.parse(value) as { botSelfId?: unknown };
    return normalizeBotSelfId(parsed.botSelfId);
  } catch {
    return '';
  }
}

/** 规范化 Bot 最终回执投递目标，只接受原始消息的群聊或私聊目标。 */
function normalizeBotDeliveryTarget(value: unknown): BotDeliveryTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const messageId = Number(raw.messageId);
  const normalizedMessageId = Number.isSafeInteger(messageId) && messageId > 0 ? messageId : undefined;
  if (raw.type === 'group') {
    const groupId = String(raw.groupId ?? '').trim();
    if (!/^\d{5,20}$/.test(groupId)) return undefined;
    const userId = String(raw.userId ?? '').trim();
    // 群聊最终回执优先引用原消息；原消息被撤回时 bot-service 需要原触发用户 QQ 来 @ 兜底。
    return { type: 'group', groupId, userId: /^\d{5,20}$/.test(userId) ? userId : undefined, messageId: normalizedMessageId };
  }
  if (raw.type === 'private') {
    const userId = String(raw.userId ?? '').trim();
    if (!/^\d{5,20}$/.test(userId)) return undefined;
    return { type: 'private', userId, messageId: normalizedMessageId };
  }
  return undefined;
}

/** 从任务投递路由配置中读取原消息目标；旧配置缺失时返回空，由 bot-service 私聊兜底。 */
function readBotDeliveryTargetFromRouteConfig(value: string): BotDeliveryTarget | undefined {
  try {
    const parsed = JSON.parse(value) as { deliveryTarget?: unknown };
    return normalizeBotDeliveryTarget(parsed.deliveryTarget);
  } catch {
    return undefined;
  }
}

/** 将 Date 格式化为中国时区 ISO 字符串，供 Bot 卡片跨服务展示。 */
function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** 返回启用的命令配置列表，供 bot-service 动态构建命令清单 */
async function botCommands(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(_req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const cached = await cacheInternalBotCommands(() => prisma.systemConfig.findUnique({ where: { key: 'bot_command_configs' }, select: { value: true } }));
  setBackendCacheHeader(res, cached.status);
  const row = cached.value;
  if (!row?.value) return sendJson(res, 200, { ok: true, data: [] });
  try {
    const configs = normalizeBotCommandConfigs(JSON.parse(row.value));
    const enabled = configs.filter((c) => c.enabled !== false);
    return sendJson(res, 200, { ok: true, data: enabled });
  } catch {
    return sendJson(res, 200, { ok: true, data: [] });
  }
}

/** 返回 QQ 端管理员权限配置；白名单和已绑定 Web 管理员 QQ 合并后供 bot-service 使用。 */
async function botAdminConfig(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(_req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const adminQqNumbers = await readBotAdminQqNumbers();
  const data: BotAdminRuntimeConfig = { adminQqNumbers };
  return sendJson(res, 200, { ok: true, data });
}

/** 兼容历史命令配置，不改数据库，只在返回给 bot-service 前补齐必要字段。 */
function normalizeBotCommandConfigs(value: unknown): BotCommandConfig[] {
  if (!Array.isArray(value)) return [];
  return ensureBuiltinBotCommandConfigs(value.map((raw) => normalizeBotCommandConfig(raw)).filter((item): item is BotCommandConfig => Boolean(item)));
}

/** 归一化单条 Bot 命令配置，修复旧任务命令缺少 task-list 卡片的问题。 */
function normalizeBotCommandConfig(raw: unknown): BotCommandConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as BotCommandConfig;
  const command = typeof item.command === 'string' ? item.command : '';
  if (!command) return null;
  const id = inferBotCommandConfigId(item);
  const cardTypes = Array.isArray(item.cardTypes) ? [...item.cardTypes] : [];
  if (id === 'tasks' && !cardTypes.includes('task-list')) cardTypes.push('task-list');
  if (id === 'info' && !cardTypes.includes('site-info')) cardTypes.push('site-info');
  return { ...item, id, command, cardTypes };
}

/** 根据触发词或卡片类型推断 Bot 命令 ID，兼容旧后台保存格式。 */
function inferBotCommandConfigId(item: BotCommandConfig): string | undefined {
  const known = new Set(['ping', 'help', 'balance', 'status', 'generation_stats', 'draw', 'reverse_extract', 'image_upscale', 'retry', 'model', 'privacy', 'bind', 'tasks', 'botlist', 'info', 'admin_balance']);
  if (item.id && known.has(item.id)) return item.id;
  const triggers = [item.command, ...(item.aliases ?? [])].map((value) => value.replace(/^[^a-zA-Z0-9一-鿿\s]+/, ''));
  const triggerMap: Record<string, string> = {
    ping: 'ping',
    帮助: 'help',
    help: 'help',
    余额: 'balance',
    额度: 'balance',
    次数: 'balance',
    状态: 'status',
    status: 'status',
    统计: 'generation_stats',
    stats: 'status',
    绘图: 'draw',
    生成: 'draw',
    draw: 'draw',
    generate: 'draw',
    提取: 'reverse_extract',
    反推: 'reverse_extract',
    reverse: 'reverse_extract',
    放大: 'image_upscale',
    upscale: 'image_upscale',
    模型: 'model',
    models: 'model',
    隐私: 'privacy',
    privacy: 'privacy',
    绑定: 'bind',
    bind: 'bind',
    任务: 'tasks',
    tasks: 'tasks',
    记录: 'tasks',
    bot: 'botlist',
    bots: 'botlist',
    list: 'botlist',
    info: 'info',
    站点统计: 'info',
    '额度 加': 'admin_balance',
    '额度 减': 'admin_balance',
    '余额 加': 'admin_balance',
    '余额 减': 'admin_balance',
  };
  for (const trigger of triggers) {
    if (triggerMap[trigger]) return triggerMap[trigger];
  }
  const cardTypeMap: Record<string, string> = {
    ping: 'ping',
    help: 'help',
    'balance-success': 'balance',
    'site-status': 'status',
    'site-info': 'info',
    'generation-stats': 'generation_stats',
    'draw-submitted': 'draw',
    'draw-result': 'draw',
    'model-list': 'model',
    'privacy-public': 'privacy',
    'bind-howto': 'bind',
    'task-list': 'tasks',
    'bot-list': 'botlist',
    'admin-balance': 'admin_balance',
  };
  for (const cardType of item.cardTypes ?? []) {
    if (cardTypeMap[cardType]) return cardTypeMap[cardType];
  }
  return undefined;
}

/** 补齐版本新增的内置 Bot 命令；只影响读取结果，不覆盖生产数据库原始配置。 */
function ensureBuiltinBotCommandConfigs(configs: BotCommandConfig[]): BotCommandConfig[] {
  const prefix = readBotCommandPrefixFromConfigs(configs);
  const result = [...configs];
  // 新增内置命令只补读取结果，不直接覆盖生产数据库里的管理员配置。
  if (!result.some((item) => item.id === 'reverse_extract')) {
    result.push({ id: 'reverse_extract', command: `${prefix}提取`, enabled: true, cooldownSec: 0, aliases: [`${prefix}反推`], cardTypes: [] });
  }
  if (!result.some((item) => item.id === 'image_upscale')) {
    result.push({ id: 'image_upscale', command: `${prefix}放大`, enabled: true, cooldownSec: 0, aliases: [`${prefix}upscale`], cardTypes: [] });
  }
  return result;
}

/** 从已有命令推断当前 Bot 前缀，避免新增命令在自定义前缀环境下失效。 */
function readBotCommandPrefixFromConfigs(configs: BotCommandConfig[]): string {
  const command = configs.find((item) => typeof item.command === 'string' && item.command.length > 0)?.command ?? '#帮助';
  const match = command.match(/^[^a-zA-Z0-9一-鿿\s]+/);
  return match?.[0] ?? '#';
}

/** 返回站点统计（含成功率和延迟），供 bot-service 渲染站点状态卡片 */
async function botSiteStats(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(_req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  try {
    const sites = await prisma.apiSite.findMany({
      select: { id: true, name: true, model: true, isEnabled: true, consecutiveFailures: true, maxConcurrency: true },
    });
    // 从 drawing-worker 统计表获取成功率和延迟（如果表存在）
    let runtimeMap = new Map<number, { successRate: number; avgLatencyMs: number }>();
    try {
      const stats = await prisma.generationSubTask.groupBy({
        by: ['siteId'],
        where: { kind: 'upstream_attempt', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        _count: { id: true },
        _avg: { latencyMs: true },
      });
      const successStats = await prisma.generationSubTask.groupBy({
        by: ['siteId'],
        where: { kind: 'upstream_attempt', status: 'success', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        _count: { id: true },
      });
      for (const s of stats) {
        const sid = s.siteId;
        if (sid == null) continue;
        const success = successStats.find((ss: any) => ss.siteId === sid);
        const total = s._count.id;
        const successCount = success?._count?.id ?? 0;
        runtimeMap.set(sid, {
          successRate: total > 0 ? Math.round((successCount / total) * 1000) / 10 : 100,
          avgLatencyMs: Math.round((s._avg.latencyMs as number | null) ?? 0),
        });
      }
    } catch { /* 统计表可能不可用 */ }
    const data = sites.map((s: { id: number; name: string; model: string | null; isEnabled: boolean; consecutiveFailures: number }) => {
      const rt = runtimeMap.get(s.id);
      return { name: s.name, model: s.model, isEnabled: s.isEnabled, consecutiveFailures: s.consecutiveFailures, successRate: rt?.successRate, avgLatencyMs: rt?.avgLatencyMs };
    });
    return sendJson(res, 200, { ok: true, data: { sites: data } });
  } catch {
    return sendJson(res, 500, { ok: false, message: '站点统计查询失败' });
  }
}

/** 返回 Bot 任务统计；只读真实 generation_tasks 和 generation_sub_tasks，不写余额或任务状态。 */
async function botGenerationStats(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'mine';
  const qqStr = String(url.searchParams.get('qqNumber') ?? '').trim();
  if (scope === 'mine' && !/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }

  const baseWhere = scope === 'mine' ? { qqNumber: BigInt(qqStr) } : {};
  const [total, today, week, ranking] = await Promise.all([
    buildStatsBucket(baseWhere, 'total', '累计'),
    buildStatsBucket({ ...baseWhere, createdAt: { gte: startOfChinaDay() } }, 'today', '今日'),
    buildStatsBucket({ ...baseWhere, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }, '7d', '近 7 日'),
    scope === 'all' ? buildStatsRanking() : Promise.resolve(undefined),
  ]);

  const data: BotGenerationStatsResponse = {
    scope,
    qqNumber: scope === 'mine' ? qqStr : undefined,
    generatedAt: formatChinaDateTime(new Date()),
    buckets: [total, today, week],
    ranking,
  };
  return sendJson(res, 200, { ok: true, data });
}

/** 聚合指定过滤条件下的真实任务、尝试、耗时和扣费。 */
async function buildStatsBucket(where: { qqNumber?: bigint; createdAt?: { gte: Date } }, key: BotGenerationStatsBucket['key'], label: string): Promise<BotGenerationStatsBucket> {
  const [statusRows, modeRows, attemptRows, chargeRows, latencyRows] = await Promise.all([
    prisma.generationTask.groupBy({ by: ['status'], where, _count: { id: true } }),
    prisma.generationTask.groupBy({ by: ['mode'], where, _count: { id: true } }),
    prisma.generationSubTask.groupBy({
      by: ['status'],
      where: { kind: 'upstream_attempt', task: where.qqNumber ? { qqNumber: where.qqNumber } : undefined, createdAt: where.createdAt },
      _count: { id: true },
    }),
    prisma.generationTask.findMany({ where, select: { chargedAmount: true } }),
    prisma.generationTask.findMany({
      where: { ...where, status: { in: ['success', 'failed'] }, startedAt: { not: null }, finishedAt: { not: null } },
      select: { startedAt: true, finishedAt: true },
      take: 5000,
    }),
  ]);
  const total = sumGroupedCount(statusRows);
  const success = readGroupedCount(statusRows, 'success');
  const failed = readGroupedCount(statusRows, 'failed');
  const active = readGroupedCount(statusRows, 'queued') + readGroupedCount(statusRows, 'running') + readGroupedCount(statusRows, 'finalizing');
  const imageToImage = readGroupedCount(modeRows, 'image-to-image');
  const textToImage = readGroupedCount(modeRows, 'text-to-image');
  const attempts = sumGroupedCount(attemptRows);
  const failedAttempts = readGroupedCount(attemptRows, 'failed');
  const chargedAmount = chargeRows.reduce((sum, row) => sum + Number(row.chargedAmount ?? '0'), 0);
  const latencyValues = latencyRows
    .map((row) => row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : NaN)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    key,
    label,
    total,
    success,
    failed,
    active,
    successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
    imageToImage,
    textToImage,
    attempts,
    failedAttempts,
    avgLatencyMs: latencyValues.length > 0 ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length) : undefined,
    chargedAmount: chargedAmount.toFixed(2),
  };
}

/** 构建全站 QQ 排行；只统计带 QQ 号的任务，头像 URL 由 QQ 号直接派生。 */
async function buildStatsRanking(): Promise<BotGenerationStatsResponse['ranking']> {
  const todayStart = startOfChinaDay();
  const rows = await prisma.generationTask.groupBy({
    by: ['qqNumber'],
    where: { qqNumber: { not: null } },
    _count: { id: true },
    _max: { createdAt: true },
    orderBy: { _count: { id: 'desc' } },
    take: 10,
  });
  const qqNumbers = rows.map((row) => row.qqNumber).filter((value): value is bigint => Boolean(value));
  if (qqNumbers.length === 0) return [];
  const [successRows, failedRows, todayRows] = await Promise.all([
    prisma.generationTask.groupBy({ by: ['qqNumber'], where: { qqNumber: { in: qqNumbers }, status: 'success' }, _count: { id: true } }),
    prisma.generationTask.groupBy({ by: ['qqNumber'], where: { qqNumber: { in: qqNumbers }, status: 'failed' }, _count: { id: true } }),
    prisma.generationTask.groupBy({ by: ['qqNumber'], where: { qqNumber: { in: qqNumbers }, createdAt: { gte: todayStart } }, _count: { id: true } }),
  ]);
  const successMap = groupedQqMap(successRows);
  const failedMap = groupedQqMap(failedRows);
  const todayMap = groupedQqMap(todayRows);
  return rows.map((row, index) => {
    const qqNumber = row.qqNumber?.toString() ?? '';
    const total = row._count.id;
    const success = successMap.get(qqNumber) ?? 0;
    const failed = failedMap.get(qqNumber) ?? 0;
    return {
      rank: index + 1,
      qqNumber,
      avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${qqNumber}&spec=100`,
      total,
      success,
      failed,
      successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
      todayTotal: todayMap.get(qqNumber) ?? 0,
      lastTaskAt: row._max.createdAt ? formatChinaDateTime(row._max.createdAt) : undefined,
    };
  });
}

/** 汇总 Prisma groupBy 的计数字段。 */
function sumGroupedCount(rows: Array<{ _count: { id: number } }>): number {
  return rows.reduce((sum, row) => sum + row._count.id, 0);
}

/** 从 Prisma groupBy 结果中读取指定分组计数。 */
function readGroupedCount<T extends string>(rows: Array<Record<string, unknown> & { _count: { id: number } }>, value: T): number {
  const row = rows.find((item) => Object.values(item).includes(value));
  return row?._count.id ?? 0;
}

/** 将 QQ groupBy 结果转换为 Map，避免 BigInt 直接序列化。 */
function groupedQqMap(rows: Array<{ qqNumber: bigint | null; _count: { id: number } }>): Map<string, number> {
  return new Map(rows.filter((row) => row.qqNumber).map((row) => [row.qqNumber!.toString(), row._count.id]));
}

/** 获取中国时区当天零点，统计“今日”时避免 UTC 日期偏移。 */
function startOfChinaDay(): Date {
  const now = new Date();
  const china = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  china.setUTCHours(0, 0, 0, 0);
  return new Date(china.getTime() - 8 * 60 * 60 * 1000);
}

function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}
