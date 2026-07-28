/**
 * 本文件集中管理独立绘图模型设置。
 * 站点配置只声明真实可用模型，本模块负责价格、尝试次数、视频分镜、类型、外显名、别名、展示权重和默认模型。
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import {
  getDrawingModelCapabilities,
  getKnownDrawingModelMetadata,
  normalizeDrawingModelType,
  type ApiSiteModelOption,
  type DrawingModelListResponse,
  type DrawingModelOptionView,
  type DrawingPromptFormat,
  type DrawingModelType,
} from '@aiimage/shared-contracts';
import { readEnabledModelNames } from './generation-model-utils.js';

/** 模型外显设置的 system_configs key。 */
export const DRAWING_MODEL_SETTINGS_KEY = 'drawing_model_settings';

/** 单个模型的管理端设置。 */
export type DrawingModelSetting = {
  /** 用户选择和任务快照使用的统一主模型名。 */
  name: string;
  /** 与主模型等价的其他上游请求模型名。 */
  requestModelNames: string[];
  /** 用户端和 Bot 外显名。 */
  label?: string;
  /** Bot 命令和后端提交可识别的别名。 */
  aliases: string[];
  /** 外显排序权重，越大越靠前。 */
  weight: number;
  /** 单次生成价格（元）。 */
  price: number;
  /** 每个任务最多调用上游的总次数；1 表示失败后不再尝试。 */
  maxAttempts: number;
  /** 视频任务是否允许在创建前调用反推模型重新设计分镜提示词。 */
  storyboardDesignEnabled: boolean;
  /** 具备文生图能力的模型是否允许使用外部 AI 增强提示词；最多四张参考图为可选输入。 */
  referencePromptAssistEnabled: boolean;
  /** AI 提示增强最终输出格式；与模型部署位置无关。 */
  promptFormat: DrawingPromptFormat;
  /** 模型能力类型；站点全部删除后仍保留用于管理展示。 */
  type: DrawingModelType;
  /** 是否为全局默认模型。 */
  isDefault: boolean;
};

/** 归一化模型设置集合。 */
export type DrawingModelSettingsConfig = {
  /** 独立模型设置列表，站点删除后仍保留。 */
  models: DrawingModelSetting[];
};

/** 默认外显权重；未配置的模型按同一权重参与排序。 */
const DEFAULT_MODEL_WEIGHT = 100;
/** 历史模型未设置价格时使用的安全兜底。 */
const DEFAULT_MODEL_PRICE = 0.05;
/** 历史模型未设置尝试次数时使用的兼容默认值。 */
export const DEFAULT_MODEL_MAX_ATTEMPTS = 3;

/** 解析 system_configs 中的模型设置 JSON。 */
export function parseDrawingModelSettings(raw: string | null | undefined, fallbackPrice = DEFAULT_MODEL_PRICE): DrawingModelSettingsConfig {
  if (!raw?.trim()) return { models: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    const source = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : [];
    return { models: normalizeDrawingModelSettings(source, fallbackPrice) };
  } catch {
    return { models: [] };
  }
}

/** 归一化管理端传入的模型设置，过滤空模型名和重复模型。 */
export function normalizeDrawingModelSettings(raw: unknown, fallbackPrice = DEFAULT_MODEL_PRICE): DrawingModelSetting[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const candidates: DrawingModelSetting[] = [];
  let defaultTaken = false;

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const label = String(record.label ?? '').trim();
    const aliases = normalizeAliases(record.aliases);
    const requestModelNames = normalizeAliases(record.requestModelNames).filter((item) => item !== name);
    const weightRaw = Number(record.weight ?? DEFAULT_MODEL_WEIGHT);
    const weight = Number.isFinite(weightRaw) ? Math.min(Math.max(Math.trunc(weightRaw), 0), 10000) : DEFAULT_MODEL_WEIGHT;
    const price = normalizeModelPrice(record.price, fallbackPrice);
    const maxAttempts = normalizeModelMaxAttempts(record.maxAttempts);
    const type = normalizeDrawingModelType(record.type, name);
    const storyboardDesignEnabled = type === 'video' && record.storyboardDesignEnabled !== false;
    const referencePromptAssistEnabled = (type === 'text_to_image' || type === 'universal') && record.referencePromptAssistEnabled === true;
    // 旧 localModel=true 只用于一次性兼容为传统 diffusion 格式；新配置不再保存部署位置开关。
    const promptFormat = normalizeDrawingPromptFormat(record.promptFormat, record.localModel === true ? 'diffusion' : inferDrawingPromptFormat(name));
    const isDefault = record.isDefault === true && !defaultTaken;
    if (isDefault) defaultTaken = true;

    candidates.push({
      name,
      requestModelNames,
      ...(label ? { label } : {}),
      aliases,
      weight,
      price,
      maxAttempts,
      storyboardDesignEnabled,
      referencePromptAssistEnabled,
      promptFormat,
      type,
      isDefault,
    });
  }
  // 前面的主模型可以吸收后面的同模型请求名；被吸收行不再单独外显或维护重复价格。
  const claimedRequestNames = new Set<string>();
  const requestOwnerMap = new Map<string, string>();
  const requestNamesByCanonical = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (claimedRequestNames.has(candidate.name)) continue;
    const requestModelNames = candidate.requestModelNames.filter((requestName) => {
      if (requestName === candidate.name || claimedRequestNames.has(requestName)) return false;
      claimedRequestNames.add(requestName);
      requestOwnerMap.set(requestName, candidate.name);
      return true;
    });
    requestNamesByCanonical.set(candidate.name, requestModelNames);
  }
  const configuredDefault = candidates.find((candidate) => candidate.isDefault)?.name;
  const resolvedDefault = configuredDefault ? requestOwnerMap.get(configuredDefault) ?? configuredDefault : undefined;
  return candidates
    .filter((candidate) => !claimedRequestNames.has(candidate.name))
    .map((candidate) => ({
      ...candidate,
      requestModelNames: requestNamesByCanonical.get(candidate.name) ?? [],
      isDefault: candidate.name === resolvedDefault,
    }));
}

