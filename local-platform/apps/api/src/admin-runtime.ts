/**
 * 本文件实现本地模型管理端的 GPU、模型、工作流和队列真实控制接口。
 */
import type { ExternalIdentity } from "@prisma/client";
import { adminGpuHostUpdateRequestSchema, adminModelUpdateRequestSchema, adminRuntimeConfigUpdateRequestSchema, adminWorkflowUpdateRequestSchema, type AdminRuntimeOverviewView } from "@drawhime/contracts";
import { database } from "@drawhime/database";
import { MainPlatformIntegrationError, publishMainPrice } from "@drawhime/main-platform-client";
import { readJsonBody, sendError, sendSuccess, type ServiceRouter } from "@drawhime/service-runtime";
import type { IncomingMessage } from "node:http";
import { DEFAULT_INFERENCE_SUBMISSION_COOLDOWN_SECONDS, normalizeInferenceSubmissionCooldownSeconds } from "./submission-cooldown.js";

type SessionRecord = { externalIdentity: ExternalIdentity };
type FindSession = (token: string | null) => Promise<SessionRecord | null>;

/** 注册只有主站管理员可调用的运行管理接口。 */
export function registerAdminRuntimeRoutes(router: ServiceRouter, findSession: FindSession): void {
  router.get("/v1/admin/runtime", async ({ request, response }) => {
    const session = await requireAdmin(request, response, findSession);
    if (!session) return;
    sendSuccess(response, await buildRuntimeOverview());
  });

  router.register("PATCH", "/v1/admin/runtime-config", async ({ request, response }) => {
    const session = await requireAdmin(request, response, findSession);
    if (!session) return;
    try {
      const input = adminRuntimeConfigUpdateRequestSchema.parse(await readJsonBody<unknown>(request));
      // 单例配置使用幂等 upsert，管理员调整后新提交立即按最后成功提交时间重新计算。
      await database.platformRuntimeConfig.upsert({
        where: { id: 1 },
        create: { id: 1, inferenceSubmissionCooldownSeconds: input.inferenceSubmissionCooldownSeconds },
        update: { inferenceSubmissionCooldownSeconds: input.inferenceSubmissionCooldownSeconds },
      });
      sendSuccess(response, await buildRuntimeOverview());
    } catch (error) { sendAdminError(response, error); }
  });

  router.register("PATCH", "/v1/admin/models/:id", async ({ request, response, params }) => {
    const session = await requireAdmin(request, response, findSession);
    if (!session) return;
    try {
      const input = adminModelUpdateRequestSchema.parse(await readJsonBody<unknown>(request));
      const model = await database.modelVersion.findUnique({ where: { id: params.id } });
      if (!model) return sendError(response, 404, "model_not_found", "本地模型不存在");
      if (!input.active) {
        const activeJobs = await database.inferenceJob.count({ where: { modelVersionId: model.id, status: { in: ["RESERVING", "READY", "RUNNING"] } } });
        if (activeJobs > 0) return sendError(response, 409, "model_has_active_jobs", `模型仍有 ${activeJobs} 个活动任务，暂不允许停用`);
      } else {
        // 启用模型前确认至少存在一条活动工作流，避免向用户暴露不可执行模型。
        const activeWorkflows = await database.workflowVersion.count({ where: { modelVersionId: model.id, status: "ACTIVE", runtimeDefinition: { status: "ACTIVE" } } });
        if (activeWorkflows === 0) return sendError(response, 409, "model_has_no_active_workflow", "模型没有可用的活动工作流，请先启用工作流");
      }
      await publishMainPrice({ productCode: input.productCode, pricingVersion: input.pricingVersion, unitPrice: input.priceCny });
      await publishMainPrice({ productCode: input.trainingProductCode, pricingVersion: input.trainingPricingVersion, unitPrice: input.trainingPriceCny, billingUnit: "training_job" });
      const defaults = readObject(model.defaultParameters);
      await database.modelVersion.update({
        where: { id: model.id },
        data: {
          displayName: input.displayName,
          description: input.description,
          status: input.active ? "ACTIVE" : "DISABLED",
          defaultParameters: { ...defaults, maxEdge: input.maxEdge, maxAttempts: input.maxAttempts, promptEnhancementEnabled: input.promptEnhancementEnabled, productCode: input.productCode, pricingVersion: input.pricingVersion, priceCny: input.priceCny, trainingProductCode: input.trainingProductCode, trainingPricingVersion: input.trainingPricingVersion, trainingPriceCny: input.trainingPriceCny },
        },
      });
      sendSuccess(response, await buildRuntimeOverview());
    } catch (error) { sendAdminError(response, error); }
  });

  router.register("PATCH", "/v1/admin/gpu-hosts/:id", async ({ request, response, params }) => {
    const session = await requireAdmin(request, response, findSession);
    if (!session) return;
    try {
      const input = adminGpuHostUpdateRequestSchema.parse(await readJsonBody<unknown>(request));
      const updated = await database.gpuHost.updateMany({ where: { id: params.id }, data: { status: input.active ? "ACTIVE" : "DISABLED" } });
      if (updated.count !== 1) return sendError(response, 404, "gpu_host_not_found", "GPU 主机不存在");
      sendSuccess(response, await buildRuntimeOverview());
    } catch (error) { sendAdminError(response, error); }
  });

  router.register("PATCH", "/v1/admin/workflows/:id", async ({ request, response, params }) => {
    const session = await requireAdmin(request, response, findSession);
    if (!session) return;
    try {
      const input = adminWorkflowUpdateRequestSchema.parse(await readJsonBody<unknown>(request));
      const workflow = await database.workflowVersion.findUnique({ where: { id: params.id }, include: { modelVersion: true } });
      if (!workflow) return sendError(response, 404, "workflow_not_found", "工作流版本不存在");
      if (!input.active) {
        // 停用前同时保护正在执行的任务与已启用模型的最后一条可用链路。
        const [activeJobs, otherActiveWorkflows] = await Promise.all([
          database.inferenceJob.count({ where: { workflowVersionId: workflow.id, status: { in: ["RESERVING", "READY", "RUNNING"] } } }),
          database.workflowVersion.count({ where: { modelVersionId: workflow.modelVersionId, id: { not: workflow.id }, status: "ACTIVE" } }),
        ]);
        if (activeJobs > 0) return sendError(response, 409, "workflow_has_active_jobs", `工作流仍有 ${activeJobs} 个活动任务，暂不允许停用`);
        if (workflow.modelVersion.status === "ACTIVE" && otherActiveWorkflows === 0) return sendError(response, 409, "workflow_is_last_active", "已启用模型必须至少保留一个活动工作流");
      }
      await database.workflowVersion.update({ where: { id: workflow.id }, data: { status: input.active ? "ACTIVE" : "DISABLED" } });
      sendSuccess(response, await buildRuntimeOverview());
    } catch (error) { sendAdminError(response, error); }
  });
}

