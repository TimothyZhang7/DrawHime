/**
 * 本文件封装上游错误清洗、分类和中文化逻辑。
 * 这些函数必须脱敏密钥和大体积 base64，避免生产日志泄露敏感信息。
 */

/** 判断上游是否把聊天式文本/JSON 当错误消息返回，而不是返回图片结果。 */
export function looksLikeWrongFormatMessage(message: string): boolean {
  const text = message.trim();
  const lower = text.toLowerCase();
  if ((text.startsWith('{') || text.startsWith('[')) && lower.includes('"prompt"')) return true;
  if ((text.startsWith('明白了') || text.startsWith('我可以帮你') || lower.startsWith('understood')) && lower.includes('"prompt"')) return true;
  return lower.includes('referenced_image_ids') && lower.includes('prompt');
}

/** 判断纯文本/非 JSON 上游错误是否值得重试；平台不支持、鉴权和参数错误必须立即停止。 */
export function isPlainTextResponseRetryable(text: string, statusCode: number): boolean {
  const lower = text.toLowerCase();
  if (isContentPolicyBlockedText(lower)) return false;
  if (lower.includes('images api is not supported for this platform')) return false;
  if (lower.includes('image generation is only available via')) return false;
  if (statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 405) return false;
  if (statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429) return true;
  return statusCode >= 500;
}

/** 判断上游是否明确表示内容审核拦截；这类错误重试不会改变结果，必须直接停止。 */
export function isContentPolicyBlockedText(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('prohibited_content')
    || lower.includes('content_filter')
    || lower.includes('safety filter')
    || lower.includes('safety_filter')
    || lower.includes('blocked by gemini api')
    || lower.includes('request blocked')
    || lower.includes('policy violation')
    || lower.includes('content policy')
    || lower.includes('内容审核')
    || lower.includes('安全策略')
    || lower.includes('违规内容');
}

/** 脱敏原始响应文本，移除 base64 大字段、Bearer token、api_key、sk-* 密钥。 */
export function sanitizeRawError(raw: string): string {
  let sanitized = raw
    .replace(/"[A-Za-z0-9+/=]{200,}"/g, '"[BASE64_DATA_REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key["\s:=]+)([A-Za-z0-9._\-]+)/gi, '$1[REDACTED]')
    .replace(/\b(sk|fk)-[A-Za-z0-9]{20,}\b/g, '$1-[REDACTED]');
  if (sanitized.length > 4000) {
    sanitized = sanitized.slice(0, 4000) + '...[TRUNCATED]';
  }
  return sanitized;
}

/** 将上游错误转换为中文用户消息，支持 HTML/JSON/英文错误码等多种格式。 */
export function toChineseError(text: string, fallback: string, statusCode?: number): string {
  const lowerText = text.toLowerCase();
  if (lowerText.includes('images api is not supported for this platform')) return '上游站点不支持 Images API，不能通过当前端点生成图片';
  if (lowerText.includes('image generation is only available via www.geek2api.com')) return '上游图片生成只允许通过 www.geek2api.com 入口调用';
  if (isContentPolicyBlockedText(text) || isContentPolicyBlockedText(fallback)) return '上游内容审核拦截，请调整提示词或参考图后重试';
  if (looksLikeWrongFormatMessage(text)) return '上游返回结果格式错误';
  if (text.trim().startsWith('<!') || text.trim().startsWith('<html')) {
    return `上游 API 返回了错误页面 (HTTP ${statusCode ?? 'unknown'})，可能正在维护或请求被拦截`;
  }
  if (fallback.includes('abort') || fallback.includes('timeout') || fallback.includes('ETIMEDOUT')) {
    return '上游 API 请求超时，请稍后重试';
  }
  if (/[一-龥]/.test(fallback)) {
    return fallback.length > 150 ? fallback.slice(0, 150) + '…' : fallback;
  }
  if (statusCode === 429) return '请求过于频繁，请稍后重试';
  if (statusCode === 401 || statusCode === 403) return '上游 API 鉴权失败，请联系管理员';
  if (statusCode === 404 && lowerText.includes('404 page not found')) return '上游站点不支持 Gemini Interactions API';
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) return '上游服务暂时不可用，正在自动重试';
  if (statusCode && statusCode >= 500) return `上游服务器错误 (HTTP ${statusCode})，正在自动重试`;
  if (fallback.includes('is not valid JSON') || fallback.includes('Unexpected token')) {
    return '上游 API 返回了非预期的响应格式，可能正在维护';
  }
  return `上游 API 返回异常: ${fallback.slice(0, 80)}`;
}
