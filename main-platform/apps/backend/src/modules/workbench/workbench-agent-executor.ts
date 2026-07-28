/** 本文件实现工作台 Agent 的真实工具执行，负责生成任务提交和用户任务详情查询。 */
import type {
  GenerationTaskView,
  WorkbenchConversationDetailResponse,
  WorkbenchSendMessageResponse,
  WorkbenchToolCallView,
} from '@aiimage/shared-contracts';
import type { PrismaClient } from '@prisma/client';
import { summarizeGenerationFailure } from '@aiimage/core-utils';
import { GenerationsService } from '../generations/generations-service.js';
import {
  createWorkbenchId,
  mapMessage,
  trimPreview,
  type WorkbenchMessageRecord,
} from './workbench-mappers.js';

type ConversationLoader = (userId: number, conversationId: string) => Promise<WorkbenchConversationDetailResponse | null>;

type InspectTaskInput = {
  userId: number;
  conversationId: string;
  userMessage: WorkbenchMessageRecord;
  taskId: string;
  reason?: string;
  /** 重试失败消息时覆盖原 assistant 消息，不新增消息。 */
  replaceAssistantMessageId?: string;
  loadConversation: ConversationLoader;
};

/** Agent 工具执行器：当前只保留只读任务查询；绘图提交必须先走用户确认。 */
export class WorkbenchAgentExecutor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly generationsService: GenerationsService,
  ) {}

  /** 查询当前用户自己的任务详情；只读任务状态和时间线，不修改余额或任务。 */
  async inspectTask(input: InspectTaskInput): Promise<WorkbenchSendMessageResponse | null> {
    const taskId = normalizeTaskId(input.taskId);
    if (!taskId) throw new WorkbenchAgentExecutorError('invalid_request', '任务 ID 不正确');
    const result = await this.generationsService.findTasks(input.userId, [taskId]);
    if (result.tasks.length === 0) {
      return this.saveToolError({
        userId: input.userId,
        conversationId: input.conversationId,
        userMessage: input.userMessage,
        kind: 'chat',
        toolType: 'generation_lookup',
        title: '未找到任务',
        taskIds: [taskId],
        message: '没有找到这个任务，或它不属于当前登录用户。',
        replaceAssistantMessageId: input.replaceAssistantMessageId,
        loadConversation: input.loadConversation,
      });
    }
    const content = buildTaskDetailContent(result.tasks);
    const toolCalls: WorkbenchToolCallView[] = [{
      id: createWorkbenchId('tool'),
      type: 'generation_lookup',
      status: 'success',
      title: '已读取任务详情',
      taskIds: result.tasks.map(task => task.id),
      error: null,
      reason: normalizeToolReason(input.reason),
    }];
    const assistantMessage = input.replaceAssistantMessageId
      ? await this.prisma.workbenchMessage.update({
        where: { id: input.replaceAssistantMessageId },
        data: {
          content,
          status: 'sent',
          kind: 'chat',
          taskIds: result.tasks.map(task => task.id),
          attachmentIds: [],
          toolCalls,
          model: null,
          error: null,
        },
      })
      : await this.prisma.workbenchMessage.create({
        data: {
          id: createWorkbenchId('msg'),
          conversationId: input.conversationId,
          userId: input.userId,
          role: 'assistant',
          content,
          status: 'sent',
          kind: 'chat',
          taskIds: result.tasks.map(task => task.id),
          attachmentIds: [],
          toolCalls,
          model: null,
        },
      });
    await this.touchConversation(input.conversationId, content);
    const detail = await input.loadConversation(input.userId, input.conversationId);
    if (!detail) return null;
    return {
      ...detail,
      userMessage: mapMessage(input.userMessage),
      assistantMessage: mapMessage(assistantMessage),
      generation: null,
    };
  }

  /** 保存工具错误为 assistant 消息，保证 Agent 工具失败也进入上下文。 */
  private async saveToolError(input: {
    userId: number;
    conversationId: string;
    userMessage: WorkbenchMessageRecord;
    kind: 'chat' | 'draw';
    toolType: WorkbenchToolCallView['type'];
    title: string;
    taskIds: string[];
    message: string;
    prompt?: string;
    model?: string;
    replaceAssistantMessageId?: string;
    loadConversation: ConversationLoader;
  }): Promise<WorkbenchSendMessageResponse | null> {
    const toolCalls: WorkbenchToolCallView[] = [{
      id: createWorkbenchId('tool'),
      type: input.toolType,
      status: 'error',
      title: input.title,
      taskIds: input.taskIds,
      error: input.message,
      prompt: input.prompt ?? null,
      model: input.model ?? null,
    }];
    const assistantMessage = input.replaceAssistantMessageId
      ? await this.prisma.workbenchMessage.update({
        where: { id: input.replaceAssistantMessageId },
        data: {
          content: input.message,
          status: 'error',
          kind: input.kind,
          taskIds: input.taskIds,
          attachmentIds: [],
          toolCalls,
          model: input.model ?? null,
          error: input.message,
        },
      })
      : await this.prisma.workbenchMessage.create({
        data: {
          id: createWorkbenchId('msg'),
          conversationId: input.conversationId,
          userId: input.userId,
          role: 'assistant',
          content: input.message,
          status: 'error',
          kind: input.kind,
          taskIds: input.taskIds,
          attachmentIds: [],
          toolCalls,
          model: input.model ?? null,
          error: input.message,
        },
      });
    await this.touchConversation(input.conversationId, input.message);
    const detail = await input.loadConversation(input.userId, input.conversationId);
    if (!detail) return null;
    return {
      ...detail,
      userMessage: mapMessage(input.userMessage),
      assistantMessage: mapMessage(assistantMessage),
      generation: null,
    };
  }

  /** 更新会话摘要和最后消息时间；不会触碰真实绘图任务。 */
  private async touchConversation(conversationId: string, content: string) {
    await this.prisma.workbenchConversation.update({
      where: { id: conversationId },
      data: { lastMessagePreview: trimPreview(content), lastMessageAt: new Date() },
    });
  }
}

