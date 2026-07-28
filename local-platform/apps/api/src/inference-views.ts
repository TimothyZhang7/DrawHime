/**
 * 本文件负责把推理数据库记录转换为用户与管理端共享的任务详情视图。
 */
import type { InferenceJobView } from "@drawhime/contracts";
import { database } from "@drawhime/database";

/** 把数据库任务转换为不包含对象存储私有键的用户视图。 */
export async function toInferenceJobView(jobId: string): Promise<InferenceJobView> {
  const job = await database.inferenceJob.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      modelVersion: true,
      artifacts: { orderBy: { createdAt: "asc" } },
      attempts: { orderBy: { attemptNumber: "asc" } },
      stages: { orderBy: { sequence: "asc" } },
      billingReservation: true,
      galleryPublication: true,
    },
  });
  const parameters = readObject(job.parameters);
  const loraSnapshots = readLoraSnapshots(parameters);
  const loraVersionIds = readLoraVersionIds(parameters, loraSnapshots);
  const loraVersions = loraVersionIds.length > 0 ? await database.loraVersion.findMany({
    where: { id: { in: loraVersionIds } },
    include: { loraEntry: { include: { examples: { include: { artifact: true }, orderBy: { sortOrder: "asc" }, take: 1 } } } },
  }) : [];
  const loraVersionMap = new Map(loraVersions.map((version) => [version.id, version]));
  const loraSnapshotMap = new Map(loraSnapshots.map((snapshot) => [snapshot.loraVersionId, snapshot]));
  return {
    id: job.id,
    source: job.source,
    status: job.status.toLowerCase() as InferenceJobView["status"],
    progress: Number(job.progress),
    effectivePrompt: job.effectivePrompt,
    requestedPrompt: job.requestedPrompt,
    negativePrompt: job.negativePrompt,
    modelDisplayName: job.modelVersion.displayName,
    parameters,
    loras: loraVersionIds.map((loraVersionId) => {
      const version = loraVersionMap.get(loraVersionId);
      const snapshot = loraSnapshotMap.get(loraVersionId);
      const type = readLoraType(snapshot?.type ?? version?.loraEntry.type);
      const example = version?.loraEntry.examples[0];
      return {
        loraVersionId,
        title: snapshot?.title || version?.loraEntry.title || "已下架 LoRA",
        type,
        strength: readLoraStrength(snapshot?.strength, parameters, loraVersionId, type),
        cover: example ? {
          width: example.artifact.width,
          height: example.artifact.height,
          contentUrl: `/local-model-api/v1/inference/jobs/${job.id}/loras/${loraVersionId}/cover`,
        } : null,
      };
    }),
    artifacts: job.artifacts.map((artifact) => ({
      id: artifact.id,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
      byteSize: String(artifact.byteSize),
      width: artifact.width,
      height: artifact.height,
      contentUrl: `/local-model-api/v1/artifacts/${artifact.id}/content`,
    })),
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    attempts: job.attempts.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status.toLowerCase() as InferenceJobView["attempts"][number]["status"],
      runtimeJobId: attempt.runtimeJobId,
      requestJson: nullableObject(attempt.requestJson),
      responseJson: nullableObject(attempt.responseJson),
      errorCode: attempt.errorCode,
      errorMessage: attempt.errorMessage,
      startedAt: attempt.startedAt?.toISOString() ?? null,
      completedAt: attempt.completedAt?.toISOString() ?? null,
    })),
    stages: job.stages.map((stage) => ({
      id: stage.id,
      sequence: stage.sequence,
      stageType: stage.stageType,
      status: stage.status.toLowerCase() as InferenceJobView["stages"][number]["status"],
      inputJson: nullableObject(stage.inputJson),
      outputJson: nullableObject(stage.outputJson),
      errorMessage: stage.errorMessage,
      startedAt: stage.startedAt?.toISOString() ?? null,
      completedAt: stage.completedAt?.toISOString() ?? null,
    })),
    billing: job.billingReservation ? {
      status: job.billingReservation.status.toLowerCase() as NonNullable<InferenceJobView["billing"]>["status"],
      amount: (Number(job.billingReservation.amountMinor) / 100).toFixed(2),
      currency: job.billingReservation.currency,
    } : null,
    publication: job.galleryPublication ? {
      status: job.galleryPublication.status.toLowerCase() as NonNullable<InferenceJobView["publication"]>["status"],
      mainGalleryItemId: job.galleryPublication.mainGalleryItemId,
      mediaUrl: job.galleryPublication.mediaUrl,
      errorMessage: job.galleryPublication.errorMessage,
    } : null,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

type TaskLoraType = InferenceJobView["loras"][number]["type"];
type TaskLoraSnapshot = { loraVersionId: string; title: string; type: TaskLoraType; strength: number };

/** 读取新任务固化的 LoRA 元数据快照，避免后续改名或下架改变历史任务语义。 */
function readLoraSnapshots(parameters: Record<string, unknown>): TaskLoraSnapshot[] {
  if (!Array.isArray(parameters.loraSelections)) return [];
  return parameters.loraSelections.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const snapshot = value as Record<string, unknown>;
    if (typeof snapshot.loraVersionId !== "string") return [];
    return [{
      loraVersionId: snapshot.loraVersionId,
      title: typeof snapshot.title === "string" && snapshot.title.trim() ? snapshot.title.trim() : "已下架 LoRA",
      type: readLoraType(snapshot.type),
      strength: normalizeLoraStrength(snapshot.strength, readLoraType(snapshot.type)),
    }];
  });
}

/** 按任务原始选择顺序读取 LoRA 版本，旧任务缺少 ID 数组时回退快照顺序。 */
function readLoraVersionIds(parameters: Record<string, unknown>, snapshots: TaskLoraSnapshot[]): string[] {
  const direct = Array.isArray(parameters.loraVersionIds) ? parameters.loraVersionIds.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  return [...new Set(direct.length > 0 ? direct : snapshots.map((snapshot) => snapshot.loraVersionId))].slice(0, 4);
}

/** 读取 LoRA 类型并兼容 Prisma 大写枚举与历史小写快照。 */
function readLoraType(value: unknown): TaskLoraType {
  const type = String(value || "other").toLowerCase();
  return ["style", "character", "concept", "clothing", "pose", "other"].includes(type) ? type as TaskLoraType : "other";
}

/** 优先使用任务快照权重，旧任务再读取强度映射并按类型补齐真实默认值。 */
function readLoraStrength(snapshotStrength: unknown, parameters: Record<string, unknown>, versionId: string, type: TaskLoraType): number {
  const strengths = readObject(parameters.loraStrengths);
  return normalizeLoraStrength(snapshotStrength ?? strengths[versionId], type);
}

/** 把 LoRA 权重约束到 Runtime 接受的范围并与生成链路默认值保持一致。 */
function normalizeLoraStrength(value: unknown, type: TaskLoraType): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1.5) return Math.round(numeric * 100) / 100;
  return ({ character: 1, style: 0.85, concept: 0.8, clothing: 0.85, pose: 0.7, other: 0.8 } satisfies Record<TaskLoraType, number>)[type];
}

/** Prisma JSON 只向视图层暴露普通对象。 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 把 Prisma JSON 安全收敛为任务详情可公开的对象。 */
function nullableObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
