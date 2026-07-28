/**
 * 本脚本负责为 Web 用户头像增加本地文件名字段。
 *
 * 约束：
 * - 只给 users 表新增 avatar_filename，可重复执行。
 * - 不修改余额、任务、图库、QQ 绑定、卡密、token 或媒体归档状态。
 * - 头像文件仍由 backend 写入本地 USER_AVATAR_STORAGE_PATH，不进入对象存储。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

console.log(`[user-avatar-migration] mode=${apply ? 'apply' : 'dry-run'}`);
console.log('[user-avatar-migration] 本脚本只新增 users.avatar_filename，不修改余额、任务、图库、QQ 绑定、卡密或 token 数据。');

try {
  if (!apply) {
    console.log('[user-avatar-migration] dry-run 完成；正式执行请追加 --apply');
  } else {
    await migrate();
    console.log('[user-avatar-migration] done');
  }
} finally {
  await prisma.$disconnect();
}

/** 幂等新增用户头像字段，避免生产重复执行时报错。 */
async function migrate() {
  const rows = await prisma.$queryRaw`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'avatar_filename'
  `;
  if (Array.isArray(rows) && rows.length > 0) {
    console.log('[user-avatar-migration] users.avatar_filename already exists');
    return;
  }
  await prisma.$executeRawUnsafe('ALTER TABLE users ADD COLUMN avatar_filename VARCHAR(128) NULL');
  console.log('[user-avatar-migration] users.avatar_filename added');
}
