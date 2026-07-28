/**
 * 本文件实现 Anima 标签的确定性格式化，只重排真实识图标签，不补充图片中不存在的内容。
 */
import type { ImageReverseLocalModelTagView, ImageReverseTagPreset, ImageReverseTagResultView } from '@aiimage/shared-contracts';
import type { ImageReverseWd14Tag } from './image-reverse-wd14-service.js';

/** Anima 格式器版本；任务结果持久化该值，便于后续回归和重放。 */
export const IMAGE_REVERSE_ANIMA_FORMATTER_VERSION = 'anima-slot-v1';

/** 按角色、细节、动作镜头、环境、画风、质量槽位生成小写无权重单行提示词。 */
export function formatImageReverseAnimaPrompt(input: {
  characterTags: ImageReverseLocalModelTagView[];
  detailTags: ImageReverseLocalModelTagView[];
  compositionTags: ImageReverseLocalModelTagView[];
  environmentTags: ImageReverseLocalModelTagView[];
  styleTags: ImageReverseLocalModelTagView[];
  qualityTags: ImageReverseLocalModelTagView[];
}): string {
  const seen = new Set<string>();
  const ordered = [
    ...input.characterTags,
    ...input.detailTags,
    ...input.compositionTags,
    ...input.environmentTags,
    ...input.styleTags,
    ...input.qualityTags,
  ];
  return ordered
    .map((item) => item.en.trim().toLowerCase())
    .filter((tag) => {
      if (!tag || seen.has(tag)) return false;
      seen.add(tag);
      return true;
    })
    .join(', ');
}

/** 把 WD14 高置信度标签并入视觉标签，再重新生成标准与 Anima Prompt。 */
export function mergeImageReverseWd14Tags(tagPrompt: ImageReverseTagResultView, wd14Tags: ImageReverseWd14Tag[], preset: ImageReverseTagPreset): ImageReverseTagResultView {
  if (wd14Tags.length === 0) return tagPrompt;
  const characterAdditions = wd14Tags.filter((item) => item.category === 'character').map(toLocalTag);
  const detailAdditions = wd14Tags.filter((item) => item.category === 'general').map(toLocalTag);
  const characterTags = mergeTagLists(tagPrompt.characterTags, characterAdditions);
  const detailTags = mergeTagLists(tagPrompt.detailTags, detailAdditions);
  const animaPrompt = formatImageReverseAnimaPrompt({
    characterTags,
    detailTags,
    compositionTags: tagPrompt.compositionTags,
    environmentTags: tagPrompt.environmentTags,
    styleTags: tagPrompt.styleTags,
    qualityTags: tagPrompt.qualityTags,
  });
  const positiveTags = [
    ...tagPrompt.qualityTags,
    ...characterTags,
    ...detailTags,
    ...tagPrompt.compositionTags,
    ...tagPrompt.styleTags,
    ...tagPrompt.environmentTags,
  ];
  const useAnima = preset === 'anima';
  return {
    ...tagPrompt,
    characterTags,
    detailTags,
    positivePrompt: useAnima ? animaPrompt : joinLocalTags(positiveTags, false),
    positivePromptWithWeights: useAnima ? animaPrompt : joinLocalTags(positiveTags, true),
    animaPrompt,
    formatterVersion: IMAGE_REVERSE_ANIMA_FORMATTER_VERSION,
  };
}

function toLocalTag(tag: ImageReverseWd14Tag): ImageReverseLocalModelTagView {
  const normalized = tag.name.toLowerCase()
    .replace(/[(){}[\]"'`]/g, '')
    .replace(/[^a-z0-9_\-\s]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return { zh: normalized, en: normalized, weight: 1 };
}

function mergeTagLists(base: ImageReverseLocalModelTagView[], additions: ImageReverseLocalModelTagView[]): ImageReverseLocalModelTagView[] {
  const seen = new Set<string>();
  return [...base, ...additions].filter((item) => {
    const key = item.en.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function joinLocalTags(tags: ImageReverseLocalModelTagView[], weighted: boolean): string {
  return tags.map((tag) => weighted && Math.abs(tag.weight - 1) >= 0.01 ? `(${tag.en}:${tag.weight.toFixed(2)})` : tag.en).join(', ');
}
