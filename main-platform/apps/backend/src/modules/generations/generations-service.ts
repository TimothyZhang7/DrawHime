/** 本文件实现生成主任务创建、恢复、查询和内部子任务写入用例。 */
import { randomBytes } from 'node:crypto';
import type {
  GenerationAppendSubTaskRequest,
  GenerationCreateRequest,
  GenerationCooldownResponse,
  GenerationListResponse,
  GenerationRecoverResponse,
  GenerationTasksResponse,
  GenerationTaskView,
  GenerationUpdateTaskStatusRequest,
  DrawingPromptFormat,
  DrawingLoraSnapshot,
} from '@aiimage/shared-contracts';
import { summarizeGenerationFailure } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { submitDrawingTask } from '../../infrastructure/http/drawing-client.js';
import { GenerationsRepository, type PromptAssistStepInput } from './generations-repository.js';
import { GenerationError } from './generations-types.js';
import { invalidateImageCache, invalidateTaskCache, invalidateUserCache, invalidateWalletCache } from '../../shared/cache/cache-service.js';
import { pickRetryModelFromSubTasks, readEnabledModelNames } from './generation-model-utils.js';
import { resolveConfiguredModelMaxAttempts, resolveConfiguredModelName, resolveConfiguredModelPromptFormat, resolveConfiguredModelReferencePromptAssistEnabled, resolveConfiguredModelStoryboardEnabled } from './model-settings-service.js';
import { assertGenerationSourceImagesAvailable, normalizeGenerationSourceImageUrls, SourceImageUnavailableError } from './source-image-utils.js';
import { ReferencePromptAssistError, ReferencePromptAssistService, REFERENCE_PROMPT_ASSIST_MAX_IMAGES } from './reference-prompt-assist-service.js';
import { GalleryTaggingService } from '../gallery/gallery-tagging-service.js';
import { VideoStoryboardError, VideoStoryboardService } from './video-storyboard-service.js';
import { LoraRepositoryError, LoraRepositoryService } from '../lora/lora-repository-service.js';

/** 默认分页大小，避免生成任务列表无上限查询。 */
const DEFAULT_PAGE_SIZE = 20;

/** 最大分页大小，保护 MySQL 查询和响应体大小。 */
const MAX_PAGE_SIZE = 50;

/** backend 投递 drawing-service 的短重试次数，与模型上游尝试预算相互独立。 */
const DRAWING_SERVICE_DISPATCH_ATTEMPTS = 3;

/** 生成任务服务负责业务规则、幂等和服务间调用编排。 */
export class GenerationsService {
  private readonly repository = new GenerationsRepository(getPrismaClient());
  private readonly galleryTaggingService = new GalleryTaggingService();
  private readonly videoStoryboardService = new VideoStoryboardService(getPrismaClient());
  private readonly referencePromptAssistService = new ReferencePromptAssistService(getPrismaClient());
  private readonly loraRepositoryService = new LoraRepositoryService();

