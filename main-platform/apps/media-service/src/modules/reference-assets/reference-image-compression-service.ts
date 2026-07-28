/**
 * 本文件负责本地媒体上传压缩：参考图和其它指定大图统一限制到调用方给定上限。
 * 该能力只处理图片二进制，不关心用户、任务、余额或图库权限。
 */

/** 允许 Sharp 输出的图片 MIME 类型。 */
export type CompressibleImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

/** 允许普通媒体上传入口识别的真实输入类型；GIF 会被抽首帧转为 PNG 后进入存储。 */
type UploadInputImageMimeType = CompressibleImageMimeType | 'image/gif';

/** 参考图入口允许解码的真实输入类型；所有类型最终都会转为静态 PNG。 */
type ReferenceInputImageMimeType = UploadInputImageMimeType | 'image/avif' | 'image/tiff' | 'image/svg+xml';

/** 图片压缩请求参数。 */
export type CompressImageToLimitOptions = {
  /** 压缩后的最大字节数，调用方必须传入明确业务上限。 */
  maxBytes: number;
  /** 原始 MIME，用于决定透明图优先输出 WebP，普通图优先输出 JPEG。 */
  mimeType: string;
  /** 压缩任务优先级；网页实时上传必须优先于后台批处理，避免用户等待队列。 */
  priority?: 'interactive' | 'background';
  /** 后台配置的最大图片边长，防止超大分辨率解码耗尽内存。 */
  maxResolution?: number;
};

/** 图片压缩结果，调用方按 mimeType 写入本地存储。 */
export type CompressImageToLimitResult = {
  /** 可写入存储的图片二进制。 */
  buffer: Buffer;
  /** 实际输出 MIME 类型。 */
  mimeType: CompressibleImageMimeType;
  /** 原始图片大小。 */
  originalSize: number;
  /** 输出图片大小。 */
  outputSize: number;
  /** 是否发生压缩或格式转换。 */
  compressed: boolean;
};

/** 图片真实内容检查结果；上传链路用它决定本地文件扩展名，不能只相信请求头。 */
export type ImageBufferInspectionResult = {
  /** 根据文件魔数和 sharp 解码确认后的 MIME 类型。 */
  mimeType: CompressibleImageMimeType;
  /** 图片宽度，供后续排障和限制判断使用。 */
  width: number;
  /** 图片高度，供后续排障和限制判断使用。 */
  height: number;
};

/** 上传入口规范化后的图片；buffer 一定是项目可存储的 PNG/JPEG/WebP。 */
export type NormalizedUploadImageBuffer = {
  /** 可继续压缩或写入本地存储的图片二进制。 */
  buffer: Buffer;
  /** 规范化后的 MIME，只会是项目可存储格式。 */
  mimeType: CompressibleImageMimeType;
  /** 原始上传字节数。 */
  originalSize: number;
  /** 是否发生格式转换。 */
  converted: boolean;
};

/** 参考图统一 PNG 请求参数。 */
export type NormalizeReferenceImageToPngLimitOptions = {
  /** PNG 任务输入版最大字节数。 */
  maxBytes: number;
  /** 调用方声明的 MIME；真实格式仍以文件内容和 Sharp 解码结果为准。 */
  mimeType?: string;
  /** 压缩任务优先级。 */
  priority?: CompressionPriority;
  /** 最大图片边长。 */
  maxResolution?: number;
  /** 调用方断开后取消尚未开始的排队转码，避免超时重试继续制造无效任务。 */
  signal?: AbortSignal;
};

