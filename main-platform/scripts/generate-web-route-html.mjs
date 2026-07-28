#!/usr/bin/env node
/**
 * 本脚本在用户端 Vite 构建后，为关键 SPA 路由生成独立 HTML 入口。
 *
 * 静态抓取器通常不会等待 React 运行时更新 document.title，因此必须让每个真实 URL
 * 在服务端直接返回绑定自身标题、说明、canonical 和 H1 的 HTML。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const includeGallerySitemap = args.has('--full-sitemap') || process.env.SITEMAP_INCLUDE_GALLERY === 'true';
const distDir = process.env.WEB_DIST_DIR ? resolve(process.env.WEB_DIST_DIR) : join(rootDir, 'apps', 'web-frontend', 'dist');
const siteName = '绘图姬 DrawHime';
const baseUrl = 'https://www.xanime.ink';
const defaultImage = `${baseUrl}/og-image.png`;
const galleryApiUrl = process.env.SITEMAP_GALLERY_API || 'http://127.0.0.1:6369/api/gallery';
const maxSitemapImages = Number(process.env.SITEMAP_MAX_IMAGES || '45000');
const imagePageWriteConcurrency = clampNumber(Number(process.env.SITEMAP_IMAGE_WRITE_CONCURRENCY || '64'), 1, 256);

const routes = [
  {
    path: '/',
    title: 'AI绘图生成',
    description: '在绘图姬 DrawHime 在线提交 AI 绘图和图生图任务，支持提示词、参考图、隐私状态和实时生成预览。',
    h1: 'AI绘图生成',
    lead: '使用提示词和参考图创建 AI 图片，登录后可查看实时生成进度和个人图库。',
    index: true,
    sitemap: true,
  },
  {
    path: '/gallery',
    title: '公开图库',
    description: '浏览绘图姬 DrawHime 公开 AI 图片作品，支持最新、热门、随机、文生图和图生图筛选。',
    h1: '公开图库',
    lead: '查看用户公开分享的 AI 绘图作品，发现图生图、文生图和参考图创作结果。',
    index: true,
    sitemap: true,
  },
  {
    path: '/workbench',
    title: '导航工作台',
    description: '在绘图姬 DrawHime 使用对话式工作台提交 AI 绘图任务，按当前模型、张数和隐私设置进入真实生成链路。',
    h1: '导航工作台',
    lead: '登录后通过对话输入提示词，并按当前模型、张数和隐私设置提交真实绘图任务。',
    index: false,
    sitemap: false,
  },
  {
    path: '/leaderboard',
    title: '排行榜',
    description: '查看绘图姬 DrawHime 用户任务排行榜，按 24 小时、7 天、30 天和全部时间统计主任务调用次数。',
    h1: '排行榜',
    lead: '查看用户主任务调用排行、成功失败统计和网页、Bot 等来源拆分。',
    index: true,
    sitemap: true,
  },
  {
    path: '/status',
    title: '服务状态',
    description: '查看绘图姬 DrawHime 后端、绘图站点、Bot、任务成功率和平台运行状态。',
    h1: '服务状态',
    lead: '查看平台服务、绘图站点、任务统计和 Bot 连接状态。',
    index: true,
    sitemap: true,
  },
  {
    path: '/tools',
    title: '工具',
    description: '绘图姬 DrawHime 工具中心，提供格式转换与压缩、图片拆分等 AI 绘图辅助工具。',
    h1: '工具',
    lead: '进入绘图姬工具中心，选择格式转换与压缩、图片拆分等辅助工具。',
    index: true,
    sitemap: true,
  },
  {
    path: '/tools/image-splitter',
    title: '图片拆分',
    description: '上传一张图片，按行列拆分为多张 PNG 图片，并在浏览器本地打包下载。',
    h1: '图片拆分',
    lead: '上传图片后设置行列数，预览拆分结果并下载切片压缩包。',
    index: true,
    sitemap: true,
  },
  {
    path: '/tools/image-converter',
    title: '格式转换与压缩',
    description: '批量转换 PNG、JPEG、WebP，并按质量、尺寸或目标体积在浏览器本地压缩。',
    h1: '格式转换与压缩',
    lead: '在同一个工具中批量转换图片格式、缩小最长边并控制 JPEG 或 WebP 文件体积。',
    index: true,
    sitemap: true,
  },
  {
    path: '/tools/image-scrambler',
    title: '图片混淆',
    description: '上传一张图片后，一键使用空间填充曲线完成混淆或解混淆。',
    h1: '图片混淆',
    lead: '在浏览器本地按空间填充曲线混淆图片，上传后点击按钮即可混淆、解混淆、还原和下载。',
    index: true,
    sitemap: true,
  },
  {
    path: '/tools/image-wobble',
    title: '局部抖动',
    description: '在浏览器本地涂抹图片区域，制作柔软弹跳、漂浮或颤动动画并录制导出。',
    h1: '局部抖动',
    lead: '上传静态图片，涂出需要活动的区域，在本地预览软体形变并录制为浏览器支持的视频格式。',
    index: true,
    sitemap: true,
  },
  {
    path: '/tools/image-upscale',
    title: '图片放大',
    description: '上传一张图片，调用本地 GPU 超分模型放大并增强细节。',
    h1: '图片放大',
    lead: '登录后上传单张图片，调用私有 GPU 图片超分服务放大并下载结果图。',
    index: false,
    sitemap: false,
  },
  {
    path: '/upscale/history',
    title: '放大记录',
    description: '查看当前账号的图片放大任务、持久化源图、运行进度和历史结果。',
    h1: '放大记录',
    lead: '登录后查看由后端持久化保存的图片放大源图、任务进度、结果和入图库状态。',
    index: false,
    sitemap: false,
  },
  {
    path: '/reverse',
    title: '图片反推',
    description: '上传一张图片，用 AI 识图模型提取完整风格、构图和可复用绘图提示词。',
    h1: '图片反推',
    lead: '登录后上传单张图片，提取图片主体、构图、画风、色彩光影和可复用绘图提示词。',
    index: false,
    sitemap: false,
  },
  {
    path: '/reverse/history',
    title: '反推记录',
    description: '查看当前账号的图片反推任务进度、源图和历史结果。',
    h1: '反推记录',
    lead: '登录后查看由后端持久化保存的图片反推进度与历史结果。',
    index: false,
    sitemap: false,
  },
  {
    path: '/login',
    title: '登录注册',
    description: '登录或注册绘图姬 DrawHime，使用 AI 绘图、图生图、个人图库和 Bot 绘图能力。',
    h1: '登录注册',
    lead: '登录绘图姬账号后可提交绘图任务、管理图片、绑定 Bot 和查看余额。',
    index: false,
    sitemap: false,
  },
  {
    path: '/forgot',
    title: '找回密码',
    description: '找回绘图姬 DrawHime 账号密码，继续使用 AI 绘图和个人图库。',
    h1: '找回密码',
    lead: '通过注册邮箱找回绘图姬账号密码。',
    index: false,
    sitemap: false,
  },
  {
    path: '/reset-password',
    title: '重置密码',
    description: '重置绘图姬 DrawHime 账号密码。',
    h1: '重置密码',
    lead: '设置新的绘图姬账号密码。',
    index: false,
    sitemap: false,
  },
  {
    path: '/verify-email',
    title: '邮箱验证',
    description: '验证绘图姬 DrawHime 账号邮箱，完成账号安全设置。',
    h1: '邮箱验证',
    lead: '完成邮箱验证后可继续使用账号安全相关功能。',
    index: false,
    sitemap: false,
  },
  {
    path: '/profile',
    title: '个人中心',
    description: '管理绘图姬 DrawHime 账号资料、QQ 绑定、邮箱验证、余额和隐私偏好。',
    h1: '个人中心',
    lead: '管理账号资料、QQ 绑定、余额、邮箱验证和默认隐私状态。',
    index: false,
    sitemap: false,
  },
  {
    path: '/recharge',
    title: '充值',
    description: '查看绘图姬 DrawHime 余额并兑换卡密或进入充值入口。',
    h1: '充值',
    lead: '查看余额、兑换卡密并管理绘图可用额度。',
    index: false,
    sitemap: false,
  },
  {
    path: '/bots',
    title: 'Bot 管理',
    description: '管理绘图姬 DrawHime Bot 连接、命令和群聊绘图能力。',
    h1: 'Bot 管理',
    lead: '配置 Bot 连接并管理群聊绘图能力。',
    index: false,
    sitemap: false,
  },
  {
    path: '/bots/add',
    title: '添加 Bot',
    description: '在绘图姬 DrawHime 添加 Bot 连接配置。',
    h1: '添加 Bot',
    lead: '新增 Bot 连接配置，用于接入 OneBotWS 绘图命令。',
    index: false,
    sitemap: false,
  },
  {
    path: '/personal/gallery',
    title: '我的图片',
    description: '查看和管理绘图姬 DrawHime 账号下的图片，支持批量删除、隐私切换和下载。',
    h1: '我的图片',
    lead: '管理个人生成图片，支持批量操作、下载和隐私状态切换。',
    index: false,
    sitemap: false,
  },
  {
    path: '/personal/generations',
    title: '生成记录',
    description: '查看绘图姬 DrawHime 账号下的生成任务状态、失败原因和历史记录。',
    h1: '生成记录',
    lead: '查看生成任务状态、耗时、失败原因和历史记录。',
    index: false,
    sitemap: false,
  },
  {
    path: '/templates',
    title: '模板',
    description: '管理和使用绘图姬 DrawHime 绘图模板。',
    h1: '模板',
    lead: '管理常用提示词模板并快速发起绘图任务。',
    index: false,
    sitemap: false,
  },
  {
    path: '/templates/new',
    title: '新建模板',
    description: '创建绘图姬 DrawHime 绘图模板，复用提示词和参数。',
    h1: '新建模板',
    lead: '创建可复用的绘图提示词模板。',
    index: false,
    sitemap: false,
  },
];

const rootHtml = await readFile(join(distDir, 'index.html'), 'utf8');
for (const route of routes) {
  const html = renderRouteHtml(rootHtml, route);
  const output = join(distDir, route.path.replace(/^\//, ''), 'index.html');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html, 'utf8');
  console.log(`[route-html] ${route.path}`);
}
await writeRedirectRoute('/generate', '/');
if (includeGallerySitemap) {
  const galleryImages = await fetchPublicGalleryImages();
  const publicUsers = collectPublicUsers(galleryImages);
  await cleanupDynamicSeoPages();
  await renderImagePages(galleryImages);
  await renderUserPages(publicUsers);
  await renderSitemap(galleryImages, publicUsers);
} else {
  // 部署构建阶段只生成固定路由，图库规模较大时完整 sitemap 由生产服务器定时任务异步刷新。
  await renderSitemap([], []);
  console.log('[sitemap] 已跳过公开图库扫描；生产完整 sitemap 由服务器定时任务刷新');
}

/** 完整刷新前清理旧动态 SEO 页，避免已删除或改私密的图片静态 HTML 残留。 */
async function cleanupDynamicSeoPages() {
  await Promise.all([
    rm(join(distDir, 'image'), { recursive: true, force: true }),
    rm(join(distDir, 'users'), { recursive: true, force: true }),
  ]);
}

