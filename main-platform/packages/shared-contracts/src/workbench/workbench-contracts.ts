/** 本文件定义网页导航工作台的持久化会话和消息接口契约。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';
import type { DrawingMode, GenerationCreateResponse } from '../drawing/drawing-contracts.js';

/** 工作台消息角色；用户消息代表原始需求，assistant 消息代表系统提交结果。 */
export type WorkbenchMessageRole = 'user' | 'assistant';

/** 工作台消息状态；pending 用于前端临时态和后端待确认的绘图提交。 */
export type WorkbenchMessageStatus = 'pending' | 'sent' | 'error';

/** 工作台消息类型；chat 是模型交流，draw 是绘图工具调用。 */
export type WorkbenchMessageKind = 'chat' | 'draw' | 'system';

/** 工作台附件类型；当前先支持图片，后续可扩展文档和音频。 */
export type WorkbenchAttachmentKind = 'image';

/** 工作台工具调用状态。 */
export type WorkbenchToolCallStatus = 'pending' | 'approved' | 'rejected' | 'success' | 'error';

/** 工作台 Agent 单次运行状态。 */
export type WorkbenchAgentRunStatus = 'running' | 'success' | 'error';

/** 工作台 Agent 分段步骤状态。 */
export type WorkbenchAgentStepStatus = 'running' | 'success' | 'error';

/** 工作台绘图提交确认状态。 */
export type WorkbenchToolCallDecision = 'pending' | 'approved' | 'rejected';

/** 工作台 Agent 工具类型；生成工具先给待确认方案，用户确认后才改变余额和任务。 */
export type WorkbenchToolCallType = 'image_generation' | 'generation_lookup';

/** 工作台绘图候选方案；用户必须选择一个方案后才会提交真实绘图任务。 */
export type WorkbenchDrawingProposalOptionView = {
  /** 方案 ID，只在当前工具调用内唯一。 */
  id: string;
  /** 方案短标题。 */
  title: string;
  /** 方案说明，解释该方案和用户需求的关系。 */
  reason: string | null;
  /** 该方案将提交给绘图链路的完整正向提示词。 */
  prompt: string;
};

/** 工作台工具调用视图，用于展示模型触发的绘图等真实工具。 */
export type WorkbenchToolCallView = {
  /** 工具调用 ID。 */
  id: string;
  /** 工具名称。 */
  type: WorkbenchToolCallType;
  /** 工具状态。 */
  status: WorkbenchToolCallStatus;
  /** 工具展示标题。 */
  title: string;
  /** 关联任务或批次 ID。 */
  taskIds: string[];
  /** 错误摘要。 */
  error: string | null;
  /** 工具调用原因，只用于解释为什么 AI 建议提交绘图。 */
  reason?: string | null;
  /** 本轮将提交给绘图链路的完整提示词。 */
  prompt?: string | null;
  /** AI 给出的多个待确认绘图方案；为空时兼容旧单 Prompt 确认卡。 */
  options?: WorkbenchDrawingProposalOptionView[] | null;
  /** 用户最终选择并提交的方案 ID。 */
  selectedOptionId?: string | null;
  /** 用户对 AI 绘图提交建议的确认标记。 */
  decision?: WorkbenchToolCallDecision | null;
  /** 本轮建议使用的绘图模型。 */
  model?: string | null;
  /** 本轮真实绘图模式；带参考图时为 image-to-image。 */
  mode?: DrawingMode | null;
  /** 图生图参考图 URL，确认后会原样进入真实生成任务。 */
  sourceImageUrls?: string[] | null;
  /** 图生图参考图任务输入字节数，顺序与 sourceImageUrls 对齐。 */
  sourceImageSizes?: number[] | null;
  /** 本轮建议生成张数。 */
  count?: number | null;
  /** 本轮建议隐私状态。 */
  isPrivate?: boolean | null;
};

/** 工作台附件视图；文件只由后端短 URL 暴露，不返回本地路径。 */
export type WorkbenchAttachmentView = {
  /** 附件 ID。 */
  id: string;
  /** 附件类型。 */
  kind: WorkbenchAttachmentKind;
  /** 浏览器可读 URL。 */
  url: string;
  /** 原始文件名。 */
  name: string;
  /** MIME 类型。 */
  mimeType: string;
  /** 文件大小。 */
  sizeBytes: number;
  /** 图片宽度。 */
  width: number | null;
  /** 图片高度。 */
  height: number | null;
  /** 创建时间。 */
  createdAt: string;
};

/** 工作台会话摘要，用于左侧对话窗口列表。 */
export type WorkbenchConversationView = {
  /** 会话 ID。 */
  id: string;
  /** 所属 Web 用户 ID。 */
  userId: number;
  /** 会话标题，由首条用户需求或用户输入生成。 */
  title: string;
  /** 当前会话默认模型；为空时使用后端默认模型。 */
  model: string | null;
  /** 当前会话默认生成张数。 */
  count: number;
  /** 当前会话默认隐私状态。 */
  isPrivate: boolean;
  /** 最后一条消息摘要。 */
  lastMessagePreview: string | null;
  /** 创建时间。 */
  createdAt: string;
  /** 更新时间。 */
  updatedAt: string;
  /** 最后消息时间。 */
  lastMessageAt: string;
};

