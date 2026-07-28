/**
 * 本文件封装工作台 Agent 的工具定义、提示词上下文压缩和 OpenAI 兼容响应解析。
 *
 * 这些函数只做路由和文本归一化，不直接创建任务、不扣费、不读取数据库。
 */
import type { WorkbenchAttachmentView, WorkbenchMessageView } from '@aiimage/shared-contracts';
import type { DrawingMode } from '@aiimage/shared-contracts';
import { isCompleteDrawingPrompt } from './workbench-prompt-rules.js';

/** AI 路由返回的待确认绘图方案，进入真实任务前还会做二次归一化。 */
export type WorkbenchActionDrawOption = {
  id: string;
  title: string;
  reason: string;
  prompt: string;
};

export const IMAGE_GENERATION_TOOL_NAME = 'submit_image_generation_task';
export const GENERATION_LOOKUP_TOOL_NAME = 'inspect_generation_task';
export const CHAT_RESPONSE_TOOL_NAME = 'respond_without_tool';

export type WorkbenchActionDecision =
  | {
      action: 'chat';
      prompt: string;
      reason: string;
      title?: string;
      toolName?: typeof CHAT_RESPONSE_TOOL_NAME;
    }
  | {
      action: 'draw';
      prompt: string;
      reason: string;
      title?: string;
      mode?: DrawingMode;
      /** AI 选中的工作台附件 ID，执行层会转存为真实图生图参考图。 */
      sourceAttachmentIds?: string[];
      /** AI 选中的历史生成结果图 URL，可直接作为真实图生图参考图。 */
      sourceImageUrls?: string[];
      options: WorkbenchActionDrawOption[];
      toolName: typeof IMAGE_GENERATION_TOOL_NAME;
    }
  | {
      action: 'inspect';
      prompt: string;
      reason: string;
      title?: string;
      taskId: string;
      toolName: typeof GENERATION_LOOKUP_TOOL_NAME;
    };

export type WorkbenchActionContext = {
  model?: string;
  count: number;
  isPrivate: boolean;
};

export type ChatCompletionResponse = {
  choices?: Array<{
    message?: ChatCompletionMessage;
  }>;
};

export type ChatCompletionStreamChunk = {
  choices?: Array<{
    delta?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
};

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatCompletionMessage = {
  content?: string | Array<{ type?: string; text?: string }>;
  tool_calls?: ChatCompletionToolCall[];
};

export type ChatCompletionToolCall = {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type ChatCompletionTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatCompletionOptions = {
  tools?: ChatCompletionTool[];
  toolChoice?: 'auto' | 'none' | 'required';
  responseFormat?: Record<string, unknown>;
};

export const IMAGE_GENERATION_TOOL = {
  type: 'function',
  function: {
    name: IMAGE_GENERATION_TOOL_NAME,
    description: '当用户明确要求创建图片任务时，生成多个待用户确认的绘图方案。没有参考图时是文生图；用户只说重新生成、再来一张、换一张时默认文生图沿用主题；用户要求参考、替换、保持构图、编辑本轮上传图、编辑历史生成结果图，或基于已上传/已描述图片补全完整角色、全身立绘、设定图、同角色扩展时是图生图。该工具不会直接扣费或提交任务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'title', 'reason', 'mode', 'options'],
      properties: {
        mode: {
          type: 'string',
          enum: ['text-to-image', 'image-to-image'],
          description: '本轮方案模式。用户只说重新生成、再来一张、换一张时填 text-to-image；用户要求参考/替换/编辑/保持构图，编辑刚才/本次/上一张生成结果图，或基于已上传/已描述的头像、半身图补全完整角色、全身立绘、设定图、同角色变体时填 image-to-image，否则填 text-to-image。',
        },
        prompt: {
          type: 'string',
          description: '推荐方案的完整中文正向绘图提示词。必须符合本地绘图提示词规范：主体/意图、场景背景、构图镜头、风格媒介、光影色彩、关键细节、质量要求、约束/禁止项都要写清。图生图时必须明确说明图1/图2等参考图关系、保持项、替换项、禁止项，不包含确认流程、价格、任务 ID 或平台说明。',
        },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          description: '给用户选择的 2-4 个绘图方案，必须都能直接提交当前 mode 对应的任务。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'reason', 'prompt'],
            properties: {
              id: {
                type: 'string',
                description: '方案 ID，例如 opt_1、opt_2、opt_3。',
              },
              title: {
                type: 'string',
                description: '12 字以内的方案短标题。',
              },
              reason: {
                type: 'string',
                description: '一句话说明方案特点。',
              },
              prompt: {
                type: 'string',
                description: '该方案完整中文正向绘图提示词；必须独立完整并符合本地绘图提示词规范。图生图必须写清参考图关系、保留项、修改项、禁止项和编辑目标。',
              },
            },
          },
        },
        title: {
          type: 'string',
          description: '12 字以内的总标题，用于 Agent 工具卡展示。',
        },
        reason: {
          type: 'string',
          description: '为什么本轮应进入绘图方案确认的简短原因。',
        },
      },
    },
  },
} satisfies ChatCompletionTool;

