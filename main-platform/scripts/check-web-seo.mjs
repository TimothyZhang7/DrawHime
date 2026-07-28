#!/usr/bin/env node
/**
 * 本脚本校验用户端 SEO 静态产物是否齐全，部署前可快速发现 robots、sitemap、manifest 或分享图缺失。
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'apps', 'web-frontend', 'dist');
const requiredFiles = [
  'index.html',
  'robots.txt',
  'sitemap.xml',
  'site.webmanifest',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon-48x48.png',
  'og-image.png',
  'apple-touch-icon.png',
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
  '3950beb2b582405489863d10fd684b50.txt',
];

const requiredIndexSnippets = [
  '<title>AI绘图生成 - 绘图姬 DrawHime</title>',
  'meta name="description"',
  'meta name="robots" content="index,follow',
  'property="og:image" content="https://www.xanime.ink/og-image.png"',
  'name="twitter:card" content="summary_large_image"',
  'application/ld+json',
  'link rel="canonical" href="https://www.xanime.ink/"',
  'link rel="manifest" href="/site.webmanifest"',
  'rel="icon" type="image/png" sizes="32x32"',
  '<h1>AI绘图生成</h1>',
];

const requiredRoutePages = [
  { file: 'generate/index.html', title: '<title>正在跳转 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/"', h1: '<h1>正在跳转到 AI 绘图生成</h1>', robots: 'content="noindex,nofollow' },
  { file: 'gallery/index.html', title: '<title>公开图库 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/gallery"', h1: '<h1>公开图库</h1>', robots: 'content="index,follow' },
  { file: 'status/index.html', title: '<title>服务状态 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/status"', h1: '<h1>服务状态</h1>', robots: 'content="index,follow' },
  { file: 'tools/index.html', title: '<title>工具 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/tools"', h1: '<h1>工具</h1>', robots: 'content="index,follow' },
  { file: 'tools/image-splitter/index.html', title: '<title>图片拆分 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/tools/image-splitter"', h1: '<h1>图片拆分</h1>', robots: 'content="index,follow' },
  { file: 'tools/image-converter/index.html', title: '<title>格式转换与压缩 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/tools/image-converter"', h1: '<h1>格式转换与压缩</h1>', robots: 'content="index,follow' },
  { file: 'tools/image-scrambler/index.html', title: '<title>图片混淆 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/tools/image-scrambler"', h1: '<h1>图片混淆</h1>', robots: 'content="index,follow' },
  { file: 'tools/image-upscale/index.html', title: '<title>图片放大 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/tools/image-upscale"', h1: '<h1>图片放大</h1>', robots: 'content="noindex,nofollow' },
  { file: 'upscale/history/index.html', title: '<title>放大记录 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/upscale/history"', h1: '<h1>放大记录</h1>', robots: 'content="noindex,nofollow' },
  { file: 'reverse/index.html', title: '<title>图片反推 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/reverse"', h1: '<h1>图片反推</h1>', robots: 'content="noindex,nofollow' },
  { file: 'login/index.html', title: '<title>登录注册 - 绘图姬 DrawHime</title>', canonical: 'href="https://www.xanime.ink/login"', h1: '<h1>登录注册</h1>', robots: 'content="noindex,nofollow' },
];

/** 断言文件存在。 */
async function assertFile(file) {
  await access(join(distDir, file));
}

/** 断言文本包含指定片段。 */
function assertIncludes(text, snippet, label) {
  if (!text.includes(snippet)) {
    throw new Error(`${label} 缺少片段：${snippet}`);
  }
}

for (const file of requiredFiles) await assertFile(file);
const indexHtml = await readFile(join(distDir, 'index.html'), 'utf8');
for (const snippet of requiredIndexSnippets) assertIncludes(indexHtml, snippet, 'index.html');

for (const page of requiredRoutePages) {
  const html = await readFile(join(distDir, page.file), 'utf8');
  assertIncludes(html, page.title, page.file);
  assertIncludes(html, page.canonical, page.file);
  assertIncludes(html, page.h1, page.file);
  assertIncludes(html, page.robots, page.file);
}

const robots = await readFile(join(distDir, 'robots.txt'), 'utf8');
assertIncludes(robots, 'Sitemap: https://www.xanime.ink/sitemap.xml', 'robots.txt');
assertIncludes(robots, 'Disallow: /api/', 'robots.txt');
assertIncludes(robots, 'Allow: /generate', 'robots.txt');
assertIncludes(robots, 'Allow: /tools', 'robots.txt');
assertIncludes(robots, 'Allow: /reverse', 'robots.txt');
assertIncludes(robots, 'Allow: /image/', 'robots.txt');

const sitemap = await readFile(join(distDir, 'sitemap.xml'), 'utf8');
assertIncludes(sitemap, '<loc>https://www.xanime.ink/</loc>', 'sitemap.xml');
assertIncludes(sitemap, '<loc>https://www.xanime.ink/gallery</loc>', 'sitemap.xml');
assertIncludes(sitemap, '<loc>https://www.xanime.ink/tools</loc>', 'sitemap.xml');
assertIncludes(sitemap, '<loc>https://www.xanime.ink/tools/image-splitter</loc>', 'sitemap.xml');
assertIncludes(sitemap, '<loc>https://www.xanime.ink/tools/image-converter</loc>', 'sitemap.xml');
assertIncludes(sitemap, '<loc>https://www.xanime.ink/tools/image-scrambler</loc>', 'sitemap.xml');
assertExcludes(sitemap, '<loc>https://www.xanime.ink/generate</loc>', 'sitemap.xml');
assertExcludes(sitemap, '<loc>https://www.xanime.ink/tools/image-upscale</loc>', 'sitemap.xml');
assertExcludes(sitemap, '<loc>https://www.xanime.ink/upscale/history</loc>', 'sitemap.xml');
assertExcludes(sitemap, '<loc>https://www.xanime.ink/reverse</loc>', 'sitemap.xml');
assertExcludes(sitemap, '<loc>https://www.xanime.ink/login</loc>', 'sitemap.xml');
assertExcludes(sitemap, '<loc>https://www.xanime.ink/forgot</loc>', 'sitemap.xml');
assertExcludes(sitemap, '<loc>https://www.xanime.ink/verify-email</loc>', 'sitemap.xml');

console.log('[seo-check] 用户端 SEO 静态产物检查通过');

/** 断言文本不包含指定片段，避免功能页进入公开索引清单。 */
function assertExcludes(text, snippet, label) {
  if (text.includes(snippet)) {
    throw new Error(`${label} 不应包含片段：${snippet}`);
  }
}
