/**
 * 本文件把真实图片反推结果确定性转换为可追溯证据和阶段审计，不调用额外模型、不虚构置信度。
 */
import type {
  ImageReverseAnalysisView,
  ImageReverseDescriptionLanguageResultView,
  ImageReverseEvidenceCategory,
  ImageReverseEvidenceConflictView,
  ImageReverseEvidenceItemView,
  ImageReverseLanguage,
  ImageReverseResultView,
  ImageReverseEvidenceSourceSummaryView,
  ImageReverseStructuredOutputMode,
} from '@aiimage/shared-contracts';
import type { ImageReverseWd14RunResult, ImageReverseWd14Tag } from './image-reverse-wd14-service.js';

/** 当前证据归一化版本。 */
export const IMAGE_REVERSE_EVIDENCE_FORMATTER_VERSION = 'reverse-evidence-v1';

/** 为当前真实识图结果附加可持久化的证据、Provider 和阶段信息。 */
export function attachImageReverseAnalysis(result: ImageReverseResultView, input: {
  structuredOutputMode: ImageReverseStructuredOutputMode;
  preprocessMs: number;
  visionMs: number;
  includeEvidence: boolean;
  repairAttempted: boolean;
  wd14: ImageReverseWd14RunResult;
}): ImageReverseResultView {
  const normalizedEvidence = collectEvidence(result, input.wd14).slice(0, 240);
  const evidence = input.includeEvidence ? normalizedEvidence : [];
  const sourceSummary = buildSourceSummary(normalizedEvidence);
  const conflicts = detectEvidenceConflicts(normalizedEvidence);
  const warnings: string[] = [];
  if (input.structuredOutputMode !== 'json-schema') {
    warnings.push(input.structuredOutputMode === 'json-object'
      ? '当前上游使用 JSON Object 兼容模式，字段已由后端再次校验。'
      : '当前上游不支持 response_format，结果依靠严格提示词和后端字段校验。');
  }
  if (input.repairAttempted) warnings.push('第一轮结构不完整，已使用同一原图完成一次受控修复。');
  if (result.mode === 'tags') warnings.push('视觉模型标签没有统计置信度；只有 WD14 标签展示模型原生概率，生成权重不代表识别概率。');
  if (input.wd14.status === 'failed') warnings.push(`${input.wd14.message ?? 'WD14 Provider 失败'}，本次已降级为视觉证据。`);
  if (input.includeEvidence && normalizedEvidence.length === 0) warnings.push('当前结果没有可展示的结构化证据。');
  if (conflicts.length > 0) warnings.push(`检测到 ${conflicts.length} 组高影响互斥证据，已保留原始依据供核对，未自动改写最终 Prompt。`);

  const analysis: ImageReverseAnalysisView = {
    pipeline: input.wd14.status === 'succeeded' ? 'hybrid' : 'vision-only',
    structuredOutputMode: input.structuredOutputMode,
    formatterVersion: IMAGE_REVERSE_EVIDENCE_FORMATTER_VERSION,
    providers: [
      {
        provider: 'vision',
        label: '视觉模型',
        model: result.model,
        status: 'succeeded',
        durationMs: input.visionMs,
      },
      {
        provider: 'wd14',
        label: 'WD14 标签器',
        model: input.wd14.model,
        status: input.wd14.status,
        durationMs: input.wd14.durationMs || undefined,
        message: input.wd14.providers.length > 0 ? input.wd14.providers.join(', ') : input.wd14.message,
      },
    ],
    stages: [
      { id: 'preprocess', label: '图像预处理', status: 'succeeded', durationMs: input.preprocessMs },
      { id: 'vision_evidence', label: '视觉证据提取', status: 'succeeded', durationMs: input.visionMs },
      { id: 'tag_evidence', label: '专用标签证据', status: input.wd14.status, durationMs: input.wd14.durationMs || undefined, message: input.wd14.providers.join(', ') || input.wd14.message },
      { id: 'merge', label: '证据归一化', status: 'succeeded' },
      { id: 'format', label: '目标格式输出', status: 'succeeded' },
      { id: 'persist', label: '任务结果持久化', status: 'succeeded' },
    ],
    evidence,
    sourceSummary,
    conflicts,
    warnings,
  };
  return { ...result, analysis } as ImageReverseResultView;
}

