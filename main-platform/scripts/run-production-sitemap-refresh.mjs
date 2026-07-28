#!/usr/bin/env node
/**
 * 本脚本在生产服务器刷新完整 sitemap 和图片/用户静态 SEO 页。
 *
 * 部署构建默认不再扫描全量公开图库；本脚本由服务器 cron 调用，直接写入
 * 1Panel 站点目录，避免每次前端部署都被大图库分页拖慢。
 */

import { open, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDistDir = process.env.WEB_DIST_DIR || '/data/1panel/www/sites/xanime.ink/index';
const lockPath = process.env.SITEMAP_LOCK_FILE || '/tmp/aiimage-sitemap-refresh.lock';
const logDir = process.env.SITEMAP_LOG_DIR || join(rootDir, 'local', 'logs');

await mkdir(logDir, { recursive: true });
const lock = await acquireLock();
try {
  console.log(`[sitemap-cron] 开始刷新完整 sitemap：${new Date().toISOString()}`);
  await runGenerator();
  console.log(`[sitemap-cron] 完成刷新完整 sitemap：${new Date().toISOString()}`);
} finally {
  await lock.close().catch(() => undefined);
  await rm(lockPath, { force: true }).catch(() => undefined);
}

/** 获取互斥锁，避免上一次图库扫描未结束时重复启动。 */
async function acquireLock() {
  try {
    return await open(lockPath, 'wx');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      console.log('[sitemap-cron] 已有刷新任务运行，本次跳过');
      process.exit(0);
    }
    throw error;
  }
}

/** 调用现有 SEO 生成器，强制进入完整 sitemap 模式并写入生产站点目录。 */
function runGenerator() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(rootDir, 'scripts', 'generate-web-route-html.mjs'), '--full-sitemap'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        WEB_DIST_DIR: webDistDir,
        SITEMAP_INCLUDE_GALLERY: 'true',
        SITEMAP_GALLERY_API: process.env.SITEMAP_GALLERY_API || 'http://127.0.0.1:6369/api/gallery',
      },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`完整 sitemap 生成失败，退出码 ${code}`));
    });
  });
}