/** 工作台消息视图，持久化保存后重启仍可恢复。 */
export type WorkbenchMessageView = {
  /** 消息 ID。 */
  id: string;
  /** 所属会话 ID。 */
  conversationId: string;
  /** 所属 Web 用户 ID。 */
  userId: number;
  /** 消息角色。 */
  role: WorkbenchMessageRole;
  /** 消息正文。 */
  content: string;
  /** 消息状态。 */
  status: WorkbenchMessageStatus;
  /** 消息类型。 */
  kind: WorkbenchMessageKind;
  /** 本条系统消息关联的生成任务或批次 ID。 */
  taskIds: string[];
  /** 消息附件。 */
  attachments: WorkbenchAttachmentView[];
  /** 工具调用结果。 */
  toolCalls: WorkbenchToolCallView[];
  /** 使用的聊天模型，普通绘图提交可为空。 */
  model: string | null;
  /** 错误摘要，仅失败消息存在。 */
  error: string | null;
  /** 关联的持久化 Agent Run ID；只有 assistant 消息通常会存在。 */
  agentRunId: string | null;
  /** 关联 Agent Run 的状态；用于刷新后恢复本条消息的执行状态。 */
  agentRunStatus: WorkbenchAgentRunStatus | null;
  /** 关联 Agent Run 的耗时毫秒，后端按 0.1 秒精度归一化。 */
  agentElapsedMs: number | null;
  /** 创建时间。 */
  createdAt: string;
};

/** 创建工作台会话请求。 */
export type WorkbenchConversationCreateRequest = {
  /** 可选标题；为空时后端使用默认标题。 */
  title?: string;
  /** 可选默认模型。 */
  model?: string;
  /** 默认生成张数。 */
  count?: number;
  /** 默认隐私状态。 */
  isPrivate?: boolean;
};

/** 工作台发送消息请求；后端会保存上下文并自动判断聊天或生成待确认绘图建议。 */
export type WorkbenchSendMessageRequest = {
  /** 用户本轮绘图需求原文。 */
  content: string;
  /** 兼容旧客户端字段；新工作台会由后端自动判断聊天或绘图。 */
  mode?: 'chat' | 'draw';
  /** 本轮携带的附件 ID。 */
  attachmentIds?: string[];
  /** 本轮使用模型；为空时沿用会话默认或后端默认。 */
  model?: string;
  /** 本轮生成张数。 */
  count?: number;
  /** 本轮隐私状态。 */
  isPrivate?: boolean;
};

/** 工作台绘图建议处理动作。 */
export type WorkbenchDrawingDecision = 'approve' | 'reject';

/** 工作台绘图建议确认请求。 */
export type WorkbenchDrawingDecisionRequest = {
  /** 用户允许或拒绝本次 AI 绘图提交。 */
  decision: WorkbenchDrawingDecision;
  /** 允许时选择的绘图方案 ID；旧单 Prompt 建议可为空。 */
  optionId?: string;
};

/** 工作台会话列表响应。 */
export type WorkbenchConversationListResponse = {
  /** 当前用户的会话列表。 */
  items: WorkbenchConversationView[];
};

/** 工作台会话删除响应。 */
export type WorkbenchConversationDeleteResponse = {
  /** 已删除的会话 ID。 */
  deletedId: string;
  /** 删除后当前用户剩余会话列表，便于前端立即选择下一个上下文窗口。 */
  items: WorkbenchConversationView[];
};

/** 工作台会话详情响应。 */
export type WorkbenchConversationDetailResponse = {
  /** 会话摘要。 */
  conversation: WorkbenchConversationView;
  /** 会话消息列表。 */
  messages: WorkbenchMessageView[];
};

/** 工作台发送消息响应。 */
export type WorkbenchSendMessageResponse = WorkbenchConversationDetailResponse & {
  /** 本次保存的用户消息。 */
  userMessage: WorkbenchMessageView;
  /** 本次保存的系统消息。 */
  assistantMessage: WorkbenchMessageView;
  /** 成功创建的生成任务；失败时为空。 */
  generation: GenerationCreateResponse | null;
};

/** 工作台绘图建议确认响应。 */
export type WorkbenchDrawingDecisionResponse = WorkbenchConversationDetailResponse & {
  /** 被标记的 assistant 绘图建议消息。 */
  assistantMessage: WorkbenchMessageView;
  /** 允许后创建的真实生成任务；拒绝或失败时为空。 */
  generation: GenerationCreateResponse | null;
};

/** 工作台流式消息结束事件数据；自动绘图时先返回待确认建议，允许后才创建真实任务。 */
export type WorkbenchStreamDoneEvent = WorkbenchSendMessageResponse;