  /** 创建或幂等恢复用户的一次生成主任务，并异步通知 drawing-service 接收处理。 */
  async createTask(userId: number, body: GenerationCreateRequest, options?: { effectivePromptOverride?: string }) {
    const normalizedBodyBase = normalizeGenerationCreateBody(body);
    const resolvedModel = await resolveConfiguredModelName(getPrismaClient(), normalizedBodyBase.model);
    const enabledMainModels = await readEnabledModelNames(getPrismaClient());
    // 主站必须在创建任务和扣费前拦截已迁移的本地模型以及任意失效模型名。
    if (!resolvedModel || !enabledMainModels.has(resolvedModel)) {
      throw new GenerationError('invalid_request', '当前模型在主站不可用；本地模型请前往独立本地模型平台');
    }
    // 默认模型和别名解析必须在扣费、快照和投递前完成，保证展示配置真实影响后端调度。
    let normalizedBody: GenerationCreateRequest = { ...normalizedBodyBase, model: resolvedModel };
    const [maxAttempts, storyboardDesignEnabled, referencePromptAssistEnabled, promptFormat] = await Promise.all([
      resolveConfiguredModelMaxAttempts(getPrismaClient(), resolvedModel),
      resolveConfiguredModelStoryboardEnabled(getPrismaClient(), resolvedModel),
      resolveConfiguredModelReferencePromptAssistEnabled(getPrismaClient(), resolvedModel),
      resolveConfiguredModelPromptFormat(getPrismaClient(), resolvedModel),
    ]);
    const isVideoTask = normalizedBody.mode === 'text-to-video' || normalizedBody.mode === 'image-to-video';
    let loraSnapshot: DrawingLoraSnapshot | undefined;
    if (normalizedBody.lora) {
      if (isVideoTask) throw new GenerationError('invalid_request', '视频任务不支持 LoRA');
      try {
        // 浏览器只提交 ID 和强度，文件名、哈希及兼容性必须由 backend 权威解析。
        loraSnapshot = await this.loraRepositoryService.resolveGenerationSelection(normalizedBody.lora, promptFormat);
      } catch (error) {
        if (error instanceof LoraRepositoryError) throw new GenerationError('invalid_request', error.message);
        throw error;
      }
    }
    if (normalizedBody.referencePromptAssist === true && !referencePromptAssistEnabled) {
      throw new GenerationError('invalid_request', '当前文生图模型未开放 AI 提示增强');
    }
    // 模型开关开启后 Web、工作台和其他用户入口默认增强；网页关闭时必须显式传 false。
    const usePromptAssist = normalizedBody.mode === 'text-to-image'
      && referencePromptAssistEnabled
      && normalizedBody.referencePromptAssist !== false;
    normalizedBody = { ...normalizedBody, referencePromptAssist: usePromptAssist };
    if (isVideoTask && normalizedBody.count !== undefined && normalizedBody.count !== 1) {
      throw new GenerationError('invalid_request', '视频任务每次只能生成 1 个结果');
    }
    const count = isVideoTask ? 1 : await this.normalizeRequestedCount(normalizedBody.count);
    const [binding, defaultImagePrivate] = await Promise.all([
      this.repository.findVerifiedBindingByUserId(userId),
      this.repository.findDefaultImagePrivateByUserId(userId),
    ]);
    const qqNumber = binding?.verified ? binding.qqNumber ?? null : null;

    const clientRequestId = normalizedBody.clientRequestId?.trim() || createClientRequestId();
    const taskId = count > 1 ? createBatchId(clientRequestId) : createTaskId(clientRequestId);
    const existingBatch = count > 1 ? await this.repository.findBatchByClientRequestId(clientRequestId, userId) : null;
    if (existingBatch) return { task: existingBatch.tasks[0], batch: existingBatch.batch, tasks: existingBatch.tasks };
    const existingTask = count === 1 ? await this.repository.findTaskByClientRequestId(clientRequestId, userId) : null;
    if (existingTask) return { task: existingTask };
    // 参考图文件可能来自前端会话缓存或历史任务复用；扣费前必须确认站内文件仍可读取。
    try {
      await assertGenerationSourceImagesAvailable(normalizedBody.sourceImageUrls ?? []);
    } catch (error) {
      if (error instanceof SourceImageUnavailableError) {
        throw new GenerationError('invalid_request', error.message);
      }
      throw error;
    }

    // 冷却检查：从 system_configs 读取冷却秒数，检查用户最近一次任务时间
    const cooldownSeconds = Number(await this.repository.getConfigValue('drawing_cooldown_seconds', '90'));
    if (cooldownSeconds > 0) {
      const lastTask = await this.repository.findLastTaskByUserId(userId);
      if (lastTask) {
        const elapsed = Date.now() - lastTask.createdAt.getTime();
        if (elapsed < cooldownSeconds * 1000) {
          const remaining = Math.ceil((cooldownSeconds * 1000 - elapsed) / 1000);
          throw new GenerationError('cooldown', `请等待 ${remaining} 秒后再生成`);
        }
      }
    }

    // 生成中阻塞检查：已绑定用户按 QQ 防并发；未绑定 Web 用户按 userId 防并发。
    const blockDuring = await this.repository.getConfigValue('drawing_block_during_generation', 'true');
    if (blockDuring === 'true') {
      const runningTask = qqNumber
        ? await this.repository.findRunningTaskByQqNumber(qqNumber)
        : await this.repository.findRunningTaskByUserId(userId);
      if (runningTask) {
        throw new GenerationError('blocked', '当前还有正在生成的任务，请等待完成');
      }
    }

    let effectivePrompt = normalizedBody.prompt;
    let promptAssistStep: PromptAssistStepInput | undefined;
    let promptAssistPending = false;
    if (normalizedBody.referencePromptAssist === true) {
      const sourceImageUrls = normalizedBody.sourceImageUrls ?? [];
      if (sourceImageUrls.length > REFERENCE_PROMPT_ASSIST_MAX_IMAGES) {
        throw new GenerationError('invalid_request', `AI 提示增强最多接受 ${REFERENCE_PROMPT_ASSIST_MAX_IMAGES} 张参考图`);
      }
      const override = options?.effectivePromptOverride?.trim();
      if (override) {
        // 历史复投直接复用已固化提示词，不再次调用 AI，也不伪造新的增强耗时步骤。
        effectivePrompt = override;
      } else {
        // 先持久化主任务并立即响应；外部 AI 在任务内异步执行，刷新页面可直接恢复进行中任务。
        promptAssistPending = true;
      }
      if (!promptAssistPending) normalizedBody = { ...normalizedBody, prompt: effectivePrompt };
    }

    // 分镜设计必须在扣费和任务创建前完成；失败时不创建任务、不扣余额，也不静默使用原提示词。
    if (isVideoTask) {
      const shouldDesignStoryboard = storyboardDesignEnabled && normalizedBody.storyboardDesign !== false;
      if (shouldDesignStoryboard) {
        const maxPromptLength = Number(await this.repository.getConfigValue('drawing_max_prompt_length', '5000')) || 5000;
        try {
          const redesignedPrompt = await this.videoStoryboardService.redesign({
            prompt: normalizedBody.prompt,
            sourceImageUrls: normalizedBody.sourceImageUrls ?? [],
            duration: Number(normalizedBody.duration),
            aspectRatio: String(normalizedBody.aspectRatio),
            resolution: String(normalizedBody.resolution),
            maxPromptLength,
          });
          normalizedBody = { ...normalizedBody, prompt: redesignedPrompt, storyboardDesign: true };
          effectivePrompt = redesignedPrompt;
        } catch (error) {
          if (error instanceof VideoStoryboardError) {
            throw new GenerationError('drawing_service_unavailable', error.message);
          }
          throw error;
        }
      } else {
        normalizedBody = { ...normalizedBody, storyboardDesign: false };
      }
    }

    const [resolvedSize, resolvedQuality] = await Promise.all([
      normalizedBody.size ? Promise.resolve(normalizedBody.size) : this.repository.getConfigValue('drawing_default_size', 'auto'),
      normalizedBody.quality ? Promise.resolve(normalizedBody.quality) : this.repository.getConfigValue('drawing_default_quality', 'auto'),
    ]);
    // 事务内快照必须保存真正用于投递的完整默认值，后台排障和 Worker 轮询不得依赖之后可能变化的全局配置。
    normalizedBody = { ...normalizedBody, size: resolvedSize, quality: resolvedQuality, count };

    // 扣费：任务创建与钱包扣费在 repository 事务内完成，禁止绕过钱包事务。
    const basePricePerGen = Number(await this.repository.getConfigValue('drawing_price_per_gen', '0.05'));
    const pricePerGen = await this.repository.resolveGenerationPrice({
      model: normalizedBody.model,
      mode: normalizedBody.mode,
      basePrice: Number(basePricePerGen),
    });
    let task: GenerationTaskView;
    let created = false;
    try {
      if (count > 1) {
        const runtime = await this.readMultiRuntimeConfig(count);
        const result = await this.repository.createBatchIdempotently({
          userId,
          qqNumber,
          source: 'web',
          clientRequestId,
          batchId: taskId,
          taskIds: createBatchTaskIds(taskId, count),
          body: normalizedBody,
          defaultImagePrivate,
          price: Number(pricePerGen),
          count,
          concurrency: runtime.concurrency,
          stopAfterConsecutiveFailures: runtime.stopAfterConsecutiveFailures,
          maxAttempts,
          // 异步增强完成前不得把用户原文伪装成 effectivePrompt，避免任何恢复链路提前投递未增强提示词。
          effectivePrompt: normalizedBody.referencePromptAssist === true && !promptAssistPending ? effectivePrompt : undefined,
          referencePromptAssist: normalizedBody.referencePromptAssist === true,
          promptFormat,
          promptAssistStep,
          promptAssistPending,
          lora: loraSnapshot,
        });
        task = result.tasks[0];
        created = result.created;
        if (created) {
          invalidateWalletCache([`user:${userId}`, ...(qqNumber ? [`qq:${qqNumber.toString()}`] : [])]);
          invalidateTaskCache(result.tasks.map((item) => item.id), [`task-list:user:${userId}`]);
          // 批次事务已保存本次真实模型，必须清理旧的账号模型偏好缓存。
          invalidateUserCache(userId);
          if (promptAssistPending) {
            void this.runPromptAssistAndDispatch(result.tasks, normalizedBody, promptFormat, maxAttempts, result.batch.id);
          } else {
            await this.submitInitialBatchTasks(result.tasks, normalizedBody);
          }
        }
        return { task, batch: result.batch, tasks: result.tasks };
      } else {
        const result = await this.repository.createTaskIdempotently({
          userId,
          qqNumber,
          clientRequestId,
          taskId,
          body: normalizedBody,
          defaultImagePrivate,
          price: Number(pricePerGen),
          maxAttempts,
          // 异步增强完成前不得把用户原文伪装成 effectivePrompt，最终值由 completePromptAssist 原子固化。
          effectivePrompt: normalizedBody.referencePromptAssist === true && !promptAssistPending ? effectivePrompt : undefined,
          referencePromptAssist: normalizedBody.referencePromptAssist === true,
          promptFormat,
          promptAssistStep,
          promptAssistPending,
          lora: loraSnapshot,
        });
        task = result.task;
        created = result.created;
      }
    } catch (error) {
      throw error;
    }

    if (!created) {
      return { task };
    }

    // 任务和扣费已经在事务内提交；即使后续投递 drawing-service 失败，也必须先清理余额和任务列表缓存。
    invalidateWalletCache([`user:${userId}`, ...(qqNumber ? [`qq:${qqNumber.toString()}`] : [])]);
    invalidateTaskCache([task.id], [`task-list:user:${userId}`]);
    // 单图事务已保存本次真实模型，必须清理旧的账号模型偏好缓存。
    invalidateUserCache(userId);

    if (promptAssistPending) {
      void this.runPromptAssistAndDispatch([task], normalizedBody, promptFormat, maxAttempts);
    } else if (task.status === 'queued') {
      // created=true 已保证本分支只处理本次新任务；初始时间线可能同时含提示增强，不能再用子任务数量判断是否投递。
      await this.submitTaskToDrawingService(task.id, {
        taskId: task.id,
        clientRequestId: task.clientRequestId,
        source: task.source,
        mode: task.mode,
        prompt: effectivePrompt,
        qqNumber: task.qqNumber,
        userId: task.userId,
        templateId: task.templateId,
        sourceImageUrls: normalizedBody.referencePromptAssist === true ? undefined : task.sourceImageUrls,
        isPrivate: task.isPrivate,
        asyncSubmit: true,
        preferredModel: normalizedBody.model,
        maxAttempts,
        size: normalizedBody.size,
        aspectRatio: normalizedBody.aspectRatio,
        quality: normalizedBody.quality,
        duration: normalizedBody.duration,
        resolution: normalizedBody.resolution,
        lora: loraSnapshot,
      });
    }

    const refreshed = await this.repository.findTaskByClientRequestId(task.clientRequestId, userId);
    return { task: refreshed ?? task };
  }

