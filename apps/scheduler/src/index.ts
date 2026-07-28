/**
 * 本文件启动任务调度服务，负责补偿主站资金预留并把数据库 READY 任务重新投递到 Redis。
 */
import { database } from "@drawhime/database";
import { createHash, randomBytes } from "node:crypto";
import { reserveMainBilling } from "@drawhime/main-platform-client";
import { createConfigCheck, createDatabaseCheck, createRedisCheck, InferenceQueue, startService, TrainingQueue } from "@drawhime/service-runtime";

const queue = new InferenceQueue();
const trainingQueue = new TrainingQueue();
const workloadsShareGpuDevice = process.env.GPU_WORKLOADS_SHARE_DEVICE?.trim().toLowerCase() !== "false";
let stopping = false;

startService({
  name: "scheduler",
  port: Number(process.env.LOCAL_SCHEDULER_PORT || 7103),
  checks: [
    createDatabaseCheck(),
    createRedisCheck(),
    createConfigCheck("main-platform-billing", ["MAIN_PLATFORM_INTERNAL_URL", "MAIN_PLATFORM_CLIENT_SECRET"]),
  ],
});

void runScheduler();
process.on("SIGINT", () => { stopping = true; void queue.close(); void trainingQueue.close(); });
process.on("SIGTERM", () => { stopping = true; void queue.close(); void trainingQueue.close(); });

/** 每十秒补偿未确认预留，并重新唤醒 READY 任务。 */
async function runScheduler(): Promise<void> {
  while (!stopping) {
    try {
      await reconcilePendingReservations();
      await reconcilePendingTrainingReservations();
      await reconcileGpuLeases();
      await assignGpuLeases();
      await assignTrainingGpuLeases();
      await enqueueReadyJobs();
      await enqueueReadyTrainingJobs();
    } catch (error) {
      process.stderr.write(`调度补偿异常：${errorMessage(error)}\n`);
    }
    await sleep(10000);
  }
}

/** 重放状态不确定的训练资金预留，使用训练任务自身固化价格。 */
async function reconcilePendingTrainingReservations(): Promise<void> {
  const rows = await database.trainingBillingReservationMirror.findMany({ where: { status: "PENDING", trainingJob: { status: "RESERVING" } }, include: { trainingJob: { include: { externalIdentity: true } } }, orderBy: { updatedAt: "asc" }, take: 20 });
  for (const row of rows) {
    const parameters = readObject(row.trainingJob.parameters);
    try {
      const reservation = await reserveMainBilling({ jobId: row.trainingJobId, idempotencyKey: row.idempotencyKey, userSubject: row.trainingJob.externalIdentity.subject, walletOwnerType: "user", productCode: String(parameters.productCode || ""), pricingVersion: Number(parameters.pricingVersion || 0), quantity: 1 });
      await database.$transaction([
        database.trainingBillingReservationMirror.update({ where: { id: row.id }, data: { mainReservationId: reservation.reservationId, amountMinor: BigInt(Math.round(Number(reservation.reservedAmount) * 100)), status: "RESERVED", expiresAt: reservation.expiresAt ? new Date(reservation.expiresAt) : null, lastSynchronizedAt: new Date(), errorMessage: null } }),
        database.trainingJob.update({ where: { id: row.trainingJobId }, data: { status: "READY", progress: 1, errorCode: null, errorMessage: null } }),
      ]);
    } catch (error) { await database.trainingBillingReservationMirror.update({ where: { id: row.id }, data: { errorMessage: errorMessage(error), lastSynchronizedAt: new Date() } }); }
  }
}

/** 使用相同幂等键重放状态不确定的主站资金预留。 */
async function reconcilePendingReservations(): Promise<void> {
  const rows = await database.billingReservationMirror.findMany({
    where: { status: "PENDING", job: { status: "RESERVING" } },
    include: { job: { include: { externalIdentity: true } } },
    orderBy: { updatedAt: "asc" },
    take: 20,
  });
  for (const row of rows) {
    const parameters = readObject(row.job.parameters);
    try {
      const reservation = await reserveMainBilling({
        jobId: row.jobId,
        idempotencyKey: row.idempotencyKey,
        userSubject: row.job.externalIdentity.subject,
        walletOwnerType: row.job.source === "bot" ? "qq" : "user",
        productCode: String(parameters.productCode || ""),
        pricingVersion: Number(parameters.pricingVersion || 0),
        quantity: Number(parameters.batchSize || 1),
      });
      await database.$transaction([
        database.billingReservationMirror.update({ where: { id: row.id }, data: { mainReservationId: reservation.reservationId, amountMinor: BigInt(Math.round(Number(reservation.reservedAmount) * 100)), status: "RESERVED", expiresAt: reservation.expiresAt ? new Date(reservation.expiresAt) : null, lastSynchronizedAt: new Date(), errorMessage: null } }),
        database.inferenceJob.update({ where: { id: row.jobId }, data: { status: "READY", progress: 1, errorCode: null, errorMessage: null } }),
      ]);
    } catch (error) {
      await database.billingReservationMirror.update({ where: { id: row.id }, data: { errorMessage: errorMessage(error), lastSynchronizedAt: new Date() } });
    }
  }
}

/** 重新投递数据库中的 READY 任务；Worker 通过条件更新保证重复唤醒不重复运行。 */
async function enqueueReadyJobs(): Promise<void> {
  const jobs = await database.inferenceJob.findMany({ where: { status: "READY", OR: [{ artifacts: { some: {} } }, { stages: { some: { stageType: "PROMPT_ENHANCEMENT", status: "PENDING" } } }, { leases: { some: { status: "OFFERED", expiresAt: { gt: new Date() } } } }] }, orderBy: { queuedAt: "asc" }, select: { id: true }, take: 100 });
  for (const job of jobs) await queue.push(job.id);
}

