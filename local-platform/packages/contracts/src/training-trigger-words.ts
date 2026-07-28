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
export function summarizeTrainingTriggerWords(captions: readonly (string | null)[], triggerWords: readonly string[]): { triggerWords: string[]; commonTags: string[]; summaryTags: string[] } {
  const normalizedTriggers = normalizeTrainingTags(triggerWords);
  const tagSets = captions.map((caption) => normalizeTrainingTags([caption || ""]));
  const commonTags = tagSets.length === 0 ? [] : tagSets[0]!.filter((tag) => tagSets.every((tags) => tags.includes(tag)));
  return { triggerWords: normalizedTriggers, commonTags, summaryTags: normalizeTrainingTags([...normalizedTriggers, ...commonTags]) };
}
