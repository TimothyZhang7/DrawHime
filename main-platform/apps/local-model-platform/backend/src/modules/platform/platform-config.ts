/** 本文件负责独立本地模型平台配置文件的读写与默认值。 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  LocalModelExecutorConfigView,
  LocalModelPlatformConfigView,
  LocalModelStorageDirectoryMappingView,
  UpdateLocalModelPlatformConfigRequest,
} from '@aiimage/local-model-platform-shared';

/** 目录映射的默认配置。 */
const DEFAULT_DIRECTORY_MAPPINGS: readonly LocalModelStorageDirectoryMappingView[] = [
  { name: 'diffusion_models', relativeDir: 'models/diffusion_models', usage: 'generation', enabled: true },
  { name: 'loras', relativeDir: 'models/loras', usage: 'generation', enabled: true },
  { name: 'text_encoders', relativeDir: 'models/text_encoders', usage: 'caption', enabled: true },
  { name: 'vae', relativeDir: 'models/vae', usage: 'vae', enabled: true },
];

/** 配置文件目录。 */
const CONFIG_DIR = path.resolve(process.cwd(), '..', '..', '..', 'local', 'private');
/** 配置文件路径。 */
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'local-model-platform-config.json');
/** 默认模型根目录。 */
const DEFAULT_MODEL_ROOT_DIR = path.resolve(process.env.LOCAL_MODEL_PLATFORM_MODEL_ROOT ?? path.join(process.cwd(), '..', '..', '..', 'models'));
/** 默认本地运行器工作根目录。 */
const DEFAULT_EXECUTOR_ROOT_DIR = path.resolve(process.cwd(), '..', 'worker');
/** 默认输出目录。 */
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), '..', '..', '..', 'local', 'local-model-platform', 'outputs');
/** 默认数据集目录。 */
const DEFAULT_DATASET_ROOT_DIR = path.resolve(process.cwd(), '..', '..', '..', 'local', 'local-model-platform', 'datasets');

/** 默认运行器配置。 */
const DEFAULT_EXECUTOR_CONFIG: LocalModelExecutorConfigView = {
  enabled: false,
  pythonExecutablePath: process.env.LOCAL_MODEL_PLATFORM_PYTHON ?? '',
  generationScriptPath: process.env.LOCAL_MODEL_PLATFORM_GENERATION_SCRIPT ?? '',
  trainingScriptPath: process.env.LOCAL_MODEL_PLATFORM_TRAINING_SCRIPT ?? '',
  workingDir: process.env.LOCAL_MODEL_PLATFORM_EXECUTOR_WORKDIR ?? DEFAULT_EXECUTOR_ROOT_DIR,
  outputDir: process.env.LOCAL_MODEL_PLATFORM_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR,
  datasetRootDir: process.env.LOCAL_MODEL_PLATFORM_DATASET_ROOT ?? DEFAULT_DATASET_ROOT_DIR,
  maxConcurrentJobs: 1,
};

/** 本地模型平台配置的磁盘结构。 */
type LocalModelPlatformConfigFile = {
  /** 扫描根目录。 */
  modelRootDir?: string;
  /** 目录映射。 */
  directoryMappings?: readonly LocalModelStorageDirectoryMappingView[];
  /** 本地运行器配置。 */
  executor?: Partial<LocalModelExecutorConfigView>;
};

/** 读取当前配置，必要时回落到环境变量和默认值。 */
export async function readLocalModelPlatformConfig(): Promise<LocalModelPlatformConfigView> {
  const fallback = buildDefaultConfig();
  if (!existsSync(CONFIG_FILE_PATH)) {
    return fallback;
  }

  try {
    const raw = await readFile(CONFIG_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as LocalModelPlatformConfigFile;
    return normalizeConfig(parsed, 'file', CONFIG_FILE_PATH);
  } catch {
    return fallback;
  }
}

/** 保存配置到本地私有目录。 */
export async function writeLocalModelPlatformConfig(
  input: UpdateLocalModelPlatformConfigRequest,
): Promise<LocalModelPlatformConfigView> {
  const current = await readLocalModelPlatformConfig();
  const next = normalizeConfig(
    {
      modelRootDir: input.modelRootDir ?? current.modelRootDir,
      directoryMappings: input.directoryMappings ?? current.directoryMappings,
      executor: input.executor ?? current.executor,
    },
    'file',
    CONFIG_FILE_PATH,
  );

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE_PATH, `${JSON.stringify({
    modelRootDir: next.modelRootDir,
    directoryMappings: next.directoryMappings,
    executor: next.executor,
  }, null, 2)}\n`, 'utf8');

  return next;
}

