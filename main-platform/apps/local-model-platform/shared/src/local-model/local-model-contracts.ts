/** 本文件定义独立本地模型平台的共享契约，供前端、管理端和服务端共同使用。 */
import type { ApiDataResponse, ApiResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';
import type { LocalModelRegistrySeed } from './local-model-registry.js';

/** 模型用途分类。 */
export type LocalModelUsage = 'generation' | 'training' | 'caption' | 'vae' | 'utility';

/** 模型来源分组。 */
export type LocalModelSource = 'builtin' | 'user_uploaded' | 'external_registry';

/** 模型精度/量化描述。 */
export type LocalModelPrecision = 'bf16' | 'fp16' | 'fp8' | 'nvfp4' | 'int8' | 'int4' | 'unknown';

/** 模型可见范围。 */
export type LocalModelVisibility = 'admin_only' | 'internal' | 'user';

/** 主机健康状态。 */
export type LocalModelHostStatus = 'unconfigured' | 'offline' | 'degraded' | 'healthy';

/** 推理提供方类型。 */
export type LocalModelProviderType = 'comfyui' | 'vllm' | 'sglang' | 'custom';

/** 任务状态。 */
export type LocalModelJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** 模型版本外显信息。 */
export type LocalModelVersionView = {
  /** 版本 ID。 */
  id: number;
  /** 版本号。 */
  version: string;
  /** 是否当前启用。 */
  enabled: boolean;
  /** 模型用途。 */
  usage: LocalModelUsage;
  /** 真实模型文件名或注册键。 */
  modelKey: string;
  /** 版本短标题。 */
  name: string;
  /** 展示标题。 */
  label: string;
  /** 来源。 */
  source: LocalModelSource;
  /** 精度或量化。 */
  precision: LocalModelPrecision;
  /** 默认宽度。 */
  defaultWidth: number;
  /** 默认高度。 */
  defaultHeight: number;
  /** 默认步数。 */
  defaultSteps: number;
  /** 默认 CFG。 */
  defaultCfg: number | null;
  /** 推荐显存。 */
  vramRecommendedGb: number | null;
  /** 预览图。 */
  previewImageUrl?: string | null;
  /** 备注。 */
  notes?: string | null;
};

/** 模型资产视图。 */
export type LocalModelAssetView = {
  /** 资产 ID。 */
  id: number;
  /** 模型版本 ID。 */
  versionId: number;
  /** 模型键。 */
  modelKey: string;
  /** 文件路径。 */
  filePath: string;
  /** 文件名。 */
  fileName: string;
  /** 文件类型。 */
  fileType: string;
  /** 文件是否真实存在。 */
  exists: boolean;
  /** 文件大小。 */
  sizeBytes: string | null;
  /** 哈希。 */
  sha256Hash: string | null;
  /** 最近发现时间。 */
  lastSeenAt: string | null;
};

/** 本地模型平台就绪摘要。 */
export type LocalModelPlatformReadinessView = {
  /** 首批登记资产总数。 */
  totalAssets: number;
  /** 已发现资产数。 */
  existingAssets: number;
  /** 缺失资产数。 */
  missingAssets: number;
  /** 生成模型资产是否至少有一个可用。 */
  generationAssetsReady: boolean;
  /** 识图/文本编码资产是否可用。 */
  captionAssetsReady: boolean;
  /** VAE 资产是否可用。 */
  vaeReady: boolean;
  /** LoRA 训练所需基础资产是否可用。 */
  trainingAssetsReady: boolean;
  /** 是否已配置真实执行器。 */
  executorConfigured: boolean;
  /** 生成运行器是否已配置且脚本可读取。 */
  generationExecutorConfigured: boolean;
  /** 训练运行器是否已配置且脚本可读取。 */
  trainingExecutorConfigured: boolean;
  /** 输出目录是否可用。 */
  outputDirectoryReady: boolean;
  /** 生成链路是否可真实执行。 */
  generationReady: boolean;
  /** 训练链路是否可真实执行。 */
  trainingReady: boolean;
  /** 缺失模型键列表。 */
  missingModelKeys: string[];
  /** 缺失生成模型键列表。 */
  missingGenerationModelKeys: string[];
  /** 缺失 LoRA 键列表。 */
  missingLoraKeys: string[];
};

/** 本地模型运行校验问题级别。 */
export type LocalModelValidationSeverity = 'error' | 'warning';

/** 本地模型运行校验问题。 */
export type LocalModelValidationIssueView = {
  /** 问题字段。 */
  field: string;
  /** 稳定问题编码。 */
  code: string;
  /** 中文问题说明。 */
  message: string;
  /** 问题级别。 */
  severity: LocalModelValidationSeverity;
};

/** 本地生成提交前校验请求。 */
export type LocalModelGenerationValidateRequest = {
  /** 目标生成模型键，不传则使用首个登记生成模型。 */
  modelKey?: string;
  /** 可选 LoRA 模型键列表。 */
  loraKeys?: string[];
  /** 输入提示词。 */
  prompt?: string;
  /** 输出宽度。 */
  width?: number;
  /** 输出高度。 */
  height?: number;
  /** 采样步数。 */
  steps?: number;
};

/** LoRA 训练提交前校验请求。 */
export type LocalModelTrainingValidateRequest = {
  /** 基础生成模型键，不传则使用首个登记生成模型。 */
  baseModelKey?: string;
  /** 训练数据集本地路径。 */
  datasetPath?: string;
  /** 输出 LoRA 名称。 */
  outputName?: string;
  /** LoRA rank。 */
  rank?: number;
  /** 最大训练步数。 */
  maxSteps?: number;
};

/** 本地模型运行校验响应。 */
export type LocalModelRunValidationResponse = {
  /** 当前请求是否允许创建真实任务。 */
  accepted: boolean;
  /** 当前平台就绪摘要。 */
  readiness: LocalModelPlatformReadinessView;
  /** 本次校验问题。 */
  issues: LocalModelValidationIssueView[];
  /** 本次请求需要的资产。 */
  requiredAssets: LocalModelAssetView[];
};

/** 资产目录状态。 */
export type LocalModelStorageDirectoryView = {
  /** 目录名。 */
  name: string;
  /** 目录是否存在。 */
  exists: boolean;
  /** 目录下直接文件数。 */
  fileCount: number;
};

/** 本地模型存储概览。 */
export type LocalModelStorageView = {
  /** 扫描根目录。 */
  rootDir: string;
  /** 目录映射配置。 */
  directoryMappings: LocalModelStorageDirectoryMappingView[];
  /** 可见文件名。 */
  visibleFiles: string[];
  /** 目录状态。 */
  directories: LocalModelStorageDirectoryView[];
};

/** 目录映射视图。 */
export type LocalModelStorageDirectoryMappingView = {
  /** 目录名。 */
  name: string;
  /** 相对目录。 */
  relativeDir: string;
  /** 目录用途。 */
  usage: LocalModelUsage;
  /** 是否启用。 */
  enabled: boolean;
};

/** 本地模型运行器配置。 */
export type LocalModelExecutorConfigView = {
  /** 是否启用本地运行器。 */
  enabled: boolean;
  /** Python 可执行文件路径。 */
  pythonExecutablePath: string;
  /** 生成脚本路径。 */
  generationScriptPath: string;
  /** LoRA 训练脚本路径。 */
  trainingScriptPath: string;
  /** 运行工作目录。 */
  workingDir: string;
  /** 输出目录。 */
  outputDir: string;
  /** 数据集根目录。 */
  datasetRootDir: string;
  /** 最大并发任务数。 */
  maxConcurrentJobs: number;
};

/** 本地模型平台配置。 */
export type LocalModelPlatformConfigView = {
  /** 扫描根目录。 */
  modelRootDir: string;
  /** 目录映射配置。 */
  directoryMappings: LocalModelStorageDirectoryMappingView[];
  /** 本地运行器配置。 */
  executor: LocalModelExecutorConfigView;
  /** 配置来源。 */
  source: 'env' | 'file';
  /** 配置文件路径。 */
  configFilePath: string;
};

/** 本地模型平台配置更新请求。 */
export type UpdateLocalModelPlatformConfigRequest = {
  /** 扫描根目录。 */
  modelRootDir?: string;
  /** 目录映射配置。 */
  directoryMappings?: LocalModelStorageDirectoryMappingView[];
  /** 本地运行器配置。 */
  executor?: LocalModelExecutorConfigView;
};

/** 本地模型平台配置响应。 */
export type LocalModelPlatformConfigResponse = {
  /** 当前配置。 */
  config: LocalModelPlatformConfigView;
};

/** 主机视图。 */
export type LocalModelHostView = {
  /** 主机 ID。 */
  id: number;
  /** 主机标识。 */
  hostKey: string;
  /** 主机名称。 */
  name: string;
  /** 服务地址。 */
  serviceUrl: string;
  /** 健康状态。 */
  status: LocalModelHostStatus;
  /** 是否启用。 */
  enabled: boolean;
  /** 是否接收新任务。 */
  acceptsNewTasks: boolean;
  /** 最大并发。 */
  maxConcurrency: number;
  /** 队列权重。 */
  queueWeight: number;
  /** 最近健康检查时间。 */
  lastHealthAt: string | null;
  /** 最近错误。 */
  lastError: string | null;
  /** 主机附加信息。 */
  metadata: Record<string, unknown>;
};

/** Provider 视图。 */
export type LocalModelProviderView = {
  /** Provider ID。 */
  id: number;
  /** Provider 标识。 */
  providerKey: string;
  /** Provider 类型。 */
  type: LocalModelProviderType;
  /** Provider 名称。 */
  label: string;
  /** 基础地址。 */
  baseUrl: string | null;
  /** 是否启用。 */
  enabled: boolean;
  /** 是否接收新任务。 */
  acceptsNewTasks: boolean;
  /** 最大并发。 */
  maxConcurrency: number;
  /** 请求超时。 */
  requestTimeoutSec: number;
  /** WebSocket 超时。 */
  websocketTimeoutSec: number;
  /** 上传策略。 */
  uploadPolicy: string;
  /** 输出策略。 */
  outputPolicy: string;
  /** 关联主机。 */
  hostId: number;
};

/** 模型注册视图。 */
export type LocalModelRegistryView = {
  /** 模型 ID。 */
  id: number;
  /** Provider ID。 */
  providerId: number;
  /** 模型键。 */
  modelKey: string;
  /** 展示名。 */
  displayName: string;
  /** 模型用途。 */
  usage: LocalModelUsage;
  /** 来源。 */
  source: LocalModelSource;
  /** 精度。 */
  precision: LocalModelPrecision;
  /** 是否启用。 */
  enabled: boolean;
  /** 可见范围。 */
  visibility: LocalModelVisibility;
  /** 默认宽高。 */
  defaultWidth: number;
  /** 默认步数。 */
  defaultSteps: number;
  /** 默认 CFG。 */
  defaultCfg: number | null;
  /** 最大步数。 */
  maxSteps: number;
  /** 最大批量。 */
  maxBatchSize: number;
  /** 推荐显存。 */
  vramRecommendedGb: number | null;
  /** 支持能力。 */
  capabilities: string[];
  /** 备注。 */
  notes?: string | null;
};

/** 训练作业视图。 */
export type LocalModelTrainingRunView = {
  /** 训练任务 ID。 */
  id: string;
  /** 目标模型版本。 */
  versionId: number;
  /** 基础模型键。 */
  baseModelKey: string;
  /** 当前状态。 */
  status: LocalModelJobStatus;
  /** 数据集 ID。 */
  datasetId: string;
  /** 输出 LoRA 名称。 */
  outputName: string;
  /** LoRA rank。 */
  rank: number;
  /** 训练阶段。 */
  stage: string;
  /** 已完成步数。 */
  completedSteps: number;
  /** 总步数。 */
  totalSteps: number;
  /** 最近日志。 */
  latestMessage: string | null;
  /** 开始时间。 */
  startedAt: string | null;
  /** 完成时间。 */
  finishedAt: string | null;
  /** 创建时间。 */
  createdAt: string;
  /** 更新时间。 */
  updatedAt: string;
  /** 错误信息。 */
  errorMessage: string | null;
  /** 输入 JSON 路径。 */
  inputJsonPath: string | null;
  /** 输出清单路径。 */
  outputManifestPath: string | null;
  /** 输出 LoRA 文件路径。 */
  outputModelPath: string | null;
};

/** 生成作业视图。 */
export type LocalModelGenerationRunView = {
  /** 生成任务 ID。 */
  id: string;
  /** 模型版本 ID。 */
  versionId: number;
  /** 生成模型键。 */
  modelKey: string;
  /** LoRA 模型键列表。 */
  loraKeys: string[];
  /** 当前状态。 */
  status: LocalModelJobStatus;
  /** 输入提示词。 */
  prompt: string;
  /** 采样器。 */
  sampler: string;
  /** 步数。 */
  steps: number;
  /** 宽度。 */
  width: number;
  /** 高度。 */
  height: number;
  /** 种子。 */
  seed: string;
  /** 开始时间。 */
  startedAt: string | null;
  /** 完成时间。 */
  finishedAt: string | null;
  /** 创建时间。 */
  createdAt: string;
  /** 更新时间。 */
  updatedAt: string;
  /** 错误信息。 */
  errorMessage: string | null;
  /** 输入 JSON 路径。 */
  inputJsonPath: string | null;
  /** 输出清单路径。 */
  outputManifestPath: string | null;
  /** 输出图片文件路径。 */
  outputImagePaths: string[];
};

/** 本地生成任务创建请求。 */
export type LocalModelGenerationCreateRequest = LocalModelGenerationValidateRequest & {
  /** 采样器名称。 */
  sampler?: string;
  /** 随机种子。 */
  seed?: string;
};

/** 本地 LoRA 训练任务创建请求。 */
export type LocalModelTrainingCreateRequest = LocalModelTrainingValidateRequest;

/** 本地生成任务列表响应。 */
export type LocalModelGenerationRunListResponse = {
  /** 生成任务列表。 */
  runs: LocalModelGenerationRunView[];
};

/** 本地 LoRA 训练任务列表响应。 */
export type LocalModelTrainingRunListResponse = {
  /** 训练任务列表。 */
  runs: LocalModelTrainingRunView[];
};

/** 本地生成任务创建响应。 */
export type LocalModelGenerationRunCreateResponse = {
  /** 已入队生成任务。 */
  run: LocalModelGenerationRunView;
};

/** 本地 LoRA 训练任务创建响应。 */
export type LocalModelTrainingRunCreateResponse = {
  /** 已入队训练任务。 */
  run: LocalModelTrainingRunView;
};

/** 平台概览响应。 */
export type LocalModelPlatformOverviewResponse = {
  /** 平台配置。 */
  config: LocalModelPlatformConfigView;
  /** 主机列表。 */
  hosts: LocalModelHostView[];
  /** Provider 列表。 */
  providers: LocalModelProviderView[];
  /** 模型列表。 */
  models: LocalModelRegistryView[];
  /** 版本列表。 */
  versions: LocalModelVersionView[];
  /** 训练任务。 */
  trainingRuns: LocalModelTrainingRunView[];
  /** 生成任务。 */
  generationRuns: LocalModelGenerationRunView[];
  /** 资产列表。 */
  assets: LocalModelAssetView[];
  /** 平台就绪摘要。 */
  readiness: LocalModelPlatformReadinessView;
  /** 资产存储概览。 */
  storage: LocalModelStorageView;
};

/** 说明当前系统设计状态的响应。 */
export type LocalModelPlatformStatusResponse = {
  /** 是否已进入可执行阶段。 */
  ready: boolean;
  /** 当前阶段。 */
  phase: 'design' | 'scaffold' | 'integration' | 'runtime';
  /** 入口说明。 */
  message: string;
};

/** 本地模型平台启动时的注册清单。 */
export type LocalModelPlatformRegistryResponse = {
  /** 第一批可用模型。 */
  models: LocalModelRegistrySeed[];
};

/** 平台概览端点。 */
export type GetLocalModelPlatformOverviewEndpoint = ApiEndpointContract<
  undefined,
  ApiDataResponse<LocalModelPlatformOverviewResponse>
>;

/** 平台注册清单端点。 */
export type GetLocalModelPlatformRegistryEndpoint = ApiEndpointContract<
  undefined,
  ApiDataResponse<LocalModelPlatformRegistryResponse>
>;

/** 平台配置查询端点。 */
export type GetLocalModelPlatformConfigEndpoint = ApiEndpointContract<
  undefined,
  ApiDataResponse<LocalModelPlatformConfigResponse>
>;

/** 平台配置更新端点。 */
export type UpdateLocalModelPlatformConfigEndpoint = ApiEndpointContract<
  UpdateLocalModelPlatformConfigRequest,
  ApiDataResponse<LocalModelPlatformConfigResponse>
>;

/** 生成提交前校验端点。 */
export type ValidateLocalModelGenerationRunEndpoint = ApiEndpointContract<
  LocalModelGenerationValidateRequest,
  ApiResponse<LocalModelRunValidationResponse>
>;

/** LoRA 训练提交前校验端点。 */
export type ValidateLocalModelTrainingRunEndpoint = ApiEndpointContract<
  LocalModelTrainingValidateRequest,
  ApiResponse<LocalModelRunValidationResponse>
>;

/** 生成任务列表端点。 */
export type ListLocalModelGenerationRunsEndpoint = ApiEndpointContract<
  undefined,
  ApiDataResponse<LocalModelGenerationRunListResponse>
>;

/** 生成任务创建端点。 */
export type CreateLocalModelGenerationRunEndpoint = ApiEndpointContract<
  LocalModelGenerationCreateRequest,
  ApiResponse<LocalModelGenerationRunCreateResponse>
>;

/** LoRA 训练任务列表端点。 */
export type ListLocalModelTrainingRunsEndpoint = ApiEndpointContract<
  undefined,
  ApiDataResponse<LocalModelTrainingRunListResponse>
>;

/** LoRA 训练任务创建端点。 */
export type CreateLocalModelTrainingRunEndpoint = ApiEndpointContract<
  LocalModelTrainingCreateRequest,
  ApiResponse<LocalModelTrainingRunCreateResponse>
>;
