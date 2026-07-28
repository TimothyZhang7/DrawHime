/**
 * 本脚本负责创建邀请奖励基础表。
 *
 * 约束：
 * - 只新增 user_invite_codes 与 user_referrals，不修改用户、钱包、任务、图库或卡密数据。
 * - 生产执行前必须先备份 users、wallets、wallet_ledger、system_configs。
 * - 脚本可重复执行，CREATE TABLE/INDEX 使用 IF NOT EXISTS 语义。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

console.log(`[referral-migration] mode=${apply ? 'apply' : 'dry-run'}`);
console.log('[referral-migration] 本脚本只新增邀请表，不修改余额、用户、图库、任务、QQ 绑定、卡密或 token 数据。');

try {
  if (!apply) {
    console.log('[referral-migration] dry-run 完成；正式执行请追加 --apply');
  } else {
    await migrate();
    console.log('[referral-migration] done');
  }
} finally {
  await prisma.$disconnect();
}

async function migrate() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS user_invite_codes (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      code VARCHAR(16) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      disabled_at DATETIME(3) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY user_invite_codes_user_id_key (user_id),
      UNIQUE KEY user_invite_codes_code_key (code),
      KEY user_invite_codes_code_disabled_at_idx (code, disabled_at),
      CONSTRAINT user_invite_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS user_referrals (
      id INT NOT NULL AUTO_INCREMENT,
      invitee_user_id INT NOT NULL,
      inviter_user_id INT NOT NULL,
      invite_code VARCHAR(16) NOT NULL,
      source VARCHAR(16) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending_email',
      inviter_reward_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      invitee_reward_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      rewarded_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY user_referrals_invitee_user_id_key (invitee_user_id),
      KEY user_referrals_inviter_user_id_status_idx (inviter_user_id, status),
      KEY user_referrals_status_created_at_idx (status, created_at),
      CONSTRAINT user_referrals_invitee_user_id_fkey FOREIGN KEY (invitee_user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT user_referrals_inviter_user_id_fkey FOREIGN KEY (inviter_user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
