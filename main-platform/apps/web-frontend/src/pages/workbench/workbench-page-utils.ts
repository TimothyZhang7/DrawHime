/** 本文件封装工作台页面的临时消息、SSE 解析和任务展示工具。 */
import type {
  DrawingModelOptionView,
  GenerationCreateResponse,
  WorkbenchAttachmentView,
  WorkbenchConversationView,
  WorkbenchMessageView,
} from '@aiimage/shared-contracts';

/** 合并会话列表，保证最新窗口排在最前面。 */
export function mergeConversation(items: WorkbenchConversationView[], next: WorkbenchConversationView) {
  return [next, ...items.filter(item => item.id !== next.id)]
    .sort((left, right) => new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime());
}

/** 生成发送前的临时消息；真实消息随后由后端持久化结果覆盖。 */
export function buildTemporaryMessage(
  conversationId: string,
  role: WorkbenchMessageView['role'],
  content: string,
  status: WorkbenchMessageView['status'],
  kind: WorkbenchMessageView['kind'] = 'chat',
  attachments: WorkbenchAttachmentView[] = [],
): WorkbenchMessageView {
  return {
    id: `local_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    userId: 0,
    role,
    content,
    status,
    kind,
    taskIds: [],
    attachments,
    toolCalls: [],
    model: null,
    error: null,
    agentRunId: null,
    agentRunStatus: null,
    agentElapsedMs: null,
    createdAt: new Date().toISOString(),
  };
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

/** 从 SSE 分块中读取事件名；没有 event 行时默认按模型增量处理。 */
export function readSseEventName(block: string): 'run_started' | 'status' | 'tool_start' | 'tool_result' | 'delta' | 'done' | 'error' {
  const line = block.split(/\r?\n/).find(item => item.startsWith('event:'));
  const name = line?.slice(6).trim();
  if (name === 'run_started') return 'run_started';
  if (name === 'status') return 'status';
  if (name === 'tool_start') return 'tool_start';
  if (name === 'tool_result') return 'tool_result';
  return name === 'done' || name === 'error' ? name : 'delta';
}

/** 从 SSE 分块中拼接 data 行，兼容代理拆包后的多行 JSON 数据。 */
export function readSseEventData(block: string) {
  return block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim();
}

/** 计算打字机每帧吐出的文本块；中文逐字更顺滑，英文按短词块减少卡顿。 */
export function takeTypewriterChunk(text: string) {
  if (text.length <= 2) return text;
  const first = text[0] ?? '';
  if (/[\s，。！？；：、,.!?;:]/.test(first)) return first;
  if (/^[\x00-\x7F]+$/.test(text.slice(0, 4))) return text.slice(0, Math.min(4, text.length));
  return text.slice(0, 1);
}

/** 格式化会话列表时间，避免列表被完整日期撑开。 */
export function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

/** 判断模型是否可用于文生图，排除纯文本模型。 */
export function isTextToImageModel(model: DrawingModelOptionView) {
  return model.capabilities?.textToImage !== false && model.type !== 'text';
}

/** 判断模型是否可用于图生图；工作台带参考图时必须优先使用该能力。 */
export function isImageToImageModel(model: DrawingModelOptionView) {
  return Boolean(model.capabilities?.imageToImage) && model.type !== 'text';
}
