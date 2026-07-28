/** 本文件负责把图片放大结果保存为用户“我的图片”记录，统一复用 media-service 和生成任务图库链路。 */
import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ImageUpscaleRunResponse, ImageUpscaleSavedTaskView } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { invalidateGalleryCache, invalidateImageCache, invalidateTaskCache } from '../../shared/cache/cache-service.js';
import { GalleryTaggingService } from '../gallery/gallery-tagging-service.js';
import { downloadGpuResultUrl, ImageUpscaleError } from './image-upscale-service.js';
import { logger } from '../../shared/logger.js';

const MEDIA_URL = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
const UPSCALE_SOURCE_REFERENCE_MAX_BYTES = Number(process.env.REFERENCE_TASK_INPUT_MAX_BYTES ?? String(3 * 1024 * 1024));
/** 暂存结果后台保存最多重试次数；local GPU 服务偶发连接抖动时不直接丢失图库写入。 */
const REMOTE_RESULT_DOWNLOAD_ATTEMPTS = 3;
/** 单次暂存结果下载无活动超时；使用 Node 原生 IPv4 下载，避开 undici 连接悬挂。 */
const REMOTE_RESULT_DOWNLOAD_TIMEOUT_MS = 120_000;
/** 放大结果保存最大字节数。 */
const REMOTE_RESULT_MAX_BYTES = 220 * 1024 * 1024;

type MediaUploadResponse = {
  ok?: boolean;
  message?: string;
  data?: {
    filename?: string;
    url?: string;
    size?: number;
    originalSize?: number;
    compressed?: boolean;
    mimeType?: string;
  };
};

type ThumbnailResponse = {
  ok?: boolean;
  message?: string;
  data?: {
    filename?: string;
  };
};

/** 保存图片放大结果的输入。 */
export type SaveImageUpscaleResultInput = {
  /** 当前登录用户 ID。 */
  userId: number;
  /** 图片放大接口已经生成的响应体。 */
  result: ImageUpscaleRunResponse;
  /** 输出图片二进制。 */
  imageBuffer: Buffer;
  /** 输出图片 MIME。 */
  mimeType: string;
  /** 放大前原图二进制；用于图库详情页展示“放大前原图”。 */
  sourceImageBuffer?: Buffer;
  /** 放大前原图 MIME。 */
  sourceMimeType?: string;
  /** 可选隐私覆盖；不传时读取用户默认隐私设置。 */
  isPrivate?: boolean;
  /** 图片放大任务 ID；用于生产排障日志串联。 */
  traceId?: string;
};

/** 图片放大结果保存服务；外部 HTTP 在事务前完成，数据库只做短事务最终写入。 */
export class ImageUpscaleLibraryService {
  private readonly prisma: PrismaClient = getPrismaClient();
  private readonly galleryTaggingService = new GalleryTaggingService();

