/**
 * 本文件负责为图库聚合搜索补充可复跑索引。
 *
 * 只新增索引，不修改余额、用户、任务、图库、媒体、QQ 绑定或卡密数据。
 * 生产执行前必须先部署代码并使用 `--dry-run` 查看计划；正式执行使用 `--apply`。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

const indexes = [
  {
    table: 'generation_tasks',
    name: 'generation_tasks_gallery_public_created_idx',
    createSql: 'CREATE INDEX generation_tasks_gallery_public_created_idx ON generation_tasks (status, is_private, created_at)',
  },
  {
    table: 'generation_tasks',
    name: 'generation_tasks_gallery_mode_created_idx',
    createSql: 'CREATE INDEX generation_tasks_gallery_mode_created_idx ON generation_tasks (status, is_private, mode, created_at)',
  },
  {
    table: 'generation_tasks',
    name: 'generation_tasks_gallery_source_created_idx',
    createSql: 'CREATE INDEX generation_tasks_gallery_source_created_idx ON generation_tasks (status, is_private, source, created_at)',
  },
  {
    table: 'generation_tasks',
    name: 'generation_tasks_prompt_fulltext_idx',
    createSql: 'CREATE FULLTEXT INDEX generation_tasks_prompt_fulltext_idx ON generation_tasks (prompt)',
  },
  {
    table: 'generation_sub_tasks',
    name: 'generation_sub_tasks_gallery_model_site_idx',
    createSql: 'CREATE INDEX generation_sub_tasks_gallery_model_site_idx ON generation_sub_tasks (task_id, kind, model, site_name)',
  },
];

console.log('[gallery-search-indexes] 本脚本只新增图库搜索索引，不修改任何业务数据。');
console.log(`[gallery-search-indexes] mode=${dryRun ? 'dry-run' : 'apply'}`);

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
    // 生产索引变更必须显式执行，失败立即暴露，避免误以为搜索已走索引。
    await prisma.$executeRawUnsafe(index.createSql);
    console.log(`OK created ${index.table}.${index.name}`);
  }
} finally {
  await prisma.$disconnect();
}

/** 查询当前数据库是否已存在目标索引，确保脚本可安全复跑。 */
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
