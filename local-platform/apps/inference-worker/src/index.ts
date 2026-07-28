/**
 * 本文件启动推理 Worker，负责领取已完成资金预留的任务、调用 ComfyUI、保存产物并提交或释放主站资金。
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { database } from "@drawhime/database";
import { generateAnimaImage } from "@drawhime/inference-runtime";
import { commitMainBilling, publishMainGallery, releaseMainBilling } from "@drawhime/main-platform-client";
import {
  createConfigCheck,
  createDatabaseCheck,
  createObjectStorageCheck,
  createRedisCheck,
  InferenceQueue,
  getObjectBuffer,
  putObjectBuffer,
  startService,
} from "@drawhime/service-runtime";
import { enhanceAnimaPrompt } from "./prompt-assist.js";

const queue = new InferenceQueue();
let shuttingDown = false;

startService({
  name: "inference-worker",
  port: Number(process.env.LOCAL_INFERENCE_WORKER_PORT || 7111),
  checks: [
    createDatabaseCheck(),
    createRedisCheck(),
    createObjectStorageCheck(),
    createConfigCheck("inference-runtime", ["COMFYUI_BASE_URL", "COMFYUI_SERVICE_TOKEN", "MAIN_PLATFORM_INTERNAL_URL", "MAIN_PLATFORM_CLIENT_SECRET", "PROMPT_ASSIST_BASE_URL", "PROMPT_ASSIST_API_KEY", "PROMPT_ASSIST_MODEL"]),
  ],
});

void runWorker();
process.on("SIGINT", () => { shuttingDown = true; void queue.close(); });
process.on("SIGTERM", () => { shuttingDown = true; void queue.close(); });

/** 持续领取 Redis 任务，并定期补偿数据库中未完成的资金释放。 */
async function runWorker(): Promise<void> {
  await recoverInterruptedJobs();
  while (!shuttingDown) {
    try {
      const jobId = await queue.pop(5);
      if (jobId) await processJob(jobId);
      else {
        await reconcileFailedReservations();
        await reconcileGalleryPublications();
      }
    } catch (error) {
      process.stderr.write(`推理 Worker 循环异常：${errorMessage(error)}\n`);
      await sleep(2000);
    }
  }
}

