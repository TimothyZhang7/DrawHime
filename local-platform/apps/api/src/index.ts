/**
 * 本文件启动本地模型平台 API 控制面，提供身份、模型、任务、计费编排与私有产物读取接口。
 */
import {
  inferenceJobCreateRequestSchema,
  inferenceJobCancelRequestSchema,
  mainIdentityExchangeViewSchema,
  type InferenceJobCreateRequest,
  type InferenceLoraView,
  type GalleryLoraMetadataView,
  type InferenceModelView,
  type LocalPlatformSessionView,
  type MainIdentityExchangeView,
  type PlatformOverviewView,
  type ServiceReadinessView,
} from "@drawhime/contracts";
import { database } from "@drawhime/database";
import {
  createConfigCheck,
  createDatabaseCheck,
  createObjectStorageCheck,
  createRedisCheck,
  getObjectBuffer,
  InferenceQueue,
  readJsonBody,
  sendError,
  sendSuccess,
  startService,
} from "@drawhime/service-runtime";
import { MainPlatformIntegrationError, releaseMainBilling, removeMainGallery, reserveMainBilling } from "@drawhime/main-platform-client";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { registerLoraLibraryRoutes } from "./lora-library.js";
import { registerAdminRuntimeRoutes } from "./admin-runtime.js";
import { registerBotRoutes } from "./bot-routes.js";
import { registerTrainingRoutes } from "./training-routes.js";
import { toInferenceJobView } from "./inference-views.js";

const inferenceQueue = new InferenceQueue();

const serviceEndpoints = [
  ["scheduler", "LOCAL_SCHEDULER_BASE_URL", "http://127.0.0.1:7103"],
  ["gpu-agent", "LOCAL_GPU_AGENT_BASE_URL", "http://127.0.0.1:7110"],
  ["inference-worker", "LOCAL_INFERENCE_WORKER_BASE_URL", "http://127.0.0.1:7111"],
  ["training-worker", "LOCAL_TRAINING_WORKER_BASE_URL", "http://127.0.0.1:7112"],
  ["artifact-service", "LOCAL_ARTIFACT_SERVICE_BASE_URL", "http://127.0.0.1:7113"],
] as const;

/** 获取兄弟服务的真实就绪视图，网络失败也会以明确状态呈现。 */
async function fetchServiceReadiness(
  service: string,
  environmentKey: string,
  fallback: string,
): Promise<ServiceReadinessView> {
  const endpoint = process.env[environmentKey]?.trim() || fallback;
  try {
    const response = await fetch(`${endpoint}/ready`, { signal: AbortSignal.timeout(3500) });
    const payload = (await response.json()) as { ok?: boolean; data?: ServiceReadinessView };
    if (payload.ok === true && payload.data) return payload.data;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    return {
      service,
      ready: false,
      timestamp: new Date().toISOString(),
      dependencies: [{
        name: "service-endpoint",
        ready: false,
        latencyMs: null,
        message: error instanceof Error ? error.message : "服务不可达",
      }],
    };
  }
}

const checks = [
  createDatabaseCheck(),
  createRedisCheck(),
  createObjectStorageCheck(),
  createConfigCheck("main-platform-integration", [
    "MAIN_PLATFORM_BASE_URL",
    "MAIN_PLATFORM_INTERNAL_URL",
    "MAIN_PLATFORM_AUDIENCE",
    "MAIN_PLATFORM_CLIENT_SECRET",
    "TRAINING_RUNTIME_TOKEN",
  ]),
];

