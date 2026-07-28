/** 本文件实现导航工作台持久化会话服务；绘图必须先确认方案，再复用真实任务创建链路。 */
import type {
  GenerationCreateResponse,
  DrawingMode,
  WorkbenchConversationCreateRequest,
  WorkbenchConversationDeleteResponse,
  WorkbenchConversationDetailResponse,
  WorkbenchDrawingProposalOptionView,
  WorkbenchConversationListResponse,
  WorkbenchMessageView,
  WorkbenchStreamEvent,
  WorkbenchStreamStatusEvent,
  WorkbenchToolCallView,
  WorkbenchDrawingDecisionRequest,
  WorkbenchDrawingDecisionResponse,
  WorkbenchSendMessageRequest,
  WorkbenchSendMessageResponse,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { GenerationsService } from '../generations/generations-service.js';
import { WorkbenchAiService } from './workbench-ai-service.js';
import type { WorkbenchActionDecision } from './workbench-agent-helpers.js';
import { WorkbenchAgentExecutor } from './workbench-agent-executor.js';
import { WorkbenchAttachmentService, normalizeAttachmentIds } from './workbench-attachment-service.js';
import { normalizeGenerationSourceImageUrls } from '../generations/source-image-utils.js';
import {
  buildTitleFromContent,
  createWorkbenchClientRequestId,
  createWorkbenchId,
  mapConversation,
  mapMessage,
  mapMessagesWithAgentRuns,
  normalizeCount,
  normalizeDrawingDecision,
  normalizeDrawingOptions,
  normalizeMessageContent,
  normalizeOptionalString,
  normalizeTitle,
  normalizeToolCalls,
  readVisibleTaskInfo,
  isCompleteDrawingPrompt,
  trimPreview,
  type WorkbenchMessageRecord,
} from './workbench-mappers.js';

const MAX_CONTEXT_MESSAGES = 8;
const MAX_MESSAGE_LENGTH = 5000;

type PreparedWorkbenchMessage = {
  userMessage: WorkbenchMessageRecord;
  contextMessages: WorkbenchMessageRecord[];
  content: string;
  model: string | undefined;
  count: number;
  isPrivate: boolean;
  attachmentIds: string[];
};

type WorkbenchGenerationReferences = {
  sourceImageUrls: string[];
  sourceImageSizes: number[];
};

/** 导航工作台服务：负责会话持久化、消息落库、绘图方案确认和真实绘图任务提交。 */
export class WorkbenchService {
  private readonly prisma = getPrismaClient();
  private readonly generationsService = new GenerationsService();
  private readonly aiService = new WorkbenchAiService();
  private readonly agentExecutor = new WorkbenchAgentExecutor(this.prisma, this.generationsService);
  private readonly attachmentService = new WorkbenchAttachmentService();

  /** 查询当前用户的工作台会话列表。 */
  async listConversations(userId: number): Promise<WorkbenchConversationListResponse> {
    const items = await this.prisma.workbenchConversation.findMany({
      where: { userId },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
    return { items: items.map(mapConversation) };
  }

  /** 新建当前用户的工作台会话。 */
  async createConversation(userId: number, body: WorkbenchConversationCreateRequest): Promise<WorkbenchConversationDetailResponse> {
    const title = normalizeTitle(body.title) || '新的绘图对话';
    const conversation = await this.prisma.workbenchConversation.create({
      data: {
        id: createWorkbenchId('wb'),
        userId,
        title,
        model: normalizeOptionalString(body.model, 128),
        count: normalizeCount(body.count),
        isPrivate: body.isPrivate === true,
        lastMessagePreview: null,
      },
    });
    return { conversation: mapConversation(conversation), messages: [] };
  }

  /** 读取指定会话详情；只能读取当前用户自己的会话。 */
  async getConversation(userId: number, conversationId: string): Promise<WorkbenchConversationDetailResponse | null> {
    const conversation = await this.prisma.workbenchConversation.findFirst({ where: { id: conversationId, userId } });
    if (!conversation) return null;
    const messages = await this.prisma.workbenchMessage.findMany({
      where: { conversationId, userId },
      orderBy: { createdAt: 'asc' },
      take: 300,
    });
    const userMessageIds = messages.filter(item => item.role === 'user').map(item => item.id);
    const agentRuns = userMessageIds.length > 0
      ? await this.prisma.workbenchAgentRun.findMany({
        where: { conversationId, userId, userMessageId: { in: userMessageIds } },
        orderBy: { createdAt: 'asc' },
      })
      : [];
    return { conversation: mapConversation(conversation), messages: mapMessagesWithAgentRuns(messages, agentRuns) };
  }

  /** 删除当前用户自己的工作台会话；只清理工作台上下文，不删除真实生成任务、图片、余额或钱包流水。 */
  async deleteConversation(userId: number, conversationId: string): Promise<WorkbenchConversationDeleteResponse | null> {
    const conversation = await this.prisma.workbenchConversation.findFirst({ where: { id: conversationId, userId } });
    if (!conversation) return null;
    const attachments = await this.prisma.workbenchAttachment.findMany({
      where: { conversationId, userId },
      select: { filename: true },
    });
    await this.prisma.workbenchConversation.delete({ where: { id: conversationId } });
    await this.attachmentService.deleteStoredFiles(attachments.map(item => item.filename));
    return { deletedId: conversationId, ...(await this.listConversations(userId)) };
  }

  /** 保存用户消息并自动执行本轮意图；明确要图时创建待确认方案，否则调用多模态模型聊天。 */
  async sendMessage(userId: number, conversationId: string, body: WorkbenchSendMessageRequest): Promise<WorkbenchSendMessageResponse | null> {
    const prepared = await this.prepareUserMessage(userId, conversationId, body, 'chat');
    if (!prepared) return null;
    const decision = await this.decideMessageAction(userId, prepared);

    if (decision.action === 'draw') {
      const sourceAttachmentIds = resolveDrawingSourceAttachmentIds(decision.mode, decision.sourceAttachmentIds, prepared.attachmentIds);
      const directSourceImageUrls = resolveDirectSourceImageUrls(decision.sourceImageUrls);
      const drawingMode = resolveDrawingMode(decision.mode, sourceAttachmentIds, directSourceImageUrls);
      return this.createDrawingProposal(
        userId,
        conversationId,
        prepared.userMessage,
        decision.prompt,
        prepared.model,
        prepared.count,
        prepared.isPrivate,
        decision.title,
        decision.reason,
        decision.options,
        drawingMode,
        sourceAttachmentIds,
        directSourceImageUrls,
      );
    }
    if (decision.action === 'inspect') {
      return this.agentExecutor.inspectTask({
        userId,
        conversationId,
        userMessage: prepared.userMessage,
        taskId: decision.taskId,
        reason: decision.reason,
        loadConversation: (ownerId, targetId) => this.getConversation(ownerId, targetId),
      });
    }
    return this.replyWithAi(userId, conversationId, prepared.userMessage, prepared.contextMessages.reverse().map(item => mapMessage(item)), prepared.content, prepared.attachmentIds);
  }

  /** 保存用户消息并自动执行本轮意图；聊天时返回流式 delta，绘图时返回待确认方案。 */
  async streamAutoMessage(
    userId: number,
    conversationId: string,
    body: WorkbenchSendMessageRequest,
    onDelta: (text: string) => void,
    onStatus?: (event: WorkbenchStreamEvent) => void,
  ): Promise<WorkbenchSendMessageResponse | null> {
    const prepared = await this.prepareUserMessage(userId, conversationId, body, 'chat');
    if (!prepared) return null;
    const started = await this.startAgentRunWithPendingAssistant(userId, conversationId, prepared.userMessage.id);
    const targetAssistant = started.assistantMessage;
    const runId = started.runId;
    onStatus?.({ type: 'run_started', runId, userMessageId: prepared.userMessage.id, assistantMessageId: targetAssistant.id });
    try {
      await this.recordAgentStep(runId, 'received', '接收用户消息', 'success', `附件 ${prepared.attachmentIds.length} 张`, '消息已写入上下文');
      await this.markAgentStage(runId, 'context');
      onStatus?.({ type: 'status', stage: 'context', text: '正在整理上下文和可用工具' });
      await this.recordAgentStep(runId, 'context', '整理上下文', 'success', `历史消息 ${prepared.contextMessages.length} 条`, `本轮附件 ${prepared.attachmentIds.length} 张`);

      await this.markAgentStage(runId, 'planning');
      onStatus?.({ type: 'status', stage: 'planning', text: '正在分析需求并规划执行步骤' });
      const decision = await this.decideMessageAction(userId, prepared);
      await this.recordAgentStep(runId, 'routing', '选择工具', 'success', '由工作台 AI 判断工具调用', summarizeDecision(decision));
      if (decision.action === 'draw') {
        await this.markAgentStage(runId, 'tool');
        onStatus?.({ type: 'tool_start', tool: 'image_generation', text: '正在整理待确认的绘图方案' });
        const sourceAttachmentIds = resolveDrawingSourceAttachmentIds(decision.mode, decision.sourceAttachmentIds, prepared.attachmentIds);
        const directSourceImageUrls = resolveDirectSourceImageUrls(decision.sourceImageUrls);
        const drawingMode = resolveDrawingMode(decision.mode, sourceAttachmentIds, directSourceImageUrls);
        const data = await this.createDrawingProposal(
          userId,
          conversationId,
          prepared.userMessage,
          decision.prompt,
          prepared.model,
          prepared.count,
          prepared.isPrivate,
          decision.title,
          decision.reason,
          decision.options,
          drawingMode,
          sourceAttachmentIds,
          directSourceImageUrls,
          targetAssistant.id,
        );
        await this.recordAgentStep(runId, 'tool', '生成绘图方案', 'success', `${drawingMode}，参考图 ${sourceAttachmentIds.length + directSourceImageUrls.length} 张`, `候选方案 ${decision.options.length || 1} 个`);
        onStatus?.({ type: 'tool_result', tool: 'image_generation', status: 'success', text: '绘图方案已生成，等待确认' });
        await this.finishAgentRun(runId, 'success');
        return data ? await this.refreshSendResponse(userId, conversationId, data) : null;
      }
      if (decision.action === 'inspect') {
        await this.markAgentStage(runId, 'tool');
        onStatus?.({ type: 'tool_start', tool: 'generation_lookup', text: '正在查询绘图任务状态' });
        const data = await this.agentExecutor.inspectTask({
          userId,
          conversationId,
          userMessage: prepared.userMessage,
          taskId: decision.taskId,
          reason: decision.reason,
          replaceAssistantMessageId: targetAssistant.id,
          loadConversation: (ownerId, targetId) => this.getConversation(ownerId, targetId),
        });
        await this.recordAgentStep(runId, 'tool', '查询任务状态', 'success', decision.taskId, data ? '任务查询已完成' : '任务不存在');
        onStatus?.({ type: 'tool_result', tool: 'generation_lookup', status: data ? 'success' : 'error', text: data ? '任务状态已读取' : '任务不存在' });
        await this.finishAgentRun(runId, data ? 'success' : 'error', data ? undefined : '任务不存在');
        return data ? await this.refreshSendResponse(userId, conversationId, data) : null;
      }
      const history = [...prepared.contextMessages].reverse().map(item => mapMessage(item));
      await this.markAgentStage(runId, 'streaming');
      onStatus?.({ type: 'status', stage: 'streaming', text: '正在接收上游文本回复' });
      const ai = await this.aiService.streamChat(userId, history, prepared.content, prepared.attachmentIds, onDelta);
      const detail = await this.saveAiAssistantMessage(userId, conversationId, prepared.userMessage, ai.content, ai.model, targetAssistant.id);
      await this.recordAgentStep(runId, 'streaming', '流式文本回复', 'success', `模型 ${ai.model}`, `回复 ${ai.content.length} 字`);
      await this.finishAgentRun(runId, 'success');
      if (!detail) return null;
      return this.refreshSendResponse(userId, conversationId, { ...detail, generation: null });
    } catch (error) {
      await this.finishAgentRun(runId, 'error', error instanceof Error ? error.message : '工作台 Agent 执行失败');
      const failed = await this.saveAssistantError(userId, conversationId, prepared.userMessage, error, '工作台 AI 回复失败', 'chat', undefined, targetAssistant.id);
      return failed ? await this.refreshSendResponse(userId, conversationId, failed) : null;
    }
  }

  /** 原位重试失败 assistant 消息；不新增用户消息，只覆盖这条失败消息的执行结果。 */
  async streamRetryMessage(
    userId: number,
    conversationId: string,
    assistantMessageId: string,
    onDelta: (text: string) => void,
    onStatus?: (event: WorkbenchStreamEvent) => void,
  ): Promise<WorkbenchSendMessageResponse | null> {
    const prepared = await this.prepareRetryMessage(userId, conversationId, assistantMessageId);
    if (!prepared) return null;
    const targetAssistant = await this.prisma.workbenchMessage.update({
      where: { id: assistantMessageId },
      data: {
        content: '正在思考...',
        status: 'pending',
        kind: 'chat',
        taskIds: [],
        attachmentIds: [],
        toolCalls: [],
        model: null,
        error: null,
      },
    });
    const runId = await this.startAgentRun(userId, conversationId, prepared.userMessage.id);
    onStatus?.({ type: 'run_started', runId, userMessageId: prepared.userMessage.id, assistantMessageId: targetAssistant.id });
    try {
      await this.recordAgentStep(runId, 'received', '重试失败消息', 'success', `原消息 ${assistantMessageId}`, '复用上一条用户消息重新执行');
      await this.markAgentStage(runId, 'context');
      onStatus?.({ type: 'status', stage: 'context', text: '正在重新整理上下文和可用工具' });
      await this.recordAgentStep(runId, 'context', '整理上下文', 'success', `历史消息 ${prepared.contextMessages.length} 条`, `原始附件 ${prepared.attachmentIds.length} 张`);

      await this.markAgentStage(runId, 'planning');
      onStatus?.({ type: 'status', stage: 'planning', text: '正在重新分析需求并规划执行步骤' });
      const decision = await this.decideMessageAction(userId, prepared);
      await this.recordAgentStep(runId, 'routing', '选择工具', 'success', '由工作台 AI 重新判断工具调用', summarizeDecision(decision));
      if (decision.action === 'draw') {
        await this.markAgentStage(runId, 'tool');
        onStatus?.({ type: 'tool_start', tool: 'image_generation', text: '正在重新整理待确认的绘图方案' });
        const sourceAttachmentIds = resolveDrawingSourceAttachmentIds(decision.mode, decision.sourceAttachmentIds, prepared.attachmentIds);
        const directSourceImageUrls = resolveDirectSourceImageUrls(decision.sourceImageUrls);
        const drawingMode = resolveDrawingMode(decision.mode, sourceAttachmentIds, directSourceImageUrls);
        const data = await this.createDrawingProposal(
          userId,
          conversationId,
          prepared.userMessage,
          decision.prompt,
          prepared.model,
          prepared.count,
          prepared.isPrivate,
          decision.title,
          decision.reason,
          decision.options,
          drawingMode,
          sourceAttachmentIds,
          directSourceImageUrls,
          targetAssistant.id,
        );
        await this.recordAgentStep(runId, 'tool', '重试生成绘图方案', 'success', `${drawingMode}，参考图 ${sourceAttachmentIds.length + directSourceImageUrls.length} 张`, `候选方案 ${decision.options.length || 1} 个`);
        onStatus?.({ type: 'tool_result', tool: 'image_generation', status: 'success', text: '绘图方案已重新生成，等待确认' });
        await this.finishAgentRun(runId, 'success');
        return data ? await this.refreshSendResponse(userId, conversationId, data) : null;
      }
      if (decision.action === 'inspect') {
        await this.markAgentStage(runId, 'tool');
        onStatus?.({ type: 'tool_start', tool: 'generation_lookup', text: '正在重新查询绘图任务状态' });
        const data = await this.agentExecutor.inspectTask({
          userId,
          conversationId,
          userMessage: prepared.userMessage,
          taskId: decision.taskId,
          reason: decision.reason,
          replaceAssistantMessageId: targetAssistant.id,
          loadConversation: (ownerId, targetId) => this.getConversation(ownerId, targetId),
        });
        await this.recordAgentStep(runId, 'tool', '重试查询任务状态', 'success', decision.taskId, data ? '任务查询已完成' : '任务不存在');
        onStatus?.({ type: 'tool_result', tool: 'generation_lookup', status: data ? 'success' : 'error', text: data ? '任务状态已读取' : '任务不存在' });
        await this.finishAgentRun(runId, data ? 'success' : 'error', data ? undefined : '任务不存在');
        return data ? await this.refreshSendResponse(userId, conversationId, data) : null;
      }
      const history = [...prepared.contextMessages].reverse().map(item => mapMessage(item));
      await this.markAgentStage(runId, 'streaming');
      onStatus?.({ type: 'status', stage: 'streaming', text: '正在重新接收上游文本回复' });
      const ai = await this.aiService.streamChat(userId, history, prepared.content, prepared.attachmentIds, onDelta);
      const detail = await this.saveAiAssistantMessage(userId, conversationId, prepared.userMessage, ai.content, ai.model, targetAssistant.id);
      await this.recordAgentStep(runId, 'streaming', '重试流式文本回复', 'success', `模型 ${ai.model}`, `回复 ${ai.content.length} 字`);
      await this.finishAgentRun(runId, 'success');
      if (!detail) return null;
      return this.refreshSendResponse(userId, conversationId, { ...detail, generation: null });
    } catch (error) {
      await this.finishAgentRun(runId, 'error', error instanceof Error ? error.message : '工作台 Agent 重试失败');
      const failed = await this.saveAssistantError(userId, conversationId, prepared.userMessage, error, '工作台 AI 重试失败', 'chat', undefined, targetAssistant.id);
      return failed ? await this.refreshSendResponse(userId, conversationId, failed) : null;
    }
  }

  /** 处理用户对 AI 绘图建议的允许或拒绝；允许时才进入真实扣费绘图链路。 */
  async decideDrawingProposal(
    userId: number,
    conversationId: string,
    messageId: string,
    body: WorkbenchDrawingDecisionRequest,
  ): Promise<WorkbenchDrawingDecisionResponse | null> {
    const decision = normalizeDrawingDecision(body.decision);
    if (!decision) throw new WorkbenchError('invalid_request', '确认动作不正确');
    const proposal = await this.prisma.workbenchMessage.findFirst({
      where: { id: messageId, conversationId, userId, role: 'assistant', kind: 'draw' },
    });
    if (!proposal) return null;
    const toolCalls = normalizeToolCalls(proposal.toolCalls);
    const tool = toolCalls.find(item => item.type === 'image_generation' && item.decision === 'pending' && item.prompt);
    if (!tool?.prompt) throw new WorkbenchError('conflict', '该绘图建议已处理');

    if (decision === 'reject') {
      const updated = await this.markDrawingProposalRejected(conversationId, proposal, toolCalls, tool.id);
      const detail = await this.getConversation(userId, conversationId);
      if (!detail) return null;
      return { ...detail, assistantMessage: mapMessage(updated), generation: null };
    }

    const selected = resolveSelectedDrawingOption(tool, body.optionId);
    const approved = await this.markDrawingProposalApproved(conversationId, proposal, toolCalls, tool.id, selected.id);
    return this.submitApprovedDrawingProposal(userId, conversationId, approved, tool, selected);
  }

  /** 流式运行结束后重新读取持久化详情，让响应携带终态 Agent 耗时。 */
  private async refreshSendResponse(userId: number, conversationId: string, response: WorkbenchSendMessageResponse): Promise<WorkbenchSendMessageResponse | null> {
    const detail = await this.getConversation(userId, conversationId);
    if (!detail) return response;
    return {
      ...detail,
      userMessage: detail.messages.find(item => item.id === response.userMessage.id) ?? response.userMessage,
      assistantMessage: detail.messages.find(item => item.id === response.assistantMessage.id) ?? response.assistantMessage,
      generation: response.generation,
    };
  }

  /** 统一保存用户消息；关键分支会先落库，确保模型失败也不丢上下文。 */
  private async prepareUserMessage(userId: number, conversationId: string, body: WorkbenchSendMessageRequest, initialKind: 'chat' | 'draw'): Promise<PreparedWorkbenchMessage | null> {
    const content = normalizeMessageContent(body.content, MAX_MESSAGE_LENGTH);
    if (!content) throw new WorkbenchError('invalid_request', '请输入消息内容');
    const conversation = await this.prisma.workbenchConversation.findFirst({ where: { id: conversationId, userId } });
    if (!conversation) return null;
    const contextMessages = await this.prisma.workbenchMessage.findMany({
      where: { conversationId, userId, role: { in: ['user', 'assistant'] } },
      orderBy: { createdAt: 'desc' },
      take: MAX_CONTEXT_MESSAGES * 2,
    });
    const count = normalizeCount(body.count ?? conversation.count);
    const model = normalizeOptionalString(body.model, 128) ?? conversation.model ?? undefined;
    const isPrivate = typeof body.isPrivate === 'boolean' ? body.isPrivate : conversation.isPrivate;
    const title = conversation.title === '新的绘图对话' ? buildTitleFromContent(content) : conversation.title;
    const attachmentIds = normalizeAttachmentIds(body.attachmentIds);
    const attachments = await this.attachmentService.listOwned(userId, attachmentIds);
    const userMessage = await this.prisma.workbenchMessage.create({
      data: {
        id: createWorkbenchId('msg'),
        conversationId,
        userId,
        role: 'user',
        content,
        status: 'sent',
        kind: initialKind,
        taskIds: [],
        attachmentIds: attachments.map(item => item.id),
        toolCalls: [],
        model: null,
      },
    });
    await this.prisma.workbenchConversation.update({
      where: { id: conversationId },
      data: {
        title,
        model: model ?? null,
        count,
        isPrivate,
        lastMessagePreview: trimPreview(content),
        lastMessageAt: new Date(),
      },
    });
    return { userMessage, contextMessages, content, model, count, isPrivate, attachmentIds };
  }

  /** 为失败消息重试还原原始用户消息；重试不创建新用户消息，避免上下文出现重复发言。 */
  private async prepareRetryMessage(userId: number, conversationId: string, assistantMessageId: string): Promise<PreparedWorkbenchMessage | null> {
    const conversation = await this.prisma.workbenchConversation.findFirst({ where: { id: conversationId, userId } });
    if (!conversation) return null;
    const assistantMessage = await this.prisma.workbenchMessage.findFirst({
      where: { id: assistantMessageId, conversationId, userId, role: 'assistant', status: 'error' },
    });
    if (!assistantMessage) throw new WorkbenchError('invalid_request', '只能重试失败的 Agent 消息');
    const userMessage = await this.prisma.workbenchMessage.findFirst({
      where: {
        conversationId,
        userId,
        role: 'user',
        createdAt: { lt: assistantMessage.createdAt },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!userMessage) throw new WorkbenchError('conflict', '未找到这次失败对应的用户消息');
    const content = normalizeMessageContent(userMessage.content, MAX_MESSAGE_LENGTH);
    if (!content) throw new WorkbenchError('conflict', '原始用户消息为空，无法重试');
    const contextMessages = await this.prisma.workbenchMessage.findMany({
      where: {
        conversationId,
        userId,
        role: { in: ['user', 'assistant'] },
        createdAt: { lt: userMessage.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_CONTEXT_MESSAGES * 2,
    });
    const attachmentIds = normalizeAttachmentIds(userMessage.attachmentIds);
    const attachments = await this.attachmentService.listOwned(userId, attachmentIds);
    return {
      userMessage,
      contextMessages,
      content,
      model: conversation.model ?? undefined,
      count: normalizeCount(conversation.count),
      isPrivate: conversation.isPrivate,
      attachmentIds: attachments.map(item => item.id),
    };
  }

  /** 自动判断当前用户消息要聊天还是绘图；draw 只生成待确认方案，不直接扣费。 */
  private async decideMessageAction(userId: number, prepared: PreparedWorkbenchMessage) {
    const history = [...prepared.contextMessages].reverse().map(item => mapMessage(item));
    try {
      return await this.aiService.decideAction(userId, history, prepared.content, prepared.attachmentIds, {
        model: prepared.model,
        count: prepared.count,
        isPrivate: prepared.isPrivate,
      });
    } catch {
      return { action: 'chat' as const, prompt: '', reason: '意图判断失败，保守进入聊天' };
    }
  }

  /** 普通聊天模式：调用多模态模型并保存 assistant 回复。 */
  private async replyWithAi(userId: number, conversationId: string, userMessage: WorkbenchMessageRecord, history: WorkbenchMessageView[], content: string, attachmentIds: string[]): Promise<WorkbenchSendMessageResponse | null> {
    try {
      const ai = await this.aiService.chat(userId, history, content, attachmentIds);
      const detail = await this.saveAiAssistantMessage(userId, conversationId, userMessage, ai.content, ai.model);
      if (!detail) return null;
      return {
        ...detail,
        generation: null,
      };
    } catch (error) {
      return this.saveAssistantError(userId, conversationId, userMessage, error, '工作台 AI 回复失败');
    }
  }

  /** 保存 AI 完整回复；流式和非流式聊天共用同一落库逻辑。 */
  private async saveAiAssistantMessage(userId: number, conversationId: string, userMessage: WorkbenchMessageRecord, content: string, model: string, replaceAssistantMessageId?: string): Promise<WorkbenchSendMessageResponse | null> {
    const assistantMessage = replaceAssistantMessageId
      ? await this.prisma.workbenchMessage.update({
        where: { id: replaceAssistantMessageId },
        data: {
          content,
          status: 'sent',
          kind: 'chat',
          taskIds: [],
          attachmentIds: [],
          toolCalls: [],
          model,
          error: null,
        },
      })
      : await this.prisma.workbenchMessage.create({
        data: {
          id: createWorkbenchId('msg'),
          conversationId,
          userId,
          role: 'assistant',
          content,
          status: 'sent',
          kind: 'chat',
          taskIds: [],
          attachmentIds: [],
          toolCalls: [],
          model,
        },
      });
    await this.prisma.workbenchConversation.update({
      where: { id: conversationId },
      data: { lastMessagePreview: trimPreview(assistantMessage.content), lastMessageAt: new Date() },
    });
    const detail = await this.getConversation(userId, conversationId);
    if (!detail) return null;
    return {
      ...detail,
      userMessage: mapMessage(userMessage),
      assistantMessage: mapMessage(assistantMessage),
      generation: null,
    };
  }

  /** 绘图模式：先保存完整提示词等待用户确认，不在此处扣费或创建任务。 */
  private async createDrawingProposal(
    userId: number,
    conversationId: string,
    userMessage: WorkbenchMessageRecord,
    promptContent: string,
    model: string | undefined,
    count: number,
    isPrivate: boolean,
    title?: string,
    reason?: string,
    rawOptions: WorkbenchDrawingProposalOptionView[] = [],
    requestedMode?: DrawingMode,
    sourceAttachmentIds: string[] = [],
    directSourceImageUrls: string[] = [],
    replaceAssistantMessageId?: string,
  ): Promise<WorkbenchSendMessageResponse | null> {
    const prompt = promptContent.trim();
    if (!isCompleteDrawingPrompt(prompt)) throw new WorkbenchError('invalid_request', '绘图提示词不完整，请重新描述生成要求');
    const options = buildProposalOptions(rawOptions, prompt);
    if (options.length === 0) throw new WorkbenchError('invalid_request', '绘图方案不完整，请重新生成方案');
    const normalizedDirectUrls = resolveDirectSourceImageUrls(directSourceImageUrls);
    if (requestedMode === 'image-to-image' && sourceAttachmentIds.length === 0 && normalizedDirectUrls.length === 0) {
      throw new WorkbenchError('invalid_request', '图生图需要先上传参考图');
    }
    const references = requestedMode === 'image-to-image' || sourceAttachmentIds.length > 0
      ? await this.prepareGenerationReferences(userId, sourceAttachmentIds)
      : { sourceImageUrls: [], sourceImageSizes: [] };
    // 混合“本轮上传图 + 历史生成图”时，本轮上传图通常是图1基底，历史生成图是图2角色/风格来源，必须保持这个顺序。
    const sourceImageUrls = [...references.sourceImageUrls, ...normalizedDirectUrls];
    const sourceImageSizes = normalizedDirectUrls.length === 0 && references.sourceImageSizes.length === sourceImageUrls.length
      ? references.sourceImageSizes
      : [];
    if (requestedMode === 'image-to-image' && sourceImageUrls.length === 0) {
      throw new WorkbenchError('invalid_request', '图生图参考图转存失败，请重新上传图片');
    }
    const mode: DrawingMode = sourceImageUrls.length > 0 ? 'image-to-image' : 'text-to-image';
    await this.prisma.workbenchMessage.update({
      where: { id: userMessage.id },
      data: { kind: 'draw' },
    });
    const toolCalls: WorkbenchToolCallView[] = [{
      id: createWorkbenchId('tool'),
      type: 'image_generation',
      status: 'pending',
      title: normalizeToolTitle(title) || '等待确认生成图片',
      taskIds: [],
      error: null,
      prompt,
      options,
      selectedOptionId: null,
      decision: 'pending',
      model: model ?? null,
      mode,
      sourceImageUrls,
      sourceImageSizes,
      count,
      isPrivate,
      reason: normalizeToolReason(reason),
    }];
    const assistantMessage = replaceAssistantMessageId
      ? await this.prisma.workbenchMessage.update({
        where: { id: replaceAssistantMessageId },
        data: {
          content: options.length > 1 ? '我准备了几种绘图方案，请选择一个方案生成，或直接拒绝。' : '我准备按以下完整提示词提交绘图，请确认后继续。',
          status: 'pending',
          kind: 'draw',
          taskIds: [],
          attachmentIds: [],
          toolCalls,
          model: model ?? null,
          error: null,
        },
      })
      : await this.prisma.workbenchMessage.create({
        data: {
          id: createWorkbenchId('msg'),
          conversationId,
          userId,
          role: 'assistant',
          content: options.length > 1 ? '我准备了几种绘图方案，请选择一个方案生成，或直接拒绝。' : '我准备按以下完整提示词提交绘图，请确认后继续。',
          status: 'pending',
          kind: 'draw',
          taskIds: [],
          attachmentIds: [],
          toolCalls,
          model: model ?? null,
        },
      });
    await this.prisma.workbenchConversation.update({
      where: { id: conversationId },
      data: { lastMessagePreview: trimPreview(assistantMessage.content), lastMessageAt: new Date() },
    });
    const detail = await this.getConversation(userId, conversationId);
    if (!detail) return null;
    return {
      ...detail,
      userMessage: { ...mapMessage(userMessage), kind: 'draw' },
      assistantMessage: mapMessage(assistantMessage),
      generation: null,
    };
  }

  /** 允许后的提交分支：继续复用真实 GenerationsService，鉴权、余额、冷却和错误处理不被绕过。 */
  private async submitApprovedDrawingProposal(
    userId: number,
    conversationId: string,
    assistantMessage: WorkbenchMessageRecord,
    tool: WorkbenchToolCallView,
    selected: WorkbenchDrawingProposalOptionView,
  ): Promise<WorkbenchDrawingDecisionResponse | null> {
    try {
      if (!isCompleteDrawingPrompt(selected.prompt)) throw new WorkbenchError('invalid_request', '绘图方案提示词不完整，请重新生成方案');
      const generation = await this.generationsService.createTask(userId, {
        clientRequestId: createWorkbenchClientRequestId(conversationId),
        mode: tool.mode === 'image-to-image' ? 'image-to-image' : 'text-to-image',
        prompt: selected.prompt,
        sourceImageUrls: tool.mode === 'image-to-image' ? tool.sourceImageUrls ?? [] : undefined,
        sourceImageSizes: resolveAlignedSourceImageSizes(tool.mode, tool.sourceImageUrls, tool.sourceImageSizes),
        model: tool.model ?? undefined,
        count: normalizeCount(tool.count ?? 1),
        isPrivate: tool.isPrivate === true,
      }) as GenerationCreateResponse;
      const taskInfo = readVisibleTaskInfo(generation);
      const nextToolCalls: WorkbenchToolCallView[] = [{
        ...tool,
        type: 'image_generation',
        status: 'success',
        title: taskInfo.count > 1 ? `生成 ${taskInfo.count} 张图片` : '生成图片',
        taskIds: taskInfo.ids,
        error: null,
        decision: 'approved',
        selectedOptionId: selected.id,
        prompt: selected.prompt,
        mode: tool.mode,
        sourceImageUrls: tool.sourceImageUrls,
        sourceImageSizes: tool.sourceImageSizes,
      }];
      const updated = await this.prisma.workbenchMessage.update({
        where: { id: assistantMessage.id },
        data: {
          content: taskInfo.count > 1 ? `已确认「${selected.title}」并提交 ${taskInfo.count} 张绘图任务。` : `已确认「${selected.title}」并提交绘图任务。`,
          status: 'sent',
          taskIds: taskInfo.ids,
          toolCalls: nextToolCalls,
          model: tool.model ?? null,
          error: null,
        },
      });
      await this.prisma.workbenchConversation.update({
        where: { id: conversationId },
        data: { lastMessagePreview: trimPreview(updated.content), lastMessageAt: new Date() },
      });
      const detail = await this.getConversation(userId, conversationId);
      if (!detail) return null;
      return {
        ...detail,
        assistantMessage: mapMessage(updated),
        generation,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '绘图任务提交失败';
      const failedTool: WorkbenchToolCallView = {
        ...tool,
        status: 'error',
        title: '生成图片失败',
        taskIds: [],
        error: message,
        decision: 'approved',
        selectedOptionId: selected.id,
        prompt: selected.prompt,
        mode: tool.mode,
        sourceImageUrls: tool.sourceImageUrls,
        sourceImageSizes: tool.sourceImageSizes,
      };
      const updated = await this.prisma.workbenchMessage.update({
        where: { id: assistantMessage.id },
        data: {
          content: message,
          status: 'error',
          taskIds: [],
          toolCalls: [failedTool],
          model: tool.model ?? null,
          error: message,
        },
      });
      await this.prisma.workbenchConversation.update({
        where: { id: conversationId },
        data: { lastMessagePreview: trimPreview(message), lastMessageAt: new Date() },
      });
      const detail = await this.getConversation(userId, conversationId);
      if (!detail) return null;
      return { ...detail, assistantMessage: mapMessage(updated), generation: null };
    }
  }

  /** 拒绝绘图建议时只写入标记，不触发扣费和绘图调度。 */
  private async markDrawingProposalRejected(
    conversationId: string,
    proposal: WorkbenchMessageRecord,
    toolCalls: WorkbenchToolCallView[],
    toolId: string,
  ) {
    const nextToolCalls = toolCalls.map(item => item.id === toolId
      ? { ...item, status: 'rejected' as const, title: '已拒绝生成图片', decision: 'rejected' as const }
      : item);
    const updated = await this.prisma.workbenchMessage.update({
      where: { id: proposal.id },
      data: {
        content: '已拒绝本次绘图提交。',
        status: 'sent',
        toolCalls: nextToolCalls,
        taskIds: [],
        error: null,
      },
    });
    await this.prisma.workbenchConversation.update({
      where: { id: conversationId },
      data: { lastMessagePreview: trimPreview(updated.content), lastMessageAt: new Date() },
    });
    return updated;
  }

  /** 允许绘图建议时先写入 approved 标记，再开始真实创建任务。 */
  private async markDrawingProposalApproved(
    conversationId: string,
    proposal: WorkbenchMessageRecord,
    toolCalls: WorkbenchToolCallView[],
    toolId: string,
    selectedOptionId: string,
  ) {
    const nextToolCalls = toolCalls.map(item => item.id === toolId
      ? { ...item, status: 'approved' as const, title: '已允许生成图片', decision: 'approved' as const, selectedOptionId }
      : item);
    const updated = await this.prisma.workbenchMessage.update({
      where: { id: proposal.id },
      data: {
        content: '已允许本次绘图提交，正在创建任务。',
        status: 'pending',
        toolCalls: nextToolCalls,
        error: null,
      },
    });
    await this.prisma.workbenchConversation.update({
      where: { id: conversationId },
      data: { lastMessagePreview: trimPreview(updated.content), lastMessageAt: new Date() },
    });
    return updated;
  }

  /** 错误也持久化为 assistant 消息，避免用户上下文和失败原因丢失。 */
  private async saveAssistantError(
    userId: number,
    conversationId: string,
    userMessage: WorkbenchMessageRecord,
    error: unknown,
    fallback: string,
    kind: 'chat' | 'draw' = 'chat',
    model?: string,
    replaceAssistantMessageId?: string,
  ): Promise<WorkbenchSendMessageResponse | null> {
    const message = error instanceof Error ? error.message : fallback;
    const toolCalls: WorkbenchToolCallView[] = kind === 'draw' ? [{
      id: createWorkbenchId('tool'),
      type: 'image_generation',
      status: 'error',
      title: '生成图片',
      taskIds: [],
      error: message,
    }] : [];
    const assistantMessage = replaceAssistantMessageId
      ? await this.prisma.workbenchMessage.update({
        where: { id: replaceAssistantMessageId },
        data: {
          content: message,
          status: 'error',
          kind,
          taskIds: [],
          attachmentIds: [],
          toolCalls,
          model: model ?? null,
          error: message,
        },
      })
      : await this.prisma.workbenchMessage.create({
        data: {
          id: createWorkbenchId('msg'),
          conversationId,
          userId,
          role: 'assistant',
          content: message,
          status: 'error',
          kind,
          taskIds: [],
          attachmentIds: [],
          toolCalls,
          model: model ?? null,
          error: message,
        },
      });
    await this.prisma.workbenchConversation.update({
      where: { id: conversationId },
      data: { lastMessagePreview: trimPreview(message), lastMessageAt: new Date() },
    });
    const detail = await this.getConversation(userId, conversationId);
    if (!detail) return null;
    return {
      ...detail,
      userMessage: mapMessage(userMessage),
      assistantMessage: mapMessage(assistantMessage),
      generation: null,
    };
  }

  /** 将本轮工作台附件转存为真实图生图参考图；转存失败时阻止生成建议，避免确认后才失败。 */
  private async prepareGenerationReferences(userId: number, attachmentIds: string[]): Promise<WorkbenchGenerationReferences> {
    if (attachmentIds.length === 0) return { sourceImageUrls: [], sourceImageSizes: [] };
    try {
      return await this.attachmentService.createGenerationReferences(userId, attachmentIds);
    } catch (error) {
      if (error instanceof Error) throw new WorkbenchError('invalid_request', error.message);
      throw new WorkbenchError('invalid_request', '图生图参考图转存失败');
    }
  }

  /** 创建单次 Agent Run；只记录运行阶段元数据，不保存模型隐藏推理。 */
  private async startAgentRun(userId: number, conversationId: string, userMessageId: string) {
    const run = await this.prisma.workbenchAgentRun.create({
      data: {
        id: createWorkbenchId('run'),
        conversationId,
        userId,
        userMessageId,
        status: 'running',
        currentStage: 'received',
      },
    });
    return run.id;
  }

  /** 原子创建本轮 Agent Run 和真实 pending assistant 消息，避免刷新后丢失“正在思考”气泡。 */
  private async startAgentRunWithPendingAssistant(userId: number, conversationId: string, userMessageId: string) {
    return this.prisma.$transaction(async tx => {
      const assistantMessage = await tx.workbenchMessage.create({
        data: {
          id: createWorkbenchId('msg'),
          conversationId,
          userId,
          role: 'assistant',
          content: '正在思考...',
          status: 'pending',
          kind: 'chat',
          taskIds: [],
          attachmentIds: [],
          toolCalls: [],
          model: null,
          error: null,
        },
      });
      const run = await tx.workbenchAgentRun.create({
        data: {
          id: createWorkbenchId('run'),
          conversationId,
          userId,
          userMessageId,
          status: 'running',
          currentStage: 'received',
        },
      });
      // 会话摘要同步显示后台已接手本轮请求，避免列表刷新后看不到执行中状态。
      await tx.workbenchConversation.update({
        where: { id: conversationId },
        data: { lastMessagePreview: trimPreview(assistantMessage.content), lastMessageAt: new Date() },
      });
      return { runId: run.id, assistantMessage };
    });
  }

  /** 更新 Agent 当前阶段；该字段用于刷新后排障，不参与绘图任务状态。 */
  private async markAgentStage(runId: string, stage: WorkbenchStreamStatusEvent['stage']) {
    await this.prisma.workbenchAgentRun.update({
      where: { id: runId },
      data: { currentStage: stage },
    });
  }

  /** 写入 Agent 分段步骤；摘要必须是用户可见事实，不保存模型内部推理链。 */
  private async recordAgentStep(
    runId: string,
    stepType: string,
    title: string,
    status: 'running' | 'success' | 'error',
    inputSummary?: string,
    outputSummary?: string,
    error?: string,
  ) {
    await this.prisma.workbenchAgentStep.create({
      data: {
        id: createWorkbenchId('step'),
        runId,
        stepType: stepType.slice(0, 32),
        title: title.slice(0, 128),
        status,
        inputSummary: inputSummary?.slice(0, 1000) ?? null,
        outputSummary: outputSummary?.slice(0, 1000) ?? null,
        error: error?.slice(0, 1000) ?? null,
        finishedAt: status === 'running' ? null : new Date(),
      },
    });
  }

  /** 结束 Agent Run；失败只影响工作台本轮消息，不修改余额、图库或真实绘图任务。 */
  private async finishAgentRun(runId: string, status: 'success' | 'error', error?: string) {
    await this.prisma.workbenchAgentRun.update({
      where: { id: runId },
      data: {
        status,
        currentStage: status,
        error: error?.slice(0, 1000) ?? null,
        finishedAt: new Date(),
      },
    });
  }
}

/** 归一化工具确认卡短标题，避免模型输出撑开界面。 */
function normalizeToolTitle(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 24);
}

/** 归一化工具调用原因；仅用于解释为什么进入待确认绘图，不参与真实绘图 prompt。 */
function normalizeToolReason(value: unknown) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 180) : null;
}

/** 构造持久化绘图方案；AI 没有给 options 时保留旧单 Prompt 兼容。 */
function buildProposalOptions(rawOptions: WorkbenchDrawingProposalOptionView[], fallbackPrompt: string): WorkbenchDrawingProposalOptionView[] {
  const options = normalizeDrawingOptions(rawOptions);
  if (options.length > 0) return options;
  if (!isCompleteDrawingPrompt(fallbackPrompt)) return [];
  return [{
    id: 'opt_1',
    title: '推荐方案',
    reason: '按当前要求生成',
    prompt: fallbackPrompt,
  }];
}

/** 根据用户点击解析最终提交方案；多方案必须带 optionId，避免误提交。 */
function resolveSelectedDrawingOption(tool: WorkbenchToolCallView, optionId: unknown): WorkbenchDrawingProposalOptionView {
  const options = normalizeDrawingOptions(tool.options);
  if (options.length === 0) {
    const prompt = typeof tool.prompt === 'string' ? tool.prompt.trim() : '';
    if (!prompt) throw new WorkbenchError('conflict', '该绘图建议缺少提示词');
    return { id: 'legacy_prompt', title: '推荐方案', reason: null, prompt };
  }
  const selectedId = typeof optionId === 'string' ? optionId.trim() : '';
  if (options.length > 1 && !selectedId) throw new WorkbenchError('invalid_request', '请选择绘图方案');
  const selected = options.find(item => item.id === selectedId) ?? (options.length === 1 ? options[0] : undefined);
  if (!selected) throw new WorkbenchError('invalid_request', '绘图方案不存在或已过期');
  return selected;
}

/** 解析本轮绘图实际参考图；AI 选中的图片优先，只有明确图生图但缺少选图时才回退到本轮上传图。 */
function resolveDrawingSourceAttachmentIds(mode: DrawingMode | undefined, selectedAttachmentIds: string[] | undefined, currentAttachmentIds: string[]) {
  const selected = normalizeAttachmentIds(selectedAttachmentIds ?? []);
  if (selected.length > 0) return selected;
  return mode === 'image-to-image' ? currentAttachmentIds : [];
}

/** 归一化 AI 选中的历史生成结果图 URL；真实文件可读性仍由 GenerationsService 在扣费前校验。 */
function resolveDirectSourceImageUrls(value: unknown): string[] {
  return normalizeGenerationSourceImageUrls(value)
    .filter(item => /^\/images\/[a-zA-Z0-9_.-]{1,128}$/.test(item))
    .slice(0, 8);
}

/** 解析真实提交模式；只要已经有任意参考图，就强制进入图生图，避免工具模式字段漏填导致参考图丢失。 */
function resolveDrawingMode(mode: DrawingMode | undefined, sourceAttachmentIds: string[], sourceImageUrls: string[] = []): DrawingMode {
  if (sourceAttachmentIds.length > 0 || sourceImageUrls.length > 0) return 'image-to-image';
  return mode === 'image-to-image' ? 'image-to-image' : 'text-to-image';
}

/** 只有参考图大小列表与 URL 完全对齐时才传给创建任务，历史生成图复用时不传大小以免触发格式校验。 */
function resolveAlignedSourceImageSizes(mode: DrawingMode | null | undefined, sourceImageUrls: string[] | null | undefined, sourceImageSizes: number[] | null | undefined) {
  if (mode !== 'image-to-image') return undefined;
  const urls = Array.isArray(sourceImageUrls) ? sourceImageUrls : [];
  const sizes = Array.isArray(sourceImageSizes) ? sourceImageSizes : [];
  return urls.length > 0 && sizes.length === urls.length ? sizes : undefined;
}

/** 汇总 AI 工具选择结果；只用于阶段日志和 SSE 状态，不参与真实业务判断。 */
function summarizeDecision(decision: WorkbenchActionDecision) {
  if (decision.action === 'draw') return `绘图方案，模式=${decision.mode ?? '未指定'}，方案=${decision.options.length || 1}`;
  if (decision.action === 'inspect') return `查询任务 ${decision.taskId}`;
  return `普通回复：${decision.reason || 'AI 选择文本回复'}`;
}

/** 工作台业务错误，路由层会转换为标准 API 错误响应。 */
export class WorkbenchError extends Error {
  constructor(public readonly kind: 'invalid_request' | 'conflict', message: string) {
    super(message);
    this.name = 'WorkbenchError';
  }
}