/** 执行一个任务；已有产物时只重试资金提交，避免网络抖动造成重复生成。 */
async function processJob(jobId: string): Promise<void> {
  const job = await database.inferenceJob.findUnique({
    where: { id: jobId },
    include: {
      modelVersion: true,
      runtimeDefinition: true,
      artifacts: true,
      billingReservation: true,
      leases: { where: { status: { in: ["OFFERED", "ACCEPTED"] } }, orderBy: { offeredAt: "desc" }, take: 1 },
      attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
      stages: { orderBy: { sequence: "asc" } },
    },
  });
  if (!job || job.status !== "READY" || job.billingReservation?.status !== "RESERVED") return;

  const jobParameters = readJsonObject(job.parameters);
  if (jobParameters.promptEnhancement === true && !job.effectivePrompt) {
    await processPromptEnhancement(job.id, job.requestedPrompt, job.billingReservation.mainReservationId, job.stages.find((stage) => stage.stageType === "PROMPT_ENHANCEMENT")?.id ?? null);
    return;
  }

  if (job.artifacts.length > 0) {
    await finalizeSuccessfulJob(job.id, job.billingReservation.mainReservationId);
    return;
  }
  const lease = job.leases[0];
  if (!lease || lease.expiresAt <= new Date()) return;

  const attemptNumber = (job.attempts[0]?.attemptNumber ?? 0) + 1;
  const maxAttempts = normalizeMaxAttempts(readJsonObject(job.modelVersion.defaultParameters).maxAttempts);
  const attempt = await database.$transaction(async (tx) => {
    const claimed = await tx.inferenceJob.updateMany({
      where: { id: job.id, status: "READY" },
      data: { status: "RUNNING", progress: 5, startedAt: job.startedAt ?? new Date(), errorCode: null, errorMessage: null },
    });
    if (claimed.count !== 1) return null;
    await tx.gpuLease.update({ where: { id: lease.id }, data: { status: "RUNNING", acceptedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60_000) } });
    return tx.inferenceAttempt.create({
      data: { jobId: job.id, attemptNumber, status: "RUNNING", startedAt: new Date() },
    });
  });
  if (!attempt) return;

  try {
    const parameters = readParameters(job.parameters);
    const modelDefaults = readJsonObject(job.modelVersion.defaultParameters);
    const loras = await resolveTaskLoras(parameters.loraVersionIds, parameters.loraStrengths, parameters.loraSnapshots);
    const submittedPrompt = appendLoraTriggerWords(job.effectivePrompt || job.requestedPrompt, loras);
    if (submittedPrompt !== job.effectivePrompt) {
      // 图库和任务详情必须保存真正送入 Runtime 的提示词，不能只保存增强前的文本。
      await database.inferenceJob.update({ where: { id: job.id }, data: { effectivePrompt: submittedPrompt } });
    }
    const result = await generateAnimaImage({
      baseUrl: requiredEnvironment("COMFYUI_BASE_URL"),
      modelFileName: job.modelVersion.version,
      prompt: submittedPrompt,
      negativePrompt: job.negativePrompt,
      width: parameters.width,
      height: parameters.height,
      seed: parameters.seed,
      clientId: job.id,
      loras,
      // 底模各自使用目录固化的官方推荐采样参数，禁止所有模型套用 Anima Base 的 Turbo 参数。
      steps: readBoundedInteger(modelDefaults.steps, 1, 50),
      cfg: readBoundedNumber(modelDefaults.cfg, 0.1, 20),
      samplerName: readOptionalString(modelDefaults.sampler),
      scheduler: readOptionalString(modelDefaults.scheduler),
      qualityPrefix: readOptionalString(modelDefaults.qualityPrefix),
      defaultNegativePrompt: readOptionalString(modelDefaults.defaultNegativePrompt),
      systemTurboLoraEnabled: modelDefaults.systemTurboLoraEnabled !== false,
      systemHighresLoraEnabled: modelDefaults.systemHighresLoraEnabled !== false,
      samplingMaxEdge: readBoundedInteger(modelDefaults.samplingMaxEdge, 512, 2048),
      samplingPixelBudget: readBoundedInteger(modelDefaults.samplingPixelBudget, 262_144, 4_194_304),
      samplingPixelBudgetAspectSlope: readBoundedInteger(modelDefaults.samplingPixelBudgetAspectSlope, 0, 1_000_000),
      onSubmitted: async (runtimeJobId, requestJson) => {
        await database.inferenceAttempt.update({ where: { id: attempt.id }, data: { runtimeJobId, requestJson: requestJson as Prisma.InputJsonObject } });
      },
    });
    const sha256 = createHash("sha256").update(result.buffer).digest("hex");
    const extension = result.mimeType === "image/png" ? "png" : "webp";
    const objectKey = `generated/${job.createdAt.getUTCFullYear()}/${String(job.createdAt.getUTCMonth() + 1).padStart(2, "0")}/${job.id}.${extension}`;
    await putObjectBuffer(objectKey, result.buffer, result.mimeType);
    await database.$transaction(async (tx) => {
      await tx.jobArtifact.upsert({
        where: { objectKey },
        update: { sha256, byteSize: BigInt(result.buffer.length), width: result.width, height: result.height, mimeType: result.mimeType },
        create: {
          jobId: job.id,
          kind: "GENERATED_IMAGE",
          objectKey,
          fileName: `${job.id}.${extension}`,
          mimeType: result.mimeType,
          sha256,
          byteSize: BigInt(result.buffer.length),
          width: result.width,
          height: result.height,
          metadata: { runtimeJobId: result.runtimeJobId },
        },
      });
      await tx.inferenceAttempt.update({
        where: { id: attempt.id },
        data: { status: "SUCCEEDED", runtimeJobId: result.runtimeJobId, requestJson: result.requestJson as Prisma.InputJsonObject, responseJson: result.responseJson as Prisma.InputJsonObject, completedAt: new Date() },
      });
      await tx.inferenceJob.update({ where: { id: job.id }, data: { progress: 95 } });
    });
    await finalizeSuccessfulJob(job.id, job.billingReservation.mainReservationId);
  } catch (error) {
    if (attemptNumber < maxAttempts && isRetryableRuntimeError(error)) await retryGeneratedJob(job.id, attempt.id, attemptNumber, maxAttempts, error);
    else await failGeneratedJob(job.id, attempt.id, job.billingReservation.mainReservationId, error);
  }
}