function collectEvidence(result: ImageReverseResultView, wd14: ImageReverseWd14RunResult): ImageReverseEvidenceItemView[] {
  const pending: Array<Omit<ImageReverseEvidenceItemView, 'id'>> = [];
  if (result.mode === 'tags') {
    const wd14ByName = new Map(wd14.tags.map((item) => [normalizeTagName(item.name), item]));
    appendTagEvidence(pending, 'quality', result.tagPrompt.qualityTags.map((item) => item.en), wd14ByName);
    appendTagEvidence(pending, 'character', result.tagPrompt.characterTags.map((item) => item.en), wd14ByName);
    appendTagEvidence(pending, 'detail', result.tagPrompt.detailTags.map((item) => item.en), wd14ByName);
    appendTagEvidence(pending, 'composition', result.tagPrompt.compositionTags.map((item) => item.en));
    appendTagEvidence(pending, 'style', result.tagPrompt.styleTags.map((item) => item.en));
    appendTagEvidence(pending, 'background', result.tagPrompt.environmentTags.map((item) => item.en));
    appendTagEvidence(pending, 'negative', result.tagPrompt.negativeTags.map((item) => item.en));
  } else if (result.mode === 'description') {
    for (const [language, value] of Object.entries(result.localized)) {
      if (value) appendDescriptionEvidence(pending, value, language as ImageReverseLanguage);
    }
  } else if (result.mode === 'prompt') {
    appendText(pending, 'character', result.characterPrompt);
    appendText(pending, 'composition', result.compositionPrompt);
    appendText(pending, 'style', result.stylePrompt);
    appendText(pending, 'background', result.backgroundPrompt);
    appendText(pending, 'negative', result.negativePrompt);
  } else if (result.mode === 'character') {
    appendText(pending, 'character', result.summary);
    appendText(pending, 'character', result.identityAnchors);
    appendText(pending, 'outfit', result.outfitBreakdown);
    appendText(pending, 'detail', result.featureBreakdown);
  } else {
    appendText(pending, 'subject', result.sourceSummary);
    appendText(pending, 'detail', result.keep);
    appendText(pending, 'detail', result.change);
    appendText(pending, 'negative', result.avoid);
  }
  return dedupeEvidence(pending).map((item, index) => ({ ...item, id: `evidence_${String(index + 1).padStart(3, '0')}` }));
}

function appendDescriptionEvidence(target: Array<Omit<ImageReverseEvidenceItemView, 'id'>>, value: ImageReverseDescriptionLanguageResultView, language: ImageReverseLanguage): void {
  appendText(target, 'subject', [value.overview, ...value.subjects], language);
  appendText(target, 'character', [value.character.type, value.character.countAndRole, value.character.bodyAndProportion, value.character.faceFeatures, value.character.hair, value.character.eyes, value.character.skinAndMakeup], language);
  appendText(target, 'expression', value.character.expressionAndTemperament, language);
  appendText(target, 'outfit', [value.character.outfit, value.character.accessoriesAndProps], language);
  appendText(target, 'action', value.character.poseAndAction, language);
  appendText(target, 'detail', value.details, language);
  appendText(target, 'composition', value.composition, language);
  appendText(target, 'style', value.style, language);
  appendText(target, 'lighting', value.colorLighting, language);
  appendText(target, 'background', value.backgroundAtmosphere, language);
  appendText(target, 'quality', value.qualityTags, language);
}

function appendTagEvidence(target: Array<Omit<ImageReverseEvidenceItemView, 'id'>>, category: ImageReverseEvidenceCategory, values: string[], wd14ByName: Map<string, ImageReverseWd14Tag> = new Map()): void {
  for (const text of values) {
    const wd14 = wd14ByName.get(normalizeTagName(text));
    target.push({ category, text, source: wd14 ? 'wd14' : 'vision', confidence: wd14?.confidence, language: 'en' });
  }
}

