/**
 * 本文件提供主站 Bot 使用的本地模型目录、QQ 身份任务提交和批量状态查询接口。
 */
import { localBotInferenceJobCreateRequestSchema, type InferenceJobCreateRequest, type InferenceModelView, type LocalBotInferenceJobView } from "@drawhime/contracts";
import { database } from "@drawhime/database";
import { readJsonBody, sendError, sendSuccess, type ServiceRouter } from "@drawhime/service-runtime";
import type { ServerResponse } from "node:http";

type BotRouteDependencies = {
  listModels: () => Promise<InferenceModelView[]>;
  createJob: (identity: { id: string; subject: string }, input: InferenceJobCreateRequest, source: "bot") => Promise<{ jobId: string; created: boolean }>;
  handleError: (response: ServerResponse, error: unknown) => void;
};

/** 注册只接受主站固定服务凭证的 Bot 路由。 */
export function registerBotRoutes(router: ServiceRouter, dependencies: BotRouteDependencies): void {
  router.get("/internal/bot/catalog", async ({ request, response }) => {
    if (!authenticateMainPlatform(request.headers["x-local-platform-token"])) return sendError(response, 403, "main_platform_token_invalid", "主站服务凭证不正确");
    sendSuccess(response, { models: await dependencies.listModels() });
  });

  router.post("/internal/bot/jobs", async ({ request, response }) => {
    if (!authenticateMainPlatform(request.headers["x-local-platform-token"])) return sendError(response, 403, "main_platform_token_invalid", "主站服务凭证不正确");
    try {
      const input = localBotInferenceJobCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      const identity = await upsertQqIdentity(input.qqNumber, input.displayName);
      const promptEnhancement = await isBotPromptEnhancementEnabled(input.modelVersionId);
      const result = await dependencies.createJob(identity, {
        idempotencyKey: input.idempotencyKey,
        modelVersionId: input.modelVersionId,
        workflowVersionId: input.workflowVersionId,
        prompt: input.prompt,
        // Bot 只提交用户原始提示词；模型开关开启时由独立任务执行且仅执行一次 Anima 提示增强。
        promptEnhancement,
        negativePrompt: input.negativePrompt,
        width: input.width,
        height: input.height,
        batchSize: 1,
        seed: input.seed ?? null,
        loraVersionIds: input.loraVersionIds,
        // Bot 暂不提供单项强度控件，仍按资产类型使用服务端平衡默认值。
        loraStrengths: {},
        sourceArtifactIds: [],
        publishToGallery: true,
        isPrivate: input.isPrivate,
      }, "bot");
      const billing = await database.billingReservationMirror.findUniqueOrThrow({ where: { jobId: result.jobId } });
      const job = await toBotJobView(result.jobId);
      if (job.status === "failed") return sendError(response, 409, "bot_job_failed", job.error || "本地模型任务创建失败");
      sendSuccess(response, { job, chargedAmount: (Number(billing.amountMinor) / 100).toFixed(2) }, result.created ? 201 : 200);
    } catch (error) {
      dependencies.handleError(response, error);
    }
  });

  router.get("/internal/bot/jobs", async ({ request, response, url }) => {
    if (!authenticateMainPlatform(request.headers["x-local-platform-token"])) return sendError(response, 403, "main_platform_token_invalid", "主站服务凭证不正确");
    const ids = [...new Set((url.searchParams.get("ids") || "").split(",").map((value) => value.trim()).filter((value) => /^[0-9a-f-]{36}$/i.test(value)))].slice(0, 100);
    const rows = await database.inferenceJob.findMany({ where: { id: { in: ids }, source: "bot" }, select: { id: true } });
    sendSuccess(response, { jobs: await Promise.all(rows.map((row) => toBotJobView(row.id))) });
  });
}

/** 按独立平台模型配置决定 Bot 默认提示增强，避免主站复制本地模型链路规则。 */
async function isBotPromptEnhancementEnabled(modelVersionId: string): Promise<boolean> {
  const model = await database.modelVersion.findUnique({ where: { id: modelVersionId }, select: { defaultParameters: true } });
  return readObject(model?.defaultParameters).promptEnhancementEnabled === true;
}

/** 幂等登记 QQ 外部身份，不创建浏览器会话，也不复制主站密码或钱包。 */
async function upsertQqIdentity(qqNumber: string, displayName: string) {
  const mainBase = (process.env.MAIN_PLATFORM_BASE_URL?.trim() || "https://www.xanime.ink").replace(/\/$/, "");
  return database.externalIdentity.upsert({
    where: { issuer_subject: { issuer: `${mainBase}/qq`, subject: qqNumber } },
    update: { displayName, roles: ["user"], emailVerified: false, lastAuthenticatedAt: new Date() },
    create: { issuer: `${mainBase}/qq`, subject: qqNumber, displayName, avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${qqNumber}&spec=100`, roles: ["user"], emailVerified: false, lastAuthenticatedAt: new Date() },
  });
}

/** 把独立任务映射成 Bot 轮询快照，成功媒体必须已经进入主站正式图库。 */
async function toBotJobView(jobId: string): Promise<LocalBotInferenceJobView> {
  const job = await database.inferenceJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { modelVersion: true, attempts: { orderBy: { attemptNumber: "asc" } }, galleryPublication: true },
  });
  const defaults = readObject(job.modelVersion.defaultParameters);
  const published = job.galleryPublication?.status === "PUBLISHED" && Boolean(job.galleryPublication.mediaUrl);
  const failed = job.status === "FAILED" || job.status === "CANCELLED";
  const status: LocalBotInferenceJobView["status"] = failed ? "failed" : published ? "success" : job.status === "QUEUED" || job.status === "RESERVING" || job.status === "READY" ? "queued" : "running";
  return {
    id: job.id,
    status,
    progress: published || failed ? 100 : Number(job.progress),
    imageUrl: published ? job.galleryPublication?.mediaUrl ?? undefined : undefined,
    error: failed ? job.errorMessage || "本地模型任务失败" : undefined,
    model: job.modelVersion.displayName,
    maxAttempts: normalizeAttempts(defaults.maxAttempts),
    subTasks: job.attempts.map((attempt) => ({
      kind: "upstream_attempt",
      status: attempt.status.toLowerCase(),
      attemptNo: attempt.attemptNumber,
      siteName: "本地模型独立平台",
      model: job.modelVersion.displayName,
      error: attempt.errorMessage ?? undefined,
      latencyMs: attempt.startedAt && attempt.completedAt ? Math.max(0, attempt.completedAt.getTime() - attempt.startedAt.getTime()) : undefined,
    })),
  };
}

/** 校验主站与独立平台共享的固定服务凭证。 */
function authenticateMainPlatform(value: string | string[] | undefined): boolean {
  const expected = process.env.MAIN_PLATFORM_CLIENT_SECRET?.trim();
  const actual = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
  return Boolean(expected && actual === expected);
}

/** 读取 Prisma JSON 普通对象。 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 归一化模型级尝试次数。 */
function normalizeAttempts(value: unknown): number {
  const parsed = Number(value ?? 3);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(10, parsed)) : 3;
}
