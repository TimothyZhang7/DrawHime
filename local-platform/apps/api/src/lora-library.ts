/**
 * 本文件实现独立 LoRA 仓库的用户草稿、真实文件上传、示例图与发布接口。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import type { ExternalIdentity, Prisma } from "@prisma/client";
import { loraLibraryCreateRequestSchema, loraLibraryUpdateRequestSchema, loraUploadSessionCreateRequestSchema, type LoraLibraryEntryView, type LoraUploadSessionView } from "@drawhime/contracts";
import { database } from "@drawhime/database";
import { deleteObject, getObjectBuffer, putObjectBuffer, putObjectFile, readJsonBody, sendError, sendSuccess, type ServiceRouter } from "@drawhime/service-runtime";
import sharp from "sharp";

const maximumLoraBytes = 512 * 1024 * 1024;
const maximumExampleBytes = 12 * 1024 * 1024;
const loraChunkBytes = 4 * 1024 * 1024;
const uploadDirectory = process.env.LORA_UPLOAD_TEMP_DIR?.trim() || resolve(process.cwd(), "local", "lora-uploads");
const uploadLocks = new Map<string, Promise<void>>();

type SessionRecord = { externalIdentity: ExternalIdentity };
type FindSession = (token: string | null) => Promise<SessionRecord | null>;

/** 在 API 控制面注册 LoRA 仓库写接口。 */
export function registerLoraLibraryRoutes(router: ServiceRouter, findSession: FindSession): void {
  router.get("/v1/lora-library", async ({ request, response, url }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    const mine = url.searchParams.get("mine") === "1";
    const family = url.searchParams.get("family")?.trim() || undefined;
    const entries = await listEntries(session.externalIdentity, mine, family);
    sendSuccess(response, { entries });
  });

  router.get("/v1/lora-library/:id", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      sendSuccess(response, await getAccessibleEntryView(params.id, session.externalIdentity));
    } catch (error) { sendLibraryError(response, error); }
  });

  router.post("/v1/lora-library", async ({ request, response }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const input = loraLibraryCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      const familyName = input.modelFamily.trim();
      const familySlug = normalizeFamilySlug(familyName);
      const entry = await database.$transaction(async (tx) => {
        const family = await tx.modelFamily.upsert({
          where: { slug: familySlug },
          update: { name: familyName, status: "ACTIVE" },
          create: { slug: familySlug, name: familyName, description: `用户登记的 ${familyName} LoRA 主模型系列`, status: "ACTIVE" },
        });
        return tx.loraEntry.create({
          data: {
            ownerIdentityId: session.externalIdentity.id,
            modelFamilyId: family.id,
            slug: `user-${session.externalIdentity.id.slice(0, 8)}-${randomUUID()}`,
            title: input.title,
            description: input.description,
            type: input.type.toUpperCase() as Prisma.LoraEntryCreateInput["type"],
            triggerWords: input.triggerWords,
            isPrivate: input.isPrivate,
            status: "DISABLED",
          },
        });
      });
      sendSuccess(response, await getEntryView(entry.id, session.externalIdentity.id), 201);
    } catch (error) {
      sendLibraryError(response, error);
    }
  });

  router.register("PATCH", "/v1/lora-library/:id", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const input = loraLibraryUpdateRequestSchema.parse(await readJsonBody<unknown>(request));
      const entry = await findOwnedEntry(params.id, session.externalIdentity.id);
      const familyName = input.modelFamily.trim();
      const familySlug = normalizeFamilySlug(familyName);
      await database.$transaction(async (tx) => {
        const family = await tx.modelFamily.upsert({
          where: { slug: familySlug },
          update: { name: familyName, status: "ACTIVE" },
          create: { slug: familySlug, name: familyName, description: `用户登记的 ${familyName} LoRA 主模型系列`, status: "ACTIVE" },
        });
        // 已发布 LoRA 只修改元数据、归类和外显范围，不覆盖模型版本或破坏历史任务引用。
        await tx.loraEntry.update({ where: { id: entry.id }, data: { title: input.title, description: input.description, type: input.type.toUpperCase() as Prisma.LoraEntryUpdateInput["type"], triggerWords: input.triggerWords, isPrivate: input.isPrivate, modelFamilyId: family.id } });
      });
      sendSuccess(response, await getEntryView(entry.id, session.externalIdentity.id));
    } catch (error) { sendLibraryError(response, error); }
  });

  router.post("/v1/lora-library/:id/uploads", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    let temporaryFileName = "";
    try {
      const entry = await findOwnedDraft(params.id, session.externalIdentity.id);
      const input = loraUploadSessionCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      if (!input.fileName.toLowerCase().endsWith(".safetensors")) throw new LoraLibraryError(400, "lora_file_type_invalid", "LoRA 模型文件必须使用 .safetensors 格式");
      await mkdir(uploadDirectory, { recursive: true });
      temporaryFileName = `${randomUUID()}.upload`;
      await writeFile(uploadPath(temporaryFileName), Buffer.alloc(0), { flag: "wx" });
      const upload = await database.loraUploadSession.create({
        data: { loraEntryId: entry.id, fileName: input.fileName, temporaryFileName, totalBytes: BigInt(input.totalBytes), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      });
      sendSuccess(response, toUploadView(upload), 201);
    } catch (error) {
      if (temporaryFileName) await rm(uploadPath(temporaryFileName), { force: true });
      sendLibraryError(response, error);
    }
  });

  router.get("/v1/lora-library/:id/uploads/:uploadId", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const upload = await withUploadLock(params.uploadId, () => reconcileUpload(params.id, params.uploadId, session.externalIdentity.id));
      sendSuccess(response, toUploadView(upload));
    } catch (error) { sendLibraryError(response, error); }
  });

  router.register("PUT", "/v1/lora-library/:id/uploads/:uploadId", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const offset = Number(request.headers["x-upload-offset"] ?? Number.NaN);
      const chunk = await readRequestBuffer(request, loraChunkBytes);
      const upload = await withUploadLock(params.uploadId, async () => {
        const current = await reconcileUpload(params.id, params.uploadId, session.externalIdentity.id);
        const receivedBytes = Number(current.receivedBytes);
        const totalBytes = Number(current.totalBytes);
        if (current.status !== "UPLOADING" || current.expiresAt <= new Date()) throw new LoraLibraryError(409, "lora_upload_inactive", "LoRA 上传会话已经结束或过期");
        if (!Number.isSafeInteger(offset) || offset !== receivedBytes) throw new LoraLibraryError(409, "lora_upload_offset_conflict", `上传偏移不一致，服务端当前偏移为 ${receivedBytes}`);
        if (receivedBytes + chunk.length > totalBytes) throw new LoraLibraryError(400, "lora_upload_overflow", "上传分片超过声明文件大小");
        await appendFile(uploadPath(current.temporaryFileName), chunk);
        return database.loraUploadSession.update({ where: { id: current.id }, data: { receivedBytes: BigInt(receivedBytes + chunk.length) } });
      });
      sendSuccess(response, toUploadView(upload));
    } catch (error) { sendLibraryError(response, error); }
  });

  router.post("/v1/lora-library/:id/uploads/:uploadId/complete", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const entryId = await withUploadLock(params.uploadId, async () => {
        const upload = await reconcileUpload(params.id, params.uploadId, session.externalIdentity.id);
        const byteSize = Number(upload.receivedBytes);
        if (upload.status !== "UPLOADING" || byteSize !== Number(upload.totalBytes)) throw new LoraLibraryError(409, "lora_upload_incomplete", "LoRA 文件尚未完整上传");
        const path = uploadPath(upload.temporaryFileName);
        await validateSafetensors(path, byteSize);
        const sha256 = await hashFile(path);
        const gpuFileName = `drawhime_lora_${sha256}.safetensors`;
        const objectKey = `loras/user/${upload.loraEntry.ownerIdentityId}/${upload.loraEntryId}/${sha256}.safetensors`;
        await putObjectFile(objectKey, path, "application/octet-stream", byteSize);
        await database.$transaction([
          database.loraVersion.updateMany({ where: { loraEntryId: upload.loraEntryId, status: "ACTIVE" }, data: { status: "ARCHIVED" } }),
          database.loraVersion.create({ data: { loraEntryId: upload.loraEntryId, version: `${Date.now()}`, objectKey, fileName: gpuFileName, sha256, byteSize: BigInt(byteSize), status: "ACTIVE", metadata: { source: "user-chunk-upload", originalFileName: upload.fileName } } }),
          database.loraUploadSession.update({ where: { id: upload.id }, data: { status: "COMPLETED" } }),
        ]);
        await rm(path, { force: true });
        return upload.loraEntryId;
      });
      sendSuccess(response, await getEntryView(entryId, session.externalIdentity.id));
    } catch (error) { sendLibraryError(response, error); }
  });

  router.delete("/v1/lora-library/:id/uploads/:uploadId", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      await withUploadLock(params.uploadId, async () => {
        const upload = await findOwnedUpload(params.id, params.uploadId, session.externalIdentity.id);
        if (upload.status === "COMPLETED") throw new LoraLibraryError(409, "lora_upload_completed", "已完成上传会话不允许取消");
        await database.loraUploadSession.update({ where: { id: upload.id }, data: { status: "CANCELLED" } });
        await rm(uploadPath(upload.temporaryFileName), { force: true });
      });
      sendSuccess(response, { cancelled: true });
    } catch (error) { sendLibraryError(response, error); }
  });

  router.register("PUT", "/v1/lora-library/:id/file", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    let temporaryPath = "";
    try {
      const entry = await findOwnedDraft(params.id, session.externalIdentity.id);
      const originalFileName = decodeFileName(request.headers["x-file-name"]);
      if (!originalFileName.toLowerCase().endsWith(".safetensors")) throw new LoraLibraryError(400, "lora_file_type_invalid", "LoRA 模型文件必须使用 .safetensors 格式");
      const streamed = await streamRequestToFile(request, maximumLoraBytes);
      temporaryPath = streamed.path;
      await validateSafetensors(streamed.path, streamed.byteSize);
      const gpuFileName = `drawhime_lora_${streamed.sha256}.safetensors`;
      const objectKey = `loras/user/${entry.ownerIdentityId}/${entry.id}/${streamed.sha256}.safetensors`;
      await putObjectFile(objectKey, streamed.path, "application/octet-stream", streamed.byteSize);
      const version = `${Date.now()}`;
      await database.$transaction([
        database.loraVersion.updateMany({ where: { loraEntryId: entry.id, status: "ACTIVE" }, data: { status: "ARCHIVED" } }),
        database.loraVersion.create({
          data: {
            loraEntryId: entry.id,
            version,
            objectKey,
            fileName: gpuFileName,
            sha256: streamed.sha256,
            byteSize: BigInt(streamed.byteSize),
            status: "ACTIVE",
            metadata: { source: "user-upload", originalFileName },
          },
        }),
      ]);
      sendSuccess(response, await getEntryView(entry.id, session.externalIdentity.id));
    } catch (error) {
      sendLibraryError(response, error);
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true });
    }
  });

  router.post("/v1/lora-library/:id/examples", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const entry = await findOwnedEntry(params.id, session.externalIdentity.id);
      const currentCount = await database.loraExample.count({ where: { loraEntryId: entry.id } });
      if (currentCount >= 8) throw new LoraLibraryError(400, "lora_examples_limit", "每个 LoRA 最多上传 8 张示例图");
      const source = await readRequestBuffer(request, maximumExampleBytes);
      const rendered = await sharp(source, { failOn: "error", limitInputPixels: 80_000_000 })
        .rotate()
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 92, effort: 5, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
      const buffer = rendered.data;
      const width = rendered.info.width;
      const height = rendered.info.height;
      if (!width || !height) throw new LoraLibraryError(400, "lora_example_invalid", "示例图尺寸读取失败");
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const objectKey = `loras/examples/${entry.id}/${randomUUID()}-${sha256.slice(0, 12)}.webp`;
      await putObjectBuffer(objectKey, buffer, "image/webp");
      await database.$transaction(async (tx) => {
        const artifact = await tx.jobArtifact.create({
          data: {
            jobId: null,
            kind: "PREVIEW_IMAGE",
            objectKey,
            fileName: `${entry.slug}-example-${currentCount + 1}.webp`,
            mimeType: "image/webp",
            sha256,
            byteSize: BigInt(buffer.length),
            width,
            height,
            metadata: { source: "user-upload" },
          },
        });
        await tx.loraExample.create({ data: { loraEntryId: entry.id, artifactId: artifact.id, sortOrder: currentCount } });
      });
      sendSuccess(response, await getEntryView(entry.id, session.externalIdentity.id));
    } catch (error) {
      sendLibraryError(response, error);
    }
  });

  router.post("/v1/lora-library/:id/publish", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const entry = await findOwnedDraft(params.id, session.externalIdentity.id);
      const [versionCount, exampleCount] = await Promise.all([
        database.loraVersion.count({ where: { loraEntryId: entry.id, status: "ACTIVE" } }),
        database.loraExample.count({ where: { loraEntryId: entry.id } }),
      ]);
      if (versionCount !== 1) throw new LoraLibraryError(400, "lora_file_required", "发布前必须上传一个有效 LoRA 模型文件");
      if (exampleCount < 1) throw new LoraLibraryError(400, "lora_example_required", "发布前必须上传至少一张示例图");
      await database.loraEntry.update({ where: { id: entry.id }, data: { status: "ACTIVE" } });
      sendSuccess(response, await getEntryView(entry.id, session.externalIdentity.id));
    } catch (error) {
      sendLibraryError(response, error);
    }
  });

  router.delete("/v1/lora-library/:id/examples/:exampleId", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const entry = await findOwnedEntry(params.id, session.externalIdentity.id);
      const example = await database.loraExample.findFirst({ where: { id: params.exampleId, loraEntryId: entry.id }, include: { artifact: true } });
      if (!example) throw new LoraLibraryError(404, "lora_example_not_found", "LoRA 示例图不存在");
      const count = await database.loraExample.count({ where: { loraEntryId: entry.id } });
      if (entry.status === "ACTIVE" && count <= 1) throw new LoraLibraryError(409, "lora_example_required", "已发布 LoRA 必须保留至少一张示例图");
      await database.$transaction([database.loraExample.delete({ where: { id: example.id } }), database.jobArtifact.delete({ where: { id: example.artifactId } })]);
      await deleteObject(example.artifact.objectKey).catch(() => undefined);
      sendSuccess(response, await getEntryView(entry.id, session.externalIdentity.id));
    } catch (error) { sendLibraryError(response, error); }
  });

  router.delete("/v1/lora-library/:id", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const entry = await findOwnedEntry(params.id, session.externalIdentity.id);
      const assets = await database.loraEntry.findUniqueOrThrow({
        where: { id: entry.id },
        include: { versions: true, examples: { include: { artifact: true } }, uploadSessions: true },
      });
      // 训练输出有外键引用，已发布条目也可能被历史任务使用；这些情况只能安全下架，禁止删除真实产物。
      const hasTrainingOutput = assets.versions.length > 0 && await database.trainingJob.count({ where: { outputLoraVersionId: { in: assets.versions.map((item) => item.id) } } }) > 0;
      if (entry.status === "ACTIVE" || hasTrainingOutput) {
        await database.$transaction([
          database.loraVersion.updateMany({ where: { loraEntryId: entry.id }, data: { status: "DISABLED" } }),
          database.loraEntry.update({ where: { id: entry.id }, data: { status: "DISABLED", isPrivate: true, deletedAt: new Date() } }),
        ]);
        return sendSuccess(response, { deleted: true, archived: true });
      }
      await database.$transaction(async (tx) => {
        await tx.loraExample.deleteMany({ where: { loraEntryId: entry.id } });
        await tx.jobArtifact.deleteMany({ where: { id: { in: assets.examples.map((item) => item.artifactId) } } });
        await tx.loraVersion.deleteMany({ where: { loraEntryId: entry.id } });
        await tx.loraEntry.delete({ where: { id: entry.id } });
      });
      const objectKeys = [...assets.versions.map((item) => item.objectKey), ...assets.examples.map((item) => item.artifact.objectKey)];
      await Promise.allSettled(objectKeys.map((objectKey) => deleteObject(objectKey)));
      await Promise.allSettled(assets.uploadSessions.map((upload) => rm(uploadPath(upload.temporaryFileName), { force: true })));
      sendSuccess(response, { deleted: true });
    } catch (error) {
      sendLibraryError(response, error);
    }
  });

  router.get("/v1/lora-library/examples/:id/content", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    const example = await database.loraExample.findUnique({ where: { id: params.id }, include: { artifact: true, loraEntry: true } });
    const admin = readRoles(session.externalIdentity.roles).includes("admin");
    const visible = example && !example.loraEntry.deletedAt && example.loraEntry.status === "ACTIVE" && !example.loraEntry.isPrivate;
    if (!example || example.loraEntry.deletedAt || (!visible && example.loraEntry.ownerIdentityId !== session.externalIdentity.id && !admin)) {
      return sendError(response, 404, "lora_example_not_found", "LoRA 示例图不存在");
    }
    const object = await getObjectBuffer(example.artifact.objectKey);
    response.writeHead(200, { "content-type": example.artifact.mimeType, "content-length": String(object.body.length), "cache-control": visible ? "public, max-age=86400" : "private, no-store" });
    response.end(object.body);
  });
}