/** 合并 drawing-service 返回的可用模型和后台独立模型设置。 */
export function applyDrawingModelSettings(
  response: DrawingModelListResponse,
  settings: DrawingModelSettingsConfig,
  legacyDefaultModel?: string | null,
  options?: { includeUnavailableSettings?: boolean; fallbackPrice?: number },
): DrawingModelListResponse {
  const settingsByName = new Map(settings.models.map((item) => [item.name, item]));
  const canonicalByRequestName = buildRequestModelCanonicalMap(settings);
  const fallbackPrice = normalizeModelPrice(options?.fallbackPrice, DEFAULT_MODEL_PRICE);
  const modelMap = new Map<string, DrawingModelOptionView>();
  for (const model of response.models) {
    const canonicalName = canonicalByRequestName.get(model.name) ?? model.name;
    const setting = settingsByName.get(canonicalName);
    const metadata = getKnownDrawingModelMetadata(canonicalName);
    const existing = modelMap.get(canonicalName);
    if (existing) {
      existing.sites = [...new Set([...existing.sites, ...model.sites])];
      existing.enabled = existing.enabled || model.enabled;
      existing.supportedAspectRatios = [...new Set([...(existing.supportedAspectRatios ?? ['auto']), ...(model.supportedAspectRatios ?? ['auto'])])];
      if (!setting) {
        existing.capabilities = mergeDrawingModelCapabilities(existing.capabilities, model.capabilities);
        existing.type = mergeDrawingModelTypes(existing.type, model.type);
      }
      if (model.recommended) existing.recommended = true;
      continue;
    }
    const type = setting?.type ?? model.type;
    modelMap.set(canonicalName, {
      ...model,
      name: canonicalName,
      label: setting?.label || metadata?.label,
      aliases: setting?.aliases ?? [],
      requestModelNames: setting?.requestModelNames ?? [],
      weight: setting?.weight ?? DEFAULT_MODEL_WEIGHT,
      price: setting?.price ?? fallbackPrice,
      maxAttempts: setting?.maxAttempts ?? DEFAULT_MODEL_MAX_ATTEMPTS,
      storyboardDesignEnabled: type === 'video' && (setting?.storyboardDesignEnabled ?? true),
      referencePromptAssistEnabled: (type === 'text_to_image' || type === 'universal') && setting?.referencePromptAssistEnabled === true,
      promptFormat: setting?.promptFormat ?? inferDrawingPromptFormat(canonicalName),
      type,
      capabilities: setting ? getDrawingModelCapabilities(type) : model.capabilities,
      isDefault: false,
    });
  }
  const models = [...modelMap.values()];

  // 管理端必须显示已无站点的独立模型，删站只影响可用性，不删除模型名称、价格和外显设置。
  if (options?.includeUnavailableSettings) {
    const activeNames = new Set(models.map((model) => model.name));
    for (const setting of settings.models) {
      if (activeNames.has(setting.name)) continue;
      const metadata = getKnownDrawingModelMetadata(setting.name);
      models.push({
        name: setting.name,
        label: setting.label || metadata?.label,
        aliases: setting.aliases,
        requestModelNames: setting.requestModelNames,
        weight: setting.weight,
        price: setting.price,
        maxAttempts: setting.maxAttempts,
        storyboardDesignEnabled: setting.type === 'video' && setting.storyboardDesignEnabled,
        referencePromptAssistEnabled: (setting.type === 'text_to_image' || setting.type === 'universal') && setting.referencePromptAssistEnabled,
        promptFormat: setting.promptFormat,
        isDefault: false,
        type: setting.type,
        capabilities: getDrawingModelCapabilities(setting.type),
        sites: [],
        enabled: false,
        recommended: metadata?.recommended,
        description: metadata?.description,
        provider: metadata?.provider,
      });
    }
  }

  const defaultModel = pickDefaultModel(models, settings, legacyDefaultModel ?? response.defaultModel);
  for (const model of models) {
    model.isDefault = Boolean(defaultModel && model.name === defaultModel);
    if (model.isDefault) model.recommended = true;
  }

  return {
    models: models.sort(compareModelForDisplay),
    defaultModel,
  };
}

