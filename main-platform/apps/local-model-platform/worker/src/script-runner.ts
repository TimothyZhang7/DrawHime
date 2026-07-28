/** 本文件负责 worker 调用用户配置的本地 Python 脚本。 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalModelExecutorConfigView, LocalModelGenerationRunView, LocalModelTrainingRunView } from '@aiimage/local-model-platform-shared';

/** 脚本执行结果。 */
export type LocalModelScriptRunResult = {
  /** 进程退出码。 */
  exitCode: number;
  /** 标准输出。 */
  stdout: string;
  /** 标准错误。 */
  stderr: string;
  /** 输入 JSON 路径。 */
  inputPath: string;
  /** 输出清单路径。 */
  manifestPath: string;
};

/** 执行生成脚本。 */
export async function runGenerationScript(executor: LocalModelExecutorConfigView, run: LocalModelGenerationRunView) {
  const manifestPath = getManifestPath(executor, run.id);
  const inputPath = await writeRunInput(executor, run.id, {
    kind: 'generation',
    run,
    outputDir: executor.outputDir,
    manifestPath,
  });
  return runPythonScript(executor, executor.generationScriptPath, inputPath);
}

/** 执行训练脚本。 */
export async function runTrainingScript(executor: LocalModelExecutorConfigView, run: LocalModelTrainingRunView) {
  const manifestPath = getManifestPath(executor, run.id);
  const inputPath = await writeRunInput(executor, run.id, {
    kind: 'training',
    run,
    outputDir: executor.outputDir,
    manifestPath,
  });
  return runPythonScript(executor, executor.trainingScriptPath, inputPath);
}

/** 写入单次任务输入 JSON，供 Python 脚本读取真实参数。 */
async function writeRunInput(executor: LocalModelExecutorConfigView, runId: string, payload: unknown) {
  const inputDir = path.join(executor.outputDir, 'run-inputs');
  const manifestDir = path.join(executor.outputDir, 'manifests');
  await mkdir(inputDir, { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  const inputPath = path.join(inputDir, `${runId}.json`);
  await writeFile(inputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return inputPath;
}

/** 生成输出清单路径。 */
function getManifestPath(executor: LocalModelExecutorConfigView, runId: string) {
  return path.join(executor.outputDir, 'manifests', `${runId}.json`);
}

/** 调用 Python 脚本，脚本收到唯一参数 inputPath。 */
function runPythonScript(executor: LocalModelExecutorConfigView, scriptPath: string, inputPath: string): Promise<LocalModelScriptRunResult> {
  return new Promise((resolve) => {
    const child = spawn(executor.pythonExecutablePath, [scriptPath, inputPath], {
      cwd: executor.workingDir,
      windowsHide: true,
      env: {
        ...process.env,
        LOCAL_MODEL_PLATFORM_INPUT: inputPath,
        LOCAL_MODEL_PLATFORM_OUTPUT_DIR: executor.outputDir,
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      resolve({
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${Buffer.concat(stderrChunks).toString('utf8')}\n${error.message}`.trim(),
        inputPath,
        manifestPath: readManifestPath(inputPath),
      });
    });
    child.on('close', (code) => {
      resolve({
        exitCode: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8').slice(-4000),
        stderr: Buffer.concat(stderrChunks).toString('utf8').slice(-4000),
        inputPath,
        manifestPath: readManifestPath(inputPath),
      });
    });
  });
}

/** 从输入路径推导清单路径，避免异步回调闭包额外传参。 */
function readManifestPath(inputPath: string) {
  return inputPath.replace(`${path.sep}run-inputs${path.sep}`, `${path.sep}manifests${path.sep}`);
}