/** 根据真实任务列表生成用户可读详情摘要。 */
function buildTaskDetailContent(tasks: GenerationTaskView[]) {
  const lines = tasks.map((task, index) => {
    const latestAttempt = [...task.subTasks].reverse().find(item => item.kind === 'upstream_attempt');
    const error = task.status === 'failed'
      ? summarizeGenerationFailure({ taskError: task.error, mode: task.mode, subTasks: task.subTasks })
      : task.error;
    return [
      `#${index + 1} ${task.id}`,
      `状态：${formatStatus(task.status)}`,
      `模式：${task.mode === 'image-to-image' ? '图生图' : '文生图'}`,
      task.batchId ? `批次：${task.batchId} (${task.batchIndex ?? '-'} / ${task.batchTotal ?? '-'})` : '',
      latestAttempt?.siteName ? `站点：${latestAttempt.siteName}` : '',
      latestAttempt?.model ? `模型：${latestAttempt.model}` : '',
      latestAttempt?.latencyMs ? `上游耗时：${Math.round(latestAttempt.latencyMs / 1000)}s` : '',
      `尝试：${task.subTasks.filter(item => item.kind === 'upstream_attempt').length} 次`,
      task.startedAt ? `开始：${task.startedAt}` : '',
      task.finishedAt ? `完成：${task.finishedAt}` : '',
      error ? `错误：${error}` : '',
    ].filter(Boolean).join('\n');
  });
  return `Agent 已读取任务详情：\n\n${lines.join('\n\n')}`;
}

/** 归一化工具调用原因；仅用于解释 Agent 为什么调用工具。 */
function normalizeToolReason(value: unknown) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 180) : null;
}

/** 只接受任务 ID 安全字符，避免把自然语言传给查询层。 */
function normalizeTaskId(value: string) {
  const text = value.trim();
  return /^[a-zA-Z0-9:_-]{1,64}$/.test(text) ? text : '';
}

/** 将任务状态转为中文，保持 Agent 消息对普通用户可读。 */
function formatStatus(status: GenerationTaskView['status']) {
  const map: Record<GenerationTaskView['status'], string> = {
    deferred: '等待释放',
    queued: '排队中',
    running: '运行中',
    finalizing: '收尾中',
    success: '成功',
    failed: '失败',
  };
  return map[status] ?? status;
}

/** Agent 工具执行错误，路由层会转换为标准 API 错误响应。 */
export class WorkbenchAgentExecutorError extends Error {
  constructor(public readonly kind: 'invalid_request', message: string) {
    super(message);
    this.name = 'WorkbenchAgentExecutorError';
  }
}
