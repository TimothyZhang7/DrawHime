/**
 * 本文件实现桌面本机作品的账号绑定、分片断点上传、完整性校验和主站图库发布。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import type { ExternalIdentity } from "@prisma/client";
import { desktopGalleryUploadCreateRequestSchema, type DesktopGalleryUploadView, type GalleryPublicationCreateRequest } from "@drawhime/contracts";
import { database } from "@drawhime/database";
import { MainPlatformIntegrationError, publishDesktopMainGallery } from "@drawhime/main-platform-client";
import { putObjectFile, readJsonBody, sendError, sendSuccess, type ServiceRouter } from "@drawhime/service-runtime";
import sharp from "sharp";
import { buildDesktopGalleryParameters } from "./desktop-gallery-loras.js";

const maximumArtifactBytes = 100 * 1024 * 1024;
const chunkSizeBytes = 4 * 1024 * 1024;
const uploadDirectory = process.env.DESKTOP_GALLERY_UPLOAD_TEMP_DIR?.trim() || resolve(process.cwd(), "local", "desktop-gallery-uploads");
const uploadLocks = new Map<string, Promise<void>>();

type SessionRecord = { externalIdentity: ExternalIdentity };
type FindSession = (token: string | null) => Promise<SessionRecord | null>;

/** 注册桌面图库上传控制面；每条路由都使用设备会话执行对象级权限检查。 */
export function registerDesktopGalleryRoutes(router: ServiceRouter, findSession: FindSession): void {
  router.post("/v1/desktop/gallery/uploads", async ({ request, response }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "桌面账号授权已失效");
    try {
      const input = desktopGalleryUploadCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      const parameters = await buildDesktopGalleryParameters(input.parameters, input.loras, session.externalIdentity.id);
      await mkdir(uploadDirectory, { recursive: true });
      const existing = await database.desktopGalleryUpload.findUnique({
        where: { externalIdentityId_localTaskId_artifactSha256: { externalIdentityId: session.externalIdentity.id, localTaskId: input.localTaskId, artifactSha256: input.artifactSha256 } },
      });
      if (existing) {
        // 相同产物再次提交时只允许把公开收紧为私有，避免断线重试意外放宽用户隐私。
        const reconciled = await reconcileUpload(existing.id, session.externalIdentity.id);
        const strictPrivacy = reconciled.isPrivate || input.privacy === "private";
        const updated = strictPrivacy === reconciled.isPrivate ? reconciled : await database.desktopGalleryUpload.update({ where: { id: reconciled.id }, data: { isPrivate: strictPrivacy } });
        return sendSuccess(response, toUploadView(updated));
      }
      const temporaryFileName = `${randomUUID()}.upload`;
      await writeFile(uploadPath(temporaryFileName), Buffer.alloc(0), { flag: "wx" });
      try {
        const created = await database.desktopGalleryUpload.create({
          data: {
            externalIdentityId: session.externalIdentity.id,
            localTaskId: input.localTaskId,
            artifactSha256: input.artifactSha256,
            fileName: safeFileName(input.fileName, input.mimeType),
            temporaryFileName,
            mimeType: input.mimeType,
            totalBytes: BigInt(input.byteSize),
            width: input.width,
            height: input.height,
            isPrivate: input.privacy === "private",
            effectivePrompt: input.effectivePrompt,
            negativePrompt: input.negativePrompt?.trim() || null,
            modelDisplayName: input.modelDisplayName,
            parameters,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        });
        return sendSuccess(response, toUploadView(created), 201);
      } catch (error) {
        await rm(uploadPath(temporaryFileName), { force: true });
        throw error;
      }
    } catch (error) { return sendGalleryError(response, error); }
  });

  router.get("/v1/desktop/gallery/uploads/:id", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "桌面账号授权已失效");
    try { sendSuccess(response, toUploadView(await reconcileUpload(params.id, session.externalIdentity.id))); }
    catch (error) { sendGalleryError(response, error); }
  });

  router.register("PUT", "/v1/desktop/gallery/uploads/:id", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "桌面账号授权已失效");
    try {
      const result = await withUploadLock(params.id, async () => {
        const upload = await reconcileUpload(params.id, session.externalIdentity.id);
        if (upload.status !== "UPLOADING") throw new DesktopGalleryError(409, "desktop_upload_closed", "该上传会话已经停止接收分片");
        const offset = Number(readHeader(request.headers["x-upload-offset"]));
        const declared = Number(request.headers["content-length"] ?? 0);
        if (!Number.isSafeInteger(offset) || offset !== Number(upload.receivedBytes)) throw new DesktopGalleryError(409, "desktop_upload_offset_conflict", `上传偏移不一致，服务端偏移为 ${upload.receivedBytes}`);
        if (!Number.isSafeInteger(declared) || declared <= 0 || declared > chunkSizeBytes || offset + declared > Number(upload.totalBytes)) throw new DesktopGalleryError(413, "desktop_upload_chunk_invalid", "上传分片大小不正确");
        const chunk = await readChunk(request, declared);
        await appendFile(uploadPath(upload.temporaryFileName), chunk);
        return database.desktopGalleryUpload.update({ where: { id: upload.id }, data: { receivedBytes: BigInt(offset + chunk.length), errorMessage: null } });
      });
      sendSuccess(response, toUploadView(result));
    } catch (error) { sendGalleryError(response, error); }
  });

  router.post("/v1/desktop/gallery/uploads/:id/complete", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "桌面账号授权已失效");
    try {
      const completed = await withUploadLock(params.id, async () => completeUpload(params.id, session.externalIdentity));
      sendSuccess(response, toUploadView(completed));
    } catch (error) { sendGalleryError(response, error); }
  });
}

