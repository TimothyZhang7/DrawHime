/**
 * 图片放大异步任务持久化迁移脚本。
 *
 * 本脚本新增或补齐 image_upscale_jobs 表，用于保存图片放大工具任务状态、私有源图引用和结果引用。
 * 私有源图文件保存在 /v3/local，数据库只保存安全短文件名；不修改余额、图库、QQ 绑定或卡密数据。
 * 生产执行前先运行 `node apps/backend/prisma/image-upscale-jobs-migration.mjs --dry-run` 查看计划；
 * 确认后运行 `node apps/backend/prisma/image-upscale-jobs-migration.mjs --apply`。
 */
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

const operations = [
  {
    name: 'image_upscale_jobs_table',
    sql: `CREATE TABLE IF NOT EXISTS image_upscale_jobs (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      progress_text VARCHAR(128) NOT NULL DEFAULT '已提交，等待 GPU 队列',
      source_file_name VARCHAR(255) NOT NULL,
      source_stored_name VARCHAR(128) NULL,
      preview_stored_name VARCHAR(128) NULL,
      source_mime_type VARCHAR(64) NULL,
      source_size_bytes BIGINT NOT NULL,
      source_width INT NULL,
      source_height INT NULL,
      scale INT NOT NULL,
      model VARCHAR(128) NOT NULL,
      output_format VARCHAR(16) NOT NULL DEFAULT 'webp',
      save_to_library BOOLEAN NOT NULL DEFAULT FALSE,
      is_private BOOLEAN NULL,
      result_json JSON NULL,
      error TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      started_at DATETIME(3) NULL,
      finished_at DATETIME(3) NULL,
      UNIQUE KEY image_upscale_jobs_source_stored_name_key (source_stored_name),
      UNIQUE KEY image_upscale_jobs_preview_stored_name_key (preview_stored_name),
      KEY image_upscale_jobs_user_id_created_at_idx (user_id, created_at),
      KEY image_upscale_jobs_status_updated_at_idx (status, updated_at),
      CONSTRAINT image_upscale_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    verify: () => hasTable('image_upscale_jobs'),
  },
  createColumnOperation('image_upscale_jobs_source_stored_name_column', 'source_stored_name', 'VARCHAR(128) NULL AFTER source_file_name'),
  createColumnOperation('image_upscale_jobs_preview_stored_name_column', 'preview_stored_name', 'VARCHAR(128) NULL AFTER source_stored_name'),
  createColumnOperation('image_upscale_jobs_source_mime_type_column', 'source_mime_type', 'VARCHAR(64) NULL AFTER preview_stored_name'),
  createColumnOperation('image_upscale_jobs_source_width_column', 'source_width', 'INT NULL AFTER source_size_bytes'),
  createColumnOperation('image_upscale_jobs_source_height_column', 'source_height', 'INT NULL AFTER source_width'),
  createColumnOperation('image_upscale_jobs_is_private_column', 'is_private', 'BOOLEAN NULL AFTER save_to_library'),
  createIndexOperation('image_upscale_jobs_source_stored_name_key', 'source_stored_name'),
  createIndexOperation('image_upscale_jobs_preview_stored_name_key', 'preview_stored_name'),
];

console.log('[image-upscale-jobs-migration] 本脚本只补齐图片放大任务与私有源图引用，不修改任何余额或图库数据。');
console.log(`[image-upscale-jobs-migration] mode=${dryRun ? 'dry-run' : 'apply'}`);

for (const operation of operations) {
  await runOperation(operation);
}

console.log(dryRun ? 'DONE: image upscale jobs migration planned' : 'DONE: image upscale jobs migration verified');

/** 执行幂等 DDL；生产迁移允许重复运行，避免中断后无法恢复。 */
async function runOperation(operation) {
  const exists = await operation.verify().catch((error) => {
    if (!dryRun) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`SKIP_VERIFY ${operation.name}: ${message.slice(0, 160)}`);
    return false;
  });
  if (exists) {
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

/** 检查目标表是否存在。 */
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

/** 创建幂等新增列操作；旧记录保留 NULL，不回写或删除任何任务数据。 */
function createColumnOperation(name, columnName, definition) {
  return {
    name,
    sql: `ALTER TABLE image_upscale_jobs ADD COLUMN ${columnName} ${definition}`,
    verify: () => hasColumn('image_upscale_jobs', columnName),
  };
}

/** 创建私有源图短文件名唯一索引，NULL 兼容迁移前的历史任务。 */
function createIndexOperation(indexName, columnName) {
  return {
    name: indexName,
    sql: `ALTER TABLE image_upscale_jobs ADD UNIQUE INDEX ${indexName} (${columnName})`,
    verify: () => hasIndex('image_upscale_jobs', indexName),
  };
}

/** 检查目标列是否存在。 */
async function hasColumn(tableName, columnName) {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS total
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${tableName}
        AND COLUMN_NAME = ${columnName}
    `;
    return Number(rows[0]?.total ?? 0) > 0;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

/** 检查目标索引是否存在。 */
async function hasIndex(tableName, indexName) {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS total
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${tableName}
        AND INDEX_NAME = ${indexName}
    `;
    return Number(rows[0]?.total ?? 0) > 0;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
