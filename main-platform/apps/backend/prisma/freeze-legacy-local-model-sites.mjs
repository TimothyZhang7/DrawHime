/**
 * 本脚本把主站 api_sites 中的 ComfyUI 模型选项冻结为禁用，并在站点没有其他可用模型时停用站点。
 * 脚本完整保留站点、模型、API Key、历史任务、图库、LoRA、用户和余额数据；生产应用前必须指定私有备份目录。
 */
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const backupDirectory = readArgument('--backup-dir');

try {
  const sites = await prisma.apiSite.findMany({ orderBy: { id: 'asc' } });
  const plans = sites.flatMap(buildFreezePlan);
  console.log(`[freeze-legacy-local-model-sites] mode=${apply ? 'apply' : 'dry-run'} affected=${plans.length}`);
  for (const plan of plans) {
    console.log(`PLAN site=${plan.id} name=${plan.name} disableSite=${plan.disableSite} localModels=${plan.localModelNames.join(',')}`);
  }

  if (!apply) {
    console.log('DONE: legacy local model site freeze planned');
  } else {
    if (!backupDirectory) throw new Error('应用冻结前必须通过 --backup-dir 指定生产私有备份目录');
    await writePrivateBackup(backupDirectory, plans.map((plan) => plan.original));
    await prisma.$transaction(plans.map((plan) => prisma.apiSite.update({
      where: { id: plan.id },
      data: {
        modelOptions: JSON.stringify(plan.modelOptions),
        ...(plan.disableSite ? { isEnabled: false } : {}),
      },
    })));

    const verified = await prisma.apiSite.findMany({ where: { id: { in: plans.map((plan) => plan.id) } }, select: { id: true, isEnabled: true, modelOptions: true } });
    for (const site of verified) {
      const options = parseOptions(site.modelOptions);
      if (options.some((option) => option.apiMode === 'comfyui_generation' && option.enabled !== false)) {
        throw new Error(`冻结验证失败：站点 ${site.id} 仍存在启用的 ComfyUI 模型`);
      }
      if (site.isEnabled && !options.some((option) => option.apiMode !== 'comfyui_generation' && option.enabled !== false)) {
        throw new Error(`冻结验证失败：站点 ${site.id} 没有外部模型但仍处于启用状态`);
      }
    }
    console.log('DONE: legacy local model sites frozen and verified');
  }
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

/** 生成单个站点的冻结计划；没有 ComfyUI 模型的站点保持原样。 */
function buildFreezePlan(site) {
  const options = parseOptions(site.modelOptions);
  const localOptions = options.filter((option) => option.apiMode === 'comfyui_generation');
  if (localOptions.length === 0) return [];
  const modelOptions = options.map((option) => option.apiMode === 'comfyui_generation' ? { ...option, enabled: false } : option);
  const hasEnabledExternalModel = modelOptions.some((option) => option.apiMode !== 'comfyui_generation' && option.enabled !== false);
  return [{
    id: site.id,
    name: site.name,
    disableSite: !hasEnabledExternalModel,
    localModelNames: localOptions.map((option) => String(option.name ?? '')).filter(Boolean),
    modelOptions,
    original: site,
  }];
}

/** 严格解析模型选项；损坏配置停止脚本，避免覆盖无法确认的生产内容。 */
function parseOptions(raw) {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('model_options 不是数组');
  return parsed.filter((option) => option && typeof option === 'object');
}

/** 将受影响站点完整写入服务器私有备份文件，权限固定为仅属主可读写。 */
async function writePrivateBackup(directory, rows) {
  const absoluteDirectory = resolve(directory);
  await mkdir(absoluteDirectory, { recursive: true, mode: 0o700 });
  const file = resolve(absoluteDirectory, 'api-sites-before-local-freeze.json');
  await writeFile(file, `${JSON.stringify(rows, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
  console.log(`BACKUP ${file}`);
}

/** 读取命令行键值参数。 */
function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}