/** 从后台设置、旧默认模型配置和模型列表中选出最终默认模型。 */
export function pickDefaultModel(
  models: Pick<DrawingModelOptionView, 'name' | 'capabilities'>[],
  settings: DrawingModelSettingsConfig,
  legacyDefaultModel?: string | null,
): string | undefined {
  const usable = new Set(models.filter(isImageCapable).map((model) => model.name));
  const configuredDefault = settings.models.find((item) => item.isDefault && usable.has(item.name))?.name;
  if (configuredDefault) return configuredDefault;
  const legacy = legacyDefaultModel?.trim();
  if (legacy && usable.has(legacy)) return legacy;
  return models.find(isImageCapable)?.name;
}

/** 解析用户输入的模型名、外显名或别名；空输入时回退后台默认模型。 */
export async function resolveConfiguredModelName(
  prisma: PrismaClient,
  requested: string | null | undefined,
): Promise<string | undefined> {
  const enabledNames = await readEnabledModelNames(prisma);
  const [settingsRow, legacyDefaultRow] = await Promise.all([
    prisma.systemConfig.findUnique({ where: { key: DRAWING_MODEL_SETTINGS_KEY }, select: { value: true } }),
    prisma.systemConfig.findUnique({ where: { key: 'drawing_default_model' }, select: { value: true } }),
  ]);
  const settings = parseDrawingModelSettings(settingsRow?.value);
  const trimmed = requested?.trim();
  if (trimmed) {
    const matched = matchModelInput(trimmed, settings, enabledNames);
    return matched ?? trimmed;
  }
  const canonicalMap = buildRequestModelCanonicalMap(settings);
  const canonicalNames = new Set([...enabledNames].map((name) => canonicalMap.get(name) ?? name));
  const models = [...canonicalNames].map((name) => ({ name, capabilities: { textToImage: true, imageToImage: true, text: false, textToVideo: false, imageToVideo: false } }));
  return pickDefaultModel(models, settings, legacyDefaultRow?.value);
}

/** 按独立模型设置读取真实扣费价格，未配置时只回退历史全局单价。 */
export async function resolveConfiguredModelPrice(
  prisma: PrismaClient,
  model: string | null | undefined,
  fallbackPrice?: number,
): Promise<number> {
  const [settingsRow, fallbackRow] = await Promise.all([
    prisma.systemConfig.findUnique({ where: { key: DRAWING_MODEL_SETTINGS_KEY }, select: { value: true } }),
    fallbackPrice === undefined
      ? prisma.systemConfig.findUnique({ where: { key: 'drawing_price_per_gen' }, select: { value: true } })
      : Promise.resolve(null),
  ]);
  const fallback = normalizeModelPrice(fallbackPrice ?? fallbackRow?.value, DEFAULT_MODEL_PRICE);
  const settings = parseDrawingModelSettings(settingsRow?.value, fallback);
  return findModelSetting(settings, model)?.price ?? fallback;
}

/** 按独立模型设置读取任务级最大上游尝试次数，旧模型缺失时回退 3 次。 */
export async function resolveConfiguredModelMaxAttempts(
  prisma: PrismaClient,
  model: string | null | undefined,
): Promise<number> {
  const settingsRow = await prisma.systemConfig.findUnique({
    where: { key: DRAWING_MODEL_SETTINGS_KEY },
    select: { value: true },
  });
  const settings = parseDrawingModelSettings(settingsRow?.value);
  return findModelSetting(settings, model)?.maxAttempts ?? DEFAULT_MODEL_MAX_ATTEMPTS;
}