/** 工作台失败消息重试结束事件数据；重试会覆盖原 assistant 消息，不新增用户消息。 */
export type WorkbenchRetryStreamDoneEvent = WorkbenchSendMessageResponse;

/** 工作台流式状态阶段；只用于前端展示当前等待点，不写入历史消息。 */
export type WorkbenchStreamStatusStage = 'ready' | 'received' | 'context' | 'planning' | 'image_selection' | 'routing' | 'streaming' | 'tool' | 'persisting';

/** 工作台流式状态事件；用于在上游首个文本 delta 前给用户明确反馈。 */
export type WorkbenchStreamStatusEvent = {
  /** 状态事件类型。 */
  type: 'status';
  /** 当前处理阶段。 */
  stage: WorkbenchStreamStatusStage;
  /** 前端可直接展示的短状态文本。 */
  text: string;
};

/** 工作台 Agent 单次运行开始事件；前端可用 runId 关联后续阶段。 */
export type WorkbenchStreamRunStartedEvent = {
  /** 事件类型。 */
  type: 'run_started';
  /** 本次用户消息对应的 Agent Run ID。 */
  runId: string;
  /** 本次 Agent Run 关联的用户消息 ID。 */
  userMessageId: string;
  /** 本次运行持久化的 assistant 消息 ID；前端用它把临时气泡切换为可刷新恢复的真实消息。 */
  assistantMessageId: string;
};

/** 工作台工具开始事件；用于快速告诉用户 Agent 正在调用真实工具。 */
export type WorkbenchStreamToolStartEvent = {
  /** 事件类型。 */
  type: 'tool_start';
  /** 工具名。 */
  tool: WorkbenchToolCallType;
  /** 前端可展示的短文本。 */
  text: string;
};

/** 工作台工具结果事件；只返回工具摘要，真实消息仍以 done 里的持久化数据为准。 */
export type WorkbenchStreamToolResultEvent = {
  /** 事件类型。 */
  type: 'tool_result';
  /** 工具名。 */
  tool: WorkbenchToolCallType;
  /** 工具执行状态。 */
  status: WorkbenchAgentStepStatus;
  /** 前端可展示的短文本。 */
  text: string;
};

/** 工作台流式事件联合；通过 text/event-stream 返回。 */
export type WorkbenchStreamEvent =
  | WorkbenchStreamRunStartedEvent
  | WorkbenchStreamStatusEvent
  | WorkbenchStreamToolStartEvent
  | WorkbenchStreamToolResultEvent
  | { type: 'delta'; text: string }
  | { type: 'done'; data: WorkbenchStreamDoneEvent }
  | { type: 'error'; message: string };

/** 上传工作台附件响应。 */
export type WorkbenchAttachmentUploadResponse = {
  /** 已保存附件。 */
  attachment: WorkbenchAttachmentView;
};

/** 工作台会话列表端点契约。 */
export type WorkbenchConversationListEndpoint = ApiEndpointContract<undefined, ApiDataResponse<WorkbenchConversationListResponse>>;

/** 工作台创建会话端点契约。 */
export type WorkbenchConversationCreateEndpoint = ApiEndpointContract<
  WorkbenchConversationCreateRequest,
  ApiDataResponse<WorkbenchConversationDetailResponse>
>;

/** 工作台会话详情端点契约。 */
export type WorkbenchConversationDetailEndpoint = ApiEndpointContract<undefined, ApiDataResponse<WorkbenchConversationDetailResponse>>;

/** 工作台会话删除端点契约。 */
export type WorkbenchConversationDeleteEndpoint = ApiEndpointContract<undefined, ApiDataResponse<WorkbenchConversationDeleteResponse>>;

/** 工作台发送消息端点契约。 */
export type WorkbenchSendMessageEndpoint = ApiEndpointContract<
  WorkbenchSendMessageRequest,
  ApiDataResponse<WorkbenchSendMessageResponse>
>;

/** 工作台流式发送消息端点契约；响应体为 text/event-stream。 */
export type WorkbenchSendMessageStreamEndpoint = ApiEndpointContract<WorkbenchSendMessageRequest, WorkbenchStreamEvent>;

/** 工作台失败消息重试端点契约；响应体为 text/event-stream，只允许重试当前用户自己的失败 assistant 消息。 */
export type WorkbenchRetryMessageStreamEndpoint = ApiEndpointContract<undefined, WorkbenchStreamEvent>;

/** 工作台绘图建议确认端点契约。 */
export type WorkbenchDrawingDecisionEndpoint = ApiEndpointContract<
  WorkbenchDrawingDecisionRequest,
  ApiDataResponse<WorkbenchDrawingDecisionResponse>
>;

/** 工作台附件上传端点契约。 */
export type WorkbenchAttachmentUploadEndpoint = ApiEndpointContract<undefined, ApiDataResponse<WorkbenchAttachmentUploadResponse>>;
