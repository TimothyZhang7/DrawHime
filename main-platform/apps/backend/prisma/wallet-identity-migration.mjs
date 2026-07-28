/**
 * 钱包身份模型增量迁移脚本。
 *
 * 用法：在已备份数据库后执行 `node prisma/wallet-identity-migration.mjs`。
 * 该脚本只新增表/字段并复制旧 QQ 余额，不删除 qq_quotas、用户、任务或卡密数据。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const statements = [
  `CREATE TABLE IF NOT EXISTS wallets (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    owner_type VARCHAR(16) NOT NULL,
    owner_key VARCHAR(64) NOT NULL,
    user_id INT NULL,
    free_balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    paid_balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY wallets_owner_type_owner_key_key (owner_type, owner_key),
    KEY wallets_user_id_idx (user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS wallet_links (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    qq_number BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    active_user_key VARCHAR(64) NULL,
    active_qq_key VARCHAR(64) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    unbound_at DATETIME(3) NULL,
    created_by_ip VARCHAR(45) NULL,
    unbound_by_ip VARCHAR(45) NULL,
    UNIQUE KEY wallet_links_active_user_key_key (active_user_key),
    UNIQUE KEY wallet_links_active_qq_key_key (active_qq_key),
    KEY wallet_links_user_id_status_idx (user_id, status),
    KEY wallet_links_qq_number_status_idx (qq_number, status)
  )`,
  `CREATE TABLE IF NOT EXISTS wallet_ledger (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    wallet_id INT NOT NULL,
    type VARCHAR(32) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    balance_kind VARCHAR(16) NOT NULL,
    source VARCHAR(16) NOT NULL,
    task_id VARCHAR(64) NULL,
    recharge_card_id INT NULL,
    metadata JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY wallet_ledger_wallet_id_created_at_idx (wallet_id, created_at),
    KEY wallet_ledger_task_id_idx (task_id),
    KEY wallet_ledger_recharge_card_id_idx (recharge_card_id)
  )`,
  `CREATE TABLE IF NOT EXISTS daily_free_grants (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    wallet_id INT NOT NULL,
    grant_date DATE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY daily_free_grants_wallet_id_grant_date_key (wallet_id, grant_date),
    KEY daily_free_grants_grant_date_idx (grant_date)
  )`,
  `CREATE TABLE IF NOT EXISTS task_charge_allocations (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL,
    wallet_id INT NOT NULL,
    free_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    paid_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    refunded_at DATETIME(3) NULL,
    UNIQUE KEY task_charge_allocations_task_id_wallet_id_key (task_id, wallet_id),
    KEY task_charge_allocations_wallet_id_idx (wallet_id)
  )`,
  `ALTER TABLE generation_tasks MODIFY qq_number BIGINT NULL`,
  `ALTER TABLE recharge_cards ADD COLUMN IF NOT EXISTS redeemed_wallet_id INT NULL`,
  `ALTER TABLE recharge_cards ADD INDEX IF NOT EXISTS recharge_cards_redeemed_wallet_id_idx (redeemed_wallet_id)`,
  `INSERT INTO wallets (owner_type, owner_key, user_id, free_balance, paid_balance, created_at, updated_at)
   SELECT 'qq', CAST(q.qq_number AS CHAR), NULL, q.free_balance, q.paid_balance, NOW(3), NOW(3)
   FROM qq_quotas q
   ON DUPLICATE KEY UPDATE owner_key = owner_key`,
  `INSERT INTO wallets (owner_type, owner_key, user_id, free_balance, paid_balance, created_at, updated_at)
   SELECT 'user', CAST(u.id AS CHAR), u.id, 0.00, 0.00, NOW(3), NOW(3)
   FROM users u
   ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
  `INSERT IGNORE INTO wallet_links (user_id, qq_number, status, active_user_key, active_qq_key, created_at)
   SELECT b.user_id, b.qq_number, 'active', CAST(b.user_id AS CHAR), CAST(b.qq_number AS CHAR), NOW(3)
   FROM qq_bindings b
   WHERE b.verified = 1 AND b.qq_number IS NOT NULL`,
  `INSERT IGNORE INTO daily_free_grants (wallet_id, grant_date, amount, created_at)
   SELECT w.id, DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR)), 0.00, NOW(3)
   FROM wallets w
   JOIN qq_quotas q ON w.owner_type = 'qq' AND w.owner_key = CAST(q.qq_number AS CHAR)
   WHERE q.free_balance > 0 OR q.paid_balance > 0`,
];

for (const sql of statements) {
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log('OK:', sql.replace(/\s+/g, ' ').slice(0, 110));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log('SKIP:', message.slice(0, 160));
  }
}

await prisma.$disconnect();