/** 按模型设置判断视频分镜功能是否开放；未持久化的新视频模型按站点类型默认开启。 */
export async function resolveConfiguredModelStoryboardEnabled(
  prisma: PrismaClient,
  model: string | null | undefined,
): Promise<boolean> {
  const modelName = model?.trim();
  if (!modelName) return false;
  const settingsRow = await prisma.systemConfig.findUnique({
    where: { key: DRAWING_MODEL_SETTINGS_KEY },
    select: { value: true },
  });
  const setting = findModelSetting(parseDrawingModelSettings(settingsRow?.value), modelName);
  if (setting) return setting.type === 'video' && setting.storyboardDesignEnabled;

  const sites = await prisma.apiSite.findMany({
    where: { isEnabled: true },
    select: { model: true, modelOptions: true },
  });
  for (const site of sites) {
    for (const option of parseSiteModelOptions(site.modelOptions)) {
      if (option.name === modelName && option.enabled !== false) {
        return normalizeDrawingModelType(option.type, option.name) === 'video';
      }
    }
  }
  return false;
}

/** 按模型设置判断纯文生图参考增强是否开放；未登记模型保持关闭。 */
export async function resolveConfiguredModelReferencePromptAssistEnabled(
  prisma: PrismaClient,
  model: string | null | undefined,
): Promise<boolean> {
  const modelName = model?.trim();
  if (!modelName) return false;
  const settingsRow = await prisma.systemConfig.findUnique({
    where: { key: DRAWING_MODEL_SETTINGS_KEY },
    select: { value: true },
  });
  const setting = findModelSetting(parseDrawingModelSettings(settingsRow?.value), modelName);
  return (setting?.type === 'text_to_image' || setting?.type === 'universal') && setting.referencePromptAssistEnabled === true;
}

/** 按模型设置读取提示词增强格式；未登记的 Anima 模型按真实模型名识别，其余使用通用格式。 */
export async function resolveConfiguredModelPromptFormat(prisma: PrismaClient, model: string | null | undefined): Promise<DrawingPromptFormat> {
  const modelName = model?.trim();
  if (!modelName) return 'standard';
  const row = await prisma.systemConfig.findUnique({ where: { key: DRAWING_MODEL_SETTINGS_KEY }, select: { value: true } });
  return findModelSetting(parseDrawingModelSettings(row?.value), modelName)?.promptFormat ?? inferDrawingPromptFormat(modelName);
}

/** 站点新增或更新模型时登记独立模型；已有模型的价格和外显设置绝不被站点覆盖。 */
export async function registerSiteModelsInSettings(
  prisma: PrismaClient | Prisma.TransactionClient,
  siteModels: ApiSiteModelOption[],
): Promise<void> {
  if (siteModels.length === 0) return;
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: [DRAWING_MODEL_SETTINGS_KEY, 'drawing_price_per_gen'] } },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const fallback = normalizeModelPrice(values.get('drawing_price_per_gen'), DEFAULT_MODEL_PRICE);
  const settings = parseDrawingModelSettings(values.get(DRAWING_MODEL_SETTINGS_KEY), fallback);
  const known = new Set(settings.models.flatMap((item) => [item.name, ...item.requestModelNames]));
  let added = false;
  for (const option of siteModels) {
    if (known.has(option.name)) continue;
    known.add(option.name);
    added = true;
    settings.models.push({
      name: option.name,
      requestModelNames: [],
      aliases: [],
      weight: DEFAULT_MODEL_WEIGHT,
      price: fallback,
      maxAttempts: DEFAULT_MODEL_MAX_ATTEMPTS,
      storyboardDesignEnabled: normalizeDrawingModelType(option.type, option.name) === 'video',
      referencePromptAssistEnabled: false,
      promptFormat: inferDrawingPromptFormat(option.name),
      type: normalizeDrawingModelType(option.type, option.name),
      isDefault: false,
    });
  }
  if (!added) return;
  await prisma.systemConfig.upsert({
    where: { key: DRAWING_MODEL_SETTINGS_KEY },
    update: { value: JSON.stringify(settings) },
    create: { key: DRAWING_MODEL_SETTINGS_KEY, value: JSON.stringify(settings) },
  });
}

/** 判断模型是否可用于图片生成。 */
function isImageCapable(model: Pick<DrawingModelOptionView, 'capabilities'>): boolean {
  return Boolean(model.capabilities.textToImage || model.capabilities.imageToImage);
}