startService({
  name: "api",
  port: Number(process.env.LOCAL_API_PORT || 7102),
  checks,
  registerRoutes(router, getReadiness) {
    registerLoraLibraryRoutes(router, findLocalSessionRecord);
    registerAdminRuntimeRoutes(router, findLocalSessionRecord);
    registerBotRoutes(router, { listModels: listInferenceModels, createJob: createInferenceJob, handleError: sendInferenceError });
    registerTrainingRoutes(router, findLocalSessionRecord);
    router.post("/v1/auth/session/exchange", async ({ request, response }) => {
      const mainToken = readBearerToken(request);
      if (!mainToken) {
        sendError(response, 401, "main_session_required", "请先登录绘图姬主站");
        return;
      }
      const identity = await exchangeMainIdentity(mainToken);
      if (!identity) {
        sendError(response, 401, "main_session_invalid", "绘图姬主站登录状态已失效");
        return;
      }
      const session = await createLocalSession(identity);
      sendSuccess(response, session, 201);
    });

    router.get("/v1/auth/me", async ({ request, response }) => {
      const session = await findLocalSession(readBearerToken(request));
      if (!session) {
        sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
        return;
      }
      sendSuccess(response, session);
    });

    router.get("/v1/models", async ({ request, response }) => {
      const session = await findLocalSessionRecord(readBearerToken(request));
      if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
      const models = await listInferenceModels();
      sendSuccess(response, { models });
    });

    router.get("/v1/loras", async ({ request, response, url }) => {
      const session = await findLocalSessionRecord(readBearerToken(request));
      if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
      sendSuccess(response, { loras: await listInferenceLoras(session.externalIdentity.id, url.searchParams.get("family") || undefined) });
    });

    router.post("/v1/inference/jobs", async ({ request, response }) => {
      const session = await findLocalSessionRecord(readBearerToken(request));
      if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
      try {
        const input = inferenceJobCreateRequestSchema.parse(await readJsonBody<unknown>(request));
        const result = await createInferenceJob(session.externalIdentity, input);
        sendSuccess(response, await toInferenceJobView(result.jobId), result.created ? 201 : 200);
      } catch (error) {
        sendInferenceError(response, error);
      }
    });

    router.get("/v1/inference/jobs", async ({ request, response, url }) => {
      const session = await findLocalSessionRecord(readBearerToken(request));
      if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
      const isAdmin = readIdentityRoles(session.externalIdentity.roles).includes("admin");
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
      const jobs = await database.inferenceJob.findMany({
        where: isAdmin && url.searchParams.get("scope") === "all" ? { deletedAt: null } : { externalIdentityId: session.externalIdentity.id, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true },
      });
      sendSuccess(response, { jobs: await Promise.all(jobs.map((job) => toInferenceJobView(job.id))) });
    });

    router.get("/v1/inference/jobs/:id", async ({ request, response, params }) => {
      const session = await findLocalSessionRecord(readBearerToken(request));
      if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
      const authorized = await authorizeJob(session.externalIdentity, params.id);
      if (!authorized) return sendError(response, 404, "job_not_found", "任务不存在");
      sendSuccess(response, await toInferenceJobView(params.id));
    });

    router.get("/v1/inference/jobs/:id/loras/:versionId/cover", async ({ request, response, params }) => {
      const session = await findLocalSessionRecord(readBearerToken(request));
      if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
      const job = await authorizeJob(session.externalIdentity, params.id);
      const selectedVersionIds = job ? readTaskLoraVersionIds(job.parameters) : [];
      if (!job || !selectedVersionIds.includes(params.versionId)) return sendError(response, 404, "job_lora_cover_not_found", "任务 LoRA 封面不存在");
      const version = await database.loraVersion.findUnique({
        where: { id: params.versionId },
        include: { loraEntry: { include: { examples: { include: { artifact: true }, orderBy: { sortOrder: "asc" }, take: 1 } } } },
      });
      const example = version?.loraEntry.examples[0];
      if (!example) return sendError(response, 404, "job_lora_cover_not_found", "任务 LoRA 封面不存在");
      const object = await getObjectBuffer(example.artifact.objectKey);
      response.writeHead(200, { "content-type": example.artifact.mimeType || object.contentType, "content-length": String(object.body.length), "cache-control": "private, max-age=300" });
      response.end(object.body);
    });

    router.post("/v1/inference/jobs/:id/cancel", async ({ request, response, params }) => {
      const session = await findLocalSessionRecord(readBearerToken(request));
      if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
      try {
        const input = inferenceJobCancelRequestSchema.parse(await readJsonBody<unknown>(request));
        const job = await authorizeJob(session.externalIdentity, params.id);
        if (!job) return sendError(response, 404, "job_not_found", "任务不存在");
        await cancelInferenceJob(job.id, input.reason);
        sendSuccess(response, await toInferenceJobView(job.id));
      } catch (error) {
        sendInferenceError(response, error);
      }
    });

    router.delete("/v1/inference/jobs/:id", async ({ request, response, params }) => {
      const session = await findLocalSessionRecord(readBearerToken(request));
      if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
      try {
        const job = await authorizeJob(session.externalIdentity, params.id);
        if (!job) return sendError(response, 404, "job_not_found", "任务不存在");
        await removeInferenceJob(job.id, true);
        sendSuccess(response, { id: job.id, deleted: true });
      } catch (error) {
        sendInferenceError(response, error);
      }
    });

    router.delete("/internal/gallery-publications/:externalTaskId", async ({ request, response, params }) => {
      if (!authenticateMainPlatform(request)) return sendError(response, 403, "main_platform_token_invalid", "主站服务凭证不正确");
      try {
        const deleted = await removeInferenceJob(params.externalTaskId, false);
        sendSuccess(response, { id: params.externalTaskId, deleted });
      } catch (error) {
        sendInferenceError(response, error);
      }
    });

    router.get("/v1/artifacts/:id/content", async ({ request, response, params }) => {
      const session = await findLocalSessionRecord(readBearerToken(request));
      if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
      const artifact = await database.jobArtifact.findUnique({ where: { id: params.id }, include: { job: true } });
      const isAdmin = readIdentityRoles(session.externalIdentity.roles).includes("admin");
      if (!artifact || !artifact.job || artifact.job.deletedAt || (!isAdmin && artifact.job.externalIdentityId !== session.externalIdentity.id)) {
        return sendError(response, 404, "artifact_not_found", "产物不存在");
      }
      const object = await getObjectBuffer(artifact.objectKey);
      response.writeHead(200, { "content-type": artifact.mimeType || object.contentType, "content-length": String(object.body.length), "cache-control": "private, max-age=300" });
      response.end(object.body);
    });

    router.get("/internal/artifacts/:id/content", async ({ request, response, params }) => {
      if (!authenticateMainPlatform(request)) return sendError(response, 403, "main_platform_token_invalid", "主站服务凭证不正确");
      const artifact = await database.jobArtifact.findUnique({
        where: { id: params.id },
        include: { job: { include: { billingReservation: true } } },
      });
      if (!artifact?.job || artifact.job.deletedAt || artifact.job.status !== "SUCCEEDED" || artifact.job.billingReservation?.status !== "COMMITTED") {
        return sendError(response, 404, "artifact_not_publishable", "产物不存在或尚未达到发布终态");
      }
      const object = await getObjectBuffer(artifact.objectKey);
      response.writeHead(200, {
        "content-type": artifact.mimeType || object.contentType,
        "content-length": String(object.body.length),
        "x-artifact-sha256": artifact.sha256,
        "cache-control": "no-store",
      });
      response.end(object.body);
    });

    router.get("/internal/gallery-publications/:externalTaskId/loras/:versionId/cover", async ({ request, response, params }) => {
      if (!authenticateMainPlatform(request)) return sendError(response, 403, "main_platform_token_invalid", "主站服务凭证不正确");
      const job = await database.inferenceJob.findUnique({
        where: { id: params.externalTaskId },
        include: { galleryPublication: true },
      });
      const selectedVersionIds = job ? readTaskLoraVersionIds(job.parameters) : [];
      // 只有仍存在且已经正式发布到主站图库的任务才允许服务间读取 LoRA 封面。
      if (!job || job.deletedAt || job.status !== "SUCCEEDED" || job.galleryPublication?.status !== "PUBLISHED" || !selectedVersionIds.includes(params.versionId)) {
        return sendError(response, 404, "gallery_lora_cover_not_found", "图库 LoRA 封面不存在");
      }
      const version = await database.loraVersion.findUnique({
        where: { id: params.versionId },
        include: { loraEntry: { include: { examples: { include: { artifact: true }, orderBy: { sortOrder: "asc" }, take: 1 } } } },
      });
      const example = version?.loraEntry.examples[0];
      if (!example) return sendError(response, 404, "gallery_lora_cover_not_found", "图库 LoRA 封面不存在");
      const object = await getObjectBuffer(example.artifact.objectKey);
      response.writeHead(200, {
        "content-type": example.artifact.mimeType || object.contentType,
        "content-length": String(object.body.length),
        "cache-control": "private, max-age=300",
      });
      response.end(object.body);
    });

    router.get("/internal/gallery-publications/:externalTaskId/loras", async ({ request, response, params }) => {
      if (!authenticateMainPlatform(request)) return sendError(response, 403, "main_platform_token_invalid", "主站服务凭证不正确");
      const job = await database.inferenceJob.findUnique({
        where: { id: params.externalTaskId },
        include: { galleryPublication: true },
      });
      const selectedVersionIds = job ? readTaskLoraVersionIds(job.parameters) : [];
      if (!job || job.deletedAt || job.status !== "SUCCEEDED" || job.galleryPublication?.status !== "PUBLISHED") {
        return sendError(response, 404, "gallery_lora_metadata_not_found", "图库 LoRA 元数据不存在");
      }
      const versions = selectedVersionIds.length > 0 ? await database.loraVersion.findMany({
        where: { id: { in: selectedVersionIds } },
        include: { loraEntry: { select: { id: true, title: true, type: true } } },
      }) : [];
      const versionMap = new Map(versions.map((version) => [version.id, version]));
      // 返回顺序严格跟随任务固化版本 ID，实时标题只改变展示，不改变历史权重和版本绑定。
      const loras = selectedVersionIds.flatMap((loraVersionId): GalleryLoraMetadataView[] => {
        const version = versionMap.get(loraVersionId);
        if (!version) return [];
        return [{
          loraVersionId,
          loraEntryId: version.loraEntry.id,
          title: version.loraEntry.title,
          type: version.loraEntry.type.toLowerCase() as GalleryLoraMetadataView["type"],
        }];
      });
      sendSuccess(response, { loras, negativePrompt: job.negativePrompt?.trim() || null });
    });

    router.delete("/v1/auth/session", async ({ request, response }) => {
      const token = readBearerToken(request);
      if (token) await database.platformSession.updateMany({
        where: { tokenHash: hashToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
      sendSuccess(response, { revoked: true });
    });

    router.get("/v1/system/overview", async ({ response }) => {
      const [api, ...services] = await Promise.all([
        getReadiness(),
        ...serviceEndpoints.map(([service, key, fallback]) => fetchServiceReadiness(service, key, fallback)),
      ]);
      const overview: PlatformOverviewView = {
        platform: "drawhime-local-platform",
        phase: "runtime",
        ready: [api, ...services].every((service) => service.ready),
        generatedAt: new Date().toISOString(),
        services: [api, ...services],
        capabilities: [
          { id: "control-plane", label: "基础控制面", status: "available", message: "健康与依赖状态端点已启用" },
          { id: "sso", label: "主站单点登录", status: "available", message: "主站身份交换与独立短期会话已启用" },
          { id: "inference", label: "本地推理", status: "available", message: "任务持久化、主站预留、Redis 队列、ComfyUI 与对象存储已接入" },
          { id: "prompt-enhancement", label: "AI 提示增强", status: "available", message: "Anima 独立转写作为任务内一次性持久化阶段运行" },
          { id: "lora-training", label: "LoRA 训练", status: "available", message: "数据集、训练 Runtime、计费退款、产物校验与 LoRA 草稿已接入" },
        ],
      };
      sendSuccess(response, overview);
    });
  },
});

/** 使用服务凭证向主站交换最小身份摘要，主站 JWT 不写入本地数据库。 */
async function exchangeMainIdentity(mainToken: string): Promise<MainIdentityExchangeView | null> {
  const baseUrl = process.env.MAIN_PLATFORM_INTERNAL_URL?.trim() || process.env.MAIN_PLATFORM_BASE_URL?.trim();
  const serviceToken = process.env.MAIN_PLATFORM_CLIENT_SECRET?.trim();
  if (!baseUrl || !serviceToken) return null;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/internal/integrations/local-model/auth/exchange`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mainToken}`,
        "x-local-platform-token": serviceToken,
      },
      signal: AbortSignal.timeout(8000),
    });
    const payload = (await response.json()) as { ok?: boolean; data?: unknown };
    if (!response.ok || payload.ok !== true) return null;
    return mainIdentityExchangeViewSchema.parse(payload.data);
  } catch {
    return null;
  }
}