/** 领取并执行每个主任务唯一的提示增强阶段；生成重试只复用最终提示词。 */
async function processPromptEnhancement(jobId: string, requestedPrompt: string, mainReservationId: string | null, stageId: string | null): Promise<void> {
  if (!stageId) throw new Error("提示增强任务缺少持久化阶段");
  const claimed = await database.jobStage.updateMany({ where: { id: stageId, jobId, status: "PENDING" }, data: { status: "RUNNING", startedAt: new Date(), errorMessage: null } });
  if (claimed.count !== 1) return;
  await database.inferenceJob.update({ where: { id: jobId }, data: { progress: 2, errorCode: null, errorMessage: null } });
  try {
    const result = await enhanceAnimaPrompt(requestedPrompt, `drawhime-local:${jobId}`);
    await database.$transaction(async (tx) => {
      const active = await tx.inferenceJob.updateMany({ where: { id: jobId, status: "READY" }, data: { effectivePrompt: result.prompt, progress: 3, errorCode: null, errorMessage: null } });
      await tx.jobStage.update({ where: { id: stageId }, data: active.count === 1 ? { status: "SUCCEEDED", outputJson: { effectivePrompt: result.prompt, upstream: result.response }, completedAt: new Date() } : { status: "CANCELLED", errorMessage: "任务已取消，增强结果未进入生成链路", completedAt: new Date() } });
    });
  } catch (error) {
    await failPromptEnhancementJob(jobId, stageId, mainReservationId, error);
  }
}

/** 提示增强失败时原路释放资金并写入阶段和主任务终态。 */
async function failPromptEnhancementJob(jobId: string, stageId: string, mainReservationId: string | null, error: unknown): Promise<void> {
  const message = errorMessage(error);
  const current = await database.inferenceJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!current || current.status === "CANCELLED") {
    await database.jobStage.update({ where: { id: stageId }, data: { status: "CANCELLED", errorMessage: "任务已取消", completedAt: new Date() } });
    return;
  }
  let released = false;
  if (mainReservationId) {
    try { await releaseMainBilling(mainReservationId, `release:${jobId}`, message); released = true; }
    catch (releaseError) { process.stderr.write(`提示增强任务 ${jobId} 退款同步异常：${errorMessage(releaseError)}\n`); }
  }
  await database.$transaction([
    database.jobStage.update({ where: { id: stageId }, data: { status: "FAILED", errorMessage: message, completedAt: new Date() } }),
    database.inferenceJob.update({ where: { id: jobId }, data: { status: "FAILED", progress: 100, errorCode: "prompt_enhancement_failed", errorMessage: message, completedAt: new Date() } }),
    database.billingReservationMirror.update({ where: { jobId }, data: { status: released ? "RELEASED" : "RESERVED", errorMessage: released ? null : "主站退款同步待补偿", lastSynchronizedAt: new Date() } }),
  ]);
  await releaseJobLeases(jobId);
}

/** 提交主站预留并把任务转为成功；提交失败保留产物并延迟重试。 */
async function finalizeSuccessfulJob(jobId: string, mainReservationId: string | null): Promise<void> {
  if (!mainReservationId) throw new Error("任务缺少主站资金预留 ID");
  try {
    await commitMainBilling(mainReservationId, `commit:${jobId}`);
    await database.$transaction([
      database.billingReservationMirror.update({
        where: { jobId },
        data: { status: "COMMITTED", lastSynchronizedAt: new Date(), errorMessage: null },
      }),
      database.inferenceJob.update({
        where: { id: jobId },
        data: { status: "SUCCEEDED", progress: 100, completedAt: new Date(), errorCode: null, errorMessage: null },
      }),
    ]);
    await releaseJobLeases(jobId);
    await ensureGalleryPublication(jobId);
  } catch (error) {
    await database.$transaction([
      database.billingReservationMirror.update({ where: { jobId }, data: { errorMessage: errorMessage(error), lastSynchronizedAt: new Date() } }),
      database.inferenceJob.update({ where: { id: jobId }, data: { status: "READY", progress: 95, errorCode: "billing_commit_pending", errorMessage: "产物已保存，正在同步主站计费状态" } }),
    ]);
    setTimeout(() => void queue.push(jobId).catch(() => undefined), 15000);
    await releaseJobLeases(jobId);
  }
}