/** 渲染指定路由的 HTML，保留 Vite 构建产物引用，只替换抓取器需要的头部和无脚本首屏文本。 */
function renderRouteHtml(template, route) {
  const pageTitle = `${route.title} - ${siteName}`;
  const url = `${baseUrl}${route.path}`;
  const shareImage = normalizeAbsoluteUrl(route.imageUrl) || defaultImage;
  const robots = route.index
    ? 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1'
    : 'noindex,nofollow';
  let html = template;
  html = replaceTag(html, /<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`);
  html = upsertMeta(html, 'name', 'description', route.description);
  html = upsertMeta(html, 'name', 'robots', robots);
  html = upsertMeta(html, 'name', 'googlebot', robots);
  html = upsertMeta(html, 'name', 'bingbot', robots);
  html = upsertMeta(html, 'property', 'og:title', pageTitle);
  html = upsertMeta(html, 'property', 'og:description', route.description);
  html = upsertMeta(html, 'property', 'og:url', url);
  html = upsertMeta(html, 'property', 'og:image', shareImage);
  html = upsertMeta(html, 'property', 'og:image:secure_url', shareImage);
  html = upsertMeta(html, 'name', 'twitter:title', pageTitle);
  html = upsertMeta(html, 'name', 'twitter:description', route.description);
  html = upsertMeta(html, 'name', 'twitter:image', shareImage);
  html = upsertLink(html, 'canonical', url);
  return replaceRootFallback(html, route);
}

/** 从 backend 公开图库接口分页读取可收录图片；接口自身已过滤私密、失败和断链图片。 */
async function fetchPublicGalleryImages() {
  const images = [];
  const pageSize = 50;
  for (let page = 1; images.length < maxSitemapImages; page += 1) {
    const url = new URL(galleryApiUrl);
    url.searchParams.set('sort', 'latest');
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));
    let payload;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sitemap] 公开图库读取失败，已生成静态页面 sitemap：${message}`);
      break;
    }
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
    for (const item of items) {
      if (typeof item.id === 'string') images.push(normalizeGalleryImage(item));
      if (images.length >= maxSitemapImages) break;
    }
    const hasMore = Boolean(payload?.data?.hasMore);
    const totalPages = Number(payload?.data?.totalPages || 0);
    if (!hasMore || (totalPages > 0 && page >= totalPages) || items.length === 0) break;
  }
  console.log(`[sitemap] image pages=${images.length}`);
  return images;
}

