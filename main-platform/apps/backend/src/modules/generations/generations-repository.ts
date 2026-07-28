/** 本文件封装生成主任务与子任务的 Prisma 数据库访问，业务判断保留在 service 层。 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  DrawingAspectRatio,
  DrawingLoraSnapshot,
  DrawingPromptFormat,
  DrawingVideoResolution,
  GenerationBatchView,
  GenerationAppendSubTaskRequest,
  GenerationCreateRequest,
  GenerationSubTaskView,
  GenerationTaskView,
  GenerationUpdateTaskStatusRequest,
} from '@aiimage/shared-contracts';
import { isDrawingAspectRatio } from '@aiimage/shared-contracts';
import { WalletService } from '../wallet/wallet-service.js';
import { DEFAULT_MODEL_MAX_ATTEMPTS, normalizeModelMaxAttempts, resolveConfiguredModelPrice } from './model-settings-service.js';

/** 任务创建时固化的调度参数，供直推、轮询恢复和进度展示共享。 */
export type TaskGenerationParamsSnapshot = {
  model?: string;
  size?: string;
  aspectRatio?: DrawingAspectRatio;
  quality?: string;
  duration?: number;
  resolution?: DrawingVideoResolution;
  storyboardDesign?: boolean;
  count?: number;
  sourceImageSizes?: number[];
  /** 外部 AI 生成、实际投递给文生图上游的提示词。 */
  effectivePrompt?: string;
  /** 当前任务是否使用 AI 提示增强；参考图为可选输入。 */
  referencePromptAssist?: boolean;
  /** 本次增强使用的模型提示词格式，恢复时不得依赖之后变化的后台配置。 */
  promptFormat?: DrawingPromptFormat;
  maxAttempts: number;
  /** backend 校验并固化的用户 LoRA 文件快照。 */
  lora?: DrawingLoraSnapshot;
};

/** AI 提示增强调用的单次审计时间；同一批次全部任务复用同一份调用结果。 */
export type PromptAssistStepInput = {
  startedAt: Date;
  finishedAt: Date;
  latencyMs: number;
};

/** 创建主任务需要的已鉴权上下文；QQ 号只在用户已绑定 QQ 时携带。 */
export type CreateGenerationTaskInput = {
  userId: number;
  qqNumber?: bigint | null;
  clientRequestId: string;
  taskId: string;
  body: GenerationCreateRequest;
  defaultImagePrivate: boolean;
  price: number;
  /** 当前模型在任务创建时确定的最大上游尝试次数。 */
  maxAttempts: number;
  /** 任务实际投递提示词；参考增强任务的任务表和快照均保存该值。 */
  effectivePrompt?: string;
  /** 是否启用参考图提示词增强。 */
  referencePromptAssist?: boolean;
  /** 任务创建时确定的提示词格式。 */
  promptFormat?: DrawingPromptFormat;
  /** 本次用户提交实际发生的一次 AI 提示增强调用。 */
  promptAssistStep?: PromptAssistStepInput;
  /** 任务创建后异步执行提示增强，初始时间线必须显示进行中。 */
  promptAssistPending?: boolean;
  /** 本次任务使用的已验证 LoRA 文件快照。 */
  lora?: DrawingLoraSnapshot;
};

/** 创建多图批次需要的上下文；批次下每个任务仍按单图任务独立扣费和退款。 */
export type CreateGenerationBatchInput = {
  userId?: number | null;
  qqNumber?: bigint | null;
  source: 'web' | 'bot';
  clientRequestId: string;
  batchId: string;
  taskIds: string[];
  body: GenerationCreateRequest;
  defaultImagePrivate: boolean;
  price: number;
  /** 当前模型在批次创建时确定的最大上游尝试次数。 */
  maxAttempts: number;
  /** 批次全部子任务共用的实际投递提示词。 */
  effectivePrompt?: string;
  /** 是否启用参考图提示词增强。 */
  referencePromptAssist?: boolean;
  /** 批次创建时确定的提示词格式。 */
  promptFormat?: DrawingPromptFormat;
  /** 批次创建前实际发生的一次 AI 提示增强调用，N 个结果共享。 */
  promptAssistStep?: PromptAssistStepInput;
  /** 批次共享一次异步提示增强。 */
  promptAssistPending?: boolean;
  /** 批次全部图片共用的已验证 LoRA 文件快照。 */
  lora?: DrawingLoraSnapshot;
  count: number;
  concurrency: number;
  stopAfterConsecutiveFailures: number;
};

/** 查询主任务列表的输入，必须分页避免无上限扫描。 */
export type ListGenerationTasksInput = {
  userId: number;
  page: number;
  pageSize: number;
  status?: string;
};

/** 批次终态推进结果；释放任务用于继续调度，停止任务用于缓存和余额刷新。 */
export type GenerationBatchAdvanceResult = {
  releasedTasks: GenerationTaskView[];
  changedTaskIds: string[];
  refundedStoppedTasks: boolean;
};

/** 生成任务仓储只做数据访问和短事务，不调用外部 HTTP。 */
export class GenerationsRepository {
  private readonly walletService = new WalletService();

  /** 注入 Prisma 单例，避免请求内重复创建连接池。 */
  constructor(private readonly prisma: PrismaClient) {}

  /** 查询用户已验证 QQ 绑定；未绑定时 service 层返回禁止生成。 */
  findVerifiedBindingByUserId(userId: number) {
    return this.prisma.qqBinding.findUnique({
      where: { userId },
      select: {
        userId: true,
        qqNumber: true,
        verified: true,
      },
    });
  }

