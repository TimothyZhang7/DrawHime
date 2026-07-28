/** 本文件负责把绘图主任务和子任务错误归纳为用户可理解的短原因。 */

/** 可用于归纳失败原因的子任务错误信号。 */
export type GenerationFailureSignal = {
  /** 子任务类型，优先关注 upstream_attempt/finalize 等真实失败节点。 */
  kind?: string;
  /** 子任务状态，failed 的信号权重最高。 */
  status?: string;
  /** 面向用户的清洗后错误。 */
  error?: string | null;
  /** 管理排障用脱敏原始错误；只用于识别类别，不原样返回给用户。 */
  rawError?: string | null;
};

/** 归纳失败原因所需上下文。 */
export type GenerationFailureSummaryInput = {
  /** 主任务错误，可能只是“重试次数已用完”。 */
  taskError?: string | null;
  /** 绘图模式，用于泛化输入审核时判断是否可能包含参考图。 */
  mode?: string | null;
  /** 子任务错误列表，按真实时间线传入即可。 */
  subTasks?: GenerationFailureSignal[] | null;
};

type FailureCategory =
  | 'prompt_policy'
  | 'reference_policy'
  | 'input_policy'
  | 'output_policy'
  | 'upstream_format'
  | 'upstream_timeout'
  | 'upstream_auth'
  | 'upstream_unavailable'
  | 'upstream_failed'
  | 'no_site'
  | 'save_failed'
  | 'reference_failed'
  | 'worker_timeout'
  | 'unknown';

const GENERIC_ERRORS = new Set([
  '重试次数已用完',
  '重试已终止',
  '所有重试均已用完',
  '已由上游调用结果覆盖',
  '已被新尝试覆盖',
  '任务已结束',
]);

/** 将任务错误和子任务错误归纳为一句短中文；返回值可以直接展示给用户。 */
export function summarizeGenerationFailure(input: GenerationFailureSummaryInput): string {
  const messages = collectFailureMessages(input);
  const categories = messages.map((message) => classifyFailureMessage(message, input.mode));

  const hasPromptPolicy = categories.includes('prompt_policy');
  const hasReferencePolicy = categories.includes('reference_policy');
  const hasInputPolicy = categories.includes('input_policy');
  const hasOutputPolicy = categories.includes('output_policy');
  const hasAnyInputPolicy = hasPromptPolicy || hasReferencePolicy || hasInputPolicy;

  // 审核类原因对用户最有行动价值，优先于同任务内夹杂的上游通用失败或超时。
  if (hasOutputPolicy && hasAnyInputPolicy) return '提交参数及最终结果未通过审查';
  if (hasOutputPolicy) return '最终生成图片未通过审查';
  if (hasPromptPolicy && hasReferencePolicy) return '提示词及参考图审查未通过';
  if (hasReferencePolicy) return '参考图审查未通过';
  if (hasPromptPolicy) return '提示词审查未通过';
  if (hasInputPolicy) return input.mode === 'image-to-image' ? '提示词或参考图审查未通过' : '提交参数审查未通过';

  if (categories.includes('upstream_format')) return '上游返回结果格式错误';
  if (categories.includes('upstream_timeout')) return '上游请求超时';
  if (categories.includes('upstream_auth')) return '上游鉴权失败';
  if (categories.includes('upstream_unavailable')) return '上游服务暂时不可用';
  if (categories.includes('no_site')) return '暂无可用绘图站点';
  if (categories.includes('save_failed')) return '生成图片保存失败';
  if (categories.includes('reference_failed')) return '参考图读取失败';
  if (categories.includes('worker_timeout')) return '任务执行超时';
  if (categories.includes('upstream_failed')) return '上游请求失败';

  const fallback = firstSpecificMessage(messages) ?? input.taskError ?? '任务执行失败';
  return shortenUserMessage(fallback);
}

/** 收集真实失败错误，过滤重试收尾和覆盖类噪声。 */
function collectFailureMessages(input: GenerationFailureSummaryInput): string[] {
  const result: string[] = [];
  for (const subTask of input.subTasks ?? []) {
    const error = normalizeMessage(subTask.error);
    const rawError = normalizeMessage(subTask.rawError);
    if (error && shouldUseSubTaskError(subTask, error)) result.push(error);
    if (rawError && rawError !== error && shouldUseSubTaskError(subTask, rawError)) result.push(rawError);
  }
  const taskError = normalizeMessage(input.taskError);
  if (result.length === 0 && taskError) result.push(taskError);
  return result;
}

