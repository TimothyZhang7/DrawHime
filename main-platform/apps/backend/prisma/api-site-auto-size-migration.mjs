/**
 * API 站点 Auto 尺寸兼容开关增量迁移脚本。
 *
 * 本脚本只给 api_sites 新增默认关闭的布尔列，不删除或修改余额、任务、用户、图库、API Key 或现有站点配置。
 * 生产执行前先运行 `node apps/backend/prisma/api-site-auto-size-migration.mjs --dry-run` 查看计划；
 * 确认后运行 `node apps/backend/prisma/api-site-auto-size-migration.mjs --apply`。
 */
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;
const columnName = 'auto_size_from_reference';
const sql = `ALTER TABLE api_sites ADD COLUMN ${columnName} BOOLEAN NOT NULL DEFAULT FALSE AFTER response_format`;

console.log('[api-site-auto-size-migration] 本脚本只新增默认关闭的站点兼容开关，不修改任何业务数据。');
console.log(`[api-site-auto-size-migration] mode=${dryRun ? 'dry-run' : 'apply'}`);

if (await hasColumn(columnName)) {
  console.log(`OK_EXISTS: api_sites.${columnName}`);
} else if (dryRun) {
  console.log(`PLAN api_sites.${columnName}: ${sql};`);
} else {
  await applyMigration();
}

console.log(dryRun ? 'DONE: api site auto size migration planned' : 'DONE: api site auto size migration verified');

/** 执行幂等增量 DDL，并在连接异常后重新验证列是否已经创建。 */
async function applyMigration() {
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log(`OK_APPLIED: api_sites.${columnName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (await hasColumn(columnName)) {
      console.log(`OK_AFTER_RECONNECT: api_sites.${columnName}`);
      return;
    }
    console.error(`FAIL api_sites.${columnName}: ${message.slice(0, 300)}`);
    process.exitCode = 1;
    throw error;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  if (!await hasColumn(columnName)) throw new Error(`迁移验证失败：api_sites.${columnName}`);
}

/** 检查站点表目标列是否存在，保证迁移可安全复跑。 */
async function hasColumn(targetColumn) {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS total
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'api_sites'
        AND COLUMN_NAME = ${targetColumn}
    `;
    return Number(rows[0]?.total ?? 0) > 0;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
