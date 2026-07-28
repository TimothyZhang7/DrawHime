/** 本文件实现浏览器端图片格式转换、尺寸缩放和目标体积压缩，不向服务器上传图片。 */

/** 工具支持的输出图片格式。 */
export type ImageOutputFormat = 'webp' | 'jpeg' | 'png';

/** 单张图片转换选项。 */
export interface ImageConvertOptions {
  /** 输出格式。 */
  format: ImageOutputFormat;
  /** JPEG/WebP 编码质量，范围 1-100。 */
  quality: number;
  /** 输出最长边；为空时保持原尺寸。 */
  maxEdge?: number;
  /** JPEG/WebP 目标最大体积；为空时不按体积搜索质量。 */
  targetBytes?: number;
}

/** 单张图片转换结果。 */
export interface ImageConvertResult {
  /** 转换后的二进制。 */
  blob: Blob;
  /** 安全的下载文件名。 */
  filename: string;
  /** 输出宽度。 */
  width: number;
  /** 输出高度。 */
  height: number;
  /** 实际使用的编码质量；PNG 没有该值。 */
  quality?: number;
  /** 设置目标体积后是否达到目标。 */
  targetReached?: boolean;
}

const MAX_INPUT_PIXELS = 64_000_000;
const MIN_LOSSY_QUALITY = 0.1;

/** 转换一张浏览器可解码的静态图片，并返回可直接下载的 Blob。 */
export async function convertImageFile(file: File, options: ImageConvertOptions): Promise<ImageConvertResult> {
  const decoded = await decodeImage(file);
  try {
    if (decoded.width * decoded.height > MAX_INPUT_PIXELS) {
      throw new Error('图片像素过大，请先缩小到 6400 万像素以内。');
    }
    const size = calculateOutputSize(decoded.width, decoded.height, options.maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d', { alpha: options.format !== 'jpeg' });
    if (!context) throw new Error('当前浏览器未提供图片画布能力。');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (options.format === 'jpeg') {
      // JPEG 不支持透明通道，先铺白底，避免透明区域被编码成黑色。
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, size.width, size.height);
    }
    context.drawImage(decoded.source, 0, 0, size.width, size.height);

    const mimeType = getOutputMimeType(options.format);
    const extension = options.format === 'jpeg' ? 'jpg' : options.format;
    const filename = `${buildSafeBaseName(file.name)}_converted.${extension}`;
    if (options.format === 'png') {
      return {
        blob: await canvasToBlob(canvas, mimeType),
        filename,
        width: size.width,
        height: size.height,
      };
    }

    const maximumQuality = clamp(options.quality / 100, MIN_LOSSY_QUALITY, 1);
    const targetBytes = options.targetBytes && options.targetBytes > 0 ? options.targetBytes : undefined;
    if (!targetBytes) {
      return {
        blob: await canvasToBlob(canvas, mimeType, maximumQuality),
        filename,
        width: size.width,
        height: size.height,
        quality: Math.round(maximumQuality * 100),
      };
    }

    const compressed = await encodeToTargetSize(canvas, mimeType, maximumQuality, targetBytes);
    return {
      blob: compressed.blob,
      filename,
      width: size.width,
      height: size.height,
      quality: Math.round(compressed.quality * 100),
      targetReached: compressed.blob.size <= targetBytes,
    };
  } finally {
    decoded.release();
  }
}

/** 判断文件是否属于工具明确支持的静态图片格式。 */
export function isSupportedImageFile(file: File): boolean {
  const mimeType = file.type.toLowerCase();
  if (['image/png', 'image/jpeg', 'image/webp', 'image/bmp'].includes(mimeType)) return true;
  return /\.(png|jpe?g|webp|bmp)$/i.test(file.name);
}

/** 触发浏览器下载 Blob。 */
export function downloadImageBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 构造不含路径字符的安全文件名主体。 */
export function buildSafeBaseName(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return withoutExtension.replace(/[\\/:*?\"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'image';
}

/** 按目标体积搜索尽可能高的可用质量，搜索失败时返回最低质量的真实编码结果。 */
async function encodeToTargetSize(canvas: HTMLCanvasElement, mimeType: string, maximumQuality: number, targetBytes: number) {
  const maximumBlob = await canvasToBlob(canvas, mimeType, maximumQuality);
  if (maximumBlob.size <= targetBytes) return { blob: maximumBlob, quality: maximumQuality };

  const minimumBlob = await canvasToBlob(canvas, mimeType, MIN_LOSSY_QUALITY);
  if (minimumBlob.size > targetBytes) return { blob: minimumBlob, quality: MIN_LOSSY_QUALITY };

  let low = MIN_LOSSY_QUALITY;
  let high = maximumQuality;
  let best = { blob: minimumBlob, quality: MIN_LOSSY_QUALITY };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const quality = (low + high) / 2;
    const blob = await canvasToBlob(canvas, mimeType, quality);
    if (blob.size <= targetBytes) {
      best = { blob, quality };
      low = quality;
    } else {
      high = quality;
    }
  }
  return best;
}

/** 计算等比缩放后的整数尺寸，禁止放大原图。 */
function calculateOutputSize(width: number, height: number, maxEdge?: number) {
  const longest = Math.max(width, height);
  if (!maxEdge || maxEdge >= longest) return { width, height };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** 解码图片；优先使用 ImageBitmap 自动校正 EXIF 方向，并保留兼容回退。 */
async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('当前浏览器读取该图片失败。'));
      element.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** 把画布异步编码为图片 Blob。 */
function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('浏览器图片编码失败，请尝试其他输出格式。'));
    }, mimeType, quality);
  });
}

/** 映射输出格式到标准 MIME。 */
function getOutputMimeType(format: ImageOutputFormat): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  return 'image/webp';
}

/** 将数值限制在给定闭区间。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