function appendText(target: Array<Omit<ImageReverseEvidenceItemView, 'id'>>, category: ImageReverseEvidenceCategory, value: string | string[], language?: ImageReverseLanguage): void {
  const values = Array.isArray(value) ? value : [value];
  for (const text of values.map((item) => item.trim()).filter(Boolean)) target.push({ category, text, source: 'vision', language });
}

function dedupeEvidence(values: Array<Omit<ImageReverseEvidenceItemView, 'id'>>): Array<Omit<ImageReverseEvidenceItemView, 'id'>> {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = `${item.language ?? ''}:${item.category}:${item.text.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTagName(value: string): string {
  return value.toLowerCase().replace(/[(){}[\]"'`]/g, '').replace(/[^a-z0-9_\-\s]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

/** 按真实证据来源汇总数量；没有原生分数时不生成平均值或推测置信度。 */
function buildSourceSummary(evidence: ImageReverseEvidenceItemView[]): ImageReverseEvidenceSourceSummaryView[] {
  const labels = { vision: '视觉模型', wd14: 'WD14 标签器', metadata: '可信元数据', user: '用户要求', derived: '确定性派生' } as const;
  const counts = new Map<ImageReverseEvidenceItemView['source'], { count: number; confidenceCount: number }>();
  for (const item of evidence) {
    const current = counts.get(item.source) ?? { count: 0, confidenceCount: 0 };
    current.count += 1;
    if (item.confidence !== undefined) current.confidenceCount += 1;
    counts.set(item.source, current);
  }
  return [...counts.entries()].map(([source, value]) => ({ source, label: labels[source], ...value }));
}

interface ConflictRule {
  category: ImageReverseEvidenceCategory;
  label: string;
  options: Array<{ label: string; tags: string[] }>;
}

/**
 * 只检查标签模式中可精确匹配的高影响互斥标签。
 * 自然语言段落不会参与关键词猜测，避免把“未坐下”等上下文误报为姿势冲突。
 */
function detectEvidenceConflicts(evidence: ImageReverseEvidenceItemView[]): ImageReverseEvidenceConflictView[] {
  const conflicts: ImageReverseEvidenceConflictView[] = [];
  for (const rule of CONFLICT_RULES) {
    const matched = rule.options.flatMap((option) => evidence
      .filter((item) => option.tags.includes(normalizeTagName(item.text)))
      .map((item) => ({ label: option.label, text: item.text, source: item.source, confidence: item.confidence })));
    if (new Set(matched.map((item) => item.label)).size < 2) continue;
    conflicts.push({
      id: `conflict_${String(conflicts.length + 1).padStart(2, '0')}`,
      category: rule.category,
      label: rule.label,
      values: matched,
      resolution: '同一互斥组存在多个来源或多个候选值；保留原始证据供核对，不在依据不足时自动改写最终 Prompt。',
    });
  }
  return conflicts;
}

const CONFLICT_RULES: ConflictRule[] = [
  {
    category: 'subject',
    label: '主体数量',
    options: [
      { label: '单人', tags: ['solo', '1girl', '1boy', '1other'] },
      { label: '多人', tags: ['2girls', '2boys', 'multiple_girls', 'multiple_boys', 'group'] },
    ],
  },
  {
    category: 'action',
    label: '主体姿势',
    options: [
      { label: '站立', tags: ['standing'] },
      { label: '坐姿', tags: ['sitting'] },
      { label: '躺姿', tags: ['lying', 'on_back', 'on_stomach'] },
      { label: '跪姿', tags: ['kneeling'] },
    ],
  },
  {
    category: 'expression',
    label: '眼睛状态',
    options: [
      { label: '睁眼', tags: ['open_eyes'] },
      { label: '闭眼', tags: ['closed_eyes'] },
    ],
  },
  {
    category: 'composition',
    label: '人物朝向',
    options: [
      { label: '正面', tags: ['front_view', 'facing_viewer'] },
      { label: '侧面', tags: ['side_view', 'profile'] },
      { label: '背面', tags: ['from_behind', 'back_view'] },
    ],
  },
  {
    category: 'background',
    label: '场景类型',
    options: [
      { label: '室内', tags: ['indoors'] },
      { label: '室外', tags: ['outdoors'] },
    ],
  },
];
