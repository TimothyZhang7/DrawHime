/**
 * 本文件负责 Bot 最近任务复投接口。
 *
 * 职责：按 OneBot 事件 QQ 号读取最近一次真实生成任务，并重新创建 Bot 新任务。
 * 复投不修改历史任务；余额扣费、任务创建和 drawing-service 调度仍走真实链路。
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode, type BotDeliveryTarget, type BotGenerationRetryRequest, type BotGenerationRetryResponse, type DrawingMode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { submitDrawingTask } from '../../infrastructure/http/drawing-client.js';
import { invalidateTaskCache, invalidateWalletCache } from '../../shared/cache/cache-service.js';
import { WalletService } from '../wallet/wallet-service.js';
import { WalletError } from '../wallet/wallet-types.js';
import { pickRetryModelFromSubTasks, readEnabledModelNames } from './generation-model-utils.js';
import { assertGenerationSourceImagesAvailable, normalizeGenerationSourceImageUrls, SourceImageUnavailableError } from './source-image-utils.js';
import { resolveConfiguredModelMaxAttempts, resolveConfiguredModelName } from './model-settings-service.js';
import { GenerationsRepository } from './generations-repository.js';

const prisma = getPrismaClient();
const walletService = new WalletService();
const generationsRepository = new GenerationsRepository(prisma);

/** Bot 单次生成价格；保持与现有 Bot 绘图入口一致，避免两条入口扣费口径分裂。 */
const DEFAULT_PRICE = Number.parseFloat(process.env.DRAWING_PRICE_PER_GEN ?? '0.05');

/** 注册 Bot 复投相关内部接口。 */
export function createBotRetryRoutes(): Route[] {
  return [
    { method: 'POST', path: '/internal/bot/generate/retry-latest', handle: retryLatestBotGeneration },
  ];
}

