/**
 * 图片反推异步任务持久化迁移脚本。
 *
 * 本脚本幂等创建 image_reverse_jobs 表，并补齐历史列表使用的轻量分析摘要列。
 * 不修改余额、绘图任务、图库、QQ 绑定或卡密数据。
 */
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

const operations = [
  {
    name: 'image_reverse_jobs_table',
    sql: `CREATE TABLE IF NOT EXISTS image_reverse_jobs (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      progress_text VARCHAR(128) NOT NULL DEFAULT '已提交，等待识图处理',
      mode VARCHAR(24) NOT NULL,
      model VARCHAR(128) NOT NULL,
      options_json JSON NOT NULL,
      source_file_name VARCHAR(255) NOT NULL,
      source_stored_name VARCHAR(128) NOT NULL,
      preview_stored_name VARCHAR(128) NOT NULL,
      source_mime_type VARCHAR(64) NOT NULL,
      source_size_bytes BIGINT NOT NULL,
      source_width INT NOT NULL,
      source_height INT NOT NULL,
      result_summary VARCHAR(1024) NULL,
      analysis_summary_json JSON NULL,
      result_json JSON NULL,
      error TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      started_at DATETIME(3) NULL,
      finished_at DATETIME(3) NULL,
      UNIQUE KEY image_reverse_jobs_source_stored_name_key (source_stored_name),
      UNIQUE KEY image_reverse_jobs_preview_stored_name_key (preview_stored_name),
      KEY image_reverse_jobs_user_id_created_at_idx (user_id, created_at),
      KEY image_reverse_jobs_status_updated_at_idx (status, updated_at),
      CONSTRAINT image_reverse_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    verify: () => hasTable('image_reverse_jobs'),
  },
  {
    name: 'image_reverse_jobs_analysis_summary_json',
    sql: 'ALTER TABLE image_reverse_jobs ADD COLUMN analysis_summary_json JSON NULL AFTER result_summary',
    verify: () => hasColumn('image_reverse_jobs', 'analysis_summary_json'),
  },
];

console.log('[image-reverse-jobs-migration] 本脚本只维护图片反推任务表并回填轻量摘要，不修改余额、图库或绘图任务。');
console.log(`[image-reverse-jobs-migration] mode=${dryRun ? 'dry-run' : 'apply'}`);

for (const operation of operations) await runOperation(operation);
if (!dryRun) await backfillAnalysisSummaries();

console.log(dryRun ? 'DONE: image reverse jobs migration planned' : 'DONE: image reverse jobs migration verified');

/** 执行幂等 DDL；生产迁移允许重复运行，避免中断后留下半完成状态。 */
async function runOperation(operation) {
  const exists = await operation.verify().catch((error) => {
    if (!dryRun) throw error;
    console.log(`SKIP_VERIFY ${operation.name}: ${readError(error).slice(0, 160)}`);
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
    if (await operation.verify()) {
      console.log(`OK_AFTER_RECONNECT: ${operation.name}`);
      return;
    }
    console.error(`FAIL: ${operation.name}: ${readError(error).slice(0, 300)}`);
    throw error;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  if (!await operation.verify()) throw new Error(`迁移验证失败：${operation.name}`);
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

/** 检查目标列是否存在，避免重复执行 ALTER TABLE。 */
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

/**
 * 为旧反推结果回填独立摘要。
 * 分批读取当前表且只更新空摘要，不改变完整结果 JSON、任务状态或任何用户资产。
 */
async function backfillAnalysisSummaries() {
  const prisma = new PrismaClient();
  let total = 0;
  try {
    while (true) {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT id, mode, result_json AS resultJson
        FROM image_reverse_jobs
        WHERE analysis_summary_json IS NULL AND result_json IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 200
      `);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const result = readJsonObject(row.resultJson) ?? { mode: String(row.mode ?? '') };
        const summary = buildAnalysisSummary(result);
        await prisma.$executeRawUnsafe(
          'UPDATE image_reverse_jobs SET analysis_summary_json = ? WHERE id = ? AND analysis_summary_json IS NULL',
          JSON.stringify(summary),
          String(row.id),
        );
        total += 1;
      }
      if (rows.length < 200) break;
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  console.log(`[image-reverse-jobs-migration] analysis summaries backfilled=${total}`);
}

/** 从驱动返回值安全读取结果对象。 */
function readJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 将旧完整结果压缩成历史列表摘要，字段规则与 backend 仓储保持一致。 */
function buildAnalysisSummary(result) {
  const analysis = result.analysis && typeof result.analysis === 'object' ? result.analysis : undefined;
  const sourceSummary = Array.isArray(analysis?.sourceSummary) ? analysis.sourceSummary : [];
  const evidence = Array.isArray(analysis?.evidence) ? analysis.evidence : [];
  const evidenceCount = sourceSummary.length > 0
    ? sourceSummary.reduce((total, item) => total + Math.max(0, Number(item?.count ?? 0)), 0)
    : evidence.length;
  const providers = Array.isArray(analysis?.providers) ? analysis.providers : [];
  return {
    pipeline: analysis?.pipeline === 'hybrid' ? 'hybrid' : 'vision-only',
    structuredOutputMode: ['json-schema', 'json-object', 'prompt-json'].includes(analysis?.structuredOutputMode) ? analysis.structuredOutputMode : 'prompt-json',
    providers: providers.map((provider) => ({ provider: provider.provider, label: provider.label, status: provider.status })),
    evidenceCount,
    warningCount: Array.isArray(analysis?.warnings) ? analysis.warnings.length : 0,
    conflictCount: Array.isArray(analysis?.conflicts) ? analysis.conflicts.length : 0,
    animaPromptAvailable: result.mode === 'tags' && Boolean(result.tagPrompt?.animaPrompt?.trim?.()),
  };
}

function readError(error) {
  return error instanceof Error ? error.message : String(error);
}
