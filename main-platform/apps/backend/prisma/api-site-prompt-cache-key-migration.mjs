/**
 * API 站点 prompt_cache_key 发送开关增量迁移脚本。
 *
 * 本脚本只给 api_sites 新增默认关闭的布尔列，不修改余额、任务、用户、图库、API Key 或现有站点行为。
 */
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;
const columnName = 'send_prompt_cache_key';
const sql = `ALTER TABLE api_sites ADD COLUMN ${columnName} BOOLEAN NOT NULL DEFAULT FALSE AFTER send_response_format`;

console.log('[api-site-prompt-cache-key-migration] 本脚本只新增默认关闭的 prompt_cache_key 发送开关，不修改任何业务数据。');
console.log(`[api-site-prompt-cache-key-migration] mode=${dryRun ? 'dry-run' : 'apply'}`);

if (await hasColumn(columnName)) {
  console.log(`OK_EXISTS: api_sites.${columnName}`);
} else if (dryRun) {
  console.log(`PLAN api_sites.${columnName}: ${sql};`);
} else {
  await applyMigration();
}

console.log(dryRun ? 'DONE: api site prompt cache key migration planned' : 'DONE: api site prompt cache key migration verified');

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
