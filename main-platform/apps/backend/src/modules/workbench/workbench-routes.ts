/** 本文件注册导航工作台 HTTP 路由，所有入口都必须使用用户 JWT。 */
import type { IncomingMessage } from 'node:http';
import {
  ApiErrorCode,
  type ApiDataResponse,
  type WorkbenchConversationCreateRequest,
  type WorkbenchConversationDeleteResponse,
  type WorkbenchConversationDetailResponse,
  type WorkbenchConversationListResponse,
  type WorkbenchAttachmentUploadResponse,
  type WorkbenchSendMessageRequest,
  type WorkbenchSendMessageResponse,
  type WorkbenchStreamEvent,
  type WorkbenchStreamStatusEvent,
  type WorkbenchDrawingDecisionRequest,
  type WorkbenchDrawingDecisionResponse,
} from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { WorkbenchError, WorkbenchService } from './workbench-service.js';
import { WorkbenchAttachmentError, WorkbenchAttachmentService } from './workbench-attachment-service.js';

const workbenchService = new WorkbenchService();
const attachmentService = new WorkbenchAttachmentService();
const WORKBENCH_ATTACHMENT_UPLOAD_MAX_BYTES = Number(process.env.WORKBENCH_ATTACHMENT_MAX_BYTES ?? String(12 * 1024 * 1024));

/** 创建导航工作台路由。 */
export function createWorkbenchRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/workbench/conversations', handle: listConversations },
    { method: 'POST', path: '/api/workbench/conversations', handle: createConversation },
    { method: 'GET', path: '/api/workbench/conversations/:id', handle: getConversation },
    { method: 'DELETE', path: '/api/workbench/conversations/:id', handle: deleteConversation },
    { method: 'POST', path: '/api/workbench/conversations/:id/messages', handle: sendMessage },
    { method: 'POST', path: '/api/workbench/conversations/:id/messages/stream', handle: streamMessage },
    { method: 'POST', path: '/api/workbench/conversations/:id/messages/:messageId/retry/stream', handle: retryMessage },
    { method: 'POST', path: '/api/workbench/conversations/:id/messages/:messageId/decision', handle: decideDrawingProposal },
    { method: 'POST', path: '/api/workbench/attachments', handle: uploadAttachment },
    { method: 'GET', path: '/api/workbench/attachments/:id', handle: getAttachment },
  ];
}

/** 查询当前用户工作台会话列表。 */
async function listConversations(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const data = await workbenchService.listConversations(userId);
  return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<WorkbenchConversationListResponse>);
}

/** 创建新的工作台对话窗口。 */
async function createConversation(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const body = await readJsonBody<WorkbenchConversationCreateRequest>(req);
  const data = await workbenchService.createConversation(userId, body);
  return sendJson(res, 201, { ok: true, data } satisfies ApiDataResponse<WorkbenchConversationDetailResponse>);
}

/** 读取指定工作台对话窗口。 */
async function getConversation(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const conversationId = String(params?.id ?? '').trim();
  if (!isSafeWorkbenchId(conversationId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '会话 ID 不正确' });
  const data = await workbenchService.getConversation(userId, conversationId);
  if (!data) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '会话不存在' });
  return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<WorkbenchConversationDetailResponse>);
}

/** 删除当前用户自己的工作台对话窗口；真实绘图任务和图库记录不会被删除。 */
async function deleteConversation(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const conversationId = String(params?.id ?? '').trim();
  if (!isSafeWorkbenchId(conversationId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '会话 ID 不正确' });
  const data = await workbenchService.deleteConversation(userId, conversationId);
  if (!data) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '会话不存在' });
  return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<WorkbenchConversationDeleteResponse>);
}

/** 发送工作台消息；后端会保存上下文并创建真实绘图任务。 */
async function sendMessage(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const conversationId = String(params?.id ?? '').trim();
  if (!isSafeWorkbenchId(conversationId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '会话 ID 不正确' });
  const body = await readJsonBody<WorkbenchSendMessageRequest>(req);
  try {
    const data = await workbenchService.sendMessage(userId, conversationId, body);
    if (!data) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '会话不存在' });
    return sendJson(res, 202, { ok: true, data } satisfies ApiDataResponse<WorkbenchSendMessageResponse>);
  } catch (error) {
    if (error instanceof WorkbenchError) {
      return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: error.message });
    }
    throw error;
  }
}

/** 流式发送工作台消息；后端会自动判断聊天或绘图，绘图仍走真实扣费任务链路。 */
async function streamMessage(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const conversationId = String(params?.id ?? '').trim();
  if (!isSafeWorkbenchId(conversationId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '会话 ID 不正确' });
  const body = await readJsonBody<WorkbenchSendMessageRequest>(req);
  writeSseHeaders(res);
  // 首个状态事件用于尽快打通浏览器流式连接，避免用户只看到本地“正在思考”。
  writeSse(res, 'status', { type: 'status', stage: 'ready', text: '已连接工作台，正在处理请求' } satisfies WorkbenchStreamStatusEvent);
  try {
    const data = await workbenchService.streamAutoMessage(userId, conversationId, body, text => {
      writeSse(res, 'delta', { type: 'delta', text });
    }, event => {
      writeSse(res, event.type, event);
    });
    if (!data) {
      writeSse(res, 'error', { type: 'error', message: '会话不存在' });
      res.end();
      return;
    }
    writeSse(res, 'done', { type: 'done', data });
    res.end();
    return;
  } catch (error) {
    const message = error instanceof WorkbenchError
      ? error.message
      : error instanceof Error
        ? error.message
        : '工作台 AI 回复失败';
    writeSse(res, 'error', { type: 'error', message });
    res.end();
    return;
  }
}