/** 最小有效上限，避免传入异常配置导致循环压到不可用。 */
const MIN_LIMIT_BYTES = 64 * 1024;
/** Sharp resize 过程允许的最小边长，低于该尺寸说明输入不适合继续压缩。 */
const MIN_EDGE_PX = 256;
/** 单张图片最大解码像素，防止小体积超大分辨率图片在 libvips 解码阶段耗尽内存。 */
const MAX_INPUT_PIXELS = Number(process.env.MEDIA_REFERENCE_MAX_INPUT_PIXELS ?? '60000000');
/** Sharp 全局缓存只应初始化一次，避免参考图批量压缩时 libvips 缓存把 RSS 顶到 OOM。 */
let sharpCacheConfigured = false;
/** 图片压缩队列优先级。 */
type CompressionPriority = NonNullable<CompressImageToLimitOptions['priority']>;
/** 图片压缩队列任务。 */
type CompressionJob = {
  /** 实际 sharp 压缩任务。 */
  run: () => Promise<unknown>;
  /** 压缩成功回调。 */
  resolve: (value: unknown) => void;
  /** 压缩失败回调。 */
  reject: (reason?: unknown) => void;
  /** 请求取消信号；仅取消尚未开始的任务，已进入 Sharp 的任务仍需完整收尾。 */
  signal?: AbortSignal;
};
/** 实时上传压缩队列；只允许插队到后台批处理前，不能并发执行。 */
const interactiveCompressionQueue: CompressionJob[] = [];
/** 后台批量压缩队列；维护任务不能阻塞用户实时上传。 */
const backgroundCompressionQueue: CompressionJob[] = [];
/** 当前是否已有 sharp 压缩任务在运行；media-service 的所有 sharp 压缩仍保持串行。 */
let compressionQueueRunning = false;
/** 实时上传等待队列上限；防止浏览器重试把已经超时的转码任务无限堆积。 */
const MAX_INTERACTIVE_COMPRESSION_QUEUE = normalizeQueueLimit(process.env.MEDIA_REFERENCE_INTERACTIVE_QUEUE_LIMIT, 16);
/** 后台维护等待队列上限；后台批处理拥塞时不能继续挤占用户上传所需内存。 */
const MAX_BACKGROUND_COMPRESSION_QUEUE = normalizeQueueLimit(process.env.MEDIA_REFERENCE_BACKGROUND_QUEUE_LIMIT, 64);

/**
 * 将图片压缩到指定大小以内；已满足上限的图片保持原样，避免不必要的画质损失。
 * 关键分支：如果原图超过限制，则逐步降低质量和尺寸，失败时明确抛错而不是写入超限文件。
 */
export async function compressImageToLimit(
  input: Buffer,
  options: CompressImageToLimitOptions,
): Promise<CompressImageToLimitResult> {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const source = await normalizeUploadImageBuffer(input, options.mimeType, { maxResolution: options.maxResolution });
  if (source.buffer.length <= maxBytes) {
    return {
      buffer: source.buffer,
      mimeType: source.mimeType,
      originalSize: input.length,
      outputSize: source.buffer.length,
      compressed: source.converted,
    };
  }

  return enqueueImageCompression(options.priority ?? 'background', () => compressImageToLimitWithSharp(source.buffer, maxBytes, input.length));
}

/**
 * 把任意受支持参考图统一转成静态 PNG，并在保持 PNG 格式的前提下压到任务上限内。
 * GIF 只读取首帧，JPEG 会按 EXIF 自动旋转，SVG/AVIF/TIFF 会安全栅格化。
 */