/** 构建默认配置。 */
export function buildDefaultConfig(): LocalModelPlatformConfigView {
  return normalizeConfig(
    {
      modelRootDir: DEFAULT_MODEL_ROOT_DIR,
      directoryMappings: DEFAULT_DIRECTORY_MAPPINGS,
      executor: DEFAULT_EXECUTOR_CONFIG,
    },
    'env',
    CONFIG_FILE_PATH,
  );
}

/** 获取配置文件路径。 */
export function getLocalModelPlatformConfigFilePath() {
  return CONFIG_FILE_PATH;
}

/** 归一化配置。 */
function normalizeConfig(
  input: LocalModelPlatformConfigFile,
  source: LocalModelPlatformConfigView['source'],
  configFilePath: string,
): LocalModelPlatformConfigView {
  const modelRootDir = path.resolve(String(input.modelRootDir ?? DEFAULT_MODEL_ROOT_DIR));
  const directoryMappings = normalizeDirectoryMappings(input.directoryMappings);
  const executor = normalizeExecutorConfig(input.executor);
  return {
    modelRootDir,
    directoryMappings,
    executor,
    source,
    configFilePath,
  };
}

/** 归一化单个目录映射输入。 */
export function normalizeLocalModelDirectoryMappingInput(
  input: unknown,
  fallback: LocalModelStorageDirectoryMappingView | undefined = undefined,
): LocalModelStorageDirectoryMappingView {
  const safeFallback = fallback ?? DEFAULT_DIRECTORY_MAPPINGS[0];
  if (!input || typeof input !== 'object') {
    return { ...safeFallback };
  }
  const record = input as Record<string, unknown>;
  const name = normalizeKey(record.name) || safeFallback.name;
  const relativeDir = normalizeRelativeDir(record.relativeDir, name);
  const usage = normalizeUsage(record.usage);
  const enabled = record.enabled !== false;
  return { name, relativeDir, usage, enabled };
}

/** 归一化目录映射。 */
function normalizeDirectoryMappings(input: readonly LocalModelStorageDirectoryMappingView[] | undefined) {
  const source = Array.isArray(input) && input.length > 0 ? input : [...DEFAULT_DIRECTORY_MAPPINGS];
  const result: LocalModelStorageDirectoryMappingView[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    const normalized = normalizeLocalModelDirectoryMappingInput(item);
    if (seen.has(normalized.name)) {
      continue;
    }
    seen.add(normalized.name);
    result.push(normalized);
  }

  return result.length > 0 ? result : DEFAULT_DIRECTORY_MAPPINGS.map((item) => ({ ...item }));
}

/** 规范化目录键。 */
function normalizeKey(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/[^a-zA-Z0-9._-]/g, '') : '';
}

/** 规范化相对目录。 */
function normalizeRelativeDir(value: unknown, fallbackName: string) {
  if (typeof value !== 'string') return `models/${fallbackName}`;
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '');
  return normalized || `models/${fallbackName}`;
}

/** 规范化用途。 */
function normalizeUsage(value: unknown): LocalModelStorageDirectoryMappingView['usage'] {
  if (value === 'caption' || value === 'vae') return value;
  return 'generation';
}

/** 归一化本地运行器配置。 */
function normalizeExecutorConfig(input: Partial<LocalModelExecutorConfigView> | undefined): LocalModelExecutorConfigView {
  const source = input ?? {};
  return {
    enabled: source.enabled === true,
    pythonExecutablePath: normalizeAbsolutePath(source.pythonExecutablePath, DEFAULT_EXECUTOR_CONFIG.pythonExecutablePath),
    generationScriptPath: normalizeAbsolutePath(source.generationScriptPath, DEFAULT_EXECUTOR_CONFIG.generationScriptPath),
    trainingScriptPath: normalizeAbsolutePath(source.trainingScriptPath, DEFAULT_EXECUTOR_CONFIG.trainingScriptPath),
    workingDir: normalizeAbsolutePath(source.workingDir, DEFAULT_EXECUTOR_CONFIG.workingDir),
    outputDir: normalizeAbsolutePath(source.outputDir, DEFAULT_EXECUTOR_CONFIG.outputDir),
    datasetRootDir: normalizeAbsolutePath(source.datasetRootDir, DEFAULT_EXECUTOR_CONFIG.datasetRootDir),
    maxConcurrentJobs: normalizeConcurrency(source.maxConcurrentJobs),
  };
}

/** 归一化本地绝对路径配置。 */
function normalizeAbsolutePath(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : fallback;
}

/** 归一化运行器并发。 */
function normalizeConcurrency(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_EXECUTOR_CONFIG.maxConcurrentJobs;
  return Math.min(8, Math.max(1, value));
}
