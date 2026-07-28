/** 本文件提供本地模型平台 backend 的基础路由。 */
import { sendJson, type Route } from '@aiimage/core-utils';
import { readdir } from 'node:fs/promises';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import {
  LOCAL_MODEL_REGISTRY_SEED,
  type LocalModelAssetView,
  type LocalModelGenerationCreateRequest,
  type LocalModelGenerationValidateRequest,
  type LocalModelTrainingCreateRequest,
  type LocalModelTrainingValidateRequest,
  type UpdateLocalModelPlatformConfigRequest,
} from '@aiimage/local-model-platform-shared';
import {
  buildDefaultConfig,
  normalizeLocalModelDirectoryMappingInput,
  readLocalModelPlatformConfig,
  writeLocalModelPlatformConfig,
} from './platform-config.js';
import { getLocalModelDirectoryCandidates, listVisibleFileNames, scanLocalModelAssetFiles } from './platform-files.js';
import {
  buildLocalModelReadiness,
  validateLocalModelGenerationRequest,
  validateLocalModelTrainingRequest,
} from './platform-readiness.js';
import { inspectLocalModelExecutor, type LocalModelExecutorRuntimeStatus } from './platform-executor.js';
import {
  createLocalModelGenerationRun,
  createLocalModelTrainingRun,
  readLocalModelRunStore,
} from './platform-run-store.js';

/** JSON 请求体超过路由声明上限时抛出。 */
class JsonBodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super('请求体过大');
    this.name = 'JsonBodyTooLargeError';
  }
}

