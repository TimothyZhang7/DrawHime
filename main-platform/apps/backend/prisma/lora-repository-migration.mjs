/**
 * LoRA 仓库幂等迁移脚本。
 * 只维护 LoRA 条目、示例图、内容分类和主模型词表，不修改余额、绘图任务、图库或绑定数据。
 */
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();

const createStatements = [
  `CREATE TABLE IF NOT EXISTS lora_repository_items (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    base_model VARCHAR(128) NOT NULL DEFAULT 'anima',
    lora_type VARCHAR(24) NOT NULL DEFAULT 'style',
    status VARCHAR(16) NOT NULL DEFAULT 'draft',
    stored_name VARCHAR(160) NULL,
    original_file_name VARCHAR(255) NULL,
    file_size_bytes BIGINT NULL,
    sha256 CHAR(64) NULL,
    download_count INT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    published_at DATETIME(3) NULL,
    UNIQUE KEY lora_repository_items_stored_name_key (stored_name),
    KEY lora_repository_items_status_published_at_idx (status, published_at),
    KEY lora_repository_items_user_id_created_at_idx (user_id, created_at),
    KEY lora_repository_items_base_model_status_published_at_idx (base_model, status, published_at),
    KEY lora_repository_items_lora_type_status_published_at_idx (lora_type, status, published_at),
    CONSTRAINT lora_repository_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS lora_example_images (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    lora_id INT NOT NULL,
    stored_name VARCHAR(160) NOT NULL,
    width INT NOT NULL,
    height INT NOT NULL,
    size_bytes INT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY lora_example_images_stored_name_key (stored_name),
    KEY lora_example_images_lora_id_sort_order_idx (lora_id, sort_order),
    CONSTRAINT lora_example_images_lora_id_fkey FOREIGN KEY (lora_id) REFERENCES lora_repository_items(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS lora_base_models (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    display_name VARCHAR(64) NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_by_user_id INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY lora_base_models_name_key (name),
    KEY lora_base_models_is_system_display_name_idx (is_system, display_name),
    KEY lora_base_models_created_by_user_id_idx (created_by_user_id),
    CONSTRAINT lora_base_models_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  )`,
];

const dataStatements = [
  `INSERT INTO lora_base_models (name, display_name, is_system) VALUES ('anima', 'Anima', TRUE), ('krea2', 'Krea 2', TRUE)
   ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), is_system=TRUE`,
  `UPDATE lora_repository_items SET base_model='anima' WHERE LOWER(base_model) LIKE 'anima%'`,
  `UPDATE lora_repository_items SET base_model='krea2' WHERE LOWER(REPLACE(base_model, '-', '')) LIKE 'krea2%'`,
  `INSERT IGNORE INTO lora_base_models (name, display_name, is_system)
   SELECT DISTINCT base_model, base_model, FALSE FROM lora_repository_items WHERE base_model <> ''`,
];

console.log(`[lora-repository-migration] mode=${apply ? 'apply' : 'dry-run'}`);
try {
  if (apply) {
    for (const statement of createStatements) await prisma.$executeRawUnsafe(statement);
    await ensureColumn('lora_repository_items', 'lora_type', `ALTER TABLE lora_repository_items ADD COLUMN lora_type VARCHAR(24) NOT NULL DEFAULT 'style' AFTER base_model`);
    await ensureBaseModelColumn();
    await ensureIndex('lora_repository_items', 'lora_repository_items_lora_type_status_published_at_idx', `ALTER TABLE lora_repository_items ADD INDEX lora_repository_items_lora_type_status_published_at_idx (lora_type, status, published_at)`);
    for (const statement of dataStatements) await prisma.$executeRawUnsafe(statement);
    const tables = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('lora_repository_items','lora_example_images','lora_base_models')`);
    const columns = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lora_repository_items' AND COLUMN_NAME='lora_type'`);
    if (Number(tables[0]?.total ?? 0) !== 3 || Number(columns[0]?.total ?? 0) !== 1) throw new Error('LoRA 仓库结构验证失败');
    console.log('DONE: lora repository migration verified');
  } else {
    for (const statement of createStatements) console.log(`PLAN ${compact(statement)};`);
    console.log(`PLAN ALTER lora_repository_items ADD lora_type WHEN MISSING;`);
    console.log(`PLAN ALTER lora_repository_items base_model DEFAULT 'anima';`);
    console.log(`PLAN ADD lora_type INDEX WHEN MISSING;`);
    for (const statement of dataStatements) console.log(`PLAN ${compact(statement)};`);
  }
} finally {
  await prisma.$disconnect();
}

/** 缺少字段时执行一次安全增量变更。 */
async function ensureColumn(tableName, columnName, statement) {
  const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, tableName, columnName);
  if (Number(rows[0]?.total ?? 0) === 0) await prisma.$executeRawUnsafe(statement);
}

/** 缺少索引时执行一次安全增量变更。 */
async function ensureIndex(tableName, indexName, statement) {
  const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?`, tableName, indexName);
  if (Number(rows[0]?.total ?? 0) === 0) await prisma.$executeRawUnsafe(statement);
}

/** 仅在长度或默认值不一致时调整主模型字段，避免每次部署重建表。 */
async function ensureBaseModelColumn() {
  const rows = await prisma.$queryRawUnsafe(`SELECT CHARACTER_MAXIMUM_LENGTH AS maximumLength, COLUMN_DEFAULT AS columnDefault FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lora_repository_items' AND COLUMN_NAME='base_model' LIMIT 1`);
  const column = rows[0];
  if (Number(column?.maximumLength ?? 0) === 128 && String(column?.columnDefault ?? '') === 'anima') return;
  await prisma.$executeRawUnsafe(`ALTER TABLE lora_repository_items MODIFY COLUMN base_model VARCHAR(128) NOT NULL DEFAULT 'anima'`);
}

/** 压缩 dry-run SQL，保持部署日志可读。 */
function compact(statement) {
  return statement.replace(/\s+/g, ' ').trim();
}
