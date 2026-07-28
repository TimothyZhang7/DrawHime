/**
 * 本文件实现真实 Anima LoRA 训练消费者，负责 GPU Runtime、产物校验、LoRA 草稿与主站计费终态。
 */
import { Prisma } from "@prisma/client";
import { trainingRuntimeJobViewSchema, trainingRuntimeSubmitRequestSchema, type TrainingRuntimeJobView, type TrainingRuntimeSubmitRequest } from "@drawhime/contracts";
import { database } from "@drawhime/database";
import { commitMainBilling, releaseMainBilling } from "@drawhime/main-platform-client";
import { createConfigCheck, createDatabaseCheck, createObjectStorageCheck, createRedisCheck, putObjectBuffer, startService, TrainingQueue } from "@drawhime/service-runtime";
import { createHash } from "node:crypto";
import { runCaptionWorker } from "./caption-worker.js";

const queue = new TrainingQueue();
let stopping = false;

startService({
  name: "training-worker",
  port: Number(process.env.LOCAL_TRAINING_WORKER_PORT || 7112),
  checks: [createDatabaseCheck(), createRedisCheck(), createObjectStorageCheck(), createConfigCheck("training-runtime", ["TRAINING_RUNTIME_BASE_URL", "TRAINING_RUNTIME_TOKEN", "LOCAL_PUBLIC_API_BASE_URL", "MAIN_PLATFORM_INTERNAL_URL", "MAIN_PLATFORM_CLIENT_SECRET", "PROMPT_ASSIST_BASE_URL", "PROMPT_ASSIST_API_KEY", "PROMPT_ASSIST_MODEL"])],
});

void runWorker();
void runCaptionWorker(() => stopping);
process.on("SIGINT", () => { stopping = true; void queue.close(); });
process.on("SIGTERM", () => { stopping = true; void queue.close(); });

/** 持续处理训练任务并恢复进程中断留下的运行状态。 */
async function runWorker(): Promise<void> {
  await recoverInterruptedTrainingJobs();
  while (!stopping) {
    try { const jobId = await queue.pop(5); if (jobId) await processTrainingJob(jobId); else await reconcileFailedTrainingBilling(); }
    catch (error) { process.stderr.write(`训练 Worker 异常：${errorMessage(error)}\n`); await sleep(2000); }
  }
}

/** 执行一次训练尝试，训练产物存在时只重放计费提交。 */
async function processTrainingJob(jobId: string): Promise<void> {
  const job = await database.trainingJob.findUnique({ where: { id: jobId }, include: { externalIdentity: true, dataset: { include: { assets: { include: { artifact: true }, orderBy: { createdAt: "asc" } } } }, baseModelVersion: { include: { family: true } }, outputLoraVersion: true, billingReservation: true, leases: { where: { status: { in: ["OFFERED", "ACCEPTED"] } }, orderBy: { offeredAt: "desc" }, take: 1 }, attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } } });
  if (!job || !["READY", "EVALUATING"].includes(job.status) || job.billingReservation?.status !== "RESERVED") return;
  if (job.outputLoraVersionId) return finalizeTrainingJob(job.id, job.billingReservation.mainReservationId);
  const lease = job.leases[0]; if (!lease || lease.expiresAt <= new Date()) return;
  const parameters = readParameters(job.parameters);
  const attemptNumber = (job.attempts[0]?.attemptNumber ?? 0) + 1;
  const attempt = await database.$transaction(async (tx) => {
    const claimed = await tx.trainingJob.updateMany({ where: { id: job.id, status: "READY" }, data: { status: "RUNNING", progress: 2, startedAt: job.startedAt ?? new Date(), errorCode: null, errorMessage: null } });
    if (claimed.count !== 1) return null;
    await tx.trainingGpuLease.update({ where: { id: lease.id }, data: { status: "RUNNING", acceptedAt: new Date(), expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } });
    return tx.trainingAttempt.create({ data: { trainingJobId: job.id, attemptNumber, status: "RUNNING", startedAt: new Date() } });
  });
  if (!attempt) return;
  await executeTrainingAttempt(job.id, attempt.id, attemptNumber, lease.id);
}

