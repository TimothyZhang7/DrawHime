/**
 * 本文件实现训练数据集、训练任务、计费预留和训练图片读取接口，所有资产写入独立对象存储。
 */
import {
  trainingDatasetAssetUpdateRequestSchema,
  trainingDatasetArchiveMimeType,
  trainingCaptionJobCreateRequestSchema,
  trainingDatasetCreateRequestSchema,
  trainingTagTranslationRequestSchema,
  trainingJobCreateRequestSchema,
  trainingPriceQuoteRequestSchema,
  type TrainingCaptionStageView,
  type TrainingDatasetView,
  type TrainingJobView,
  type TrainingParameters,
} from "@drawhime/contracts";
import { database } from "@drawhime/database";
import { MainPlatformIntegrationError, releaseMainBilling, reserveMainBilling } from "@drawhime/main-platform-client";
import { deleteObject, getObjectBuffer, putObjectBuffer, readJsonBody, sendError, sendSuccess, type ServiceRouter, TrainingQueue } from "@drawhime/service-runtime";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import sharp from "sharp";
import { Prisma } from "@prisma/client";
import { calculateTrainingPrice } from "./training-pricing.js";
import { translateTrainingTags } from "./training-tag-translation.js";
import { streamTrainingDatasetArchive, trainingDatasetArchiveContentDisposition } from "./training-dataset-archive.js";

const trainingQueue = new TrainingQueue();
const maximumDatasetImageBytes = 25 * 1024 * 1024;
type SessionRecord = { externalIdentity: { id: string; subject: string; displayName: string; roles: unknown } };

