/** 本文件负责独立本地模型平台生成与训练任务的本地队列持久化。 */
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LOCAL_MODEL_REGISTRY_SEED,
  type LocalModelGenerationCreateRequest,
  type LocalModelGenerationRunView,
  type LocalModelTrainingCreateRequest,
  type LocalModelTrainingRunView,
} from '@aiimage/local-model-platform-shared';
import { isLoraModelKey } from './platform-readiness.js';

/** 本地队列文件目录。 */
const RUN_STORE_DIR = path.resolve(process.cwd(), '..', '..', '..', 'local', 'private');

/** 本地队列文件路径。 */
const RUN_STORE_FILE = path.join(RUN_STORE_DIR, 'local-model-platform-runs.json');

/** 本地队列文件结构。 */
type LocalModelRunStoreFile = {
  /** 生成任务。 */
  generationRuns?: LocalModelGenerationRunView[];
  /** 训练任务。 */
  trainingRuns?: LocalModelTrainingRunView[];
};

/** 读取本地模型平台任务队列。 */
export async function readLocalModelRunStore(): Promise<{
  generationRuns: LocalModelGenerationRunView[];
  trainingRuns: LocalModelTrainingRunView[];
}> {
  if (!existsSync(RUN_STORE_FILE)) {
    return { generationRuns: [], trainingRuns: [] };
  }

  try {
    const raw = await readFile(RUN_STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as LocalModelRunStoreFile;
    return {
      generationRuns: Array.isArray(parsed.generationRuns) ? parsed.generationRuns : [],
      trainingRuns: Array.isArray(parsed.trainingRuns) ? parsed.trainingRuns : [],
    };
  } catch {
    return { generationRuns: [], trainingRuns: [] };
  }
}

/** 创建生成任务并写入本地队列。 */
export async function createLocalModelGenerationRun(input: LocalModelGenerationCreateRequest): Promise<LocalModelGenerationRunView> {
  const store = await readLocalModelRunStore();
  const modelKey = normalizeString(input.modelKey) || getDefaultGenerationModelKey();
  const seed = findSeed(modelKey);
  const now = new Date().toISOString();
  const run: LocalModelGenerationRunView = {
    id: createRunId('gen'),
    versionId: getVersionId(modelKey),
    modelKey,
    loraKeys: normalizeStringList(input.loraKeys),
    status: 'queued',
    prompt: normalizeString(input.prompt),
    sampler: normalizeString(input.sampler) || 'local-script',
    steps: normalizeInteger(input.steps, seed?.defaultSteps ?? 24),
    width: normalizeInteger(input.width, seed?.defaultWidth ?? 1024),
    height: normalizeInteger(input.height, seed?.defaultHeight ?? 1024),
    seed: normalizeString(input.seed) || String(randomInt(1, 2_147_483_647)),
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    errorMessage: null,
    inputJsonPath: null,
    outputManifestPath: null,
    outputImagePaths: [],
  };

  await writeLocalModelRunStore({
    generationRuns: [run, ...store.generationRuns],
    trainingRuns: store.trainingRuns,
  });
  return run;
}

/** 写入本地模型平台任务队列。 */
async function writeLocalModelRunStore(store: Required<LocalModelRunStoreFile>) {
  await mkdir(RUN_STORE_DIR, { recursive: true });
  const temporaryPath = `${RUN_STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, RUN_STORE_FILE);
}

/** 创建 LoRA 训练任务并写入本地队列。 */
export async function createLocalModelTrainingRun(input: LocalModelTrainingCreateRequest): Promise<LocalModelTrainingRunView> {
  const store = await readLocalModelRunStore();
  const baseModelKey = normalizeString(input.baseModelKey) || getDefaultGenerationModelKey();
  const now = new Date().toISOString();
  const totalSteps = normalizeInteger(input.maxSteps, 1000);
  const run: LocalModelTrainingRunView = {
    id: createRunId('train'),
    versionId: getVersionId(baseModelKey),
    baseModelKey,
    status: 'queued',
    datasetId: normalizeString(input.datasetPath),
    outputName: normalizeString(input.outputName),
    rank: normalizeInteger(input.rank, 64),
    stage: 'queued',
    completedSteps: 0,
    totalSteps,
    latestMessage: '任务已写入本地队列，等待 worker 接入真实执行器处理。',
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    errorMessage: null,
    inputJsonPath: null,
    outputManifestPath: null,
    outputModelPath: null,
  };

  await writeLocalModelRunStore({
    generationRuns: store.generationRuns,
    trainingRuns: [run, ...store.trainingRuns],
  });
  return run;
}

/** 创建本地任务 ID。 */
function createRunId(prefix: 'gen' | 'train') {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/** 获取默认基础生成模型键。 */
function getDefaultGenerationModelKey() {
  return LOCAL_MODEL_REGISTRY_SEED.find((item) => item.usage === 'generation' && !isLoraModelKey(item.modelKey))?.modelKey ?? '';
}

/** 查找注册模型。 */
function findSeed(modelKey: string) {
  return LOCAL_MODEL_REGISTRY_SEED.find((item) => item.modelKey === modelKey);
}

/** 根据模型键计算稳定版本 ID。 */
function getVersionId(modelKey: string) {
  const index = LOCAL_MODEL_REGISTRY_SEED.findIndex((item) => item.modelKey === modelKey);
  return index >= 0 ? index + 1 : 0;
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

/** 规范化整数。 */
function normalizeInteger(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}
