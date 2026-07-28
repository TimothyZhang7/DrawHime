/**
 * 本文件负责图片反推单项范围的提示词约束与结果归一化。
 * 单项结果使用独立结构，避免姿势、服装、角色外观等视觉维度互相污染。
 */
import type {
  ImageReverseExtractOptions,
  ImageReverseFocus,
  ImageReverseFocusedLanguageResultView,
  ImageReverseLanguage,
} from '@aiimage/shared-contracts';
import { normalizeLanguageAlias, selectedOutputLanguages } from './image-reverse-options.js';

type FocusDefinition = {
  label: string;
  include: string;
  exclude: string;
};

const FOCUS_DEFINITIONS: Record<Exclude<ImageReverseFocus, 'all'>, FocusDefinition> = {
  overall: {
    label: '整体画面',
    include: '画面类型、主要主体数量与大类、场景大类、整体空间关系和最显著的视觉印象',
    exclude: '角色五官发型、服装细节、具体姿势关节、镜头参数、画风技法、光影参数和背景小物件',
  },
  subject: {
    label: '主体关系',
    include: '主体种类、数量、主次关系、相对位置、遮挡关系和主体之间的互动',
    exclude: '角色身份外观、五官发型、服装配饰、肢体姿势细节、画风、光影和背景装饰',
  },
  character: {
    label: '角色外观',
    include: '体型轮廓、脸型五官、发型发色、眼睛、肤色、妆容和稳定身份特征',
    exclude: '当前姿势动作、手势、服装配饰、镜头构图、背景、光影和画风',
  },
  pose: {
    label: '姿势动作',
    include: '身体朝向、重心、躯干角度、四肢弯曲、手势、脚步、头部方向、视线方向和正在进行的动作',
    exclude: '脸型五官、发型发色、肤色体型等角色特征，服装配饰，背景物件，画风技法和光影色彩',
  },
  outfit: {
    label: '服装配饰',
    include: '服装品类、版型、层次、颜色、材质、纹理、图案、穿着方式、饰品和随身道具',
    exclude: '五官发型等角色特征、当前姿势动作、镜头构图、背景、画风和光影',
  },
  composition: {
    label: '构图镜头',
    include: '景别、裁切、视角、机位、透视、主体位置、视觉重心、前中后景和景深',
    exclude: '角色具体外观、服装细节、动作语义、画风技法、色彩光影和背景物件描述',
  },
  style: {
    label: '风格技法',
    include: '媒介、线条、笔触、上色方式、渲染方法、材质表现、细节密度和后期质感',
    exclude: '角色外观、服装、姿势、镜头位置、具体背景内容和光源方向',
  },
  lighting: {
    label: '色彩光影',
    include: '主色与辅色、色温、饱和度、明暗对比、主辅光方向、阴影、高光、轮廓光和环境光',
    exclude: '角色身份外观、服装款式、姿势动作、构图参数、画风技法和背景物件清单',
  },
  background: {
    label: '背景环境',
    include: '场所类型、背景物件、空间层次、地面墙面、远景、天气、时间感和环境氛围',
    exclude: '前景角色外观、服装配饰、姿势动作、镜头参数、画风技法和人物光影细节',
  },
};

/** 判断本次请求是否为描述模式的单项提取。 */
export function isFocusedImageReverse(options: ImageReverseExtractOptions): options is ImageReverseExtractOptions & { focus: Exclude<ImageReverseFocus, 'all'> } {
  return options.mode === 'description' && Boolean(options.focus) && options.focus !== 'all';
}

/** 构造严格单项提示词；允许项与排除项同时写入，防止模型返回综合分析。 */
export function buildImageReverseFocusPrompt(options: ImageReverseExtractOptions & { focus: Exclude<ImageReverseFocus, 'all'> }): string[] {
  const definition = FOCUS_DEFINITIONS[options.focus];
  return [
    `当前是“${definition.label}”单项提取，不是综合反推。`,
    `唯一允许分析：${definition.include}。`,
    `必须排除：${definition.exclude}。即使图片中清晰可见，也不得写入 summary、observations 或 promptFragment。`,
    'observations 每一项只能陈述当前范围内的一条可见事实；promptFragment 只能包含当前范围，可直接拼接到其他提示词片段。',
    `严格 JSON 结构：${buildFocusSchema(selectedOutputLanguages(options), options.focus)}`,
  ];
}

/** 归一化单项多语言结果；不从综合字段回填，从数据层保证范围隔离。 */
export function normalizeImageReverseFocusedLocalized(
  raw: unknown,
  options: ImageReverseExtractOptions & { focus: Exclude<ImageReverseFocus, 'all'> },
  limit: number,
): Partial<Record<ImageReverseLanguage, ImageReverseFocusedLanguageResultView>> {
  const root = readRecord(raw);
  const localized = readRecord(root.localized);
  const result: Partial<Record<ImageReverseLanguage, ImageReverseFocusedLanguageResultView>> = {};
  for (const language of selectedOutputLanguages(options)) {
    const normalizedLanguage = normalizeLanguageAlias(language);
    const source = readRecord(localized[normalizedLanguage] ?? localized[language] ?? root[normalizedLanguage] ?? root[language]);
    result[normalizedLanguage] = {
      focus: options.focus,
      summary: clampText(source.summary, limit),
      observations: readStringArray(source.observations, 32, 320),
      promptFragment: clampText(source.promptFragment, limit),
    };
  }
  return result;
}

/** 判断单项结果是否过短，需要携带原图再次规范化。 */
export function focusedImageReverseNeedsRepair(result: ImageReverseFocusedLanguageResultView | undefined): boolean {
  if (!result) return true;
  return result.summary.length < 24 || result.observations.length < 3 || result.promptFragment.length < 24;
}

function buildFocusSchema(languages: ImageReverseLanguage[], focus: Exclude<ImageReverseFocus, 'all'>): string {
  const localized = Object.fromEntries(
    languages.map((language) => [normalizeLanguageAlias(language), { summary: '', observations: [], promptFragment: '', focus }]),
  );
  return JSON.stringify({ localized });
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampText(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > limit ? text.slice(0, limit) : text;
}

function readStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}
