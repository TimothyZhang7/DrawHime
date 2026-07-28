/**
 * 用户全站背景图显示偏好增量迁移脚本。
 *
 * 本脚本只给 users 新增默认开启的布尔列，不修改余额、任务、图库、绑定或其他用户资料。
 */
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;
const columnName = 'site_background_enabled';
const sql = `ALTER TABLE users ADD COLUMN ${columnName} BOOLEAN NOT NULL DEFAULT TRUE AFTER default_image_private`;

console.log('[user-site-background-migration] 本脚本只新增用户背景图显示偏好，不修改其他业务数据。');
console.log(`[user-site-background-migration] mode=${dryRun ? 'dry-run' : 'apply'}`);

if (await hasColumn(columnName)) {
  console.log(`OK_EXISTS: users.${columnName}`);
} else if (dryRun) {
  console.log(`PLAN users.${columnName}: ${sql};`);
} else {
  await applyMigration();
}

console.log(dryRun ? 'DONE: user site background migration planned' : 'DONE: user site background migration verified');

/** 执行幂等增量 DDL，并在连接异常后重新验证目标列。 */
async function applyMigration() {
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log(`OK_APPLIED: users.${columnName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (await hasColumn(columnName)) {
      console.log(`OK_AFTER_RECONNECT: users.${columnName}`);
      return;
    }
    console.error(`FAIL users.${columnName}: ${message.slice(0, 300)}`);
    process.exitCode = 1;
    throw error;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  if (!await hasColumn(columnName)) throw new Error(`迁移验证失败：users.${columnName}`);
}

/** 检查 users 目标列是否存在，保证迁移可安全复跑。 */
async function hasColumn(targetColumn) {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS total
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME = ${targetColumn}
    `;
    return Number(rows[0]?.total ?? 0) > 0;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
