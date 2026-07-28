/**
 * 图片反推 Phase 4 质量校准执行器。
 *
 * 本脚本只读取公开图库与反推私有配置，真实调用视觉模型和 WD14 Provider，
 * 输出本地校准报告；不创建绘图任务、不扣费、不修改余额、任务、图库或系统配置。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ImageReverseService } from '../apps/backend/dist/modules/tools/image-reverse-service.js';
import { readImageReverseConfig } from '../apps/backend/dist/modules/tools/image-reverse-routes.js';
import { mergeImageReverseWd14Tags } from '../apps/backend/dist/modules/tools/image-reverse-anima-formatter.js';
import { attachImageReverseAnalysis } from '../apps/backend/dist/modules/tools/image-reverse-evidence.js';
import { ImageReverseWd14Service } from '../apps/backend/dist/modules/tools/image-reverse-wd14-service.js';

const GENERAL_THRESHOLDS = [0.30, 0.35, 0.40, 0.45, 0.50, 0.53];
const CHARACTER_THRESHOLDS = [0.75, 0.80, 0.85, 0.90];
const DEFAULT_SAMPLE_SIZE = 10;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const sampleSize = clampInteger(args.sampleSize, DEFAULT_SAMPLE_SIZE, 2, 30);
const publicBaseUrl = normalizeBaseUrl(args.baseUrl || process.env.APP_BASE_URL || 'https://www.xanime.ink');
const outputPath = resolve(args.output || `local/reports/image-reverse-calibration-${formatFileTimestamp(new Date())}.json`);
const markdownPath = outputPath.replace(/\.json$/i, '.md');
const blindReviewPath = outputPath.replace(/\.json$/i, '-blind-review.json');
const blindKeyPath = outputPath.replace(/\.json$/i, '-blind-key.json');
const reverseService = new ImageReverseService();
const wd14Service = new ImageReverseWd14Service();

const config = await readImageReverseConfig();
validateRuntimeConfig(config);
const samples = args.manifest
  ? await readManifestSamples(resolve(args.manifest), sampleSize)
  : await selectPublicGallerySamples(publicBaseUrl, sampleSize);

console.log(`[image-reverse-calibration] samples=${samples.length} base=${publicBaseUrl}`);
const runs = [];
for (const [index, sample] of samples.entries()) {
  console.log(`[image-reverse-calibration] ${index + 1}/${samples.length} task=${sample.taskId} date=${sample.createdAt}`);
  try {
    runs.push(await calibrateSample(sample, config, publicBaseUrl));
  } catch (error) {
    runs.push({ sample, status: 'failed', error: readError(error) });
    console.warn(`[image-reverse-calibration] sample_failed task=${sample.taskId} error=${readError(error)}`);
  }
}

const successfulRuns = runs.filter((run) => run.status === 'succeeded');
const report = {
  version: 'image-reverse-calibration-v1',
  generatedAt: new Date().toISOString(),
  publicBaseUrl,
  sampleStrategy: args.manifest ? 'fixed-manifest' : 'evenly-spaced-public-gallery',
  requestedSampleSize: sampleSize,
  successfulSamples: successfulRuns.length,
  failedSamples: runs.length - successfulRuns.length,
  model: config.model,
  wd14Model: config.wd14.model,
  configuredThresholds: {
    general: config.wd14.generalThreshold,
    character: config.wd14.characterThreshold,
  },
  thresholdGrid: {
    general: GENERAL_THRESHOLDS,
    character: CHARACTER_THRESHOLDS,
  },
  aggregate: aggregateThresholdRuns(successfulRuns),
  runs,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(markdownPath, buildMarkdownReport(report), 'utf8');
await writeFile(blindReviewPath, `${JSON.stringify(buildBlindReviewSheet(report), null, 2)}\n`, 'utf8');
await writeFile(blindKeyPath, `${JSON.stringify(buildBlindAnswerKey(report), null, 2)}\n`, 'utf8');
console.log(`[image-reverse-calibration] completed=${successfulRuns.length}/${runs.length}`);
console.log(`[image-reverse-calibration] json=${outputPath}`);
console.log(`[image-reverse-calibration] markdown=${markdownPath}`);
console.log(`[image-reverse-calibration] blind_review=${blindReviewPath}`);
if (successfulRuns.length < Math.max(2, Math.ceil(samples.length * 0.8))) process.exitCode = 1;

/** 对单张公开图库图片只执行一次视觉识别和一次最低阈值 WD14 推理，再在内存扫描全部阈值。 */
async function calibrateSample(sample, runtimeConfig, baseUrl) {
  const imageResponse = await fetch(resolvePublicUrl(baseUrl, sample.imageUrl), { signal: AbortSignal.timeout(60_000) });
  if (!imageResponse.ok) throw new Error(`公开图片下载失败 HTTP ${imageResponse.status}`);
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  if (bytes.length <= 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error(`公开图片大小异常 ${bytes.length}`);
  const mimeType = String(imageResponse.headers.get('content-type') || 'image/jpeg').split(';', 1)[0].trim();
  const options = buildCalibrationOptions();
  const startedAt = Date.now();
  const [visionResult, wd14Result] = await Promise.all([
    reverseService.extract(bytes, mimeType, { ...runtimeConfig, wd14: { ...runtimeConfig.wd14, enabled: false } }, options),
    wd14Service.tag(bytes, mimeType, {
      ...runtimeConfig.wd14,
      enabled: true,
      generalThreshold: GENERAL_THRESHOLDS[0],
      characterThreshold: CHARACTER_THRESHOLDS[0],
      maxTags: 500,
    }),
  ]);
  if (visionResult.mode !== 'tags') throw new Error('视觉链路没有返回标签结果');
  if (wd14Result.status !== 'succeeded') throw new Error(wd14Result.message || 'WD14 Provider 校准调用失败');
  const baselinePrompt = visionResult.tagPrompt.animaPrompt || visionResult.tagPrompt.positivePrompt;
  const variants = [];
  for (const generalThreshold of GENERAL_THRESHOLDS) {
    for (const characterThreshold of CHARACTER_THRESHOLDS) {
      const filteredTags = wd14Result.tags.filter((tag) => tag.category === 'general'
        ? tag.confidence >= generalThreshold
        : tag.confidence >= characterThreshold);
      const merged = mergeImageReverseWd14Tags(visionResult.tagPrompt, filteredTags, 'anima');
      const analyzed = attachImageReverseAnalysis({ ...visionResult, tagPrompt: merged }, {
        structuredOutputMode: visionResult.analysis?.structuredOutputMode ?? 'prompt-json',
        preprocessMs: 0,
        visionMs: 0,
        includeEvidence: true,
        repairAttempted: false,
        wd14: { ...wd14Result, tags: filteredTags },
      });
      const mergedPrompt = merged.animaPrompt || merged.positivePrompt;
      const baselineTags = splitPromptTags(baselinePrompt);
      const mergedTags = splitPromptTags(mergedPrompt);
      variants.push({
        generalThreshold,
        characterThreshold,
        generalTagCount: filteredTags.filter((tag) => tag.category === 'general').length,
        characterTagCount: filteredTags.filter((tag) => tag.category === 'character').length,
        mergedTagCount: mergedTags.size,
        addedTagCount: [...mergedTags].filter((tag) => !baselineTags.has(tag)).length,
        retainedBaselineTagCount: [...baselineTags].filter((tag) => mergedTags.has(tag)).length,
        conflictCount: analyzed.analysis?.conflicts?.length ?? 0,
        formatterStable: mergedPrompt === (mergeImageReverseWd14Tags(visionResult.tagPrompt, filteredTags, 'anima').animaPrompt || ''),
        promptHash: sha256(mergedPrompt),
        animaPrompt: mergedPrompt,
      });
    }
  }
  return {
    sample,
    status: 'succeeded',
    durationMs: Date.now() - startedAt,
    vision: {
      structuredOutputMode: visionResult.analysis?.structuredOutputMode,
      evidenceCount: visionResult.analysis?.sourceSummary?.reduce((total, item) => total + item.count, 0) ?? visionResult.analysis?.evidence.length ?? 0,
      promptHash: sha256(baselinePrompt),
      animaPrompt: baselinePrompt,
    },
    wd14: {
      durationMs: wd14Result.durationMs,
      providers: wd14Result.providers,
      rawGeneralCount: wd14Result.tags.filter((tag) => tag.category === 'general').length,
      rawCharacterCount: wd14Result.tags.filter((tag) => tag.category === 'character').length,
    },
    blindPair: buildBlindPair(sample.taskId, baselinePrompt, findConfiguredVariant(variants, runtimeConfig.wd14)),
    variants,
  };
}

/**
 * 生成可复用的固定公开图库样本。
 * 使用一次最新页与一次全库随机页后按创建时间等距取样，避免深页 OFFSET 拖慢线上图库查询。
 */
async function selectPublicGallerySamples(baseUrl, count) {
  const [latest, random] = await Promise.all([
    fetchGalleryPage(baseUrl, 1, 'latest', Math.min(50, Math.max(24, count * 2))),
    fetchGalleryPage(baseUrl, 1, 'random', 50),
  ]);
  const unique = new Map();
  for (const candidate of [...latest.items, ...random.items]) {
    if (candidate.mediaType === 'video' || !candidate.imageUrl || unique.has(candidate.taskId)) continue;
    unique.set(candidate.taskId, candidate);
  }
  const ordered = [...unique.values()].sort((left, right) => parseGalleryTime(left.createdAt) - parseGalleryTime(right.createdAt));
  const indices = evenlySpacedIntegers(0, Math.max(0, ordered.length - 1), Math.min(count, ordered.length));
  const samples = indices.map((index) => toSample(ordered[index]));
  if (samples.length < 2) throw new Error('公开图库没有足够的图片样本');
  return samples.slice(0, count);
}

async function fetchGalleryPage(baseUrl, page, sort = 'latest', pageSize = 24) {
  const url = `${baseUrl}/api/gallery?sort=${encodeURIComponent(sort)}&page=${page}&pageSize=${pageSize}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`图库接口失败 HTTP ${response.status}`);
  const body = JSON.parse(text);
  const data = body?.ok === true ? body.data : body;
  if (!data || !Array.isArray(data.items)) throw new Error('图库接口没有返回列表');
  return data;
}

function toSample(item) {
  return {
    taskId: String(item.taskId),
    imageUrl: String(item.imageUrl),
    createdAt: String(item.createdAt),
    source: String(item.source || ''),
    model: item.model ? String(item.model) : null,
    galleryTags: Array.isArray(item.tags) ? item.tags.map((tag) => ({ name: String(tag.name), category: String(tag.category), weight: Number(tag.weight) })) : [],
  };
}

async function readManifestSamples(path, count) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.runs) ? parsed.runs.map((run) => run.sample) : [];
  const samples = values.filter((item) => item?.taskId && item?.imageUrl).map((item) => ({
    taskId: String(item.taskId),
    imageUrl: String(item.imageUrl),
    createdAt: String(item.createdAt || ''),
    source: String(item.source || ''),
    model: item.model ? String(item.model) : null,
    galleryTags: Array.isArray(item.galleryTags) ? item.galleryTags : [],
  }));
  if (samples.length < 2) throw new Error('固定样本清单至少需要两张有效图片');
  return samples.slice(0, count);
}

/** 汇总每个阈值组合的规模、冲突率和格式稳定性；准确率仍需结合盲评结果判断。 */
function aggregateThresholdRuns(runs) {
  return GENERAL_THRESHOLDS.flatMap((generalThreshold) => CHARACTER_THRESHOLDS.map((characterThreshold) => {
    const variants = runs.map((run) => run.variants.find((item) => item.generalThreshold === generalThreshold && item.characterThreshold === characterThreshold)).filter(Boolean);
    return {
      generalThreshold,
      characterThreshold,
      samples: variants.length,
      averageGeneralTags: average(variants.map((item) => item.generalTagCount)),
      averageCharacterTags: average(variants.map((item) => item.characterTagCount)),
      averageAddedTags: average(variants.map((item) => item.addedTagCount)),
      conflictSampleRate: ratio(variants.filter((item) => item.conflictCount > 0).length, variants.length),
      formatterStableRate: ratio(variants.filter((item) => item.formatterStable).length, variants.length),
    };
  }));
}

/** 构造盲评对，不把 A/B 标签与真实管线的对应关系混入人工评分界面。 */
function buildBlindPair(taskId, visionPrompt, configuredVariant) {
  const hybridPrompt = configuredVariant?.animaPrompt || visionPrompt;
  const hybridFirst = Number.parseInt(sha256(taskId).slice(0, 2), 16) % 2 === 0;
  return {
    pairId: `pair_${sha256(taskId).slice(0, 12)}`,
    promptA: hybridFirst ? hybridPrompt : visionPrompt,
    promptB: hybridFirst ? visionPrompt : hybridPrompt,
    answer: hybridFirst ? { A: 'hybrid', B: 'vision-only' } : { A: 'vision-only', B: 'hybrid' },
  };
}

/** 输出不含真实管线答案的盲评表，评分人只比较 A/B 生成效果。 */
function buildBlindReviewSheet(report) {
  return {
    version: 'image-reverse-blind-review-v1',
    generatedAt: report.generatedAt,
    pairs: report.runs.filter((run) => run.status === 'succeeded').map((run) => ({
      pairId: run.blindPair.pairId,
      taskId: run.sample.taskId,
      referenceImageUrl: resolvePublicUrl(report.publicBaseUrl, run.sample.imageUrl),
      promptA: run.blindPair.promptA,
      promptB: run.blindPair.promptB,
      scores: {
        compositionA: null,
        compositionB: null,
        characterA: null,
        characterB: null,
        actionA: null,
        actionB: null,
        backgroundA: null,
        backgroundB: null,
        styleA: null,
        styleB: null,
        overallWinner: null,
        notes: '',
      },
    })),
  };
}

/** 单独保存盲评答案键，避免评分时提前看到 A/B 对应管线。 */
function buildBlindAnswerKey(report) {
  return {
    version: 'image-reverse-blind-key-v1',
    generatedAt: report.generatedAt,
    answers: Object.fromEntries(report.runs.filter((run) => run.status === 'succeeded').map((run) => [run.blindPair.pairId, run.blindPair.answer])),
  };
}

function findConfiguredVariant(variants, wd14Config) {
  return variants.reduce((best, item) => {
    const distance = Math.abs(item.generalThreshold - wd14Config.generalThreshold) + Math.abs(item.characterThreshold - wd14Config.characterThreshold);
    if (!best || distance < best.distance) return { ...item, distance };
    return best;
  }, undefined);
}

function buildCalibrationOptions() {
  return {
    mode: 'tags',
    language: { resultLanguageMode: 'bilingual', primaryLanguage: 'zh', secondaryLanguage: 'en', promptLanguage: 'en' },
    detailLevel: 'forensic',
    sections: ['tags'],
    focus: 'all',
    tagPreset: 'anima',
    tagDensity: 'rich',
    tagWeightMode: 'none',
    includeEvidence: true,
    analysisMode: 'vision-only',
  };
}

function buildMarkdownReport(report) {
  const configured = report.aggregate.find((item) => item.generalThreshold === report.configuredThresholds.general && item.characterThreshold === report.configuredThresholds.character)
    || nearestAggregate(report.aggregate, report.configuredThresholds);
  const dates = report.runs.map((run) => run.sample?.createdAt).filter(Boolean).sort((left, right) => parseGalleryTime(left) - parseGalleryTime(right));
  const earliest = dates.length > 0 ? dates[0] : '-';
  const latest = dates.length > 0 ? dates[dates.length - 1] : '-';
  const characterEvidenceObserved = report.aggregate.some((item) => item.averageCharacterTags > 0);
  const averageDurationSeconds = average(report.runs.filter((run) => run.status === 'succeeded').map((run) => run.durationMs / 1000));
  const rows = report.aggregate.map((item) => `| ${item.generalThreshold.toFixed(2)} | ${item.characterThreshold.toFixed(2)} | ${item.averageGeneralTags.toFixed(1)} | ${item.averageCharacterTags.toFixed(1)} | ${item.averageAddedTags.toFixed(1)} | ${(item.conflictSampleRate * 100).toFixed(1)}% | ${(item.formatterStableRate * 100).toFixed(1)}% |`).join('\n');
  return `# 图片反推质量校准运行报告\n\n## 运行摘要\n\n- 生成时间：${report.generatedAt}\n- 样本策略：${report.sampleStrategy}\n- 成功样本：${report.successfulSamples}/${report.requestedSampleSize}\n- 时间跨度：${earliest} ～ ${latest}\n- 视觉模型：${report.model}\n- WD14 模型：${report.wd14Model}\n- 当前阈值：general ${report.configuredThresholds.general} / character ${report.configuredThresholds.character}\n- 单样本平均完整耗时：${averageDurationSeconds.toFixed(1)} 秒\n\n当前阈值在本次样本中平均增加 ${configured?.averageAddedTags?.toFixed(1) ?? '-'} 个标签，冲突样本率 ${configured ? `${(configured.conflictSampleRate * 100).toFixed(1)}%` : '-'}。该统计用于控制标签规模和冲突，不把视觉模型重合率当作真实准确率；最终阈值仍需结合同一批固定样本的 Anima A/B 盲评。\n\n${characterEvidenceObserved ? '' : '> 本批样本在最低 character 阈值 0.75 下仍未出现 character 标签，因此本轮只校准 general 标签规模；character 阈值继续保持现有配置，等待包含已知角色标签的专项样本。\n\n'}## 阈值扫描\n\n| General | Character | 平均 General | 平均 Character | 平均新增 | 冲突样本率 | 格式稳定率 |\n|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n## 验收说明\n\n- 每张图只执行一次视觉识别与一次最低阈值 WD14 推理，全部阈值组合在本地从同一证据重放。\n- JSON 报告保留固定样本、全部 A/B Prompt、阈值指标和盲评答案；重新运行时可通过 \`--manifest\` 复用相同样本。\n- 脚本不创建绘图任务、不扣费、不写系统配置；阈值调整必须在盲评完成后单独实施。\n`;
}

function nearestAggregate(values, target) {
  return values.reduce((best, item) => {
    const distance = Math.abs(item.generalThreshold - target.general) + Math.abs(item.characterThreshold - target.character);
    return !best || distance < best.distance ? { ...item, distance } : best;
  }, undefined);
}

function splitPromptTags(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function evenlySpacedIntegers(min, max, count) {
  if (count <= 1 || min === max) return [min];
  return [...new Set(Array.from({ length: count }, (_, index) => Math.round(min + ((max - min) * index) / (count - 1))))];
}

/** 兼容图库返回的北京时间字符串和 ISO 时间。 */
function parseGalleryTime(value) {
  const text = String(value || '').trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}+08:00` : text;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function validateRuntimeConfig(runtimeConfig) {
  if (!runtimeConfig.enabled || !runtimeConfig.baseUrl || !runtimeConfig.apiKey) throw new Error('图片反推视觉 Provider 配置不完整');
  if (!runtimeConfig.wd14.enabled || !runtimeConfig.wd14.baseUrl || !runtimeConfig.wd14.apiKey) throw new Error('WD14 Provider 配置不完整');
}

function resolvePublicUrl(baseUrl, value) {
  return new URL(String(value), `${baseUrl}/`).toString();
}

function normalizeBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, '');
}

function average(values) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function ratio(value, total) {
  return total > 0 ? value / total : 0;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function formatFileTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function readError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(values) {
  const output = {};
  for (const value of values) {
    if (value.startsWith('--sample-size=')) output.sampleSize = value.slice('--sample-size='.length);
    else if (value.startsWith('--base-url=')) output.baseUrl = value.slice('--base-url='.length);
    else if (value.startsWith('--output=')) output.output = value.slice('--output='.length);
    else if (value.startsWith('--manifest=')) output.manifest = value.slice('--manifest='.length);
  }
  return output;
}