  /** 查询网页用户默认图片隐私；生成请求未显式传 isPrivate 时以此兜底。 */
  async findDefaultImagePrivateByUserId(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { defaultImagePrivate: true },
    });
    return user?.defaultImagePrivate ?? false;
  }

  /** 创建主任务；若 clientRequestId 已存在则返回既有主任务，保证一次提交只有一个主任务。 */
  async createTaskIdempotently(input: CreateGenerationTaskInput): Promise<{ task: GenerationTaskView; created: boolean }> {
    const existing = await this.findTaskByClientRequestId(input.clientRequestId, input.userId);
    if (existing) return { task: existing, created: false };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.generationTask.create({
          data: {
            id: input.taskId,
            clientRequestId: input.clientRequestId,
            userId: input.userId,
            source: 'web',
            mode: input.body.mode,
            prompt: input.body.prompt.trim(),
            qqNumber: input.qqNumber ?? null,
            templateId: input.body.templateId,
            sourceImageUrls: input.body.sourceImageUrls ?? Prisma.JsonNull,
            isPrivate: input.body.isPrivate ?? input.defaultImagePrivate,
            // 提示增强期间主任务已经真实运行，但尚未生成上游尝试；running 可供前端持续轮询，Worker 只会消费带 queued 尝试的 running 任务。
            status: input.promptAssistPending ? 'running' : 'queued',
            startedAt: input.promptAssistPending ? new Date() : undefined,
            subTasks: {
              create: buildInitialSubTasks(input.promptAssistStep, input.promptAssistPending),
            },
          },
          select: { id: true },
        });
        const dispatchParams = JSON.stringify({
          model: input.body.model,
          size: input.body.size,
          aspectRatio: input.body.aspectRatio,
          quality: input.body.quality,
          duration: input.body.duration,
          resolution: input.body.resolution,
          storyboardDesign: input.body.storyboardDesign === true,
          count: input.body.count ?? 1,
          sourceImageSizes: input.body.sourceImageSizes,
          effectivePrompt: input.effectivePrompt,
          referencePromptAssist: input.referencePromptAssist === true,
          promptFormat: input.promptFormat,
          lora: input.lora,
          maxAttempts: normalizeModelMaxAttempts(input.maxAttempts),
        });
        // 单图任务也在创建事务内保存调度参数，避免 worker 轮询在事务提交后立刻抢占时丢失用户指定模型。
        await tx.systemConfig.upsert({
          where: { key: buildTaskGenerationParamsKey(created.id) },
          update: { value: dispatchParams },
          create: { key: buildTaskGenerationParamsKey(created.id), value: dispatchParams },
        });
        // 网页任务创建成功时同步更新账号模型偏好，浏览器中断响应后仍能从真实上一个任务恢复。
        if (input.body.model) {
          await tx.userModelPref.upsert({
            where: { userId: input.userId },
            update: { model: input.body.model },
            create: { userId: input.userId, model: input.body.model },
          });
        }
        // 扣费与任务创建处于同一事务；余额不足会回滚任务，避免留下不可恢复的空任务。
        const charge = await this.walletService.chargeForGenerationTx(tx, {
          actor: 'web',
          userId: input.userId,
          qqNumber: input.qqNumber ?? undefined,
          taskId: created.id,
          amount: input.price,
          source: 'web',
        });
        const task = await tx.generationTask.update({
          where: { id: created.id },
          data: {
            chargedSource: charge.chargedSource,
            chargedAmount: charge.chargedAmount,
            chargedFreeAmount: charge.freeUsed,
            chargedPaidAmount: charge.paidUsed,
          },
          select: generationTaskSelect,
        });
        return { task: toGenerationTaskView(task), created: true };
      // 钱包首次创建可能与其他请求并发；ReadCommitted 允许回读已提交钱包，余额写入仍由钱包行锁保护。
      }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const task = await this.findTaskByClientRequestId(input.clientRequestId, input.userId);
        if (task) return { task, created: false };
      }
      throw error;
    }
  }

  /** 创建多图批次及其单图子任务；每个子任务独立扣费，便于失败后按原任务退款。 */
  async createBatchIdempotently(input: CreateGenerationBatchInput): Promise<{ batch: GenerationBatchView; tasks: GenerationTaskView[]; created: boolean }> {
    const existing = await this.findBatchByClientRequestId(input.clientRequestId, input.userId ?? undefined);
    if (existing) return { ...existing, created: false };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const batch = await tx.generationBatch.create({
          data: {
            id: input.batchId,
            clientRequestId: input.clientRequestId,
            userId: input.userId ?? null,
            qqNumber: input.qqNumber ?? null,
            source: input.source,
            mode: input.body.mode,
            prompt: input.body.prompt.trim(),
            status: 'queued',
            count: input.count,
            concurrency: input.concurrency,
            stopAfterConsecutiveFailures: input.stopAfterConsecutiveFailures,
          },
          select: generationBatchSelect,
        });

        const createdTaskIds: string[] = [];
        // Web 多图批次内所有单图使用同一调度模型，只需在批次事务内保存一次账号模型偏好。
        if (input.source === 'web' && input.userId && input.body.model) {
          await tx.userModelPref.upsert({
            where: { userId: input.userId },
            update: { model: input.body.model },
            create: { userId: input.userId, model: input.body.model },
          });
        }
        for (let index = 0; index < input.count; index += 1) {
          const taskId = input.taskIds[index];
          if (!taskId) throw new Error('批次子任务 ID 缺失');
          const isInitiallyQueued = index < input.concurrency;
          const created = await tx.generationTask.create({
            data: {
              id: taskId,
              clientRequestId: taskId,
              batchId: input.batchId,
              batchIndex: index + 1,
              batchTotal: input.count,
              userId: input.userId ?? null,
              source: input.source,
              mode: input.body.mode,
              prompt: input.body.prompt.trim(),
              qqNumber: input.qqNumber ?? null,
              templateId: input.body.templateId,
              sourceImageUrls: input.body.sourceImageUrls ?? Prisma.JsonNull,
              isPrivate: input.body.isPrivate ?? input.defaultImagePrivate,
              // 批次首批任务在共享提示增强期间保持 running，剩余任务仍 deferred；此时尚无上游尝试，Worker 不会提前消费。
              status: isInitiallyQueued ? (input.promptAssistPending ? 'running' : 'queued') : 'deferred',
              startedAt: isInitiallyQueued && input.promptAssistPending ? new Date() : undefined,
              subTasks: {
                create: buildInitialSubTasks(input.promptAssistStep, input.promptAssistPending),
              },
            },
            select: { id: true },
          });
          createdTaskIds.push(created.id);
          const dispatchParams = JSON.stringify({
            model: input.body.model,
            size: input.body.size,
            aspectRatio: input.body.aspectRatio,
            quality: input.body.quality,
            duration: input.body.duration,
            resolution: input.body.resolution,
            storyboardDesign: input.body.storyboardDesign === true,
            count: input.count,
            sourceImageSizes: input.body.sourceImageSizes,
            effectivePrompt: input.effectivePrompt,
            referencePromptAssist: input.referencePromptAssist === true,
            promptFormat: input.promptFormat,
            lora: input.lora,
            maxAttempts: normalizeModelMaxAttempts(input.maxAttempts),
          });
          // 批次 deferred 任务会在后续释放，必须保存用户当次选择的调度参数，避免后续回退默认模型或尺寸。
          await tx.systemConfig.upsert({
            where: { key: buildTaskGenerationParamsKey(created.id) },
            update: { value: dispatchParams },
            create: { key: buildTaskGenerationParamsKey(created.id), value: dispatchParams },
          });
          // 批次扣费必须逐任务写分账记录，停止未开始任务或单张失败时才能按任务幂等退款。
          const charge = await this.walletService.chargeForGenerationTx(tx, {
            actor: input.source,
            userId: input.userId ?? undefined,
            qqNumber: input.qqNumber ?? undefined,
            taskId: created.id,
            amount: input.price,
            source: input.source,
          });
          await tx.generationTask.update({
            where: { id: created.id },
            data: {
              chargedSource: charge.chargedSource,
              chargedAmount: charge.chargedAmount,
              chargedFreeAmount: charge.freeUsed,
              chargedPaidAmount: charge.paidUsed,
            },
          });
        }

        await tx.generationBatch.update({
          where: { id: input.batchId },
          data: { status: input.concurrency > 0 ? 'running' : 'queued' },
        });
        const tasks = await tx.generationTask.findMany({
          where: { id: { in: createdTaskIds } },
          orderBy: { batchIndex: 'asc' },
          select: generationTaskSelect,
        });
        return {
          batch: toGenerationBatchView({ ...batch, status: input.concurrency > 0 ? 'running' : batch.status }),
          tasks: tasks.map(toGenerationTaskView),
          created: true,
        };
      }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 30000 });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existingAfterRace = await this.findBatchByClientRequestId(input.clientRequestId, input.userId ?? undefined);
        if (existingAfterRace) return { ...existingAfterRace, created: false };
      }
      throw error;
    }
  }

  /** 原子固化异步提示增强结果，并完成每个任务的进行中时间线。 */
  async completePromptAssist(taskIds: string[], effectivePrompt: string, step: PromptAssistStepInput, batchId?: string): Promise<GenerationTaskView[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        // AI 已经成功返回提示词后只重试数据库事务，绝不再次调用模型或重复扣费。
        return await this.prisma.$transaction(async (tx) => {
          await tx.generationTask.updateMany({ where: { id: { in: taskIds } }, data: { prompt: effectivePrompt } });
          if (batchId) await tx.generationBatch.updateMany({ where: { id: batchId }, data: { prompt: effectivePrompt } });
          const rows = await tx.systemConfig.findMany({ where: { key: { in: taskIds.map(buildTaskGenerationParamsKey) } } });
          for (const row of rows) {
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(row.value) as Record<string, unknown>; } catch { /* 损坏快照只补写当前增强字段。 */ }
            parsed.effectivePrompt = effectivePrompt;
            await tx.systemConfig.update({ where: { key: row.key }, data: { value: JSON.stringify(parsed) } });
          }
          await tx.generationSubTask.updateMany({
            where: { taskId: { in: taskIds }, kind: 'prompt_assist', status: 'running' },
            data: { status: 'success', latencyMs: step.latencyMs, finishedAt: step.finishedAt },
          });
          const tasks = await tx.generationTask.findMany({
            where: { id: { in: taskIds } },
            orderBy: [{ batchIndex: 'asc' }, { createdAt: 'asc' }],
            select: generationTaskSelect,
          });
          return tasks.map(toGenerationTaskView);
        }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 30_000 });
      } catch (error) {
        lastError = error;
        if (attempt >= 3 || !isPromptAssistTransactionRetryable(error)) throw error;
        // 短退避让出连接与行锁；有效 AI 结果保留在当前内存中，不产生第二次推理。
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
      }
    }
    throw lastError;
  }

  /** 标记异步提示增强失败；主任务退款由 service 统一调用现有幂等事务。 */
  async failPromptAssist(taskIds: string[], error: string, finishedAt: Date) {
    await this.prisma.generationSubTask.updateMany({
      where: { taskId: { in: taskIds }, kind: 'prompt_assist', status: 'running' },
      data: { status: 'failed', error, finishedAt },
    });
  }

  /** 查询进程重启前已经持久化、但尚未进入绘图调度的提示增强任务。 */
  async findPendingPromptAssistTasks(limit = 100): Promise<GenerationTaskView[]> {
    const tasks = await this.prisma.generationTask.findMany({
      where: {
        status: { in: ['running', 'deferred'] },
        subTasks: {
          some: { kind: 'prompt_assist', status: 'running' },
          // 正常异步链路在增强完成前没有 dispatch；排除旧竞态任务，避免对已经绘图的任务重复投递。
          none: { kind: 'dispatch' },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { batchIndex: 'asc' }],
      take: Math.min(Math.max(limit, 1), 500),
      select: generationTaskSelect,
    });
    return tasks.map(toGenerationTaskView);
  }

  /** 按批次幂等键读取批次及其任务；Web 入口不能恢复其他用户批次。 */
  async findBatchByClientRequestId(clientRequestId: string, userId?: number): Promise<{ batch: GenerationBatchView; tasks: GenerationTaskView[] } | null> {
    const batch = await this.prisma.generationBatch.findFirst({
      where: {
        clientRequestId,
        ...(userId ? { userId } : {}),
      },
      select: generationBatchSelect,
    });
    if (!batch) return null;
    const tasks = await this.prisma.generationTask.findMany({
      where: { batchId: batch.id },
      orderBy: { batchIndex: 'asc' },
      select: generationTaskSelect,
    });
    return { batch: toGenerationBatchView(batch), tasks: tasks.map(toGenerationTaskView) };
  }

  /** 按 clientRequestId 查询当前用户的主任务，避免用户恢复到他人任务。 */
  async findTaskByClientRequestId(clientRequestId: string, userId?: number): Promise<GenerationTaskView | null> {
    const task = await this.prisma.generationTask.findFirst({
      where: {
        clientRequestId,
        ...(userId ? { userId } : {}),
      },
      select: generationTaskSelect,
    });
    return task ? toGenerationTaskView(task) : null;
  }

  /** 按 ID 查询当前用户历史任务；复投只读取参数来源，不修改原任务。 */
  async findTaskByIdForUser(taskId: string, userId: number): Promise<GenerationTaskView | null> {
    const task = await this.prisma.generationTask.findFirst({
      where: { id: taskId, userId },
      select: generationTaskSelect,
    });
    return task ? toGenerationTaskView(task) : null;
  }

  /** 按 ID 查询当前用户的主任务，含图片URL。 */
  async findTasksByIds(userId: number | null, ids: string[]): Promise<GenerationTaskView[]> {
    if (ids.length === 0) return [];
    const expandedIds = await this.expandVisibleTaskIds(userId, ids);
    if (expandedIds.length === 0) return [];
    const where: any = { id: { in: expandedIds } };
    if (userId !== null) where.userId = userId;
    const tasks = await this.prisma.generationTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: generationTaskSelect,
    });

    // 查询图片文件名映射
    const configKeys = expandedIds.map(id => `task_image_${id}`);
    const configs = await this.prisma.systemConfig.findMany({
      where: { key: { in: configKeys } },
      select: { key: true, value: true },
    });
    const imgMap = new Map<string, TaskMediaConfig>();
    for (const c of configs) {
      try {
        const v = JSON.parse(c.value) as TaskMediaConfig;
        imgMap.set(c.key.replace('task_image_', ''), v);
      } catch { /* skip malformed */ }
    }

    const order = new Map(expandedIds.map((id, index) => [id, index]));
    const orderedTasks = [...tasks].sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));

    return orderedTasks.map(t => {
      const view = toGenerationTaskView(t);
      const img = imgMap.get(t.id);
      attachTaskMedia(view, img);
      // 从最后一个成功/失败的 upstream_attempt 提取站点/模型/耗时
      const lastAttempt = [...(t.subTasks || [])].reverse().find(s => s.kind === 'upstream_attempt' && (s.status === 'success' || s.status === 'failed'));
      if (lastAttempt?.siteName) (view as any).siteName = lastAttempt.siteName;
      if (lastAttempt?.model) (view as any).model = lastAttempt.model;
      if (lastAttempt?.latencyMs != null) (view as any).latencyMs = lastAttempt.latencyMs;
      // 余额字段（result 卡片用）
      (view as any).chargedSource = t.chargedSource ?? undefined;
      (view as any).chargedAmount = t.chargedAmount ?? undefined;
      (view as any).chargedFreeAmount = t.chargedFreeAmount ?? undefined;
      (view as any).chargedPaidAmount = t.chargedPaidAmount ?? undefined;
      return view;
    });
  }

  /** 展开前端外显任务 ID；传入批次 ID 时返回该批次全部真实单图任务 ID。 */
  private async expandVisibleTaskIds(userId: number | null, ids: string[]): Promise<string[]> {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const batchRows = await this.prisma.generationTask.findMany({
      where: {
        batchId: { in: uniqueIds },
        ...(userId !== null ? { userId } : {}),
      },
      orderBy: [{ batchId: 'asc' }, { batchIndex: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, batchId: true },
    });
    const byBatch = new Map<string, string[]>();
    for (const row of batchRows) {
      if (!row.batchId) continue;
      const list = byBatch.get(row.batchId) ?? [];
      list.push(row.id);
      byBatch.set(row.batchId, list);
    }
    const result: string[] = [];
    for (const id of uniqueIds) {
      const batchTaskIds = byBatch.get(id);
      if (batchTaskIds?.length) result.push(...batchTaskIds);
      else result.push(id);
    }
    return [...new Set(result)];
  }

  /** 任务终态后推进批次：更新统计、按批次并发释放下一批，或停止未开始任务并退款。 */
  async advanceBatchAfterTaskTerminal(taskId: string): Promise<GenerationBatchAdvanceResult> {
    const emptyResult: GenerationBatchAdvanceResult = { releasedTasks: [], changedTaskIds: [], refundedStoppedTasks: false };
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { id: true, batchId: true, status: true },
    });
    if (!task?.batchId || (task.status !== 'success' && task.status !== 'failed')) return emptyResult;

    const advanceResult = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; concurrency: number; stop_after_consecutive_failures: number; consecutive_failures: number }>>`
        SELECT id, concurrency, stop_after_consecutive_failures, consecutive_failures
        FROM generation_batches
        WHERE id = ${task.batchId}
        FOR UPDATE
      `;
      const batch = locked[0];
      if (!batch) return { releasedIds: [], changedTaskIds: [], refundedStoppedTasks: false };

      const advanceKey = buildBatchTerminalAdvanceKey(task.id, task.status);
      const existingAdvance = await tx.systemConfig.findUnique({
        where: { key: advanceKey },
        select: { key: true },
      });
      if (existingAdvance) return { releasedIds: [], changedTaskIds: [], refundedStoppedTasks: false };
      // 批次推进必须按“每个子任务终态只消费一次”幂等；Worker/Bot 重试回写不能重复释放下一张或重复累加连续失败。
      await tx.systemConfig.create({
        data: {
          key: advanceKey,
          value: JSON.stringify({ batchId: batch.id, taskId: task.id, status: task.status, advancedAt: new Date().toISOString() }),
        },
      });

      // 批次连续失败按子任务完成顺序统计；成功会重置，避免单个任务内部重试失败误触发批次停止。
      const nextConsecutiveFailures = task.status === 'failed'
        ? Number(batch.consecutive_failures ?? 0) + 1
        : 0;
      await tx.generationBatch.update({
        where: { id: batch.id },
        data: { consecutiveFailures: nextConsecutiveFailures },
      });

      const statusRows = await tx.generationTask.groupBy({
        by: ['status'],
        where: { batchId: batch.id },
        _count: { id: true },
      });
      const statusCount = new Map(statusRows.map((row) => [row.status, row._count.id]));
      const successCount = statusCount.get('success') ?? 0;
      const failedCount = statusCount.get('failed') ?? 0;
      const activeCount = (statusCount.get('queued') ?? 0) + (statusCount.get('running') ?? 0) + (statusCount.get('finalizing') ?? 0);
      const deferredCount = statusCount.get('deferred') ?? 0;
      const stopThreshold = Math.max(1, Number(batch.stop_after_consecutive_failures ?? 1));

      if (deferredCount > 0 && nextConsecutiveFailures >= stopThreshold) {
        const deferred = await tx.generationTask.findMany({
          where: { batchId: batch.id, status: 'deferred' },
          orderBy: { batchIndex: 'asc' },
          select: { id: true },
        });
        const now = new Date();
        for (const item of deferred) {
          await tx.generationTask.update({
            where: { id: item.id },
            data: { status: 'failed', error: '批次连续失败已停止，未开始任务已退款', finishedAt: now },
          });
          await this.walletService.refundTaskByAllocationsTx(tx, item.id);
          await appendSubTaskAfterTaskLock(tx, item.id, {
            kind: 'finalize',
            status: 'failed',
            error: '批次连续失败已停止',
            finishedAt: now,
          });
        }
        const batchTerminal = activeCount === 0;
        await tx.generationBatch.update({
          where: { id: batch.id },
          data: {
            // 已停止 deferred 但仍有 active 任务时，批次继续保持 running，等最后一个 active 终态后再写最终状态和 finishedAt。
            status: batchTerminal ? successCount > 0 ? 'partial_success' : 'failed' : 'running',
            successCount,
            failedCount: failedCount + deferred.length,
            finishedAt: batchTerminal ? now : undefined,
          },
        });
        const stoppedIds = deferred.map((item) => item.id);
        return { releasedIds: [], changedTaskIds: stoppedIds, refundedStoppedTasks: stoppedIds.length > 0 };
      }

      // 批次释放只补齐当前空位：例如 count=3、concurrency=2 时，已有 1 张仍在 queued/running/finalizing，
      // 第一张终态后只释放 1 张 deferred，不能把剩余 deferred 全部放出造成并发超限。
      const slots = Math.max(0, Number(batch.concurrency ?? 1) - activeCount);
      const releaseLimit = Math.min(deferredCount, slots);
      const toRelease = releaseLimit > 0
        ? await tx.generationTask.findMany({
            where: { batchId: batch.id, status: 'deferred' },
            orderBy: { batchIndex: 'asc' },
            take: releaseLimit,
            select: { id: true },
          })
        : [];
      if (toRelease.length > 0) {
        await tx.generationTask.updateMany({
          where: { id: { in: toRelease.map((item) => item.id) }, status: 'deferred' },
          data: { status: 'queued' },
        });
      }

      const remainingDeferred = Math.max(0, deferredCount - toRelease.length);
      const remainingActive = activeCount + toRelease.length;
      const terminal = remainingDeferred === 0 && remainingActive === 0;
      await tx.generationBatch.update({
        where: { id: batch.id },
        data: {
          status: terminal
            ? successCount > 0 && failedCount === 0 ? 'success'
            : successCount > 0 ? 'partial_success'
            : 'failed'
            : 'running',
          successCount,
          failedCount,
          finishedAt: terminal ? new Date() : undefined,
        },
      });
      const releasedIds = toRelease.map((item) => item.id);
      return { releasedIds, changedTaskIds: releasedIds, refundedStoppedTasks: false };
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 30000 });

    if (advanceResult.releasedIds.length === 0) {
      return { releasedTasks: [], changedTaskIds: advanceResult.changedTaskIds, refundedStoppedTasks: advanceResult.refundedStoppedTasks };
    }
    const releasedTasks = await this.findTasksByIds(null, advanceResult.releasedIds);
    const order = new Map(advanceResult.releasedIds.map((id, index) => [id, index]));
    releasedTasks.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    return { releasedTasks, changedTaskIds: advanceResult.changedTaskIds, refundedStoppedTasks: advanceResult.refundedStoppedTasks };
  }

  /** 分页查询当前用户主任务；默认按创建时间倒序展示，含图片 URL。 */
  async listTasks(input: ListGenerationTasksInput) {
    const whereSql = buildUserTaskListWhereSql(input);
    const skip = (input.page - 1) * input.pageSize;
    const [taskIds, total] = await Promise.all([
      this.findUserTaskIds(whereSql, input.pageSize, skip),
      this.countUserTasks(whereSql),
    ]);
    const items = taskIds.length > 0
      ? await this.prisma.generationTask.findMany({
          where: { id: { in: taskIds } },
          select: generationTaskSelect,
        })
      : [];
    const itemMap = new Map(items.map((item) => [item.id, item]));
    const orderedItems = taskIds.map((id) => itemMap.get(id)).filter((item): item is (typeof items)[number] => Boolean(item));

    // 查询图片文件名映射（与 findTasksByIds 一致）
    const configKeys = orderedItems.map(item => `task_image_${item.id}`);
    const configs = configKeys.length > 0
      ? await this.prisma.systemConfig.findMany({
          where: { key: { in: configKeys } },
          select: { key: true, value: true },
        })
      : [];
    const imgMap = new Map<string, TaskMediaConfig>();
    for (const c of configs) {
      try {
        const v = JSON.parse(c.value) as TaskMediaConfig;
        imgMap.set(c.key.replace('task_image_', ''), v);
      } catch { /* 跳过解析失败的条目 */ }
    }

    return {
      items: orderedItems.map(t => {
        const view = toGenerationTaskView(t);
        const img = imgMap.get(t.id);
        attachTaskMedia(view, img);
        return view;
      }),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  /** 查询用户任务 ID；成功任务必须存在图片配置，避免旧断链任务继续占用个人图片列表。 */
  private async findUserTaskIds(whereSql: Prisma.Sql, take: number, skip: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT picked.id
      FROM (
        SELECT
          COALESCE(t.batch_id, t.id) AS visible_task_id,
          SUBSTRING_INDEX(
            GROUP_CONCAT(t.id ORDER BY COALESCE(t.batch_index, 1) ASC, t.created_at ASC SEPARATOR ','),
            ',',
            1
          ) AS id,
          MAX(t.created_at) AS sort_created_at
        FROM generation_tasks t
        WHERE ${whereSql}
        GROUP BY COALESCE(t.batch_id, t.id)
      ) picked
      ORDER BY picked.sort_created_at DESC, picked.id DESC
      LIMIT ${take} OFFSET ${skip}
    `);
    return rows.map((row) => row.id);
  }

  /** 统计用户可展示任务；失败和运行中任务保留，成功任务只统计仍有图片的记录。 */
  private async countUserTasks(whereSql: Prisma.Sql): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ total: bigint | number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT COALESCE(t.batch_id, t.id)) AS total
      FROM generation_tasks t
      WHERE ${whereSql}
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /** 内部接口追加子任务，sequence 在事务中递增，调用方不能伪造顺序。 */
  async appendSubTask(input: GenerationAppendSubTaskRequest) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.appendSubTaskOnce(input);
      } catch (error) {
        // 并发追加子任务时，MySQL 偶发唯一键、行版本或死锁冲突，短退避后重算 sequence 并重试。
        if (attempt < maxAttempts && (isUniqueConstraintError(error) || isMySqlChangedSinceReadError(error) || isPrismaWriteConflictOrDeadlockError(error))) {
          await sleep(20 * attempt);
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  /** 单次追加子任务事务；先锁定主任务行，再计算 sequence，避免并发请求读到相同最大序号。 */
  private async appendSubTaskOnce(input: GenerationAppendSubTaskRequest) {
    return this.prisma.$transaction(async (tx) => {
      const lockedTasks = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM generation_tasks WHERE id = ${input.taskId} FOR UPDATE
      `;
      if (lockedTasks.length === 0) return null;

      if (input.kind === 'upstream_attempt') {
        // drawing-service/Worker 会先放置 queued 或 running 占位尝试；真实上游结果写入前必须收尾旧占位，避免后台时间线长期显示等待中。
        await tx.generationSubTask.updateMany({
          where: {
            taskId: input.taskId,
            kind: 'upstream_attempt',
            status: { in: ['queued', 'running'] },
          },
          data: {
            status: 'skipped',
            error: '已由上游调用结果覆盖',
            finishedAt: new Date(),
          },
        });
        if (input.attemptNo !== undefined) {
          // 新一轮真实上游尝试已开始，前置切站/同站重试节点已经完成，不能继续外显为“运行中”。
          await tx.generationSubTask.updateMany({
            where: {
              taskId: input.taskId,
              kind: { in: ['site_switch', 'same_site_retry'] },
              status: 'running',
              attemptNo: { lte: input.attemptNo },
            },
            data: {
              status: 'success',
              error: null,
              finishedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
            },
          });
        }
      }

      if ((input.kind === 'site_switch' || input.kind === 'same_site_retry') && input.status !== 'running') {
        // 任务收尾只负责关闭已有重试节点，不再追加一条“跳过”噪声记录。
        await tx.generationSubTask.updateMany({
          where: {
            taskId: input.taskId,
            kind: isRetryTransitionCleanup(input) ? { in: ['site_switch', 'same_site_retry'] } : input.kind,
            status: 'running',
            ...(input.attemptNo !== undefined ? { attemptNo: { lte: input.attemptNo } } : {}),
          },
          data: {
            status: input.status,
            error: input.error,
            finishedAt: input.finishedAt ? new Date(input.finishedAt) : new Date(),
          },
        });
        if (isRetryTransitionCleanup(input)) {
          const latest = await findLatestSubTaskView(tx, input.taskId);
          if (latest) return latest;
        }
      }

      const lastSubTask = await tx.generationSubTask.findFirst({
        where: { taskId: input.taskId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const sequence = (lastSubTask?.sequence ?? 0) + 1;
      const subTask = await tx.generationSubTask.create({
        data: {
          taskId: input.taskId,
          sequence,
          kind: input.kind,
          status: input.status,
          attemptNo: input.attemptNo,
          siteId: input.siteId,
          siteName: input.siteName,
          model: input.model,
          retryable: input.retryable,
          nextAction: input.nextAction,
          latencyMs: input.latencyMs,
          error: input.error,
          rawError: input.rawError,
          startedAt: input.startedAt ? new Date(input.startedAt) : undefined,
          finishedAt: input.finishedAt ? new Date(input.finishedAt) : undefined,
        },
        select: generationSubTaskSelect,
      });
      return toGenerationSubTaskView(subTask);
    // 子任务时间线只做短事务追加；ReadCommitted 降低并发上报时的死锁概率，失败仍由外层重试或抛出。
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 内部接口更新主任务状态；状态切换只写主任务，不在事务中调用外部服务。 */
  async updateTaskStatus(input: GenerationUpdateTaskStatusRequest): Promise<GenerationTaskView | null> {
    return this.prisma.$transaction(async (tx) => {
      const lockedTasks = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM generation_tasks WHERE id = ${input.taskId} FOR UPDATE
      `;
      if (lockedTasks.length === 0) return null;

      const existing = await tx.generationTask.findUnique({
        where: { id: input.taskId },
        select: { status: true, startedAt: true },
      });
      if (!existing) return null;

      // 终态任务不允许被后到的 worker 回写覆盖，避免失败已退款后又被改成成功。
      if (existing.status !== 'success' && existing.status !== 'failed') {
        const now = new Date();
        if (input.status === 'success' || input.status === 'failed') {
          // 主任务进入终态时，兜底关闭仍未收口的重试流转节点，避免详情页残留假运行态。
          await closeRunningRetryTransitionsTx(tx, input.taskId, 'skipped', input.error ?? '任务已结束', now);
        }
        await tx.generationTask.update({
          where: { id: input.taskId },
          data: {
            status: input.status,
            error: input.error,
            // 提示增强任务在创建时已经开始计时；drawing-service 再次写 running 时不得覆盖总任务起点。
            startedAt: input.status === 'running' && !existing.startedAt ? now : undefined,
            finishedAt: input.status === 'success' || input.status === 'failed' ? now : undefined,
          },
        });
      }

      const task = await tx.generationTask.findUnique({ where: { id: input.taskId }, select: generationTaskSelect });
      return task ? toGenerationTaskView(task) : null;
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 原子标记任务失败并按记录的扣费明细退款；只有首次从非终态切到 failed 才会退款。 */
  async failTaskAndRefund(input: { taskId: string; error?: string; finishedAt?: Date }): Promise<{ task: GenerationTaskView | null; changed: boolean; refunded: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const lockedTasks = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM generation_tasks WHERE id = ${input.taskId} FOR UPDATE
      `;
      if (lockedTasks.length === 0) return { task: null, changed: false, refunded: false };

      const current = await tx.generationTask.findUnique({
        where: { id: input.taskId },
        select: generationTaskSelect,
      });
      if (!current) return { task: null, changed: false, refunded: false };

      if (current.status === 'success' || current.status === 'failed') {
        return { task: toGenerationTaskView(current), changed: false, refunded: false };
      }

      const now = input.finishedAt ?? new Date();
      // 失败退款事务内同步整理子任务时间线，只更新重试流转状态，不触碰钱包金额和扣费流水。
      await closeRunningRetryTransitionsTx(tx, input.taskId, 'skipped', input.error ?? '任务已结束', now);
      const updated = await tx.generationTask.update({
        where: { id: input.taskId },
        data: {
          status: 'failed',
          error: input.error,
          finishedAt: now,
        },
        select: generationTaskSelect,
      });

      const refundedByWallet = await this.walletService.refundTaskByAllocationsTx(tx, input.taskId);
      const freeAmount = refundedByWallet ? 0 : parseMoney(current.chargedFreeAmount);
      const paidAmount = refundedByWallet ? 0 : parseMoney(current.chargedPaidAmount);
      if (!refundedByWallet && current.qqNumber && (freeAmount > 0 || paidAmount > 0)) {
        // 兼容迁移前创建、尚未写入 task_charge_allocations 的旧任务；只回退旧 QQ 余额字段。
        await tx.qqQuota.upsert({
          where: { qqNumber: current.qqNumber },
          update: { freeBalance: { increment: freeAmount }, paidBalance: { increment: paidAmount } },
          create: { qqNumber: current.qqNumber, freeBalance: freeAmount, paidBalance: paidAmount },
        });
      }

      return { task: toGenerationTaskView(updated), changed: true, refunded: refundedByWallet || freeAmount > 0 || paidAmount > 0 };
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
  }

  /** 从 system_configs 读取配置值，带默认兜底。 */
  async getConfigValue(key: string, fallback: string): Promise<string> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? fallback;
  }

  /** 读取任务创建时保存的调度参数快照；历史快照缺少尝试次数时按 3 次兼容。 */
  async findTaskGenerationParams(taskId: string): Promise<TaskGenerationParamsSnapshot> {
    const snapshots = await this.findTaskGenerationParamsByIds([taskId]);
    return snapshots.get(taskId) ?? { maxAttempts: DEFAULT_MODEL_MAX_ATTEMPTS };
  }

  /** 批量读取任务调度参数，避免任务轮询列表按任务逐条查询 system_configs。 */
  async findTaskGenerationParamsByIds(taskIds: string[]): Promise<Map<string, TaskGenerationParamsSnapshot>> {
    const keys = taskIds.map(buildTaskGenerationParamsKey);
    if (keys.length === 0) return new Map();
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: keys } },
      select: { key: true, value: true },
    });
    const result = new Map<string, TaskGenerationParamsSnapshot>();
    for (const row of rows) {
      const taskId = row.key.slice('task_generation_params_'.length);
      result.set(taskId, parseTaskGenerationParamsSnapshot(row.value));
    }
    return result;
  }

  /** 解析生成任务真实扣费金额；当前只使用外部上游基础单价，本地模型链路已下线。 */
  async resolveGenerationPrice(input: { model?: string; mode?: string; basePrice: number }): Promise<number> {
    // 扣费以独立模型配置为准；历史全局单价只作为未迁移模型的兜底。
    return resolveConfiguredModelPrice(this.prisma, input.model, normalizeMoney(input.basePrice, 0.05));
  }

  /** 查找用户最近一次生成任务（用于冷却检查）。 */
  async findLastTaskByUserId(userId: number) {
    return this.prisma.generationTask.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
  }

  /** 查找同一 QQ 号的运行中任务（用于生成中阻塞检查）。 */
  async findRunningTaskByQqNumber(qqNumber: bigint) {
    return this.prisma.generationTask.findFirst({
      where: { qqNumber, status: { in: ['queued', 'running', 'finalizing'] } },
      select: { id: true },
    });
  }

  /** 查找同一 Web 用户的运行中任务，用于未绑定 QQ 的独立网页钱包模式。 */
  async findRunningTaskByUserId(userId: number) {
    return this.prisma.generationTask.findFirst({
      where: { userId, status: { in: ['queued', 'running', 'finalizing'] } },
      select: { id: true },
    });
  }
}

/** 主任务查询字段，显式 select 避免默认返回未来的大字段。 */
const generationTaskSelect = {
  id: true,
  clientRequestId: true,
  batchId: true,
  batchIndex: true,
  batchTotal: true,
  userId: true,
  source: true,
  mode: true,
  prompt: true,
  qqNumber: true,
  templateId: true,
  sourceImageUrls: true,
  isPrivate: true,
  status: true,
  error: true,
  chargedSource: true,
  chargedAmount: true,
  chargedFreeAmount: true,
  chargedPaidAmount: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  finishedAt: true,
  subTasks: {
    orderBy: { sequence: 'asc' },
    select: {
      id: true,
      taskId: true,
      sequence: true,
      kind: true,
      status: true,
      attemptNo: true,
      siteId: true,
      siteName: true,
      model: true,
      retryable: true,
      nextAction: true,
      latencyMs: true,
      error: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
    },
  },
} satisfies Prisma.GenerationTaskSelect;

/** 批次查询字段，显式 select 避免默认返回未来的大字段。 */
const generationBatchSelect = {
  id: true,
  clientRequestId: true,
  status: true,
  source: true,
  count: true,
  concurrency: true,
  stopAfterConsecutiveFailures: true,
  successCount: true,
  failedCount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.GenerationBatchSelect;

/** 子任务查询字段；rawError 不返回普通视图，避免上游敏感信息泄露。 */
const generationSubTaskSelect = {
  id: true,
  taskId: true,
  sequence: true,
  kind: true,
  status: true,
  attemptNo: true,
  siteId: true,
  siteName: true,
  model: true,
  retryable: true,
  nextAction: true,
  latencyMs: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.GenerationSubTaskSelect;

type GenerationTaskRecord = Prisma.GenerationTaskGetPayload<{ select: typeof generationTaskSelect }>;
type GenerationSubTaskRecord = Prisma.GenerationSubTaskGetPayload<{ select: typeof generationSubTaskSelect }>;
type GenerationBatchRecord = Prisma.GenerationBatchGetPayload<{ select: typeof generationBatchSelect }>;

/** 将 Prisma 批次记录转换为共享契约视图。 */
function toGenerationBatchView(batch: GenerationBatchRecord): GenerationBatchView {
  return {
    id: batch.id,
    clientRequestId: batch.clientRequestId,
    status: batch.status as GenerationBatchView['status'],
    source: batch.source as GenerationBatchView['source'],
    count: batch.count,
    concurrency: batch.concurrency,
    stopAfterConsecutiveFailures: batch.stopAfterConsecutiveFailures,
    successCount: batch.successCount,
    failedCount: batch.failedCount,
    createdAt: formatChinaDateTime(batch.createdAt),
    updatedAt: formatChinaDateTime(batch.updatedAt),
  };
}

/** 将 Prisma 主任务记录转换为共享契约视图。 */
function toGenerationTaskView(task: GenerationTaskRecord): GenerationTaskView {
  const sourceImageUrls = Array.isArray(task.sourceImageUrls)
    ? task.sourceImageUrls.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    id: task.id,
    clientRequestId: task.clientRequestId,
    batchId: task.batchId ?? undefined,
    batchIndex: task.batchIndex ?? undefined,
    batchTotal: task.batchTotal ?? undefined,
    status: task.status as GenerationTaskView['status'],
    source: task.source as GenerationTaskView['source'],
    mode: task.mode as GenerationTaskView['mode'],
    prompt: task.prompt,
    qqNumber: task.qqNumber ? task.qqNumber.toString() : undefined,
    userId: task.userId ?? undefined,
    templateId: task.templateId ?? undefined,
    sourceImageUrls,
    isPrivate: task.isPrivate,
    error: task.error ?? undefined,
    createdAt: formatChinaDateTime(task.createdAt),
    updatedAt: formatChinaDateTime(task.updatedAt),
    startedAt: task.startedAt ? formatChinaDateTime(task.startedAt) : undefined,
    finishedAt: task.finishedAt ? formatChinaDateTime(task.finishedAt) : undefined,
    subTasks: task.subTasks.map(toGenerationSubTaskView),
  };
}

/** 将 Prisma 子任务记录转换为共享契约视图。 */
function toGenerationSubTaskView(subTask: GenerationSubTaskRecord): GenerationSubTaskView {
  return {
    id: subTask.id,
    taskId: subTask.taskId,
    sequence: subTask.sequence,
    kind: subTask.kind as GenerationSubTaskView['kind'],
    status: subTask.status as GenerationSubTaskView['status'],
    attemptNo: subTask.attemptNo ?? undefined,
    siteId: subTask.siteId ?? undefined,
    siteName: subTask.siteName ?? undefined,
    model: subTask.model ?? undefined,
    retryable: subTask.retryable ?? undefined,
    nextAction: subTask.nextAction as GenerationSubTaskView['nextAction'],
    latencyMs: subTask.latencyMs ?? undefined,
    error: subTask.error ?? undefined,
    createdAt: formatChinaDateTime(subTask.createdAt),
    startedAt: subTask.startedAt ? formatChinaDateTime(subTask.startedAt) : undefined,
    finishedAt: subTask.finishedAt ? formatChinaDateTime(subTask.finishedAt) : undefined,
  };
}

/** 判断 Prisma 唯一约束错误，用于并发幂等恢复。 */
function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 判断 Prisma 记录不存在错误，用于内部接口返回 not_found。 */
function isRecordNotFoundError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/** 判断 MySQL 行版本冲突错误，用于并发追加子任务时的短重试。 */
function isMySqlChangedSinceReadError(error: unknown) {
  return error instanceof Prisma.PrismaClientUnknownRequestError
    && error.message.includes("Record has changed since last read in table 'generation_sub_tasks'");
}

/** 判断 Prisma 事务写冲突或死锁错误；appendSubTask 会在事务内重算 sequence，短重试不会复用旧序号。 */
function isPrismaWriteConflictOrDeadlockError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2034'
    && error.message.includes('write conflict or a deadlock');
}

/** 判断提示增强固化阶段可安全重试的事务拥塞；事务本身原子且未提交时重试不会产生重复记录。 */
function isPromptAssistTransactionRetryable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Unable to start a transaction|Transaction API error|write conflict|deadlock|timed out fetching a new connection/i.test(message);
}

/** 判断是否为 worker 收尾时发出的重试流转清理上报；该类上报只更新旧节点，不生成新时间线项。 */
function isRetryTransitionCleanup(input: GenerationAppendSubTaskRequest) {
  return (input.kind === 'site_switch' || input.kind === 'same_site_retry')
    && input.status !== 'running'
    && input.attemptNo === undefined
    && input.siteId === undefined
    && input.siteName === undefined
    && input.model === undefined
    && input.retryable === undefined
    && input.nextAction === undefined
    && input.latencyMs === undefined
    && input.rawError === undefined
    && input.startedAt === undefined;
}

/** 查询任务最后一条子任务，供清理型上报返回稳定响应并避免追加噪声节点。 */
async function findLatestSubTaskView(tx: Prisma.TransactionClient, taskId: string) {
  const latest = await tx.generationSubTask.findFirst({
    where: { taskId },
    orderBy: { sequence: 'desc' },
    select: generationSubTaskSelect,
  });
  return latest ? toGenerationSubTaskView(latest) : null;
}

/** 终态写入兜底关闭切站/同站重试的 running 节点，防止已结束任务仍显示处理中。 */
async function closeRunningRetryTransitionsTx(
  tx: Prisma.TransactionClient,
  taskId: string,
  status: GenerationSubTaskView['status'],
  error: string,
  finishedAt: Date,
) {
  await tx.generationSubTask.updateMany({
    where: {
      taskId,
      kind: { in: ['site_switch', 'same_site_retry'] },
      status: 'running',
    },
    data: {
      status,
      error,
      finishedAt,
    },
  });
}

/** 批次内部取消未开始任务时追加 finalize 子任务；调用方已在事务内，不做外部请求。 */
async function appendSubTaskAfterTaskLock(
  tx: Prisma.TransactionClient,
  taskId: string,
  data: Omit<Prisma.GenerationSubTaskUncheckedCreateInput, 'taskId' | 'sequence'>,
) {
  await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM generation_tasks WHERE id = ${taskId} FOR UPDATE
  `;
  const lastSubTask = await tx.generationSubTask.findFirst({
    where: { taskId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  await tx.generationSubTask.create({
    data: {
      taskId,
      sequence: (lastSubTask?.sequence ?? 0) + 1,
      ...data,
    },
  });
}

/** 解析数据库中以字符串保存的金额，统一保留两位小数，非法值按 0 处理。 */
function parseMoney(value: string | null | undefined) {
  const amount = Number.parseFloat(value ?? '0');
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100) / 100;
}

function normalizeMoney(value: number, fallback: number) {
  const amount = Number.isFinite(value) && value >= 0 ? value : fallback;
  return Math.round(amount * 100) / 100;
}

/** 构造任务初始时间线；增强结果只记录审计步骤，不在事务内再次调用外部 AI。 */
function buildInitialSubTasks(promptAssistStep?: PromptAssistStepInput, promptAssistPending = false) {
  const receivedAt = promptAssistStep?.startedAt ?? new Date();
  return [
    {
      sequence: 1,
      kind: 'request_received',
      status: 'success',
      startedAt: receivedAt,
      finishedAt: receivedAt,
    },
    ...(promptAssistStep ? [{
      sequence: 2,
      kind: 'prompt_assist',
      status: 'success',
      latencyMs: promptAssistStep.latencyMs,
      startedAt: promptAssistStep.startedAt,
      finishedAt: promptAssistStep.finishedAt,
    }] : promptAssistPending ? [{
      sequence: 2,
      kind: 'prompt_assist',
      status: 'running',
      startedAt: receivedAt,
    }] : []),
  ];
}

/** 解析任务调度快照；损坏或旧数据只回退尝试次数，不伪造其他生成参数。 */
function parseTaskGenerationParamsSnapshot(value: string): TaskGenerationParamsSnapshot {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : undefined,
      size: typeof parsed.size === 'string' && parsed.size.trim() ? parsed.size : undefined,
      aspectRatio: isDrawingAspectRatio(parsed.aspectRatio) ? parsed.aspectRatio : undefined,
      quality: typeof parsed.quality === 'string' && parsed.quality.trim() ? parsed.quality : undefined,
      duration: Number.isSafeInteger(parsed.duration) && Number(parsed.duration) >= 1 && Number(parsed.duration) <= 15 ? Number(parsed.duration) : undefined,
      resolution: parsed.resolution === '480p' || parsed.resolution === '720p' || parsed.resolution === '1080p' ? parsed.resolution : undefined,
      storyboardDesign: typeof parsed.storyboardDesign === 'boolean' ? parsed.storyboardDesign : undefined,
      count: Number.isSafeInteger(parsed.count) && Number(parsed.count) >= 1 ? Number(parsed.count) : undefined,
      sourceImageSizes: Array.isArray(parsed.sourceImageSizes)
        ? parsed.sourceImageSizes.filter((item): item is number => Number.isSafeInteger(item) && item >= 0)
        : undefined,
      effectivePrompt: typeof parsed.effectivePrompt === 'string' && parsed.effectivePrompt.trim() ? parsed.effectivePrompt : undefined,
      referencePromptAssist: parsed.referencePromptAssist === true,
      promptFormat: parsed.promptFormat === 'standard' || parsed.promptFormat === 'diffusion' || parsed.promptFormat === 'anima' ? parsed.promptFormat : undefined,
      lora: parseDrawingLoraSnapshot(parsed.lora),
      maxAttempts: normalizeModelMaxAttempts(parsed.maxAttempts),
    };
  } catch {
    return { maxAttempts: DEFAULT_MODEL_MAX_ATTEMPTS };
  }
}

/** 解析任务快照中的 LoRA 元数据；旧数据或损坏字段按未选择处理。 */
function parseDrawingLoraSnapshot(value: unknown): DrawingLoraSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const strength = Number(record.strength);
  const sizeBytes = Number(record.sizeBytes);
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const baseModel = typeof record.baseModel === 'string' ? record.baseModel.trim() : '';
  const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim().toLowerCase() : '';
  const gpuFileName = typeof record.gpuFileName === 'string' ? record.gpuFileName.trim() : '';
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(strength) || strength < 0 || strength > 2) return undefined;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || !title || !baseModel || !/^[a-f0-9]{64}$/.test(sha256)) return undefined;
  if (!/^aiimage_lora_[a-f0-9]{64}\.safetensors$/.test(gpuFileName)) return undefined;
  return { id, strength, sizeBytes, title, baseModel, sha256, gpuFileName };
}

/** 批次任务调度参数快照 key；只保存模型、尺寸和质量，不保存凭证或图片数据。 */
function buildTaskGenerationParamsKey(taskId: string) {
  return `task_generation_params_${taskId}`;
}

/** 批次终态推进幂等 key；长度控制在 system_configs.key 的 96 字符内。 */
function buildBatchTerminalAdvanceKey(taskId: string, status: string) {
  return `batch_terminal_advance_${taskId}_${status}`;
}

/** 个人任务列表保留非成功任务；成功任务必须有图片配置，避免旧丢图记录渲染为空卡片。 */
function buildUserTaskListWhereSql(input: ListGenerationTasksInput): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`t.user_id = ${input.userId}`,
    Prisma.sql`(t.status <> 'success' OR EXISTS (SELECT 1 FROM system_configs c WHERE c.\`key\` = CONCAT('task_image_', t.id)))`,
  ];
  if (input.status) clauses.push(Prisma.sql`t.status = ${input.status}`);
  return joinSqlClauses(clauses, Prisma.sql` AND `);
}

/** task_image_ 配置兼容图片和视频结果；视频不复用 imageFilename，避免图库按图片解析。 */
type TaskMediaConfig = {
  mediaType?: 'image' | 'video';
  imageFilename?: string;
  thumbnailFilename?: string;
  videoFilename?: string;
  duration?: number;
  resolution?: DrawingVideoResolution;
  aspectRatio?: DrawingAspectRatio;
};

/** 将本地媒体配置附加到任务视图，所有列表和轮询保持同一字段语义。 */
function attachTaskMedia(view: GenerationTaskView, media?: TaskMediaConfig): void {
  if (!media) return;
  if (media.mediaType === 'video' && media.videoFilename) {
    view.mediaType = 'video';
    view.videoUrl = `/images/${media.videoFilename}`;
    if (media.thumbnailFilename) view.thumbnailUrl = `/images/${media.thumbnailFilename}`;
    view.duration = media.duration;
    view.resolution = media.resolution;
    view.aspectRatio = media.aspectRatio;
    return;
  }
  if (media.imageFilename) view.imageUrl = `/images/${media.imageFilename}`;
  if (media.thumbnailFilename) view.thumbnailUrl = `/images/${media.thumbnailFilename}`;
  if (media.imageFilename || media.thumbnailFilename) view.mediaType = 'image';
}

/** 拼接 Prisma SQL 条件，所有动态值通过 Prisma 参数绑定，避免 SQL 注入。 */
function joinSqlClauses(clauses: Prisma.Sql[], separator: Prisma.Sql): Prisma.Sql {
  return clauses.reduce((sql, clause, index) => (
    index === 0 ? clause : Prisma.sql`${sql}${separator}${clause}`
  ), Prisma.empty);
}

/** 短退避等待，避免并发事务立即重撞同一行锁。 */
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 将 Date 格式化为中国时区 ISO 字符串，避免前端再次按本地时区换算。 */
function formatChinaDateTime(date: Date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}