/** 按权重降序、默认模型优先、模型名升序排序。 */
function compareModelForDisplay(left: DrawingModelOptionView, right: DrawingModelOptionView): number {
  return Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault))
    || (right.weight ?? DEFAULT_MODEL_WEIGHT) - (left.weight ?? DEFAULT_MODEL_WEIGHT)
    || left.name.localeCompare(right.name);
}

/** 按主模型名、等价请求模型名、外显名或输入别名匹配用户输入。 */
function matchModelInput(input: string, settings: DrawingModelSettingsConfig, enabledNames: Set<string>): string | undefined {
  const normalized = input.toLowerCase();
  for (const item of settings.models) {
    if (![item.name, ...item.requestModelNames].some((name) => enabledNames.has(name))) continue;
    if (item.name.toLowerCase() === normalized) return item.name;
    if (item.label?.toLowerCase() === normalized) return item.name;
    if (item.aliases.some((alias) => alias.toLowerCase() === normalized)) return item.name;
    if (item.requestModelNames.some((name) => name.toLowerCase() === normalized)) return item.name;
  }
  if (enabledNames.has(input)) return input;
  return undefined;
}

/** 构建上游请求模型名到统一主模型名的映射，Worker 和展示层必须使用同一关系。 */
export function buildRequestModelCanonicalMap(settings: DrawingModelSettingsConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const setting of settings.models) {
    map.set(setting.name, setting.name);
    for (const requestName of setting.requestModelNames) map.set(requestName, setting.name);
  }
  return map;
}

/** 按主模型名或上游请求模型名读取统一设置。 */
function findModelSetting(settings: DrawingModelSettingsConfig, model: string | null | undefined): DrawingModelSetting | undefined {
  const name = model?.trim();
  if (!name) return undefined;
  return settings.models.find((item) => item.name === name || item.requestModelNames.includes(name));
}

/** 规范化管理端提示词格式，未知值必须回退明确默认值。 */
export function normalizeDrawingPromptFormat(value: unknown, fallback: DrawingPromptFormat = 'standard'): DrawingPromptFormat {
  return value === 'standard' || value === 'diffusion' || value === 'anima' ? value : fallback;
}

/** Anima 系列模型在尚未保存新字段时自动进入 Anima 专用链路。 */
function inferDrawingPromptFormat(modelName: string): DrawingPromptFormat {
  return /^anima(?:[-_.]|$)/i.test(modelName.trim()) ? 'anima' : 'standard';
}

/** 合并同一逻辑模型在不同站点声明的能力。 */
function mergeDrawingModelCapabilities(
  left: DrawingModelOptionView['capabilities'],
  right: DrawingModelOptionView['capabilities'],
): DrawingModelOptionView['capabilities'] {
  return {
    textToImage: left.textToImage || right.textToImage,
    imageToImage: left.imageToImage || right.imageToImage,
    text: left.text || right.text,
    textToVideo: left.textToVideo || right.textToVideo,
    imageToVideo: left.imageToVideo || right.imageToVideo,
  };
}

/** 同模型请求名出现不同图片能力时归并为通用类型，视频和文本保持独立。 */
function mergeDrawingModelTypes(left: DrawingModelType, right: DrawingModelType): DrawingModelType {
  if (left === right) return left;
  if (left === 'video' || right === 'video') return 'video';
  if (left === 'text' || right === 'text') return left === 'text' && right === 'text' ? 'text' : 'universal';
  return 'universal';
}

/** 归一化别名输入，兼容数组和逗号/换行字符串。 */
function normalizeAliases(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,，、]/)
      : [];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const item of items) {
    const alias = String(item ?? '').trim();
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    aliases.push(alias.slice(0, 64));
  }
  return aliases;
}

/** 解析站点模型选项，只用于识别尚未写入独立设置的新视频模型。 */
function parseSiteModelOptions(raw: string | null): Array<{ name: string; type?: string; enabled?: boolean }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? '').trim();
      if (!name) return [];
      return [{
        name,
        type: typeof record.type === 'string' ? record.type : undefined,
        enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
      }];
    });
  } catch {
    return [];
  }
}

/** 价格按钱包支持的分精度归一化，并限制管理端允许的安全范围。 */
function normalizeModelPrice(value: unknown, fallback: number): number {
  const numeric = Number(value ?? fallback);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  return Math.round(Math.min(Math.max(safe, 0), 100) * 100) / 100;
}

/** 归一化模型任务级尝试上限，确保 Worker 循环始终在 1-10 次内。 */
export function normalizeModelMaxAttempts(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MODEL_MAX_ATTEMPTS;
  return Math.min(Math.max(Math.trunc(numeric), 1), 10);
}
