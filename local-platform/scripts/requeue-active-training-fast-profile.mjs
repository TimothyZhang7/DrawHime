/**
 * 本脚本把生产中的活动 LoRA 训练安全迁移到半小时快速参数，并为每个原身份重新建立独立计费预留。
 */
import { PrismaClient } from "@prisma/client";
import { resolveTrainingCycles } from "@drawhime/contracts";

const database = new PrismaClient();
const applyChanges = process.argv.includes("--apply");
const profileVersion = 2;
const activeStatuses = ["RESERVING", "READY", "RUNNING", "EVALUATING"];

try {
  const jobs = await database.trainingJob.findMany({
    where: { status: { in: activeStatuses }, deletedAt: null },
    include: {
      externalIdentity: true,
      dataset: { select: { _count: { select: { assets: true } } } },
      baseModelVersion: true,
      billingReservation: true,
      attempts: { where: { status: "RUNNING" }, orderBy: { attemptNumber: "desc" }, take: 1 },
    },
    orderBy: { queuedAt: "asc" },
  });
  const candidates = jobs.filter((job) => readObject(job.parameters).fastProfileVersion !== profileVersion && !readObject(job.parameters).requeuedFromJobId);
  console.log(JSON.stringify({ mode: applyChanges ? "apply" : "dry-run", candidateCount: candidates.length, jobs: candidates.map(summarizeMigration) }, null, 2));
  if (!applyChanges) process.exit(0);

  for (const job of candidates) await migrateJob(job);
  console.log(JSON.stringify({ migratedCount: candidates.length, profile: "anima-p40-stable-v2" }));
} finally {
  await database.$disconnect();
}

/** 迁移单个任务，旧任务只进入取消终态，归属、数据集、底模和触发词全部复制到新任务。 */
async function migrateJob(job) {
  const oldParameters = readObject(job.parameters);
  const fastParameters = createFastParameters(oldParameters, job.dataset._count.assets, job.id, job.baseModelVersion.defaultParameters);
  const activeAttempt = job.attempts[0];
  if (activeAttempt?.runtimeJobId) await cancelRuntimeJob(activeAttempt.runtimeJobId);

  if (job.billingReservation?.status === "RESERVED" && job.billingReservation.mainReservationId) {
    await mainRequest(`/internal/integrations/local-model/billing/reservations/${encodeURIComponent(job.billingReservation.mainReservationId)}/release`, {
      idempotencyKey: `train-fast-release:${job.id}:v${profileVersion}`,
      reason: "训练任务迁移到半小时快速参数",
    });
  }

  const replacementKey = `train-fast-requeue:${job.id}:v${profileVersion}`;
  const replacement = await database.$transaction(async (tx) => {
    const existing = await tx.trainingJob.findUnique({ where: { idempotencyKey: replacementKey } });
    if (existing) return existing;
    const created = await tx.trainingJob.create({
      data: {
        externalIdentityId: job.externalIdentityId,
        datasetId: job.datasetId,
        baseModelVersionId: job.baseModelVersionId,
        idempotencyKey: replacementKey,
        title: job.title,
        status: "RESERVING",
        progress: 0,
        parameters: fastParameters,
        queuedAt: job.queuedAt,
      },
    });
    await tx.trainingBillingReservationMirror.create({
      data: {
        trainingJobId: created.id,
        idempotencyKey: `train-fast-reserve:${job.id}:v${profileVersion}`,
        priceVersion: `${fastParameters.productCode}@${fastParameters.pricingVersion}`,
        amountMinor: BigInt(Math.round(Number(fastParameters.estimatedPriceCny) * 100)),
        currency: "CNY",
        status: "PENDING",
      },
    });
    await tx.trainingAttempt.updateMany({ where: { trainingJobId: job.id, status: "RUNNING" }, data: { status: "CANCELLED", errorMessage: "已迁移到半小时快速训练任务", completedAt: new Date() } });
    await tx.trainingGpuLease.updateMany({ where: { trainingJobId: job.id, status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] } }, data: { status: "RELEASED", releasedAt: new Date() } });
    await tx.trainingBillingReservationMirror.update({ where: { trainingJobId: job.id }, data: { status: "RELEASED", lastSynchronizedAt: new Date(), errorMessage: null } });
    await tx.trainingJob.update({ where: { id: job.id }, data: { status: "CANCELLED", progress: 100, completedAt: new Date(), errorCode: "requeued_with_fast_profile", errorMessage: `已迁移到快速训练任务 ${created.id}` } });
    return created;
  });

  const reservation = await mainRequest("/internal/integrations/local-model/billing/reservations", {
    externalTaskId: replacement.id,
    idempotencyKey: `train-fast-reserve:${job.id}:v${profileVersion}`,
    userSubject: job.externalIdentity.subject,
    walletOwnerType: "user",
    productCode: fastParameters.productCode,
    pricingVersion: fastParameters.pricingVersion,
    quantity: fastParameters.pricingUnits,
  });
  await database.$transaction([
    database.trainingBillingReservationMirror.update({ where: { trainingJobId: replacement.id }, data: { mainReservationId: reservation.reservationId, amountMinor: BigInt(Math.round(Number(reservation.reservedAmount) * 100)), status: "RESERVED", expiresAt: reservation.expiresAt ? new Date(reservation.expiresAt) : null, lastSynchronizedAt: new Date(), errorMessage: null } }),
    database.trainingJob.update({ where: { id: replacement.id }, data: { status: "READY", progress: 1, errorCode: null, errorMessage: null } }),
  ]);
}