export async function normalizeReferenceImageToPngLimit(
  input: Buffer,
  options: NormalizeReferenceImageToPngLimitOptions,
): Promise<CompressImageToLimitResult> {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  if (input.length <= 0) throw new Error('缺少图片数据');
  const detectedMimeType = detectReferenceImageMimeType(input);
  if (!detectedMimeType) {
    throw new Error('图片格式不正确，仅支持 PNG、JPEG、WebP、GIF、AVIF、TIFF、SVG');
  }
  return enqueueImageCompression(options.priority ?? 'interactive', async () => {
    const sharpFn = await loadSharp();
    const image = createReferenceSharpImage(sharpFn, input);
    let metadata: { format?: string; width?: number; height?: number; pageHeight?: number; orientation?: number };
    try {
      metadata = await image.metadata();
    } catch {
      throw new Error('图片格式不正确，无法读取图片内容');
    }
    if (!isReferenceDecodedFormatConsistent(detectedMimeType, metadata.format)) {
      throw new Error('图片格式不正确，文件内容与编码不一致');
    }
    const rawWidth = Math.max(0, Number(metadata.width ?? 0));
    const rawHeight = Math.max(0, Number(metadata.pageHeight ?? metadata.height ?? 0));
    if (!rawWidth || !rawHeight) throw new Error('图片格式不正确，缺少有效尺寸');
    const maxResolution = normalizeMaxResolution(options.maxResolution);
    if (rawWidth * rawHeight > MAX_INPUT_PIXELS) throw new Error('图片分辨率过大，无法安全处理');

    // 已满足格式、体积、方向和边长要求的 PNG 直接复用，避免无意义的最高强度重编码拖垮实时上传队列。
    if (
      detectedMimeType === 'image/png'
      && input.length <= maxBytes
      && rawWidth <= maxResolution
      && rawHeight <= maxResolution
      && ![2, 3, 4, 5, 6, 7, 8].includes(Number(metadata.orientation ?? 1))
    ) {
      return {
        buffer: input,
        mimeType: 'image/png',
        originalSize: input.length,
        outputSize: input.length,
        compressed: false,
      };
    }

    // EXIF 方向 5-8 会交换宽高，候选缩放尺寸必须使用旋转后的方向计算。
    const swapsDimensions = [5, 6, 7, 8].includes(Number(metadata.orientation ?? 1));
    const sourceWidth = swapsDimensions ? rawHeight : rawWidth;
    const sourceHeight = swapsDimensions ? rawWidth : rawHeight;
    // 长边超限但总像素仍安全时直接按比例缩到后台上限，不能把可正常使用的 QQ 大图整张拒绝。
    const resolutionScale = Math.min(1, maxResolution / Math.max(sourceWidth, sourceHeight));
    const targetWidth = Math.max(1, Math.round(sourceWidth * resolutionScale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * resolutionScale));
    return encodeReferencePngToLimit(sharpFn, input, targetWidth, targetHeight, maxBytes);
  }, options.signal);
}

/** 校验图片真实内容；请求头 MIME 只作参考，最终以文件魔数和 sharp 解码结果为准。 */
export async function inspectImageBuffer(input: Buffer, declaredMimeType?: string, options: { maxResolution?: number } = {}): Promise<ImageBufferInspectionResult> {
  const normalized = await normalizeUploadImageBuffer(input, declaredMimeType, options);
  const source = await inspectCompressibleImageBuffer(normalized.buffer, normalized.mimeType, options);
  return source;
}

/** 规范化上传图片；GIF 表情包抽取首帧转 PNG，避免后续绘图上游不支持动态图。 */
export async function normalizeUploadImageBuffer(input: Buffer, declaredMimeType?: string, options: { maxResolution?: number } = {}): Promise<NormalizedUploadImageBuffer> {
  if (input.length <= 0) throw new Error('缺少图片数据');
  const magicMimeType = detectImageMimeType(input);
  if (!magicMimeType) throw new Error('图片格式不正确，仅支持 PNG、JPEG、WebP、GIF');

  const sharpFn = await loadSharp();
  let metadata: { format?: string; width?: number; height?: number };
  try {
    metadata = await createSharpImage(sharpFn, input).metadata();
  } catch {
    throw new Error('图片格式不正确，无法读取图片内容');
  }

  const decodedMimeType = mimeTypeForSharpFormat(metadata.format);
  if (decodedMimeType && decodedMimeType !== magicMimeType) {
    throw new Error('图片格式不正确，文件内容与编码不一致');
  }
  const width = Math.max(0, Number(metadata.width ?? 0));
  const height = Math.max(0, Number(metadata.height ?? 0));
  if (!width || !height) throw new Error('图片格式不正确，缺少有效尺寸');
  const maxResolution = normalizeMaxResolution(options.maxResolution);
  if (width > maxResolution || height > maxResolution) throw new Error(`图片分辨率过大，最大边长 ${maxResolution}px`);
  if (width * height > MAX_INPUT_PIXELS) throw new Error('图片分辨率过大，无法安全处理');

  if (magicMimeType === 'image/gif') {
    // GIF 表情包只取首帧作为静态参考图，保持后续 media 文件格式和绘图上游兼容。
    const buffer = await createSharpImage(sharpFn, input)
      .rotate()
      .png({ compressionLevel: 8 })
      .toBuffer();
    return { buffer, mimeType: 'image/png', originalSize: input.length, converted: true };
  }

  const declared = declaredMimeType ? normalizeMimeType(declaredMimeType) : magicMimeType;
  return {
    buffer: input,
    // 关键分支：真实 MIME 覆盖错误请求头，避免 jpg 按 png 扩展名落盘。
    mimeType: declared && declared === magicMimeType ? declared : magicMimeType,
    originalSize: input.length,
    converted: false,
  };
}