/** 对选择入图库的成功任务执行幂等发布；发布异常只进入镜像补偿，不篡改生成和计费终态。 */
async function ensureGalleryPublication(jobId: string): Promise<void> {
  const job = await database.inferenceJob.findUnique({
    where: { id: jobId },
    include: { externalIdentity: true, modelVersion: true, artifacts: { orderBy: { createdAt: "asc" }, take: 1 }, galleryPublication: true },
  });
  const parameters = readJsonObject(job?.parameters);
  if (!job || parameters.publishToGallery !== true) return;
  const artifact = job.artifacts[0];
  if (!artifact || !artifact.width || !artifact.height) throw new Error("图库发布缺少完整生成产物");
  const mirror = job.galleryPublication ?? await database.galleryPublicationMirror.create({
    data: { jobId: job.id, artifactId: artifact.id, idempotencyKey: `publish:${job.id}:${artifact.sha256}`, status: "PENDING" },
  });
  if (mirror.status === "PUBLISHED") return;
  await database.galleryPublicationMirror.update({ where: { id: mirror.id }, data: { status: "PUBLISHING", errorMessage: null } });
  try {
    const publication = await publishMainGallery(job.id, {
      idempotencyKey: mirror.idempotencyKey,
      jobId: job.id,
      artifactId: artifact.id,
      walletOwnerType: job.source === "bot" ? "qq" : "user",
      userSubject: job.externalIdentity.subject,
      sha256: artifact.sha256,
      mimeType: artifact.mimeType,
      byteSize: Number(artifact.byteSize),
      width: artifact.width,
      height: artifact.height,
      isPrivate: parameters.isPrivate === true,
      effectivePrompt: job.effectivePrompt || job.requestedPrompt,
      negativePrompt: job.negativePrompt?.trim() || null,
      modelDisplayName: job.modelVersion.displayName,
      parameters,
    });
    await database.galleryPublicationMirror.update({
      where: { id: mirror.id },
      data: {
        status: publication.status.toUpperCase() as "PENDING" | "PUBLISHING" | "PUBLISHED" | "FAILED",
        mainPublicationId: publication.publicationId,
        mainGalleryItemId: publication.mainGalleryItemId,
        mediaUrl: publication.mediaUrl,
        lastSynchronizedAt: new Date(),
        errorMessage: null,
      },
    });
  } catch (error) {
    await database.galleryPublicationMirror.update({
      where: { id: mirror.id },
      data: { status: "FAILED", lastSynchronizedAt: new Date(), errorMessage: errorMessage(error) },
    });
  }
}

/** 生成失败后优先释放主站预留，再写任务失败终态；释放异常由补偿扫描继续处理。 */
async function failGeneratedJob(jobId: string, attemptId: string, mainReservationId: string | null, error: unknown): Promise<void> {
  const message = errorMessage(error);
  let released = false;
  if (mainReservationId) {
    try {
      await releaseMainBilling(mainReservationId, `release:${jobId}`, message);
      released = true;
    } catch (releaseError) {
      process.stderr.write(`任务 ${jobId} 退款同步异常：${errorMessage(releaseError)}\n`);
    }
  }
  await database.$transaction([
    database.inferenceAttempt.update({ where: { id: attemptId }, data: { status: "FAILED", errorCode: "runtime_failed", errorMessage: message, completedAt: new Date() } }),
    database.inferenceJob.update({ where: { id: jobId }, data: { status: "FAILED", progress: 100, errorCode: "runtime_failed", errorMessage: message, completedAt: new Date() } }),
    database.billingReservationMirror.update({
      where: { jobId },
      data: { status: released ? "RELEASED" : "RESERVED", errorMessage: released ? null : "主站退款同步待补偿", lastSynchronizedAt: new Date() },
    }),
  ]);
  await releaseJobLeases(jobId);
}

/** 对瞬时网络或上游 5xx 错误保留资金预留，释放 GPU 后交回调度器重试。 */
async function retryGeneratedJob(jobId: string, attemptId: string, attemptNumber: number, maxAttempts: number, error: unknown): Promise<void> {
  const message = errorMessage(error);
  await database.$transaction([
    database.inferenceAttempt.update({ where: { id: attemptId }, data: { status: "FAILED", errorCode: "runtime_retryable", errorMessage: message, completedAt: new Date() } }),
    database.inferenceJob.update({ where: { id: jobId }, data: { status: "READY", progress: 1, errorCode: "runtime_retrying", errorMessage: `第 ${attemptNumber}/${maxAttempts} 次执行遇到瞬时错误，正在重新调度：${message}` } }),
  ]);
  await releaseJobLeases(jobId);
}