  /** 在已经持久化并返回给用户的任务内执行一次提示增强，成功后才投递绘图服务。 */
  async runPromptAssistAndDispatch(tasks: Array<Pick<GenerationTaskView, 'id'>>, body: GenerationCreateRequest, promptFormat: DrawingPromptFormat, maxAttempts: number, batchId?: string, persistedStartedAt?: Date) {
    const taskIds = tasks.map((task) => task.id);
    // 启动恢复沿用持久化起点，时间线耗时必须包含进程重启期间，而不是只计算恢复后的二次等待。
    const startedAt = persistedStartedAt ?? new Date();
    try {
      const maxPromptLength = Number(await this.repository.getConfigValue('drawing_max_prompt_length', '5000')) || 5000;
      const effectivePrompt = await this.referencePromptAssistService.enhance({
        prompt: body.prompt,
        sourceImageUrls: body.sourceImageUrls ?? [],
        maxPromptLength,
        promptFormat,
      });
      const finishedAt = new Date();
      const completedTasks = await this.repository.completePromptAssist(taskIds, effectivePrompt, {
        startedAt,
        finishedAt,
        latencyMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      }, batchId);
      invalidateTaskCache(taskIds);
      const dispatchBody = { ...body, prompt: effectivePrompt };
      if (batchId) {
        await this.submitInitialBatchTasks(completedTasks, dispatchBody);
      } else {
        // 增强期间任务可能被其他终态流程结束；只投递仍处于活动状态的主任务，杜绝退款后再次生成。
        const task = completedTasks.find((item) => item.status === 'running' || item.status === 'queued');
        if (task) {
          const snapshot = await this.repository.findTaskGenerationParams(task.id);
          await this.submitTaskToDrawingService(task.id, {
          taskId: task.id, clientRequestId: task.clientRequestId, source: task.source, mode: task.mode,
          prompt: effectivePrompt, qqNumber: task.qqNumber, userId: task.userId, templateId: task.templateId,
          sourceImageUrls: undefined, isPrivate: task.isPrivate, asyncSubmit: true,
          preferredModel: body.model, maxAttempts, size: body.size, aspectRatio: body.aspectRatio,
          quality: body.quality, duration: body.duration, resolution: body.resolution, lora: snapshot.lora,
          });
        }
      }
    } catch (error) {
      const message = error instanceof ReferencePromptAssistError ? error.message : error instanceof Error ? error.message : 'AI 提示增强失败';
      const finishedAt = new Date();
      await this.repository.failPromptAssist(taskIds, message, finishedAt);
      for (const taskId of taskIds) await this.repository.failTaskAndRefund({ taskId, error: message });
      invalidateTaskCache(taskIds);
      invalidateWalletCache();
    }
  }

