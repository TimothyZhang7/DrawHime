#!/usr/bin/env node
/**
 * 本脚本向 IndexNow 端点提交用户端公开页面，部署后用于加速 Bing、Yandex 等支持方发现更新。
 * 注意：脚本只提交公开 URL，不提交登录后页面，且不能保证搜索引擎一定收录。
 */

const host = process.env.INDEXNOW_HOST || 'www.xanime.ink';
const key = process.env.INDEXNOW_KEY || '3950beb2b582405489863d10fd684b50';
const keyLocation = process.env.INDEXNOW_KEY_LOCATION || `https://${host}/${key}.txt`;
const endpoint = process.env.INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow';
const urls = [
  `https://${host}/`,
  `https://${host}/generate`,
  `https://${host}/gallery`,
  `https://${host}/leaderboard`,
  `https://${host}/tools`,
  `https://${host}/tools/image-splitter`,
  `https://${host}/tools/image-converter`,
  `https://${host}/tools/image-scrambler`,
  `https://${host}/status`,
  `https://${host}/sitemap.xml`,
];

/** 提交 IndexNow 请求，失败时返回非零退出码，便于部署脚本感知。 */
async function main() {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key, keyLocation, urlList: urls }),
  });
  const body = await response.text();
  if (!response.ok && response.status !== 202) {
    console.error(`[indexnow] 提交失败 status=${response.status} body=${body.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`[indexnow] 已提交 ${urls.length} 个 URL，status=${response.status}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[indexnow] 提交异常：${message}`);
  process.exit(1);
});
