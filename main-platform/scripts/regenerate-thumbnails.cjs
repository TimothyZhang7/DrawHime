/**
 * 本文件用于生产补齐缺失缩略图。
 *
 * 约束：
 * - 默认只补缺失缩略图，不删除已有图片或旧缩略图。
 * - 生成缩略图通过 media-service 完成，当前默认只写本地媒体目录。
 *
 * 用法：
 *   cd /v3 && node scripts/regenerate-thumbnails.cjs --dry-run
 *   cd /v3 && node scripts/regenerate-thumbnails.cjs --limit=200
 *   cd /v3 && node scripts/regenerate-thumbnails.cjs --task-id=b_xxx
 */
const path = require('node:path');

const { PrismaClient } = loadPrismaClient();

/** 脚本入口：扫描 task_image_* 配置并补齐缺失缩略图。 */
async function main() {
  loadRuntimeEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL，请在 /v3 下运行或显式传入环境变量。');

  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const mediaUrl = args.mediaUrl || process.env.MEDIA_SERVICE_URL || 'http://127.0.0.1:3013';
  const serviceToken = process.env.WS_PROXY_TOKEN?.trim() ?? '';

  try {
    const configs = await readTaskImageConfigs(prisma, args.taskId);
    const limitedConfigs = args.limit > 0 ? configs.slice(0, args.limit) : configs;
    console.log(`找到 ${configs.length} 个任务图片记录，本次检查 ${limitedConfigs.length} 个。`);

    const stats = { ok: 0, missing: 0, generated: 0, skipped: 0, failed: 0 };
    for (const row of limitedConfigs) {
      const result = await handleTaskImageConfig(prisma, row, { ...args, mediaUrl, serviceToken });
      stats[result] += 1;
      const done = stats.ok + stats.missing + stats.generated + stats.skipped + stats.failed;
      if (done % 50 === 0 || result === 'failed') {
        console.log(`进度 ${done}/${limitedConfigs.length} ok=${stats.ok} missing=${stats.missing} generated=${stats.generated} skipped=${stats.skipped} failed=${stats.failed}`);
      }
    }
    console.log(`完成 ok=${stats.ok} missing=${stats.missing} generated=${stats.generated} skipped=${stats.skipped} failed=${stats.failed}`);
  } finally {
    await prisma.$disconnect();
  }
}

/** 读取任务图片配置；支持按单任务定位，避免生产排障时全表扫描。 */
async function readTaskImageConfigs(prisma, taskId) {
  if (taskId) {
    const row = await prisma.systemConfig.findUnique({
      where: { key: `task_image_${taskId}` },
      select: { key: true, value: true },
    });
    return row ? [row] : [];
  }
  return prisma.$queryRawUnsafe('SELECT `key`, value FROM system_configs WHERE `key` LIKE "task_image_%" ORDER BY `updated_at` DESC');
}

