/**
 * 本文件实现缩略图生成服务，基于 Sharp 进行图片缩放和格式转换。
 * 当前生产只写入本地媒体目录，不提供对象存储回退。
 *
 * 约束：
 * - 缩略图默认宽度 512px，等比缩放
 * - 输入格式不限（PNG/JPEG/WebP），输出为中压缩 JPEG
 * - 缩略图文件名前缀为 thumb_
 * - 转换失败不阻断主流程，返回错误供调用方降级
 */
import type { IStorageService } from '../file-store/storage-factory.js';

/** 缩略图配置，可通过环境变量覆盖默认值。 */
type ThumbnailConfig = {
  /** 目标宽度像素，默认 512。 */
  width: number;
  /** 目标高度像素，不指定则等比缩放。 */
  height?: number;
  /** 输出质量 1-100，默认 75。 */
  quality: number;
  /** 缩略图写入本地存储的大小上限。 */
  maxFileSizeBytes?: number;
};

/** 默认缩略图配置：中压缩 JPEG，兼顾图库清晰度和带宽。 */
const DEFAULT_CONFIG: ThumbnailConfig = {
  width: Number(process.env.THUMBNAIL_WIDTH ?? '512'),
  quality: Number(process.env.THUMBNAIL_QUALITY ?? '75'),
};
/** 缩略图输出 MIME；当前统一使用 JPEG，避免 PNG 缩略图过大。 */
const THUMB_MIME = process.env.THUMBNAIL_MIME || 'image/jpeg';

/**
 * 缩略图生成服务，接受任意 IStorageService 实现。
 * 本地存储：直接读文件、sharp 缩放、写回本地文件。
 */
export class ThumbnailService {
  /** 注入存储服务；当前生产只允许本地文件存储实现。 */
  constructor(private readonly store: IStorageService) {}

  /**
   * 为指定图片生成缩略图。
   * @param sourceFilename 源文件名（writeImage 返回的短文件名）
   * @param config 缩略图配置，不传使用默认值
   * @returns 缩略图文件名
   */
  async generateThumbnail(
    sourceFilename: string,
    config: Partial<ThumbnailConfig> = {},
  ): Promise<{ filename: string }> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    // 读取源图；本地媒体文件是缩略图生成的唯一输入。
    const { stream: sourceStream } = await this.store.readImage(sourceFilename);
    const chunks: Buffer[] = [];
    for await (const chunk of sourceStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    }
    const sourceBuffer = Buffer.concat(chunks);

    // 使用 Sharp 进行缩放（ESM 动态 import，兼容 sharp 的 CJS/ESM 差异）
    let sharpFn: any;
    try {
      const mod = await import('sharp');
      sharpFn = (mod as { default?: unknown }).default ?? mod;
    } catch {
      throw new Error('Sharp 未安装或不可用，无法生成缩略图');
    }

    const sharpInstance = sharpFn(sourceBuffer);
    const metadata = await sharpInstance.metadata();

    // 计算目标尺寸（等比缩放，不放大）
    const targetWidth = Number(cfg.width) || 400;
    const rawH = metadata.height && metadata.width
      ? Math.round(targetWidth * Number(metadata.height) / Number(metadata.width))
      : undefined;
    const targetHeight = cfg.height ? Number(cfg.height) : (rawH && rawH > 0 && !isNaN(rawH) ? rawH : undefined);

    const thumbnailBuffer = await sharpInstance
      .resize(targetWidth, targetHeight, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: cfg.quality, progressive: true })
      .toBuffer();

    // 写入缩略图；缩略图作为本地媒体文件独立保存。
    const filename = await this.store.writeImage(thumbnailBuffer, THUMB_MIME, 'thumb_', { maxFileSizeBytes: cfg.maxFileSizeBytes });

    return { filename };
  }

  /**
   * 批量生成缩略图，返回成功和失败结果。
   */
  async generateThumbnails(
    sourceFilenames: string[],
    config?: Partial<ThumbnailConfig>,
  ): Promise<{ succeeded: { filename: string }[]; failed: string[] }> {
    const succeeded: { filename: string }[] = [];
    const failed: string[] = [];

    for (const sourceFilename of sourceFilenames) {
      try {
        const result = await this.generateThumbnail(sourceFilename, config);
        succeeded.push(result);
      } catch {
        failed.push(sourceFilename);
      }
    }

    return { succeeded, failed };
  }
}
