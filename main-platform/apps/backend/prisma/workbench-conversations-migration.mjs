/**
 * 导航工作台会话持久化迁移脚本。
 *
 * 本脚本只新增 workbench_conversations 和 workbench_messages 表，用于保存网页工作台多窗口上下文。
 * 后续升级会给消息表补充多模态字段，并新增 workbench_attachments 表。
 * 不修改余额、绘图任务、图库、QQ 绑定、卡密、邮箱 token 或任何已有业务记录。
 * 生产执行前先运行 `node apps/backend/prisma/workbench-conversations-migration.mjs --dry-run` 查看计划；
 * 确认后运行 `node apps/backend/prisma/workbench-conversations-migration.mjs --apply`。
 */
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

const operations = [
  {
    name: 'workbench_conversations_table',
    sql: `CREATE TABLE IF NOT EXISTS workbench_conversations (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(128) NOT NULL,
      model VARCHAR(128) NULL,
      count INT NOT NULL DEFAULT 1,
      is_private BOOLEAN NOT NULL DEFAULT FALSE,
      last_message_preview VARCHAR(255) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      last_message_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY workbench_conversations_user_id_last_message_at_idx (user_id, last_message_at),
      CONSTRAINT workbench_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    verify: () => hasTable('workbench_conversations'),
  },
  {
    name: 'workbench_messages_table',
    sql: `CREATE TABLE IF NOT EXISTS workbench_messages (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      conversation_id VARCHAR(64) NOT NULL,
      user_id INT NOT NULL,
      role VARCHAR(16) NOT NULL,
      content TEXT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'sent',
      task_ids JSON NULL,
      error TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY workbench_messages_conversation_id_created_at_idx (conversation_id, created_at),
      KEY workbench_messages_user_id_created_at_idx (user_id, created_at),
      CONSTRAINT workbench_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES workbench_conversations(id) ON DELETE CASCADE,
      CONSTRAINT workbench_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    verify: () => hasTable('workbench_messages'),
  },
  {
    name: 'workbench_messages_kind_column',
    sql: `ALTER TABLE workbench_messages ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'chat' AFTER status`,
    verify: () => hasColumn('workbench_messages', 'kind'),
  },
  {
    name: 'workbench_messages_attachment_ids_column',
    sql: `ALTER TABLE workbench_messages ADD COLUMN attachment_ids JSON NULL AFTER task_ids`,
    verify: () => hasColumn('workbench_messages', 'attachment_ids'),
  },
  {
    name: 'workbench_messages_tool_calls_column',
    sql: `ALTER TABLE workbench_messages ADD COLUMN tool_calls JSON NULL AFTER attachment_ids`,
    verify: () => hasColumn('workbench_messages', 'tool_calls'),
  },
  {
    name: 'workbench_messages_model_column',
    sql: `ALTER TABLE workbench_messages ADD COLUMN model VARCHAR(128) NULL AFTER tool_calls`,
    verify: () => hasColumn('workbench_messages', 'model'),
  },
  {
    name: 'workbench_attachments_table',
    sql: `CREATE TABLE IF NOT EXISTS workbench_attachments (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL,
      conversation_id VARCHAR(64) NULL,
      kind VARCHAR(16) NOT NULL DEFAULT 'image',
      filename VARCHAR(128) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(64) NOT NULL,
      size_bytes INT NOT NULL,
      width INT NULL,
      height INT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY workbench_attachments_user_id_created_at_idx (user_id, created_at),
      KEY workbench_attachments_conversation_id_created_at_idx (conversation_id, created_at),
      CONSTRAINT workbench_attachments_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT workbench_attachments_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES workbench_conversations(id) ON DELETE SET NULL
    )`,
    verify: () => hasTable('workbench_attachments'),
  },
  {
    name: 'workbench_agent_runs_table',
    sql: `CREATE TABLE IF NOT EXISTS workbench_agent_runs (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      conversation_id VARCHAR(64) NOT NULL,
      user_id INT NOT NULL,
      user_message_id VARCHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'running',
      current_stage VARCHAR(32) NULL,
      plan_json JSON NULL,
      selected_attachment_ids JSON NULL,
      error TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      finished_at DATETIME(3) NULL,
      KEY workbench_agent_runs_conversation_id_created_at_idx (conversation_id, created_at),
      KEY workbench_agent_runs_user_id_created_at_idx (user_id, created_at),
      KEY workbench_agent_runs_status_updated_at_idx (status, updated_at),
      CONSTRAINT workbench_agent_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES workbench_conversations(id) ON DELETE CASCADE,
      CONSTRAINT workbench_agent_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    verify: () => hasTable('workbench_agent_runs'),
  },
  {
    name: 'workbench_agent_steps_table',
    sql: `CREATE TABLE IF NOT EXISTS workbench_agent_steps (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      step_type VARCHAR(32) NOT NULL,
      title VARCHAR(128) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'running',
      input_summary TEXT NULL,
      output_summary TEXT NULL,
      error TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      finished_at DATETIME(3) NULL,
      KEY workbench_agent_steps_run_id_created_at_idx (run_id, created_at),
      CONSTRAINT workbench_agent_steps_run_id_fkey FOREIGN KEY (run_id) REFERENCES workbench_agent_runs(id) ON DELETE CASCADE
    )`,
    verify: () => hasTable('workbench_agent_steps'),
  },
];

console.log('[workbench-migration] 本脚本只新增导航工作台会话表，不修改任何余额、任务或图库数据。');
console.log(`[workbench-migration] mode=${dryRun ? 'dry-run' : 'apply'}`);

for (const operation of operations) {
  await runOperation(operation);
}

console.log(dryRun ? 'DONE: workbench migration planned' : 'DONE: workbench migration verified');

/** 执行幂等 DDL；生产迁移允许重复运行，避免中断后无法恢复。 */
async function runOperation(operation) {
  const exists = await operation.verify().catch((error) => {
    if (!dryRun) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`SKIP_VERIFY ${operation.name}: ${message.slice(0, 160)}`);
    return false;
  });
  if (exists) {
    console.log(`OK_EXISTS: ${operation.name}`);
    return;
  }
  if (dryRun) {
    console.log(`PLAN ${operation.name}: ${operation.sql.replace(/\s+/g, ' ').trim()};`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(operation.sql);
    console.log(`OK_APPLIED: ${operation.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (await operation.verify()) {
      console.log(`OK_AFTER_RECONNECT: ${operation.name}`);
      return;
    }
    console.error(`FAIL: ${operation.name}: ${message.slice(0, 300)}`);
    process.exitCode = 1;
    throw error;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  if (!await operation.verify()) {
    throw new Error(`迁移验证失败：${operation.name}`);
  }
}

/** 检查目标表是否存在。 */
async function hasTable(tableName) {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS total
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${tableName}
    `;
    return Number(rows[0]?.total ?? 0) > 0;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

/** 检查目标列是否存在，便于旧生产库无损升级。 */
async function hasColumn(tableName, columnName) {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS total
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${tableName}
        AND COLUMN_NAME = ${columnName}
    `;
    return Number(rows[0]?.total ?? 0) > 0;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