/** 执行或恢复同一个幂等训练尝试，Worker 重启不会取消已完成的 GPU 产物。 */
async function executeTrainingAttempt(jobId: string, attemptId: string, attemptNumber: number, leaseId: string): Promise<void> {
  const job = await database.trainingJob.findUnique({ where: { id: jobId }, include: { externalIdentity: true, dataset: { include: { assets: { include: { artifact: true }, orderBy: { createdAt: "asc" } } } }, baseModelVersion: { include: { family: true } }, outputLoraVersion: true, billingReservation: true } });
  if (!job || job.status !== "RUNNING" || job.billingReservation?.status !== "RESERVED") return;
  if (job.outputLoraVersionId) return finalizeTrainingJob(job.id, job.billingReservation.mainReservationId);
  const parameters = readParameters(job.parameters);
  try {
    const publicBase = requiredEnvironment("LOCAL_PUBLIC_API_BASE_URL").replace(/\/$/, "");
    const triggerWords = parameters.triggerWords.length ? parameters.triggerWords : [normalizeSlug(job.title)];
    const runtimeInput = trainingRuntimeSubmitRequestSchema.parse({
      jobId: attemptId,
      baseModelFile: job.baseModelVersion.version,
      textEncoderFile: "qwen_3_06b_base.safetensors",
      vaeFile: "qwen_image_vae.safetensors",
      outputName: `drawhime_${job.id.replace(/-/g, "_")}_v1`,
      dataset: job.dataset.assets.map((asset) => ({ url: `${publicBase}/internal/training/assets/${asset.artifactId}/content`, caption: asset.caption?.trim() || triggerWords.join(", "), sha256: asset.artifact.sha256 })),
      parameters: {
        rank: parameters.rank,
        alpha: parameters.alpha,
        epochs: parameters.epochs,
        repeats: parameters.repeats,
        learningRate: parameters.learningRate,
        resolution: parameters.resolution,
        lrScheduler: parameters.lrScheduler,
        warmupRatio: parameters.warmupRatio,
        gradientAccumulationSteps: parameters.gradientAccumulationSteps,
        captionDropoutRate: parameters.captionDropoutRate,
        shuffleCaption: parameters.shuffleCaption,
        keepTokens: parameters.keepTokens,
        seed: parameters.seed,
        samplePrompt: parameters.samplePrompt,
      },
    });
    await database.trainingAttempt.update({ where: { id: attemptId }, data: { runtimeJobId: attemptId, metrics: { submittedParameters: runtimeInput.parameters } } });
    let runtime = await reconnectRuntimeCall("提交训练", job.id, leaseId, () => submitRuntimeTraining(runtimeInput));
    if (!runtime) return;
    while (["queued", "running"].includes(runtime.status)) {
      if (stopping) return;
      await sleep(5000);
      const current = await reconnectRuntimeCall("查询训练状态", job.id, leaseId, () => getRuntimeTraining(attemptId));
      if (!current) return;
      runtime = current;
      await database.$transaction([
        database.trainingJob.update({ where: { id: job.id }, data: { progress: Math.max(2, Math.min(94, runtime.progress)), errorCode: null, errorMessage: null } }),
        database.trainingAttempt.update({ where: { id: attemptId }, data: { metrics: runtime.metrics as Prisma.InputJsonObject } }),
        database.trainingGpuLease.update({ where: { id: leaseId }, data: { expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } }),
      ]);
    }
    if (runtime.status !== "succeeded") throw new Error(runtime.errorMessage || `训练 Runtime 状态：${runtime.status}`);
    const output = await downloadRuntimeOutput(attemptId, runtime, job.id, leaseId);
    if (!output) return;
    validateSafetensors(output.buffer);
    const objectKey = `trained-loras/${job.externalIdentityId}/${job.id}/v1.safetensors`;
    await putObjectBuffer(objectKey, output.buffer, "application/octet-stream");
    const entry = await database.loraEntry.upsert({ where: { slug: `trained-${job.id}` }, update: {}, create: { ownerIdentityId: job.externalIdentityId, modelFamilyId: job.baseModelVersion.familyId, slug: `trained-${job.id}`, title: job.title, description: `由数据集“${job.dataset.title}”训练生成的 Anima LoRA，发布前请补充示例图。`, type: "OTHER", triggerWords, status: "DISABLED" } });
    const version = await database.loraVersion.upsert({ where: { loraEntryId_version: { loraEntryId: entry.id, version: "1.0.0" } }, update: {}, create: { loraEntryId: entry.id, version: "1.0.0", objectKey, fileName: `${normalizeSlug(job.title)}.safetensors`, sha256: output.sha256, byteSize: BigInt(output.buffer.length), metadata: { trainingJobId: job.id, runtimeJobId: attemptId, parameters } } });
    await database.$transaction([
      database.trainingAttempt.update({ where: { id: attemptId }, data: { status: "SUCCEEDED", metrics: runtime.metrics as Prisma.InputJsonObject, completedAt: new Date() } }),
      database.trainingJob.update({ where: { id: job.id }, data: { status: "EVALUATING", progress: 98, outputLoraVersionId: version.id, errorCode: null, errorMessage: null } }),
    ]);
    await finalizeTrainingJob(job.id, job.billingReservation.mainReservationId);
  } catch (error) {
    if (attemptNumber < parameters.maxAttempts) await retryTrainingJob(job.id, attemptId, leaseId, error);
    else await failTrainingJob(job.id, attemptId, leaseId, job.billingReservation.mainReservationId, error);
  }
}

