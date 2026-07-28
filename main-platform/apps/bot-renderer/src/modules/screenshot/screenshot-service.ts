/** HTML 截图服务 — 使用 Puppeteer 将 HTML 卡片渲染为 PNG 图片。Puppeteer 不可用时优雅降级。 */
import type { Browser } from 'puppeteer';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

let browserPromise: Promise<Browser> | null = null;
let puppeteerUnavailable = false;
let renderQueue: Promise<unknown> = Promise.resolve();

/** 卡片截图必须服务 Bot 实时回复，超过该时间就主动失败，避免请求在 Chromium 内部长时间悬挂。 */
const SCREENSHOT_TIMEOUT_MS = Number(process.env.CARD_SCREENSHOT_TIMEOUT_MS ?? '20000');
/** Chromium 冷启动在低负载机器上可能超过单张截图预算，因此和截图超时拆开配置。 */
const BROWSER_LAUNCH_TIMEOUT_MS = Number(process.env.BOT_RENDERER_BROWSER_LAUNCH_TIMEOUT_MS ?? '45000');
/** renderer 本地静态资源虚拟域名，只允许映射到白名单目录。 */
const LOCAL_ASSET_ORIGIN = 'http://aiimage.local-assets';
/** QQ 头像是卡片身份展示所需的小图，允许短时缓存，避免每张卡都访问外部头像服务。 */
const QQ_AVATAR_CACHE_TTL_MS = Number(process.env.BOT_RENDERER_QQ_AVATAR_CACHE_TTL_MS ?? String(30 * 60 * 1000));
const QQ_AVATAR_MAX_BYTES = Number(process.env.BOT_RENDERER_QQ_AVATAR_MAX_BYTES ?? String(512 * 1024));
const qqAvatarCache = new Map<string, { expiresAt: number; contentType: string; body: Buffer }>();

/** Windows 本地部署常见浏览器路径；用于 Puppeteer 未下载自带 Chrome 时兜底渲染 QQ 图片卡片。 */
const LOCAL_BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((path): path is string => Boolean(path));

/** 查找可用浏览器；生产可通过 PUPPETEER_EXECUTABLE_PATH 明确指定，Windows 本地自动兼容 Edge/Chrome。 */
function findLocalBrowserExecutable(): string | undefined {
  return LOCAL_BROWSER_CANDIDATES.find((path) => existsSync(path));
}