/** 查询公开仓库或当前用户自己的草稿。 */
async function listEntries(identity: ExternalIdentity, mine: boolean, family?: string): Promise<LoraLibraryEntryView[]> {
  const admin = readRoles(identity.roles).includes("admin");
  const visibility = mine
    ? { ownerIdentityId: identity.id }
    : admin
      ? {}
      : { OR: [{ status: "ACTIVE" as const, isPrivate: false }, { ownerIdentityId: identity.id }] };
  const rows = await database.loraEntry.findMany({
    where: {
      deletedAt: null,
      ...(family ? { modelFamily: { slug: normalizeFamilySlug(family) } } : {}),
      ...visibility,
    },
    include: {
      owner: true,
      modelFamily: true,
      versions: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1 },
      examples: { include: { artifact: true }, orderBy: { sortOrder: "asc" } },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return rows.map((entry) => toEntryView(entry, identity.id));
}

/** 加载一个带文件和示例图的仓库条目视图。 */
async function getEntryView(id: string, viewerIdentityId: string): Promise<LoraLibraryEntryView> {
  const entry = await database.loraEntry.findUniqueOrThrow({
    where: { id },
    include: { owner: true, modelFamily: true, versions: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1 }, examples: { include: { artifact: true }, orderBy: { sortOrder: "asc" } } },
  });
  return toEntryView(entry, viewerIdentityId, await listReferenceTasks(entry.id));
}

/** 按公开范围、作者或管理员身份读取详情，私有条目对其他用户统一表现为不存在。 */
async function getAccessibleEntryView(id: string, identity: ExternalIdentity): Promise<LoraLibraryEntryView> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new LoraLibraryError(400, "lora_id_invalid", "LoRA 条目 ID 不正确");
  // 图库历史任务固化的是版本 ID；详情查询同时接受条目 ID 与版本 ID，并始终归一到唯一 LoRA 条目。
  const entry = await database.loraEntry.findFirst({ where: { OR: [{ id }, { versions: { some: { id } } }] }, include: { owner: true, modelFamily: true, versions: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1 }, examples: { include: { artifact: true }, orderBy: { sortOrder: "asc" } } } });
  const admin = readRoles(identity.roles).includes("admin");
  if (!entry || entry.deletedAt || (!admin && entry.ownerIdentityId !== identity.id && (entry.status !== "ACTIVE" || entry.isPrivate))) throw new LoraLibraryError(404, "lora_not_found", "LoRA 不存在或未公开");
  return toEntryView(entry, identity.id, await listReferenceTasks(entry.id));
}