/** 标准化图库接口返回值，避免字段缺失导致生成脚本中断。 */
function normalizeGalleryImage(item) {
  const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
  return {
    id: item.id,
    userId: Number.isInteger(Number(item.userId)) && Number(item.userId) > 0 ? Number(item.userId) : null,
    authorName: typeof item.authorName === 'string' && item.authorName.trim() ? item.authorName.trim() : '',
    prompt,
    title: buildImageTitle(prompt, item.id),
    description: buildImageDescription(prompt),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : '',
  };
}

/** 从公开图库结果中收集有公开作品的 Web 用户，用于生成 /users/:id 固定主页入口。 */
function collectPublicUsers(images) {
  const map = new Map();
  for (const image of images) {
    if (!image.userId) continue;
    const current = map.get(image.userId);
    if (!current || new Date(image.createdAt).getTime() > new Date(current.latestImageAt).getTime()) {
      map.set(image.userId, {
        id: image.userId,
        name: image.authorName || `用户${image.userId}`,
        latestImageAt: image.createdAt,
      });
    }
  }
  const users = [...map.values()].sort((a, b) => a.id - b.id);
  console.log(`[sitemap] user pages=${users.length}`);
  return users;
}

/** 为每张图片生成独立 HTML 入口，解决 /image/:id 被抓取时标题和 H1 重复的问题。 */
async function renderImagePages(images) {
  for (let index = 0; index < images.length; index += imagePageWriteConcurrency) {
    const batch = images.slice(index, index + imagePageWriteConcurrency);
    await Promise.all(batch.map(async (image) => {
      const route = {
        path: `/image/${encodeURIComponent(image.id)}`,
        title: image.title,
        description: image.description,
        h1: image.title,
        lead: image.prompt || '查看绘图姬 DrawHime 公开 AI 图片作品详情。',
        imageUrl: image.imageUrl,
        index: true,
      };
      const html = renderRouteHtml(rootHtml, route);
      const output = join(distDir, 'image', image.id, 'index.html');
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, html, 'utf8');
    }));
  }
}