/** 处理单条任务图片配置，返回统计状态。 */
async function handleTaskImageConfig(prisma, row, options) {
  let data;
  try {
    data = JSON.parse(row.value);
  } catch {
    console.warn(`[skip] ${row.key} 配置不是合法 JSON`);
    return 'skipped';
  }

  const imageFilename = typeof data.imageFilename === 'string' ? data.imageFilename : '';
  const thumbnailFilename = typeof data.thumbnailFilename === 'string' ? data.thumbnailFilename : '';
  if (!isSafeImageFilename(imageFilename)) return 'skipped';

  if (!options.force && isSafeImageFilename(thumbnailFilename) && await mediaFileExists(options.mediaUrl, thumbnailFilename)) {
    return 'ok';
  }

  if (options.dryRun) {
    console.log(`[missing] ${row.key} image=${imageFilename} thumbnail=${thumbnailFilename || '-'}`);
    return 'missing';
  }

  try {
    const nextThumbnail = await generateThumbnail(options.mediaUrl, options.serviceToken, imageFilename);
    const nextValue = {
      ...data,
      thumbnailFilename: nextThumbnail,
    };

    await prisma.systemConfig.update({
      where: { key: row.key },
      data: { value: JSON.stringify(nextValue) },
    });
    console.log(`[fixed] ${row.key} thumbnail=${nextThumbnail}`);
    return 'generated';
  } catch (error) {
    console.warn(`[failed] ${row.key} image=${imageFilename} error=${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

/** 调用 media-service 判断文件是否可读；只看响应头，避免下载完整图片。 */
async function mediaFileExists(mediaUrl, filename) {
  const res = await fetch(`${mediaUrl}/media/files/${encodeURIComponent(filename)}`, {
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res) return false;
  await res.body?.cancel().catch(() => {});
  return res.ok;
}

/** 调用 media-service 生成缩略图，返回新缩略图短文件名。 */
async function generateThumbnail(mediaUrl, serviceToken, sourceFilename) {
  const res = await fetch(`${mediaUrl}/media/generate-thumbnail`, {
    method: 'POST',
    headers: serviceHeaders(serviceToken),
    body: JSON.stringify({ sourceFilename }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  const filename = data?.data?.filename;
  if (!res.ok || !data.ok || !isSafeImageFilename(filename)) {
    throw new Error(data?.message ?? `生成缩略图失败：${res.status}`);
  }
  return filename;
}

/** 读取命令行参数，默认稳妥执行。 */
function parseArgs(rawArgs) {
  const args = { dryRun: false, force: false, limit: 0, taskId: '', mediaUrl: '' };
  for (const raw of rawArgs) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--force') args.force = true;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(0, Number.parseInt(raw.slice('--limit='.length), 10) || 0);
    else if (raw.startsWith('--task-id=')) args.taskId = raw.slice('--task-id='.length).trim();
    else if (raw.startsWith('--media-url=')) args.mediaUrl = raw.slice('--media-url='.length).replace(/\/+$/, '');
    else throw new Error(`未知参数：${raw}`);
  }
  return args;
}

/** 服务间请求头；生产必须携带 token，本地未配置时兼容调试。 */
function serviceHeaders(serviceToken) {
  return {
    'content-type': 'application/json',
    ...(serviceToken ? { 'x-service-token': serviceToken } : {}),
  };
}

/** 从生产 ecosystem 读取运行时环境；不打印任何敏感配置。 */
function loadRuntimeEnv() {
  if (process.env.DATABASE_URL && process.env.WS_PROXY_TOKEN) return;
  const configPath = path.join(process.cwd(), 'ecosystem.config.js');
  let config;
  try {
    config = require(configPath);
  } catch {
    return;
  }
  const apps = Array.isArray(config.apps) ? config.apps : [];
  const backendEnv = apps.find((app) => app.name === 'v3-backend')?.env ?? {};
  const mediaEnv = apps.find((app) => app.name === 'v3-media')?.env ?? {};
  process.env.DATABASE_URL ||= backendEnv.DATABASE_URL;
  process.env.WS_PROXY_TOKEN ||= backendEnv.WS_PROXY_TOKEN ?? mediaEnv.WS_PROXY_TOKEN;
  const mediaPort = mediaEnv.MEDIA_PORT ?? mediaEnv.PORT ?? '3013';
  process.env.MEDIA_SERVICE_URL ||= `http://127.0.0.1:${mediaPort}`;
}

/** 兼容 pnpm workspace：脚本从根目录执行时优先复用 backend 的 Prisma Client。 */
function loadPrismaClient() {
  try {
    return require('@prisma/client');
  } catch {
    return require(path.join(process.cwd(), 'apps/backend/node_modules/@prisma/client'));
  }
}

/** 校验短文件名，避免脚本把异常配置传给媒体服务。 */
function isSafeImageFilename(filename) {
  return typeof filename === 'string'
    && /^[a-zA-Z0-9_.-]{1,128}$/.test(filename)
    && !filename.includes('..')
    && !filename.includes('/')
    && !filename.includes('\\');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