export const GENERATION_LOOKUP_TOOL = {
  type: 'function',
  function: {
    name: GENERATION_LOOKUP_TOOL_NAME,
    description: '当用户要求查看绘图任务状态、进度、失败原因或任务详情时，读取当前用户自己的生成任务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'reason'],
      properties: {
        taskId: {
          type: 'string',
          description: '用户提到的任务 ID 或批次 ID，只能由用户消息或上下文中已有任务链接得出。',
        },
        reason: {
          type: 'string',
          description: '为什么本轮应调用任务详情工具的简短原因。',
        },
      },
    },
  },
} satisfies ChatCompletionTool;

export const CHAT_RESPONSE_TOOL = {
  type: 'function',
  function: {
    name: CHAT_RESPONSE_TOOL_NAME,
    description: '当本轮不应该提交绘图任务、也不应该查询任务时，选择普通回复。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['reason'],
      properties: {
        reason: {
          type: 'string',
          description: '为什么本轮不应该调用绘图或任务查询工具的简短原因。',
        },
      },
    },
  },
} satisfies ChatCompletionTool;

/** 读取不同兼容接口返回的 message.content。 */
export function readChatContent(body: ChatCompletionResponse): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map(item => item.text ?? '').join('\n').trim();
  return '';
}

/** 解析真实 tools/function calling 返回；没有有效工具参数时保守返回 null。 */
export function parseToolDecision(message: ChatCompletionMessage): WorkbenchActionDecision | null {
  const toolCall = message.tool_calls?.find(item =>
    item.function?.name === IMAGE_GENERATION_TOOL_NAME
    || item.function?.name === GENERATION_LOOKUP_TOOL_NAME
    || item.function?.name === CHAT_RESPONSE_TOOL_NAME);
  const rawArguments = toolCall?.function?.arguments;
  if (!toolCall?.function?.name || !rawArguments) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(extractJsonObject(rawArguments) || rawArguments) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (toolCall.function.name === IMAGE_GENERATION_TOOL_NAME) {
    const prompt = normalizeDecisionText(payload.prompt, 5000);
    const options = normalizeActionDrawOptions(payload.options, prompt);
    const safePrompt = isCompleteDrawingPrompt(prompt) ? prompt : options[0]?.prompt || '';
    if (!safePrompt && options.length === 0) return null;
    return {
      action: 'draw',
      prompt: safePrompt,
      title: normalizeDecisionText(payload.title, 24) || '生成图片',
      reason: normalizeDecisionText(payload.reason, 300) || '用户明确要求生成图片',
      mode: payload.mode === 'image-to-image' ? 'image-to-image' : 'text-to-image',
      options,
      toolName: IMAGE_GENERATION_TOOL_NAME,
    };
  }
  if (toolCall.function.name === CHAT_RESPONSE_TOOL_NAME) {
    return {
      action: 'chat',
      prompt: '',
      reason: normalizeDecisionText(payload.reason, 300) || 'Agent 判断本轮应普通回复',
      toolName: CHAT_RESPONSE_TOOL_NAME,
    };
  }
  const taskId = normalizeTaskId(payload.taskId);
  if (!taskId) return null;
  return {
    action: 'inspect',
    prompt: '',
    taskId,
    title: '查看任务详情',
    reason: normalizeDecisionText(payload.reason, 300) || '用户要求查看任务状态',
    toolName: GENERATION_LOOKUP_TOOL_NAME,
  };
}

