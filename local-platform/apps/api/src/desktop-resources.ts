/**
 * 本文件提供桌面端公开资源清单端点，只返回运维离线签名且通过契约校验的信封文件。
 */
import { desktopResourceManifestEnvelopeSchema } from "@drawhime/contracts";
import type { ServiceRouter } from "@drawhime/service-runtime";
import { sendError, sendSuccess } from "@drawhime/service-runtime";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_ENVELOPE_BYTES = 6 * 1024 * 1024;

/** 注册无需登录但必须由桌面端本地验签的资源清单读取接口。 */
export function registerDesktopResourceRoutes(router: ServiceRouter): void {
  router.get("/v1/desktop/resources/manifest", async ({ response }) => {
    const configuredPath = process.env.DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE?.trim();
    if (!configuredPath || configuredPath.startsWith("<")) {
      sendError(response, 503, "desktop_resource_manifest_unconfigured", "桌面资源清单尚未发布");
      return;
    }
    const filePath = resolve(configuredPath);
    let metadata;
    try {
      metadata = await stat(filePath);
    } catch {
      sendError(response, 503, "desktop_resource_manifest_missing", "桌面资源清单文件不存在");
      return;
    }
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ENVELOPE_BYTES) {
      sendError(response, 503, "desktop_resource_manifest_invalid", "桌面资源清单文件大小不正确");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      sendError(response, 503, "desktop_resource_manifest_invalid", "桌面资源清单文件不是有效 JSON");
      return;
    }
    const result = desktopResourceManifestEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      sendError(response, 503, "desktop_resource_manifest_invalid", "桌面资源清单信封未通过契约校验");
      return;
    }
    sendSuccess(response, result.data);
  });
}
