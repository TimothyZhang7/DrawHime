#!/usr/bin/env node
/**
 * 本脚本在生产服务器安装完整 sitemap 自动刷新 cron。
 *
 * 设计目标是把大图库分页扫描移出前端部署构建，由服务器定时直接刷新
 * `/data/1panel/www/sites/xanime.ink/index` 下的 sitemap、图片页和用户页。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

const cronPath = process.env.SITEMAP_CRON_FILE || '/etc/cron.d/aiimage-sitemap';
const rootDir = process.env.AIIMAGE_ROOT || '/v3';
const logDir = `${rootDir}/local/logs`;
const runNow = process.argv.includes('--run-now');
if (process.argv.includes('--help')) {
  console.log('用法：node scripts/install-production-sitemap-cron.mjs [--run-now]');
  console.log('生产默认写入 /etc/cron.d/aiimage-sitemap；本地测试可用 SITEMAP_CRON_FILE 指定输出文件。');
  process.exit(0);
}
if (process.platform === 'win32' && !process.env.SITEMAP_CRON_FILE) {
  console.error('Windows 本地不会写入 /etc/cron.d；如需测试请设置 SITEMAP_CRON_FILE。');
  process.exit(1);
}
const cronBody = `# 本文件由 /v3/scripts/install-production-sitemap-cron.mjs 生成。
# 每 6 小时刷新完整 sitemap 和公开图片/用户静态 SEO 页，避免部署阶段扫描大图库。
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

17 */6 * * * root /bin/bash -lc 'mkdir -p ${logDir}; cd ${rootDir} && node scripts/run-production-sitemap-refresh.mjs >> ${logDir}/sitemap-cron.log 2>&1'
`;

await mkdir(logDir, { recursive: true });
await mkdir(dirname(cronPath), { recursive: true });
await writeFile(cronPath, cronBody, { encoding: 'utf8', mode: 0o644 });
console.log(`[sitemap-cron] 已安装 cron：${cronPath}`);

if (runNow) {
  console.log('[sitemap-cron] 立即启动一次后台刷新');
  await runDetachedRefresh();
}

/** 立即后台启动一次刷新，部署后不用等到下一个 6 小时周期。 */
function runDetachedRefresh() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/bash', ['-lc', `cd ${rootDir} && nohup node scripts/run-production-sitemap-refresh.mjs >> ${logDir}/sitemap-cron.log 2>&1 &`], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}
