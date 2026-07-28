/** 本文件负责探测独立本地模型平台的本地运行器配置状态。 */
import { access, stat } from 'node:fs/promises';
import type { LocalModelPlatformConfigView } from '@aiimage/local-model-platform-shared';

/** 本地运行器运行时状态。 */
export type LocalModelExecutorRuntimeStatus = {
  /** 是否启用运行器配置。 */
  enabled: boolean;
  /** Python 可执行文件是否可读取。 */
  pythonReady: boolean;
  /** 工作目录是否存在。 */
  workingDirectoryReady: boolean;
  /** 输出目录是否存在。 */
  outputDirectoryReady: boolean;
  /** 数据集根目录是否存在。 */
  datasetRootReady: boolean;
  /** 生成脚本是否可读取。 */
  generationScriptReady: boolean;
  /** 训练脚本是否可读取。 */
  trainingScriptReady: boolean;
  /** 生成运行器是否可用于创建真实任务。 */
  generationExecutorConfigured: boolean;
  /** 训练运行器是否可用于创建真实任务。 */
  trainingExecutorConfigured: boolean;
  /** 任一运行器是否已具备真实执行条件。 */
  executorConfigured: boolean;
  /** 当前运行器配置问题。 */
  issues: string[];
};

/** 探测本地运行器配置，不创建目录、不下载依赖、不启动进程。 */
export async function inspectLocalModelExecutor(config: LocalModelPlatformConfigView): Promise<LocalModelExecutorRuntimeStatus> {
  const executor = config.executor;
  const enabled = executor.enabled;
  const [pythonReady, workingDirectoryReady, outputDirectoryReady, datasetRootReady, generationScriptReady, trainingScriptReady] = await Promise.all([
    fileReadable(executor.pythonExecutablePath),
    directoryReadable(executor.workingDir),
    directoryReadable(executor.outputDir),
    directoryReadable(executor.datasetRootDir),
    fileReadable(executor.generationScriptPath),
    fileReadable(executor.trainingScriptPath),
  ]);
  const generationExecutorConfigured = enabled && pythonReady && workingDirectoryReady && outputDirectoryReady && generationScriptReady;
  const trainingExecutorConfigured = enabled && pythonReady && workingDirectoryReady && outputDirectoryReady && datasetRootReady && trainingScriptReady;
  const issues = buildExecutorIssues({
    enabled,
    pythonReady,
    workingDirectoryReady,
    outputDirectoryReady,
    datasetRootReady,
    generationScriptReady,
    trainingScriptReady,
  });

  return {
    enabled,
    pythonReady,
    workingDirectoryReady,
    outputDirectoryReady,
    datasetRootReady,
    generationScriptReady,
    trainingScriptReady,
    generationExecutorConfigured,
    trainingExecutorConfigured,
    executorConfigured: generationExecutorConfigured || trainingExecutorConfigured,
    issues,
  };
}

/** 检查文件是否可读。 */
async function fileReadable(filePath: string) {
  if (!filePath) return false;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return false;
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 检查目录是否可读。 */
async function directoryReadable(directoryPath: string) {
  if (!directoryPath) return false;
  try {
    const directoryStat = await stat(directoryPath);
    if (!directoryStat.isDirectory()) return false;
    await access(directoryPath);
    return true;
  } catch {
    return false;
  }
}

/** 生成运行器配置问题列表。 */
function buildExecutorIssues(status: {
  enabled: boolean;
  pythonReady: boolean;
  workingDirectoryReady: boolean;
  outputDirectoryReady: boolean;
  datasetRootReady: boolean;
  generationScriptReady: boolean;
  trainingScriptReady: boolean;
}) {
  const issues: string[] = [];
  if (!status.enabled) issues.push('本地运行器未启用');
  if (!status.pythonReady) issues.push('Python 可执行文件不可读');
  if (!status.workingDirectoryReady) issues.push('运行工作目录不可读');
  if (!status.outputDirectoryReady) issues.push('输出目录不可读');
  if (!status.datasetRootReady) issues.push('数据集根目录不可读');
  if (!status.generationScriptReady) issues.push('生成脚本不可读');
  if (!status.trainingScriptReady) issues.push('训练脚本不可读');
  return issues;
}
