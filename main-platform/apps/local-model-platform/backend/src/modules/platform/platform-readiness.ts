/** 本文件负责计算独立本地模型平台的资产就绪状态与提交前校验。 */
import { stat } from 'node:fs/promises';
import {
  LOCAL_MODEL_REGISTRY_SEED,
  type LocalModelAssetView,
  type LocalModelGenerationValidateRequest,
  type LocalModelPlatformReadinessView,
  type LocalModelRunValidationResponse,
  type LocalModelTrainingValidateRequest,
  type LocalModelValidationIssueView,
} from '@aiimage/local-model-platform-shared';
import type { LocalModelExecutorRuntimeStatus } from './platform-executor.js';

/** Qwen Image VAE 的首批资产键。 */
const VAE_MODEL_KEY = 'qwen_image_vae.safetensors';

/** Qwen3-VL 文本/识图资产键。 */
const CAPTION_MODEL_KEY = 'qwen3vl_4b_fp8_scaled.safetensors';

/** 根据资产扫描结果计算平台就绪摘要。 */
export function buildLocalModelReadiness(
  assets: readonly LocalModelAssetView[],
  executorStatus: LocalModelExecutorRuntimeStatus,
): LocalModelPlatformReadinessView {
  const assetByKey = buildAssetMap(assets);
  const generationModelKeys = LOCAL_MODEL_REGISTRY_SEED.filter((item) => item.usage === 'generation' && !isLoraModelKey(item.modelKey)).map((item) => item.modelKey);
  const loraKeys = LOCAL_MODEL_REGISTRY_SEED.filter((item) => isLoraModelKey(item.modelKey)).map((item) => item.modelKey);
  const missingModelKeys = LOCAL_MODEL_REGISTRY_SEED.filter((item) => !assetByKey.get(item.modelKey)?.exists).map((item) => item.modelKey);
  const missingGenerationModelKeys = generationModelKeys.filter((modelKey) => !assetByKey.get(modelKey)?.exists);
  const missingLoraKeys = loraKeys.filter((modelKey) => !assetByKey.get(modelKey)?.exists);
  const generationAssetsReady = generationModelKeys.some((modelKey) => assetByKey.get(modelKey)?.exists);
  const captionAssetsReady = Boolean(assetByKey.get(CAPTION_MODEL_KEY)?.exists);
  const vaeReady = Boolean(assetByKey.get(VAE_MODEL_KEY)?.exists);
  const trainingAssetsReady = generationAssetsReady && captionAssetsReady;

  return {
    totalAssets: assets.length,
    existingAssets: assets.filter((item) => item.exists).length,
    missingAssets: assets.filter((item) => !item.exists).length,
    generationAssetsReady,
    captionAssetsReady,
    vaeReady,
    trainingAssetsReady,
    executorConfigured: executorStatus.executorConfigured,
    generationExecutorConfigured: executorStatus.generationExecutorConfigured,
    trainingExecutorConfigured: executorStatus.trainingExecutorConfigured,
    outputDirectoryReady: executorStatus.outputDirectoryReady,
    generationReady: generationAssetsReady && vaeReady && executorStatus.generationExecutorConfigured,
    trainingReady: trainingAssetsReady && executorStatus.trainingExecutorConfigured,
    missingModelKeys,
    missingGenerationModelKeys,
    missingLoraKeys,
  };
}

