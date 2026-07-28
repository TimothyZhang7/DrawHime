/** 本文件提供生成主任务与子任务接口的请求校验，避免无效数据进入数据库事务。 */
import type {
  GenerationAppendSubTaskRequest,
  GenerationCreateRequest,
  GenerationRetryNextAction,
  GenerationSubTaskKind,
  GenerationSubTaskStatus,
  GenerationUpdateTaskStatusRequest,
} from '@aiimage/shared-contracts';
import { isDrawingAspectRatio } from '@aiimage/shared-contracts';
import { CONFIG_KEYS, getString } from '../../shared/config/config-service.js';

/** 单张参考图任务输入大小上限，只校验 Web 端传来的 sourceImageSizes 单项；当前本地链路统一为 3MB。 */
const MAX_REFERENCE_IMAGE_BYTES = Number(process.env.REFERENCE_SINGLE_IMAGE_MAX_BYTES ?? String(3 * 1024 * 1024));
/** 单任务参考图任务输入大小合计上限，按 sourceImageSizes 相加。 */
const MAX_REFERENCE_TOTAL_BYTES = Number(process.env.REFERENCE_TOTAL_IMAGE_MAX_BYTES ?? String(16 * 1024 * 1024));

/** 允许的绘图模式，必须与 shared-contracts 的 DrawingMode 保持一致。 */
const drawingModes = new Set(['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video']);

/** Grok 视频端点真实支持的画幅集合。 */
const videoAspectRatios = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

/** Grok 视频端点真实支持的分辨率档位。 */
const videoResolutions = new Set(['480p', '720p', '1080p']);

/** 允许的主任务状态，服务间状态更新只能写入这些值；deferred 只允许后端批次调度内部写入。 */
const drawingStatuses = new Set(['queued', 'running', 'finalizing', 'success', 'failed']);

/** 允许的子任务类型，所有重试行为必须归入这些明确类型。 */
const subTaskKinds = new Set<GenerationSubTaskKind>([
  'request_received',
  'prompt_assist',
  'dispatch',
  'same_site_retry',
  'site_switch',
  'upstream_attempt',
  'image_saved',
  'result_ready',
  'result_delivered',
  'finalize',
]);

/** 允许的子任务状态，避免调用方写入不可解释的状态字符串。 */
const subTaskStatuses = new Set<GenerationSubTaskStatus>(['queued', 'running', 'success', 'failed', 'skipped']);

/** 允许的下一步动作，必须与重试链路文档一致。 */
const retryNextActions = new Set<GenerationRetryNextAction>(['stop', 'switch_site', 'same_site']);

/** 读取后台配置的提示词长度上限，避免前端允许提交但后端仍按环境变量拦截。 */
async function readMaxPromptLength(): Promise<number> {
  const raw = await getString(CONFIG_KEYS.drawingMaxPromptLength.key, CONFIG_KEYS.drawingMaxPromptLength.default);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return Number(CONFIG_KEYS.drawingMaxPromptLength.default);
  return Math.min(50_000, Math.max(100, value));
}

/** 校验用户创建主任务请求，返回中文错误；通过时返回 undefined。 */
export async function validateGenerationCreateRequest(body: unknown): Promise<string | undefined> {
  if (!isRecord(body)) return '生成请求格式不正确';
  if (body.clientRequestId !== undefined && !isClientRequestId(body.clientRequestId)) return 'clientRequestId 格式不正确';
  if (typeof body.mode !== 'string' || !drawingModes.has(body.mode)) return '绘图模式不正确';
  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) return '提示词不能为空';
  const maxPromptLength = await readMaxPromptLength();
  if (body.prompt.length > maxPromptLength) return `提示词不能超过 ${maxPromptLength} 字符`;
  if (body.templateId !== undefined && !isPositiveInteger(body.templateId)) return '模板 ID 不正确';
  if (body.sourceImageUrls !== undefined && !isStringArray(body.sourceImageUrls, 8)) return '参考图 URL 列表格式不正确';
  const sourceImageSizesError = validateSourceImageSizes(body.sourceImageSizes, Array.isArray(body.sourceImageUrls) ? body.sourceImageUrls.length : 0);
  if (sourceImageSizesError) return sourceImageSizesError;
  if (body.mode === 'image-to-image' && (!Array.isArray(body.sourceImageUrls) || body.sourceImageUrls.length === 0)) return '图生图至少需要 1 张参考图';
  if (body.mode === 'image-to-video' && (!Array.isArray(body.sourceImageUrls) || body.sourceImageUrls.length === 0)) return '参考图视频至少需要 1 张参考图';
  if (body.referencePromptAssist !== undefined && typeof body.referencePromptAssist !== 'boolean') return 'AI 提示增强参数格式不正确';
  if (body.lora !== undefined && !isGenerationLoraSelection(body.lora)) return 'LoRA 选择参数不正确';
  if (body.lora !== undefined && body.mode !== 'text-to-image') return 'LoRA 当前只支持文生图任务';
  if (body.mode === 'text-to-image' && Array.isArray(body.sourceImageUrls) && body.sourceImageUrls.length > 0 && body.referencePromptAssist !== true) return '当前生成模式不接收参考图';
  if (body.mode === 'text-to-video' && Array.isArray(body.sourceImageUrls) && body.sourceImageUrls.length > 0) return '当前生成模式不接收参考图';
  if (body.referencePromptAssist === true && body.mode !== 'text-to-image') return 'AI 提示增强只适用于文生图任务';
  if (body.referencePromptAssist === true && Array.isArray(body.sourceImageUrls) && body.sourceImageUrls.length > 4) return 'AI 提示增强最多接受 4 张参考图';
  if (body.isPrivate !== undefined && typeof body.isPrivate !== 'boolean') return '私密参数格式不正确';
  if (typeof body.model === 'string' && body.model.trim().startsWith('local:')) return '本地模型功能已下线';
  if (body.model !== undefined && !isModelName(body.model)) return '模型名称格式不正确';
  if (body.aspectRatio !== undefined && !isDrawingAspectRatio(body.aspectRatio)) return '画幅比例不正确';
  if (body.count !== undefined && (!Number.isSafeInteger(body.count) || Number(body.count) < 1)) return '生成张数不正确';
  const isVideo = body.mode === 'text-to-video' || body.mode === 'image-to-video';
  if (isVideo && body.count !== undefined && body.count !== 1) return '视频任务每次只能生成 1 个结果';
  if (isVideo && (!Number.isSafeInteger(body.duration) || Number(body.duration) < 1 || Number(body.duration) > 15)) return '视频时长必须为 1-15 秒整数';
  if (isVideo && (typeof body.resolution !== 'string' || !videoResolutions.has(body.resolution))) return '视频分辨率不正确';
  if (isVideo && (typeof body.aspectRatio !== 'string' || !videoAspectRatios.has(body.aspectRatio))) return '视频画幅比例不正确';
  if (body.storyboardDesign !== undefined && typeof body.storyboardDesign !== 'boolean') return '分镜设计参数格式不正确';
  if (!isVideo && (body.duration !== undefined || body.resolution !== undefined || body.storyboardDesign !== undefined)) return '图片任务不能携带视频参数';
  if (isVideo && body.referencePromptAssist !== undefined) return '视频任务不能携带 AI 提示增强参数';
  if ('localInferenceParams' in body) return '本地模型功能已下线';
  return undefined;
}

