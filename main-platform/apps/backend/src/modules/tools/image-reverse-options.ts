/**
 * 本文件统一归一化图片反推请求选项。
 * Web、Bot 和兼容旧 header 的调用都会在进入识图模型前变成同一份稳定配置。
 */
import type {
  ImageReverseEditIntent,
  ImageReverseAnalysisMode,
  ImageReverseExtractOptions,
  ImageReverseFocus,
  ImageReverseLanguage,
  ImageReverseLanguageMode,
  ImageReverseMode,
  ImageReversePromptLanguage,
  ImageReversePromptTarget,
  ImageReverseTagDensity,
  ImageReverseTagPreset,
  ImageReverseTagWeightMode,
} from '@aiimage/shared-contracts';

const ALL_MODES: ImageReverseMode[] = ['description', 'prompt', 'character', 'tags', 'edit'];
const ALL_LANGUAGES: ImageReverseLanguage[] = ['zh', 'en', 'zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'zh-TW'];
const ALL_FOCUSES: ImageReverseFocus[] = ['all', 'overall', 'subject', 'character', 'pose', 'outfit', 'composition', 'style', 'lighting', 'background'];

/** 图片反推配置中可公开给前端的默认项。 */
export interface ImageReversePublicDefaults {
  /** 默认模式。 */
  defaultMode: ImageReverseMode;
  /** 默认结果语言。 */
  defaultLanguage: ImageReverseLanguage;
  /** 默认 Prompt 语言。 */
  defaultPromptLanguage: ImageReversePromptLanguage;
  /** 用户端开放的模式。 */
  enabledModes: ImageReverseMode[];
  /** 用户端开放的语言。 */
  enabledLanguages: ImageReverseLanguage[];
  /** WD14 配置完整时允许标签模式选择混合证据。 */
  hybridAvailable: boolean;
}

/** 归一化请求选项；非法值回退默认配置，避免前端旧缓存导致接口失败。 */
export function normalizeImageReverseOptions(input: unknown, defaults: ImageReversePublicDefaults): ImageReverseExtractOptions {
  const record = readRecord(input);
  const mode = normalizeMode(record.mode, defaults.defaultMode, defaults.enabledModes);
  const primaryLanguage = normalizeLanguage(readRecord(record.language)?.primaryLanguage ?? record.primaryLanguage, defaults.defaultLanguage, defaults.enabledLanguages);
  const secondaryLanguage = normalizeLanguage(readRecord(record.language)?.secondaryLanguage, defaultSecondaryLanguage(primaryLanguage), defaults.enabledLanguages);
  const resultLanguageMode = normalizeLanguageMode(readRecord(record.language)?.resultLanguageMode ?? record.resultLanguageMode);
  const promptLanguage = normalizePromptLanguage(readRecord(record.language)?.promptLanguage ?? record.promptLanguage, defaults.defaultPromptLanguage);
  const focus = normalizeUnion(record.focus, ALL_FOCUSES, 'all');
  const requestedAnalysisMode = normalizeUnion(record.analysisMode, ['vision-only', 'hybrid'] satisfies ImageReverseAnalysisMode[], 'vision-only');
  return {
    mode,
    language: {
      resultLanguageMode,
      primaryLanguage,
      secondaryLanguage: resultLanguageMode === 'bilingual' ? secondaryLanguage : undefined,
      extraLanguages: normalizeExtraLanguages(readRecord(record.language)?.extraLanguages, defaults.enabledLanguages),
      promptLanguage,
    },
    // 反推结果不再暴露详细度配置，后端统一固定最高详细度，避免旧客户端传低档导致结果缩水。
    detailLevel: 'forensic',
    focus,
    // 单项描述的输出区域由 focus 唯一决定，不能让旧缓存或手写请求重新混入综合区域。
    sections: mode === 'description' && focus !== 'all' ? [focus] : normalizeSections(record.sections, defaultSectionsForMode(mode)),
    tagPreset: normalizeUnion(record.tagPreset, ['sdxl', 'nai', 'sd15', 'comfyui', 'anima'] satisfies ImageReverseTagPreset[], 'sdxl'),
    tagWeightMode: normalizeUnion(record.tagWeightMode, ['none', 'important', 'all'] satisfies ImageReverseTagWeightMode[], 'important'),
    tagDensity: normalizeUnion(record.tagDensity, ['compact', 'standard', 'rich'] satisfies ImageReverseTagDensity[], 'standard'),
    promptTarget: normalizeUnion(record.promptTarget, ['general', 'gpt-image', 'gemini-image', 'sdxl'] satisfies ImageReversePromptTarget[], 'general'),
    characterConsistency: normalizeUnion(record.characterConsistency, ['standard', 'strict'] as const, 'standard'),
    editIntent: normalizeUnion(record.editIntent, ['auto', 'character-replace', 'style-transfer', 'outfit-replace', 'background-replace', 'composition-redraw', 'multi-reference'] satisfies ImageReverseEditIntent[], 'auto'),
    includeEvidence: record.includeEvidence !== false,
    analysisMode: mode === 'tags' && defaults.hybridAvailable && requestedAnalysisMode === 'hybrid' ? 'hybrid' : 'vision-only',
  };
}

/** 从旧模式 header 构造兼容选项。 */
export function buildLegacyImageReverseOptions(mode: ImageReverseMode, defaults: ImageReversePublicDefaults): ImageReverseExtractOptions {
  return normalizeImageReverseOptions({ mode }, defaults);
}

/** 解析后台配置中的模式列表。 */
export function parseEnabledReverseModes(value: string | undefined): ImageReverseMode[] {
  const parsed = parseCsv(value).filter((item): item is ImageReverseMode => ALL_MODES.includes(item as ImageReverseMode));
  return parsed.length ? parsed : ALL_MODES;
}

/** 解析后台配置中的语言列表。 */
export function parseEnabledReverseLanguages(value: string | undefined): ImageReverseLanguage[] {
  const parsed = parseCsv(value).filter((item): item is ImageReverseLanguage => ALL_LANGUAGES.includes(item as ImageReverseLanguage));
  return parsed.length ? parsed : ['zh', 'en', 'zh-CN', 'en-US'];
}

/** 读取标准多语言输出键，旧 zh/en 会同步保留给旧前端。 */
export function selectedOutputLanguages(options: ImageReverseExtractOptions): ImageReverseLanguage[] {
  const languages = [options.language.primaryLanguage];
  if (options.language.resultLanguageMode === 'bilingual' && options.language.secondaryLanguage) languages.push(options.language.secondaryLanguage);
  if (options.language.resultLanguageMode === 'multilingual') languages.push(...(options.language.extraLanguages ?? []));
  return [...new Set(languages.map(normalizeLanguageAlias))];
}

/** 标准化语言别名；内部仍保留 zh/en 作为兼容输出。 */
export function normalizeLanguageAlias(language: ImageReverseLanguage): ImageReverseLanguage {
  if (language === 'zh-CN') return 'zh';
  if (language === 'en-US') return 'en';
  return language;
}

function normalizeMode(value: unknown, fallback: ImageReverseMode, enabledModes: ImageReverseMode[]): ImageReverseMode {
  const mode = String(value ?? '').trim() as ImageReverseMode;
  return enabledModes.includes(mode) ? mode : enabledModes.includes(fallback) ? fallback : enabledModes[0] ?? 'description';
}

function normalizeLanguage(value: unknown, fallback: ImageReverseLanguage, enabledLanguages: ImageReverseLanguage[]): ImageReverseLanguage {
  const language = String(value ?? '').trim() as ImageReverseLanguage;
  return enabledLanguages.includes(language) ? language : enabledLanguages.includes(fallback) ? fallback : 'zh';
}

function normalizePromptLanguage(value: unknown, fallback: ImageReversePromptLanguage): ImageReversePromptLanguage {
  const text = String(value ?? '').trim() as ImageReversePromptLanguage;
  if (text === 'auto' || text === 'bilingual' || ALL_LANGUAGES.includes(text as ImageReverseLanguage)) return text;
  return fallback || 'auto';
}

function normalizeLanguageMode(value: unknown): ImageReverseLanguageMode {
  const text = String(value ?? '').trim();
  if (text === 'bilingual' || text === 'multilingual') return text;
  return 'single';
}

function normalizeExtraLanguages(value: unknown, enabledLanguages: ImageReverseLanguage[]): ImageReverseLanguage[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeLanguage(item, 'zh', enabledLanguages)).slice(0, 3);
}

function normalizeSections(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const sections = value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 24);
  return sections.length ? sections : fallback;
}

function normalizeUnion<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = String(value ?? '').trim() as T;
  return allowed.includes(text) ? text : fallback;
}

function defaultSectionsForMode(mode: ImageReverseMode): string[] {
  if (mode === 'tags') return ['quality', 'character', 'details', 'composition', 'style', 'environment', 'negative'];
  if (mode === 'prompt') return ['positive', 'negative', 'character', 'composition', 'style', 'background'];
  if (mode === 'character') return ['profile', 'features', 'outfit', 'anchors', 'prompt', 'avoid'];
  if (mode === 'edit') return ['summary', 'keep', 'change', 'remove', 'avoid', 'mapping', 'prompt'];
  return ['overview', 'subjects', 'character', 'details', 'composition', 'style', 'colorLighting', 'backgroundAtmosphere', 'qualityTags', 'drawingPrompt', 'negativePrompt'];
}

function defaultSecondaryLanguage(primary: ImageReverseLanguage): ImageReverseLanguage {
  return primary === 'en' || primary === 'en-US' ? 'zh' : 'en';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseCsv(value: string | undefined): string[] {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}
