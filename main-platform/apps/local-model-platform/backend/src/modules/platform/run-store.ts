/** 本文件负责 worker 读写独立本地模型平台本地队列。 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalModelGenerationRunView, LocalModelJobStatus, LocalModelTrainingRunView } from '@aiimage/local-model-platform-shared';

/** 本地队列文件结构。 */
type LocalModelRunStoreFile = {
  /** 生成任务。 */
  generationRuns?: LocalModelGenerationRunView[];
  /** 训练任务。 */
  trainingRuns?: LocalModelTrainingRunView[];
};

/** 读取本地模型平台任务队列。 */
export async function readLocalModelRunStore() {
  const filePath = getRunStoreFilePath();
  if (!existsSync(filePath)) {
    return { generationRuns: [], trainingRuns: [] };
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as LocalModelRunStoreFile;
    return {
      generationRuns: Array.isArray(parsed.generationRuns) ? parsed.generationRuns : [],
      trainingRuns: Array.isArray(parsed.trainingRuns) ? parsed.trainingRuns : [],
    };
  } catch {
    return { generationRuns: [], trainingRuns: [] };
  }
}

/** 更新生成任务。 */
export async function updateLocalModelGenerationRun(runId: string, patch: Partial<Omit<LocalModelGenerationRunView, 'id' | 'createdAt'>>) {
  const store = await readLocalModelRunStore();
  const generationRuns = store.generationRuns.map((run) => (run.id === runId ? { ...run, ...patch, updatedAt: new Date().toISOString() } : run));
  await writeLocalModelRunStore({ ...store, generationRuns });
}

/** 更新训练任务。 */
export async function updateLocalModelTrainingRun(runId: string, patch: Partial<Omit<LocalModelTrainingRunView, 'id' | 'createdAt'>>) {
  const store = await readLocalModelRunStore();
  const trainingRuns = store.trainingRuns.map((run) => (run.id === runId ? { ...run, ...patch, updatedAt: new Date().toISOString() } : run));
  await writeLocalModelRunStore({ ...store, trainingRuns });
}

/** 创建运行中状态补丁。 */
export function createRunningPatch(status: LocalModelJobStatus = 'running') {
  return {
    status,
    startedAt: new Date().toISOString(),
    errorMessage: null,
  };
}

/** 创建失败状态补丁。 */
export function createFailedPatch(message: string) {
  return {
    status: 'failed' as const,
    finishedAt: new Date().toISOString(),
    errorMessage: message.slice(0, 2000),
  };
}

/** 创建生成成功状态补丁。 */
export function createGenerationSucceededPatch() {
  return {
    status: 'succeeded' as const,
    finishedAt: new Date().toISOString(),
    errorMessage: null,
  };
}

/** 创建训练成功状态补丁。 */
export function createTrainingSucceededPatch(message: string) {
  return {
    status: 'succeeded' as const,
    stage: 'succeeded',
    finishedAt: new Date().toISOString(),
    errorMessage: null,
    latestMessage: message,
  };
}

/** 写入本地模型平台任务队列。 */
async function writeLocalModelRunStore(store: { generationRuns: LocalModelGenerationRunView[]; trainingRuns: LocalModelTrainingRunView[] }) {
  const filePath = getRunStoreFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

/** 获取队列文件路径。 */
function getRunStoreFilePath() {
  return path.join(resolveWorkspaceRoot(process.cwd()), 'local', 'private', 'local-model-platform-runs.json');
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