/** 判断子任务错误是否是可用于归因的真实错误。 */
function shouldUseSubTaskError(subTask: GenerationFailureSignal, error: string): boolean {
  if (GENERIC_ERRORS.has(error)) return false;
  if (subTask.kind === 'site_switch' || subTask.kind === 'same_site_retry') return false;
  if (subTask.status && subTask.status !== 'failed') return false;
  return true;
}

/** 对单条错误消息做类别识别，只返回类别，不返回原始敏感内容。 */
function classifyFailureMessage(message: string, mode?: string | null): FailureCategory {
  const text = message.trim();
  const lower = text.toLowerCase();

  if (looksLikeUpstreamFormatError(text)) return 'upstream_format';
  if (lower.includes('this operation was aborted') || lower.includes('abort') || lower.includes('timeout') || text.includes('超时')) {
    return text.includes('Worker') || text.includes('任务执行超时') ? 'worker_timeout' : 'upstream_timeout';
  }
  if (lower.includes('invalid token') || lower.includes('unauthorized') || lower.includes('forbidden') || text.includes('鉴权失败')) {
    return 'upstream_auth';
  }
  if (lower.includes('http 502') || lower.includes('http 503') || lower.includes('http 504') || text.includes('错误页面') || text.includes('暂时不可用')) {
    return 'upstream_unavailable';
  }
  if (text.includes('没有可用的绘图站点') || text.includes('所有可用站点均已尝试失败')) return 'no_site';
  if (text.includes('生成图片保存失败')) return 'save_failed';
  if (text.includes('参考图') && (text.includes('失败') || text.includes('损坏') || text.includes('无效') || text.includes('无法附加'))) {
    return 'reference_failed';
  }

  if (isPolicyMessage(text)) {
    if (text.includes('生成的图片') || lower.includes('generated image') || lower.includes('output image')) return 'output_policy';
    if (text.includes('参考图') || text.includes('上传的图像') || lower.includes('reference image') || lower.includes('uploaded image') || lower.includes('input image')) {
      return 'reference_policy';
    }
    if (text.includes('提示') || lower.includes('prompt')) return 'prompt_policy';
    return mode === 'image-to-image' ? 'input_policy' : 'prompt_policy';
  }

  if (lower.includes('upstream request failed') || text.includes('上游 API 返回异常') || text.includes('上游')) {
    return 'upstream_failed';
  }
  if (text.includes('任务执行超时')) return 'worker_timeout';
  return 'unknown';
}

/** 判断上游是否返回了普通文本/JSON 而不是图片结果。 */
function looksLikeUpstreamFormatError(text: string): boolean {
  const lower = text.toLowerCase();
  if (text.includes('上游响应中未找到图片数据') || text.includes('非预期的响应格式')) return true;
  if ((text.trim().startsWith('{') || text.trim().startsWith('[')) && lower.includes('"prompt"')) return true;
  if ((text.startsWith('明白了') || lower.startsWith('understood') || text.startsWith('我可以帮你')) && lower.includes('"prompt"')) return true;
  if (lower.includes('referenced_image_ids') && lower.includes('prompt')) return true;
  return false;
}

/** 内容审核相关错误的统一识别。 */
function isPolicyMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return text.includes('内容政策')
    || text.includes('防护限制')
    || text.includes('审查')
    || text.includes('审计')
    || text.includes('风险规则')
    || lower.includes('content_policy')
    || lower.includes('safety')
    || lower.includes('policy violation')
    || lower.includes('cannot generate')
    || lower.includes('无法生成')
    || lower.includes('不能帮助生成')
    || lower.includes('我不能帮助');
}

/** 标准化错误文本，清理空白并过滤泛化噪声。 */
function normalizeMessage(value?: string | null): string {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** 选择第一条非泛化错误作为兜底展示。 */
function firstSpecificMessage(messages: string[]): string | undefined {
  return messages.find((message) => message && !GENERIC_ERRORS.has(message));
}

/** 兜底错误也要压短，避免上游长文本刷屏。 */
function shortenUserMessage(message: string): string {
  const cleaned = normalizeMessage(message);
  if (!cleaned) return '任务执行失败';
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
}