  /** Backend 重启后恢复尚未进入绘图调度的提示增强；任务、参数和参考图均来自持久化快照。 */
  async resumePendingPromptAssistTasks(): Promise<number> {
    const pendingTasks = await this.repository.findPendingPromptAssistTasks();
    if (pendingTasks.length === 0) return 0;
    const snapshots = await this.repository.findTaskGenerationParamsByIds(pendingTasks.map((task) => task.id));
    const groups = new Map<string, GenerationTaskView[]>();
    for (const task of pendingTasks) {
      const groupKey = task.batchId ?? task.id;
      const group = groups.get(groupKey) ?? [];
      group.push(task);
      groups.set(groupKey, group);
    }

    let resumed = 0;
    for (const [groupKey, tasks] of groups) {
      const first = tasks[0];
      if (!first) continue;
      const snapshot = snapshots.get(first.id);
      if (!snapshot?.model) {
        const message = 'AI 提示增强恢复失败：任务缺少模型快照';
        await this.repository.failPromptAssist(tasks.map((task) => task.id), message, new Date());
        for (const task of tasks) await this.repository.failTaskAndRefund({ taskId: task.id, error: message });
        invalidateTaskCache(tasks.map((task) => task.id));
        invalidateWalletCache();
        continue;
      }
      const model = snapshot.model;
      const promptFormat = snapshot.promptFormat ?? await resolveConfiguredModelPromptFormat(getPrismaClient(), model);
      const body: GenerationCreateRequest = {
        mode: first.mode,
        prompt: first.prompt,
        templateId: first.templateId,
        sourceImageUrls: first.sourceImageUrls,
        isPrivate: first.isPrivate,
        model,
        size: snapshot.size,
        aspectRatio: snapshot.aspectRatio,
        quality: snapshot.quality,
        duration: snapshot.duration,
        resolution: snapshot.resolution,
        count: tasks.length,
        referencePromptAssist: true,
      };
      // 每个批次仍只恢复一次共享增强；单图以自身 ID 分组，不会重复调用。
      const persistedStartedAt = first.subTasks.find((step) => step.kind === 'prompt_assist')?.startedAt;
      void this.runPromptAssistAndDispatch(
        tasks,
        body,
        promptFormat,
        snapshot.maxAttempts,
        first.batchId ? groupKey : undefined,
        persistedStartedAt ? new Date(persistedStartedAt) : undefined,
      );
      resumed += tasks.length;
    }
    return resumed;
  }

