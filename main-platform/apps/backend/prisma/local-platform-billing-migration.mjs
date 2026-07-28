/**
 * 本脚本幂等创建独立本地模型平台价格、资金预留和退款分账表。
 *
 * 该迁移只新增表和外键，不读取、迁移、合并或删除现有用户、钱包、余额、任务、图库与卡密数据。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

console.log(`[local-platform-billing-migration] mode=${apply ? 'apply' : 'dry-run'}`);

try {
  if (!apply) {
    console.log('[local-platform-billing-migration] dry-run 完成；正式执行请追加 --apply');
  } else {
    await migrate();
    console.log('[local-platform-billing-migration] done');
  }
} finally {
  await prisma.$disconnect();
}

/** 按依赖顺序创建价格、预留和分账表，重复执行不会覆盖已有数据。 */
async function migrate() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS local_platform_price_versions (
      id INT NOT NULL AUTO_INCREMENT,
      product_code VARCHAR(128) NOT NULL,
      pricing_version INT NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL,
      billing_unit VARCHAR(32) NOT NULL DEFAULT 'image',
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY local_platform_price_product_version_key (product_code, pricing_version),
      KEY local_platform_price_active_product_idx (active, product_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS local_platform_billing_reservations (
      id VARCHAR(36) NOT NULL,
      external_task_id VARCHAR(64) NOT NULL,
      idempotency_key VARCHAR(191) NOT NULL,
      commit_idempotency_key VARCHAR(191) NULL,
      release_idempotency_key VARCHAR(191) NULL,
      user_id INT NOT NULL,
      price_version_id INT NOT NULL,
      quantity DECIMAL(12,3) NOT NULL,
      reserved_amount DECIMAL(10,2) NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      status VARCHAR(16) NOT NULL DEFAULT 'reserved',
      expires_at DATETIME(3) NULL,
      committed_at DATETIME(3) NULL,
      released_at DATETIME(3) NULL,
      release_reason VARCHAR(500) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY local_platform_reservation_external_task_key (external_task_id),
      UNIQUE KEY local_platform_reservation_idempotency_key (idempotency_key),
      UNIQUE KEY local_platform_reservation_commit_key (commit_idempotency_key),
      UNIQUE KEY local_platform_reservation_release_key (release_idempotency_key),
      KEY local_platform_reservation_user_created_idx (user_id, created_at),
      KEY local_platform_reservation_status_expiry_idx (status, expires_at),
      CONSTRAINT local_platform_reservation_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT local_platform_reservation_price_fkey FOREIGN KEY (price_version_id) REFERENCES local_platform_price_versions(id) ON DELETE RESTRICT ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS local_platform_billing_allocations (
      id INT NOT NULL AUTO_INCREMENT,
      reservation_id VARCHAR(36) NOT NULL,
      wallet_id INT NOT NULL,
      free_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      paid_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      released_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY local_platform_allocation_reservation_wallet_key (reservation_id, wallet_id),
      KEY local_platform_allocation_wallet_idx (wallet_id),
      CONSTRAINT local_platform_allocation_reservation_fkey FOREIGN KEY (reservation_id) REFERENCES local_platform_billing_reservations(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT local_platform_allocation_wallet_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