/** 获取或创建共享的 Puppeteer Browser 实例。不可用时返回 null。 */
async function getBrowser(): Promise<Browser | null> {
  if (puppeteerUnavailable) return null;
  if (browserPromise) {
    try { return await browserPromise; } catch { browserPromise = null; puppeteerUnavailable = true; return null; }
  }
  try {
    const puppeteer = await import('puppeteer');
    const executablePath = findLocalBrowserExecutable();
    browserPromise = puppeteer.default.launch({
      headless: true,
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    return await browserPromise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bot-renderer] Puppeteer 启动失败，卡片渲染将稍后重试', message);
    browserPromise = null;
    // 缺少浏览器二进制属于配置错误，继续重试只会放大压力；普通超时保留后续重试机会。
    puppeteerUnavailable = /Could not find Chrome|Browser was not found|ENOENT/i.test(message);
    return null;
  }
}

/** 截图层级配置。 */
export type ScreenshotOptions = {
  /** 视口宽度（默认 600）。 */
  width?: number;
  /** 视口高度（默认 400）。 */
  height?: number;
  /** 设备像素比（默认 2，用于高清截图）。 */
  deviceScaleFactor?: number;
};

/**
 * 将 HTML 渲染为 PNG 图片 Buffer。
 * @param html 完整 HTML 文档字符串
 * @param options 截图配置
 * @returns PNG 图片的 Buffer
 */
/** 默认截图配置，可通过环境变量覆盖。 */
const DEFAULT_SCREENSHOT = {
  width: Number(process.env.CARD_WIDTH ?? '600'),
  deviceScaleFactor: Number(process.env.CARD_SCALE ?? '1.5'),
};

/** 实际截图区域；由浏览器 DOM 一次性计算，避免 ElementHandle.boundingBox 偶发阻塞。 */
type ScreenshotMetrics = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function renderHtmlToPng(html: string, options: ScreenshotOptions = {}): Promise<Buffer> {
  // Puppeteer 共享同一个 Browser；串行化可避免某个超时请求重置 Chromium 时杀掉其他正在截图的请求。
  const queued = renderQueue.then(() => renderHtmlToPngNow(html, options), () => renderHtmlToPngNow(html, options));
  renderQueue = queued.catch(() => undefined);
  return queued;
}

async function renderHtmlToPngNow(html: string, options: ScreenshotOptions = {}): Promise<Buffer> {
  const browser = await getBrowser();
  if (!browser) throw new Error('Puppeteer 不可用，卡片渲染已降级');
  const { width = DEFAULT_SCREENSHOT.width, height = 400, deviceScaleFactor = DEFAULT_SCREENSHOT.deviceScaleFactor } = options;
  let page;
  try {
    page = await withTimeout(browser.newPage(), SCREENSHOT_TIMEOUT_MS, '打开截图页面超时');
  } catch (error) {
    await resetBrowserAfterRenderError('打开截图页面失败');
    throw error;
  }
  try {
    page.setDefaultTimeout(SCREENSHOT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(SCREENSHOT_TIMEOUT_MS);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      void (async () => {
        const local = await resolveLocalResource(request.url(), request.resourceType());
        if (local) {
          await request.respond(local).catch(() => {});
          return;
        }
        const url = request.url();
        const type = request.resourceType();
        // Bot 卡片是状态通知，不应等待外部字体、头像、参考图或结果图加载；未命中本地白名单的外部资源直接丢弃。
        if (/^https?:\/\//i.test(url) || type === 'font' || type === 'stylesheet' || type === 'image') {
          await request.abort().catch(() => {});
          return;
        }
        await request.continue().catch(() => {});
      })();
    });
    await page.setViewport({ width, height, deviceScaleFactor });
    await page.setContent(ensureLocalAssetBase(html), { waitUntil: 'domcontentloaded', timeout: SCREENSHOT_TIMEOUT_MS });
    // 给布局和字体替换一个短暂稳定窗口，避免等待外部资源导致 Bot 回复超时。
    await new Promise(r => setTimeout(r, 80));
    // 参考图使用固定展示框，但仍等待本地图片完成解码，确保截图高度按最终布局计算。
    await waitForImagesReady(page);
    await waitForLayoutStable(page);
    // 截取实际卡片包围盒，而不是固定 viewport；尺寸用 DOM 直接读取，减少 Puppeteer 元素句柄通信开销。
    const metrics = await readScreenshotMetrics(page);
    let screenshotOptions: Parameters<typeof page.screenshot>[0];
    if (metrics) {
      await page.setViewport({
        width: Math.max(width, metrics.x + metrics.width + 2),
        height: Math.max(metrics.y + metrics.height + 2, 100),
        deviceScaleFactor,
      });
      // 只等待布局落定，不再二次读取包围盒；生产固定宽度下 viewport 高度变化不会改变卡片宽高。
      await waitForLayoutStable(page);
      screenshotOptions = {
        type: 'png',
        fullPage: false,
        clip: {
          x: metrics.x,
          y: metrics.y,
          width: Math.max(1, metrics.width),
          height: Math.max(1, metrics.height),
        },
        encoding: 'binary',
      };
    } else {
      // 尺寸读取在高 CPU 下偶发超时，兜底必须截完整页面，不能再返回固定 400 高的半张卡片。
      screenshotOptions = { type: 'png', fullPage: true, encoding: 'binary' };
    }

    const buffer = await withTimeout(page.screenshot(screenshotOptions), SCREENSHOT_TIMEOUT_MS, '截图生成超时');
    return buffer as Buffer;
  } catch (error) {
    await resetBrowserAfterRenderError('截图流程失败');
    throw error;
  } finally {
    // Chromium 偶发卡在 close 时不能阻塞 HTTP 响应；失败页面由浏览器进程回收或后续重启清理。
    await withTimeout(page.close(), 1000, '关闭截图页面超时').catch(() => {});
  }
}