/** 校验项目可直接存储的图片，GIF 必须先通过 normalizeUploadImageBuffer 转成 PNG。 */
async function inspectCompressibleImageBuffer(input: Buffer, declaredMimeType?: string, options: { maxResolution?: number } = {}): Promise<ImageBufferInspectionResult> {
  if (input.length <= 0) throw new Error('缺少图片数据');
  const magicMimeType = detectImageMimeType(input);
  if (!magicMimeType || magicMimeType === 'image/gif') throw new Error('图片格式不正确，仅支持 PNG、JPEG、WebP');

  const sharpFn = await loadSharp();
  let metadata: { format?: string; width?: number; height?: number };
  try {
    metadata = await createSharpImage(sharpFn, input).metadata();
  } catch {
    throw new Error('图片格式不正确，无法读取图片内容');
  }

  const decodedMimeType = mimeTypeForSharpFormat(metadata.format);
  if (decodedMimeType && decodedMimeType !== magicMimeType) {
    throw new Error('图片格式不正确，文件内容与编码不一致');
  }
  const width = Math.max(0, Number(metadata.width ?? 0));
  const height = Math.max(0, Number(metadata.height ?? 0));
  if (!width || !height) throw new Error('图片格式不正确，缺少有效尺寸');
  const maxResolution = normalizeMaxResolution(options.maxResolution);
  if (width > maxResolution || height > maxResolution) throw new Error(`图片分辨率过大，最大边长 ${maxResolution}px`);
  if (width * height > MAX_INPUT_PIXELS) throw new Error('图片分辨率过大，无法安全处理');

  const declared = declaredMimeType ? normalizeMimeType(declaredMimeType) : magicMimeType;
  return {
    // 关键分支：真实 MIME 覆盖错误请求头，避免 jpg 按 png 扩展名落盘。
    mimeType: declared && declared === magicMimeType ? declared : magicMimeType,
    width,
    height,
  };
}

/** 规范化后台配置的最大边长，避免异常值导致 sharp 解码风险。 */
function normalizeMaxResolution(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 8192;
  return Math.min(16384, Math.max(512, Math.trunc(Number(value))));
}

/** 规范化压缩等待队列上限，避免异常环境变量关闭保护或制造过大内存队列。 */
function normalizeQueueLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(256, Math.max(1, parsed));
}

/** 串行执行真实 sharp 压缩，并允许网页上传在后台队列前优先执行。 */
async function enqueueImageCompression<T>(priority: CompressionPriority, job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const targetQueue = priority === 'interactive' ? interactiveCompressionQueue : backgroundCompressionQueue;
  const queueLimit = priority === 'interactive' ? MAX_INTERACTIVE_COMPRESSION_QUEUE : MAX_BACKGROUND_COMPRESSION_QUEUE;
  pruneAbortedCompressionJobs(targetQueue);
  if (signal?.aborted) throw new Error('图片处理请求已取消');
  if (targetQueue.length >= queueLimit) {
    throw new Error('图片处理队列繁忙，请稍后重试');
  }
  return new Promise<T>((resolve, reject) => {
    const queuedJob: CompressionJob = {
      run: job as () => Promise<unknown>,
      resolve: (value) => resolve(value as T),
      reject,
      signal,
    };
    targetQueue.push(queuedJob);
    drainCompressionQueue();
  });
}