/** 聚合管理端运行状态，不返回 Runtime token、对象存储键或主站凭证。 */
async function buildRuntimeOverview(): Promise<AdminRuntimeOverviewView> {
  const activeLeaseStatuses = ["OFFERED", "ACCEPTED", "RUNNING"] as const;
  const [reserving, ready, running, failed, succeeded, trainingReserving, trainingReady, trainingRunning, trainingEvaluating, trainingFailed, trainingSucceeded, hosts, models, runtimeConfig] = await Promise.all([
    database.inferenceJob.count({ where: { status: "RESERVING" } }),
    database.inferenceJob.count({ where: { status: "READY" } }),
    database.inferenceJob.count({ where: { status: "RUNNING" } }),
    database.inferenceJob.count({ where: { status: "FAILED" } }),
    database.inferenceJob.count({ where: { status: "SUCCEEDED" } }),
    database.trainingJob.count({ where: { status: "RESERVING" } }),
    database.trainingJob.count({ where: { status: "READY" } }),
    database.trainingJob.count({ where: { status: "RUNNING" } }),
    database.trainingJob.count({ where: { status: "EVALUATING" } }),
    database.trainingJob.count({ where: { status: "FAILED" } }),
    database.trainingJob.count({ where: { status: "SUCCEEDED" } }),
    database.gpuHost.findMany({
      include: { devices: { include: { leases: { where: { status: { in: [...activeLeaseStatuses] } }, orderBy: { offeredAt: "desc" }, take: 1 }, trainingLeases: { where: { status: { in: [...activeLeaseStatuses] } }, orderBy: { offeredAt: "desc" }, take: 1 } }, orderBy: { deviceKey: "asc" } } },
      orderBy: { displayName: "asc" },
    }),
    database.modelVersion.findMany({
      where: { status: { not: "ARCHIVED" } },
      include: { family: true, workflowVersions: { where: { status: { not: "ARCHIVED" } }, include: { runtimeDefinition: true, workflowTemplate: true }, orderBy: { version: "desc" } } },
      orderBy: { displayName: "asc" },
    }),
    database.platformRuntimeConfig.findUnique({ where: { id: 1 } }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    settings: { inferenceSubmissionCooldownSeconds: normalizeInferenceSubmissionCooldownSeconds(runtimeConfig?.inferenceSubmissionCooldownSeconds ?? DEFAULT_INFERENCE_SUBMISSION_COOLDOWN_SECONDS) },
    queue: { reserving, ready, running, failed, succeeded },
    trainingQueue: { reserving: trainingReserving, ready: trainingReady, running: trainingRunning, evaluating: trainingEvaluating, failed: trainingFailed, succeeded: trainingSucceeded },
    gpuHosts: hosts.map((host) => ({
      id: host.id,
      agentKey: host.agentKey,
      displayName: host.displayName,
      active: host.status === "ACTIVE",
      agentVersion: host.agentVersion,
      lastHeartbeatAt: host.lastHeartbeatAt?.toISOString() ?? null,
      devices: host.devices.map((device) => ({
        id: device.id,
        name: device.name,
        totalVramBytes: Number(device.totalVramBytes),
        freeVramBytes: device.freeVramBytes === null ? null : Number(device.freeVramBytes),
        utilizationPercent: device.utilizationPercent?.toNumber() ?? null,
        temperatureCelsius: device.temperatureCelsius?.toNumber() ?? null,
        activeLeaseJobId: device.leases[0]?.jobId ?? null,
        activeTrainingJobId: device.trainingLeases[0]?.trainingJobId ?? null,
        lastHeartbeatAt: device.lastHeartbeatAt?.toISOString() ?? null,
      })),
    })),
    models: models.map((model) => ({
      id: model.id,
      family: model.family.slug,
      version: model.version,
      displayName: model.displayName,
      description: model.description,
      active: model.status === "ACTIVE",
      defaultParameters: readObject(model.defaultParameters),
      workflows: model.workflowVersions.map((workflow) => ({ id: workflow.id, name: workflow.workflowTemplate.name, version: workflow.version, active: workflow.status === "ACTIVE", sha256: workflow.sha256, runtimeType: workflow.runtimeDefinition.runtimeType })),
    })),
  };
}

/** 校验独立会话与主站管理员角色。 */
async function requireAdmin(request: IncomingMessage, response: Parameters<typeof sendError>[0], findSession: FindSession): Promise<SessionRecord | null> {
  const session = await findSession(readBearerToken(request));
  const roles = Array.isArray(session?.externalIdentity.roles) ? session.externalIdentity.roles : [];
  if (!session || !roles.includes("admin")) {
    sendError(response, 403, "admin_required", "需要主站管理员权限");
    return null;
  }
  return session;
}

/** 统一映射管理写入错误。 */
function sendAdminError(response: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof MainPlatformIntegrationError) return sendError(response, error.status, error.code, error.message);
  const issue = error && typeof error === "object" && "issues" in error ? "管理配置参数不正确" : error instanceof Error ? error.message : "运行配置更新失败";
  sendError(response, 400, "admin_runtime_update_failed", issue);
}

/** 读取 Prisma JSON 普通对象。 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 读取独立会话 Bearer token。 */
function readBearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization?.trim() || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() || null : null;
}