  /** 保存放大结果并返回可跳转的任务摘要；不处理扣费，也不写钱包流水。 */
  async saveResult(input: SaveImageUpscaleResultInput): Promise<ImageUpscaleSavedTaskView> {
    const saveStartedAt = Date.now();
    const isPrivate = input.isPrivate ?? await this.readUserDefaultPrivacy(input.userId);
    const taskId = createUpscaleTaskId(input.traceId);
    // 放大任务重试保存时先复用已经完整落库的图库任务，避免网络中断后生成重复作品。
    const existing = await this.findExistingSavedTask(taskId, input.userId);
    if (existing) return existing;
    const uploadStartedAt = Date.now();
    const image = await uploadImageToMedia(input.imageBuffer, input.mimeType);
    const uploadMs = Date.now() - uploadStartedAt;
    const thumbnailStartedAt = Date.now();
    const thumbnail = await generateThumbnail(image.filename);
    const thumbnailMs = Date.now() - thumbnailStartedAt;
    const referenceStartedAt = Date.now();
    const sourceReference = input.sourceImageBuffer?.length
      ? await uploadSourceReferenceToMedia(input.sourceImageBuffer, input.sourceMimeType ?? input.mimeType)
      : undefined;
    const referenceMs = Date.now() - referenceStartedAt;
    const sourceReferenceUrl = sourceReference ? `/images/${sourceReference.filename}` : undefined;
    const now = new Date();
    const prompt = buildUpscalePrompt(input.result);
    const imageConfigValue = JSON.stringify({
      imageFilename: image.filename,
      thumbnailFilename: thumbnail.filename,
      size: `${input.result.image.width}x${input.result.image.height}`,
      quality: 'upscale',
      storage: 'local',
      storedAt: now.toISOString(),
    });
    const paramsValue = JSON.stringify({
      tool: 'image-upscale',
      model: input.result.model,
      scale: input.result.scale,
      // 图片放大输出已固定为 WebP，图库参数也保持同一口径，避免旧 PNG 配置继续外显。
      outputFormat: 'webp',
      sourceWidth: input.result.source.width,
      sourceHeight: input.result.source.height,
      outputWidth: input.result.image.width,
      outputHeight: input.result.image.height,
      sourceBytes: input.result.source.sizeBytes,
      outputBytes: input.result.image.sizeBytes,
      elapsedMs: input.result.elapsedMs,
      sourceReferenceUrl,
      sourceReferenceFilename: sourceReference?.filename,
    });

    const dbStartedAt = Date.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.generationTask.create({
        data: {
          id: taskId,
          clientRequestId: taskId,
          userId: input.userId,
          source: 'web',
          mode: 'image-to-image',
          prompt,
          sourceImageUrls: sourceReferenceUrl ? [sourceReferenceUrl] : Prisma.JsonNull,
          isPrivate,
          status: 'success',
          startedAt: now,
          finishedAt: now,
          subTasks: {
            create: [
              {
                sequence: 1,
                kind: 'request_received',
                status: 'success',
                startedAt: now,
                finishedAt: now,
              },
              {
                sequence: 2,
                kind: 'upstream_attempt',
                status: 'success',
                attemptNo: 1,
                siteName: '本地 GPU 放大',
                model: input.result.model.slice(0, 96),
                latencyMs: input.result.elapsedMs,
                startedAt: new Date(Math.max(0, now.getTime() - input.result.elapsedMs)),
                finishedAt: now,
              },
              {
                sequence: 3,
                kind: 'image_saved',
                status: 'success',
                finishedAt: now,
              },
              {
                sequence: 4,
                kind: 'finalize',
                status: 'success',
                finishedAt: now,
              },
            ],
          },
        },
      });
      // 任务图片和参数快照必须与主任务同事务写入，避免成功任务没有最终图或参数审计缺失。
      await tx.systemConfig.create({ data: { key: `task_image_${taskId}`, value: imageConfigValue } });
      await tx.systemConfig.create({ data: { key: `task_generation_params_${taskId}`, value: paramsValue } });
      if (sourceReference) {
        // 参考图归档快照必须与主任务同事务写入，详情页才能稳定展示放大前原图。
        await tx.systemConfig.create({ data: { key: `task_ref_images_${taskId}`, value: JSON.stringify([sourceReference.filename]) } });
      }
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
    const dbMs = Date.now() - dbStartedAt;

    invalidateTaskCache([taskId], [`task-list:user:${input.userId}`]);
    invalidateImageCache(taskId);
    invalidateImageCache(image.filename);
    // 图片放大保存为公开作品时只软失效图库首屏，保护图库高频浏览路径。
    if (!isPrivate) invalidateGalleryCache([`image:${taskId}`], { soft: true });
    // 自动打标是旁路增强能力；失败不能影响保存成功。
    await this.galleryTaggingService.enqueueTask(taskId).catch(() => undefined);
    logger.info({
      traceId: input.traceId,
      taskId,
      userId: input.userId,
      uploadMs,
      thumbnailMs,
      referenceMs,
      dbMs,
      totalMs: Date.now() - saveStartedAt,
      outputBytes: input.imageBuffer.length,
    }, '图片放大保存图库耗时');

    return {
      id: taskId,
      detailPath: `/personal/generations/${taskId}`,
      imageDetailPath: `/image/${taskId}`,
      imageUrl: `/images/${image.filename}`,
      thumbnailUrl: thumbnail.filename ? `/images/${thumbnail.filename}` : undefined,
      isPrivate,
      savedAt: now.toISOString(),
    };
  }

