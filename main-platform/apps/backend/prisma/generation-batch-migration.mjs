/**
 * 多图生成批次增量迁移脚本。
 *
 * 用法：生产数据库已备份后执行 `node apps/backend/prisma/generation-batch-migration.mjs`。
 * 该脚本只新增批次表和任务批次字段，不删除任何用户、余额、任务、图片或流水数据。
 */
import { PrismaClient } from '@prisma/client';

const operations = [
  {
    name: 'generation_batches_table',
    sql: `CREATE TABLE IF NOT EXISTS generation_batches (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      client_request_id VARCHAR(96) NOT NULL,
      user_id INT NULL,
      qq_number BIGINT NULL,
      source VARCHAR(16) NOT NULL,
      mode VARCHAR(24) NOT NULL,
      prompt TEXT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      count INT NOT NULL,
      concurrency INT NOT NULL DEFAULT 1,
      stop_after_consecutive_failures INT NOT NULL DEFAULT 1,
      success_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      consecutive_failures INT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      finished_at DATETIME(3) NULL,
      UNIQUE KEY generation_batches_client_request_id_key (client_request_id),
      KEY generation_batches_user_id_created_at_idx (user_id, created_at),
      KEY generation_batches_qq_number_created_at_idx (qq_number, created_at),
      KEY generation_batches_status_created_at_idx (status, created_at)
    )`,
    verify: () => hasTable('generation_batches'),
  },
  {
    name: 'generation_tasks.batch_id',
    sql: `ALTER TABLE generation_tasks ADD COLUMN batch_id VARCHAR(64) NULL`,
    verify: () => hasColumn('generation_tasks', 'batch_id'),
  },
  {
    name: 'generation_tasks.batch_index',
    sql: `ALTER TABLE generation_tasks ADD COLUMN batch_index INT NULL`,
    verify: () => hasColumn('generation_tasks', 'batch_index'),
  },
  {
    name: 'generation_tasks.batch_total',
    sql: `ALTER TABLE generation_tasks ADD COLUMN batch_total INT NULL`,
    verify: () => hasColumn('generation_tasks', 'batch_total'),
  },
  {
    name: 'generation_tasks_batch_id_batch_index_idx',
    sql: `ALTER TABLE generation_tasks ADD INDEX generation_tasks_batch_id_batch_index_idx (batch_id, batch_index)`,
    verify: () => hasIndex('generation_tasks', 'generation_tasks_batch_id_batch_index_idx'),
  },
];

for (const operation of operations) {
  await runOperation(operation);
}

console.log('DONE: generation batch migration verified');

/** 执行一条幂等 DDL；MariaDB 可能在 DDL 后断开连接，因此失败后必须重新连接验证目标结构。 */
async function runOperation(operation) {
  if (await operation.verify()) {
    console.log(`OK_EXISTS: ${operation.name}`);
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
    if (isDuplicateSchemaError(message) && await operation.verify()) {
      console.log(`OK_DUPLICATE: ${operation.name}`);
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

/** 检查列是否存在。 */
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

/** 检查索引是否存在。 */
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

/** 判断重复表、重复列、重复索引这类幂等场景。 */
function isDuplicateSchemaError(message) {
  return /Duplicate column name|Duplicate key name|already exists/i.test(message);
}