  /** 查询当前用户绘图冷却状态；只读状态用于前端禁用按钮，创建任务时仍会再次校验。 */
  async getCooldownStatus(userId: number): Promise<GenerationCooldownResponse> {
    const cooldownSeconds = Math.max(0, Number(await this.repository.getConfigValue('drawing_cooldown_seconds', '90')) || 0);
    if (cooldownSeconds <= 0) return { cooldownSeconds: 0, remainingSeconds: 0, lastTaskId: null };
    const lastTask = await this.repository.findLastTaskByUserId(userId);
    if (!lastTask) return { cooldownSeconds, remainingSeconds: 0, lastTaskId: null };
    const elapsedMs = Date.now() - lastTask.createdAt.getTime();
    const remainingSeconds = Math.max(0, Math.ceil((cooldownSeconds * 1000 - elapsedMs) / 1000));
    return { cooldownSeconds, remainingSeconds, lastTaskId: lastTask.id };
  }

  /** 按 clientRequestId 恢复当前用户任务，调用方不能恢复其他用户任务。 */
  async recoverTask(userId: number, clientRequestId: string): Promise<GenerationRecoverResponse> {
    const batch = await this.repository.findBatchByClientRequestId(clientRequestId, userId);
    if (batch?.tasks[0]) return { task: batch.tasks[0], batch: batch.batch, tasks: batch.tasks };
    const task = await this.repository.findTaskByClientRequestId(clientRequestId, userId);
    if (!task) throw new GenerationError('not_found', '生成任务不存在');
    return { task };
  }

