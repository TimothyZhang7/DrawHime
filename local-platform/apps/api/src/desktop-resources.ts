/**
 * 本文件提供桌面端公开资源清单端点，只返回运维离线签名且通过契约校验的信封文件。
 */
import { desktopResourceManifestEnvelopeSchema, desktopResourceManifestPayloadSchema, type DesktopResourceManifestEnvelope, type DesktopResourceManifestPayload } from "@drawhime/contracts";
import type { ServiceRouter } from "@drawhime/service-runtime";
import { sendError, sendSuccess } from "@drawhime/service-runtime";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { basename, resolve } from "node:path";

const MAX_ENVELOPE_BYTES = 6 * 1024 * 1024;

/** 注册无需登录但必须由桌面端本地验签的资源清单读取接口。 */
export function registerDesktopResourceRoutes(router: ServiceRouter): void {
  router.get("/v1/desktop/resources/manifest", async ({ response }) => {
    try {
      sendSuccess(response, (await loadPublishedManifest()).envelope);
    } catch (error) {
      const failure = publicationError(error);
      sendError(response, 503, failure.code, failure.message);
    }
  });

  router.get("/v1/desktop/resources/:id/content", async ({ request, response, params }) => {
    let published;
    try {
      published = await loadPublishedManifest();
    } catch (error) {
      const failure = publicationError(error);
      sendError(response, 503, failure.code, failure.message);
      return;
    }
    const resource = published.payload.resources.find((item) => item.id === params.id);
    if (!resource) return sendError(response, 404, "desktop_resource_not_found", "桌面资源不存在");
    const storageRoot = process.env.DESKTOP_RESOURCE_STORAGE_ROOT?.trim();
    if (!storageRoot || storageRoot.startsWith("<")) return sendError(response, 503, "desktop_resource_storage_unconfigured", "桌面资源镜像存储尚未配置");
    const resolvedStorageRoot = resolve(storageRoot);
    // 生产大资源必须位于 data 盘，错误配置直接停止服务而不是回落系统盘。
    if (process.platform !== "win32" && resolvedStorageRoot !== "/data" && !resolvedStorageRoot.startsWith("/data/")) return sendError(response, 503, "desktop_resource_storage_not_data", "桌面资源镜像存储必须位于 data 盘");
    if (basename(resource.fileName) !== resource.fileName) return sendError(response, 503, "desktop_resource_manifest_invalid", "桌面资源文件名不安全");
    const filePath = resolve(resolvedStorageRoot, resource.fileName);
    let metadata;
    const range = parseDesktopResourceRange(request.headers.range, resource.byteSize);
    if (range === "invalid") {
      response.writeHead(416, { "content-range": `bytes */${resource.byteSize}`, "accept-ranges": "bytes", "cache-control": "no-store" });
      response.end();
      return;
    }
    try { metadata = await stat(filePath); }
    catch { return sendError(response, 404, "desktop_resource_file_missing", "桌面资源镜像文件不存在"); }
    if (!metadata.isFile() || metadata.size !== resource.byteSize) return sendError(response, 503, "desktop_resource_file_invalid", "桌面资源镜像大小与签名清单不一致");
    const start = range?.start ?? 0;
    const end = range?.end ?? resource.byteSize - 1;
    response.writeHead(range ? 206 : 200, {
      "content-type": resource.archive === "7z" ? "application/x-7z-compressed" : resource.archive === "zip" ? "application/zip" : "application/octet-stream",
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      "etag": `"${resource.sha256}"`,
      "cache-control": "public, max-age=31536000, immutable",
      ...(range ? { "content-range": `bytes ${start}-${end}/${resource.byteSize}` } : {}),
    });
    const stream = createReadStream(filePath, { start, end });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });
}

/** 读取并同时校验签名信封和内部载荷结构，签名真实性仍由桌面固定公钥判定。 */
async function loadPublishedManifest(): Promise<{ envelope: DesktopResourceManifestEnvelope; payload: DesktopResourceManifestPayload }> {
  const configuredPath = process.env.DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE?.trim();
  if (!configuredPath || configuredPath.startsWith("<")) throw publicationFailure("desktop_resource_manifest_unconfigured", "桌面资源清单尚未发布");
  const filePath = resolve(configuredPath);
  let metadata;
  try { metadata = await stat(filePath); }
  catch { throw publicationFailure("desktop_resource_manifest_missing", "桌面资源清单文件不存在"); }
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ENVELOPE_BYTES) throw publicationFailure("desktop_resource_manifest_invalid", "桌面资源清单文件大小不正确");
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(filePath, "utf8")); }
  catch { throw publicationFailure("desktop_resource_manifest_invalid", "桌面资源清单文件不是有效 JSON"); }
  const envelope = desktopResourceManifestEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) throw publicationFailure("desktop_resource_manifest_invalid", "桌面资源清单信封未通过契约校验");
  let payloadJson: unknown;
  try { payloadJson = JSON.parse(envelope.data.payload); }
  catch { throw publicationFailure("desktop_resource_manifest_invalid", "桌面资源清单载荷不是有效 JSON"); }
  const payload = desktopResourceManifestPayloadSchema.safeParse(payloadJson);
  if (!payload.success) throw publicationFailure("desktop_resource_manifest_invalid", "桌面资源清单载荷未通过契约校验");
  return { envelope: envelope.data, payload: payload.data };
}

/** 只接受单一闭区间 Range，避免多段响应扩大内存和文件句柄占用。 */
export function parseDesktopResourceRange(value: string | undefined, totalBytes: number): { start: number; end: number } | "invalid" | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) return "invalid";
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : totalBytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalBytes || end < start || end >= totalBytes) return "invalid";
  return { start, end };
}

/** 构造内部发布错误，避免把服务器绝对路径回显给客户端。 */
function publicationFailure(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
/** 把未知异常收敛为不包含服务器路径的公开错误。 */
function publicationError(error: unknown): { code: string; message: string } { return error instanceof Error && "code" in error ? { code: String(error.code), message: error.message } : { code: "desktop_resource_manifest_invalid", message: "桌面资源发布状态异常" }; }