/** 注册用户训练数据集与任务路由。 */
export function registerTrainingRoutes(router: ServiceRouter, findSession: (token: string | null) => Promise<SessionRecord | null>): void {
  router.post("/v1/training/tag-translations", async ({ request, response }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const input = trainingTagTranslationRequestSchema.parse(await readJsonBody<unknown>(request));
      sendSuccess(response, await translateTrainingTags(input.tags));
    } catch (error) { sendTrainingError(response, error); }
  });

  router.get("/internal/training/assets/:artifactId/content", async ({ request, response, params }) => {
    if (!authenticateTrainingRuntime(request)) return sendError(response, 403, "training_runtime_token_invalid", "训练 Runtime 服务凭证不正确");
    const artifact = await database.jobArtifact.findFirst({ where: { id: params.artifactId, kind: "DATASET_ASSET", datasetAssets: { some: { dataset: { status: "ACTIVE" } } } } });
    if (!artifact) return sendError(response, 404, "training_asset_not_found", "训练图片不存在");
    const object = await getObjectBuffer(artifact.objectKey);
    response.writeHead(200, { "content-type": artifact.mimeType, "content-length": String(object.body.length), "x-content-sha256": artifact.sha256, "cache-control": "no-store" }); response.end(object.body);
  });

  router.get("/v1/training/datasets", async ({ request, response, url }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    const admin = readRoles(session.externalIdentity.roles).includes("admin");
    const rows = await database.trainingDataset.findMany({
      where: admin && url.searchParams.get("scope") === "all" ? {} : { ownerIdentityId: session.externalIdentity.id, status: { not: "ARCHIVED" } },
      include: datasetInclude,
      orderBy: { updatedAt: "desc" }, take: 100,
    });
    sendSuccess(response, { datasets: rows.map(toDatasetView) });
  });

  router.post("/v1/training/datasets", async ({ request, response }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const input = trainingDatasetCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      const row = await database.trainingDataset.create({ data: { ownerIdentityId: session.externalIdentity.id, title: input.title, description: input.description || null }, include: datasetInclude });
      sendSuccess(response, toDatasetView(row), 201);
    } catch (error) { sendTrainingError(response, error); }
  });

  router.post("/v1/training/datasets/:id/assets", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const dataset = await findOwnedMutableDataset(params.id, session.externalIdentity.id);
      ensureCaptionMutationAllowed(dataset.captionJobs[0]);
      if (dataset._count.assets >= 200) throw new TrainingRouteError(400, "dataset_asset_limit", "单个数据集最多包含 200 张图片");
      const source = await readRequestBuffer(request, maximumDatasetImageBytes);
      const rendered = await sharp(source, { failOn: "error", limitInputPixels: 100_000_000 }).rotate().toColorspace("srgb").webp({ quality: 96, effort: 5, smartSubsample: true }).toBuffer({ resolveWithObject: true });
      if (!rendered.info.width || !rendered.info.height || Math.min(rendered.info.width, rendered.info.height) < 256) throw new TrainingRouteError(400, "dataset_image_too_small", "训练图片短边不得小于 256 像素");
      const sha256 = createHash("sha256").update(rendered.data).digest("hex");
      const duplicate = await database.datasetAsset.findFirst({ where: { datasetId: dataset.id, artifact: { sha256 } } });
      if (duplicate) throw new TrainingRouteError(409, "dataset_image_duplicate", "该图片已经存在于当前数据集");
      const artifactId = randomUUID();
      const objectKey = `datasets/${session.externalIdentity.id}/${dataset.id}/${artifactId}.webp`;
      await putObjectBuffer(objectKey, rendered.data, "image/webp");
      try {
        await database.$transaction(async (tx) => {
          await tx.jobArtifact.create({ data: { id: artifactId, kind: "DATASET_ASSET", objectKey, fileName: `${artifactId}.webp`, mimeType: "image/webp", sha256, byteSize: BigInt(rendered.data.length), width: rendered.info.width, height: rendered.info.height, metadata: { sourceContentType: request.headers["content-type"] || null } } });
          await tx.datasetAsset.create({ data: { datasetId: dataset.id, artifactId, caption: normalizeCaptionHeader(request.headers["x-dataset-caption"]), metadata: { normalized: true } } });
          // 图片快照变化后旧打标确认必须失效，正式训练只能使用重新打标并确认的新快照。
          await tx.trainingCaptionJob.updateMany({ where: { datasetId: dataset.id, scope: "DATASET", status: { in: ["AWAITING_CONFIRMATION", "CONFIRMED"] } }, data: { status: "STALE", errorMessage: "数据集图片已变化，请重新自动打标并确认" } });
        });
      } catch (error) { await deleteObject(objectKey).catch(() => undefined); throw error; }
      sendSuccess(response, await getDatasetView(dataset.id), 201);
    } catch (error) { sendTrainingError(response, error); }
  });

  router.register("PATCH", "/v1/training/datasets/:id/assets/:assetId", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const dataset = await findOwnedMutableDataset(params.id, session.externalIdentity.id);
      ensureCaptionMutationAllowed(dataset.captionJobs[0]);
      const input = trainingDatasetAssetUpdateRequestSchema.parse(await readJsonBody<unknown>(request));
      const changed = await database.$transaction(async (tx) => {
        const result = await tx.datasetAsset.updateMany({ where: { id: params.assetId, datasetId: params.id }, data: { caption: input.caption } });
        if (result.count === 1) {
          await tx.trainingCaptionJob.updateMany({ where: { datasetId: params.id, scope: "DATASET", status: "CONFIRMED" }, data: { status: "AWAITING_CONFIRMATION", confirmedAt: null, errorMessage: "Caption 已修改，请重新确认" } });
          await tx.trainingCaptionJob.updateMany({ where: { datasetId: params.id, scope: "ASSET", assetId: params.assetId, status: "CONFIRMED" }, data: { status: "STALE", confirmedAt: null, errorMessage: "Caption 已人工修改" } });
        }
        return result;
      });
      if (changed.count !== 1) throw new TrainingRouteError(404, "dataset_asset_not_found", "数据集图片不存在");
      sendSuccess(response, await getDatasetView(params.id));
    } catch (error) { sendTrainingError(response, error); }
  });

  router.delete("/v1/training/datasets/:id/assets/:assetId", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const dataset = await findOwnedMutableDataset(params.id, session.externalIdentity.id);
      ensureCaptionMutationAllowed(dataset.captionJobs[0]);
      const asset = await database.datasetAsset.findFirst({ where: { id: params.assetId, datasetId: params.id }, include: { artifact: true } });
      if (!asset) throw new TrainingRouteError(404, "dataset_asset_not_found", "数据集图片不存在");
      await database.$transaction([
        database.datasetAsset.delete({ where: { id: asset.id } }),
        database.jobArtifact.delete({ where: { id: asset.artifactId } }),
        database.trainingCaptionJob.updateMany({ where: { datasetId: params.id, scope: "DATASET", status: { in: ["AWAITING_CONFIRMATION", "CONFIRMED"] } }, data: { status: "STALE", errorMessage: "数据集图片已变化，请重新自动打标并确认" } }),
      ]);
      await deleteObject(asset.artifact.objectKey).catch(() => undefined);
      sendSuccess(response, await getDatasetView(params.id));
    } catch (error) { sendTrainingError(response, error); }
  });

  router.delete("/v1/training/datasets/:id", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const dataset = await findOwnedMutableDataset(params.id, session.externalIdentity.id);
      if (dataset._count.trainingJobs > 0) throw new TrainingRouteError(409, "dataset_in_use", "已用于训练的数据集需要保留用于审计");
      await database.trainingDataset.update({ where: { id: dataset.id }, data: { status: "ARCHIVED" } });
      sendSuccess(response, { archived: true });
    } catch (error) { sendTrainingError(response, error); }
  });

  router.get("/v1/training/datasets/:id/assets/:assetId/content", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    const asset = await database.datasetAsset.findFirst({ where: { id: params.assetId, datasetId: params.id }, include: { dataset: true, artifact: true } });
    const admin = readRoles(session.externalIdentity.roles).includes("admin");
    if (!asset || (!admin && asset.dataset.ownerIdentityId !== session.externalIdentity.id)) return sendError(response, 404, "dataset_asset_not_found", "数据集图片不存在");
    const object = await getObjectBuffer(asset.artifact.objectKey);
    response.writeHead(200, { "content-type": asset.artifact.mimeType, "content-length": String(object.body.length), "cache-control": "private, max-age=300" }); response.end(object.body);
  });

  router.get("/v1/training/datasets/:id/archive", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    const dataset = await database.trainingDataset.findFirst({
      where: { id: params.id, status: { not: "ARCHIVED" } },
      include: { assets: { include: { artifact: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    const admin = readRoles(session.externalIdentity.roles).includes("admin");
    if (!dataset || (!admin && dataset.ownerIdentityId !== session.externalIdentity.id)) return sendError(response, 404, "dataset_not_found", "训练数据集不存在");
    if (dataset.assets.length === 0) return sendError(response, 400, "dataset_archive_empty", "当前训练集还没有图片");
    response.writeHead(200, {
      "content-type": trainingDatasetArchiveMimeType,
      "content-disposition": trainingDatasetArchiveContentDisposition(dataset),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    try {
      // ZIP 写入后不再发送 JSON；任一对象异常都主动断开响应，避免交付缺图但看似成功的压缩包。
      await streamTrainingDatasetArchive(response, dataset);
    } catch (error) {
      if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error("训练集打包失败"));
    }
  });

  router.post("/v1/training/datasets/:id/assets/:assetId/caption-jobs", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const input = trainingCaptionJobCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      const dataset = await findOwnedMutableDataset(params.id, session.externalIdentity.id);
      ensureCaptionMutationAllowed(dataset.captionJobs[0]);
      const asset = await database.datasetAsset.findFirst({ where: { id: params.assetId, datasetId: dataset.id }, select: { id: true } });
      if (!asset) throw new TrainingRouteError(404, "dataset_asset_not_found", "数据集图片不存在");
      // 单图任务独立持久化，不替换数据集全量打标任务；完成后只使既有确认回到待确认。
      const job = await database.trainingCaptionJob.create({ data: { datasetId: dataset.id, scope: "ASSET", assetId: asset.id, mode: input.mode, status: "QUEUED", assetSnapshot: [asset.id], totalAssets: 1 } });
      sendSuccess(response, toCaptionStageView(job), 201);
    } catch (error) { sendTrainingError(response, error); }
  });

  router.post("/v1/training/datasets/:id/caption-jobs", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const input = trainingCaptionJobCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      const dataset = await findOwnedMutableDataset(params.id, session.externalIdentity.id);
      ensureCaptionMutationAllowed(dataset.captionJobs[0]);
      // 打标工具允许先处理单张图片；正式训练仍在任务创建处要求至少 5 张已确认图片。
      if (dataset._count.assets < 1) throw new TrainingRouteError(400, "dataset_assets_insufficient", "自动打标至少需要 1 张训练图片");
      const assets = await database.datasetAsset.findMany({ where: { datasetId: dataset.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
      const job = await database.$transaction(async (tx) => {
        await tx.trainingCaptionJob.updateMany({ where: { datasetId: dataset.id, scope: "DATASET", status: { in: ["AWAITING_CONFIRMATION", "CONFIRMED"] } }, data: { status: "STALE", errorMessage: "已创建新的自动打标任务" } });
        return tx.trainingCaptionJob.create({ data: { datasetId: dataset.id, scope: "DATASET", mode: input.mode, status: "QUEUED", assetSnapshot: assets.map((asset) => asset.id), totalAssets: assets.length } });
      });
      sendSuccess(response, toCaptionStageView(job), 201);
    } catch (error) { sendTrainingError(response, error); }
  });

  router.post("/v1/training/datasets/:id/caption-jobs/:jobId/confirm", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      await findOwnedMutableDataset(params.id, session.externalIdentity.id);
      const job = await database.trainingCaptionJob.findFirst({ where: { id: params.jobId, datasetId: params.id, scope: "DATASET" } });
      if (!job || !["AWAITING_CONFIRMATION", "CONFIRMED"].includes(job.status)) throw new TrainingRouteError(409, "caption_job_not_confirmable", "自动打标尚未完成或已经失效");
      const assets = await database.datasetAsset.findMany({ where: { datasetId: params.id }, orderBy: { createdAt: "asc" }, select: { id: true, caption: true } });
      if (!sameAssetSnapshot(job.assetSnapshot, assets.map((asset) => asset.id))) throw new TrainingRouteError(409, "caption_snapshot_stale", "数据集图片已经变化，请重新自动打标");
      if (assets.some((asset) => !asset.caption?.trim())) throw new TrainingRouteError(400, "caption_incomplete", "请先补全每张图片的 Caption");
      const confirmed = await database.trainingCaptionJob.update({ where: { id: job.id }, data: { status: "CONFIRMED", progress: 100, confirmedAt: new Date(), errorMessage: null } });
      sendSuccess(response, toCaptionStageView(confirmed));
    } catch (error) { sendTrainingError(response, error); }
  });

  router.post("/v1/training/quotes", async ({ request, response }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const input = trainingPriceQuoteRequestSchema.parse(await readJsonBody<unknown>(request));
      const dataset = await database.trainingDataset.findFirst({ where: { id: input.datasetId, ownerIdentityId: session.externalIdentity.id, status: "ACTIVE" }, include: { _count: { select: { assets: true } } } });
      if (!dataset) throw new TrainingRouteError(404, "dataset_not_found", "训练数据集不存在");
      const model = await findTrainingModel(input.baseModelVersionId);
      validateTrainingParameters(input.parameters);
      sendSuccess(response, calculateTrainingPrice(dataset._count.assets, input.parameters, trainingBaseUnitPrice(model.defaultParameters)));
    } catch (error) { sendTrainingError(response, error); }
  });

  router.post("/v1/training/jobs", async ({ request, response }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const input = trainingJobCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      const existing = await database.trainingJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return sendSuccess(response, await getTrainingJobView(existing.id));
      const dataset = await database.trainingDataset.findFirst({ where: { id: input.datasetId, ownerIdentityId: session.externalIdentity.id, status: "ACTIVE" }, include: { assets: { orderBy: { createdAt: "asc" }, select: { id: true, caption: true } }, captionJobs: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { assets: true } } } });
      if (!dataset) throw new TrainingRouteError(404, "dataset_not_found", "训练数据集不存在");
      if (dataset._count.assets < 5) throw new TrainingRouteError(400, "dataset_assets_insufficient", "正式训练至少需要 5 张已标注图片");
      const captionJob = dataset.captionJobs[0];
      if (!captionJob || captionJob.status !== "CONFIRMED" || !sameAssetSnapshot(captionJob.assetSnapshot, dataset.assets.map((asset) => asset.id))) throw new TrainingRouteError(409, "caption_confirmation_required", "请先完成自动打标、检查并确认全部 Caption");
      if (dataset.assets.some((asset) => !asset.caption?.trim())) throw new TrainingRouteError(400, "caption_incomplete", "正式训练要求每张图片都有已确认 Caption");
      const model = await findTrainingModel(input.baseModelVersionId);
      const defaults = readObject(model.defaultParameters);
      const productCode = String(defaults.trainingProductCode || "local.anima-lora.training");
      const pricingVersion = Number(defaults.trainingPricingVersion || 2);
      const priceCny = trainingBaseUnitPrice(defaults);
      validateTrainingParameters(input.parameters);
      const quote = calculateTrainingPrice(dataset._count.assets, input.parameters, priceCny);
      const parameters = { ...input.parameters, triggerWords: input.triggerWords, productCode, pricingVersion, pricingUnits: quote.priceUnits, estimatedPriceCny: quote.estimatedPrice, assetSnapshot: dataset.assets.map((asset) => asset.id) };
      const job = await database.$transaction(async (tx) => {
        const created = await tx.trainingJob.create({ data: { externalIdentityId: session.externalIdentity.id, datasetId: dataset.id, baseModelVersionId: model.id, idempotencyKey: input.idempotencyKey, title: input.title, status: "RESERVING", parameters: parameters as Prisma.InputJsonObject } });
        await tx.trainingBillingReservationMirror.create({ data: { trainingJobId: created.id, idempotencyKey: `train-reserve:${created.id}`, priceVersion: `${productCode}@${pricingVersion}`, amountMinor: BigInt(Math.round(priceCny * quote.priceUnits * 100)), currency: "CNY", status: "PENDING" } });
        return created;
      });
      await ensureTrainingReservation(job.id, session.externalIdentity.subject, productCode, pricingVersion, quote.priceUnits);
      sendSuccess(response, await getTrainingJobView(job.id), 201);
    } catch (error) { sendTrainingError(response, error); }
  });

  router.get("/v1/training/jobs", async ({ request, response, url }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    const admin = readRoles(session.externalIdentity.roles).includes("admin");
    const rows = await database.trainingJob.findMany({ where: admin && url.searchParams.get("scope") === "all" ? { deletedAt: null } : { externalIdentityId: session.externalIdentity.id, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true } });
    sendSuccess(response, { jobs: await Promise.all(rows.map((item) => getTrainingJobView(item.id))) });
  });

  router.get("/v1/training/jobs/:id", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    const row = await authorizeTrainingJob(params.id, session.externalIdentity);
    if (!row) return sendError(response, 404, "training_job_not_found", "训练任务不存在");
    sendSuccess(response, await getTrainingJobView(row.id));
  });

  router.post("/v1/training/jobs/:id/cancel", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const row = await authorizeTrainingJob(params.id, session.externalIdentity);
      if (!row) throw new TrainingRouteError(404, "training_job_not_found", "训练任务不存在");
      if (["RUNNING", "EVALUATING"].includes(row.status)) throw new TrainingRouteError(409, "training_job_running", "训练已经开始，请在训练控制面执行安全停止");
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(row.status)) return sendSuccess(response, await getTrainingJobView(row.id));
      const billing = await database.trainingBillingReservationMirror.findUnique({ where: { trainingJobId: row.id } });
      if (billing?.mainReservationId && billing.status === "RESERVED") await releaseMainBilling(billing.mainReservationId, `train-release:${row.id}`, "用户取消训练任务");
      await database.$transaction([
        database.trainingJob.update({ where: { id: row.id }, data: { status: "CANCELLED", progress: 100, completedAt: new Date(), errorCode: "cancelled_by_user", errorMessage: "用户取消训练任务" } }),
        database.trainingBillingReservationMirror.update({ where: { trainingJobId: row.id }, data: { status: "RELEASED", lastSynchronizedAt: new Date() } }),
      ]);
      sendSuccess(response, await getTrainingJobView(row.id));
    } catch (error) { sendTrainingError(response, error); }
  });

  router.delete("/v1/training/jobs/:id", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const row = await authorizeTrainingJob(params.id, session.externalIdentity);
      if (!row) throw new TrainingRouteError(404, "training_job_not_found", "训练任务不存在");
      if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(row.status)) throw new TrainingRouteError(409, "training_job_not_finished", "训练仍在处理中，请先取消或等待完成");
      // 仅隐藏用户任务记录，训练产物 LoRA、计费分账和运行审计仍须保留以保证可追溯。
      await database.trainingJob.updateMany({ where: { id: row.id, deletedAt: null }, data: { deletedAt: new Date() } });
      sendSuccess(response, { id: row.id, deleted: true });
    } catch (error) { sendTrainingError(response, error); }
  });
}

