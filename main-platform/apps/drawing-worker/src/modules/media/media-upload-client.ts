/**
 * 本文件封装 drawing-worker 到 media-service 的文件链路调用。
 *
 * drawing-worker 只负责把真实图片字节交给 media-service；图片格式校验、压缩和本地落盘
 * 仍由 media-service 统一执行，避免 worker 侧出现第二套存储规则。
 */

/** media-service 上传响应数据。 */
export type MediaUploadResult = {
  /** media-service 生成的安全短文件名。 */
  filename: string;
  /** 写入后的字节数；参考图是任务输入版大小，生成图是原图大小。 */
  size?: number;
  /** 原始上传字节数。 */
  originalSize?: number;
  /** 是否由 media-service 做过压缩或格式转换。 */
  compressed?: boolean;
  /** media-service 校验后的真实 MIME。 */
  mimeType?: string;
  /** 视频上传时由 media-service 同步生成的首帧封面文件名。 */
  thumbnailFilename?: string;
};

/** 上传图片到 media-service 的参数。 */
export type UploadMediaImageInput = {
  /** 图片二进制。 */
  buffer: Buffer;
  /** 调用方收到的 MIME；media-service 会按真实内容重新校验。 */
  mimeType: string;
  /** 写入文件名前缀，例如 img_ 或 ref_。 */
  prefix: string;
  /** 可选压缩上限；最终生成原图不得传该值。 */
  maxBytes?: number;
  /** 请求超时毫秒。 */
  timeoutMs?: number;
};

/** 视频原样上传参数。 */
export type UploadMediaVideoInput = {
  /** 已校验的 MP4 字节。 */
  buffer: Buffer;
  /** 请求超时毫秒。 */
  timeoutMs?: number;
};

/** 外部图片下载参数。 */
export type DownloadImageWithLimitInput = {
  /** 图片 URL。 */
  url: string;
  /** 请求头。 */
  headers?: Record<string, string>;
  /** 最大允许字节数。 */
  maxBytes: number;
  /** 下载超时毫秒。 */
  timeoutMs: number;
};

const MEDIA_URL = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
const SERVICE_TOKEN = process.env.WS_PROXY_TOKEN ?? '';

/** 二进制直传图片到 media-service，避免 base64 JSON 膨胀和额外内存复制。 */
export async function uploadMediaImage(input: UploadMediaImageInput): Promise<MediaUploadResult> {
  if (input.buffer.length <= 0) throw new Error('缺少图片数据');
  const response = await fetch(`${MEDIA_URL}/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': normalizeImageMimeType(input.mimeType),
      'x-service-token': SERVICE_TOKEN,
      'x-aiimage-prefix': input.prefix,
      ...(input.maxBytes ? { 'x-aiimage-max-bytes': String(input.maxBytes) } : {}),
    },
    body: new Uint8Array(input.buffer),
    signal: AbortSignal.timeout(input.timeoutMs ?? 30000),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    message?: string;
    data?: Partial<MediaUploadResult>;
  };
  if (!response.ok || body.ok !== true || !body.data?.filename) {
    throw new Error(body.message || `media-service 上传失败：HTTP ${response.status}`);
  }
  return {
    filename: body.data.filename,
    size: body.data.size,
    originalSize: body.data.originalSize,
    compressed: body.data.compressed,
    mimeType: body.data.mimeType,
  };
}

/** 二进制直传 MP4 到 media-service，视频不得进入图片压缩链路。 */
export async function uploadMediaVideo(input: UploadMediaVideoInput): Promise<MediaUploadResult> {
  if (input.buffer.length < 12 || input.buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error('缺少有效 MP4 视频数据');
  }
  const response = await fetch(`${MEDIA_URL}/media/upload-video`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-service-token': SERVICE_TOKEN },
    body: new Uint8Array(input.buffer),
    signal: AbortSignal.timeout(input.timeoutMs ?? 60000),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string; data?: Partial<MediaUploadResult> };
  if (!response.ok || body.ok !== true || !body.data?.filename) {
    throw new Error(body.message || `media-service 视频上传失败：HTTP ${response.status}`);
  }
  return {
    filename: body.data.filename,
    size: body.data.size,
    mimeType: body.data.mimeType,
    thumbnailFilename: body.data.thumbnailFilename,
  };
}

/** 下载外部图片并按 content-length 和最终字节数双重限流，避免异常外链撑爆 worker 内存。 */
export async function downloadImageWithLimit(input: DownloadImageWithLimitInput): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetch(input.url, {
    headers: input.headers ?? {},
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > input.maxBytes) throw new Error(`图片超过下载上限：${declaredLength}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length <= 0 || buffer.length > input.maxBytes) throw new Error(`图片超过下载上限：${buffer.length}`);
  return {
    buffer,
    mimeType: normalizeImageMimeType(response.headers.get('content-type') ?? detectImageMimeType(buffer) ?? 'image/png'),
  };
}

/** 把 MIME 规范化到项目支持的三种图片类型；非法值交给 media-service 真实内容校验兜底。 */
function normalizeImageMimeType(value: string): string {
  const mimeType = String(value || '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'image/jpeg';
  if (mimeType === 'image/webp') return 'image/webp';
  return 'image/png';
}

/** 根据文件魔数推断 MIME，用于外部响应头缺失或错误时的兜底。 */
function detectImageMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