/** 服务重启时把没有产物的运行中任务恢复为待执行，有产物任务恢复为资金提交。 */
async function recoverInterruptedJobs(): Promise<void> {
  // 本进程重启后把尚未固化结果的增强阶段恢复为待领取；任务级缓存键保持稳定。
  await database.jobStage.updateMany({ where: { stageType: "PROMPT_ENHANCEMENT", status: "RUNNING", job: { status: "READY", effectivePrompt: null } }, data: { status: "PENDING", errorMessage: "Worker 重启后恢复提示增强", startedAt: null } });
  const interrupted = await database.inferenceJob.findMany({
    where: { status: "RUNNING", billingReservation: { status: "RESERVED" } },
    include: { attempts: { where: { status: "RUNNING" }, orderBy: { attemptNumber: "desc" } } },
    take: 100,
  });
  for (const item of interrupted) {
    for (const attempt of item.attempts) {
      if (attempt.runtimeJobId) await cancelComfyPrompt(attempt.runtimeJobId).catch((error) => process.stderr.write(`任务 ${item.id} 旧 Runtime 队列取消异常：${errorMessage(error)}\n`));
    }
    await releaseJobLeases(item.id);
    await database.$transaction([
      database.inferenceAttempt.updateMany({ where: { jobId: item.id, status: "RUNNING" }, data: { status: "FAILED", errorCode: "worker_recovered", errorMessage: "Worker 重启后取消旧 Runtime 并重新调度", completedAt: new Date() } }),
      database.inferenceJob.update({ where: { id: item.id }, data: { status: "READY", errorCode: "worker_recovered", errorMessage: "Worker 重启后已恢复任务" } }),
    ]);
    await queue.push(item.id);
  }
}

/** 从 ComfyUI 队列删除重启前已提交但未完成的 Runtime，避免恢复任务重复出图。 */
async function cancelComfyPrompt(promptId: string): Promise<void> {
  const baseUrl = requiredEnvironment("COMFYUI_BASE_URL").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/queue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [promptId] }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`ComfyUI 队列取消失败：HTTP ${response.status}`);
}

/** 任务离开 GPU 执行阶段后幂等释放所有活动租约。 */
async function releaseJobLeases(jobId: string): Promise<void> {
  await database.gpuLease.updateMany({
    where: { jobId, status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] } },
    data: { status: "RELEASED", releasedAt: new Date() },
  });
}

/** 补偿失败任务中仍处于预留状态的资金，确保临时主站故障恢复后自动退款。 */
async function reconcileFailedReservations(): Promise<void> {
  const rows = await database.billingReservationMirror.findMany({
    where: { status: "RESERVED", job: { status: { in: ["FAILED", "CANCELLED"] } } },
    include: { job: true },
    orderBy: { updatedAt: "asc" },
    take: 10,
  });
  for (const row of rows) {
    if (!row.mainReservationId) continue;
    try {
      await releaseMainBilling(row.mainReservationId, `release:${row.jobId}`, row.job.errorMessage || "任务未完成");
      await database.billingReservationMirror.update({ where: { id: row.id }, data: { status: "RELEASED", errorMessage: null, lastSynchronizedAt: new Date() } });
    } catch (error) {
      await database.billingReservationMirror.update({ where: { id: row.id }, data: { errorMessage: errorMessage(error), lastSynchronizedAt: new Date() } });
    }
  }
}

/** 定期补偿成功任务中尚未发布或发布失败的正式图库镜像。 */
async function reconcileGalleryPublications(): Promise<void> {
  const jobs = await database.inferenceJob.findMany({
    where: {
      status: "SUCCEEDED",
      billingReservation: { status: "COMMITTED" },
      OR: [{ galleryPublication: null }, { galleryPublication: { status: { in: ["PENDING", "FAILED"] } } }],
    },
    orderBy: { updatedAt: "asc" },
    take: 5,
    select: { id: true, parameters: true },
  });
  for (const job of jobs) {
    if (readJsonObject(job.parameters).publishToGallery === true) await ensureGalleryPublication(job.id);
  }
}

/** 任务创建时固化的 LoRA 触发词快照，避免排队期间编辑条目改变最终请求。 */
interface TaskLoraSnapshot {
  strength?: number;
  triggerWords?: string[];
}

