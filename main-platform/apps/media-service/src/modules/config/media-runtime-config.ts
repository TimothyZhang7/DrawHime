/** 本文件负责 media-service 从 backend 拉取后台媒体运行时配置，并提供本地兜底。 */
import type { MediaRuntimeConfigResponse } from '@aiimage/shared-contracts';

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
const SERVICE_TOKEN = process.env.WS_PROXY_TOKEN ?? '';
const CACHE_TTL_MS = 60_000;
const MB = 1024 * 1024;

let cachedConfig: MediaRuntimeConfigResponse | null = null;
let cachedAt = 0;

/** 读取 media-service 运行时配置；backend 不可用时使用环境变量兜底，保证上传链路不中断。 */
export async function getMediaRuntimeConfig(): Promise<MediaRuntimeConfigResponse> {
  if (cachedConfig && Date.now() - cachedAt < CACHE_TTL_MS) return cachedConfig;
  try {
    const response = await fetch(`${BACKEND_URL}/internal/media-config`, {
      headers: { 'x-service-token': SERVICE_TOKEN },
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; data?: Partial<MediaRuntimeConfigResponse> };
    if (response.ok && body.ok === true && body.data) {
      cachedConfig = normalizeMediaConfig(body.data);
      cachedAt = Date.now();
      return cachedConfig;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[media-service] 读取 backend 媒体配置失败，使用本地兜底：${message}`);
  }
  cachedConfig = readFallbackConfig();
  cachedAt = Date.now();
  return cachedConfig;
}

/** 校验 backend 下发配置，避免异常值直接影响图片解码和本地写入。 */
function normalizeMediaConfig(input: Partial<MediaRuntimeConfigResponse>): MediaRuntimeConfigResponse {
  return {
    thumbnailWidth: clampInt(input.thumbnailWidth, 400, 64, 2048),
    thumbnailQuality: clampInt(input.thumbnailQuality, 80, 30, 95),
    imageMaxFileSizeBytes: clampInt(input.imageMaxFileSizeBytes, 20 * MB, 1 * MB, 100 * MB),
    imageMaxResolution: clampInt(input.imageMaxResolution, 8192, 512, 16384),
    referenceTaskInputMaxBytes: clampInt(input.referenceTaskInputMaxBytes, 3 * MB, 64 * 1024, 20 * MB),
  };
}

/** backend 配置读取失败时的环境变量兜底，仍保留合理边界。 */
function readFallbackConfig(): MediaRuntimeConfigResponse {
  return normalizeMediaConfig({
    thumbnailWidth: Number(process.env.THUMBNAIL_WIDTH ?? '400'),
    thumbnailQuality: Number(process.env.THUMBNAIL_QUALITY ?? '80'),
    imageMaxFileSizeBytes: Number(process.env.IMAGE_MAX_FILE_SIZE_MB ?? '20') * MB,
    imageMaxResolution: Number(process.env.IMAGE_MAX_RESOLUTION ?? '8192'),
    referenceTaskInputMaxBytes: Number(process.env.REFERENCE_TASK_INPUT_MAX_BYTES ?? String(3 * MB)),
  });
}

/** 将运行时配置限制在安全整数范围内。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(Math.min(max, Math.max(min, numeric)));
}