/** Puppeteer setContent 默认以 about:blank 解析相对路径；注入 base 后 /images/* 才能命中本地资源拦截。 */
function ensureLocalAssetBase(html: string): string {
  if (/<base\s/i.test(html)) return html;
  const baseTag = `<base href="${LOCAL_ASSET_ORIGIN}/">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  return `${baseTag}${html}`;
}

/** 读取最终截图区域；宽高向上取整并加 1px 兜底，避免阴影和边框抗锯齿被裁掉。 */
async function readScreenshotMetrics(page: Awaited<ReturnType<Browser['newPage']>>): Promise<ScreenshotMetrics | undefined> {
  const raw = await withTimeout(page.evaluate(`
    (() => {
      const el = document.querySelector('.card') || document.body;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const width = Math.max(rect.width, el.scrollWidth || 0);
      const height = Math.max(rect.height, el.scrollHeight || 0);
      return {
        x: Math.max(0, Math.floor(rect.x)),
        y: Math.max(0, Math.floor(rect.y)),
        width: Math.ceil(width) + 1,
        height: Math.ceil(height) + 1
      };
    })()
  `), 5000, '读取卡片尺寸超时').catch(() => null) as ScreenshotMetrics | null;
  return raw ?? undefined;
}

/** Puppeteer 拦截资源时返回本地文件响应；只允许字体资产和 media-service 暂存图片。 */
async function resolveLocalResource(url: string, resourceType: string): Promise<{ status: number; contentType: string; body: Buffer } | undefined> {
  const parsed = parseResourceUrl(url);
  if (!parsed) return readAllowedQqAvatar(url);

  const fontFilename = parsed.kind === 'font' ? safeFilename(parsed.filename) : '';
  if (fontFilename) {
    const font = await readFirstExistingFile(fontRoots(), fontFilename);
    if (font) return { status: 200, contentType: detectFontContentType(fontFilename), body: font };
  }

  const imageFilename = parsed.kind === 'image' || resourceType === 'image' ? safeFilename(parsed.filename) : '';
  if (imageFilename) {
    const image = await readFirstExistingFile(imageRoots(), imageFilename);
    if (image) return { status: 200, contentType: detectImageContentType(imageFilename, image), body: image };
  }

  return undefined;
}

/** 只允许 QQ 头像外链进入 renderer，并用短缓存降低外部依赖抖动。 */
async function readAllowedQqAvatar(url: string): Promise<{ status: number; contentType: string; body: Buffer } | undefined> {
  if (!isAllowedQqAvatarUrl(url)) return undefined;
  const cached = qqAvatarCache.get(url);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { status: 200, contentType: cached.contentType, body: cached.body };
  }
  try {
    for (const candidate of qqAvatarCandidates(url)) {
      const response = await fetch(candidate, {
        headers: {
          Referer: 'https://qun.qq.com/',
          'User-Agent': 'Mozilla/5.0 DrawHimeBotRenderer/3.0',
        },
        signal: AbortSignal.timeout(Number(process.env.BOT_RENDERER_QQ_AVATAR_TIMEOUT_MS ?? '3000')),
      }).catch(() => null);
      if (!response?.ok) continue;
      const contentType = normalizeImageContentType(response.headers.get('content-type') ?? 'image/png');
      if (!isAllowedImageContentType(contentType)) continue;
      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (contentLength > QQ_AVATAR_MAX_BYTES) continue;
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length === 0 || body.length > QQ_AVATAR_MAX_BYTES || !validateImageMagic(body)) continue;
      qqAvatarCache.set(url, { expiresAt: now + QQ_AVATAR_CACHE_TTL_MS, contentType, body });
      trimQqAvatarCache();
      return { status: 200, contentType, body };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isAllowedQqAvatarUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (host === 'q.qlogo.cn' || host === 'qlogo.cn' || host.endsWith('.qlogo.cn'))
      && (parsed.pathname.includes('headimg') || parsed.pathname === '/g');
  } catch {
    return false;
  }
}

/** QQ 头像服务偶发单域名失败，按同一 QQ 号生成备用 qlogo 地址，命中后仍按原始 URL 缓存。 */
function qqAvatarCandidates(url: string): string[] {
  const candidates = [url];
  try {
    const parsed = new URL(url);
    const qq = parsed.searchParams.get('dst_uin') || parsed.searchParams.get('nk') || '';
    if (/^\d{5,12}$/.test(qq)) {
      candidates.push(`https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`);
      candidates.push(`https://q.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=640`);
    }
  } catch {
    // URL 已在上游校验，这里只做备用地址增强。
  }
  return [...new Set(candidates)];
}