/** 从任务 JSON 读取经过 API 校验的推理参数。 */
function readParameters(value: unknown): { width: number; height: number; seed: number | null; loraVersionIds: string[]; loraStrengths: Record<string, number>; loraSnapshots: Record<string, TaskLoraSnapshot> } {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const loraSnapshots = Object.fromEntries((Array.isArray(data.loraSelections) ? data.loraSelections : []).flatMap((selection) => {
    if (!selection || typeof selection !== "object") return [];
    const row = selection as Record<string, unknown>;
    const id = typeof row.loraVersionId === "string" ? row.loraVersionId : "";
    if (!id) return [];
    const strength = typeof row.strength === "number" && Number.isFinite(row.strength) && row.strength >= 0 && row.strength <= 1.5 ? row.strength : undefined;
    const triggerWords = Array.isArray(row.triggerWords) ? row.triggerWords.filter((word): word is string => typeof word === "string" && word.trim().length > 0).map((word) => word.trim()).slice(0, 32) : undefined;
    return [[id, { strength, triggerWords } satisfies TaskLoraSnapshot]];
  })) as Record<string, TaskLoraSnapshot>;
  const explicitStrengths = data.loraStrengths && typeof data.loraStrengths === "object" && !Array.isArray(data.loraStrengths)
    ? Object.fromEntries(Object.entries(data.loraStrengths).flatMap(([id, strength]) => typeof strength === "number" && Number.isFinite(strength) && strength >= 0 && strength <= 1.5 ? [[id, strength]] : []))
    : {};
  // 主站旧请求只固化 loraSelections，新字段存在时仍以显式 loraStrengths 为最高优先级。
  const loraStrengths = { ...Object.fromEntries(Object.entries(loraSnapshots).flatMap(([id, snapshot]) => snapshot.strength === undefined ? [] : [[id, snapshot.strength]])), ...explicitStrengths };
  return { width: Number(data.width), height: Number(data.height), seed: data.seed === null ? null : Number(data.seed), loraVersionIds: Array.isArray(data.loraVersionIds) ? data.loraVersionIds.filter((item): item is string => typeof item === "string") : [], loraStrengths, loraSnapshots };
}

/** 把 Prisma JSON 读取为普通对象，供发布参数审计使用。 */
function readJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 从模型目录读取有界整数；缺失值交给 Runtime 使用兼容默认值。 */
function readBoundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

/** 从模型目录读取有界小数；缺失值交给 Runtime 使用兼容默认值。 */
function readBoundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

/** 从模型目录读取短字符串，阻止异常配置扩大 ComfyUI 请求。 */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 2000) : undefined;
}

/** 模型级最大尝试次数限制为 1 到 10，缺省三次。 */
function normalizeMaxAttempts(value: unknown): number {
  const parsed = Number(value ?? 3);
  return Number.isSafeInteger(parsed) ? Math.min(10, Math.max(1, parsed)) : 3;
}

/** 只重试网络中断、超时和上游 5xx，参数或工作流错误直接失败退款。 */
function isRetryableRuntimeError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return ["fetch failed", "timeout", "timed out", "econn", "socket", "terminated", "http 500", "http 502", "http 503", "http 504", "temporarily unavailable"].some((token) => message.includes(token));
}

/** 从独立对象存储解析任务 LoRA，并在提交工作流前按 SHA-256 同步到 ComfyUI。 */
async function resolveTaskLoras(versionIds: string[], strengths: Record<string, number>, snapshots: Record<string, TaskLoraSnapshot>): Promise<Array<{ fileName: string; strength: number; triggerWords: string[] }>> {
  if (versionIds.length === 0) return [];
  const versions = await database.loraVersion.findMany({ where: { id: { in: versionIds }, status: "ACTIVE", loraEntry: { status: "ACTIVE" } }, include: { loraEntry: { select: { type: true, triggerWords: true } } } });
  const map = new Map(versions.map((version) => [version.id, version]));
  const result: Array<{ fileName: string; strength: number; triggerWords: string[] }> = [];
  for (const versionId of versionIds) {
    const version = map.get(versionId);
    if (!version) throw new Error("任务 LoRA 文件版本已经不可用");
    // GPU 同步扩展只接受以内容哈希命名的受控文件名，禁止把用户上传文件名直接传入 GPU 主机。
    const gpuFileName = buildGpuLoraFileName(version.sha256);
    await ensureComfyLora(version.objectKey, gpuFileName, version.sha256, Number(version.byteSize));
    result.push({ fileName: gpuFileName, strength: normalizeRuntimeLoraStrength(strengths[versionId], version.loraEntry.type), triggerWords: snapshots[versionId]?.triggerWords ?? readRuntimeTriggerWords(version.loraEntry.triggerWords) });
  }
  return result;
}

