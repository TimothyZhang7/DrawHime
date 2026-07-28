/**
 * 本脚本幂等创建独立平台正式图库发布镜像表，不修改或删除现有任务、图库、媒体与余额数据。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

console.log(`[local-platform-gallery-migration] mode=${apply ? 'apply' : 'dry-run'}`);

try {
  if (apply) {
    await migrate();
    console.log('[local-platform-gallery-migration] done');
  } else {
    console.log('[local-platform-gallery-migration] dry-run 完成；正式执行请追加 --apply');
  }
} finally {
  await prisma.$disconnect();
}

/** 创建只新增数据的图库发布镜像表，重复执行不会覆盖既有发布记录。 */
async function migrate() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS local_platform_gallery_publications (
      id VARCHAR(36) NOT NULL,
      external_task_id VARCHAR(64) NOT NULL,
      artifact_id VARCHAR(64) NOT NULL,
      artifact_sha256 CHAR(64) NOT NULL,
      idempotency_key VARCHAR(191) NOT NULL,
      user_id INT NOT NULL,
      main_task_id VARCHAR(64) NULL,
      media_filename VARCHAR(128) NULL,
      thumbnail_filename VARCHAR(128) NULL,
      mime_type VARCHAR(64) NOT NULL,
      byte_size BIGINT NOT NULL,
      width INT NOT NULL,
      height INT NOT NULL,
      is_private BOOLEAN NOT NULL,
      effective_prompt LONGTEXT NOT NULL,
      model_display_name VARCHAR(191) NOT NULL,
      parameters JSON NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      error_message TEXT NULL,
      published_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY local_platform_gallery_idempotency_key (idempotency_key),
      UNIQUE KEY local_platform_gallery_external_hash_key (external_task_id, artifact_sha256),
      UNIQUE KEY local_platform_gallery_artifact_key (artifact_id),
      UNIQUE KEY local_platform_gallery_main_task_key (main_task_id),
      KEY local_platform_gallery_user_created_idx (user_id, created_at),
      KEY local_platform_gallery_status_created_idx (status, created_at),
      CONSTRAINT local_platform_gallery_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
