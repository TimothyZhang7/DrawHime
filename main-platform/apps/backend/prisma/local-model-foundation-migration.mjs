/**
 * 本地模型基础表增量迁移脚本。
 *
 * 用法：
 * - 预览：node prisma/local-model-foundation-migration.mjs --dry-run
 * - 执行：node prisma/local-model-foundation-migration.mjs --apply
 *
 * 该脚本只新增本地模型相关表和索引，不修改余额、用户、图库、任务、媒体、QQ 绑定、卡密或 token 数据。
 * 生产执行前必须先在 /v3/backups 下备份受影响表；禁止用 prisma db push 替代本脚本。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

const backupTables = [
  'system_configs',
  'module_configs',
  'generation_tasks',
  'generation_sub_tasks',
  'api_sites',
  'local_inference_hosts',
  'local_model_providers',
  'local_models',
  'local_model_files',
  'local_node_catalog',
  'local_workflow_templates',
  'local_workflow_template_versions',
  'local_runs',
  'local_run_nodes',
  'local_run_artifacts',
];

const statements = [
  {
    label: 'local_inference_hosts',
    sql: `CREATE TABLE IF NOT EXISTS local_inference_hosts (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      host_key VARCHAR(64) NOT NULL,
      name VARCHAR(128) NOT NULL,
      service_url VARCHAR(512) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      accepts_new_tasks TINYINT(1) NOT NULL DEFAULT 1,
      max_concurrency INT NOT NULL DEFAULT 1,
      queue_weight INT NOT NULL DEFAULT 1,
      status VARCHAR(24) NOT NULL DEFAULT 'unconfigured',
      last_health_at DATETIME(3) NULL,
      last_error TEXT NULL,
      metadata_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY local_inference_hosts_host_key_key (host_key),
      KEY local_inference_hosts_enabled_accepts_new_tasks_idx (enabled, accepts_new_tasks),
      KEY local_inference_hosts_status_last_health_at_idx (status, last_health_at)
    )`,
  },
  {
    label: 'local_model_providers',
    sql: `CREATE TABLE IF NOT EXISTS local_model_providers (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      host_id INT NOT NULL,
      provider_key VARCHAR(64) NOT NULL,
      type VARCHAR(32) NOT NULL,
      label VARCHAR(128) NOT NULL,
      base_url VARCHAR(512) NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      accepts_new_tasks TINYINT(1) NOT NULL DEFAULT 1,
      max_concurrency INT NOT NULL DEFAULT 1,
      queue_weight INT NOT NULL DEFAULT 1,
      request_timeout_sec INT NOT NULL DEFAULT 300,
      websocket_timeout_sec INT NOT NULL DEFAULT 300,
      upload_policy VARCHAR(32) NOT NULL DEFAULT 'input',
      output_policy VARCHAR(32) NOT NULL DEFAULT 'media_service',
      secret_ref VARCHAR(128) NULL,
      config_json JSON NULL,
      last_sync_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY local_model_providers_host_id_provider_key_key (host_id, provider_key),
      KEY local_model_providers_type_enabled_idx (type, enabled),
      KEY local_model_providers_accepts_new_tasks_enabled_idx (accepts_new_tasks, enabled)
    )`,
  },
  {
    label: 'local_models',
    sql: `CREATE TABLE IF NOT EXISTS local_models (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      provider_id INT NOT NULL,
      model_key VARCHAR(128) NOT NULL,
      display_name VARCHAR(128) NOT NULL,
      model_type VARCHAR(32) NOT NULL,
      family VARCHAR(64) NULL,
      capabilities JSON NULL,
      preview_image_url VARCHAR(512) NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      visibility VARCHAR(24) NOT NULL DEFAULT 'admin_only',
      vram_min_gb INT NULL,
      vram_recommended_gb INT NULL,
      model_precision VARCHAR(32) NULL,
      quantization VARCHAR(32) NULL,
      default_width INT NOT NULL DEFAULT 1024,
      default_height INT NOT NULL DEFAULT 1024,
      max_width INT NOT NULL DEFAULT 1024,
      max_height INT NOT NULL DEFAULT 1024,
      default_steps INT NOT NULL DEFAULT 24,
      max_steps INT NOT NULL DEFAULT 40,
      default_cfg DECIMAL(6,2) NULL,
      max_batch_size INT NOT NULL DEFAULT 1,
      max_concurrency INT NOT NULL DEFAULT 1,
      queue_weight INT NOT NULL DEFAULT 1,
      price_weight DECIMAL(8,3) NOT NULL DEFAULT 1.000,
      license_note VARCHAR(512) NULL,
      metadata_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY local_models_provider_id_model_key_key (provider_id, model_key),
      KEY local_models_model_type_enabled_idx (model_type, enabled),
      KEY local_models_visibility_enabled_idx (visibility, enabled)
    )`,
  },
  {
    label: 'local_model_files',
    sql: `CREATE TABLE IF NOT EXISTS local_model_files (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      model_id INT NOT NULL,
      provider_id INT NOT NULL,
      file_path VARCHAR(512) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_type VARCHAR(32) NOT NULL,
      size_bytes BIGINT NULL,
      sha256_hash VARCHAR(128) NULL,
      last_seen_at DATETIME(3) NULL,
      metadata_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY local_model_files_provider_id_file_path_key (provider_id, file_path),
      KEY local_model_files_model_id_idx (model_id),
      KEY local_model_files_file_type_last_seen_at_idx (file_type, last_seen_at)
    )`,
  },
  {
    label: 'local_node_catalog',
    sql: `CREATE TABLE IF NOT EXISTS local_node_catalog (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      provider_id INT NOT NULL,
      class_type VARCHAR(160) NOT NULL,
      display_name VARCHAR(160) NOT NULL,
      category VARCHAR(160) NULL,
      input_schema JSON NULL,
      output_schema JSON NULL,
      danger_level VARCHAR(24) NOT NULL DEFAULT 'safe',
      visibility VARCHAR(24) NOT NULL DEFAULT 'admin_only',
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      raw_schema JSON NULL,
      synced_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY local_node_catalog_provider_id_class_type_key (provider_id, class_type),
      KEY local_node_catalog_category_idx (category),
      KEY local_node_catalog_visibility_enabled_idx (visibility, enabled)
    )`,
  },
  {
    label: 'local_workflow_templates',
    sql: `CREATE TABLE IF NOT EXISTS local_workflow_templates (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      template_key VARCHAR(128) NOT NULL,
      name VARCHAR(128) NOT NULL,
      category VARCHAR(64) NOT NULL,
      description VARCHAR(1024) NOT NULL DEFAULT '',
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      visibility VARCHAR(24) NOT NULL DEFAULT 'admin_only',
      status VARCHAR(24) NOT NULL DEFAULT 'draft',
      metadata_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY local_workflow_templates_template_key_key (template_key),
      KEY local_workflow_templates_category_enabled_idx (category, enabled),
      KEY local_workflow_templates_visibility_status_idx (visibility, status)
    )`,
  },
  {
    label: 'local_workflow_template_versions',
    sql: `CREATE TABLE IF NOT EXISTS local_workflow_template_versions (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      template_id INT NOT NULL,
      version INT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'draft',
      provider_id INT NULL,
      model_id INT NULL,
      runtime_target VARCHAR(32) NOT NULL DEFAULT 'comfyui',
      input_schema JSON NULL,
      provider_runtime_json JSON NULL,
      artifact_rules JSON NULL,
      price_weight DECIMAL(8,3) NOT NULL DEFAULT 1.000,
      timeout_sec INT NOT NULL DEFAULT 600,
      created_by_id INT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      activated_at DATETIME(3) NULL,
      UNIQUE KEY local_workflow_template_versions_template_id_version_key (template_id, version),
      KEY local_workflow_template_versions_provider_id_status_idx (provider_id, status),
      KEY local_workflow_template_versions_model_id_idx (model_id)
    )`,
  },
  {
    label: 'local_runs',
    sql: `CREATE TABLE IF NOT EXISTS local_runs (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      task_id VARCHAR(64) NULL,
      workflow_id VARCHAR(64) NULL,
      workflow_version_id VARCHAR(64) NULL,
      template_id INT NULL,
      template_version_id INT NULL,
      provider_id INT NULL,
      host_id INT NULL,
      model_id INT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      provider_prompt_id VARCHAR(128) NULL,
      inputs_json JSON NULL,
      callback_json JSON NULL,
      error_summary VARCHAR(512) NULL,
      raw_error LONGTEXT NULL,
      queued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      started_at DATETIME(3) NULL,
      finished_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY local_runs_task_id_idx (task_id),
      KEY local_runs_status_queued_at_idx (status, queued_at),
      KEY local_runs_provider_prompt_id_idx (provider_prompt_id),
      KEY local_runs_provider_id_status_idx (provider_id, status)
    )`,
  },
  {
    label: 'local_run_nodes',
    sql: `CREATE TABLE IF NOT EXISTS local_run_nodes (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      local_run_id VARCHAR(64) NOT NULL,
      node_key VARCHAR(128) NOT NULL,
      class_type VARCHAR(160) NULL,
      title VARCHAR(160) NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      progress INT NULL,
      order_index INT NOT NULL DEFAULT 0,
      error_summary VARCHAR(512) NULL,
      raw_error LONGTEXT NULL,
      metadata_json JSON NULL,
      started_at DATETIME(3) NULL,
      finished_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY local_run_nodes_local_run_id_node_key_key (local_run_id, node_key),
      KEY local_run_nodes_local_run_id_status_idx (local_run_id, status)
    )`,
  },
  {
    label: 'local_run_artifacts',
    sql: `CREATE TABLE IF NOT EXISTS local_run_artifacts (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      local_run_id VARCHAR(64) NOT NULL,
      node_id VARCHAR(64) NULL,
      kind VARCHAR(24) NOT NULL DEFAULT 'image',
      filename VARCHAR(255) NULL,
      media_url VARCHAR(1024) NULL,
      mime_type VARCHAR(128) NULL,
      size_bytes BIGINT NULL,
      width INT NULL,
      height INT NULL,
      metadata_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY local_run_artifacts_local_run_id_kind_idx (local_run_id, kind),
      KEY local_run_artifacts_node_id_idx (node_id)
    )`,
  },
];

console.log('[local-model-migration] 本脚本只新增本地模型基础表，不会删除或修改余额、用户、图库、任务、媒体、QQ 绑定、卡密或 token 数据。');
console.log('[local-model-migration] 生产执行前必须先备份受影响表；如果生产机没有 mysqldump/mariadb-dump，请使用 Prisma 只读导出 JSONL 到 /v3/backups。');
console.log(`[local-model-migration] 备份表范围：${backupTables.join(', ')}`);

if (dryRun) {
  console.log('[local-model-migration] dry-run 模式，仅打印 SQL，不执行。正式执行请传 --apply。');
  for (const item of statements) {
    console.log(`\n-- ${item.label}\n${item.sql};`);
  }
  console.log('\n[local-model-migration] 回滚草案：仅在确认新表没有业务写入时，按依赖倒序 DROP local_run_artifacts、local_run_nodes、local_runs、local_workflow_template_versions、local_workflow_templates、local_node_catalog、local_model_files、local_models、local_model_providers、local_inference_hosts。已有运行记录时不要 DROP，改为停用功能并保留审计数据。');
  await prisma.$disconnect();
  process.exit(0);
}

for (const item of statements) {
  try {
    // 生产迁移按语句逐条执行，失败立即暴露，避免静默跳过导致 schema 半落地。
    await prisma.$executeRawUnsafe(item.sql);
    console.log('OK:', item.label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('FAIL:', item.label, message.slice(0, 240));
    await prisma.$disconnect();
    process.exit(1);
  }
}

await prisma.$disconnect();
console.log('[local-model-migration] done');