/** 按实时上传优先、后台批处理其次的顺序消费压缩队列。 */
function drainCompressionQueue(): void {
  if (compressionQueueRunning) return;
  compressionQueueRunning = true;
  void (async () => {
    try {
      while (true) {
        const job = interactiveCompressionQueue.shift() ?? backgroundCompressionQueue.shift();
        if (!job) break;
        if (job.signal?.aborted) {
          job.reject(new Error('图片处理请求已取消'));
          continue;
        }
        try {
          job.resolve(await job.run());
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      compressionQueueRunning = false;
      // 关键分支：finally 期间如果新任务入队，需要重新启动消费循环，避免队列残留。
      if (interactiveCompressionQueue.length > 0 || backgroundCompressionQueue.length > 0) {
        drainCompressionQueue();
      }
    }
  })();
}

/** 清理已断开请求留下的等待任务；保留输入图片仍在调用方，不能继续消耗服务端转码资源。 */
function pruneAbortedCompressionJobs(queue: CompressionJob[]): void {
  for (let index = queue.length - 1; index >= 0; index--) {
    const job = queue[index];
    if (!job?.signal?.aborted) continue;
    queue.splice(index, 1);
    job.reject(new Error('图片处理请求已取消'));
  }
}

/** 使用 sharp 执行压缩；调用方必须已经完成无需压缩的快速返回判断。 */
async function compressImageToLimitWithSharp(input: Buffer, maxBytes: number, originalSize = input.length): Promise<CompressImageToLimitResult> {
  const sharpFn = await loadSharp();
  const metadata = await createSharpImage(sharpFn, input).metadata();
  const hasAlpha = metadata.hasAlpha === true;
  const outputMimeType: CompressibleImageMimeType = hasAlpha ? 'image/webp' : 'image/jpeg';
  const sourceWidth = Math.max(1, Number(metadata.width ?? 0));
  const sourceHeight = Math.max(1, Number(metadata.height ?? 0));
  if (sourceWidth * sourceHeight > MAX_INPUT_PIXELS) {
    throw new Error('图片分辨率过大，无法安全压缩');
  }

  let best: Buffer | undefined;
  for (const scale of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.28]) {
    const width = Math.max(MIN_EDGE_PX, Math.round(sourceWidth * scale));
    const height = Math.max(MIN_EDGE_PX, Math.round(sourceHeight * scale));
    for (const quality of [88, 80, 72, 64, 56, 48, 40, 34]) {
      const candidate = await encodeWithSharp(sharpFn, input, {
        width,
        height,
        quality,
        mimeType: outputMimeType,
      });
      if (!best || candidate.length < best.length) best = candidate;
      if (candidate.length <= maxBytes) {
        return {
          buffer: candidate,
          mimeType: outputMimeType,
          originalSize,
          outputSize: candidate.length,
          compressed: true,
        };
      }
    }
  }

  // 最后一档使用更激进的缩放，避免用户大分辨率参考图因为轻度压缩失败而无法进入任务。
  const fallback = await encodeWithSharp(sharpFn, input, {
    width: MIN_EDGE_PX,
    height: MIN_EDGE_PX,
    quality: 30,
    mimeType: outputMimeType,
  });
  const finalBuffer = fallback.length < (best?.length ?? Number.POSITIVE_INFINITY) ? fallback : best;
  if (!finalBuffer || finalBuffer.length > maxBytes) {
    throw new Error(`图片压缩后仍超过 ${(maxBytes / 1024 / 1024).toFixed(1)}MB`);
  }
  return {
    buffer: finalBuffer,
    mimeType: outputMimeType,
    originalSize,
    outputSize: finalBuffer.length,
    compressed: true,
  };
}

/** 在 PNG 格式内逐级调整颜色与分辨率，避免为了体积上限回退为 JPEG/WebP。 */
async function encodeReferencePngToLimit(
  sharpFn: any,
  input: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  maxBytes: number,
): Promise<CompressImageToLimitResult> {
  let smallest: Buffer | undefined;
  for (const scale of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.28, 0.22]) {
    const width = Math.max(MIN_EDGE_PX, Math.round(sourceWidth * scale));
    const height = Math.max(MIN_EDGE_PX, Math.round(sourceHeight * scale));
    const trueColor = await encodeReferencePng(sharpFn, input, width, height);
    if (!smallest || trueColor.length < smallest.length) smallest = trueColor;
    if (trueColor.length <= maxBytes) {
      return buildReferencePngResult(trueColor, input.length);
    }
    // 照片型 PNG 优先保留空间细节，再逐档减少颜色；透明通道会继续保留。
    for (const colors of [256, 192, 128]) {
      const palette = await encodeReferencePng(sharpFn, input, width, height, colors);
      if (!smallest || palette.length < smallest.length) smallest = palette;
      if (palette.length <= maxBytes) {
        return buildReferencePngResult(palette, input.length);
      }
    }
  }

  const fallback = await encodeReferencePng(sharpFn, input, MIN_EDGE_PX, MIN_EDGE_PX, 64);
  const finalBuffer = fallback.length < (smallest?.length ?? Number.POSITIVE_INFINITY) ? fallback : smallest;
  if (!finalBuffer || finalBuffer.length > maxBytes) {
    throw new Error(`图片转换为 PNG 后仍超过 ${(maxBytes / 1024 / 1024).toFixed(1)}MB`);
  }
  return buildReferencePngResult(finalBuffer, input.length);
}

