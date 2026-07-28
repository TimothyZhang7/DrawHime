/** 本文件校验 drawing-service 生成入口请求，保证只接收 backend 已创建的主任务。 */
import { isDrawingAspectRatio, type DrawingGenerateRequest } from '@aiimage/shared-contracts';

/** 允许的绘图来源。 */
const drawingSources = new Set(['web', 'bot']);

/** 允许的绘图模式。 */
const drawingModes = new Set(['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video']);

/** 视频分辨率由 backend 强校验，drawing-service 继续做服务边界校验。 */
const videoResolutions = new Set(['480p', '720p', '1080p']);

/** 校验服务间生成请求。 */
export function validateDrawingGenerateRequest(body: unknown): body is DrawingGenerateRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const request = body as Partial<DrawingGenerateRequest>;
  return typeof request.taskId === 'string'
    && /^[a-zA-Z0-9:_-]{1,64}$/.test(request.taskId)
    && typeof request.clientRequestId === 'string'
    && /^[a-zA-Z0-9:_-]{1,96}$/.test(request.clientRequestId)
    && typeof request.source === 'string'
    && drawingSources.has(request.source)
    && typeof request.mode === 'string'
    && drawingModes.has(request.mode)
    && typeof request.prompt === 'string'
    && request.prompt.trim().length > 0
    // 模型级尝试次数由 backend 在任务创建时固化，服务边界拒绝缺失或越界值。
    && Number.isSafeInteger(request.maxAttempts)
    && Number(request.maxAttempts) >= 1
    && Number(request.maxAttempts) <= 10
    // QQ 号只对 Bot 任务必填；未绑定 QQ 的 Web 任务依赖 userId 归属。
    && (request.source === 'bot'
      ? typeof request.qqNumber === 'string' && /^\d{3,20}$/.test(request.qqNumber)
      : request.qqNumber === undefined || (typeof request.qqNumber === 'string' && /^\d{3,20}$/.test(request.qqNumber)))
    && (request.userId === undefined || Number.isSafeInteger(request.userId))
    && (request.templateId === undefined || Number.isSafeInteger(request.templateId))
    && (request.sourceImageUrls === undefined || isStringArray(request.sourceImageUrls))
    && (request.isPrivate === undefined || typeof request.isPrivate === 'boolean')
    && (request.aspectRatio === undefined || isDrawingAspectRatio(request.aspectRatio))
    && (request.duration === undefined || (Number.isSafeInteger(request.duration) && request.duration >= 1 && request.duration <= 15))
    && (request.resolution === undefined || videoResolutions.has(request.resolution))
    && (request.lora === undefined || isDrawingLoraSnapshot(request.lora, request.mode))
    && (request.asyncSubmit === undefined || typeof request.asyncSubmit === 'boolean');
}

/** 校验 backend 固化的 LoRA 快照，防止损坏的跨服务请求进入 Worker。 */
function isDrawingLoraSnapshot(value: unknown, mode: string | undefined): boolean {
  if (mode !== 'text-to-image' || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.id) && Number(record.id) > 0
    && typeof record.title === 'string' && record.title.trim().length > 0
    && typeof record.baseModel === 'string' && record.baseModel.trim().length > 0
    && typeof record.strength === 'number' && Number.isFinite(record.strength) && record.strength >= 0 && record.strength <= 2
    && Number.isSafeInteger(record.sizeBytes) && Number(record.sizeBytes) > 0
    && typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256)
    && typeof record.gpuFileName === 'string' && /^aiimage_lora_[a-f0-9]{64}\.safetensors$/.test(record.gpuFileName);
}

/** 校验字符串数组，图生图 URL 当前最多允许 8 个。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 8
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}
