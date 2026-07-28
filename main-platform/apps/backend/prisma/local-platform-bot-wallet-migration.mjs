/**
 * 本脚本为独立平台计费和图库镜像补充 QQ 身份列，不迁移、合并或删除任何钱包、余额、任务和图库数据。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

console.log(`[local-platform-bot-wallet-migration] mode=${apply ? 'apply' : 'dry-run'}`);

try {
  if (apply) {
    await migrate();
    console.log('[local-platform-bot-wallet-migration] done');
  } else {
    console.log('[local-platform-bot-wallet-migration] dry-run 完成；正式执行请追加 --apply');
  }
} finally {
  await prisma.$disconnect();
}

/** 幂等放宽既有用户列并添加 QQ 主体列和查询索引。 */
async function migrate() {
  await prisma.$executeRawUnsafe('ALTER TABLE local_platform_billing_reservations MODIFY COLUMN user_id INT NULL');
  await addColumnIfMissing('local_platform_billing_reservations', 'qq_number', 'BIGINT NULL AFTER user_id');
  await addIndexIfMissing('local_platform_billing_reservations', 'local_platform_reservation_qq_created_idx', '(qq_number, created_at)');

  await prisma.$executeRawUnsafe('ALTER TABLE local_platform_gallery_publications MODIFY COLUMN user_id INT NULL');
  await addColumnIfMissing('local_platform_gallery_publications', 'qq_number', 'BIGINT NULL AFTER user_id');
  await addIndexIfMissing('local_platform_gallery_publications', 'local_platform_gallery_qq_created_idx', '(qq_number, created_at)');
}

/** 仅在目标列不存在时新增，避免重复部署覆盖生产数据。 */
async function addColumnIfMissing(tableName, columnName, definition) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) AS total FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    tableName,
    columnName,
  );
  if (Number(rows[0]?.total ?? 0) === 0) await prisma.$executeRawUnsafe(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
}

/** 仅在目标索引不存在时新增，保证迁移可以安全重放。 */
async function addIndexIfMissing(tableName, indexName, columns) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) AS total FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    tableName,
    indexName,
  );
  if (Number(rows[0]?.total ?? 0) === 0) await prisma.$executeRawUnsafe(`ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` ${columns}`);
}
