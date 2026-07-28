/** 本文件负责 worker 读取独立本地模型平台的本地私有配置。 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalModelExecutorConfigView, LocalModelPlatformConfigView, LocalModelStorageDirectoryMappingView } from '@aiimage/local-model-platform-shared';

/** 默认目录映射。 */
const DEFAULT_DIRECTORY_MAPPINGS: LocalModelStorageDirectoryMappingView[] = [
  { name: 'diffusion_models', relativeDir: 'models/diffusion_models', usage: 'generation', enabled: true },
  { name: 'loras', relativeDir: 'models/loras', usage: 'generation', enabled: true },
  { name: 'text_encoders', relativeDir: 'models/text_encoders', usage: 'caption', enabled: true },
  { name: 'vae', relativeDir: 'models/vae', usage: 'vae', enabled: true },
];

/** 读取 worker 运行时配置。 */
export async function readWorkerLocalModelConfig(): Promise<LocalModelPlatformConfigView> {
  const rootDir = resolveWorkspaceRoot(process.cwd());
  const configFilePath = path.join(rootDir, 'local', 'private', 'local-model-platform-config.json');
  const fallback = buildDefaultConfig(rootDir, configFilePath);
  if (!existsSync(configFilePath)) return fallback;

  try {
    const parsed = JSON.parse(await readFile(configFilePath, 'utf8')) as Partial<LocalModelPlatformConfigView>;
    return {
      modelRootDir: normalizePath(parsed.modelRootDir, fallback.modelRootDir),
      directoryMappings: Array.isArray(parsed.directoryMappings) ? parsed.directoryMappings : fallback.directoryMappings,
      executor: normalizeExecutor(parsed.executor, fallback.executor),
      source: 'file',
      configFilePath,
    };
  } catch {
    return fallback;
  }
}

/** 构建默认配置。 */
function buildDefaultConfig(rootDir: string, configFilePath: string): LocalModelPlatformConfigView {
  return {
    modelRootDir: path.join(rootDir, 'models'),
    directoryMappings: DEFAULT_DIRECTORY_MAPPINGS,
    executor: {
      enabled: false,
      pythonExecutablePath: '',
      generationScriptPath: '',
      trainingScriptPath: '',
      workingDir: path.join(rootDir, 'apps', 'local-model-platform', 'worker'),
      outputDir: path.join(rootDir, 'local', 'local-model-platform', 'outputs'),
      datasetRootDir: path.join(rootDir, 'local', 'local-model-platform', 'datasets'),
      maxConcurrentJobs: 1,
    },
    source: 'env',
    configFilePath,
  };
}

/** 归一化运行器配置。 */
function normalizeExecutor(input: unknown, fallback: LocalModelExecutorConfigView): LocalModelExecutorConfigView {
  const record = input && typeof input === 'object' ? input as Partial<LocalModelExecutorConfigView> : {};
  return {
    enabled: record.enabled === true,
    pythonExecutablePath: normalizePath(record.pythonExecutablePath, fallback.pythonExecutablePath),
    generationScriptPath: normalizePath(record.generationScriptPath, fallback.generationScriptPath),
    trainingScriptPath: normalizePath(record.trainingScriptPath, fallback.trainingScriptPath),
    workingDir: normalizePath(record.workingDir, fallback.workingDir),
    outputDir: normalizePath(record.outputDir, fallback.outputDir),
    datasetRootDir: normalizePath(record.datasetRootDir, fallback.datasetRootDir),
    maxConcurrentJobs: typeof record.maxConcurrentJobs === 'number' && Number.isInteger(record.maxConcurrentJobs) ? Math.min(8, Math.max(1, record.maxConcurrentJobs)) : fallback.maxConcurrentJobs,
  };
}

/** 归一化路径。 */
function normalizePath(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : fallback;
}

/** 从 worker 目录回溯到 workspace 根目录。 */
function resolveWorkspaceRoot(baseDir: string) {
  let current = path.resolve(baseDir);
  for (let index = 0; index < 8; index++) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml')) && existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(baseDir);
}