/** 创建独立平台短期会话；只持久化随机 token 哈希。 */
async function createLocalSession(identity: MainIdentityExchangeView): Promise<LocalPlatformSessionView> {
  const externalIdentity = await database.externalIdentity.upsert({
    where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } },
    update: {
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      roles: identity.roles,
      emailVerified: identity.emailVerified,
      lastAuthenticatedAt: new Date(),
    },
    create: {
      issuer: identity.issuer,
      subject: identity.subject,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      roles: identity.roles,
      emailVerified: identity.emailVerified,
      lastAuthenticatedAt: new Date(),
    },
  });
  const sessionToken = randomBytes(32).toString("base64url");
  const ttlHours = Math.min(Math.max(Number(process.env.LOCAL_SESSION_TTL_HOURS || 12), 1), 168);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await database.platformSession.create({
    data: { externalIdentityId: externalIdentity.id, tokenHash: hashToken(sessionToken), expiresAt },
  });
  return {
    identity: {
      issuer: identity.issuer,
      subject: identity.subject,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      roles: identity.roles,
      emailVerified: identity.emailVerified,
    },
    sessionToken,
    expiresAt: expiresAt.toISOString(),
  };
}

/** 校验独立平台会话并返回当前身份，过期和撤销会话均不再可用。 */
async function findLocalSession(token: string | null): Promise<LocalPlatformSessionView | null> {
  const session = await findLocalSessionRecord(token);
  if (!session || !token) return null;
  const roles = readIdentityRoles(session.externalIdentity.roles);
  return {
    identity: {
      issuer: session.externalIdentity.issuer,
      subject: session.externalIdentity.subject,
      displayName: session.externalIdentity.displayName,
      avatarUrl: session.externalIdentity.avatarUrl,
      roles,
      emailVerified: session.externalIdentity.emailVerified,
    },
    sessionToken: token,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/** 查询有效独立会话及数据库身份，业务路由据此执行对象级权限检查。 */
async function findLocalSessionRecord(token: string | null) {
  if (!token) return null;
  const session = await database.platformSession.findFirst({
    where: { tokenHash: hashToken(token), revokedAt: null, expiresAt: { gt: new Date() } },
    include: { externalIdentity: true },
  });
  if (!session) return null;
  await database.platformSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  return session;
}

/** 读取身份角色，异常历史值仅回退普通用户。 */
function readIdentityRoles(value: unknown): Array<"user" | "admin"> {
  const roles = Array.isArray(value) ? value.filter((role): role is "user" | "admin" => role === "user" || role === "admin") : [];
  return roles.length ? roles : ["user"];
}

/** 查询可用模型及其唯一活动工作流。 */
async function listInferenceModels(): Promise<InferenceModelView[]> {
  const rows = await database.modelVersion.findMany({
    where: { status: "ACTIVE", family: { status: "ACTIVE" }, workflowVersions: { some: { status: "ACTIVE" } } },
    include: { family: true, workflowVersions: { where: { status: "ACTIVE" }, orderBy: { version: "desc" }, take: 1 } },
    orderBy: { displayName: "asc" },
  });
  return rows.flatMap((row) => {
    const workflow = row.workflowVersions[0];
    if (!workflow) return [];
    const defaults = readObject(row.defaultParameters);
    return [{
      modelVersionId: row.id,
      workflowVersionId: workflow.id,
      family: row.family.slug,
      version: row.version,
      displayName: row.displayName,
      description: row.description,
      productCode: String(defaults.productCode || ""),
      pricingVersion: Number(defaults.pricingVersion || 0),
      priceCny: String(defaults.priceCny || "0.00"),
      defaultParameters: defaults,
    }];
  }).filter((row) => row.productCode && row.pricingVersion > 0);
}

/** 持久化任务后向主站预留资金，再投递只含任务 ID 的 Redis 队列。 */
async function createInferenceJob(identity: { id: string; subject: string }, input: InferenceJobCreateRequest, source: "web" | "bot" = "web"): Promise<{ jobId: string; created: boolean }> {
  if (input.batchSize !== 1) throw new ApiOperationError(400, "batch_size_unsupported", "当前本地模型任务每次生成 1 张图片");
  if (input.sourceArtifactIds.length > 0) throw new ApiOperationError(400, "source_image_unsupported", "当前 Anima 工作流仅支持文生图");
  const existing = await database.inferenceJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.externalIdentityId !== identity.id || existing.modelVersionId !== input.modelVersionId || existing.requestedPrompt !== input.prompt) {
      throw new ApiOperationError(409, "idempotency_conflict", "任务幂等键已经被其他请求使用");
    }
    if (existing.status === "RESERVING") await ensureMainReservation(existing.id);
    return { jobId: existing.id, created: false };
  }
  const workflow = await database.workflowVersion.findFirst({
    where: { id: input.workflowVersionId, modelVersionId: input.modelVersionId, status: "ACTIVE", runtimeDefinition: { status: "ACTIVE" }, modelVersion: { status: "ACTIVE" } },
    include: { modelVersion: true },
  });
  if (!workflow) throw new ApiOperationError(400, "model_workflow_invalid", "模型与工作流不可用或不匹配");
  if (input.loraVersionIds.length > 4) throw new ApiOperationError(400, "lora_limit_exceeded", "单个任务最多选择 4 个 LoRA");
  if (new Set(input.loraVersionIds).size !== input.loraVersionIds.length) throw new ApiOperationError(400, "lora_duplicate", "同一 LoRA 不能重复选择");
  const loraStrengths = input.loraStrengths ?? {};
  if (Object.keys(loraStrengths).some((id) => !input.loraVersionIds.includes(id))) throw new ApiOperationError(400, "lora_strength_invalid", "LoRA 强度包含未选择的版本");
  const selectedLoras = input.loraVersionIds.length > 0 ? await database.loraVersion.findMany({
    // 私有 LoRA 只允许作者提交；公开 LoRA 才能被其他用户用于生成，并固化类型和触发词快照供 Worker 实际注入。
    where: { id: { in: input.loraVersionIds }, status: "ACTIVE", loraEntry: { status: "ACTIVE", modelFamilyId: workflow.modelVersion.familyId, OR: [{ isPrivate: false }, { ownerIdentityId: identity.id }] } },
    include: { loraEntry: { select: { title: true, type: true, triggerWords: true } } },
  }) : [];
  if (selectedLoras.length !== input.loraVersionIds.length) throw new ApiOperationError(400, "lora_version_invalid", "所选 LoRA 不存在、已停用或与主模型系列不匹配");
  const loraMap = new Map(selectedLoras.map((item) => [item.id, item]));
  const loraSelections = input.loraVersionIds.map((id) => {
    const lora = loraMap.get(id);
    if (!lora) throw new ApiOperationError(400, "lora_version_invalid", "所选 LoRA 不存在或已停用");
    const type = lora.loraEntry.type.toLowerCase();
    return {
      loraVersionId: id,
      type,
      title: lora.loraEntry.title,
      strength: normalizeLoraStrength(loraStrengths[id], type),
      triggerWords: readTriggerWords(lora.loraEntry.triggerWords),
    };
  });
  const defaults = readObject(workflow.modelVersion.defaultParameters);
  if (input.promptEnhancement && defaults.promptEnhancementEnabled !== true) throw new ApiOperationError(400, "prompt_enhancement_disabled", "当前模型未开放 AI 提示增强");
  const productCode = String(defaults.productCode || "");
  const pricingVersion = Number(defaults.pricingVersion || 0);
  const priceCny = Number(defaults.priceCny || 0);
  if (!productCode || !Number.isSafeInteger(pricingVersion) || pricingVersion <= 0 || priceCny <= 0) {
    throw new ApiOperationError(503, "model_price_missing", "模型尚未配置有效主站价格版本");
  }
  const job = await database.$transaction(async (tx) => {
    const created = await tx.inferenceJob.create({
      data: {
        externalIdentityId: identity.id,
        modelVersionId: input.modelVersionId,
        runtimeDefinitionId: workflow.runtimeDefinitionId,
        workflowVersionId: workflow.id,
        idempotencyKey: input.idempotencyKey,
        source,
        status: "RESERVING",
        requestedPrompt: input.prompt,
        effectivePrompt: input.promptEnhancement ? null : input.prompt,
        // 正负提示词使用独立数据库字段，空白负面提示词归一为空，禁止混入正面提示词参数。
        negativePrompt: input.negativePrompt?.trim() || null,
        parameters: { width: input.width, height: input.height, batchSize: input.batchSize, seed: input.seed, loraVersionIds: input.loraVersionIds, loraStrengths, loraSelections, sourceArtifactIds: input.sourceArtifactIds, promptEnhancement: input.promptEnhancement, publishToGallery: input.publishToGallery, isPrivate: input.isPrivate, productCode, pricingVersion },
        stages: input.promptEnhancement ? { create: { sequence: 1, stageType: "PROMPT_ENHANCEMENT", status: "PENDING", inputJson: { format: "anima", promptLength: input.prompt.length } } } : undefined,
      },
    });
    await tx.billingReservationMirror.create({
      data: { jobId: created.id, idempotencyKey: `reserve:${created.id}`, priceVersion: `${productCode}@${pricingVersion}`, amountMinor: BigInt(Math.round(priceCny * input.batchSize * 100)), currency: "CNY", status: "PENDING" },
    });
    return created;
  });
  await ensureMainReservation(job.id);
  return { jobId: job.id, created: true };
}

