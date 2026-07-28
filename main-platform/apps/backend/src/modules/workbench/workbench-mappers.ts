/** 本文件封装导航工作台数据库记录到共享契约的映射、ID 生成和输入归一化工具。 */
import { randomBytes } from 'node:crypto';
import type {
  GenerationCreateResponse,
  WorkbenchAttachmentView,
  WorkbenchAgentRunStatus,
  WorkbenchConversationView,
  WorkbenchDrawingProposalOptionView,
  WorkbenchMessageView,
  WorkbenchToolCallView,
} from '@aiimage/shared-contracts';
import { normalizeAttachmentIds } from './workbench-attachment-service.js';
import { isCompleteDrawingPrompt } from './workbench-prompt-rules.js';
export { isCompleteDrawingPrompt } from './workbench-prompt-rules.js';

/** 工作台会话数据库记录形状。 */
export type WorkbenchConversationRecord = {
  id: string;
  userId: number;
  title: string;
  model: string | null;
  count: number;
  isPrivate: boolean;
  lastMessagePreview: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
};

/** 工作台消息数据库记录形状。 */
export type WorkbenchMessageRecord = {
  id: string;
  conversationId: string;
  userId: number;
  role: string;
  content: string;
  status: string;
  kind: string;
  taskIds: unknown;
  attachmentIds: unknown;
  toolCalls: unknown;
  model: string | null;
  error: string | null;
  createdAt: Date;
};

/** 工作台 Agent Run 数据库记录形状；用于把持久化运行耗时映射回消息。 */
export type WorkbenchAgentRunRecord = {
  id: string;
  userMessageId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

/** 将数据库会话转换为共享契约。 */
export function mapConversation(item: WorkbenchConversationRecord): WorkbenchConversationView {
  return {
    id: item.id,
    userId: item.userId,
    title: item.title,
    model: item.model,
    count: item.count,
    isPrivate: item.isPrivate,
    lastMessagePreview: item.lastMessagePreview,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    lastMessageAt: item.lastMessageAt.toISOString(),
  };
}

/** 将数据库消息转换为共享契约。 */
export function mapMessage(item: WorkbenchMessageRecord, agentRun?: WorkbenchAgentRunRecord | null): WorkbenchMessageView {
  const normalizedRunStatus = normalizeAgentRunStatus(agentRun?.status);
  return {
    id: item.id,
    conversationId: item.conversationId,
    userId: item.userId,
    role: item.role === 'user' ? 'user' : 'assistant',
    content: item.content,
    status: item.status === 'error' ? 'error' : item.status === 'pending' ? 'pending' : 'sent',
    kind: item.kind === 'draw' ? 'draw' : item.kind === 'system' ? 'system' : 'chat',
    taskIds: normalizeTaskIds(item.taskIds),
    attachments: normalizeAttachments(item.attachmentIds),
    toolCalls: normalizeToolCalls(item.toolCalls),
    model: item.model,
    error: item.error,
    agentRunId: agentRun?.id ?? null,
    agentRunStatus: normalizedRunStatus,
    agentElapsedMs: agentRun ? calculateAgentElapsedMs(agentRun, normalizedRunStatus) : null,
    createdAt: item.createdAt.toISOString(),
  };
}

/** 批量映射消息并把每条 assistant 消息关联到前一条用户消息的最新持久化 Agent Run。 */
export function mapMessagesWithAgentRuns(messages: WorkbenchMessageRecord[], runs: WorkbenchAgentRunRecord[]): WorkbenchMessageView[] {
  const latestRunByUserMessage = new Map<string, WorkbenchAgentRunRecord>();
  for (const run of runs) {
    const current = latestRunByUserMessage.get(run.userMessageId);
    if (!current || run.createdAt.getTime() >= current.createdAt.getTime()) latestRunByUserMessage.set(run.userMessageId, run);
  }
  let lastUserMessageId = '';
  return messages.map(message => {
    if (message.role === 'user') {
      lastUserMessageId = message.id;
      return mapMessage(message);
    }
    const run = lastUserMessageId ? latestRunByUserMessage.get(lastUserMessageId) : undefined;
    return mapMessage(message, run);
  });
}

/** 生成工作台表主键；随机 ID 不包含明文用户信息。 */
export function createWorkbenchId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`;
}

/** 生成工作台绘图幂等键，保证每次消息提交能独立创建或恢复任务。 */
export function createWorkbenchClientRequestId(conversationId: string) {
  return `workbench_${conversationId.slice(0, 18)}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/** 归一化会话标题，避免空标题和过长标题污染列表。 */
export function normalizeTitle(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 128);
}

/** 归一化可选短字符串。 */
export function normalizeOptionalString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

/** 归一化工作台生成张数；最终限制仍由 GenerationsService 按后台配置校验。 */
export function normalizeCount(value: unknown) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 1;
  return Math.min(Math.max(Math.trunc(count), 1), 20);
}

/** 归一化用户消息正文，防止超长上下文拖垮后端请求。 */
export function normalizeMessageContent(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

/** 从消息内容生成默认标题。 */
export function buildTitleFromContent(content: string) {
  return content.replace(/\s+/g, ' ').slice(0, 24) || '新的绘图对话';
}

/** 列表摘要不保留过长正文。 */
export function trimPreview(content: string) {
  return content.replace(/\s+/g, ' ').slice(0, 120);
}

/** 归一化 Agent Run 状态，避免数据库异常值影响前端渲染。 */
function normalizeAgentRunStatus(value: string | undefined): WorkbenchAgentRunStatus | null {
  if (value === 'success' || value === 'error' || value === 'running') return value;
  return null;
}

/** 计算 Agent Run 耗时；终态用持久化 finishedAt，运行中用当前请求时间，展示精度固定到 0.1 秒。 */
function calculateAgentElapsedMs(run: WorkbenchAgentRunRecord, status: WorkbenchAgentRunStatus | null) {
  const startedMs = run.createdAt.getTime();
  const endedMs = status === 'running' ? Date.now() : (run.finishedAt ?? run.updatedAt).getTime();
  const elapsedMs = endedMs - startedMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return Math.round(elapsedMs / 100) * 100;
}

/** 归一化 JSON 中的任务 ID 列表。 */
export function normalizeTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 20);
}