  /** 从 GPU 本机暂存或对象存储 URL 拉取结果图后保存；用于避免用户等待主站同步落库。 */
  async saveResultFromUrl(input: Omit<SaveImageUpscaleResultInput, 'imageBuffer' | 'mimeType'> & { imageUrl: string; mimeType?: string }): Promise<ImageUpscaleSavedTaskView> {
    const downloaded = await downloadRemoteImage(input.imageUrl, input.mimeType);
    return await this.saveResult({
      ...input,
      imageBuffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
    });
  }

  /** 读取用户默认隐私；缺失用户按私密保存，避免异常账号结果意外公开。 */
  private async readUserDefaultPrivacy(userId: number): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { defaultImagePrivate: true },
    });
    return user?.defaultImagePrivate ?? true;
  }

  /** 查询同一放大任务已经保存的完整图库记录；仅复用当前用户且存在真实图片配置的任务。 */
  private async findExistingSavedTask(taskId: string, userId: number): Promise<ImageUpscaleSavedTaskView | undefined> {
    const [task, imageConfig] = await Promise.all([
      this.prisma.generationTask.findFirst({
        where: { id: taskId, userId, status: 'success' },
        select: { id: true, isPrivate: true, createdAt: true },
      }),
      this.prisma.systemConfig.findUnique({ where: { key: `task_image_${taskId}` }, select: { value: true } }),
    ]);
    if (!task || !imageConfig) return undefined;
    try {
      const parsed = JSON.parse(imageConfig.value) as { imageFilename?: unknown; thumbnailFilename?: unknown; storedAt?: unknown };
      const imageFilename = typeof parsed.imageFilename === 'string' && isSafeMediaFilename(parsed.imageFilename) ? parsed.imageFilename : '';
      const thumbnailFilename = typeof parsed.thumbnailFilename === 'string' && isSafeMediaFilename(parsed.thumbnailFilename) ? parsed.thumbnailFilename : '';
      if (!imageFilename) return undefined;
      const storedAt = typeof parsed.storedAt === 'string' && Number.isFinite(Date.parse(parsed.storedAt))
        ? new Date(parsed.storedAt).toISOString()
        : task.createdAt.toISOString();
      return {
        id: task.id,
        detailPath: `/personal/generations/${task.id}`,
        imageDetailPath: `/image/${task.id}`,
        imageUrl: `/images/${imageFilename}`,
        thumbnailUrl: thumbnailFilename ? `/images/${thumbnailFilename}` : undefined,
        isPrivate: task.isPrivate,
        savedAt: storedAt,
      };
    } catch {
      return undefined;
    }
  }
}

/** 下载受信任 GPU 返回的结果图，设置大小和类型上限，避免后台保存被异常远端拖垮。 */
async function downloadRemoteImage(url: string, fallbackMimeType?: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ImageUpscaleError('library_download_failed', '图片放大结果地址协议不支持', 502);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= REMOTE_RESULT_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const downloaded = await downloadGpuResultUrl(parsed.href, {
        maxBytes: REMOTE_RESULT_MAX_BYTES,
        timeoutMs: REMOTE_RESULT_DOWNLOAD_TIMEOUT_MS,
      });
      if (downloaded.statusCode < 200 || downloaded.statusCode >= 300) {
        throw new ImageUpscaleError('library_download_failed', `图片放大结果下载失败：HTTP ${downloaded.statusCode}`, 502);
      }
      if (downloaded.buffer.length <= 0) throw new ImageUpscaleError('library_download_failed', '图片放大结果大小异常', 502);
      const mimeType = normalizeImageMimeType(downloaded.contentType || fallbackMimeType || 'image/png');
      return { buffer: downloaded.buffer, mimeType };
    } catch (error) {
      lastError = error;
      if (attempt < REMOTE_RESULT_DOWNLOAD_ATTEMPTS) await delay(2_000 * attempt);
    }
  }
  const message = lastError instanceof Error ? lastError.message : '未知下载错误';
  throw new ImageUpscaleError('library_download_failed', `图片放大结果下载失败：${message}`, 502);
}