/** 查询最近引用当前 LoRA 的公开图库任务，严格排除私密、未发布和已删除记录。 */
async function listReferenceTasks(loraEntryId: string): Promise<LoraLibraryEntryView["referenceTasks"]> {
  const versions = await database.loraVersion.findMany({ where: { loraEntryId }, select: { id: true } });
  if (versions.length === 0) return [];
  const jobs = await database.inferenceJob.findMany({
    where: {
      status: "SUCCEEDED",
      deletedAt: null,
      galleryPublication: { status: "PUBLISHED", mediaUrl: { not: null }, mainGalleryItemId: { not: null } },
      artifacts: { some: { kind: "GENERATED_IMAGE" } },
      AND: [
        { parameters: { path: "$.isPrivate", equals: false } },
        { OR: versions.map((version) => ({ parameters: { path: "$.loraVersionIds", array_contains: version.id } })) },
      ],
    },
    select: {
      id: true,
      requestedPrompt: true,
      createdAt: true,
      externalIdentity: { select: { displayName: true } },
      modelVersion: { select: { displayName: true } },
      galleryPublication: { select: { mediaUrl: true, mainGalleryItemId: true } },
      artifacts: { where: { kind: "GENERATED_IMAGE" }, orderBy: { createdAt: "asc" }, take: 1, select: { width: true, height: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  return jobs.flatMap((job) => {
    const publication = job.galleryPublication;
    if (!publication?.mediaUrl || !publication.mainGalleryItemId) return [];
    const artifact = job.artifacts[0];
    return [{
      id: job.id,
      prompt: job.requestedPrompt,
      modelDisplayName: job.modelVersion.displayName,
      ownerDisplayName: job.externalIdentity.displayName,
      imageUrl: publication.mediaUrl,
      galleryItemId: publication.mainGalleryItemId,
      width: artifact?.width ?? null,
      height: artifact?.height ?? null,
      createdAt: job.createdAt.toISOString(),
    }];
  });
}

type EntryWithRelations = Awaited<ReturnType<typeof loadEntryWithRelations>>;

/** 仅用于复用 Prisma 推导类型，不在业务链路额外查询。 */
async function loadEntryWithRelations(id: string) {
  return database.loraEntry.findUniqueOrThrow({
    where: { id },
    include: { owner: true, modelFamily: true, versions: { where: { status: "ACTIVE" }, take: 1 }, examples: { include: { artifact: true } } },
  });
}

/** 把数据库条目转换成不暴露对象存储键的用户视图。 */
function toEntryView(entry: EntryWithRelations, viewerIdentityId: string, referenceTasks: LoraLibraryEntryView["referenceTasks"] = []): LoraLibraryEntryView {
  const version = entry.versions[0];
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    type: entry.type.toLowerCase() as LoraLibraryEntryView["type"],
    modelFamily: entry.modelFamily.slug,
    modelFamilyName: entry.modelFamily.name,
    triggerWords: Array.isArray(entry.triggerWords) ? entry.triggerWords.filter((item): item is string => typeof item === "string") : [],
    ownerDisplayName: entry.owner.displayName,
    privacy: entry.isPrivate ? "private" : "public",
    isOwner: entry.ownerIdentityId === viewerIdentityId,
    status: entry.status === "ACTIVE" ? "published" : "draft",
    version: version ? { id: version.id, fileName: version.fileName, sha256: version.sha256, byteSize: Number(version.byteSize) } : null,
    examples: entry.examples.map((example) => ({ id: example.id, width: example.artifact.width, height: example.artifact.height, contentUrl: `/local-model-api/v1/lora-library/examples/${example.id}/content` })),
    referenceTasks,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

/** 查找当前作者的 LoRA，允许详情页编辑已发布条目的元数据和隐私。 */
async function findOwnedEntry(id: string, ownerIdentityId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new LoraLibraryError(400, "lora_id_invalid", "LoRA 条目 ID 不正确");
  const entry = await database.loraEntry.findFirst({ where: { id, ownerIdentityId, deletedAt: null } });
  if (!entry) throw new LoraLibraryError(404, "lora_not_found", "LoRA 不存在");
  return entry;
}

/** 查找当前用户尚未发布的草稿，发布后内容保持不可变。 */
async function findOwnedDraft(id: string, ownerIdentityId: string) {
  const entry = await findOwnedEntry(id, ownerIdentityId);
  if (entry.status === "ACTIVE") throw new LoraLibraryError(409, "lora_already_published", "已发布 LoRA 不允许覆盖文件或示例图");
  return entry;
}

/** 流式接收 LoRA 到受控临时文件，同时计算真实字节数和 SHA-256。 */
async function streamRequestToFile(request: IncomingMessage, maximumBytes: number): Promise<{ path: string; byteSize: number; sha256: string }> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > maximumBytes) throw new LoraLibraryError(413, "lora_file_size_invalid", "LoRA 文件大小必须在 1B 到 512MB 之间");
  const path = join(tmpdir(), `drawhime-lora-${randomUUID()}.upload`);
  const hash = createHash("sha256");
  let byteSize = 0;
  request.on("data", (chunk: Buffer) => {
    byteSize += chunk.length;
    hash.update(chunk);
    if (byteSize > maximumBytes || byteSize > declared) request.destroy(new Error("LoRA 文件超过声明大小"));
  });
  try {
    await pipeline(request, createWriteStream(path, { flags: "wx" }));
    if (byteSize !== declared) throw new Error("LoRA 文件接收不完整");
    return { path, byteSize, sha256: hash.digest("hex") };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

/** 校验 safetensors 固定头和 JSON 元数据，避免任意二进制进入模型仓库。 */
async function validateSafetensors(path: string, byteSize: number): Promise<void> {
  const file = await open(path, "r");
  try {
    const prefix = Buffer.alloc(8);
    await file.read(prefix, 0, 8, 0);
    const headerBytes = Number(prefix.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerBytes) || headerBytes < 2 || headerBytes > 16 * 1024 * 1024 || headerBytes + 8 >= byteSize) throw new Error("safetensors 文件头长度不正确");
    const header = Buffer.alloc(headerBytes);
    await file.read(header, 0, headerBytes, 8);
    const metadata = JSON.parse(header.toString("utf8")) as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("safetensors 元数据不正确");
  } catch {
    throw new LoraLibraryError(400, "lora_safetensors_invalid", "LoRA safetensors 文件内容不正确");
  } finally {
    await file.close();
  }
}

/** 查找当前作者的上传会话，禁止跨草稿或跨用户续传。 */
async function findOwnedUpload(entryId: string, uploadId: string, ownerIdentityId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new LoraLibraryError(400, "lora_upload_id_invalid", "LoRA 上传会话 ID 不正确");
  const upload = await database.loraUploadSession.findFirst({
    where: { id: uploadId, loraEntryId: entryId, loraEntry: { ownerIdentityId, status: "DISABLED" } },
    include: { loraEntry: true },
  });
  if (!upload) throw new LoraLibraryError(404, "lora_upload_not_found", "LoRA 上传会话不存在");
  return upload;
}

/** 以临时文件真实长度修正数据库偏移，保证进程重启和响应丢失后仍可续传。 */
async function reconcileUpload(entryId: string, uploadId: string, ownerIdentityId: string) {
  const upload = await findOwnedUpload(entryId, uploadId, ownerIdentityId);
  if (upload.status !== "UPLOADING") return upload;
  let actualBytes = 0;
  try { actualBytes = (await stat(uploadPath(upload.temporaryFileName))).size; }
  catch { throw new LoraLibraryError(409, "lora_upload_file_missing", "LoRA 上传临时文件不存在，请重新创建上传会话"); }
  if (actualBytes > Number(upload.totalBytes)) throw new LoraLibraryError(409, "lora_upload_file_corrupt", "LoRA 上传临时文件长度异常");
  return actualBytes === Number(upload.receivedBytes) ? upload : database.loraUploadSession.update({ where: { id: upload.id }, data: { receivedBytes: BigInt(actualBytes) }, include: { loraEntry: true } });
}

/** 上传会话视图不暴露服务端临时文件名和路径。 */
function toUploadView(upload: { id: string; loraEntryId: string; fileName: string; totalBytes: bigint; receivedBytes: bigint; status: string; expiresAt: Date }): LoraUploadSessionView {
  return {
    id: upload.id,
    loraEntryId: upload.loraEntryId,
    fileName: upload.fileName,
    totalBytes: Number(upload.totalBytes),
    receivedBytes: Number(upload.receivedBytes),
    chunkSizeBytes: loraChunkBytes,
    status: upload.status.toLowerCase() as LoraUploadSessionView["status"],
    expiresAt: upload.expiresAt.toISOString(),
  };
}

/** 同一上传会话串行执行偏移读取、文件追加和数据库回写。 */
async function withUploadLock<T>(uploadId: string, operation: () => Promise<T>): Promise<T> {
  const previous = uploadLocks.get(uploadId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const queued = previous.then(() => gate);
  uploadLocks.set(uploadId, queued);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (uploadLocks.get(uploadId) === queued) uploadLocks.delete(uploadId);
  }
}

/** 按流计算完整 LoRA 文件 SHA-256，避免把大文件加载到内存。 */
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** 只接受数据库生成的 UUID 临时文件名，避免路径穿越。 */
function uploadPath(temporaryFileName: string): string {
  if (!/^[0-9a-f-]{36}\.upload$/i.test(temporaryFileName)) throw new LoraLibraryError(500, "lora_upload_path_invalid", "LoRA 上传临时文件名不正确");
  return join(uploadDirectory, temporaryFileName);
}

/** 读取受限示例图请求体。 */
async function readRequestBuffer(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    byteSize += buffer.length;
    if (byteSize > maximumBytes) throw new LoraLibraryError(413, "lora_example_too_large", "LoRA 示例图不能超过 12MB");
    chunks.push(buffer);
  }
  if (byteSize === 0) throw new LoraLibraryError(400, "lora_example_empty", "LoRA 示例图内容为空");
  return Buffer.concat(chunks);
}

/** 主模型系列统一成稳定全局筛选键，中文自定义值使用内容摘要避免碰撞。 */
function normalizeFamilySlug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  return normalized || `custom-${createHash("sha256").update(value.trim()).digest("hex").slice(0, 16)}`;
}

/** 安全解码浏览器上传文件名，仅保存末段显示名。 */
function decodeFileName(value: string | string[] | undefined): string {
  const raw = String(Array.isArray(value) ? value[0] ?? "" : value ?? "model.safetensors");
  try {
    return decodeURIComponent(raw).split(/[\\/]/).pop()?.slice(0, 255) || "model.safetensors";
  } catch {
    return "model.safetensors";
  }
}

/** 从本地会话请求读取 Bearer token。 */
function readBearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization?.trim() || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() || null : null;
}

/** 从身份 JSON 读取主站角色。 */
function readRoles(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** LoRA 仓库业务错误。 */
class LoraLibraryError extends Error {
  public constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/** 统一映射仓库输入、图片和存储异常。 */
function sendLibraryError(response: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof LoraLibraryError) return sendError(response, error.status, error.code, error.message);
  const issue = error && typeof error === "object" && "issues" in error ? "LoRA 表单参数不正确" : error instanceof Error ? error.message : "LoRA 仓库操作失败";
  sendError(response, 400, "lora_library_failed", issue);
}