/** 根据图片数把总遍历量提高到至少 320，保留用户归属、触发词、底模和计费版本。 */
function createFastParameters(parameters, assetCount, sourceJobId, modelDefaultsValue) {
  const modelDefaults = readObject(modelDefaultsValue);
  const { epochs, repeats } = resolveTrainingCycles(Math.max(5, assetCount), 320);
  const rank = Number(parameters.rank);
  const imagePasses = assetCount * epochs * repeats;
  const workload = imagePasses * Math.pow(768 / 1024, 2) * (0.75 + rank / 64);
  const pricingUnits = Math.max(1, Math.min(32, Math.ceil(workload / 800)));
  const unitPrice = Number(modelDefaults.trainingPriceCny || parameters.estimatedPriceCny || 0.8);
  return {
    ...parameters,
    epochs,
    repeats,
    resolution: 768,
    learningRate: 0.0001,
    lrScheduler: "constant",
    warmupRatio: 0,
    gradientAccumulationSteps: 1,
    captionDropoutRate: 0,
    shuffleCaption: false,
    keepTokens: 1,
    maxAttempts: 2,
    pricingUnits,
    estimatedPriceCny: (unitPrice * pricingUnits).toFixed(2),
    fastProfileVersion: profileVersion,
    runtimeProfile: "anima-p40-stable-v2",
    targetImagePasses: imagePasses,
    requeuedFromJobId: sourceJobId,
  };
}

/** 输出脱敏后的迁移摘要，不打印用户提示词、图片、Caption 或服务凭证。 */
function summarizeMigration(job) {
  const oldParameters = readObject(job.parameters);
  const next = createFastParameters(oldParameters, job.dataset._count.assets, job.id, job.baseModelVersion.defaultParameters);
  return { jobId: job.id, ownerIdentityId: job.externalIdentityId, status: job.status, assetCount: job.dataset._count.assets, old: pickParameters(oldParameters), next: pickParameters(next) };
}

/** 仅保留训练性能与计费核验所需参数。 */
function pickParameters(parameters) {
  return Object.fromEntries(["rank", "alpha", "epochs", "repeats", "resolution", "shuffleCaption", "pricingUnits", "estimatedPriceCny", "targetImagePasses"].map((key) => [key, parameters[key]]));
}

/** 请求训练 Runtime 的幂等取消接口。 */
async function cancelRuntimeJob(runtimeJobId) {
  const baseUrl = requiredEnvironment("TRAINING_RUNTIME_BASE_URL").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/v1/training/jobs/${encodeURIComponent(runtimeJobId)}/cancel`, { method: "POST", headers: { "content-type": "application/json", "x-training-runtime-token": requiredEnvironment("TRAINING_RUNTIME_TOKEN") }, body: "{}", signal: AbortSignal.timeout(30_000) });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true || payload.data?.status !== "cancelled") throw new Error(payload.message || `训练 Runtime 取消失败：HTTP ${response.status}`);
}

/** 请求主站真实钱包集成接口，所有金额仍由主站已发布价格版本计算。 */
async function mainRequest(path, body) {
  const baseUrl = requiredEnvironment("MAIN_PLATFORM_INTERNAL_URL").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-local-platform-token": requiredEnvironment("MAIN_PLATFORM_CLIENT_SECRET") }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) throw new Error(payload.message || `主站集成请求失败：HTTP ${response.status}`);
  return payload.data;
}

/** 读取必填生产配置且不回显具体内容。 */
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少生产配置 ${name}`);
  return value;
}

/** 把 Prisma JSON 安全读取为普通对象。 */
function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