/** 训练成功产物保存后提交主站预留，提交不确定时保留产物重试。 */
async function finalizeTrainingJob(jobId: string, reservationId: string | null): Promise<void> {
  if (!reservationId) throw new Error("训练任务缺少主站资金预留 ID");
  try {
    await commitMainBilling(reservationId, `train-commit:${jobId}`);
    await database.$transaction([
      database.trainingBillingReservationMirror.update({ where: { trainingJobId: jobId }, data: { status: "COMMITTED", lastSynchronizedAt: new Date(), errorMessage: null } }),
      database.trainingJob.update({ where: { id: jobId }, data: { status: "SUCCEEDED", progress: 100, completedAt: new Date(), errorCode: null, errorMessage: null } }),
      database.trainingGpuLease.updateMany({ where: { trainingJobId: jobId, status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] } }, data: { status: "RELEASED", releasedAt: new Date() } }),
    ]);
  } catch (error) {
    await database.trainingJob.update({ where: { id: jobId }, data: { status: "EVALUATING", progress: 99, errorCode: "training_billing_commit_pending", errorMessage: "LoRA 已保存，正在同步主站计费状态" } });
    setTimeout(() => void queue.push(jobId).catch(() => undefined), 15000);
  }
}

/** 重试失败尝试并释放当前租约，由调度器重新分配空闲 GPU。 */
async function retryTrainingJob(jobId: string, attemptId: string, leaseId: string, error: unknown): Promise<void> {
  await database.$transaction([
    database.trainingAttempt.update({ where: { id: attemptId }, data: { status: "FAILED", errorMessage: errorMessage(error), completedAt: new Date() } }),
    database.trainingJob.update({ where: { id: jobId }, data: { status: "READY", progress: 1, errorCode: "training_retry_pending", errorMessage: errorMessage(error) } }),
    database.trainingGpuLease.update({ where: { id: leaseId }, data: { status: "RELEASED", releasedAt: new Date() } }),
  ]);
}