/** 从资源 URL 中提取允许映射到本地的字体或图片短文件名。 */
function parseResourceUrl(url: string): { kind: 'font' | 'image'; filename: string } | undefined {
  try {
    const parsed = new URL(url, LOCAL_ASSET_ORIGIN);
    if (parsed.origin === LOCAL_ASSET_ORIGIN && parsed.pathname.startsWith('/fonts/')) {
      return { kind: 'font', filename: basename(parsed.pathname) };
    }
    if (parsed.pathname.startsWith('/images/') || parsed.pathname.startsWith('/api/images/')) {
      return { kind: 'image', filename: basename(parsed.pathname) };
    }
    // 远端归档或历史绝对 URL 只取末尾文件名回查本地暂存，不允许访问远端对象。
    const filename = basename(parsed.pathname);
    if (/^(img|thumb|ref)_[a-zA-Z0-9_.-]+\.(png|jpe?g|webp)$/i.test(filename)) {
      return { kind: 'image', filename };
    }
  } catch {
    // 非法 URL 不能映射到本地文件。
  }
  return undefined;
}

/** 读取第一个存在的白名单文件，路径必须保持在对应根目录下。 */
async function readFirstExistingFile(roots: string[], filename: string): Promise<Buffer | undefined> {
  for (const root of roots) {
    const base = resolve(root);
    const filePath = resolve(join(base, filename));
    if (!filePath.startsWith(base)) continue;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      return await readFile(filePath);
    } catch {
      // 单个目录不存在或文件缺失时继续检查下一个白名单目录。
    }
  }
  return undefined;
}

/** 本地字体目录：生产建议放在 /v3/local/bot-renderer-assets/fonts。 */
function fontRoots(): string[] {
  const assetDir = process.env.BOT_RENDERER_ASSET_DIR ?? join(process.cwd(), 'local', 'bot-renderer-assets');
  return uniquePaths([
    join(assetDir, 'fonts'),
    join(process.cwd(), 'apps', 'bot-renderer', 'assets', 'fonts'),
  ]);
}

/** 本地图片目录：默认读取 media-service 的暂存目录，避免 renderer 走公网或远端归档。 */
function imageRoots(): string[] {
  return uniquePaths([
    ...(process.env.BOT_RENDERER_LOCAL_IMAGE_DIRS ?? '').split(/[;,]/).map((item) => item.trim()).filter(Boolean),
    process.env.MEDIA_STORAGE_PATH ?? '',
    join(process.cwd(), 'media-storage'),
    '/v3/media-storage',
  ]);
}

function safeFilename(filename: string): string {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') ? filename : '';
}