  /** 按历史任务重新提交；旧任务只作为参数来源，新任务重新扣费、限流并调度。 */
  async retryTask(userId: number, taskId: string) {
    const sourceTask = await this.repository.findTaskByIdForUser(taskId, userId);
    if (!sourceTask) throw new GenerationError('not_found', '生成任务不存在');
    const enabledModels = await readEnabledModelNames(getPrismaClient());
    const snapshot = await this.repository.findTaskGenerationParams(sourceTask.id);

    const task = await this.createTask(userId, {
      clientRequestId: createClientRequestId('web_retry'),
      mode: sourceTask.mode,
      prompt: sourceTask.prompt,
      templateId: sourceTask.templateId,
      sourceImageUrls: sourceTask.sourceImageUrls,
      isPrivate: sourceTask.isPrivate,
      // 复投只能沿用真实上游尝试中的有效模型，避免结果图文件名等脏字段进入调度。
      model: pickRetryModelFromSubTasks(sourceTask.subTasks, enabledModels),
      // 复投继续使用历史任务真实画幅参数，避免显式比例回退为当前后台默认尺寸。
      size: snapshot.size,
      aspectRatio: snapshot.aspectRatio,
      quality: snapshot.quality,
      duration: snapshot.duration,
      resolution: snapshot.resolution,
      // 历史任务已保存最终分镜提示词，复投时禁止再次改写造成内容漂移。
      storyboardDesign: false,
      referencePromptAssist: snapshot.referencePromptAssist === true,
      lora: snapshot.lora ? { id: snapshot.lora.id, strength: snapshot.lora.strength } : undefined,
    }, snapshot.referencePromptAssist && snapshot.effectivePrompt ? { effectivePromptOverride: snapshot.effectivePrompt } : undefined);
    return { ...task, sourceTaskId: sourceTask.id };
  }

  /** 分页查询当前用户任务列表。 */
  async listTasks(userId: number, pageInput: number, pageSizeInput: number, status?: string): Promise<GenerationListResponse> {
    const page = Number.isSafeInteger(pageInput) && pageInput > 0 ? pageInput : 1;
    const pageSize = Number.isSafeInteger(pageSizeInput) && pageSizeInput > 0
      ? Math.min(pageSizeInput, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
    return this.repository.listTasks({ userId, page, pageSize, status });
  }

  /** 批量查询当前用户任务状态，用于前端轮询进行中任务。 */
  async findTasks(userId: number | null, ids: string[]): Promise<GenerationTasksResponse> {
    const tasks = await this.repository.findTasksByIds(userId, ids);
    const snapshots = await this.repository.findTaskGenerationParamsByIds(tasks.map((task) => task.id));
    // 展示与 Worker 都使用任务创建时的同一模型级尝试次数快照。
    return {
      tasks: tasks.map((task) => ({
        ...task,
        maxAttempts: snapshots.get(task.id)?.maxAttempts ?? 3,
        failureSummary: task.status === 'failed' ? summarizeTaskFailure(task) : undefined,
      })),
    };
  }

  /** 内部接口追加子任务；所有重试和尝试都必须挂到主任务下。 */
  async appendSubTask(body: GenerationAppendSubTaskRequest) {
    const subTask = await this.repository.appendSubTask(body);
    if (!subTask) throw new GenerationError('not_found', '生成主任务不存在');
    invalidateTaskCache([body.taskId]);
    return { subTask };
  }

  /** 内部接口更新主任务状态；仅首次标记失败时自动退款（防止重复退款）。 */
  async updateTaskStatus(body: GenerationUpdateTaskStatusRequest) {
    let updatedTask: GenerationTaskView | null = null;
    if (body.status === 'failed') {
      const result = await this.repository.failTaskAndRefund({ taskId: body.taskId, error: body.error });
      if (!result.task) throw new GenerationError('not_found', '生成主任务不存在');
      updatedTask = result.task;
      invalidateTaskCache([body.taskId]);
      invalidateWalletCache();
      await this.advanceBatchAfterTerminal(result.task.id);
      return { task: result.task };
    }

    const task = await this.repository.updateTaskStatus(body);
    if (!task) throw new GenerationError('not_found', '生成主任务不存在');
    updatedTask = task;
    invalidateTaskCache([body.taskId]);
    // 成功/收尾阶段影响详情；公开图库列表由状态路由在成功写入时刷新。
    if (body.status === 'success' || body.status === 'finalizing') invalidateImageCache(body.taskId);
    if (body.status === 'success' && task.mode !== 'text-to-video' && task.mode !== 'image-to-video') {
      // 图库标签是旁路增强数据，只入队异步识别，不能阻塞任务成功状态和余额链路。
      await this.galleryTaggingService.enqueueTask(body.taskId);
    }
    if (updatedTask.status === 'success' || updatedTask.status === 'failed') await this.advanceBatchAfterTerminal(updatedTask.id);
    return { task };
  }

  /** 提交任务给 drawing-service；带重试，下游临时不可达不立即判定任务失败。 */
  private async submitTaskToDrawingService(taskId: string, request: Parameters<typeof submitDrawingTask>[0]) {
    const rawBackoff = await this.repository.getConfigValue('drawing_dispatch_backoff_ms', '500');
    const backoffBase = Math.max(Number(rawBackoff) || 500, 100);
    let lastError: unknown;

    for (let attempt = 0; attempt < DRAWING_SERVICE_DISPATCH_ATTEMPTS; attempt++) {
      try {
        await submitDrawingTask(request);
        return; // 成功
      } catch (error) {
        lastError = error;
        if (attempt < DRAWING_SERVICE_DISPATCH_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, (attempt + 1) * backoffBase));
        }
      }
    }