/** 完整校验上传文件、持久化对象并以同一幂等键补偿主站发布。 */
async function completeUpload(uploadId: string, identity: ExternalIdentity) {
  let upload = await reconcileUpload(uploadId, identity.id);
  if (upload.status === "PUBLISHED" || upload.status === "REMOTE_DELETED") return upload;
  if (Number(upload.receivedBytes) !== Number(upload.totalBytes)) throw new DesktopGalleryError(409, "desktop_upload_incomplete", "桌面作品尚未完整上传");
  if (!upload.artifactId) {
    const path = uploadPath(upload.temporaryFileName);
    const sha256 = await hashFile(path);
    if (sha256 !== upload.artifactSha256) throw new DesktopGalleryError(409, "desktop_upload_hash_mismatch", "桌面作品 SHA-256 校验失败");
    const metadata = await sharp(path).metadata();
    const detectedMime = mimeFromSharp(metadata.format);
    if (detectedMime !== upload.mimeType || metadata.width !== upload.width || metadata.height !== upload.height) throw new DesktopGalleryError(409, "desktop_upload_image_mismatch", "桌面作品格式或尺寸与任务快照不一致");
    const artifactId = randomUUID();
    const objectKey = `desktop-gallery/${identity.id}/${upload.id}/${upload.artifactSha256}${extensionForMime(upload.mimeType)}`;
    await putObjectFile(objectKey, path, upload.mimeType, Number(upload.totalBytes));
    upload = await database.$transaction(async (transaction) => {
      await transaction.jobArtifact.create({
        data: { id: artifactId, kind: "GENERATED_IMAGE", objectKey, fileName: upload.fileName, mimeType: upload.mimeType, sha256: upload.artifactSha256, byteSize: upload.totalBytes, width: upload.width, height: upload.height, metadata: { source: "desktop-local-compute", localTaskId: upload.localTaskId } },
      });
      return transaction.desktopGalleryUpload.update({ where: { id: upload.id }, data: { artifactId, status: "READY", errorMessage: null } });
    });
  }
  const artifactId = upload.artifactId;
  if (!artifactId) throw new DesktopGalleryError(500, "desktop_upload_artifact_missing", "桌面作品产物登记失败");
  upload = await database.desktopGalleryUpload.update({ where: { id: upload.id }, data: { status: "PUBLISHING", errorMessage: null } });
  const externalTaskId = desktopExternalTaskId(upload.localTaskId);
  const publicationRequest: GalleryPublicationCreateRequest = {
    idempotencyKey: `desktop-gallery:${upload.id}`,
    jobId: externalTaskId,
    artifactId,
    walletOwnerType: "user",
    userSubject: identity.subject,
    sha256: upload.artifactSha256,
    mimeType: upload.mimeType,
    byteSize: Number(upload.totalBytes),
    width: upload.width,
    height: upload.height,
    isPrivate: upload.isPrivate,
    effectivePrompt: upload.effectivePrompt,
    negativePrompt: upload.negativePrompt,
    modelDisplayName: upload.modelDisplayName,
    parameters: upload.parameters && typeof upload.parameters === "object" && !Array.isArray(upload.parameters) ? upload.parameters as Record<string, unknown> : {},
  };
  try {
    const publication = await publishDesktopMainGallery(externalTaskId, publicationRequest);
    const published = await database.desktopGalleryUpload.update({
      where: { id: upload.id },
      data: { status: "PUBLISHED", mainPublicationId: publication.publicationId, mainGalleryItemId: publication.mainGalleryItemId, mediaUrl: publication.mediaUrl, publishedAt: new Date(), errorMessage: null },
    });
    await rm(uploadPath(upload.temporaryFileName), { force: true });
    return published;
  } catch (error) {
    await database.desktopGalleryUpload.update({ where: { id: upload.id }, data: { status: "FAILED_RETRYABLE", errorMessage: publicError(error) } });
    throw error;
  }
}

