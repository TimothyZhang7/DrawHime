/**
 * 本文件实现用户 Anima 底模在主站 data 盘的分片上传、结构校验、目录登记和 Range 下载。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import type { ExternalIdentity, Prisma } from "@prisma/client";
import { modelUploadSessionCreateRequestSchema, type ModelUploadSessionCreateRequest, type ModelUploadSessionView } from "@drawhime/contracts";
import { database } from "@drawhime/database";
import { readJsonBody, sendError, sendSuccess, type ServiceRouter } from "@drawhime/service-runtime";
import { animaComponentDefaults } from "./anima-components.js";

const modelChunkBytes = 8 * 1024 * 1024;
const maximumModelBytes = 16 * 1024 * 1024 * 1024;
const uploadLocks = new Map<string, Promise<void>>();
type SessionRecord = { externalIdentity: ExternalIdentity };
type FindSession = (token: string | null) => Promise<SessionRecord | null>;

/** 注册用户底模上传和唯一主站下载接口。 */
export function registerModelUploadRoutes(router: ServiceRouter, findSession: FindSession): void {
  router.post("/v1/model-library/uploads", async ({ request, response }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    let temporaryFileName = "";
    try {
      const input = modelUploadSessionCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      if (input.totalBytes > maximumModelBytes) throw new ModelUploadError(413, "model_file_too_large", "底模文件不能超过 16GB");
      const activeCount = await database.modelUploadSession.count({ where: { ownerIdentityId: session.externalIdentity.id, status: { in: ["UPLOADING", "PROCESSING"] } } });
      if (activeCount >= 3) throw new ModelUploadError(409, "model_upload_limit", "当前已有 3 个未完成的底模上传");
      await mkdir(uploadRoot(), { recursive: true });
      temporaryFileName = `${randomUUID()}.upload`;
      await open(uploadPath(temporaryFileName), "wx").then((file) => file.close());
      const upload = await database.modelUploadSession.create({
        data: {
          ownerIdentityId: session.externalIdentity.id,
          fileName: input.fileName,
          temporaryFileName,
          totalBytes: BigInt(input.totalBytes),
          metadata: input as unknown as Prisma.InputJsonObject,
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
      });
      sendSuccess(response, toUploadView(upload), 201);
    } catch (error) {
      if (temporaryFileName) await rm(uploadPath(temporaryFileName), { force: true }).catch(() => undefined);
      sendModelUploadError(response, error);
    }
  });

  router.get("/v1/model-library/uploads/:uploadId", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const upload = await withUploadLock(params.uploadId, () => reconcileUpload(params.uploadId, session.externalIdentity.id));
      sendSuccess(response, toUploadView(upload));
    } catch (error) { sendModelUploadError(response, error); }
  });

  router.register("PUT", "/v1/model-library/uploads/:uploadId", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const offset = Number(request.headers["x-upload-offset"] ?? Number.NaN);
      const chunk = await readRequestBuffer(request, modelChunkBytes);
      const upload = await withUploadLock(params.uploadId, async () => {
        const current = await reconcileUpload(params.uploadId, session.externalIdentity.id);
        if (current.status !== "UPLOADING") throw new ModelUploadError(409, "model_upload_not_writable", "底模上传已经结束或正在校验");
        if (!Number.isSafeInteger(offset) || offset !== Number(current.receivedBytes)) throw new ModelUploadError(409, "model_upload_offset_conflict", `上传偏移不一致，当前偏移为 ${current.receivedBytes}`);
        if (offset + chunk.length > Number(current.totalBytes)) throw new ModelUploadError(413, "model_upload_overflow", "上传内容超过声明的底模大小");
        await appendFile(uploadPath(current.temporaryFileName), chunk);
        return database.modelUploadSession.update({ where: { id: current.id }, data: { receivedBytes: BigInt(offset + chunk.length), expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000), errorMessage: null } });
      });
      sendSuccess(response, toUploadView(upload));
    } catch (error) { sendModelUploadError(response, error); }
  });

  router.post("/v1/model-library/uploads/:uploadId/complete", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const modelId = await withUploadLock(params.uploadId, () => completeUpload(params.uploadId, session.externalIdentity.id));
      sendSuccess(response, { modelVersionId: modelId });
    } catch (error) { sendModelUploadError(response, error); }
  });

  router.delete("/v1/model-library/uploads/:uploadId", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const upload = await withUploadLock(params.uploadId, async () => {
        const current = await findOwnedUpload(params.uploadId, session.externalIdentity.id);
        if (current.status === "COMPLETED") throw new ModelUploadError(409, "model_upload_completed", "已完成的底模不能通过上传会话删除");
        await database.modelUploadSession.delete({ where: { id: current.id } });
        await rm(uploadPath(current.temporaryFileName), { force: true });
        return current;
      });
      sendSuccess(response, { id: upload.id, deleted: true });
    } catch (error) { sendModelUploadError(response, error); }
  });

  router.get("/v1/model-library/:id/download", async ({ request, response, params }) => {
    const session = await requireSession(request, response, findSession); if (!session) return;
    try {
      const model = await database.modelVersion.findFirst({ where: { id: params.id, status: "ACTIVE" }, select: { defaultParameters: true } });
      if (!model) throw new ModelUploadError(404, "model_not_found", "底模不存在");
      const defaults = readObject(model.defaultParameters);
      const fileName = safeStorageFileName(defaults.desktopStorageFileName);
      const sha256 = readSha256(defaults.modelSha256);
      const totalBytes = readPositiveInteger(defaults.modelByteSize);
      if (!fileName || !sha256 || !totalBytes || defaults.desktopDownloadEnabled !== true) throw new ModelUploadError(404, "model_download_unavailable", "该底模尚未提供主站下载文件");
      const path = storagePath(fileName);
      const file = await stat(path).catch(() => null);
      if (!file?.isFile() || file.size !== totalBytes) throw new ModelUploadError(503, "model_download_not_ready", "主站底模文件正在维护");
      const range = parseModelDownloadRange(request.headers.range, totalBytes);
      if (range === "invalid") { response.writeHead(416, { "content-range": `bytes */${totalBytes}`, "accept-ranges": "bytes", "cache-control": "no-store" }); response.end(); return; }
      const start = range?.start ?? 0;
      const end = range?.end ?? totalBytes - 1;
      response.writeHead(range ? 206 : 200, {
        "content-type": "application/octet-stream",
        "content-length": String(end - start + 1),
        "content-disposition": `attachment; filename="${fileName}"`,
        "accept-ranges": "bytes",
        "etag": `"${sha256}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        ...(range ? { "content-range": `bytes ${start}-${end}/${totalBytes}` } : {}),
      });
      await new Promise<void>((resolvePromise, reject) => {
        const stream = createReadStream(path, { start, end });
        stream.once("error", reject); response.once("error", reject); response.once("finish", resolvePromise); stream.pipe(response);
      });
    } catch (error) {
      if (!response.headersSent) return sendModelUploadError(response, error);
      if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error("底模下载失败"));
    }
  });
}

/** 完整校验临时文件后原子发布到资源根目录，并创建只由在线目录驱动的桌面底模记录。 */
async function completeUpload(uploadId: string, ownerIdentityId: string): Promise<string> {
  const upload = await reconcileUpload(uploadId, ownerIdentityId);
  if (upload.status === "COMPLETED" && upload.modelVersionId) return upload.modelVersionId;
  if (upload.status !== "UPLOADING") throw new ModelUploadError(409, "model_upload_not_completable", "底模上传当前不能完成");
  if (upload.receivedBytes !== upload.totalBytes) throw new ModelUploadError(409, "model_upload_incomplete", `底模尚未上传完整：${upload.receivedBytes}/${upload.totalBytes}`);
  await database.modelUploadSession.update({ where: { id: upload.id }, data: { status: "PROCESSING", errorMessage: null } });
  const temporaryPath = uploadPath(upload.temporaryFileName);
  try {
    await validateAnimaSafetensors(temporaryPath, Number(upload.totalBytes));
    const sha256 = await sha256File(temporaryPath);
    const metadata = modelUploadSessionCreateRequestSchema.parse(upload.metadata);
    const duplicate = await findDuplicateSha256(sha256);
    if (duplicate) throw new ModelUploadError(409, "model_file_registered", "该底模内容已经存在于仓库");
    const storageFileName = `community-${sha256.slice(0, 12)}-${metadata.fileName}`;
    const destination = storagePath(storageFileName);
    const existing = await stat(destination).catch(() => null);
    if (existing) {
      if (!existing.isFile() || existing.size !== Number(upload.totalBytes) || await sha256File(destination) !== sha256) throw new ModelUploadError(409, "model_storage_collision", "主站存在同名但内容不同的资源文件");
      await rm(temporaryPath, { force: true });
    } else {
      await rename(temporaryPath, destination);
    }
    const family = await database.modelFamily.upsert({ where: { slug: "anima" }, update: { name: "Anima", status: "ACTIVE" }, create: { slug: "anima", name: "Anima", description: "Anima 本地动漫图像模型系列", status: "ACTIVE" } });
    // 模型目录与上传终态必须原子提交，API 中断不会留下目录和会话相互矛盾的状态。
    const model = await database.$transaction(async (transaction) => {
      const created = await transaction.modelVersion.create({
        data: {
          familyId: family.id,
          version: storageFileName,
          displayName: metadata.displayName,
          description: metadata.description,
          status: "ACTIVE",
          runtimeFormat: "anima",
          defaultParameters: buildCommunityDefaults(metadata, sha256, storageFileName, ownerIdentityId),
        },
      });
      await transaction.modelUploadSession.update({ where: { id: upload.id }, data: { status: "COMPLETED", modelVersionId: created.id, receivedBytes: upload.totalBytes, expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), errorMessage: null } });
      return created;
    });
    return model.id;
  } catch (error) {
    await database.modelUploadSession.update({ where: { id: upload.id }, data: { status: "FAILED", errorMessage: errorMessage(error) } }).catch(() => undefined);
    throw error;
  }
}

/** 用户上传模型默认仅进入桌面仓库；没有 GPU 分发前不创建平台推理工作流。 */
function buildCommunityDefaults(input: ModelUploadSessionCreateRequest, sha256: string, storageFileName: string, ownerIdentityId: string): Prisma.InputJsonObject {
  const profile = input.parameters;
  return {
    width: 1024, height: 1024, maxAttempts: 3, promptEnhancementEnabled: true,
    priceCny: "0.00", repositoryVisible: true, platformInferenceEnabled: false,
    repositoryOwnerIdentityId: ownerIdentityId, sourceUrls: input.sourceUrls, sourceUrl: null, usageGuide: input.usageGuide,
    modelSha256: sha256, modelByteSize: input.totalBytes, desktopStorageFileName: storageFileName, desktopDownloadEnabled: true,
    steps: profile.steps, cfg: profile.cfg, sampler: profile.sampler, scheduler: profile.scheduler,
    samplingMaxEdge: profile.samplingMaxEdge, samplingPixelBudget: profile.samplingPixelBudget,
    aspectStepThreshold: profile.aspectStepThreshold, aspectAdjustedSteps: profile.presets.quality.aspectAdjustedSteps,
    maxEdge: profile.maxEdge, qualityPrefix: profile.qualityPrefix, defaultNegativePrompt: profile.defaultNegativePrompt,
    availableSamplers: profile.availableSamplers, availableSchedulers: profile.availableSchedulers,
    generationPresets: profile.presets, trainingSupported: false, systemTurboLoraEnabled: false, systemHighresLoraEnabled: false,
    ...animaComponentDefaults(),
  };
}

/** 校验文件是 Anima 完整 UNet，而不是 LoRA、Checkpoint 或任意伪装的 safetensors。 */
export async function validateAnimaSafetensors(path: string, totalBytes: number): Promise<void> {
  const file = await open(path, "r");
  try {
    const prefix = Buffer.alloc(8); await file.read(prefix, 0, 8, 0);
    const headerBytes = Number(prefix.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerBytes) || headerBytes < 2 || headerBytes > 100 * 1024 * 1024 || headerBytes + 8 >= totalBytes) throw new Error("文件头长度不正确");
    const header = Buffer.alloc(headerBytes); await file.read(header, 0, headerBytes, 8);
    const value = JSON.parse(header.toString("utf8")) as Record<string, unknown>;
    const keys = Object.keys(value).filter((key) => key !== "__metadata__");
    const required = ["net.blocks.0.self_attn.q_proj.weight", "net.llm_adapter.embed.weight", "net.x_embedder.proj.1.weight"];
    if (keys.length < 600 || required.some((key) => !(key in value))) throw new Error("缺少 Anima UNet 必需张量");
  } catch {
    throw new ModelUploadError(400, "model_anima_invalid", "上传文件不是有效的 Anima 完整底模");
  } finally { await file.close(); }
}

/** 以流式方式计算完整哈希，避免 4GB 级底模进入 API 堆内存。 */
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }

/** 查询已有目录哈希，目录规模较小且只读取必要 JSON 字段。 */
async function findDuplicateSha256(sha256: string): Promise<string | null> {
  const models = await database.modelVersion.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, defaultParameters: true } });
  return models.find((model) => readSha256(readObject(model.defaultParameters).modelSha256) === sha256)?.id ?? null;
}

/** 用真实临时文件长度修复数据库偏移，支持 API 重启与响应丢失后的继续上传。 */
async function reconcileUpload(id: string, ownerIdentityId: string) {
  const upload = await findOwnedUpload(id, ownerIdentityId);
  if (upload.status !== "UPLOADING") return upload;
  const file = await stat(uploadPath(upload.temporaryFileName)).catch(() => null);
  if (!file?.isFile()) throw new ModelUploadError(409, "model_upload_file_missing", "底模上传临时文件不存在");
  if (file.size > Number(upload.totalBytes)) throw new ModelUploadError(409, "model_upload_file_overflow", "底模上传临时文件超过声明大小");
  return file.size === Number(upload.receivedBytes) ? upload : database.modelUploadSession.update({ where: { id: upload.id }, data: { receivedBytes: BigInt(file.size) } });
}

/** 查找当前用户可操作的上传会话。 */
async function findOwnedUpload(id: string, ownerIdentityId: string) {
  if (!uuidLike(id)) throw new ModelUploadError(400, "model_upload_id_invalid", "底模上传 ID 不正确");
  const upload = await database.modelUploadSession.findFirst({ where: { id, ownerIdentityId } });
  if (!upload) throw new ModelUploadError(404, "model_upload_not_found", "底模上传会话不存在");
  return upload;
}

/** 同一上传会话串行执行偏移变更与完成操作。 */
async function withUploadLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = uploadLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queued = previous.then(() => current);
  uploadLocks.set(id, queued);
  await previous;
  try { return await action(); } finally { release(); if (uploadLocks.get(id) === queued) uploadLocks.delete(id); }
}

/** 读取单个上传分片并实施硬大小限制。 */
async function readRequestBuffer(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer); total += buffer.length; if (total > maximumBytes) throw new ModelUploadError(413, "model_chunk_too_large", "单个底模分片不能超过 8MB"); chunks.push(buffer); }
  if (!total) throw new ModelUploadError(400, "model_chunk_empty", "底模分片不能为空");
  return Buffer.concat(chunks);
}

/** 资源根目录生产环境必须位于 /data；上传临时文件也不落系统盘。 */
function storageRoot(): string {
  return resolveModelStorageRoot(process.env.DESKTOP_RESOURCE_STORAGE_ROOT, process.platform);
}

/** 解析底模资源根目录；Linux 生产及测试都必须明确落到 data 盘。 */
export function resolveModelStorageRoot(configured: string | undefined, platform: NodeJS.Platform): string {
  const value = configured?.trim();
  if (!value) throw new ModelUploadError(503, "model_storage_unconfigured", "主站底模存储目录未配置");
  if (platform === "win32") {
    if (!isAbsolute(value)) throw new ModelUploadError(503, "model_storage_unconfigured", "主站底模存储目录未配置");
    return resolve(value);
  }
  if (!posix.isAbsolute(value)) throw new ModelUploadError(503, "model_storage_unconfigured", "主站底模存储目录未配置");
  const root = posix.resolve(value);
  if (root !== "/data" && !root.startsWith("/data/")) throw new ModelUploadError(503, "model_storage_not_data", "主站底模存储目录必须位于 data 盘");
  return root;
}
function uploadRoot(): string { return join(storageRoot(), ".uploads"); }
function uploadPath(fileName: string): string { return safeChild(uploadRoot(), fileName); }
function storagePath(fileName: string): string { return safeChild(storageRoot(), fileName); }
/** 路径必须是受控根目录的直接子项。 */
function safeChild(root: string, fileName: string): string { if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) throw new ModelUploadError(400, "model_file_name_invalid", "底模文件名不安全"); const path = resolve(root, fileName); const child = relative(root, path); if (!child || child.startsWith("..") || isAbsolute(child)) throw new ModelUploadError(400, "model_file_path_invalid", "底模文件路径不安全"); return path; }

/** 解析标准单段下载范围。 */
export function parseModelDownloadRange(value: string | string[] | undefined, total: number): { start: number; end: number } | null | "invalid" { if (!value) return null; const match = /^bytes=(\d+)-(\d*)$/.exec(String(Array.isArray(value) ? value[0] : value).trim()); if (!match) return "invalid"; const start = Number(match[1]); const end = match[2] ? Number(match[2]) : total - 1; return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end < total ? { start, end } : "invalid"; }
function readObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function readSha256(value: unknown): string | null { const normalized = typeof value === "string" ? value.toLowerCase() : ""; return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null; }
function readPositiveInteger(value: unknown): number | null { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : null; }
function safeStorageFileName(value: unknown): string | null { return typeof value === "string" && /^[a-zA-Z0-9._-]+\.safetensors$/.test(value) ? value : null; }
function uuidLike(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function toUploadView(upload: { id: string; fileName: string; totalBytes: bigint; receivedBytes: bigint; status: string; modelVersionId: string | null; errorMessage: string | null; expiresAt: Date }): ModelUploadSessionView { return { id: upload.id, fileName: upload.fileName, totalBytes: Number(upload.totalBytes), receivedBytes: Number(upload.receivedBytes), status: upload.status.toLowerCase() as ModelUploadSessionView["status"], modelVersionId: upload.modelVersionId, errorMessage: upload.errorMessage, expiresAt: upload.expiresAt.toISOString() }; }
function readBearerToken(request: IncomingMessage): string | null { const value = request.headers.authorization; return value?.startsWith("Bearer ") ? value.slice(7).trim() || null : null; }
async function requireSession(request: IncomingMessage, response: import("node:http").ServerResponse, findSession: FindSession): Promise<SessionRecord | null> { const session = await findSession(readBearerToken(request)); if (!session) sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效"); return session; }
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
function sendModelUploadError(response: import("node:http").ServerResponse, error: unknown): void { if (error instanceof ModelUploadError) sendError(response, error.status, error.code, error.message); else if (error && typeof error === "object" && "issues" in error) sendError(response, 400, "model_upload_input_invalid", "底模上传参数不正确"); else sendError(response, 500, "model_upload_failed", errorMessage(error)); }
class ModelUploadError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ModelUploadError"; } }