/** 归一化绘图建议处理动作，避免前端传入任意字符串。 */
export function normalizeDrawingDecision(value: unknown): 'approve' | 'reject' | null {
  return value === 'approve' || value === 'reject' ? value : null;
}

/** 消息中的附件 ID 会映射成稳定读取 URL；文件权限由后端附件接口再次校验。 */
function normalizeAttachments(value: unknown): WorkbenchAttachmentView[] {
  const ids = normalizeAttachmentIds(value);
  return ids.map(id => ({
    id,
    kind: 'image',
    url: `/api/workbench/attachments/${id}`,
    name: '图片',
    mimeType: 'image/*',
    sizeBytes: 0,
    width: null,
    height: null,
    createdAt: new Date(0).toISOString(),
  }));
}

/** 归一化 JSON 中的工具调用结果，避免坏数据影响前端渲染。 */
export function normalizeToolCalls(value: unknown): WorkbenchToolCallView[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): WorkbenchToolCallView | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const decision = raw.decision === 'approved' || raw.decision === 'rejected' || raw.decision === 'pending' ? raw.decision : null;
      const count = Number(raw.count);
      const type = raw.type === 'generation_lookup' ? 'generation_lookup' : 'image_generation';
      return {
        id: typeof raw.id === 'string' ? raw.id : createWorkbenchId('tool'),
        type,
        status: raw.status === 'error'
          ? 'error'
          : raw.status === 'pending'
            ? 'pending'
            : raw.status === 'approved'
              ? 'approved'
              : raw.status === 'rejected'
                ? 'rejected'
                : 'success',
        title: typeof raw.title === 'string' ? raw.title : '生成图片',
        taskIds: normalizeTaskIds(raw.taskIds),
        error: typeof raw.error === 'string' ? raw.error : null,
        reason: typeof raw.reason === 'string' ? raw.reason : null,
        prompt: typeof raw.prompt === 'string' ? raw.prompt : null,
        options: normalizeDrawingOptions(raw.options),
        selectedOptionId: typeof raw.selectedOptionId === 'string' ? raw.selectedOptionId : null,
        decision,
        model: typeof raw.model === 'string' ? raw.model : null,
        mode: raw.mode === 'image-to-image' ? 'image-to-image' : raw.mode === 'text-to-image' ? 'text-to-image' : null,
        sourceImageUrls: normalizeSourceImageUrls(raw.sourceImageUrls),
        sourceImageSizes: normalizeSourceImageSizes(raw.sourceImageSizes),
        count: Number.isFinite(count) ? normalizeCount(count) : null,
        isPrivate: typeof raw.isPrivate === 'boolean' ? raw.isPrivate : null,
      };
    })
    .filter((item): item is WorkbenchToolCallView => Boolean(item))
    .slice(0, 10);
}

/** 归一化工具调用中的参考图 URL；这里只保留站内图片路径，真实存在性由创建任务时校验。 */
function normalizeSourceImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && /^\/images\/[a-zA-Z0-9_.-]{1,128}$/.test(item))
    .filter((item, index, array) => array.indexOf(item) === index)
    .slice(0, 8);
}

/** 归一化工具调用中的参考图任务输入大小；只用于传给真实生成校验。 */
function normalizeSourceImageSizes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => Number(item))
    .filter(item => Number.isFinite(item) && item > 0)
    .map(item => Math.trunc(item))
    .slice(0, 8);
}

/** 归一化 AI 返回的绘图候选方案，确保每个方案都有标题和完整 Prompt。 */
export function normalizeDrawingOptions(value: unknown): WorkbenchDrawingProposalOptionView[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index): WorkbenchDrawingProposalOptionView | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim().slice(0, 5000) : '';
      if (!isCompleteDrawingPrompt(prompt)) return null;
      const id = typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(raw.id) ? raw.id : `opt_${index + 1}`;
      const title = typeof raw.title === 'string' ? raw.title.trim().replace(/\s+/g, ' ').slice(0, 24) : '';
      const reason = typeof raw.reason === 'string' ? raw.reason.trim().replace(/\s+/g, ' ').slice(0, 180) : '';
      return {
        id,
        title: title || `方案 ${index + 1}`,
        reason: reason || null,
        prompt,
      };
    })
    .filter((item): item is WorkbenchDrawingProposalOptionView => Boolean(item))
    .slice(0, 4);
}

/** 从生成响应里读取外显任务 ID 和展示张数；多图提交统一外显为批次 ID。 */
export function readVisibleTaskInfo(data: GenerationCreateResponse) {
  const batchId = data.batch?.id || data.task.batchId || data.tasks?.find(item => item.batchId)?.batchId;
  const batchTotal = Math.max(1, data.batch?.count ?? data.task.batchTotal ?? data.tasks?.[0]?.batchTotal ?? 1);
  if (batchId && batchTotal > 1) return { ids: [batchId], count: batchTotal };
  const ids = data.tasks?.map(item => item.id).filter(Boolean);
  const visibleIds = ids && ids.length > 0 ? ids : [data.task.id];
  return { ids: visibleIds, count: visibleIds.length };
}
