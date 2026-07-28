/**
 * 本脚本把模型设置从 localModel 布尔开关迁移为 promptFormat，且只更新 drawing_model_settings。
 * 不修改余额、钱包流水、任务、用户、站点、媒体、QQ 绑定、卡密或任何业务数据。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

try {
  const row = await prisma.systemConfig.findUnique({ where: { key: 'drawing_model_settings' }, select: { value: true } });
  const source = parseSettings(row?.value);
  const models = source.map(normalizeModel).filter(Boolean);
  const changed = JSON.stringify(source) !== JSON.stringify(models);
  console.log(`[model-prompt-format-migration] mode=${apply ? 'apply' : 'dry-run'} models=${models.length} changed=${changed}`);

  if (!apply) {
    console.log(`PLAN anima=${models.filter((item) => item.promptFormat === 'anima').map((item) => item.name).join(',') || '-'}`);
  } else if (changed) {
    await prisma.systemConfig.upsert({
      where: { key: 'drawing_model_settings' },
      update: { value: JSON.stringify({ models }) },
      create: { key: 'drawing_model_settings', value: JSON.stringify({ models }) },
    });
  }

  const verified = parseSettings((await prisma.systemConfig.findUnique({ where: { key: 'drawing_model_settings' }, select: { value: true } }))?.value);
  if (apply && verified.some((item) => item?.localModel !== undefined || !isPromptFormat(item?.promptFormat))) {
    throw new Error('迁移验证失败：模型提示词格式不完整或仍保留 localModel');
  }
  console.log(apply ? 'DONE: model prompt format migration verified' : 'DONE: model prompt format migration planned');
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

/** 兼容历史数组和 { models } 两种存储结构。 */
function parseSettings(raw) {
  try {
    const parsed = JSON.parse(raw || '{"models":[]}');
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

/** 保留已有模型字段，只补充显式格式并移除废弃布尔开关。 */
function normalizeModel(value) {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name ?? '').trim();
  if (!name) return null;
  const promptFormat = isPromptFormat(value.promptFormat)
    ? value.promptFormat
    : value.localModel === true ? 'diffusion' : /^anima(?:[-_.]|$)/i.test(name) ? 'anima' : 'standard';
  const { localModel: _legacyLocalModel, ...rest } = value;
  return { ...rest, name, promptFormat };
}

/** 只接受当前共享契约声明的三种格式。 */
function isPromptFormat(value) {
  return value === 'standard' || value === 'diffusion' || value === 'anima';
}
