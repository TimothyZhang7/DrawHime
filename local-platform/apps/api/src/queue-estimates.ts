/**
 * 本文件负责基于真实排队任务、运行中任务和近期完成耗时计算推理与训练队列估算。
 */
import type { JobQueueEstimateView } from "@drawhime/contracts";
import { database } from "@drawhime/database";

const inferenceFallbackSeconds = 260;
const trainingFallbackSeconds = 1800;
const trainingBaselineSteps = 160;

interface QueueCandidate {
  id: string;
  estimatedRunSeconds: number;
}

interface RunningQueueCandidate extends QueueCandidate {
  startedAt: Date | null;
}

/** 批量计算当前推理队列，避免任务列表逐条查询产生 N+1。 */
export async function getInferenceQueueEstimates(): Promise<Map<string, JobQueueEstimateView>> {
  const [activeJobs, recentJobs] = await Promise.all([
    database.inferenceJob.findMany({
      where: { status: { in: ["QUEUED", "RESERVING", "READY", "RUNNING"] }, deletedAt: null },
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        status: true,
        startedAt: true,
        modelVersionId: true,
        modelVersion: { select: { defaultParameters: true } },
        _count: { select: { artifacts: true } },
      },
    }),
    database.inferenceJob.findMany({
      where: { status: "SUCCEEDED", startedAt: { not: null }, completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      take: 80,
      select: { modelVersionId: true, startedAt: true, completedAt: true },
    }),
  ]);
  const historicalSeconds = new Map<string, number[]>();
  for (const job of recentJobs) {
    const duration = elapsedSeconds(job.startedAt, job.completedAt);
    if (duration < 30 || duration > 3600) continue;
    const samples = historicalSeconds.get(job.modelVersionId) ?? [];
    if (samples.length < 12) samples.push(duration);
    historicalSeconds.set(job.modelVersionId, samples);
  }
  const durationByModel = new Map<string, number>();
  for (const job of activeJobs) {
    if (durationByModel.has(job.modelVersionId)) continue;
    const configured = positiveInteger(readObject(job.modelVersion.defaultParameters).targetSeconds, inferenceFallbackSeconds);
    const samples = historicalSeconds.get(job.modelVersionId) ?? [];
    durationByModel.set(job.modelVersionId, samples.length >= 3 ? median(samples) : configured);
  }
  const candidates = activeJobs.map((job) => ({
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    artifactCount: job._count.artifacts,
    estimatedRunSeconds: durationByModel.get(job.modelVersionId) ?? inferenceFallbackSeconds,
  }));
  // 已保存产物但仍在同步计费的 READY 任务不再占用 GPU，也不进入排队人数和等待时间。
  const waiting = candidates.filter((job) => job.status !== "RUNNING" && job.artifactCount === 0);
  const running = candidates.filter((job) => job.status === "RUNNING");
  return calculateQueueEstimates(waiting, running);
}

/** 批量计算当前 LoRA 训练队列，训练耗时优先按近期真实单位步耗时估算。 */
export async function getTrainingQueueEstimates(): Promise<Map<string, JobQueueEstimateView>> {
  const [activeJobs, recentJobs] = await Promise.all([
    database.trainingJob.findMany({
      where: { status: { in: ["QUEUED", "RESERVING", "READY", "RUNNING"] }, deletedAt: null },
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
      select: { id: true, status: true, startedAt: true, outputLoraVersionId: true, parameters: true },
    }),
    database.trainingJob.findMany({
      where: { status: "SUCCEEDED", startedAt: { not: null }, completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      take: 30,
      select: { parameters: true, startedAt: true, completedAt: true },
    }),
  ]);
  const unitSecondSamples = recentJobs.flatMap((job) => {
    const steps = estimateTrainingSteps(readObject(job.parameters));
    const duration = elapsedSeconds(job.startedAt, job.completedAt);
    return steps > 0 && duration >= 300 && duration <= 14_400 ? [duration / steps] : [];
  });
  const secondsPerStep = unitSecondSamples.length >= 3 ? median(unitSecondSamples) : trainingFallbackSeconds / trainingBaselineSteps;
  const candidates = activeJobs.map((job) => ({
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    outputLoraVersionId: job.outputLoraVersionId,
    estimatedRunSeconds: clamp(Math.round(estimateTrainingSteps(readObject(job.parameters)) * secondsPerStep), 600, 7200),
  }));
  // 已生成 LoRA、只剩结算收尾的任务不再占用训练 Runtime。
  const waiting = candidates.filter((job) => job.status !== "RUNNING" && job.outputLoraVersionId === null);
  const running = candidates.filter((job) => job.status === "RUNNING");
  return calculateQueueEstimates(waiting, running);
}

/** 按单槽位 FIFO 语义生成位置、前方任务数和预计耗时。 */
function calculateQueueEstimates(waiting: QueueCandidate[], running: RunningQueueCandidate[]): Map<string, JobQueueEstimateView> {
  const estimates = new Map<string, JobQueueEstimateView>();
  const now = new Date();
  let accumulatedWaitSeconds = running.reduce((total, job) => {
    const elapsed = job.startedAt ? Math.max(0, elapsedSeconds(job.startedAt, now)) : 0;
    return total + Math.max(30, job.estimatedRunSeconds - elapsed);
  }, 0);
  for (const [index, job] of waiting.entries()) {
    const estimatedWaitSeconds = Math.max(0, Math.round(accumulatedWaitSeconds));
    const estimatedRunSeconds = Math.max(1, Math.round(job.estimatedRunSeconds));
    estimates.set(job.id, {
      position: running.length + index + 1,
      ahead: running.length + index,
      total: waiting.length,
      estimatedWaitSeconds,
      estimatedRunSeconds,
      estimatedCompletionSeconds: estimatedWaitSeconds + estimatedRunSeconds,
    });
    accumulatedWaitSeconds += estimatedRunSeconds;
  }
  return estimates;
}

/** 从固化训练参数推导优化步数，保持与价格试算口径一致。 */
function estimateTrainingSteps(parameters: Record<string, unknown>): number {
  const assetCount = Array.isArray(parameters.assetSnapshot) ? parameters.assetSnapshot.length : 0;
  const repeats = positiveInteger(parameters.repeats, 1);
  const epochs = positiveInteger(parameters.epochs, 1);
  const gradientAccumulationSteps = positiveInteger(parameters.gradientAccumulationSteps, 1);
  return Math.max(1, Math.ceil(Math.max(1, assetCount) * repeats * epochs / gradientAccumulationSteps));
}

/** 计算两个时间点之间的完整秒数，缺失或倒序时间返回零。 */
function elapsedSeconds(startedAt: Date | null, completedAt: Date | null): number {
  if (!startedAt || !completedAt) return 0;
  return Math.max(0, Math.round((completedAt.getTime() - startedAt.getTime()) / 1000));
}

/** 读取中位数，降低偶发模型切换、网络重连和对象上传抖动对 ETA 的影响。 */
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : Math.round(sorted[middle]);
}

/** 把未知 JSON 值收敛为普通对象。 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 读取正整数配置，异常值使用业务默认值。 */
function positiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

/** 把估算值限制在可解释的业务范围内。 */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
