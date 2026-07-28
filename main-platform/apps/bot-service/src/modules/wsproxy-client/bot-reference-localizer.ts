/**
 * 本文件负责把 Bot 命令中的参考图提前转存到 media-service 本地暂存。
 *
 * 这样 backend、drawing-worker 和 bot-renderer 后续都使用站内 `/images/ref_*.png`，
 * 任务执行期不再依赖 QQ 临时外链或头像外链。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';

/** Bot 侧单张参考图最大下载大小，避免表情包或文件消息异常放大占满内存。 */
const MAX_REFERENCE_BYTES = Number(process.env.BOT_REFERENCE_MAX_BYTES ?? String(20 * 1024 * 1024));
/** Bot 侧参考图本地化数量上限，保持和绘图接口的参考图数量约束一致。 */
const MAX_REFERENCE_COUNT = Number(process.env.BOT_REFERENCE_IMAGE_LIMIT ?? '8');
/** 下载外部参考图单次超时；QQ NT 临时图偶发慢响应，默认给足 30 秒避免误失败。 */
const DOWNLOAD_TIMEOUT_MS = Number(process.env.BOT_REFERENCE_DOWNLOAD_TIMEOUT_MS ?? '30000');
/** 下载外部参考图最大尝试次数；只对网络异常、超时和临时 HTTP 错误重试。 */
const DOWNLOAD_MAX_ATTEMPTS = safePositiveInt(Number(process.env.BOT_REFERENCE_DOWNLOAD_RETRIES ?? '3'), 3);
/** curl 兜底下载超时；只用于 QQ NT 临时图，避免 Node fetch 在该 CDN 上长期超时。 */
const CURL_DOWNLOAD_TIMEOUT_MS = Number(process.env.BOT_REFERENCE_CURL_TIMEOUT_MS ?? '90000');
/** 上传本地暂存超时；需覆盖参考图格式转换和受控短队列，避免 Bot 比 backend 更早放弃同一张图片。 */
const UPLOAD_TIMEOUT_MS = Number(process.env.BOT_REFERENCE_UPLOAD_TIMEOUT_MS ?? '60000');
/** Bot 参考图任务输入版上限；超限图片由 media-service 压缩后再进入绘图任务。 */
const REFERENCE_TASK_INPUT_MAX_BYTES = Number(process.env.REFERENCE_TASK_INPUT_MAX_BYTES ?? String(3 * 1024 * 1024));

/** 参考图本地化结果，调用方可据此决定继续绘图或提示用户重试。 */
export type LocalizedReferenceImages = {
  /** 已按原始优先级转存后的站内图片地址。 */
  urls: string[];
  /** Bot 卡片渲染专用缩略图地址；生成失败时按顺序回退为原图地址。 */
  previewUrls: string[];
  /** 原始去重后的图片数量。 */
  total: number;
  /** 下载或上传失败数量。 */
  failed: number;
  /** 因超过绘图参考图上限而未进入任务的数量。 */
  omitted: number;
  /** 当前 Bot 入口允许进入单次绘图任务的参考图上限。 */
  maxAllowed: number;
};

/** 将参考图来源转为 media-service 本地暂存地址，保持输入顺序和去重结果。 */
export async function localizeReferenceImagesForGeneration(sourceUrls: string[]): Promise<LocalizedReferenceImages> {
  const urls: string[] = [];
  const previewUrls: string[] = [];
  const seenReferenceKeys = new Set<string>();
  let failed = 0;
  const uniqueSources = uniqueOrdered(sourceUrls);
  const maxReferenceCount = safePositiveInt(MAX_REFERENCE_COUNT, 8);
  const limitedSources = uniqueSources.slice(0, maxReferenceCount);
  const omitted = Math.max(0, uniqueSources.length - limitedSources.length);

  for (const sourceUrl of limitedSources) {
    try {
      const localized = await localizeSingleReferenceImage(sourceUrl);
      if (localized) {
        const key = await buildLocalizedReferenceKey(localized);
        if (key && seenReferenceKeys.has(key)) continue;
        if (key) seenReferenceKeys.add(key);
        urls.push(localized);
        // 绘图任务继续使用原图；Bot 卡片只展示本地缩略图，避免 Puppeteer 解码超大参考图导致回复超时。
        previewUrls.push(await generatePreviewImage(localized) || localized);
      }
      else {
        failed++;
        logReferenceLocalizeFailure('empty_result', sourceUrl);
      }
    } catch (error) {
      failed++;
      logReferenceLocalizeFailure(error instanceof Error ? error.message : 'unknown_error', sourceUrl);
    }
  }

  return { urls, previewUrls, total: uniqueSources.length, failed, omitted, maxAllowed: maxReferenceCount };
}