/** 为有公开作品的用户生成固定数字 ID 主页入口，避免直接访问时仍返回默认标题。 */
async function renderUserPages(users) {
  for (let index = 0; index < users.length; index += imagePageWriteConcurrency) {
    const batch = users.slice(index, index + imagePageWriteConcurrency);
    await Promise.all(batch.map(async (user) => {
      const route = {
        path: `/users/${encodeURIComponent(user.id)}`,
        title: `${user.name} 的主页`,
        description: `查看绘图姬 DrawHime 用户 ${user.name} 的公开主页、公开作品和公开图片统计。`,
        h1: `${user.name} 的主页`,
        lead: '查看该用户公开分享的 AI 图片作品、公开作品数量、点赞和浏览统计。',
        index: true,
      };
      const html = renderRouteHtml(rootHtml, route);
      const output = join(distDir, 'users', String(user.id), 'index.html');
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, html, 'utf8');
    }));
  }
}

/** 输出包含公开页面和公开图片详情页的 sitemap.xml。 */
async function renderSitemap(images, users) {
  const urls = [
    ...routes
      .filter((route) => route.sitemap)
      .map((route) => ({
        loc: route.path,
        lastmod: today(),
        changefreq: route.path === '/' ? 'daily' : route.path === '/gallery' || route.path === '/status' ? 'hourly' : 'monthly',
        priority: route.path === '/' ? '1.0' : route.path === '/gallery' ? '0.9' : '0.6',
      })),
    ...images.map((image) => ({
      loc: `/image/${encodeURIComponent(image.id)}`,
      lastmod: normalizeSitemapDate(image.createdAt),
      changefreq: 'monthly',
      priority: '0.6',
    })),
    ...users.map((user) => ({
      loc: `/users/${encodeURIComponent(user.id)}`,
      lastmod: normalizeSitemapDate(user.latestImageAt),
      changefreq: 'weekly',
      priority: '0.5',
    })),
  ];
  const seen = new Set();
  const uniqueUrls = urls.filter((item) => {
    if (seen.has(item.loc)) return false;
    seen.add(item.loc);
    return true;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- 本文件由 scripts/generate-web-route-html.mjs 生成；完整公开图片详情页由生产定时任务刷新。 -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${uniqueUrls.map(renderSitemapUrl).join('\n')}
</urlset>
`;
  await writeFile(join(distDir, 'sitemap.xml'), xml, 'utf8');
  console.log(`[sitemap] urls=${uniqueUrls.length}`);
}

/** 写入旧路由兼容跳转页；脚本跳转保留查询参数，meta 兜底给无脚本客户端。 */
async function writeRedirectRoute(fromPath, toPath) {
  const target = `${baseUrl}${toPath}`;
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex,nofollow" />
    <meta name="googlebot" content="noindex,nofollow" />
    <meta name="bingbot" content="noindex,nofollow" />
    <link rel="canonical" href="${escapeHtml(target)}" />
    <meta http-equiv="refresh" content="1;url=${escapeHtml(toPath)}" />
    <title>正在跳转 - ${siteName}</title>
    <script>
      // 旧入口只做兼容跳转，保留 prompt 等查询参数给首页绘图工作台消费。
      window.location.replace('${toPath}' + window.location.search + window.location.hash);
    </script>
  </head>
  <body>
    <main>
      <h1>正在跳转到 AI 绘图生成</h1>
      <p><a href="${escapeHtml(toPath)}">前往首页绘图工作台</a></p>
    </main>
  </body>
</html>
`;
  const output = join(distDir, fromPath.replace(/^\//, ''), 'index.html');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html, 'utf8');
  console.log(`[route-html] ${fromPath} -> ${toPath}`);
}

/** 渲染单个 sitemap URL 节点。 */
function renderSitemapUrl(item) {
  return `  <url>
    <loc>${escapeXml(`${baseUrl}${item.loc}`)}</loc>
    <lastmod>${escapeXml(item.lastmod)}</lastmod>
    <changefreq>${escapeXml(item.changefreq)}</changefreq>
    <priority>${escapeXml(item.priority)}</priority>
  </url>`;
}

/** 替换已有标签；如果模板异常则保持原内容并在后续检查中暴露。 */
function replaceTag(html, pattern, replacement) {
  return html.replace(pattern, replacement);
}

/** 写入 meta 标签，已有则替换，没有则插入到 head 结束前。 */
function upsertMeta(html, kind, key, value) {
  const escaped = escapeHtml(value);
  const pattern = new RegExp(`<meta\\s+${kind}="${escapeRegExp(key)}"[^>]*>`, 'i');
  const tag = `<meta ${kind}="${key}" content="${escaped}" />`;
  if (pattern.test(html)) return html.replace(pattern, tag);
  return html.replace('</head>', `    ${tag}\n  </head>`);
}

/** 写入 canonical 链接，保证每个生成的静态路由绑定自己的规范地址。 */
function upsertLink(html, rel, href) {
  const pattern = new RegExp(`<link\\s+rel="${escapeRegExp(rel)}"[^>]*>`, 'i');
  const tag = `<link rel="${rel}" href="${escapeHtml(href)}" />`;
  if (pattern.test(html)) return html.replace(pattern, tag);
  return html.replace('</head>', `    ${tag}\n  </head>`);
}

/** 替换 React 挂载点中的静态兜底文本，解决无脚本抓取器缺 H1 或内容不足的问题。 */
function replaceRootFallback(html, route) {
  const fallback = `    <div id="root">
      <main>
        <h1>${escapeHtml(route.h1)}</h1>
        <p>${escapeHtml(route.lead)}</p>
        <nav aria-label="主要页面">
          <a href="/">AI绘图生成</a>
          <a href="/gallery">公开图库</a>
          <a href="/leaderboard">排行榜</a>
          <a href="/tools">工具</a>
          <a href="/status">服务状态</a>
          <a href="/login">登录注册</a>
        </nav>
      </main>
    </div>`;
  return html.replace(/    <div id="root">[\s\S]*?    <\/div>\s*  <\/body>/, `${fallback}\n  </body>`);
}

/** 根据提示词生成唯一图片页标题，过长提示词会被截断以避免搜索标题异常。 */
function buildImageTitle(prompt, id) {
  const text = prompt.replace(/\s+/g, ' ').slice(0, 34);
  return text ? `${text} - AI图片作品` : `AI图片作品 ${id.slice(-8)}`;
}

/** 根据提示词生成图片页说明；无提示词时使用稳定站点说明。 */
function buildImageDescription(prompt) {
  const text = prompt.replace(/\s+/g, ' ').slice(0, 120);
  return text
    ? `查看绘图姬 DrawHime 公开 AI 图片作品：${text}`
    : '查看绘图姬 DrawHime 公开 AI 图片作品详情、提示词摘要和生成信息。';
}

/** sitemap lastmod 只保留日期，避免时区格式不稳定。 */
function normalizeSitemapDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? today() : parsed.toISOString().slice(0, 10);
}

/** 返回当前 UTC 日期，用于静态页面 lastmod。 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** 限制并发配置范围，避免环境变量误配导致构建阶段占用过高。 */
function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 将后端返回的站内图片路径转为绝对地址，供搜索引擎分享图字段使用。 */
function normalizeAbsoluteUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return '';
  }
}

/** HTML 文本转义，避免标题或说明破坏标签结构。 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** XML 文本转义，避免图片提示词或 URL 破坏 sitemap。 */
function escapeXml(value) {
  return escapeHtml(value).replace(/'/g, '&apos;');
}

/** 正则文本转义，用于安全构造标签匹配表达式。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