/** Bot 最近任务复投：QQ 号只能来自 bot-service 的 OneBot 事件，不能读取用户文本里的 QQ。 */
async function retryLatestBotGeneration(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }

  const body = await readJsonBody(req) as Partial<BotGenerationRetryRequest>;
  const qqStr = String(body.qqNumber ?? '').trim();
  const botSelfId = normalizeBotSelfId(body.botSelfId);
  const deliveryTarget = normalizeBotDeliveryTarget(body.deliveryTarget);
  if (!/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }
  if (body.botSelfId !== undefined && !botSelfId) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'Bot selfId 格式不正确' });
  }
  if (body.deliveryTarget !== undefined && !deliveryTarget) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'Bot 投递目标格式不正确' });
  }

  const qqNumber = BigInt(qqStr);
  const sourceTask = await prisma.generationTask.findFirst({
    where: { qqNumber },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      mode: true,
      prompt: true,
      templateId: true,
      sourceImageUrls: true,
      subTasks: {
        orderBy: { sequence: 'asc' },
        select: { kind: true, model: true },
      },
    },
  });
  if (!sourceTask) {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '暂无可重试的历史任务' });
  }

  const sourceImageUrls = normalizeSourceImageUrls(sourceTask.sourceImageUrls);
  const mode = normalizeRetryDrawingMode(sourceTask.mode);
  if ((mode === 'image-to-image' || mode === 'image-to-video') && sourceImageUrls.length === 0) {
    return sendJson(res, 409, { ok: false, code: ApiErrorCode.Conflict, message: mode === 'image-to-video' ? '最近视频任务缺少可复用的参考图，请重新发送图片生成视频' : '最近任务缺少可复用的参考图，请重新发送图片绘图' });
  }
  try {
    // 复投只能复用仍可读取的站内参考图；不可用时在扣费前提示用户重新发送图片。
    await assertGenerationSourceImagesAvailable(sourceImageUrls);
  } catch (error) {
    if (error instanceof SourceImageUnavailableError) {
      return sendJson(res, 409, { ok: false, code: ApiErrorCode.Conflict, message: '最近任务参考图已过期，请重新发送图片绘图' });
    }
    throw error;
  }

  const binding = await prisma.qqBinding.findUnique({
    where: { qqNumber },
    select: { userId: true, verified: true, user: { select: { username: true } } },
  });
  const privacyPref = await prisma.qqImagePrivacyPref.findUnique({
    where: { qqNumber },
    select: { isPrivate: true },
  });
  const isPrivate = privacyPref?.isPrivate ?? false;
  const [enabledModels, generationParams, defaultSize, defaultQuality] = await Promise.all([
    readEnabledModelNames(prisma),
    generationsRepository.findTaskGenerationParams(sourceTask.id),
    readConfigValue('drawing_default_size', 'auto'),
    readConfigValue('drawing_default_quality', 'auto'),
  ]);
  const historicalModel = generationParams.model ?? pickRetryModelFromSubTasks(sourceTask.subTasks, enabledModels);
  const preferredModel = await resolveConfiguredModelName(prisma, historicalModel);
  // 复投优先沿用历史快照；旧视频任务缺字段时使用已登记的视频默认规格，避免降级为图片参数。
  const size = generationParams.size ?? defaultSize ?? 'auto';
  const quality = generationParams.quality ?? defaultQuality ?? 'auto';
  const aspectRatio = generationParams.aspectRatio ?? (mode === 'text-to-video' || mode === 'image-to-video' ? '16:9' : undefined);
  const duration = mode === 'text-to-video' || mode === 'image-to-video' ? generationParams.duration ?? 5 : undefined;
  const resolution = mode === 'text-to-video' || mode === 'image-to-video' ? generationParams.resolution ?? '720p' : undefined;
  const maxAttempts = await resolveConfiguredModelMaxAttempts(prisma, preferredModel);
  const referencePromptAssist = generationParams.referencePromptAssist === true && Boolean(generationParams.effectivePrompt);
  const effectivePrompt = referencePromptAssist ? generationParams.effectivePrompt! : sourceTask.prompt;
  const fallbackPrice = Number(await readConfigValue('drawing_price_per_gen', String(DEFAULT_PRICE)) ?? DEFAULT_PRICE);
  // Bot 复投沿用实际选择模型的独立价格，避免与首次生成和网页入口扣费分裂。
  const modelPrice = await generationsRepository.resolveGenerationPrice({ model: preferredModel, mode, basePrice: fallbackPrice });

  let chargeResult: { chargedSource: string; chargedAmount: string; freeUsed: string; paidUsed: string; freeBalance: string; paidBalance: string } | undefined;
  const taskId = createBotRetryTaskId(qqStr);
  const clientRequestId = taskId;

  try {
    const task = await prisma.$transaction(async (tx) => {
      const created = await tx.generationTask.create({
        data: {
          id: taskId,
          clientRequestId,
          userId: binding?.verified ? binding.userId : null,
          source: 'bot',
          mode,
          prompt: sourceTask.prompt,
          qqNumber,
          templateId: sourceTask.templateId,
          sourceImageUrls,
          isPrivate,
          status: 'queued',
          subTasks: {
            create: {
              sequence: 1,
              kind: 'request_received',
              status: 'success',
              startedAt: new Date(),
              finishedAt: new Date(),
            },
          },
        },
        select: { id: true },
      });
      if (botSelfId) {
        // 关键投递链路：重试任务也记录创建任务的 Bot selfId，避免多 Bot 或服务重启后最终图补发到错误连接。
        await tx.systemConfig.upsert({
          where: { key: buildBotDeliveryRouteKey(created.id) },
          update: { value: JSON.stringify({ botSelfId, deliveryTarget, createdAt: new Date().toISOString(), sourceTaskId: sourceTask.id }) },
          create: { key: buildBotDeliveryRouteKey(created.id), value: JSON.stringify({ botSelfId, deliveryTarget, createdAt: new Date().toISOString(), sourceTaskId: sourceTask.id }) },
        });
      }
      // 复投任务也在创建事务内固化全部图片或视频参数，避免 Worker 轮询兜底使用当前配置。
      const generationParamsSnapshot = JSON.stringify({ model: preferredModel, size, quality, maxAttempts, aspectRatio, duration, resolution, storyboardDesign: false, effectivePrompt: referencePromptAssist ? effectivePrompt : undefined, referencePromptAssist, count: 1 });
      await tx.systemConfig.upsert({
        where: { key: buildTaskGenerationParamsKey(created.id) },
        update: { value: generationParamsSnapshot },
        create: { key: buildTaskGenerationParamsKey(created.id), value: generationParamsSnapshot },
      });
      // 复投扣费与任务创建必须同事务，余额不足时不留下空任务。
      chargeResult = await walletService.chargeForGenerationTx(tx, {
        actor: 'bot',
        qqNumber,
        userId: binding?.verified ? binding.userId : undefined,
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
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });

    if (!chargeResult) throw new Error('钱包扣费结果缺失');
    const charged = chargeResult;

    submitDrawingTask({
      taskId,
      clientRequestId,
      source: 'bot',
      mode,
      prompt: effectivePrompt,
      qqNumber: qqStr,
      userId: binding?.verified ? binding.userId : undefined,
      templateId: sourceTask.templateId ?? undefined,
      sourceImageUrls: referencePromptAssist ? undefined : sourceImageUrls,
      isPrivate,
      asyncSubmit: true,
      preferredModel,
      maxAttempts,
      size,
      quality,
      aspectRatio,
      duration,
      resolution,
    }).catch(() => { /* 投递失败由 worker 轮询兜底，不能回滚已提交任务。 */ });

    invalidateWalletCache([`qq:${qqStr}`, ...(binding?.verified ? [`user:${binding.userId}`] : [])]);
    invalidateTaskCache([taskId], ['task-list:admin']);

    const data: BotGenerationRetryResponse = {
      accepted: true,
      taskId: task.id,
      clientRequestId: task.clientRequestId,
      status: task.status as BotGenerationRetryResponse['status'],
      charged: Number(charged.chargedAmount) > 0,
      chargedSource: charged.chargedSource,
      chargedAmount: charged.chargedAmount,
      paidBalance: charged.paidBalance,
      freeBalance: charged.freeBalance,
      mode: mode as DrawingMode,
      prompt: sourceTask.prompt.slice(0, 200),
      preferredModel,
      maxAttempts,
      aspectRatio,
      duration,
      resolution,
      imageCount: sourceImageUrls.length,
      isPrivate,
      qqNumber: qqStr,
      bindingUsername: binding?.verified ? binding.user?.username ?? null : null,
      bindingUserId: binding?.verified ? binding.userId : null,
      sourceTaskId: sourceTask.id,
      sourceImageUrls,
    };
    return sendJson(res, 202, { ok: true, data });
  } catch (error) {
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

/** 校验服务间 token；仅显式开发或测试环境允许缺省调试。 */
function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

/** 读取 JSON 请求体；内部接口只接收短 JSON，不承载图片文件。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

/** 归一化历史任务参考图，保证复投链路只传可解释的字符串列表。 */
function normalizeSourceImageUrls(value: unknown): string[] {
  return normalizeGenerationSourceImageUrls(value);
}

/** 复投仅保留共享契约声明的四种真实生成模式，异常历史值按文生图兼容。 */
function normalizeRetryDrawingMode(value: unknown): DrawingMode {
  if (value === 'image-to-image' || value === 'text-to-video' || value === 'image-to-video') return value;
  return 'text-to-image';
}

/** 读取绘图配置；缺失时回退到调用方提供的默认值。 */
async function readConfigValue(key: string, fallback: string | undefined): Promise<string | undefined> {
  const row = await prisma.systemConfig.findUnique({ where: { key }, select: { value: true } });
  return row?.value || fallback;
}

/** Bot 复投任务 ID：短且包含 QQ 后 6 位，便于用户侧识别。 */
function createBotRetryTaskId(qqNumber: string): string {
  const ts36 = Date.now().toString(36);
  const r4 = randomBytes(2).toString('hex');
  return `br_${ts36}_${r4}_${qqNumber.slice(-6)}`;
}

/** 任务级 Bot 投递路由快照 key；和普通 Bot 绘图入口共用命名。 */
function buildBotDeliveryRouteKey(taskId: string) {
  return `task_bot_delivery_${taskId}`;
}

/** Bot 复投任务调度参数快照 key，与 Worker 轮询读取口径一致。 */
function buildTaskGenerationParamsKey(taskId: string) {
  return `task_generation_params_${taskId}`;
}

/** 规范化 Bot selfId；只接受 QQ 号形态，避免把群号或用户 QQ 写入投递路由。 */
function normalizeBotSelfId(value: unknown): string {
  const text = String(value ?? '').trim();
  return /^\d{5,15}$/.test(text) ? text : '';
}

/** 规范化 Bot 最终回执投递目标，复投任务也必须保留原会话恢复路径。 */
function normalizeBotDeliveryTarget(value: unknown): BotDeliveryTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const messageId = Number(raw.messageId);
  const normalizedMessageId = Number.isSafeInteger(messageId) && messageId > 0 ? messageId : undefined;
  if (raw.type === 'group') {
    const groupId = String(raw.groupId ?? '').trim();
    if (!/^\d{5,20}$/.test(groupId)) return undefined;
    const userId = String(raw.userId ?? '').trim();
    // 复投任务同样保存原触发用户；最终消息引用失效时需要 @ 用户兜底。
    return { type: 'group', groupId, userId: /^\d{5,20}$/.test(userId) ? userId : undefined, messageId: normalizedMessageId };
  }
  if (raw.type === 'private') {
    const userId = String(raw.userId ?? '').trim();
    if (!/^\d{5,20}$/.test(userId)) return undefined;
    return { type: 'private', userId, messageId: normalizedMessageId };
  }
  return undefined;
}