/** 创建本地模型平台基础路由。 */
export function createLocalModelPlatformRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/local-model-platform/status',
      handle: async (_req, res) => {
        sendJson(res, 200, {
          ok: true,
          data: {
            ready: true,
            phase: 'scaffold',
            message: '独立本地模型平台 backend 骨架已就绪，后续接入真实模型注册、训练和推理执行器。',
          },
        });
      },
    },
    {
      method: 'GET',
      path: '/api/local-model-platform/overview',
      handle: async (_req, res) => {
        const config = await readLocalModelPlatformConfig();
        const runStore = await readLocalModelRunStore();
        const rootDir = config.modelRootDir;
        const enabledMappings = config.directoryMappings.filter((item) => item.enabled);
        const executorStatus = await inspectLocalModelExecutor(config);
        const assets = await scanLocalModelAssetFiles(
          rootDir,
          enabledMappings.map((item) => item.relativeDir),
          LOCAL_MODEL_REGISTRY_SEED.map((item) => item.modelKey),
        );
        const assetViews: LocalModelAssetView[] = assets.map((item, index) => ({
          id: index + 1,
          versionId: index + 1,
          modelKey: item.modelKey,
          filePath: item.absolutePath,
          fileName: item.fileName,
          fileType: item.fileName.endsWith('.safetensors') ? 'safetensors' : 'unknown',
          exists: item.exists,
          sizeBytes: item.sizeBytes,
          sha256Hash: null,
          lastSeenAt: item.lastModifiedAt,
        }));
        const readiness = buildLocalModelReadiness(assetViews, executorStatus);
        const visibleFiles = await listVisibleFileNames(rootDir).catch(() => []);
        const directoryState = await Promise.all(
          enabledMappings.map(async (item: (typeof enabledMappings)[number]) => {
            for (const directoryPath of getLocalModelDirectoryCandidates(rootDir, item.relativeDir)) {
              try {
                const entries = await readdir(directoryPath, { withFileTypes: true });
                return {
                  name: item.name,
                  exists: true,
                  fileCount: entries.filter((entry) => entry.isFile()).length,
                };
              } catch {
                // 先尝试当前目录映射，再尝试兼容路径；两个目录都不存在时才认为目录缺失。
              }
            }
            return {
              name: item.name,
              exists: false,
              fileCount: 0,
            };
          }),
        );
        sendJson(res, 200, {
          ok: true,
          data: {
            config,
            hosts: [
              {
                id: 1,
                hostKey: 'local-default',
                name: '本机默认主机',
                serviceUrl: 'http://127.0.0.1:3017',
                status: executorStatus.executorConfigured ? 'healthy' : 'unconfigured',
                enabled: config.executor.enabled,
                acceptsNewTasks: readiness.generationReady || readiness.trainingReady,
                maxConcurrency: 1,
                queueWeight: 1,
                lastHealthAt: null,
                lastError: null,
                metadata: { executorIssues: executorStatus.issues },
              },
            ],
            providers: [
              {
                id: 1,
                providerKey: 'local-comfyui',
                type: 'comfyui',
                label: '本地 ComfyUI',
                baseUrl: null,
                enabled: config.executor.enabled,
                acceptsNewTasks: readiness.generationReady,
                maxConcurrency: 1,
                requestTimeoutSec: 180,
                websocketTimeoutSec: 180,
                uploadPolicy: 'local_only',
                outputPolicy: 'local_first',
                hostId: 1,
              },
            ],
            models: LOCAL_MODEL_REGISTRY_SEED.map((item, index) => ({
              id: index + 1,
              providerId: 1,
              modelKey: item.modelKey,
              displayName: item.displayName,
              usage: item.usage,
              source: item.source,
              precision: item.precision,
              enabled: true,
              visibility: 'internal',
              defaultWidth: item.defaultWidth,
              defaultSteps: item.defaultSteps,
              defaultCfg: item.defaultCfg,
              maxSteps: Math.max(item.defaultSteps, 40),
              maxBatchSize: item.usage === 'generation' ? 4 : 1,
              vramRecommendedGb: item.vramRecommendedGb,
              capabilities: item.tags,
              notes: item.notes,
            })),
            versions: LOCAL_MODEL_REGISTRY_SEED.map((item, index) => ({
              id: index + 1,
              version: '1.0.0',
              enabled: true,
              usage: item.usage,
              modelKey: item.modelKey,
              name: item.displayName,
              label: item.displayName,
              source: item.source,
              precision: item.precision,
              defaultWidth: item.defaultWidth,
              defaultHeight: item.defaultHeight,
              defaultSteps: item.defaultSteps,
              defaultCfg: item.defaultCfg,
              vramRecommendedGb: item.vramRecommendedGb,
              previewImageUrl: null,
              notes: item.notes,
            })),
            trainingRuns: runStore.trainingRuns,
            generationRuns: runStore.generationRuns,
            assets: assetViews,
            readiness,
            storage: {
              rootDir,
              directoryMappings: config.directoryMappings,
              visibleFiles,
              directories: directoryState,
            },
          },
        });
      },
    },
    {
      method: 'GET',
      path: '/api/local-model-platform/registry',
      handle: async (_req, res) => {
        sendJson(res, 200, {
          ok: true,
          data: {
            models: LOCAL_MODEL_REGISTRY_SEED,
          },
        });
      },
    },
    {
      method: 'GET',
      path: '/api/local-model-platform/config',
      handle: async (_req, res) => {
        const config = await readLocalModelPlatformConfig();
        sendJson(res, 200, {
          ok: true,
          data: {
            config,
          },
        });
      },
    },
    {
      method: 'PUT',
      path: '/api/local-model-platform/config',
      handle: async (req, res) => {
        try {
          const body = await readJsonBody<{ modelRootDir?: string; directoryMappings?: unknown; executor?: unknown }>(req);
          const defaultConfig = buildDefaultConfig();
          const nextConfig = await writeLocalModelPlatformConfig({
            modelRootDir: typeof body.modelRootDir === 'string' ? body.modelRootDir : undefined,
            directoryMappings: Array.isArray(body.directoryMappings)
              ? body.directoryMappings.map((item, index) => normalizeLocalModelDirectoryMappingInput(item, defaultConfig.directoryMappings[index]))
              : undefined,
            executor: body.executor && typeof body.executor === 'object' ? (body.executor as UpdateLocalModelPlatformConfigRequest['executor']) : undefined,
          });
          sendJson(res, 200, {
            ok: true,
            data: {
              config: nextConfig,
            },
          });
        } catch (error) {
          if (error instanceof JsonBodyTooLargeError) {
            sendJson(res, 413, {
              ok: false,
              code: ApiErrorCode.BadRequest,
              message: `请求体过大，超过 ${error.limitBytes} 字节`,
            });
            return;
          }
          throw error;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/local-model-platform/generation-runs/validate',
      handle: async (req, res) => {
        try {
          const body = await readJsonBody<LocalModelGenerationValidateRequest>(req);
          const snapshot = await loadCurrentPlatformSnapshot();
          const result = validateLocalModelGenerationRequest(body, snapshot.assets, snapshot.executorStatus);
          sendValidationResult(res, result);
        } catch (error) {
          if (error instanceof JsonBodyTooLargeError) {
            sendJson(res, 413, {
              ok: false,
              code: ApiErrorCode.BadRequest,
              message: `请求体过大，超过 ${error.limitBytes} 字节`,
            });
            return;
          }
          throw error;
        }
      },
    },
    {
      method: 'GET',
      path: '/api/local-model-platform/generation-runs',
      handle: async (_req, res) => {
        const store = await readLocalModelRunStore();
        sendJson(res, 200, {
          ok: true,
          data: {
            runs: store.generationRuns,
          },
        });
      },
    },
    {
      method: 'POST',
      path: '/api/local-model-platform/generation-runs',
      handle: async (req, res) => {
        try {
          const body = await readJsonBody<LocalModelGenerationCreateRequest>(req);
          const snapshot = await loadCurrentPlatformSnapshot();
          const validation = validateLocalModelGenerationRequest(body, snapshot.assets, snapshot.executorStatus);
          if (!validation.accepted) {
            sendValidationResult(res, validation);
            return;
          }
          const run = await createLocalModelGenerationRun(body);
          sendJson(res, 201, {
            ok: true,
            data: { run },
          });
        } catch (error) {
          if (error instanceof JsonBodyTooLargeError) {
            sendJson(res, 413, {
              ok: false,
              code: ApiErrorCode.BadRequest,
              message: `请求体过大，超过 ${error.limitBytes} 字节`,
            });
            return;
          }
          throw error;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/local-model-platform/training-runs/validate',
      handle: async (req, res) => {
        try {
          const body = await readJsonBody<LocalModelTrainingValidateRequest>(req);
          const snapshot = await loadCurrentPlatformSnapshot();
          const result = await validateLocalModelTrainingRequest(body, snapshot.assets, snapshot.executorStatus);
          sendValidationResult(res, result);
        } catch (error) {
          if (error instanceof JsonBodyTooLargeError) {
            sendJson(res, 413, {
              ok: false,
              code: ApiErrorCode.BadRequest,
              message: `请求体过大，超过 ${error.limitBytes} 字节`,
            });
            return;
          }
          throw error;
        }
      },
    },
    {
      method: 'GET',
      path: '/api/local-model-platform/training-runs',
      handle: async (_req, res) => {
        const store = await readLocalModelRunStore();
        sendJson(res, 200, {
          ok: true,
          data: {
            runs: store.trainingRuns,
          },
        });
      },
    },
    {
      method: 'POST',
      path: '/api/local-model-platform/training-runs',
      handle: async (req, res) => {
        try {
          const body = await readJsonBody<LocalModelTrainingCreateRequest>(req);
          const snapshot = await loadCurrentPlatformSnapshot();
          const validation = await validateLocalModelTrainingRequest(body, snapshot.assets, snapshot.executorStatus);
          if (!validation.accepted) {
            sendValidationResult(res, validation);
            return;
          }
          const run = await createLocalModelTrainingRun(body);
          sendJson(res, 201, {
            ok: true,
            data: { run },
          });
        } catch (error) {
          if (error instanceof JsonBodyTooLargeError) {
            sendJson(res, 413, {
              ok: false,
              code: ApiErrorCode.BadRequest,
              message: `请求体过大，超过 ${error.limitBytes} 字节`,
            });
            return;
          }
          throw error;
        }
      },
    },
    {
      method: 'GET',
      path: '/api/local-model-platform/bootstrap',
      handle: async (_req, res) => {
        sendJson(res, 200, {
          ok: true,
          data: {
            message: '独立本地模型平台已接入第一批真实模型注册清单，可继续补前端、管理端与 worker。',
          },
        });
      },
    },
    {
      method: 'GET',
      path: '/api/local-model-platform/not-ready',
      handle: async (_req, res) => {
        sendJson(res, 409, {
          ok: false,
          code: ApiErrorCode.Conflict,
          message: '该接口仅用于标记尚未接入真实训练和推理执行器的写入能力。',
        });
      },
    },
  ];
}

/** 读取当前配置并生成资产视图，供概览和提交前校验复用。 */
async function loadCurrentPlatformSnapshot(): Promise<{ assets: LocalModelAssetView[]; executorStatus: LocalModelExecutorRuntimeStatus }> {
  const config = await readLocalModelPlatformConfig();
  const executorStatus = await inspectLocalModelExecutor(config);
  const enabledMappings = config.directoryMappings.filter((item) => item.enabled);
  const assets = await scanLocalModelAssetFiles(
    config.modelRootDir,
    enabledMappings.map((item) => item.relativeDir),
    LOCAL_MODEL_REGISTRY_SEED.map((item) => item.modelKey),
  );
  const assetViews = assets.map((item, index) => ({
    id: index + 1,
    versionId: index + 1,
    modelKey: item.modelKey,
    filePath: item.absolutePath,
    fileName: item.fileName,
    fileType: item.fileName.endsWith('.safetensors') ? 'safetensors' : 'unknown',
    exists: item.exists,
    sizeBytes: item.sizeBytes,
    sha256Hash: null,
    lastSeenAt: item.lastModifiedAt,
  }));
  return { assets: assetViews, executorStatus };
}

/** 发送提交前校验响应，未通过时明确阻断任务创建。 */
function sendValidationResult(
  res: Parameters<typeof sendJson>[0],
  result: ReturnType<typeof validateLocalModelGenerationRequest>,
) {
  if (result.accepted) {
    sendJson(res, 200, { ok: true, data: result });
    return;
  }

  sendJson(res, 409, {
    ok: false,
    code: ApiErrorCode.Conflict,
    message: `本地模型任务校验未通过：${result.issues.map((item) => item.message).join('；')}`,
  });
}

/** 读取 JSON 请求体。 */
async function readJsonBody<T>(req: NodeJS.ReadableStream, limitBytes = 64 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) throw new JsonBodyTooLargeError(limitBytes);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}