    // 所有重试均失败，记录为 dispatch 失败并触发退款
    const message = lastError instanceof Error ? lastError.message : 'drawing-service 接收生成任务失败';
    await this.repository.appendSubTask({
      taskId,
      kind: 'dispatch',
      status: 'failed',
      retryable: true,
      nextAction: 'same_site',
      error: message,
      finishedAt: new Date().toISOString(),
    });
    // 走 updateTaskStatus 确保触发退款逻辑
    await this.updateTaskStatus({ taskId, status: 'failed', error: message });
    throw new GenerationError('drawing_service_unavailable', message);
  }

  /** 读取和规范化多图生成张数；后端是唯一强校验入口。 */
  private async normalizeRequestedCount(value: unknown): Promise<number> {
    const requested = Number.isSafeInteger(value) ? Number(value) : 1;
    const enabled = await this.repository.getConfigValue('drawing_multi_enabled', 'true');
    if (requested <= 1 || enabled === 'false') return 1;
    const maxRaw = await this.repository.getConfigValue('drawing_multi_count_max', '4');
    const max = Math.min(Math.max(Number(maxRaw) || 4, 1), 20);
    return Math.min(Math.max(requested, 1), max);
  }

  /** 读取多图批次运行配置，保证并发和失败停止阈值不会超出批次数。 */
  private async readMultiRuntimeConfig(count: number) {
    const [concurrencyRaw, stopRaw] = await Promise.all([
      this.repository.getConfigValue('drawing_multi_concurrency', '2'),
      this.repository.getConfigValue('drawing_multi_stop_after_consecutive_failures', '2'),
    ]);
    return {
      concurrency: Math.min(Math.max(Number(concurrencyRaw) || 1, 1), count),
      stopAfterConsecutiveFailures: Math.min(Math.max(Number(stopRaw) || 1, 1), count),
    };
  }

  /** 批次首批活动任务逐个投递 drawing-service；提示增强期间的 running 任务尚无上游尝试，不会被 Worker 抢占。 */
  private async submitInitialBatchTasks(tasks: GenerationTaskView[], body: GenerationCreateRequest) {
    const dispatchable = tasks.filter((item) => item.status === 'queued' || (body.referencePromptAssist === true && item.status === 'running'));
    await Promise.allSettled(dispatchable.map((task) => this.submitBatchTaskSafely(task, body)));
  }

  /** 批次内子任务进入终态后释放下一批，并投递 drawing-service。 */
  private async advanceBatchAfterTerminal(taskId: string) {
    const result = await this.repository.advanceBatchAfterTaskTerminal(taskId);
    if (result.changedTaskIds.length > 0) invalidateTaskCache(result.changedTaskIds);
    // 批次连续失败会在推进事务内退款停止的 deferred 任务，必须在退款后再次清理余额缓存。
    if (result.refundedStoppedTasks) invalidateWalletCache();
    if (result.releasedTasks.length === 0) return;
    await Promise.allSettled(result.releasedTasks.map((task) => this.submitBatchTaskSafely(task, {
        mode: task.mode,
        prompt: task.prompt,
        templateId: task.templateId,
        sourceImageUrls: task.sourceImageUrls,
        isPrivate: task.isPrivate,
      })));
  }

  /** 批次单张投递失败只影响该张图；submitTaskToDrawingService 内部会标记失败并退款。 */
  private async submitBatchTaskSafely(task: GenerationTaskView, body: GenerationCreateRequest) {
    try {
      await this.submitTaskViewToDrawingService(task, body);
    } catch {
      // 批次内其他任务不能被单张 dispatch 异常阻断；失败任务状态和退款已由下层写入。
    }
  }

  /** 按任务视图投递 drawing-service；批次释放路径复用单图投递保护。 */
  private async submitTaskViewToDrawingService(task: GenerationTaskView, body: GenerationCreateRequest) {
    const snapshot = await this.repository.findTaskGenerationParams(task.id);
    const size = body.size || snapshot.size || await this.repository.getConfigValue('drawing_default_size', 'auto');
    const quality = body.quality || snapshot.quality || await this.repository.getConfigValue('drawing_default_quality', 'auto');
    await this.submitTaskToDrawingService(task.id, {
      taskId: task.id,
      clientRequestId: task.clientRequestId,
      source: task.source,
      mode: task.mode,
      prompt: snapshot.effectivePrompt ?? task.prompt,
      qqNumber: task.qqNumber,
      userId: task.userId,
      templateId: task.templateId,
      sourceImageUrls: snapshot.referencePromptAssist === true ? undefined : task.sourceImageUrls,
      isPrivate: task.isPrivate,
      asyncSubmit: true,
      preferredModel: body.model || snapshot.model,
      maxAttempts: snapshot.maxAttempts,
      size,
      aspectRatio: body.aspectRatio || snapshot.aspectRatio,
      quality,
      duration: body.duration ?? snapshot.duration,
      resolution: body.resolution ?? snapshot.resolution,
      lora: snapshot.lora,
    });
  }
}