/** 解析旧 JSON 意图模型返回；无法确认工具时保守回到聊天，避免误扣费。 */
export function parseActionDecision(rawText: string): WorkbenchActionDecision {
  const jsonText = extractJsonObject(rawText);
  if (!jsonText) return { action: 'chat', prompt: '', reason: '未能解析 Agent JSON' };
  try {
    const raw = JSON.parse(jsonText) as Record<string, unknown>;
    const reason = normalizeDecisionText(raw.reason, 300);
    const title = normalizeDecisionText(raw.title, 24);
    if (raw.action === 'draw') {
      const prompt = normalizeDecisionText(raw.prompt, 5000);
      const options = normalizeActionDrawOptions(raw.options, prompt);
      const safePrompt = isCompleteDrawingPrompt(prompt) ? prompt : options[0]?.prompt || '';
      return safePrompt || options.length > 0
        ? { action: 'draw', prompt: safePrompt, title, reason, mode: raw.mode === 'image-to-image' ? 'image-to-image' : 'text-to-image', options, toolName: IMAGE_GENERATION_TOOL_NAME }
        : { action: 'chat', prompt: '', reason: 'Agent 未返回完整绘图提示词，保守进入聊天' };
    }
    if (raw.action === 'inspect') {
      const taskId = normalizeTaskId(raw.taskId);
      return taskId
        ? { action: 'inspect', prompt: '', taskId, title, reason, toolName: GENERATION_LOOKUP_TOOL_NAME }
        : { action: 'chat', prompt: '', reason: 'Agent 未返回可查询的任务 ID，保守进入聊天' };
    }
    return { action: 'chat', prompt: '', reason };
  } catch {
    return { action: 'chat', prompt: '', reason: 'Agent JSON 解析失败' };
  }
}

/** 将历史消息压缩成可给模型阅读的上下文摘要，不直接拼进最终绘图 prompt。 */
export function formatHistoryMessage(message: WorkbenchMessageView, maxLength: number): string {
  const lines: string[] = [];
  const roleLabel = message.role === 'user' ? '用户' : 'Agent';
  lines.push(`[${roleLabel}/${message.kind}/${message.status}]`);
  if (message.content.trim()) lines.push(limitText(message.content, Math.max(120, Math.floor(maxLength * 0.55))));
  if (message.attachments.length > 0) lines.push(`附件：${message.attachments.length} 张图片`);
  for (const tool of message.toolCalls.slice(0, 4)) {
    const toolLines = [
      `工具：${tool.type}/${tool.title || '工具调用'}，状态：${tool.status}`,
      tool.mode ? `模式：${tool.mode === 'image-to-image' ? '图生图' : '文生图'}` : '',
      tool.sourceImageUrls?.length ? `参考图：${tool.sourceImageUrls.length} 张` : '',
      tool.decision ? `确认：${tool.decision}` : '',
      tool.model ? `模型：${tool.model}` : '',
      tool.count ? `张数：${tool.count}` : '',
      tool.reason ? `原因：${tool.reason}` : '',
      tool.prompt ? `绘图提示词：${limitText(tool.prompt, 620)}` : '',
      tool.taskIds.length ? `任务：${tool.taskIds.join(', ')}` : '',
      tool.error ? `错误：${tool.error}` : '',
    ].filter(Boolean);
    lines.push(toolLines.join('；'));
  }
  return limitText(lines.join('\n'), maxLength).trim();
}