/** 主站资金预留成功后才允许训练任务入队。 */
async function ensureTrainingReservation(jobId: string, subject: string, productCode: string, pricingVersion: number, quantity: number): Promise<void> {
  const billing = await database.trainingBillingReservationMirror.findUniqueOrThrow({ where: { trainingJobId: jobId } });
  try {
    const reservation = await reserveMainBilling({ jobId, idempotencyKey: billing.idempotencyKey, userSubject: subject, walletOwnerType: "user", productCode, pricingVersion, quantity });
    await database.$transaction([
      database.trainingBillingReservationMirror.update({ where: { id: billing.id }, data: { mainReservationId: reservation.reservationId, amountMinor: BigInt(Math.round(Number(reservation.reservedAmount) * 100)), status: "RESERVED", expiresAt: reservation.expiresAt ? new Date(reservation.expiresAt) : null, lastSynchronizedAt: new Date(), errorMessage: null } }),
      database.trainingJob.update({ where: { id: jobId }, data: { status: "READY", progress: 1, errorCode: null, errorMessage: null } }),
    ]);
    await trainingQueue.push(jobId);
  } catch (error) {
    const temporary = error instanceof MainPlatformIntegrationError && error.status >= 500;
    await database.$transaction([
      database.trainingBillingReservationMirror.update({ where: { id: billing.id }, data: { status: temporary ? "PENDING" : "FAILED", lastSynchronizedAt: new Date(), errorMessage: errorMessage(error) } }),
      database.trainingJob.update({ where: { id: jobId }, data: { status: temporary ? "RESERVING" : "FAILED", progress: temporary ? 0 : 100, completedAt: temporary ? null : new Date(), errorCode: "training_billing_failed", errorMessage: errorMessage(error) } }),
    ]);
    throw error;
  }
}

