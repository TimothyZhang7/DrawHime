/**
 * 本文件封装上游图片调用需要的图片工具。
 * 包括参考图读取、图片格式校验和 MIME 到文件扩展名映射。
 */
import { downloadImageWithLimit } from '../media/media-upload-client.js';
import sharp from 'sharp';

/** worker 下载参考图或上游 URL 图片的硬上限；media-service 最终也会拒绝超过 20MB 的原图。 */
export const MAX_IMAGE_DOWNLOAD_BYTES = Number(process.env.WORKER_IMAGE_DOWNLOAD_MAX_BYTES ?? String(20 * 1024 * 1024));

/** 允许进入统一 PNG 转换链路的参考图 MIME。 */
const ALLOWED_IMAGE_FORMATS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/tiff', 'image/svg+xml'] as const;
/** Worker 向上游发送的单张 PNG 默认大小上限，与 media-service 参考图任务输入保持一致。 */
const MAX_REFERENCE_PNG_BYTES = Number(process.env.REFERENCE_TASK_INPUT_MAX_BYTES ?? String(3 * 1024 * 1024));
/** Worker 解码参考图最大像素，避免外部小体积超大尺寸图片耗尽内存。 */
const MAX_REFERENCE_INPUT_PIXELS = Number(process.env.MEDIA_REFERENCE_MAX_INPUT_PIXELS ?? '60000000');

/** MIME → 文件扩展名映射，确保外部 API 能通过扩展名正确识别格式。 */
export function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  return '.png';
}

/** 下载或解码参考图，支持 base64、HTTP(S) URL、media-service 短文件名和 /images/ 路径。 */
export async function fetchSourceImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+)(?:;[a-zA-Z0-9_-]+=[^;,]*)*;base64,(.+)$/);
    if (match) {
      const mimeType = match[1].toLowerCase();
      if (!ALLOWED_IMAGE_FORMATS.includes(mimeType as typeof ALLOWED_IMAGE_FORMATS[number])) {
        throw new Error(`不支持的参考图格式: ${mimeType}`);
      }
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > MAX_IMAGE_DOWNLOAD_BYTES) throw new Error('参考图超过允许大小');
      return normalizeReferenceImageToPng(buffer);
    }
    throw new Error('无效的 data URL 格式');
  }

  const MEDIA_URL = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('/images/')) {
    return downloadMediaServiceImage(`${MEDIA_URL}/media/files/${encodeURIComponent(url)}`);
  }

  if (url.startsWith('/images/')) {
    const filename = url.replace('/images/', '');
    return downloadMediaServiceImage(`${MEDIA_URL}/media/files/${encodeURIComponent(filename)}`);
  }

  const image = await downloadImageWithLimit({
    url,
    maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
    timeoutMs: 30000,
  });
  return normalizeDownloadedImage(image.buffer, image.mimeType);
}

/** 从 media-service 下载内部图片，必须带服务 token。 */
async function downloadMediaServiceImage(downloadUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
  const image = await downloadImageWithLimit({
    url: downloadUrl,
    headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
    maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
    timeoutMs: 30000,
  });
  return normalizeDownloadedImage(image.buffer, image.mimeType);
}

/** 下载结果统一解码为静态 PNG；声明 MIME 仅用于日志，上游参数固定使用 image/png。 */
async function normalizeDownloadedImage(buffer: Buffer, _mimeType: string): Promise<{ buffer: Buffer; contentType: string }> {
  return normalizeReferenceImageToPng(buffer);
}

/** 校验并把一张参考图转换为上游稳定支持的 PNG，动图只读取首帧。 */
async function normalizeReferenceImageToPng(buffer: Buffer): Promise<{ buffer: Buffer; contentType: string }> {
  if (buffer.length <= 0) throw new Error('参考图数据损坏或格式无效');
  let metadata: { format?: string; width?: number; height?: number; pageHeight?: number; orientation?: number };
  try {
    metadata = await createReferenceSharp(buffer).metadata();
  } catch {
    throw new Error('参考图数据损坏或格式无效');
  }
  if (!['png', 'jpeg', 'webp', 'gif', 'heif', 'avif', 'tiff', 'svg'].includes(String(metadata.format ?? ''))) {
    throw new Error(`不支持的参考图格式: ${metadata.format ?? 'unknown'}`);
  }
  const rawWidth = Math.max(0, Number(metadata.width ?? 0));
  const rawHeight = Math.max(0, Number(metadata.pageHeight ?? metadata.height ?? 0));
  if (!rawWidth || !rawHeight || rawWidth * rawHeight > MAX_REFERENCE_INPUT_PIXELS) {
    throw new Error('参考图分辨率过大或尺寸无效');
  }
  // 已经由 media-service 规范化的小 PNG 直接复用，减少每次上游重试前的重复编码。
  if (metadata.format === 'png' && buffer.length <= MAX_REFERENCE_PNG_BYTES) {
    return { buffer, contentType: 'image/png' };
  }

  const swapsDimensions = [5, 6, 7, 8].includes(Number(metadata.orientation ?? 1));
  const sourceWidth = swapsDimensions ? rawHeight : rawWidth;
  const sourceHeight = swapsDimensions ? rawWidth : rawHeight;
  let smallest: Buffer | undefined;
  for (const scale of [1, 0.85, 0.7, 0.55, 0.42, 0.32, 0.24]) {
    const width = Math.max(256, Math.round(sourceWidth * scale));
    const height = Math.max(256, Math.round(sourceHeight * scale));
    for (const colors of [undefined, 256, 128] as const) {
      const image = createReferenceSharp(buffer)
        .rotate()
        .resize(width, height, { fit: 'inside', withoutEnlargement: true });
      const candidate = await image.png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        effort: 8,
        ...(colors ? { palette: true, colors, dither: 0.7 } : {}),
      }).toBuffer();
      if (!smallest || candidate.length < smallest.length) smallest = candidate;
      if (candidate.length <= MAX_REFERENCE_PNG_BYTES) return { buffer: candidate, contentType: 'image/png' };
    }
  }
  if (!smallest || smallest.length > MAX_REFERENCE_PNG_BYTES) throw new Error('参考图转换为 PNG 后仍超过允许大小');
  return { buffer: smallest, contentType: 'image/png' };
}

/** 创建只读取首帧且带像素上限的 Sharp 实例。 */
function createReferenceSharp(buffer: Buffer) {
  return sharp(buffer, { limitInputPixels: MAX_REFERENCE_INPUT_PIXELS, page: 0, pages: 1, failOn: 'error' });
}