/** 校验生成请求是否具备创建真实任务的前置条件。 */
export function validateLocalModelGenerationRequest(
  input: LocalModelGenerationValidateRequest,
  assets: readonly LocalModelAssetView[],
  executorStatus: LocalModelExecutorRuntimeStatus,
): LocalModelRunValidationResponse {
  const issues: LocalModelValidationIssueView[] = [];
  const assetByKey = buildAssetMap(assets);
  const fallbackModelKey = getDefaultGenerationModelKey();
  const modelKey = normalizeString(input.modelKey) || fallbackModelKey;
  const loraKeys = normalizeStringList(input.loraKeys);
  const requiredKeys = uniqueStrings([modelKey, VAE_MODEL_KEY, ...loraKeys]);

  if (!normalizeString(input.prompt)) {
    issues.push(createIssue('prompt', 'prompt_required', '提示词不能为空'));
  } else if (normalizeString(input.prompt).length > 4000) {
    issues.push(createIssue('prompt', 'prompt_too_long', '提示词不能超过 4000 个字符'));
  }

  validateImageDimension('width', input.width, issues);
  validateImageDimension('height', input.height, issues);
  validateSteps(input.steps, issues);

  if (!isBaseGenerationModelKey(modelKey)) {
    issues.push(createIssue('modelKey', 'generation_model_invalid', '生成模型必须是已登记的基础生成模型，不能使用 LoRA 或未知文件'));
  }

  for (const loraKey of loraKeys) {
    if (!isLoraModelKey(loraKey)) {
      issues.push(createIssue('loraKeys', 'lora_model_invalid', `LoRA 未登记或类型不正确：${loraKey}`));
    }
  }

  pushMissingAssetIssues(requiredKeys, assetByKey, issues);
  pushExecutorIssue(issues, executorStatus, 'generation');

  return {
    accepted: issues.every((item) => item.severity !== 'error'),
    readiness: buildLocalModelReadiness(assets, executorStatus),
    issues,
    requiredAssets: requiredKeys.map((key) => getRequiredAssetView(key, assetByKey)),
  };
}

/** 校验 LoRA 训练请求是否具备创建真实任务的前置条件。 */
export async function validateLocalModelTrainingRequest(
  input: LocalModelTrainingValidateRequest,
  assets: readonly LocalModelAssetView[],
  executorStatus: LocalModelExecutorRuntimeStatus,
): Promise<LocalModelRunValidationResponse> {
  const issues: LocalModelValidationIssueView[] = [];
  const assetByKey = buildAssetMap(assets);
  const baseModelKey = normalizeString(input.baseModelKey) || getDefaultGenerationModelKey();
  const requiredKeys = uniqueStrings([baseModelKey, CAPTION_MODEL_KEY]);
  const datasetPath = normalizeString(input.datasetPath);
  const outputName = normalizeString(input.outputName);

  if (!isBaseGenerationModelKey(baseModelKey)) {
    issues.push(createIssue('baseModelKey', 'training_base_model_invalid', '训练底模必须是已登记的基础生成模型，不能使用 LoRA 或未知文件'));
  }

  if (!datasetPath) {
    issues.push(createIssue('datasetPath', 'dataset_required', '训练数据集路径不能为空'));
  } else if (!(await directoryExists(datasetPath))) {
    issues.push(createIssue('datasetPath', 'dataset_not_found', '训练数据集目录不存在或不可读取'));
  }

  if (!outputName) {
    issues.push(createIssue('outputName', 'output_name_required', '输出 LoRA 名称不能为空'));
  } else if (!/^[a-zA-Z0-9._-]{2,80}$/.test(outputName)) {
    issues.push(createIssue('outputName', 'output_name_invalid', '输出 LoRA 名称只能包含字母、数字、点、下划线和短横线，长度 2-80'));
  }

  if (typeof input.rank !== 'number' || !Number.isInteger(input.rank) || input.rank < 4 || input.rank > 256) {
    issues.push(createIssue('rank', 'rank_invalid', 'LoRA rank 必须是 4 到 256 的整数'));
  }

  if (typeof input.maxSteps !== 'number' || !Number.isInteger(input.maxSteps) || input.maxSteps < 100 || input.maxSteps > 200000) {
    issues.push(createIssue('maxSteps', 'max_steps_invalid', '最大训练步数必须是 100 到 200000 的整数'));
  }

  pushMissingAssetIssues(requiredKeys, assetByKey, issues);
  pushExecutorIssue(issues, executorStatus, 'training');

  return {
    accepted: issues.every((item) => item.severity !== 'error'),
    readiness: buildLocalModelReadiness(assets, executorStatus),
    issues,
    requiredAssets: requiredKeys.map((key) => getRequiredAssetView(key, assetByKey)),
  };
}