/** 唤醒已经取得训练 GPU 租约的任务。 */
async function enqueueReadyTrainingJobs(): Promise<void> {
  const jobs = await database.trainingJob.findMany({ where: { status: { in: ["READY", "EVALUATING"] }, OR: [{ outputLoraVersionId: { not: null } }, { leases: { some: { status: "OFFERED", expiresAt: { gt: new Date() } } } }] }, orderBy: { queuedAt: "asc" }, select: { id: true }, take: 50 });
  for (const job of jobs) await trainingQueue.push(job.id);
}

/** 释放终态任务租约，并回收过期但尚未运行的 GPU 租约。 */
async function reconcileGpuLeases(): Promise<void> {
  const now = new Date();
  await database.gpuLease.updateMany({
    where: { status: { in: ["OFFERED", "ACCEPTED"] }, expiresAt: { lte: now } },
    data: { status: "EXPIRED", releasedAt: now },
  });
  const terminal = await database.gpuLease.findMany({
    where: { status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] }, job: { status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] } } },
    select: { id: true },
    take: 100,
  });
  if (terminal.length > 0) await database.gpuLease.updateMany({ where: { id: { in: terminal.map((item) => item.id) } }, data: { status: "RELEASED", releasedAt: now } });
  await database.trainingGpuLease.updateMany({ where: { status: { in: ["OFFERED", "ACCEPTED"] }, expiresAt: { lte: now } }, data: { status: "EXPIRED", releasedAt: now } });
  const terminalTraining = await database.trainingGpuLease.findMany({ where: { status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] }, trainingJob: { status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] } } }, select: { id: true }, take: 100 });
  if (terminalTraining.length > 0) await database.trainingGpuLease.updateMany({ where: { id: { in: terminalTraining.map((item) => item.id) } }, data: { status: "RELEASED", releasedAt: now } });
}

/** 为没有产物的 READY 任务分配最近心跳正常且空闲的 GPU。 */
async function assignGpuLeases(): Promise<void> {
  const heartbeatAfter = new Date(Date.now() - 45_000);
  const jobs = await database.inferenceJob.findMany({
    where: { status: "READY", effectivePrompt: { not: null }, artifacts: { none: {} }, leases: { none: { status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] } } } },
    orderBy: { queuedAt: "asc" },
    select: { id: true },
    take: 20,
  });
  for (const job of jobs) {
    await database.$transaction(async (tx) => {
      const current = await tx.gpuLease.count({ where: { jobId: job.id, status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] } } });
      if (current > 0) return;
      const device = await tx.gpuDevice.findFirst({
        where: {
          status: "ACTIVE",
          lastHeartbeatAt: { gte: heartbeatAfter },
          host: { status: "ACTIVE", lastHeartbeatAt: { gte: heartbeatAfter } },
          leases: { none: { status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] } } },
          // 单卡部署保持推理与训练互斥；生产双卡部署分别固定 GPU 0/1，不让训练错误阻塞绘图队列。
          ...(workloadsShareGpuDevice ? { trainingLeases: { none: { status: { in: ["OFFERED" as const, "ACCEPTED" as const, "RUNNING" as const] } } } } : {}),
        },
        orderBy: [{ freeVramBytes: "desc" }, { updatedAt: "asc" }],
      });
      if (!device) return;
      const leaseToken = randomBytes(32).toString("hex");
      await tx.gpuLease.create({
        data: { gpuDeviceId: device.id, jobId: job.id, leaseTokenHash: createHash("sha256").update(leaseToken).digest("hex"), status: "OFFERED", expiresAt: new Date(Date.now() + 10 * 60_000) },
      });
    }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 10000 }).catch((error) => {
      process.stderr.write(`任务 ${job.id} GPU 租约分配竞争：${errorMessage(error)}\n`);
    });
  }
}

/** 为训练任务分配与推理互斥的 GPU 租约，优先使用空闲显存最多的设备。 */
async function assignTrainingGpuLeases(): Promise<void> {
  const heartbeatAfter = new Date(Date.now() - 45_000);
  const jobs = await database.trainingJob.findMany({ where: { status: "READY", outputLoraVersionId: null, leases: { none: { status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] } } } }, orderBy: { queuedAt: "asc" }, select: { id: true }, take: 10 });
  for (const job of jobs) {
    await database.$transaction(async (tx) => {
      const existing = await tx.trainingGpuLease.count({ where: { trainingJobId: job.id, status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] } } });
      if (existing > 0) return;
      const device = await tx.gpuDevice.findFirst({ where: { status: "ACTIVE", lastHeartbeatAt: { gte: heartbeatAfter }, host: { status: "ACTIVE", lastHeartbeatAt: { gte: heartbeatAfter } }, trainingLeases: { none: { status: { in: ["OFFERED", "ACCEPTED", "RUNNING"] } } }, ...(workloadsShareGpuDevice ? { leases: { none: { status: { in: ["OFFERED" as const, "ACCEPTED" as const, "RUNNING" as const] } } } } : {}) }, orderBy: [{ freeVramBytes: "desc" }, { updatedAt: "asc" }] });
      if (!device) return;
      const leaseToken = randomBytes(32).toString("hex");
      await tx.trainingGpuLease.create({ data: { gpuDeviceId: device.id, trainingJobId: job.id, leaseTokenHash: createHash("sha256").update(leaseToken).digest("hex"), status: "OFFERED", expiresAt: new Date(Date.now() + 30 * 60_000) } });
    }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 10000 }).catch((error) => process.stderr.write(`训练任务 ${job.id} GPU 租约分配竞争：${errorMessage(error)}\n`));
  }
}

/** Prisma JSON 读取为普通对象。 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 限制日志错误长度。 */
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** 调度循环等待。 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
