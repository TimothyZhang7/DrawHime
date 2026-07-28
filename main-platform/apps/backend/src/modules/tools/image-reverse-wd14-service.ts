/**
 * 本文件调用真实 WD14 GPU Provider，并把上游标签、置信度和健康状态归一化为后端内部结构。
 */
import type { ImageReverseWd14HealthResponse } from '@aiimage/shared-contracts';

/** WD14 私有运行时配置；地址和密钥不返回用户端。 */
export interface ImageReverseWd14RuntimeConfig {
  /** 是否启用 WD14 混合证据。 */
  enabled: boolean;
  /** GPU Provider Base URL。 */
  baseUrl: string;
  /** GPU Provider API Key。 */
  apiKey: string;
  /** 后台展示和审计使用的模型名。 */
  model: string;
  /** 单次请求超时秒数。 */
  timeoutSec: number;
  /** general 标签阈值。 */
  generalThreshold: number;
  /** character 标签阈值。 */
  characterThreshold: number;
  /** general 标签最大返回数。 */
  maxTags: number;
}

/** WD14 单条真实标签。 */
export interface ImageReverseWd14Tag {
  /** Danbooru 英文标签。 */
  name: string;
  /** WD14 标签类别。 */
  category: 'general' | 'character';
  /** 模型原生概率。 */
  confidence: number;
}

/** WD14 Provider 的成功或降级结果。 */
export interface ImageReverseWd14RunResult {
  /** Provider 是否成功。 */
  status: 'succeeded' | 'failed' | 'skipped';
  /** 实际模型。 */
  model: string;
  /** Provider 耗时。 */
  durationMs: number;
  /** 成功时的真实标签。 */
  tags: ImageReverseWd14Tag[];
  /** 激活的 ONNX Runtime Provider。 */
  providers: string[];
  /** 跳过或失败原因。 */
  message?: string;
}

type RawWd14Payload = {
  ok?: boolean;
  model?: unknown;
  tags?: unknown;
  elapsedMs?: unknown;
  providers?: unknown;
};

/** WD14 GPU Provider 客户端。 */
export class ImageReverseWd14Service {
  /** 调用标签接口；异常被转换为 failed，图片反推仍可降级到视觉链路。 */
  async tag(imageBuffer: Buffer, mimeType: string, config: ImageReverseWd14RuntimeConfig): Promise<ImageReverseWd14RunResult> {
    if (!config.enabled) return skippedResult(config, '后台未开启 WD14 Provider');
    if (!config.baseUrl || !config.apiKey) return skippedResult(config, 'WD14 Provider 配置不完整');
    const startedAt = Date.now();
    try {
      const form = new FormData();
      const uploadBytes = new Uint8Array(imageBuffer.length);
      uploadBytes.set(imageBuffer);
      form.append('file', new Blob([uploadBytes.buffer], { type: mimeType }), 'reverse-image.jpg');
      form.append('general_threshold', String(config.generalThreshold));
      form.append('character_threshold', String(config.characterThreshold));
      form.append('max_tags', String(config.maxTags));
      const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v1/tag`, {
        method: 'POST',
        headers: { 'x-api-key': config.apiKey },
        body: form,
        signal: AbortSignal.timeout(Math.max(5, config.timeoutSec) * 1000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(readProviderError(response.status, text));
      const payload = parsePayload(text);
      const tags = normalizeTags(payload.tags);
      if (!payload.ok || tags.length === 0) throw new Error('WD14 Provider 未返回有效标签');
      return {
        status: 'succeeded',
        model: readString(payload.model) || config.model,
        durationMs: Date.now() - startedAt,
        tags,
        providers: readStringArray(payload.providers, 8),
      };
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        status: 'failed',
        model: config.model,
        durationMs: Date.now() - startedAt,
        tags: [],
        providers: [],
        message: timeout ? 'WD14 Provider 请求超时' : readErrorMessage(error),
      };
    }
  }

  /** 管理后台健康检查；只返回模型状态，不返回密钥或完整上游响应。 */
  async health(config: ImageReverseWd14RuntimeConfig): Promise<ImageReverseWd14HealthResponse> {
    const base: Omit<ImageReverseWd14HealthResponse, 'upstream'> = {
      enabled: config.enabled,
      baseUrlConfigured: Boolean(config.baseUrl),
      apiKeyConfigured: Boolean(config.apiKey),
      model: config.model,
      generalThreshold: config.generalThreshold,
      characterThreshold: config.characterThreshold,
    };
    const checkedAt = new Date().toISOString();
    if (!config.baseUrl) return { ...base, upstream: { ok: false, checkedAt, error: '未配置 Provider 地址' } };
    try {
      const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/health`, { signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      if (!response.ok) return { ...base, upstream: { ok: false, statusCode: response.status, checkedAt, error: readProviderError(response.status, text) } };
      const body = JSON.parse(text) as { wd14?: Record<string, unknown> };
      const wd14 = body.wd14 ?? {};
      const runtimeError = readString(wd14.runtimeError);
      return {
        ...base,
        upstream: {
          ok: wd14.modelReady === true && wd14.tagsReady === true && !runtimeError,
          statusCode: response.status,
          modelReady: wd14.modelReady === true,
          tagsReady: wd14.tagsReady === true,
          loaded: wd14.loaded === true,
          activeProviders: readStringArray(wd14.activeProviders, 8),
          availableProviders: readStringArray(wd14.availableProviders, 8),
          runtimeVersion: readString(wd14.runtimeVersion) || undefined,
          checkedAt,
          error: runtimeError || undefined,
        },
      };
    } catch (error) {
      return { ...base, upstream: { ok: false, checkedAt, error: readErrorMessage(error) } };
    }
  }
}

function skippedResult(config: ImageReverseWd14RuntimeConfig, message: string): ImageReverseWd14RunResult {
  return { status: 'skipped', model: config.model, durationMs: 0, tags: [], providers: [], message };
}

function normalizeTags(value: unknown): ImageReverseWd14Tag[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ImageReverseWd14Tag[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = readString(record.name).toLowerCase().replace(/\s+/g, '_').slice(0, 120);
    const category = record.category === 'character' ? 'character' : record.category === 'general' ? 'general' : undefined;
    const confidence = Number(record.confidence);
    const key = `${category}:${name}`;
    if (!name || !category || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, category, confidence: Math.round(confidence * 1_000_000) / 1_000_000 });
  }
  return result.slice(0, 600);
}

function parsePayload(value: string): RawWd14Payload {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RawWd14Payload : {};
  } catch {
    throw new Error('WD14 Provider 返回不是合法 JSON');
  }
}

function readProviderError(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown };
    const message = readString(body.detail) || readString(body.message);
    if (message) return `WD14 Provider HTTP ${status}：${message.slice(0, 200)}`;
  } catch {
    // 非 JSON 错误只暴露状态码，避免把反代 HTML 写入任务记录。
  }
  return `WD14 Provider HTTP ${status}`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.map(readString).filter(Boolean).slice(0, max) : [];
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : 'WD14 Provider 请求失败';
}