/** 读取服务端临时文件真实长度，响应丢失后以真实偏移继续。 */
async function reconcileUpload(uploadId: string, identityId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new DesktopGalleryError(400, "desktop_upload_id_invalid", "桌面上传会话 ID 不正确");
  const upload = await database.desktopGalleryUpload.findFirst({ where: { id: uploadId, externalIdentityId: identityId } });
  if (!upload) throw new DesktopGalleryError(404, "desktop_upload_not_found", "桌面上传会话不存在");
  if (upload.status !== "UPLOADING") return upload;
  let actualBytes = 0;
  try { actualBytes = (await stat(uploadPath(upload.temporaryFileName))).size; }
  catch { throw new DesktopGalleryError(409, "desktop_upload_file_missing", "桌面上传断点文件不存在"); }
  if (actualBytes > Number(upload.totalBytes)) throw new DesktopGalleryError(409, "desktop_upload_file_corrupt", "桌面上传断点文件长度异常");
  return actualBytes === Number(upload.receivedBytes) ? upload : database.desktopGalleryUpload.update({ where: { id: upload.id }, data: { receivedBytes: BigInt(actualBytes) } });
}

/** 上传会话视图只返回恢复上传和页面展示所需字段。 */
function toUploadView(upload: { id: string; localTaskId: string; status: string; totalBytes: bigint; receivedBytes: bigint; isPrivate: boolean; mainGalleryItemId: string | null; mediaUrl: string | null; errorMessage: string | null; expiresAt: Date }): DesktopGalleryUploadView {
  return { id: upload.id, localTaskId: upload.localTaskId, status: upload.status.toLowerCase() as DesktopGalleryUploadView["status"], totalBytes: Number(upload.totalBytes), receivedBytes: Number(upload.receivedBytes), chunkSizeBytes, privacy: upload.isPrivate ? "private" : "public", mainGalleryItemId: upload.mainGalleryItemId, mediaUrl: upload.mediaUrl, errorMessage: upload.errorMessage, expiresAt: upload.expiresAt.toISOString() };
}

/** 同一上传会话串行执行偏移核对、追加和发布，避免并发分片覆盖。 */
async function withUploadLock<T>(uploadId: string, operation: () => Promise<T>): Promise<T> {
  const previous = uploadLocks.get(uploadId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const queued = previous.then(() => gate);
  uploadLocks.set(uploadId, queued);
  await previous;
  try { return await operation(); }
  finally { release(); if (uploadLocks.get(uploadId) === queued) uploadLocks.delete(uploadId); }
}

/** 严格读取声明长度的单个分片，防止无限请求体占用内存。 */
async function readChunk(request: IncomingMessage, declared: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > declared) throw new DesktopGalleryError(400, "desktop_upload_chunk_overflow", "上传分片超过声明长度");
    chunks.push(chunk);
  }
  if (total !== declared) throw new DesktopGalleryError(400, "desktop_upload_chunk_incomplete", "上传分片接收不完整");
  return Buffer.concat(chunks);
}

/** 流式计算桌面作品哈希，避免把最大 100MB 原图复制进 Node 堆。 */
async function hashFile(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest("hex"); }

/** 只接受数据库生成的 UUID 临时文件名，禁止路径穿越。 */
function uploadPath(fileName: string): string { if (!/^[0-9a-f-]{36}\.upload$/i.test(fileName)) throw new DesktopGalleryError(500, "desktop_upload_path_invalid", "桌面上传临时文件名不正确"); return join(uploadDirectory, fileName); }

/** 生成与账号无关但全站稳定的桌面图库任务 ID。 */
function desktopExternalTaskId(localTaskId: string): string { return `desktop_${localTaskId.replaceAll("-", "")}`; }

/** 清理文件名路径与扩展名，真实格式仍由图片解码结果决定。 */
function safeFileName(value: string, mimeType: string): string { const stem = basename(value, extname(value)).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-").trim().slice(0, 180) || "drawhime-desktop"; return `${stem}${extensionForMime(mimeType)}`; }
function extensionForMime(mimeType: string): string { return mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : ".webp"; }
function mimeFromSharp(format: string | undefined): string { return format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : ""; }
function readHeader(value: string | string[] | undefined): string { return String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim(); }
function readBearerToken(request: IncomingMessage): string | null { const value = request.headers.authorization?.trim() || ""; return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() || null : null; }
function publicError(error: unknown): string { return error instanceof MainPlatformIntegrationError ? error.message.slice(0, 1000) : error instanceof Error ? error.message.slice(0, 1000) : "桌面作品发布失败"; }

/** 桌面图库上传业务错误保留稳定 HTTP 状态与机器码。 */
class DesktopGalleryError extends Error { public constructor(public readonly status: number, public readonly code: string, message: string) { super(message); } }

/** 统一收敛上传、图片校验、对象存储和主站发布错误。 */
function sendGalleryError(response: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof DesktopGalleryError) return sendError(response, error.status, error.code, error.message);
  if (error instanceof MainPlatformIntegrationError) return sendError(response, error.status, error.code, error.message);
  const invalidInput = error && typeof error === "object" && "issues" in error;
  sendError(response, invalidInput ? 400 : 500, invalidInput ? "desktop_upload_input_invalid" : "desktop_upload_failed", invalidInput ? "桌面作品上传参数不正确" : "桌面作品上传失败");
}
