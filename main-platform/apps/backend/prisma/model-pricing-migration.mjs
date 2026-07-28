/**
 * 模型级定价迁移脚本。
 *
 * 本脚本把站点 model_options 中的历史 price 迁移到 drawing_model_settings，
 * 同时登记所有现有站点模型、完整保留模型级功能设置并清除站点价格字段。不会删除模型、站点、余额、任务、用户或图片数据。
 * 生产执行前必须备份 api_sites 与 drawing_model_settings，再运行 `--dry-run`；确认后使用 `--apply`。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

try {
  const [globalPriceRow, legacyRetryRow, settingsRow, sites] = await Promise.all([
    prisma.systemConfig.findUnique({ where: { key: 'drawing_price_per_gen' }, select: { value: true } }),
    prisma.systemConfig.findUnique({ where: { key: 'drawing_retry_count' }, select: { value: true } }),
    prisma.systemConfig.findUnique({ where: { key: 'drawing_model_settings' }, select: { value: true } }),
    prisma.apiSite.findMany({ select: { id: true, model: true, modelOptions: true } }),
  ]);
  const fallbackPrice = normalizePrice(globalPriceRow?.value, 0.05);
  const fallbackMaxAttempts = normalizeMaxAttempts(legacyRetryRow?.value, 3);
  const existingSettings = parseSettings(settingsRow?.value);
  const models = new Map();
  for (const raw of existingSettings) {
    const normalized = normalizeSetting(raw, fallbackPrice, false, fallbackMaxAttempts);
    if (normalized && !models.has(normalized.name)) models.set(normalized.name, normalized);
  }

  const siteUpdates = [];
  let removedSitePriceCount = 0;
  for (const site of sites) {
    const options = parseOptions(site.modelOptions);
    let changed = false;
    for (const option of options) {
      const name = String(option.name ?? '').trim();
      if (!name) continue;
      const existing = models.get(name);
      if (!existing) {
        const type = normalizeType(option.type);
        models.set(name, {
          name,
          requestModelNames: [],
          aliases: [],
          weight: 100,
          price: normalizePrice(option.price, fallbackPrice),
          maxAttempts: fallbackMaxAttempts,
          storyboardDesignEnabled: type === 'video',
          referencePromptAssistEnabled: false,
          type,
          isDefault: false,
        });
      } else {
        // 旧模型设置没有价格时优先继承站点历史价格，否则使用全局兜底。
        if (!Number.isFinite(Number(existing.price))) existing.price = normalizePrice(option.price, fallbackPrice);
        if (!existing.type) existing.type = normalizeType(option.type);
      }
      if (Object.prototype.hasOwnProperty.call(option, 'price')) {
        delete option.price;
        removedSitePriceCount += 1;
        changed = true;
      }
    }
    if (options.length === 0 && site.model?.trim() && !models.has(site.model.trim())) {
      models.set(site.model.trim(), {
        name: site.model.trim(), requestModelNames: [], aliases: [], weight: 100, price: fallbackPrice, maxAttempts: fallbackMaxAttempts,
        storyboardDesignEnabled: false, referencePromptAssistEnabled: false, type: 'universal', isDefault: false,
      });
    }
    if (changed) siteUpdates.push({ id: site.id, modelOptions: JSON.stringify(options) });
  }

  const finalModels = [...models.values()].map((item) => normalizeSetting(item, fallbackPrice, true, fallbackMaxAttempts)).filter(Boolean);
  const value = JSON.stringify({ models: finalModels });
  console.log(`[model-pricing-migration] mode=${dryRun ? 'dry-run' : 'apply'} models=${finalModels.length} siteUpdates=${siteUpdates.length} removedPrices=${removedSitePriceCount} fallback=${fallbackPrice.toFixed(2)}`);

  if (dryRun) {
    console.log(`PLAN drawing_model_settings models=${finalModels.map((item) => `${item.name}:${item.price.toFixed(2)}`).join(',')}`);
  } else {
    // 模型登记和站点价格清理在同一事务完成，避免扣费配置出现半迁移状态。
    await prisma.$transaction(async (tx) => {
      await tx.systemConfig.upsert({
        where: { key: 'drawing_model_settings' },
        update: { value },
        create: { key: 'drawing_model_settings', value },
      });
      for (const update of siteUpdates) {
        await tx.apiSite.update({ where: { id: update.id }, data: { modelOptions: update.modelOptions } });
      }
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 30000 });
    await verifyMigration(finalModels);
    console.log('DONE: model pricing migration verified');
  }
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

/** 解析独立模型设置，兼容历史数组和对象格式。 */
function parseSettings(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

/** 解析站点模型 JSON，非法值按空数组处理且不写伪造数据。 */
function parseOptions(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

/** 规范化独立模型设置，保留现有外显配置并补齐价格、尝试次数与类型。 */
function normalizeSetting(raw, fallbackPrice, forcePrice, fallbackMaxAttempts) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim();
  if (!name) return null;
  const label = String(raw.label ?? '').trim();
  const price = forcePrice || Number.isFinite(Number(raw.price)) ? normalizePrice(raw.price, fallbackPrice) : undefined;
  const type = normalizeType(raw.type);
  return {
    name,
    ...(label ? { label } : {}),
    requestModelNames: normalizeNames(raw.requestModelNames).filter((item) => item !== name),
    aliases: Array.isArray(raw.aliases) ? [...new Set(raw.aliases.map((item) => String(item).trim()).filter(Boolean))] : [],
    weight: Number.isFinite(Number(raw.weight)) ? Math.min(Math.max(Math.trunc(Number(raw.weight)), 0), 10000) : 100,
    ...(price === undefined ? {} : { price }),
    maxAttempts: normalizeMaxAttempts(raw.maxAttempts, fallbackMaxAttempts),
    storyboardDesignEnabled: type === 'video' && raw.storyboardDesignEnabled !== false,
    referencePromptAssistEnabled: (type === 'text_to_image' || type === 'universal') && raw.referencePromptAssistEnabled === true,
    // 模型级定价迁移不得覆盖提示词格式；旧 localModel 仅兼容映射一次，后续统一由 promptFormat 决定链路。
    promptFormat: normalizePromptFormat(raw.promptFormat, raw.localModel === true ? 'diffusion' : inferPromptFormat(name)),
    type,
    isDefault: raw.isDefault === true,
  };
}

/** 规范化等价请求模型名，迁移时保留后台已配置的真实上游模型映射。 */
function normalizeNames(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : [];
}

/** 模型类型只允许当前生产契约支持的五种值，视频模型不得在重复迁移时降级。 */
function normalizeType(value) {
  return value === 'text_to_image' || value === 'image_to_image' || value === 'video' || value === 'text' ? value : 'universal';
}

/** 保留已配置的提示词格式，Anima 系列历史模型补齐为 Anima 标签链路。 */
function normalizePromptFormat(value, fallback) {
  return value === 'standard' || value === 'diffusion' || value === 'anima' ? value : fallback;
}

/** 按真实模型名为历史 Anima 设置补齐格式，其他模型使用通用描述。 */
function inferPromptFormat(modelName) {
  return /^anima(?:[-_.]|$)/i.test(String(modelName ?? '').trim()) ? 'anima' : 'standard';
}

/** 模型价格统一为 0-100 元范围内的分精度。 */
function normalizePrice(value, fallback) {
  const numeric = Number(value ?? fallback);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  return Math.round(Math.min(Math.max(safe, 0), 100) * 100) / 100;
}

/** 模型级最大尝试次数限制为 1-10；旧全局配置仅用于首次补齐缺失模型。 */
function normalizeMaxAttempts(value, fallback) {
  const numeric = Number(value ?? fallback);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  return Math.min(Math.max(Math.trunc(safe), 1), 10);
}

/** 验证模型设置及功能开关已完整写入，且所有站点 JSON 都不再携带价格字段。 */
async function verifyMigration(expectedModels) {
  const [settings, sites] = await Promise.all([
    prisma.systemConfig.findUnique({ where: { key: 'drawing_model_settings' }, select: { value: true } }),
    prisma.apiSite.findMany({ select: { modelOptions: true } }),
  ]);
  const models = parseSettings(settings?.value);
  if (models.length < expectedModels.length || models.some((item) => !Number.isFinite(Number(item?.price)) || !Number.isInteger(item?.maxAttempts))) {
    throw new Error('迁移验证失败：独立模型价格或尝试次数不完整');
  }
  const actualByName = new Map(models.map((item) => [item?.name, item]));
  const settingsLost = expectedModels.some((expected) => {
    const actual = actualByName.get(expected.name);
    return !actual
      || JSON.stringify(actual.requestModelNames) !== JSON.stringify(expected.requestModelNames)
      || actual.storyboardDesignEnabled !== expected.storyboardDesignEnabled
      || actual.referencePromptAssistEnabled !== expected.referencePromptAssistEnabled
      || actual.promptFormat !== expected.promptFormat;
  });
  if (settingsLost) throw new Error('迁移验证失败：模型请求名或功能开关未完整保留');
  if (sites.some((site) => parseOptions(site.modelOptions).some((item) => Object.prototype.hasOwnProperty.call(item, 'price')))) {
    throw new Error('迁移验证失败：站点仍包含 price 字段');
  }
}