/** 判断模型键是否属于 LoRA。 */
export function isLoraModelKey(modelKey: string) {
  const seed = LOCAL_MODEL_REGISTRY_SEED.find((item) => item.modelKey === modelKey);
  return Boolean(seed?.tags.some((tag) => tag.toLowerCase() === 'lora'));
}

/** 判断模型键是否属于基础生成模型。 */
function isBaseGenerationModelKey(modelKey: string) {
  const seed = LOCAL_MODEL_REGISTRY_SEED.find((item) => item.modelKey === modelKey);
  return Boolean(seed && seed.usage === 'generation' && !isLoraModelKey(seed.modelKey));
}

/** 获取默认生成模型键。 */
function getDefaultGenerationModelKey() {
  return LOCAL_MODEL_REGISTRY_SEED.find((item) => item.usage === 'generation' && !isLoraModelKey(item.modelKey))?.modelKey ?? '';
}

/** 构建资产快速索引。 */
function buildAssetMap(assets: readonly LocalModelAssetView[]) {
  return new Map(assets.map((item) => [item.modelKey, item]));
}

/** 规范化字符串。 */
function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 规范化字符串列表。 */
function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeString(item)).filter(Boolean);
}

/** 字符串去重。 */
function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))];
}

/** 创建校验错误。 */
function createIssue(field: string, code: string, message: string, severity: LocalModelValidationIssueView['severity'] = 'error'): LocalModelValidationIssueView {
  return { field, code, message, severity };
}

/** 校验输出尺寸。 */
function validateImageDimension(field: 'width' | 'height', value: unknown, issues: LocalModelValidationIssueView[]) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 256 || value > 2048 || value % 8 !== 0) {
    issues.push(createIssue(field, `${field}_invalid`, `${field === 'width' ? '宽度' : '高度'}必须是 256 到 2048 之间且可被 8 整除的整数`));
  }
}

/** 校验采样步数。 */
function validateSteps(value: unknown, issues: LocalModelValidationIssueView[]) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 80) {
    issues.push(createIssue('steps', 'steps_invalid', '采样步数必须是 1 到 80 的整数'));
  }
}

/** 添加缺失资产问题。 */
function pushMissingAssetIssues(requiredKeys: readonly string[], assetByKey: Map<string, LocalModelAssetView>, issues: LocalModelValidationIssueView[]) {
  for (const key of requiredKeys) {
    const asset = assetByKey.get(key);
    if (!asset?.exists) {
      issues.push(createIssue('assets', 'asset_missing', `缺少模型资产：${key}`));
    }
  }
}

/** 添加执行器未配置问题。 */
function pushExecutorIssue(
  issues: LocalModelValidationIssueView[],
  executorStatus: LocalModelExecutorRuntimeStatus,
  mode: 'generation' | 'training',
) {
  const configured = mode === 'generation' ? executorStatus.generationExecutorConfigured : executorStatus.trainingExecutorConfigured;
  if (!configured) {
    const detail = executorStatus.issues.length > 0 ? `：${executorStatus.issues.join('；')}` : '';
    issues.push(createIssue('executor', 'executor_unconfigured', `尚未配置可用的真实本地${mode === 'generation' ? '推理' : '训练'}执行器，不能创建任务${detail}`));
  }
}

/** 获取本次请求依赖的资产视图。 */
function getRequiredAssetView(modelKey: string, assetByKey: Map<string, LocalModelAssetView>): LocalModelAssetView {
  return assetByKey.get(modelKey) ?? {
    id: 0,
    versionId: 0,
    modelKey,
    filePath: '',
    fileName: modelKey,
    fileType: modelKey.endsWith('.safetensors') ? 'safetensors' : 'unknown',
    exists: false,
    sizeBytes: null,
    sha256Hash: null,
    lastSeenAt: null,
  };
}

/** 检查训练数据集目录是否存在。 */
async function directoryExists(directoryPath: string) {
  try {
    const datasetStat = await stat(directoryPath);
    return datasetStat.isDirectory();
  } catch {
    return false;
  }
}
