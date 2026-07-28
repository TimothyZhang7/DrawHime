/**
 * 本文件为公开状态页和后台统计补充可复跑性能索引。
 *
 * 只新增索引，不修改余额、用户、任务状态、图片、QQ 绑定、卡密或媒体数据。
 * 生产执行前先使用 `--dry-run` 查看计划，正式执行必须显式传入 `--apply`。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

const indexes = [
  {
    table: 'generation_sub_tasks',
    name: 'generation_sub_tasks_status_runtime_idx',
    createSql: 'CREATE INDEX generation_sub_tasks_status_runtime_idx ON generation_sub_tasks (kind, status, created_at, site_id, latency_ms)',
  },
];

console.log('[status-performance-indexes] 本脚本只新增状态页/统计性能索引，不修改任何业务数据。');
console.log(`[status-performance-indexes] mode=${dryRun ? 'dry-run' : 'apply'}`);

try {
  for (const index of indexes) {
    const exists = await indexExists(index.table, index.name);
    if (exists) {
      console.log(`SKIP existing ${index.table}.${index.name}`);
      continue;
    }
    if (dryRun) {
      console.log(`PLAN ${index.createSql};`);
      continue;
    }
    // 索引创建失败必须直接暴露，避免误判状态页已经走优化索引。
    await prisma.$executeRawUnsafe(index.createSql);
    console.log(`OK created ${index.table}.${index.name}`);
  }
} finally {
  await prisma.$disconnect();
}

/** 查询目标索引是否已存在，保证脚本可重复执行。 */
async function indexExists(tableName, indexName) {
  const rows = await prisma.$queryRaw`
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = ${tableName}
      AND index_name = ${indexName}
    LIMIT 1
  `;
  return rows.length > 0;
}