function detectImageContentType(filename: string, body?: Buffer): string {
  // media-service 现有缩略图存在“thumb_*.png 文件内实际是 JPEG”的历史数据，renderer 必须按魔数优先判断。
  if (body && body.length >= 12) {
    if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return 'image/png';
    if (body[0] === 0xff && body[1] === 0xd8) return 'image/jpeg';
    if (body.slice(0, 4).toString('ascii') === 'RIFF' && body.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function normalizeImageContentType(value: string): string {
  const type = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return type === 'image/jpg' ? 'image/jpeg' : type || 'image/png';
}

function isAllowedImageContentType(contentType: string): boolean {
  return contentType === 'image/png' || contentType === 'image/jpeg' || contentType === 'image/webp';
}

function validateImageMagic(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return true;
  return false;
}

function trimQqAvatarCache(): void {
  if (qqAvatarCache.size <= 1000) return;
  const now = Date.now();
  for (const [key, item] of qqAvatarCache) {
    if (item.expiresAt <= now || qqAvatarCache.size > 800) qqAvatarCache.delete(key);
  }
}

function detectFontContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.otf')) return 'font/otf';
  if (lower.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((item) => resolve(item)))];
}

/** 给 Puppeteer 内部异步操作增加上限，避免异常页面长期占用 Chromium 连接。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 等待页面图片进入 complete 并尽量完成 decode；超过短预算则继续截图，避免外部资源拖慢 Bot 回复。 */
async function waitForImagesReady(page: Awaited<ReturnType<Browser['newPage']>>): Promise<void> {
  await withTimeout(page.evaluate(`
    new Promise((resolve) => {
      const images = Array.from(document.images || []);
      if (images.length === 0) {
        resolve(true);
        return;
      }
      Promise.all(images.map((img) => new Promise((done) => {
        const decode = () => {
          if (typeof img.decode === 'function') {
            img.decode().then(done).catch(done);
            return;
          }
          done(true);
        };
        if (img.complete) {
          decode();
          return;
        }
        img.addEventListener('load', decode, { once: true });
        img.addEventListener('error', done, { once: true });
      }))).then(() => resolve(true)).catch(() => resolve(true));
      setTimeout(() => resolve(true), 1200);
    })
  `), 1500, '等待卡片图片加载超时').catch(() => {});
}

/** 等待浏览器完成两帧布局；用于图片解码和 viewport 调整后的最终包围盒计算。 */
async function waitForLayoutStable(page: Awaited<ReturnType<Browser['newPage']>>): Promise<void> {
  await withTimeout(page.evaluate(`
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    })
  `), 1000, '等待卡片布局稳定超时').catch(() => {});
}

/** 关闭 Browser（进程退出时调用）。 */
export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    try { const b = await browserPromise; await b.close(); } catch { /* 忽略 */ }
    browserPromise = null;
  }
}

/** 渲染超时通常表示 Chromium 会话已卡住，主动重置以免后续请求持续失败。 */
async function resetBrowserAfterRenderError(reason: string): Promise<void> {
  const current = browserPromise;
  browserPromise = null;
  puppeteerUnavailable = false;
  if (!current) return;
  let childProcess: ReturnType<NonNullable<Browser['process']>> | undefined;
  try {
    const browser = await withTimeout(current, 1500, '等待浏览器实例超时');
    childProcess = browser.process();
    await withTimeout(browser.close(), 1500, '关闭卡住的浏览器超时');
    console.warn(`[bot-renderer] Chromium reset after render error: ${reason}`);
  } catch {
    if (childProcess && !childProcess.killed) childProcess.kill('SIGKILL');
    console.warn(`[bot-renderer] Chromium force reset after render error: ${reason}`);
  }
}

/** 服务启动后预热 Chromium，避免第一条 Bot 命令承担浏览器冷启动成本。 */
export async function warmupRendererBrowser(): Promise<void> {
  try {
    const browser = await getBrowser();
    if (browser) console.log('[bot-renderer] Chromium warmup ready');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bot-renderer] Chromium warmup failed', message);
  }
}
