/**
 * 图库中文标签增量迁移脚本。
 *
 * 本脚本只新增标签字典、任务标签关联和自动打标任务表，不删除或修改用户、余额、任务、图片和流水数据。
 * 生产执行前先运行 `node apps/backend/prisma/gallery-tags-migration.mjs --dry-run` 查看计划；
 * 确认后运行 `node apps/backend/prisma/gallery-tags-migration.mjs --apply`。
 */
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

const operations = [
  {
    name: 'gallery_tags_table',
    sql: `CREATE TABLE IF NOT EXISTS gallery_tags (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(32) NOT NULL,
      slug VARCHAR(64) NOT NULL,
      category VARCHAR(24) NOT NULL,
      color_bg VARCHAR(16) NOT NULL,
      color_text VARCHAR(16) NOT NULL,
      color_border VARCHAR(16) NOT NULL,
      usage_count INT NOT NULL DEFAULT 0,
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY gallery_tags_name_key (name),
      UNIQUE KEY gallery_tags_slug_key (slug),
      KEY gallery_tags_category_disabled_idx (category, disabled)
    )`,
    verify: () => hasTable('gallery_tags'),
  },
  {
    name: 'generation_task_tags_table',
    sql: `CREATE TABLE IF NOT EXISTS generation_task_tags (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      task_id VARCHAR(64) NOT NULL,
      tag_id INT NOT NULL,
      weight INT NOT NULL,
      confidence DOUBLE NOT NULL DEFAULT 0,
      source VARCHAR(16) NOT NULL DEFAULT 'ai',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY generation_task_tags_task_id_tag_id_key (task_id, tag_id),
      KEY generation_task_tags_task_id_weight_idx (task_id, weight),
      KEY generation_task_tags_tag_id_weight_idx (tag_id, weight),
      CONSTRAINT generation_task_tags_task_id_fkey FOREIGN KEY (task_id) REFERENCES generation_tasks(id) ON DELETE CASCADE,
      CONSTRAINT generation_task_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES gallery_tags(id) ON DELETE CASCADE
    )`,
    verify: () => hasTable('generation_task_tags'),
  },
  {
    name: 'gallery_tagging_jobs_table',
    sql: `CREATE TABLE IF NOT EXISTS gallery_tagging_jobs (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      task_id VARCHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      attempt_count INT NOT NULL DEFAULT 0,
      error TEXT NULL,
      model VARCHAR(128) NULL,
      raw_result_json JSON NULL,
      started_at DATETIME(3) NULL,
      finished_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY gallery_tagging_jobs_task_id_key (task_id),
      KEY gallery_tagging_jobs_status_created_at_idx (status, created_at),
      CONSTRAINT gallery_tagging_jobs_task_id_fkey FOREIGN KEY (task_id) REFERENCES generation_tasks(id) ON DELETE CASCADE
    )`,
    verify: () => hasTable('gallery_tagging_jobs'),
  },
];

console.log('[gallery-tags-migration] 本脚本只新增图库标签相关表，不修改任何余额或任务状态数据。');
console.log(`[gallery-tags-migration] mode=${dryRun ? 'dry-run' : 'apply'}`);

for (const operation of operations) {
  await runOperation(operation);
}

console.log('DONE: gallery tags migration verified');

/** 执行一条幂等 DDL；生产迁移必须可复跑，避免部署中断后无法恢复。 */
async function runOperation(operation) {
  if (await operation.verify()) {
    console.log(`OK_EXISTS: ${operation.name}`);
    return;
  }
  if (dryRun) {
    console.log(`PLAN ${operation.name}: ${operation.sql.replace(/\s+/g, ' ').trim()};`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(operation.sql);
    console.log(`OK_APPLIED: ${operation.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (await operation.verify()) {
      console.log(`OK_AFTER_RECONNECT: ${operation.name}`);
      return;
    }
    console.error(`FAIL: ${operation.name}: ${message.slice(0, 300)}`);
    process.exitCode = 1;
    throw error;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  if (!await operation.verify()) {
    throw new Error(`迁移验证失败：${operation.name}`);
  }
}

/** 检查表是否存在。 */
async function hasTable(tableName) {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS total
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${tableName}
    `;
    return Number(rows[0]?.total ?? 0) > 0;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