/** 归一化创建请求；图生图参考图是任务输入的强约束，不能静默过滤成少图任务。 */
function normalizeGenerationCreateBody(body: GenerationCreateRequest): GenerationCreateRequest {
  const sourceImageUrls = normalizeGenerationSourceImageUrls(body.sourceImageUrls);
  if (body.lora && body.mode !== 'text-to-image') throw new GenerationError('invalid_request', 'LoRA 当前只支持文生图任务');
  if ((body.mode === 'image-to-image' || body.mode === 'image-to-video') && sourceImageUrls.length === 0) {
    throw new GenerationError('invalid_request', body.mode === 'image-to-video' ? '参考图视频至少需要 1 张参考图' : '图生图至少需要 1 张参考图');
  }
  if (body.mode === 'text-to-image' && sourceImageUrls.length > 0 && body.referencePromptAssist !== true) {
    throw new GenerationError('invalid_request', '当前生成模式不接收参考图');
  }
  if (body.mode === 'text-to-video' && sourceImageUrls.length > 0) throw new GenerationError('invalid_request', '当前生成模式不接收参考图');
  if (body.referencePromptAssist === true && body.mode !== 'text-to-image') {
    throw new GenerationError('invalid_request', 'AI 提示增强只适用于文生图任务');
  }
  if (body.referencePromptAssist === true && sourceImageUrls.length > REFERENCE_PROMPT_ASSIST_MAX_IMAGES) {
    throw new GenerationError('invalid_request', `AI 提示增强最多接受 ${REFERENCE_PROMPT_ASSIST_MAX_IMAGES} 张参考图`);
  }
  const isVideo = body.mode === 'text-to-video' || body.mode === 'image-to-video';
  if (isVideo) {
    if (!Number.isSafeInteger(body.duration) || Number(body.duration) < 1 || Number(body.duration) > 15) {
      throw new GenerationError('invalid_request', '视频时长必须为 1-15 秒整数');
    }
    if (body.resolution !== '480p' && body.resolution !== '720p' && body.resolution !== '1080p') {
      throw new GenerationError('invalid_request', '视频分辨率不正确');
    }
    if (!body.aspectRatio || !['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].includes(body.aspectRatio)) {
      throw new GenerationError('invalid_request', '视频画幅比例不正确');
    }
  } else if (body.duration !== undefined || body.resolution !== undefined) {
    throw new GenerationError('invalid_request', '图片任务不能携带视频参数');
  }
  return {
    ...body,
    prompt: body.prompt.trim(),
    sourceImageUrls: sourceImageUrls.length > 0 ? sourceImageUrls : undefined,
  };
}

/** 创建短格式 ID：w_{ts36}_{r6}，taskId == clientRequestId */
function createClientRequestId(prefix = 'w') {
  const ts36 = Date.now().toString(36);
  const r6 = randomBytes(3).toString('hex');
  return `${prefix}_${ts36}_${r6}`;
}

/** taskId 直接复用 clientRequestId，无需二次包装 */
function createTaskId(clientRequestId: string) {
  return clientRequestId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** 批次 ID 复用批次幂等键，保持短 ID 且便于后台排查。 */
function createBatchId(clientRequestId: string) {
  return createTaskId(clientRequestId).slice(0, 56);
}

/** 批次子任务 ID 在批次 ID 后追加序号，避免超过数据库 64 字符限制。 */
function createBatchTaskIds(batchId: string, count: number) {
  const base = batchId.slice(0, 56);
  return Array.from({ length: count }, (_, index) => `${base}_${String(index + 1).padStart(2, '0')}`);
}

/** 基于主任务和子任务真实错误生成用户可读短原因，避免前台展示上游长文本。 */
function summarizeTaskFailure(task: GenerationTaskView) {
  return summarizeGenerationFailure({
    taskError: task.error,
    mode: task.mode,
    subTasks: task.subTasks,
  });
}