/** 校验浏览器提交的单个 LoRA ID 与强度，文件元数据由 service 层重新读取。 */
function isGenerationLoraSelection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.id) && Number(record.id) > 0
    && typeof record.strength === 'number' && Number.isFinite(record.strength)
    && record.strength >= 0 && record.strength <= 2;
}

/** 校验 Web 端参考图任务输入大小；单张和合计必须分开判断，避免把累计限制误用于单张。 */
function validateSourceImageSizes(value: unknown, expectedLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== expectedLength || value.length > 8) return '参考图大小列表格式不正确';
  let total = 0;
  for (const [index, item] of value.entries()) {
    if (!Number.isSafeInteger(item) || Number(item) < 0) return '参考图大小列表格式不正确';
    const size = Number(item);
    if (size > MAX_REFERENCE_IMAGE_BYTES) return `第 ${index + 1} 张参考图不能超过 ${formatMegabytes(MAX_REFERENCE_IMAGE_BYTES)}`;
    total += size;
  }
  if (total > MAX_REFERENCE_TOTAL_BYTES) return '单任务参考图合计不能超过 16MB';
  return undefined;
}

/** 校验恢复请求中的 clientRequestId。 */
export function validateRecoverClientRequestId(value: unknown): value is string {
  return isClientRequestId(value);
}

/** 校验批量查询任务 ID 列表，避免无上限查询。 */
export function parseTaskIdsQuery(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^[a-zA-Z0-9:_-]{1,96}$/.test(item))
    .slice(0, 50);
}

/** 校验内部追加子任务请求。 */
export function validateAppendSubTaskRequest(body: unknown): body is GenerationAppendSubTaskRequest {
  if (!isRecord(body)) return false;
  return typeof body.taskId === 'string'
    && /^[a-zA-Z0-9:_-]{1,64}$/.test(body.taskId)
    && typeof body.kind === 'string'
    && subTaskKinds.has(body.kind as GenerationSubTaskKind)
    && typeof body.status === 'string'
    && subTaskStatuses.has(body.status as GenerationSubTaskStatus)
    && (body.attemptNo === undefined || isPositiveInteger(body.attemptNo))
    && (body.siteId === undefined || isPositiveInteger(body.siteId))
    && (body.siteName === undefined || typeof body.siteName === 'string')
    && (body.model === undefined || typeof body.model === 'string')
    && (body.retryable === undefined || typeof body.retryable === 'boolean')
    && (body.nextAction === undefined || (typeof body.nextAction === 'string' && retryNextActions.has(body.nextAction as GenerationRetryNextAction)))
    && (body.latencyMs === undefined || isNonNegativeInteger(body.latencyMs))
    && (body.error === undefined || typeof body.error === 'string')
    && (body.rawError === undefined || typeof body.rawError === 'string')
    && (body.startedAt === undefined || isDateString(body.startedAt))
    && (body.finishedAt === undefined || isDateString(body.finishedAt));
}

/** 校验内部主任务状态更新请求。 */
export function validateUpdateTaskStatusRequest(body: unknown): body is GenerationUpdateTaskStatusRequest {
  if (!isRecord(body)) return false;
  return typeof body.taskId === 'string'
    && /^[a-zA-Z0-9:_-]{1,64}$/.test(body.taskId)
    && typeof body.status === 'string'
    && drawingStatuses.has(body.status)
    && (body.error === undefined || typeof body.error === 'string');
}

/** 判断 unknown 是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断 clientRequestId 是否满足幂等键格式。 */
function isClientRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,96}$/.test(value);
}

/** 判断值是否为正整数。 */
function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** 判断值是否为非负整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** 校验字符串数组，并限制最大数量。 */
function isStringArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxLength
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

/** 校验模型名称只允许常见上游模型 ID 字符，避免把任意长文本写入任务链路。 */
function isModelName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(value.trim());
}

/** 把字节上限格式化成用户可读的 MB 文案，避免默认值变化后错误提示滞后。 */
function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
}

/** 校验可解析时间字符串，内部接口允许 drawing-service 传入 ISO 时间。 */
function isDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