/** 原位重试失败 Agent 消息；不会新增用户消息，只覆盖当前失败 assistant 消息。 */
async function retryMessage(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const conversationId = String(params?.id ?? '').trim();
  const messageId = String(params?.messageId ?? '').trim();
  if (!isSafeWorkbenchId(conversationId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '会话 ID 不正确' });
  if (!isSafeWorkbenchId(messageId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '消息 ID 不正确' });
  writeSseHeaders(res);
  writeSse(res, 'status', { type: 'status', stage: 'ready', text: '已连接工作台，正在重试失败步骤' } satisfies WorkbenchStreamStatusEvent);
  try {
    const data = await workbenchService.streamRetryMessage(userId, conversationId, messageId, text => {
      writeSse(res, 'delta', { type: 'delta', text });
    }, event => {
      writeSse(res, event.type, event);
    });
    if (!data) {
      writeSse(res, 'error', { type: 'error', message: '会话或失败消息不存在' });
      res.end();
      return;
    }
    writeSse(res, 'done', { type: 'done', data });
    res.end();
    return;
  } catch (error) {
    const message = error instanceof WorkbenchError
      ? error.message
      : error instanceof Error
        ? error.message
        : '工作台 AI 重试失败';
    writeSse(res, 'error', { type: 'error', message });
    res.end();
    return;
  }
}

/** 处理 AI 绘图建议确认；拒绝只写标记，允许才进入真实绘图链路。 */
async function decideDrawingProposal(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const conversationId = String(params?.id ?? '').trim();
  const messageId = String(params?.messageId ?? '').trim();
  if (!isSafeWorkbenchId(conversationId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '会话 ID 不正确' });
  if (!isSafeWorkbenchId(messageId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '消息 ID 不正确' });
  const body = await readJsonBody<WorkbenchDrawingDecisionRequest>(req);
  try {
    const data = await workbenchService.decideDrawingProposal(userId, conversationId, messageId, body);
    if (!data) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '绘图建议不存在' });
    return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<WorkbenchDrawingDecisionResponse>);
  } catch (error) {
    if (error instanceof WorkbenchError) {
      const status = error.kind === 'conflict' ? 409 : 400;
      const code = error.kind === 'conflict' ? ApiErrorCode.Conflict : ApiErrorCode.BadRequest;
      return sendJson(res, status, { ok: false, code, message: error.message });
    }
    throw error;
  }
}

/** 上传工作台图片附件；附件先落本地，消息发送时只传附件 ID。 */
async function uploadAttachment(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const mimeType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请上传图片文件' });
  try {
    const buffer = await readBinaryBody(req, WORKBENCH_ATTACHMENT_UPLOAD_MAX_BYTES);
    const originalName = decodeURIComponent(String(req.headers['x-aiimage-file-name'] ?? 'image'));
    const conversationId = String(req.headers['x-aiimage-conversation-id'] ?? '').trim();
    const attachment = await attachmentService.saveImage(userId, buffer, mimeType, originalName, isSafeWorkbenchId(conversationId) ? conversationId : undefined);
    return sendJson(res, 201, { ok: true, data: { attachment } } satisfies ApiDataResponse<WorkbenchAttachmentUploadResponse>);
  } catch (error) {
    if (error instanceof WorkbenchAttachmentError) {
      return sendJson(res, error.status, { ok: false, code: ApiErrorCode.BadRequest, message: error.message });
    }
    const message = error instanceof Error ? error.message : '附件上传失败';
    return sendJson(res, message.includes('超过') ? 413 : 400, { ok: false, code: ApiErrorCode.BadRequest, message });
  }
}

/** 读取当前用户自己的工作台附件图片；权限在服务层再次校验。 */
async function getAttachment(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = authenticateUser(req);
  if (!userId) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const attachmentId = String(params?.id ?? '').trim();
  if (!isSafeWorkbenchId(attachmentId)) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '附件 ID 不正确' });
  const served = await attachmentService.serveOwnedImage(userId, attachmentId, res);
  if (!served && !res.headersSent) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '附件不存在' });
}

/** 写入 SSE 响应头；关闭代理缓冲，确保模型增量能尽快到达浏览器。 */
function writeSseHeaders(res: Parameters<typeof sendJson>[0]) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/** 写入单个 SSE 事件；所有数据统一 JSON 化，前端按 event 名分发。 */
function writeSse(res: Parameters<typeof sendJson>[0], event: WorkbenchStreamEvent['type'], data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** 校验用户 JWT，返回用户 id；失败时由路由层转为 401。 */
function authenticateUser(req: IncomingMessage) {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try {
    return verifyAccessToken(token).sub;
  } catch {
    return undefined;
  }
}

/** 工作台会话 ID 只接受后端生成的安全短 ID。 */
function isSafeWorkbenchId(value: string) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

/** 读取附件二进制请求体；超过单文件上限立即停止，避免大文件占用内存。 */
async function readBinaryBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += buffer.length;
    if (size > limitBytes) throw new Error('图片不能超过 12MB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