/** 构造本轮工具路由文本，要求模型像 Agent 一样选择工具而不是继续闲聊。 */
export function buildDecisionUserText(content: string, attachments: WorkbenchAttachmentView[], context: WorkbenchActionContext, selectedImageCount = 0): string {
  const modelText = context.model ? context.model : '后端默认模型';
  const privacyText = context.isPrivate ? '私密' : '公开';
  const selectedContextText = selectedImageCount > 0
    ? `上下文图片选择器已为本轮选中 ${selectedImageCount} 张可读取图片；只有用户明确要求编辑这些图片、补全角色、扩展全身、生成同角色设定图/立绘，或基于这些图片继续生成时，才调用 submit_image_generation_task 且 mode=image-to-image。`
    : '';
  const attachmentText = attachments.length > 0
    ? `本轮携带 ${attachments.length} 张图片附件。这些图片可作为图生图参考图：用户要求参考、替换、保持构图、换背景、改风格、迁移角色、补全全身、生成同角色立绘/设定图或编辑这些图片时，调用 submit_image_generation_task，mode 必须为 image-to-image，并在 prompt 写清图1/图2等参考关系。用户只是分析、描述或反推图片时才聊天。`
    : selectedImageCount > 0
      ? '本轮没有新上传附件，但上下文里已有被选中的历史图片。'
      : '本轮没有图片附件。';
  return [
    `本轮用户消息：${content}`,
    attachmentText,
    selectedContextText,
    `当前绘图设置：模型=${modelText}，张数=${context.count}，隐私=${privacyText}。`,
    '你必须判断本轮是否需要调用工具：生成图片时调用 submit_image_generation_task 生成候选方案；查询任务时调用 inspect_generation_task；不能调用工具时才聊天。',
    '如果用户说“确认生成、直接生成、就按这个生成、按上面生成、开始吧、可以、OK、就这样”等承接上文的确认语，仍然必须结合最近历史生成候选方案，让用户点击确认后才提交。',
    '如果用户只说“重新生成、再生成一次、再来一张、换一张、重抽一张”等重新出图请求，默认沿用最近一轮文字主题和要求生成新的文生图方案，不要引用上一张结果图；只有明确说基于/参考/优化/重绘/修改上一张图时才按图生图。',
    '生成图片工具必须给出 2-4 个可直接出图的方案。第一个方案应最贴近用户当前要求，其余方案提供不同构图、风格或编辑强度。',
    '所有候选方案 prompt 必须符合本地绘图提示词规范：按主体/意图、场景背景、构图镜头、风格媒介、光影色彩、关键细节、质量要求、约束/禁止项组织；图生图必须写清图1/图2用途、保持项、修改项和禁止项。',
    '工具路由阶段不要输出给用户看的最终解释文本，只能通过工具调用表达你的选择。',
  ].join('\n');
}

/** 归一化 AI 工具参数中的候选方案；缺失时用推荐 prompt 兜底生成单方案兼容旧模型。 */
function normalizeActionDrawOptions(value: unknown, fallbackPrompt: string): WorkbenchActionDrawOption[] {
  const source = Array.isArray(value) ? value : [];
  const options = source
    .map((item, index): WorkbenchActionDrawOption | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const prompt = normalizeDecisionText(raw.prompt, 5000);
      if (!isCompleteDrawingPrompt(prompt)) return null;
      const id = normalizeOptionId(raw.id, index);
      return {
        id,
        title: normalizeDecisionText(raw.title, 24) || `方案 ${index + 1}`,
        reason: normalizeDecisionText(raw.reason, 180),
        prompt,
      };
    })
    .filter((item): item is WorkbenchActionDrawOption => Boolean(item))
    .slice(0, 4);
  if (options.length > 0) return options;
  if (!isCompleteDrawingPrompt(fallbackPrompt)) return [];
  return [{ id: 'opt_1', title: '推荐方案', reason: '按当前要求生成', prompt: fallbackPrompt }];
}

/** 方案 ID 只允许安全字符，避免写入任意结构到工具调用 JSON。 */
function normalizeOptionId(value: unknown, index: number) {
  if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(value)) return value;
  return `opt_${index + 1}`;
}

/** 解析 OpenAI 兼容 SSE 分片，只提取 delta.content 文本。 */
export function readStreamPart(part: string): string {
  let text = '';
  for (const line of part.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const body = JSON.parse(data) as ChatCompletionStreamChunk;
      const content = body.choices?.[0]?.delta?.content;
      if (typeof content === 'string') text += content;
      else if (Array.isArray(content)) text += content.map(item => item.text ?? '').join('');
    } catch {
      // 兼容非 JSON 心跳或注释分片，忽略即可。
    }
  }
  return text;
}

/** 规范 baseUrl，最终请求追加 /chat/completions。 */
export function normalizeBaseUrl(value: string, fallback: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed || fallback;
}

/** 数值范围限制。 */
export function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 从模型文本中提取第一段 JSON 对象，兼容模型偶发包裹说明文字。 */
function extractJsonObject(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return '';
  return text.slice(start, end + 1);
}

/** 归一化模型返回的短文本字段，去掉多余空白并限制长度。 */
function normalizeDecisionText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

/** 限制上下文片段长度，保留开头主体信息并标记截断。 */
function limitText(value: string, maxLength: number) {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 12))}...（已截断）`;
}

/** 归一化用户可查询的任务 ID，防止模型把自然语言误当数据库键。 */
function normalizeTaskId(value: unknown) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return /^[a-zA-Z0-9:_-]{1,64}$/.test(text) ? text : '';
}