/** 按资产类型给出平衡默认强度，角色优先保留身份，画风默认足以体现训练风格而不压制角色。 */
function normalizeLoraStrength(value: unknown, type: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1.5) return Math.round(numeric * 100) / 100;
  return ({ character: 1, style: 0.85, concept: 0.8, clothing: 0.85, pose: 0.7, other: 0.8 } as Record<string, number>)[type] ?? 0.8;
}

/** 从 LoRA 条目 JSON 中读取受控触发词快照，避免非字符串内容进入提示词。 */
function readTriggerWords(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 32) : [];
}

/** 查询已发布且文件版本可用的 LoRA。 */
async function listInferenceLoras(viewerIdentityId: string, family?: string): Promise<InferenceLoraView[]> {
  const rows = await database.loraEntry.findMany({
    where: { deletedAt: null, status: "ACTIVE", OR: [{ isPrivate: false }, { ownerIdentityId: viewerIdentityId }], modelFamily: family ? { slug: family, status: "ACTIVE" } : { status: "ACTIVE" }, versions: { some: { status: "ACTIVE" } } },
    include: { modelFamily: true, versions: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { createdAt: "desc" },
  });
  return rows.flatMap((entry) => entry.versions[0] ? [{
    loraVersionId: entry.versions[0].id,
    title: entry.title,
    description: entry.description,
    type: entry.type.toLowerCase() as InferenceLoraView["type"],
    modelFamily: entry.modelFamily.slug,
    fileName: entry.versions[0].fileName,
    sha256: entry.versions[0].sha256,
    triggerWords: Array.isArray(entry.triggerWords) ? entry.triggerWords.filter((value): value is string => typeof value === "string") : [],
    privacy: entry.isPrivate ? "private" : "public",
  }] : []);
}

/** 幂等完成主站资金预留；临时网络故障保留 RESERVING 供后续重试。 */
async function ensureMainReservation(jobId: string): Promise<void> {
  const job = await database.inferenceJob.findUnique({ where: { id: jobId }, include: { externalIdentity: true, billingReservation: true } });
  if (!job || !job.billingReservation) throw new ApiOperationError(500, "reservation_mirror_missing", "任务资金镜像不存在");
  if (job.billingReservation.status === "RESERVED") {
    await inferenceQueue.push(job.id);
    return;
  }
  const parameters = readObject(job.parameters);
  try {
    const reservation = await reserveMainBilling({
      jobId: job.id,
      idempotencyKey: job.billingReservation.idempotencyKey,
      userSubject: job.externalIdentity.subject,
      walletOwnerType: job.source === "bot" ? "qq" : "user",
      productCode: String(parameters.productCode),
      pricingVersion: Number(parameters.pricingVersion),
      quantity: Number(parameters.batchSize || 1),
    });
    await database.$transaction([
      database.billingReservationMirror.update({ where: { jobId: job.id }, data: { mainReservationId: reservation.reservationId, amountMinor: BigInt(Math.round(Number(reservation.reservedAmount) * 100)), status: "RESERVED", expiresAt: reservation.expiresAt ? new Date(reservation.expiresAt) : null, lastSynchronizedAt: new Date(), errorMessage: null } }),
      database.inferenceJob.update({ where: { id: job.id }, data: { status: "READY", progress: 1, errorCode: null, errorMessage: null } }),
    ]);
    await inferenceQueue.push(job.id);
  } catch (error) {
    const temporary = error instanceof MainPlatformIntegrationError && error.status >= 500;
    await database.$transaction([
      database.billingReservationMirror.update({ where: { jobId: job.id }, data: { status: temporary ? "PENDING" : "FAILED", errorMessage: errorMessage(error), lastSynchronizedAt: new Date() } }),
      database.inferenceJob.update({ where: { id: job.id }, data: { status: temporary ? "RESERVING" : "FAILED", progress: temporary ? 0 : 100, errorCode: temporary ? "billing_reservation_pending" : "billing_reservation_failed", errorMessage: errorMessage(error), completedAt: temporary ? null : new Date() } }),
    ]);
    throw error;
  }
}

/** 取消未运行任务并释放主站资金预留。 */
async function cancelInferenceJob(jobId: string, reason: string): Promise<void> {
  const job = await database.inferenceJob.findUnique({ where: { id: jobId }, include: { billingReservation: true } });
  if (!job) throw new ApiOperationError(404, "job_not_found", "任务不存在");
  if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) return;
  if (job.status === "RUNNING") throw new ApiOperationError(409, "job_running", "任务已经进入 GPU 运行阶段");
  if (job.status === "RESERVING") await ensureMainReservation(job.id);
  const refreshed = await database.billingReservationMirror.findUnique({ where: { jobId } });
  if (refreshed?.mainReservationId && refreshed.status === "RESERVED") {
    await releaseMainBilling(refreshed.mainReservationId, `release:${jobId}`, reason);
  }
  await database.$transaction([
    database.inferenceJob.update({ where: { id: jobId }, data: { status: "CANCELLED", progress: 100, errorCode: "cancelled_by_user", errorMessage: reason, completedAt: new Date() } }),
    database.billingReservationMirror.update({ where: { jobId }, data: { status: "RELEASED", lastSynchronizedAt: new Date(), errorMessage: null } }),
    database.jobStage.updateMany({ where: { jobId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "CANCELLED", errorMessage: reason, completedAt: new Date() } }),
  ]);
}