/** 为旧任务补齐与 API 相同的类型默认强度，新任务优先使用用户固化的自定义值。 */
function normalizeRuntimeLoraStrength(value: unknown, type: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1.5) return Math.round(numeric * 100) / 100;
  return ({ CHARACTER: 1, STYLE: 0.85, CONCEPT: 0.8, CLOTHING: 0.85, POSE: 0.7, OTHER: 0.8 } as Record<string, number>)[type] ?? 0.8;
}

/** 把选中 LoRA 的触发词一次性追加到实际 Runtime 提示词，已有词不会重复。 */
function appendLoraTriggerWords(prompt: string, loras: Array<{ triggerWords: string[] }>): string {
  const existing = prompt.toLowerCase();
  const missing = [...new Set(loras.flatMap((lora) => lora.triggerWords.map((word) => word.trim()).filter(Boolean)))].filter((word) => !existing.includes(word.toLowerCase()));
  return missing.length > 0 ? `${prompt.trim()}, ${missing.join(", ")}` : prompt.trim();
}

/** 从 LoRA 条目 JSON 安全读取触发词，限制长度避免异常训练元数据扩大请求。 */
function readRuntimeTriggerWords(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 32) : [];
}

/** 按 GPU 扩展登记的规则生成稳定 LoRA 文件名，确保同步路径与工作流引用完全一致。 */
function buildGpuLoraFileName(sha256: string): string {
  const normalized = sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("任务 LoRA 文件哈希不正确");
  return `aiimage_lora_${normalized}.safetensors`;
}

/** 检查并同步一个 LoRA 到受保护的 ComfyUI 扩展端点。 */
async function ensureComfyLora(objectKey: string, fileName: string, sha256: string, sizeBytes: number): Promise<void> {
  const baseUrl = requiredEnvironment("COMFYUI_BASE_URL").replace(/\/$/, "");
  const token = requiredEnvironment("COMFYUI_SERVICE_TOKEN");
  const url = `${baseUrl}/aiimage/loras/${encodeURIComponent(fileName)}`;
  const status = await readComfyLoraStatus(url, token);
  if (status.status === 200) {
    if (status.data?.sha256 === sha256 && Number(status.data.sizeBytes) === sizeBytes) return;
  } else if (status.status !== 404) {
    throw new Error(`ComfyUI LoRA 检查失败：HTTP ${status.status}`);
  }
  const object = await getObjectBuffer(objectKey);
  if (object.body.length !== sizeBytes || createHash("sha256").update(object.body).digest("hex") !== sha256) throw new Error("独立对象存储 LoRA 校验失败");
  try {
    const uploaded = await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": String(sizeBytes), "x-service-token": token, "x-aiimage-sha256": sha256 }, body: new Blob([new Uint8Array(object.body)]) });
    const result = await uploaded.json().catch(() => null) as { ok?: boolean; sha256?: string; sizeBytes?: number; message?: string } | null;
    if (!uploaded.ok || result?.ok !== true || result.sha256 !== sha256 || Number(result.sizeBytes) !== sizeBytes) throw new Error(result?.message || `ComfyUI LoRA 同步失败：HTTP ${uploaded.status}`);
  } catch (error) {
    // 大文件已完整写入但响应连接被中途关闭时，必须按 GPU 端最终 SHA-256 判定成功，避免错误退款。
    const verified = await readComfyLoraStatus(url, token).catch(() => null);
    if (verified?.data?.sha256 !== sha256 || Number(verified.data.sizeBytes) !== sizeBytes) throw error;
  }
}

/** 短状态请求最多重试三次；只限制单次网络读取，不限制 LoRA 上传或模型生成总时长。 */
async function readComfyLoraStatus(url: string, token: string): Promise<{ status: number; data: { sha256?: string; sizeBytes?: number } | null }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "x-service-token": token }, signal: AbortSignal.timeout(30000) });
      return { status: response.status, data: response.ok ? await response.json().catch(() => null) as { sha256?: string; sizeBytes?: number } | null : null };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 500);
    }
  }
  throw lastError;
}

/** 读取必填运行配置。 */
function requiredEnvironment(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`缺少必填配置：${key}`);
  return value;
}

/** 把内部异常限制为可持久化摘要。 */
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** Worker 异常退避。 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
