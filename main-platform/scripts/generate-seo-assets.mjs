#!/usr/bin/env node
/**
 * 本脚本使用指定 PNG 原图生成用户端多尺寸图标和分享图，提升浏览器、PWA、社交平台和搜索结果兼容性。
 */

import { copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const requireFromMediaService = createRequire(join(process.cwd(), 'apps', 'media-service', 'package.json'));
const sharp = requireFromMediaService('sharp');

const publicDir = join(process.cwd(), 'apps', 'web-frontend', 'public');
const sourceIcon = join(publicDir, 'icon-source.png');
const frontendPublicDirs = [
  publicDir,
  join(process.cwd(), 'apps', 'admin-portal', 'public'),
];

/** 从原始图标生成固定尺寸 PNG，统一使用高质量 Lanczos 缩放。 */
async function renderIcon(targetName, width, height = width) {
  const png = await createIconPng(width, height);
  await writeFile(join(publicDir, targetName), png);
  console.log(`[seo-assets] ${targetName} ${width}x${height}`);
}

/** 生成指定尺寸 PNG Buffer，供单图标和 ICO 复用。 */
async function createIconPng(width, height = width) {
  return sharp(sourceIcon)
    .resize(width, height, { fit: 'cover', kernel: 'lanczos3' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

/** 生成带站点信息的社交分享图，避免平台裁切方形头像导致识别弱。 */
async function renderOgImage() {
  const iconDataUrl = `data:image/png;base64,${(await sharp(sourceIcon)
    .resize(292, 292, { fit: 'cover', kernel: 'lanczos3' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer()).toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#0f172a"/>
    <path d="M0 494c154-52 285-59 420-16 148 48 273 33 455-83 123-79 219-86 325-47v282H0Z" fill="#172554"/>
    <path d="M0 430c148-34 266-21 383 31 148 66 275 43 441-58 157-95 270-77 376-20v247H0Z" fill="#155e75" opacity=".76"/>
    <circle cx="990" cy="132" r="96" fill="#22d3ee" opacity=".18"/>
    <circle cx="240" cy="475" r="128" fill="#fb7185" opacity=".15"/>
    <image href="${iconDataUrl}" x="92" y="84" width="156" height="156" preserveAspectRatio="xMidYMid slice"/>
    <text x="92" y="324" fill="#f8fafc" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-size="88" font-weight="800">绘图姬</text>
    <text x="92" y="401" fill="#93c5fd" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-size="48" font-weight="700">DrawHime</text>
    <text x="92" y="478" fill="#e2e8f0" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-size="35" font-weight="600">AI绘图 · 图生图 · 参考图创作 · Bot绘图</text>
    <text x="92" y="548" fill="#94a3b8" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-size="24" font-weight="500">www.xanime.ink</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  await writeFile(join(publicDir, 'og-image.png'), png);
  console.log('[seo-assets] og-image.png 1200x630');
}

await renderIcon('favicon-16x16.png', 16);
await renderIcon('favicon-32x32.png', 32);
await renderIcon('favicon-48x48.png', 48);
await renderIcon('android-chrome-192x192.png', 192);
await renderIcon('android-chrome-512x512.png', 512);
await renderIcon('apple-touch-icon.png', 180);
await renderIcon('icon-1024.png', 1024);
await renderIco();
await renderOgImage();
await removeOldSvgIcons();
await syncFrontendIcons();

/** 生成包含 16/32/48 三种尺寸的 favicon.ico，兼容旧浏览器和搜索引擎抓取器。 */
async function renderIco() {
  const sizes = [16, 32, 48];
  const pngs = await Promise.all(sizes.map((size) => createIconPng(size)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (let index = 0; index < pngs.length; index += 1) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(sizes[index], 0);
    entry.writeUInt8(sizes[index], 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(pngs[index].length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += pngs[index].length;
  }
  await writeFile(join(publicDir, 'favicon.ico'), Buffer.concat([header, ...entries, ...pngs]));
  console.log('[seo-assets] favicon.ico 16/32/48');
}

/** 删除旧 SVG 图标资源，确保浏览器不会继续命中旧图标。 */
async function removeOldSvgIcons() {
  const oldFiles = ['favicon.svg', 'apple-touch-icon.svg', 'og-image.svg', 'og-image-source.svg'];
  for (const dir of frontendPublicDirs) {
    for (const file of oldFiles) {
      await rm(join(dir, file), { force: true });
    }
  }
}

/** 同步多端 favicon 资源，保证后台与用户端使用同一图标。 */
async function syncFrontendIcons() {
  const sharedFiles = [
    'favicon.ico',
    'favicon-16x16.png',
    'favicon-32x32.png',
    'favicon-48x48.png',
    'android-chrome-192x192.png',
    'android-chrome-512x512.png',
    'apple-touch-icon.png',
  ];
  for (const dir of frontendPublicDirs.slice(1)) {
    for (const file of sharedFiles) {
      await copyFile(join(publicDir, file), join(dir, file));
    }
  }
}
