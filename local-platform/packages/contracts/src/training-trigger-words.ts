/**
 * 本文件统一训练集触发词的规范化、Caption 合并和公共标签汇总，避免 API 与打标 Worker 产生不同结果。
 */

/** 规范化用户输入或数据库中的英文训练标签。 */
export function normalizeTrainingTags(values: readonly string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    for (const part of value.toLowerCase().split(/[,，\n;；]+/)) {
      const tag = part.trim().replace(/\s+/g, " ");
      if (tag && !tags.includes(tag)) tags.push(tag);
    }
  }
  return tags.slice(0, 100);
}

/** 从允许为空的 JSON 字段读取历史触发词。 */
export function readTrainingTags(value: unknown): string[] {
  return Array.isArray(value) ? normalizeTrainingTags(value.filter((item): item is string => typeof item === "string")) : [];
}

/** 用新触发词替换此前自动注入部分，保留用户手工维护的其他 Caption 标签。 */
export function mergeCaptionWithTriggerWords(caption: string | null, previouslyApplied: unknown, triggerWords: readonly string[]): string | null {
  const applied = new Set(readTrainingTags(previouslyApplied));
  const retained = normalizeTrainingTags([caption || ""]).filter((tag) => !applied.has(tag));
  const merged = normalizeTrainingTags([...triggerWords, ...retained]);
  return merged.length ? merged.join(", ") : null;
}

/** 汇总每张图片共有标签，并始终包含用户主动设定的触发词。 */
export function summarizeTrainingTriggerWords(captions: readonly (string | null)[], triggerWords: readonly string[]): { triggerWords: string[]; commonTags: string[]; consensusTags: string[]; summaryTags: string[] } {
  const normalizedTriggers = normalizeTrainingTags(triggerWords);
  const tagSets = captions.map((caption) => normalizeTrainingTags([caption || ""]));
  const commonTags = tagSets.length === 0 ? [] : tagSets[0]!.filter((tag) => tagSets.every((tags) => tags.includes(tag)));
  const consensusTags = summarizeConsensusTags(tagSets, normalizedTriggers);
  return { triggerWords: normalizedTriggers, commonTags, consensusTags, summaryTags: normalizeTrainingTags([...normalizedTriggers, ...consensusTags]) };
}

/**
 * 从自动打标常见的同义写法中提取稳定共识；七成图片出现即可保留，避免个别漏标导致真实角色特征被丢弃。
 * 返回的标签只用于辅助用户设置触发词，不会自动回写训练图片 Caption。
 */
function summarizeConsensusTags(tagSets: readonly string[][], triggerWords: readonly string[]): string[] {
  if (tagSets.length === 0) return [];
  const triggerSet = new Set(triggerWords);
  const appearances = new Map<string, number>();
  for (const tags of tagSets) {
    const normalized = new Set(tags.map(canonicalizeConsensusTag));
    for (const tag of normalized) if (!triggerSet.has(tag)) appearances.set(tag, (appearances.get(tag) || 0) + 1);
  }
  const required = Math.max(1, Math.ceil(tagSets.length * 0.7));
  return [...appearances.entries()]
    .filter(([, count]) => count >= required)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([tag]) => tag)
    .slice(0, 100);
}

/** 把自动打标的颜色、长度和饰品近义词收敛为可读且可复用的角色特征标签。 */
function canonicalizeConsensusTag(tag: string): string {
  if (/\b(?:aqua|cyan|turquoise|light blue|blue)\b.*\bhair\b/.test(tag) && !/\b(?:ribbons?|bows?|ornament|accessor)/.test(tag)) return "blue hair";
  if (/\b(?:pink|purple|lavender)\b.*\bhair\b.*\b(?:streaks?|tips?|gradient)\b/.test(tag)) return "pink-purple hair accent";
  if (/\bheart(?:-shaped)?\b.*\b(?:ahoge|hair|ornament|accessory|strand)\b/.test(tag)) return "heart hair feature";
  if (/\b(?:blue|aqua|cyan|turquoise)\b.*\b(?:ribbons?|bows?)\b/.test(tag)) return "blue hair ribbon";
  if (/\b(?:horn|antler)\b.*\b(?:headpiece|hair ornament|hair accessory|ornament)\b/.test(tag)) return "horn-like headpiece";
  return tag;
}