/** 编码单个 PNG 候选；不传 colors 时使用真彩无损编码。 */
async function encodeReferencePng(
  sharpFn: any,
  input: Buffer,
  width: number,
  height: number,
  colors?: number,
): Promise<Buffer> {
  const image = createReferenceSharpImage(sharpFn, input)
    .rotate()
    .resize(width, height, { fit: 'inside', withoutEnlargement: true });
  return image.png({
    compressionLevel: 9,
    adaptiveFiltering: true,
    // 实时参考图优先保证稳定吞吐；effort 6 仍保持无损 PNG，避免 effort 10 在多图上传时成倍占用 CPU。
    effort: 6,
    ...(colors ? { palette: true, colors, dither: 0.7 } : {}),
  }).toBuffer();
}

/** 创建统一 PNG 结果，参考图每次都会经过重编码、方向修正或格式转换。 */
function buildReferencePngResult(buffer: Buffer, originalSize: number): CompressImageToLimitResult {
  return {
    buffer,
    mimeType: 'image/png',
    originalSize,
    outputSize: buffer.length,
    compressed: true,
  };
}

/** 动态加载 Sharp，避免 CJS/ESM 默认导出差异影响服务启动。 */
async function loadSharp(): Promise<any> {
  try {
    const mod = await import('sharp');
    const sharpFn = ((mod as { default?: unknown }).default ?? mod) as any;
    if (!sharpCacheConfigured && typeof sharpFn === 'function' && typeof sharpFn.cache === 'function') {
      // 生产 media-service 内存优先于压缩吞吐；禁用缓存可显著降低批量压图时的 OOM 风险。
      sharpFn.cache({ memory: 0, files: 0, items: 0 });
      if (typeof sharpFn.concurrency === 'function') sharpFn.concurrency(1);
      sharpCacheConfigured = true;
    }
    return sharpFn;
  } catch {
    throw new Error('Sharp 未安装或不可用，无法压缩参考图');
  }
}