/** 删除已结束推理记录；用户入口先清理主站图库，主站回调入口只执行本地软删除以避免循环调用。 */
async function removeInferenceJob(jobId: string, removeMainPublication: boolean): Promise<boolean> {
  const job = await database.inferenceJob.findUnique({ where: { id: jobId }, include: { galleryPublication: true } });
  if (!job || job.deletedAt) return false;
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) throw new ApiOperationError(409, "job_not_finished", "任务仍在处理中，请先取消或等待完成");
  if (removeMainPublication && job.galleryPublication?.mainGalleryItemId) await removeMainGallery(job.id);
  // 软删除仅影响用户可见列表和产物访问，钱包预留、计费镜像、运行尝试与 LoRA 引用继续保留审计。
  await database.inferenceJob.updateMany({ where: { id: job.id, deletedAt: null }, data: { deletedAt: new Date() } });
  return true;
}

/** 校验任务归属；管理员可读取全局任务。 */
async function authorizeJob(identity: { id: string; roles: unknown }, jobId: string) {
  const job = await database.inferenceJob.findFirst({ where: { id: jobId, deletedAt: null } });
  if (!job) return null;
  return job.externalIdentityId === identity.id || readIdentityRoles(identity.roles).includes("admin") ? job : null;
}

/** API 可控业务错误。 */
class ApiOperationError extends Error {
  public constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/** 统一输出推理写接口错误。 */
function sendInferenceError(response: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof ApiOperationError) return sendError(response, error.status, error.code, error.message);
  if (error instanceof MainPlatformIntegrationError) return sendError(response, error.status, error.code, error.message);
  const issue = error && typeof error === "object" && "issues" in error ? "请求参数不正确" : errorMessage(error);
  sendError(response, 400, "inference_request_failed", issue);
}