/** 本地或站内图片直接复用，外部图片先下载再上传到 media-service。 */
async function localizeSingleReferenceImage(sourceUrl: string): Promise<string> {
  const source = sourceUrl.trim();
  if (!source) return '';
  if (source.startsWith('/images/')) return normalizeImagePath(source);
  if (isSafeMediaFilename(source)) return `/images/${source}`;
  const stationFilename = extractStationImageFilename(source);
  if (stationFilename) return `/images/${stationFilename}`;

  const downloaded = source.startsWith('onebot-local-file:')
    ? await readOneBotLocalImage(source)
    : source.startsWith('data:image/')
    ? decodeDataUrl(source)
    : await downloadExternalImage(source);
  if (!downloaded) {
    logReferenceLocalizeFailure('download_failed', source);
    return '';
  }

  return uploadDownloadedReference(downloaded, source);
}

/** 把已经取得的图片二进制直传到 media-service，避免 base64 JSON 放大导致 Bot 暂存变慢。 */
async function uploadDownloadedReference(downloaded: { buffer: Buffer; contentType: string }, source: string): Promise<string> {
  const mediaUrl = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const uploadRes = await fetch(`${mediaUrl}/media/upload`, {
        method: 'POST',
        headers: {
          'content-type': downloaded.contentType,
          'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
          'x-aiimage-prefix': 'ref_',
          'x-aiimage-max-bytes': String(REFERENCE_TASK_INPUT_MAX_BYTES),
        },
        // 关键分支：Bot 任务同样复用 <=3MB 的站内 task_input，避免大 QQ 图长期占用本地和上游请求体。
        body: new Uint8Array(downloaded.buffer),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      const uploadData = await uploadRes.json().catch(() => ({})) as { ok?: boolean; data?: { filename?: string } };
      const filename = uploadData.ok ? uploadData.data?.filename ?? '' : '';
      if (uploadRes.ok && isSafeMediaFilename(filename)) return `/images/${filename}`;
      const retryable = uploadRes.status === 408 || uploadRes.status === 429 || uploadRes.status >= 500;
      if (!retryable || attempt === 3) {
        logReferenceLocalizeFailure(`upload_failed_${uploadRes.status}:${readUploadErrorMessage(uploadData)}`, source);
        return '';
      }
    } catch (error) {
      if (attempt === 3) {
        logReferenceLocalizeFailure(`upload_error:${error instanceof Error ? error.message : 'unknown'}`, source);
        return '';
      }
    }
    // Media 临时拥塞时保留已下载二进制并退避重试，不重新访问易过期的 QQ 临时链接。
    await sleepBeforeDownloadRetry(attempt);
  }
  return '';
}

/** 读取 OneBot 协议端本地缓存文件；只允许受控目录和真实图片魔数，避免任意文件读取。 */
async function readOneBotLocalImage(source: string): Promise<{ buffer: Buffer; contentType: string } | undefined> {
  const encoded = source.slice('onebot-local-file:'.length);
  let filePath = '';
  try {
    filePath = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!filePath) return undefined;
    const resolved = await realpath(filePath);
    if (!await isAllowedOneBotLocalPath(resolved)) {
      logReferenceLocalizeFailure('local_file_path_denied', source);
      return undefined;
    }
    await access(resolved, constants.R_OK);
    const info = await stat(resolved);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_REFERENCE_BYTES) {
      logReferenceLocalizeFailure(`local_file_size_invalid_${info.size}`, source);
      return undefined;
    }
    const buffer = await readFile(resolved);
    const detectedType = detectImageMimeType(buffer);
    if (!detectedType) {
      logReferenceLocalizeFailure('local_file_invalid_image_magic', source);
      return undefined;
    }
    return { buffer, contentType: detectedType };
  } catch (error) {
    logReferenceLocalizeFailure(`local_file_read_failed:${error instanceof Error ? error.message : 'unknown'}`, source);
    return undefined;
  }
}