/** 使用 Sharp 按目标 MIME、尺寸和质量编码图片。 */
async function encodeWithSharp(
  sharpFn: any,
  input: Buffer,
  options: { width: number; height: number; quality: number; mimeType: CompressibleImageMimeType },
): Promise<Buffer> {
  const image = createSharpImage(sharpFn, input)
    .rotate()
    .resize(options.width, options.height, { fit: 'inside', withoutEnlargement: true });
  if (options.mimeType === 'image/webp') {
    return image.webp({ quality: options.quality, effort: 4 }).toBuffer();
  }
  return image
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: options.quality, progressive: true, mozjpeg: true })
    .toBuffer();
}

/** 创建带像素上限的 sharp 实例；所有解码入口都必须走这里。 */
function createSharpImage(sharpFn: any, input: Buffer): any {
  return sharpFn(input, { limitInputPixels: MAX_INPUT_PIXELS });
}

/** 创建只解码首帧的参考图 Sharp 实例，避免动图所有帧叠成长图。 */
function createReferenceSharpImage(sharpFn: any, input: Buffer): any {
  return sharpFn(input, { limitInputPixels: MAX_INPUT_PIXELS, page: 0, pages: 1, failOn: 'error' });
}

/** 规范化调用方传入的 MIME，只接受本项目支持的图片格式。 */
export function normalizeMimeType(value: string): CompressibleImageMimeType {
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'image/jpeg';
  if (mimeType === 'image/webp') return 'image/webp';
  return 'image/png';
}

/** 根据文件头判断项目支持的图片格式，避免伪图片绕过 MIME 请求头。 */
function detectImageMimeType(input: Buffer): UploadInputImageMimeType | undefined {
  if (input.length >= 8 && input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    input.length >= 12
    && input.subarray(0, 4).toString('ascii') === 'RIFF'
    && input.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (input.length >= 6) {
    const signature = input.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  return undefined;
}

/** 根据文件签名判断参考图输入格式；不信任浏览器或外部站点声明的 MIME。 */
function detectReferenceImageMimeType(input: Buffer): ReferenceInputImageMimeType | undefined {
  const basicMimeType = detectImageMimeType(input);
  if (basicMimeType) return basicMimeType;
  if (input.length >= 4) {
    const littleEndianTiff = input[0] === 0x49 && input[1] === 0x49 && input[2] === 0x2a && input[3] === 0x00;
    const bigEndianTiff = input[0] === 0x4d && input[1] === 0x4d && input[2] === 0x00 && input[3] === 0x2a;
    if (littleEndianTiff || bigEndianTiff) return 'image/tiff';
  }
  if (input.length >= 16 && input.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = input.subarray(8, Math.min(input.length, 40)).toString('ascii');
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
  }
  // SVG 允许 BOM、XML 声明与 DOCTYPE，但前 4KB 必须实际出现根 svg 元素。
  const prefix = input.subarray(0, Math.min(input.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!doctype\s+svg[\s\S]*?>\s*)?<svg(?:\s|>)/i.test(prefix)) return 'image/svg+xml';
  return undefined;
}

/** 校验 Sharp 解码格式与文件签名一致，AVIF 在 Sharp 中统一报告为 heif。 */
function isReferenceDecodedFormatConsistent(mimeType: ReferenceInputImageMimeType, format: string | undefined): boolean {
  if (!format) return false;
  if (mimeType === 'image/avif') return format === 'heif' || format === 'avif';
  if (mimeType === 'image/svg+xml') return format === 'svg';
  if (mimeType === 'image/tiff') return format === 'tiff';
  return mimeTypeForSharpFormat(format) === mimeType;
}

/** 把 sharp 的 format 字段收敛为项目支持的 MIME。 */
function mimeTypeForSharpFormat(format: string | undefined): UploadInputImageMimeType | undefined {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  if (format === 'gif') return 'image/gif';
  return undefined;
}

/** 规范化压缩上限，异常配置直接抛错，避免生产静默写入超大文件。 */
function normalizeMaxBytes(value: number): number {
  if (!Number.isFinite(value) || value < MIN_LIMIT_BYTES) {
    throw new Error('参考图压缩上限配置不正确');
  }
  return Math.trunc(value);
}
