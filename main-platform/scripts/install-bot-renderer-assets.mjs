#!/usr/bin/env node
/**
 * 本脚本安装 bot-renderer 本地静态资源。
 *
 * 用途：
 * - 下载中文字体到服务器本地目录，避免 Puppeteer 每次卡片渲染访问外部字体服务。
 * - 保持脚本幂等，已有文件不会重复下载。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { get } from 'node:https';

/** 默认使用 Noto CJK 开源字体；可通过 BOT_RENDERER_FONT_SOURCE_URL 覆盖为内部镜像地址。 */
const DEFAULT_FONT_URL = 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf';
const assetDir = resolve(process.env.BOT_RENDERER_ASSET_DIR ?? join(process.cwd(), 'local', 'bot-renderer-assets'));
const fontFile = sanitizeFilename(process.env.BOT_RENDERER_FONT_FILE ?? 'NotoSansSC-Regular.otf');
const fontUrl = process.env.BOT_RENDERER_FONT_SOURCE_URL ?? DEFAULT_FONT_URL;
const fontPath = resolve(join(assetDir, 'fonts', fontFile));

try {
  await ensureFileFromUrl(fontUrl, fontPath);
  console.log(`[bot-renderer-assets] installed font ${fontPath}`);
} catch (error) {
  // 字体是渲染质量优化，不是服务启动硬依赖；下载失败时保留系统字体兜底，避免生产部署被外部网络卡死。
  console.warn(`[bot-renderer-assets] font install skipped: ${error instanceof Error ? error.message : String(error)}`);
}

async function ensureFileFromUrl(url, outputPath) {
  if (await fileExists(outputPath)) {
    console.log(`[bot-renderer-assets] skip existing ${outputPath}`);
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.tmp`;
  try {
    await download(url, tmpPath, 0);
    await import('node:fs/promises').then(({ rename }) => rename(tmpPath, outputPath));
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function download(url, outputPath, redirectCount) {
  if (redirectCount > 5) throw new Error('下载字体重定向次数过多');
  await new Promise((resolvePromise, rejectPromise) => {
    const req = get(url, { headers: { 'User-Agent': 'AIImageBotRendererAssets/3.0' } }, (res) => {
      const location = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume();
        download(new URL(location, url).toString(), outputPath, redirectCount + 1).then(resolvePromise, rejectPromise);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        rejectPromise(new Error(`下载字体失败：HTTP ${res.statusCode}`));
        return;
      }
      const file = createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolvePromise));
      file.on('error', rejectPromise);
    });
    req.on('error', rejectPromise);
    req.setTimeout(120000, () => {
      req.destroy(new Error('下载字体超时'));
    });
  });
}

async function fileExists(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function sanitizeFilename(value) {
  const filename = String(value).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!filename) throw new Error('BOT_RENDERER_FONT_FILE 不合法');
  return filename;
}