/** 训练达到最大尝试次数时原路释放主站资金并写入失败终态。 */
async function failTrainingJob(jobId: string, attemptId: string, leaseId: string, reservationId: string | null, error: unknown): Promise<void> {
  const message = errorMessage(error);
  let released = false;
  if (reservationId) {
    try { await releaseMainBilling(reservationId, `train-release:${jobId}`, message); released = true; }
    catch (releaseError) { await database.trainingBillingReservationMirror.update({ where: { trainingJobId: jobId }, data: { errorMessage: errorMessage(releaseError), lastSynchronizedAt: new Date() } }); }
  }
  await database.$transaction([
    database.trainingAttempt.update({ where: { id: attemptId }, data: { status: "FAILED", errorMessage: message, completedAt: new Date() } }),
    database.trainingJob.update({ where: { id: jobId }, data: { status: "FAILED", progress: 100, errorCode: "training_failed", errorMessage: message, completedAt: new Date() } }),
    database.trainingBillingReservationMirror.update({ where: { trainingJobId: jobId }, data: released ? { status: "RELEASED", lastSynchronizedAt: new Date(), errorMessage: null } : { status: "RESERVED", lastSynchronizedAt: new Date() } }),
    database.trainingGpuLease.update({ where: { id: leaseId }, data: { status: "RELEASED", releasedAt: new Date() } }),
  ]);
}

/** Worker 重启后恢复原 Runtime 尝试和租约，避免重复训练或丢弃已生成产物。 */
async function recoverInterruptedTrainingJobs(): Promise<void> {
  const rows = await database.trainingJob.findMany({ where: { status: "RUNNING" }, include: { attempts: { where: { status: "RUNNING" }, orderBy: { attemptNumber: "desc" }, take: 1 }, leases: { where: { status: "RUNNING" }, orderBy: { offeredAt: "desc" }, take: 1 } } });
  for (const row of rows) {
    const attempt = row.attempts[0];
    const lease = row.leases[0];
    if (attempt?.runtimeJobId && lease) await executeTrainingAttempt(row.id, attempt.id, attempt.attemptNumber, lease.id);
  }
}

/** 补偿失败任务尚未确认的主站退款，不把网络不确定状态误写为已释放。 */
async function reconcileFailedTrainingBilling(): Promise<void> {
  const rows = await database.trainingBillingReservationMirror.findMany({ where: { status: "RESERVED", trainingJob: { status: { in: ["FAILED", "CANCELLED"] } }, mainReservationId: { not: null } }, take: 20 });
  for (const row of rows) {
    try { await releaseMainBilling(row.mainReservationId!, `train-release:${row.trainingJobId}`, row.errorMessage || "训练任务未成功"); await database.trainingBillingReservationMirror.update({ where: { id: row.id }, data: { status: "RELEASED", errorMessage: null, lastSynchronizedAt: new Date() } }); }
    catch (error) { await database.trainingBillingReservationMirror.update({ where: { id: row.id }, data: { errorMessage: errorMessage(error), lastSynchronizedAt: new Date() } }); }
  }
}