const datasetInclude = { owner: true, assets: { include: { artifact: true, captionJobs: { where: { scope: "ASSET" }, orderBy: { createdAt: "desc" as const }, take: 1 } }, orderBy: { createdAt: "asc" as const } }, captionJobs: { where: { scope: "DATASET" }, orderBy: { createdAt: "desc" as const }, take: 1 }, _count: { select: { trainingJobs: true } } };
type DatasetRow = Awaited<ReturnType<typeof getDatasetRow>>;
async function getDatasetRow(id: string) { return database.trainingDataset.findUniqueOrThrow({ where: { id }, include: datasetInclude }); }
async function getDatasetView(id: string): Promise<TrainingDatasetView> { return toDatasetView(await getDatasetRow(id)); }

/** 把数据集数据库记录转换成不暴露对象键的视图。 */
function toDatasetView(row: DatasetRow): TrainingDatasetView { return { id: row.id, title: row.title, description: row.description, status: row.status.toLowerCase() as TrainingDatasetView["status"], ownerDisplayName: row.owner.displayName, assets: row.assets.map((asset) => ({ id: asset.id, artifactId: asset.artifactId, caption: asset.caption, width: asset.artifact.width, height: asset.artifact.height, byteSize: Number(asset.artifact.byteSize), sha256: asset.artifact.sha256, contentUrl: `/local-model-api/v1/training/datasets/${row.id}/assets/${asset.id}/content`, captionStage: asset.captionJobs[0] ? toCaptionStageView(asset.captionJobs[0]) : null, createdAt: asset.createdAt.toISOString() })), trainingJobCount: row._count.trainingJobs, captionStage: row.captionJobs[0] ? toCaptionStageView(row.captionJobs[0]) : null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }

/** 读取包含尝试、模型、数据集和计费镜像的训练任务视图。 */
export async function getTrainingJobView(id: string): Promise<TrainingJobView> {
  const row = await database.trainingJob.findUniqueOrThrow({ where: { id }, include: { dataset: true, baseModelVersion: true, attempts: { orderBy: { attemptNumber: "asc" } }, billingReservation: true } });
  return { id: row.id, title: row.title, status: row.status.toLowerCase() as TrainingJobView["status"], progress: Number(row.progress), datasetId: row.datasetId, datasetTitle: row.dataset.title, baseModelVersionId: row.baseModelVersionId, baseModelDisplayName: row.baseModelVersion.displayName, parameters: readObject(row.parameters), outputLoraVersionId: row.outputLoraVersionId, errorCode: row.errorCode, errorMessage: row.errorMessage, attempts: row.attempts.map((attempt) => ({ id: attempt.id, attemptNumber: attempt.attemptNumber, status: attempt.status.toLowerCase() as TrainingJobView["attempts"][number]["status"], runtimeJobId: attempt.runtimeJobId, metrics: nullableObject(attempt.metrics), errorMessage: attempt.errorMessage, startedAt: attempt.startedAt?.toISOString() ?? null, completedAt: attempt.completedAt?.toISOString() ?? null })), billing: row.billingReservation ? { status: row.billingReservation.status.toLowerCase() as NonNullable<TrainingJobView["billing"]>["status"], amount: (Number(row.billingReservation.amountMinor) / 100).toFixed(2), currency: row.billingReservation.currency } : null, startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

async function findOwnedMutableDataset(id: string, ownerIdentityId: string) { const row = await database.trainingDataset.findFirst({ where: { id, ownerIdentityId, status: "ACTIVE" }, include: { captionJobs: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { assets: true, trainingJobs: true } } } }); if (!row) throw new TrainingRouteError(404, "dataset_not_found", "训练数据集不存在"); if (row._count.trainingJobs > 0) throw new TrainingRouteError(409, "dataset_locked", "数据集已用于训练，内容需要保持不可变"); return row; }
async function authorizeTrainingJob(id: string, identity: { id: string; roles: unknown }) { const row = await database.trainingJob.findFirst({ where: { id, deletedAt: null } }); return row && (row.externalIdentityId === identity.id || readRoles(identity.roles).includes("admin")) ? row : null; }
async function requireSession(request: IncomingMessage, response: Parameters<typeof sendError>[0], findSession: (token: string | null) => Promise<SessionRecord | null>) { const session = await findSession(readBearerToken(request)); if (!session) sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效"); return session; }
function validateTrainingParameters(parameters: TrainingParameters): void { if (parameters.alpha > parameters.rank) throw new TrainingRouteError(400, "training_alpha_invalid", "Alpha 不能大于 Rank"); }
function trainingBaseUnitPrice(value: unknown): number { const price = Number(readObject(value).trainingPriceCny || 0.05); if (!Number.isFinite(price) || price <= 0) throw new TrainingRouteError(503, "training_price_invalid", "训练模型单价配置不正确"); return price; }
async function findTrainingModel(id: string) { const model = await database.modelVersion.findFirst({ where: { id, status: "ACTIVE", runtimeFormat: "anima" } }); if (!model) throw new TrainingRouteError(400, "training_model_invalid", "所选基础模型不支持 Anima LoRA 训练"); return model; }
function ensureCaptionMutationAllowed(job: { status: string } | undefined): void { if (job && ["QUEUED", "RUNNING"].includes(job.status)) throw new TrainingRouteError(409, "caption_job_active", "自动打标正在进行，请等待完成后再修改数据集"); }
function sameAssetSnapshot(value: unknown, assetIds: string[]): boolean { return Array.isArray(value) && value.length === assetIds.length && value.every((item, index) => item === assetIds[index]); }
function toCaptionStageView(row: { id: string; scope: string; assetId: string | null; mode: string; status: string; progress: Prisma.Decimal; totalAssets: number; completedAssets: number; errorMessage: string | null; confirmedAt: Date | null; createdAt: Date; updatedAt: Date }): TrainingCaptionStageView { return { id: row.id, scope: row.scope.toLowerCase() as TrainingCaptionStageView["scope"], assetId: row.assetId, mode: row.mode.toLowerCase() as TrainingCaptionStageView["mode"], status: row.status.toLowerCase() as TrainingCaptionStageView["status"], progress: Number(row.progress), totalAssets: row.totalAssets, completedAssets: row.completedAssets, errorMessage: row.errorMessage, confirmedAt: row.confirmedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
async function readRequestBuffer(request: IncomingMessage, maximumBytes: number): Promise<Buffer> { const declared = Number(request.headers["content-length"] || 0); if (!Number.isSafeInteger(declared) || declared <= 0 || declared > maximumBytes) throw new TrainingRouteError(413, "dataset_image_size_invalid", "训练图片大小必须在 1B 到 25MB 之间"); const chunks: Buffer[] = []; let total = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += buffer.length; if (total > maximumBytes || total > declared) throw new TrainingRouteError(413, "dataset_image_size_invalid", "训练图片超过大小限制"); chunks.push(buffer); } if (total !== declared) throw new TrainingRouteError(400, "dataset_image_incomplete", "训练图片上传不完整"); return Buffer.concat(chunks); }
function normalizeCaptionHeader(value: string | string[] | undefined): string | null { const raw = Array.isArray(value) ? value[0] : value; if (!raw) return null; try { return decodeURIComponent(raw).trim().slice(0, 10000) || null; } catch { return String(raw).trim().slice(0, 10000) || null; } }
function readRoles(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function authenticateTrainingRuntime(request: IncomingMessage): boolean { const expected = process.env.TRAINING_RUNTIME_TOKEN?.trim(); const received = Array.isArray(request.headers["x-training-runtime-token"]) ? request.headers["x-training-runtime-token"][0] : request.headers["x-training-runtime-token"]; return Boolean(expected && received === expected); }
function readBearerToken(request: IncomingMessage): string | null { const value = request.headers.authorization?.trim() || ""; return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() || null : null; }
function readObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function nullableObject(value: unknown): Record<string, unknown> | null { const object = readObject(value); return Object.keys(object).length ? object : null; }
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
class TrainingRouteError extends Error { public constructor(public readonly status: number, public readonly code: string, message: string) { super(message); } }
function sendTrainingError(response: Parameters<typeof sendError>[0], error: unknown): void { if (error instanceof TrainingRouteError) return sendError(response, error.status, error.code, error.message); if (error instanceof MainPlatformIntegrationError) return sendError(response, error.status, error.code, error.message); const validation = error && typeof error === "object" && "issues" in error; sendError(response, 400, "training_request_failed", validation ? "训练请求参数不正确" : errorMessage(error)); }