/** Prisma JSON 只向业务层暴露普通对象。 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 从任务参数读取实际选择的 LoRA 版本，兼容旧任务仅保存选择快照的情况。 */
function readTaskLoraVersionIds(value: unknown): string[] {
  const parameters = readObject(value);
  const direct = Array.isArray(parameters.loraVersionIds) ? parameters.loraVersionIds.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  if (direct.length > 0) return [...new Set(direct)].slice(0, 4);
  if (!Array.isArray(parameters.loraSelections)) return [];
  return [...new Set(parameters.loraSelections.flatMap((selection) => selection && typeof selection === "object" && !Array.isArray(selection) && typeof (selection as Record<string, unknown>).loraVersionId === "string" ? [(selection as Record<string, unknown>).loraVersionId as string] : []))].slice(0, 4);
}

/** 输出受限错误摘要。 */
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** 从 Authorization 请求头读取 Bearer token。 */
function readBearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization?.trim() || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() || null : null;
}

/** 主站只能使用与 Integration API 相同的服务凭证读取可发布产物。 */
function authenticateMainPlatform(request: IncomingMessage): boolean {
  const expected = process.env.MAIN_PLATFORM_CLIENT_SECRET?.trim();
  const actual = String(request.headers["x-local-platform-token"] ?? "").trim();
  return Boolean(expected && actual && actual === expected);
}

/** 对浏览器会话 token 做固定 SHA-256 哈希后再查询或写库。 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