/** 后台保存重试等待；不占用绘图队列或数据库事务。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把输出图写入 media-service，最终图使用 img_ 前缀且不额外压缩。 */
async function uploadImageToMedia(imageBuffer: Buffer, mimeType: string): Promise<{ filename: string }> {
  const response = await fetch(`${MEDIA_URL}/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': normalizeImageMimeType(mimeType),
      'x-service-token': process.env.WS_PROXY_TOKEN?.trim() ?? '',
      'x-aiimage-prefix': 'img_',
    },
    body: new Uint8Array(imageBuffer),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({})) as MediaUploadResponse;
  const filename = payload.data?.filename;
  if (!response.ok || payload.ok !== true || !filename || !isSafeMediaFilename(filename)) {
    throw new ImageUpscaleError('library_upload_failed', payload.message || '图片放大结果保存失败', response.status >= 500 ? 502 : 400);
  }
  return { filename };
}

/** 把放大前原图作为参考图写入 media-service；参考图允许被压缩，避免图库详情页引用过大的原始上传文件。 */
async function uploadSourceReferenceToMedia(imageBuffer: Buffer, mimeType: string): Promise<{ filename: string }> {
  const response = await fetch(`${MEDIA_URL}/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': normalizeImageMimeType(mimeType),
      'x-service-token': process.env.WS_PROXY_TOKEN?.trim() ?? '',
      'x-aiimage-prefix': 'ref_',
      'x-aiimage-max-bytes': String(UPSCALE_SOURCE_REFERENCE_MAX_BYTES),
    },
    body: new Uint8Array(imageBuffer),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({})) as MediaUploadResponse;
  const filename = payload.data?.filename;
  if (!response.ok || payload.ok !== true || !filename || !isSafeMediaFilename(filename)) {
    throw new ImageUpscaleError('library_reference_upload_failed', payload.message || '图片放大原图保存失败', response.status >= 500 ? 502 : 400);
  }
  return { filename };
}

/** 为已保存原图生成缩略图；缩略图失败会阻止写入任务，避免图库卡片长期空缩略图。 */
async function generateThumbnail(sourceFilename: string): Promise<{ filename: string }> {
  const response = await fetch(`${MEDIA_URL}/media/generate-thumbnail`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-service-token': process.env.WS_PROXY_TOKEN?.trim() ?? '',
    },
    body: JSON.stringify({ sourceFilename, width: 512, quality: 78 }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({})) as ThumbnailResponse;
  const filename = payload.data?.filename;
  if (!response.ok || payload.ok !== true || !filename || !isSafeMediaFilename(filename)) {
    throw new ImageUpscaleError('library_thumbnail_failed', payload.message || '图片放大缩略图生成失败', response.status >= 500 ? 502 : 400);
  }
  return { filename };
}

/** 生成符合现有任务 ID 识别规则的短 ID。 */
function createUpscaleTaskId(traceId?: string): string {
  const normalizedTraceId = String(traceId ?? '').trim();
  if (/^up_[a-z0-9_]{1,56}$/i.test(normalizedTraceId)) return `w_${normalizedTraceId}`.slice(0, 64);
  const ts36 = Date.now().toString(36);
  const suffix = randomBytes(4).toString('hex');
  return `w_${ts36}_${suffix}`.slice(0, 64);
}

/** 构造任务提示词快照；用于详情审计和后续 AI 标题/标签辅助判断，不替换图片内容。 */
function buildUpscalePrompt(result: ImageUpscaleRunResponse): string {
  return [
    `图片放大 ${result.scale}x`,
    `模型 ${result.model}`,
    `${result.source.width}x${result.source.height} 到 ${result.image.width}x${result.image.height}`,
  ].join(' · ');
}

/** 保存到媒体服务前收敛 MIME，禁止把异常 content-type 透传到文件存储。 */
function normalizeImageMimeType(value: string): string {
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mimeType === 'image/webp') return 'image/webp';
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'image/jpeg';
  return 'image/png';
}

/** 媒体短文件名安全校验，避免后续 /images 路由被污染。 */
function isSafeMediaFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}