/** 判断 OneBot 本地缓存路径是否位于允许根目录下。 */
async function isAllowedOneBotLocalPath(resolvedPath: string): Promise<boolean> {
  const roots = (process.env.BOT_REFERENCE_LOCAL_FILE_ROOTS ?? '/root/.config/QQ,/tmp,/v3/local')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const root of roots) {
    try {
      const resolvedRoot = await realpath(root);
      if (resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`)) return true;
    } catch {
      // 不存在的可选根目录跳过，不影响其他路径判断。
    }
  }
  return false;
}

/** 下载 QQ/头像/普通图片外链，并限制类型和大小。 */
async function downloadExternalImage(sourceUrl: string): Promise<{ buffer: Buffer; contentType: string } | undefined> {
  if (!/^https?:\/\//i.test(sourceUrl)) return undefined;
  if (shouldUseCurlDownloader(sourceUrl)) {
    const curlDownloaded = await downloadExternalImageWithCurl(sourceUrl);
    if (curlDownloaded) return curlDownloaded;
  }
  let lastError = '';
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(sourceUrl, {
        headers: buildExternalImageFetchHeaders(sourceUrl),
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        lastError = `download_http_${response.status}`;
        if (shouldRetryDownloadStatus(response.status) && attempt < DOWNLOAD_MAX_ATTEMPTS) {
          await sleepBeforeDownloadRetry(attempt);
          continue;
        }
        logReferenceLocalizeFailure(`${lastError}_attempt_${attempt}`, sourceUrl);
        return undefined;
      }
      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (contentLength > MAX_REFERENCE_BYTES) {
        logReferenceLocalizeFailure(`download_too_large_header_${contentLength}`, sourceUrl);
        return undefined;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_REFERENCE_BYTES) {
        logReferenceLocalizeFailure(`download_too_large_body_${buffer.length}`, sourceUrl);
        return undefined;
      }
      const detectedType = detectImageMimeType(buffer);
      if (!detectedType) {
        const headerType = normalizeContentType(response.headers.get('content-type') ?? '');
        logReferenceLocalizeFailure(`invalid_image_magic:${headerType || 'no_content_type'}`, sourceUrl);
        return undefined;
      }
      return { buffer, contentType: detectedType };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'unknown_download_error';
      if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
        await sleepBeforeDownloadRetry(attempt);
        continue;
      }
    }
  }
  logReferenceLocalizeFailure(`download_error_after_${DOWNLOAD_MAX_ATTEMPTS}:${lastError}`, sourceUrl);
  return undefined;
}

/** 使用系统 curl 下载 QQ NT 临时图；不用 shell 拼接命令，避免 URL 注入风险。 */
async function downloadExternalImageWithCurl(sourceUrl: string): Promise<{ buffer: Buffer; contentType: string } | undefined> {
  const args = buildCurlDownloadArgs(sourceUrl);
  try {
    const buffer = await execFileBuffer('curl', args, MAX_REFERENCE_BYTES + 1024 * 1024);
    if (buffer.length === 0 || buffer.length > MAX_REFERENCE_BYTES) {
      logReferenceLocalizeFailure(`curl_too_large_body_${buffer.length}`, sourceUrl);
      return undefined;
    }
    const detectedType = detectImageMimeType(buffer);
    if (!detectedType) {
      logReferenceLocalizeFailure('curl_invalid_image_magic', sourceUrl);
      return undefined;
    }
    return { buffer, contentType: detectedType };
  } catch (error) {
    logReferenceLocalizeFailure(`curl_download_failed:${error instanceof Error ? error.message : 'unknown'}`, sourceUrl);
    return undefined;
  }
}

/** 解码 data URL；网页端预上传或协议端 base64 图片也统一进入本地暂存。 */
function decodeDataUrl(source: string): { buffer: Buffer; contentType: string } | undefined {
  const match = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return undefined;
  const contentType = normalizeContentType(match[1] ?? 'image/png');
  if (!isAllowedImageContentType(contentType)) return undefined;
  const buffer = Buffer.from(match[2] ?? '', 'base64');
  if (buffer.length === 0 || buffer.length > MAX_REFERENCE_BYTES || !validateImageMagic(buffer)) return undefined;
  return { buffer, contentType };
}

/** 生成 Bot 卡片预览图，失败时不影响原图参与绘图。 */
async function generatePreviewImage(imagePath: string): Promise<string> {
  const filename = normalizeImagePath(imagePath).replace('/images/', '');
  if (!isSafeMediaFilename(filename)) return '';
  const mediaUrl = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
  try {
    const res = await fetch(`${mediaUrl}/media/generate-thumbnail`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
      },
      body: JSON.stringify({
        sourceFilename: filename,
        width: Number(process.env.BOT_REFERENCE_PREVIEW_WIDTH ?? '320'),
        quality: Number(process.env.BOT_REFERENCE_PREVIEW_QUALITY ?? '65'),
      }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { filename?: string } };
    const thumb = data.ok ? data.data?.filename ?? '' : '';
    return isSafeMediaFilename(thumb) ? `/images/${thumb}` : '';
  } catch {
    return '';
  }
}

/** QQ 临时图片和头像需要常见浏览器请求头，否则部分链接会拒绝下载。 */
function buildExternalImageFetchHeaders(imageUrl: string): Record<string, string> {
  const browserHeaders = {
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
  try {
    const host = new URL(imageUrl).hostname;
    if (host === 'multimedia.nt.qq.com.cn' || host.endsWith('.multimedia.nt.qq.com.cn')) {
      return {
        ...browserHeaders,
        Referer: 'https://nt.qq.com/',
      };
    }
    if (host === 'qq.com' || host.endsWith('.qq.com') || host === 'qpic.cn' || host.endsWith('.qpic.cn') || host === 'qlogo.cn' || host.endsWith('.qlogo.cn')) {
      return {
        ...browserHeaders,
        Referer: 'https://qun.qq.com/',
      };
    }
  } catch {
    // URL 解析失败时不附加来源头，后续下载会自然失败。
  }
  return browserHeaders;
}

/** 判断是否使用 curl 优先下载；当前只针对生产上 Node fetch 持续超时的 QQ NT 图片 CDN。 */
function shouldUseCurlDownloader(imageUrl: string): boolean {
  try {
    const host = new URL(imageUrl).hostname;
    return host === 'multimedia.nt.qq.com.cn' || host.endsWith('.multimedia.nt.qq.com.cn');
  } catch {
    return false;
  }
}

/** 构造 curl 下载参数，所有动态 URL 都作为独立 argv 传入，不经过 shell。 */
function buildCurlDownloadArgs(imageUrl: string): string[] {
  const headers = buildExternalImageFetchHeaders(imageUrl);
  const args = [
    '--location',
    '--fail',
    '--silent',
    '--show-error',
    '--http1.1',
    '--connect-timeout',
    '10',
    '--max-time',
    String(Math.max(1, Math.ceil(CURL_DOWNLOAD_TIMEOUT_MS / 1000))),
    '--max-filesize',
    String(MAX_REFERENCE_BYTES),
    '--retry',
    '2',
    '--retry-all-errors',
  ];
  for (const [key, value] of Object.entries(headers)) {
    args.push('--header', `${key}: ${value}`);
  }
  args.push(imageUrl);
  return args;
}

/** 执行二进制命令并返回 stdout；仅用于受控的 curl argv 下载，不执行 shell。 */
function execFileBuffer(command: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'buffer', maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        reject(new Error(`${error.message}${detail ? `: ${detail.slice(0, 160)}` : ''}`));
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

/** 规范化站内图片路径，只保留短文件名。 */
function normalizeImagePath(source: string): string {
  const filename = source.replace(/^\/images\//, '').split(/[?#]/, 1)[0] ?? '';
  return isSafeMediaFilename(filename) ? `/images/${filename}` : '';
}

/** 站内绝对图片 URL 直接转短路径，避免 Bot 侧为了本地化而再次请求 backend。 */
function extractStationImageFilename(source: string): string {
  try {
    const parsed = new URL(source);
    const base = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).hostname : '';
    const isStationHost = base ? parsed.hostname === base : parsed.pathname.startsWith('/images/');
    if (!isStationHost || !parsed.pathname.startsWith('/images/')) return '';
    const filename = basenamePath(parsed.pathname);
    return isSafeMediaFilename(filename) ? filename : '';
  } catch {
    return '';
  }
}

function basenamePath(pathname: string): string {
  const index = pathname.lastIndexOf('/');
  return index >= 0 ? pathname.slice(index + 1) : pathname;
}

/** 只接受 media-service 生成的短文件名，防止路径穿越。 */
function isSafeMediaFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}

/** 检查图片签名，避免把 HTML 错误页或文本上传为参考图。 */
function validateImageMagic(buffer: Buffer): boolean {
  return Boolean(detectImageMimeType(buffer));
}

function normalizeContentType(value: string): string {
  const contentType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'image/jpg') return 'image/jpeg';
  return contentType || 'image/png';
}

function isAllowedImageContentType(contentType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/tiff', 'image/svg+xml'].includes(contentType);
}

/** 提取 media-service 上传失败摘要，日志只保留短原因。 */
function readUploadErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return 'unknown';
  const record = value as { message?: unknown; code?: unknown };
  return String(record.message ?? record.code ?? 'unknown').slice(0, 120);
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/** 为已本地化参考图生成确定性去重键；优先读取站内文件内容 hash，失败时退回短文件名。 */
async function buildLocalizedReferenceKey(imagePath: string): Promise<string> {
  const normalized = normalizeImagePath(imagePath);
  const filename = normalized.replace('/images/', '');
  if (!isSafeMediaFilename(filename)) return '';
  const mediaUrl = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
  try {
    const response = await fetch(`${mediaUrl}/media/files/${encodeURIComponent(filename)}?source=local`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return `file:${filename}`;
    const buffer = Buffer.from(await response.arrayBuffer());
    return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
  } catch {
    // 内容读取失败时仍按短文件名去重，不能影响绘图主链路。
    return `file:${filename}`;
  }
}

function safePositiveInt(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 判断下载状态码是否属于临时失败，可安全重试。 */
function shouldRetryDownloadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** 参考图下载重试退避，避免 QQ CDN 短时间慢响应时立刻失败。 */
async function sleepBeforeDownloadRetry(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 3000)));
}

/** 根据图片魔数识别真实 MIME，避免 QQ 临时图用 application/octet-stream 响应头时被误拒绝。 */
function detectImageMimeType(buffer: Buffer): string {
  if (buffer.length < 4) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  // GIF 表情包允许进入 media-service，由统一上传链路抽首帧转 PNG。
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  const littleEndianTiff = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
  const bigEndianTiff = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;
  if (littleEndianTiff || bigEndianTiff) return 'image/tiff';
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = buffer.subarray(8, Math.min(buffer.length, 40)).toString('ascii');
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
  }
  // SVG 只放行前 4KB 内存在真实根元素的 XML 文本，后续仍由 media-service 栅格化并校验尺寸。
  const prefix = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!doctype\s+svg[\s\S]*?>\s*)?<svg(?:\s|>)/i.test(prefix)) return 'image/svg+xml';
  return '';
}

/** 参考图本地化失败日志；只记录来源摘要，避免泄漏完整临时 URL。 */
function logReferenceLocalizeFailure(reason: string, source: string): void {
  const summary = summarizeReferenceSource(source);
  console.warn('[bot] 参考图本地化失败', JSON.stringify({ reason: reason.slice(0, 160), source: summary }));
}

/** 压缩来源 URL 到可排障但不泄漏 token 的摘要。 */
function summarizeReferenceSource(source: string): string {
  try {
    if (source.startsWith('onebot-local-file:')) return 'onebot-local-file';
    if (source.startsWith('data:image/')) return `data:${source.length}`;
    const parsed = new URL(source);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname.slice(0, 80)}`;
  } catch {
    return source.slice(0, 80);
  }
}