async function submitRuntimeTraining(input: TrainingRuntimeSubmitRequest): Promise<TrainingRuntimeJobView> { return runtimeJson("/v1/training/jobs", { method: "POST", body: JSON.stringify(input) }); }
async function getRuntimeTraining(id: string): Promise<TrainingRuntimeJobView> { return runtimeJson(`/v1/training/jobs/${encodeURIComponent(id)}`); }
async function cancelRuntimeTraining(id: string): Promise<TrainingRuntimeJobView> { return runtimeJson(`/v1/training/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }); }
/** 对已幂等的 Runtime 请求持续重连，状态不确定时保持原尝试和 GPU 租约，禁止创建并发重复训练。 */
async function reconnectRuntimeCall(label: string, jobId: string, leaseId: string, request: () => Promise<TrainingRuntimeJobView>): Promise<TrainingRuntimeJobView | null> {
  let failures = 0;
  while (!stopping) {
    try { return await request(); }
    catch (error) {
      if (!isTemporaryRuntimeError(error)) throw error;
      failures += 1;
      const message = `${label}暂时失败，正在保持当前训练并重连（第 ${failures} 次）：${errorMessage(error)}`;
      await database.$transaction([
        database.trainingJob.update({ where: { id: jobId }, data: { errorCode: "training_runtime_reconnecting", errorMessage: message } }),
        database.trainingGpuLease.update({ where: { id: leaseId }, data: { expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } }),
      ]);
      await sleep(Math.min(30_000, 3000 + failures * 2000));
    }
  }
  return null;
}
async function runtimeJson(path: string, init: RequestInit = {}): Promise<TrainingRuntimeJobView> {
  let response: Response;
  try { response = await fetch(`${requiredEnvironment("TRAINING_RUNTIME_BASE_URL").replace(/\/$/, "")}${path}`, { ...init, headers: { "content-type": "application/json", "x-training-runtime-token": requiredEnvironment("TRAINING_RUNTIME_TOKEN"), ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) }); }
  catch (error) { throw new TrainingRuntimeRequestError(errorMessage(error), true); }
  let payload: { ok?: boolean; data?: unknown; message?: string };
  try { payload = await response.json() as typeof payload; }
  // Runtime 请求均以尝试 ID 幂等；HTTP 200 响应若被网络截断，应保持原尝试重连，禁止误退款后重复启动训练。
  catch { throw new TrainingRuntimeRequestError(`训练 Runtime HTTP ${response.status} 返回了无效 JSON`, true); }
  if (!response.ok || payload.ok !== true) {
    const message = payload.message || `训练 Runtime HTTP ${response.status}`;
    const temporary = response.status >= 500 || [408, 409, 425, 429].includes(response.status) || message.includes("当前已有训练任务运行");
    throw new TrainingRuntimeRequestError(message, temporary);
  }
  return trainingRuntimeJobViewSchema.parse(payload.data);
}
/** 以可恢复小分片下载训练产物；单片失败只重传当前分片，不会重新训练。 */
async function downloadRuntimeOutput(id: string, runtime: TrainingRuntimeJobView, jobId: string, leaseId: string): Promise<{ buffer: Buffer; sha256: string } | null> {
  const totalBytes = runtime.outputBytes ?? 0;
  if (totalBytes <= 0 || !runtime.outputSha256) throw new Error("训练 Runtime 未返回产物完整性信息");
  if (totalBytes > 512 * 1024 * 1024) throw new Error("训练产物超过 512MB 限制");
  const configuredChunkBytes = Number(process.env.TRAINING_OUTPUT_CHUNK_BYTES || 64 * 1024);
  const chunkBytes = Number.isSafeInteger(configuredChunkBytes) ? Math.max(16 * 1024, Math.min(4 * 1024 * 1024, configuredChunkBytes)) : 64 * 1024;
  const configuredConcurrency = Number(process.env.TRAINING_OUTPUT_CONCURRENCY || 8);
  const concurrency = Number.isSafeInteger(configuredConcurrency) ? Math.max(1, Math.min(16, configuredConcurrency)) : 8;
  const buffer = Buffer.allocUnsafe(totalBytes);
  const baseUrl = requiredEnvironment("TRAINING_RUNTIME_BASE_URL").replace(/\/$/, "");
  const starts = Array.from({ length: Math.ceil(totalBytes / chunkBytes) }, (_, index) => index * chunkBytes);
  let nextIndex = 0;
  let completedBytes = 0;
  let persistedProgress = 94;
  let lastReconnectPersistedAt = 0;
  /** 多路并发只领取不同分片；失败分片在原位置持续重试，避免整文件重传。 */
  async function runDownloadLane(): Promise<void> {
    while (!stopping) {
      const index = nextIndex++;
      if (index >= starts.length) return;
      const start = starts[index];
      const end = Math.min(totalBytes - 1, start + chunkBytes - 1);
      while (!stopping) {
        try {
          const response = await fetch(`${baseUrl}/v1/training/jobs/${encodeURIComponent(id)}/output`, { headers: { "x-training-runtime-token": requiredEnvironment("TRAINING_RUNTIME_TOKEN"), range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(30_000) });
          const expectedRange = `bytes ${start}-${end}/${totalBytes}`;
          if (response.status !== 206) {
            const temporary = response.status === 200 || response.status >= 500 || [408, 409, 425, 429].includes(response.status);
            throw new TrainingRuntimeRequestError(`训练产物分片响应不正确：HTTP ${response.status}`, temporary);
          }
          if (response.headers.get("content-range") !== expectedRange) throw new TrainingRuntimeRequestError("训练产物 Content-Range 不正确", true);
          const chunk = Buffer.from(await response.arrayBuffer());
          if (chunk.length !== end - start + 1) throw new TrainingRuntimeRequestError("训练产物分片长度不正确", true);
          chunk.copy(buffer, start);
          completedBytes += chunk.length;
          const progress = Math.max(94, Math.min(97, 94 + Math.floor(completedBytes / totalBytes * 4)));
          if (progress > persistedProgress) {
            persistedProgress = progress;
            await database.$transaction([
              database.trainingJob.update({ where: { id: jobId }, data: { progress, errorCode: null, errorMessage: null } }),
              database.trainingGpuLease.update({ where: { id: leaseId }, data: { expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } }),
            ]);
          }
          break;
        } catch (error) {
          if (!(error instanceof TrainingRuntimeRequestError && error.temporary) && !isTemporaryNetworkFailure(error)) throw error;
          if (Date.now() - lastReconnectPersistedAt >= 3000) {
            lastReconnectPersistedAt = Date.now();
            await database.$transaction([
              database.trainingJob.update({ where: { id: jobId }, data: { errorCode: "training_output_reconnecting", errorMessage: `训练产物分片 ${start}-${end} 暂时失败，正在从断点重传：${errorMessage(error)}` } }),
              database.trainingGpuLease.update({ where: { id: leaseId }, data: { expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } }),
            ]);
          }
          await sleep(1000);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, () => runDownloadLane()));
  if (stopping) return null;
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (runtime.outputSha256 !== sha256) throw new Error("训练产物 SHA-256 完整性校验失败");
  return { buffer, sha256 };
}
function validateSafetensors(buffer: Buffer): void { if (buffer.length < 16) throw new Error("训练产物不是有效 safetensors"); const headerSize = Number(buffer.readBigUInt64LE(0)); if (!Number.isSafeInteger(headerSize) || headerSize < 2 || headerSize + 8 >= buffer.length || headerSize > 16 * 1024 * 1024) throw new Error("训练产物 safetensors 文件头不正确"); JSON.parse(buffer.subarray(8, 8 + headerSize).toString("utf8")); }
function readParameters(value: unknown) { const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; return { rank: Number(item.rank), alpha: Number(item.alpha), epochs: Number(item.epochs), repeats: Number(item.repeats), learningRate: Number(item.learningRate), resolution: Number(item.resolution), lrScheduler: String(item.lrScheduler || "constant") as "constant" | "cosine" | "cosine_with_restarts", warmupRatio: Number(item.warmupRatio || 0), gradientAccumulationSteps: Number(item.gradientAccumulationSteps || 1), captionDropoutRate: Number(item.captionDropoutRate || 0), shuffleCaption: item.shuffleCaption === true, keepTokens: Number(item.keepTokens || 0), seed: Number(item.seed), maxAttempts: Number(item.maxAttempts || 2), samplePrompt: String(item.samplePrompt || ""), triggerWords: Array.isArray(item.triggerWords) ? item.triggerWords.filter((entry): entry is string => typeof entry === "string") : [], productCode: String(item.productCode || ""), pricingVersion: Number(item.pricingVersion || 0) }; }
function normalizeSlug(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "trained-lora"; }
function requiredEnvironment(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} 未配置`); return value; }
function isTemporaryRuntimeError(error: unknown): boolean { return error instanceof TrainingRuntimeRequestError && error.temporary; }
function isTemporaryNetworkFailure(error: unknown): boolean { return error instanceof TypeError || error instanceof DOMException || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)); }
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/** 标记 Runtime 请求是否可在同一幂等尝试内重连。 */
class TrainingRuntimeRequestError extends Error {
  constructor(message: string, readonly temporary: boolean) { super(message); this.name = "TrainingRuntimeRequestError"; }
}
