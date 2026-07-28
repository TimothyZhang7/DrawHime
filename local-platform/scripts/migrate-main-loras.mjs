/**
 * 本脚本通过主站只读迁移接口幂等复制已发布 LoRA 与示例图，所有文件落库前重新校验 SHA-256。
 */
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { putObjectBuffer } from "../packages/service-runtime/dist/index.js";

const database = new PrismaClient();

try {
  const snapshot = await mainJson("/internal/integrations/local-model/migration/snapshot");
  let migratedFiles = 0;
  let migratedExamples = 0;
  for (const item of snapshot.loras) {
    const identity = await database.externalIdentity.upsert({
      where: { issuer_subject: { issuer: snapshot.issuer, subject: item.owner.subject } },
      update: { displayName: item.owner.displayName, emailVerified: item.owner.emailVerified },
      create: { issuer: snapshot.issuer, subject: item.owner.subject, displayName: item.owner.displayName, avatarUrl: null, roles: ["user"], emailVerified: item.owner.emailVerified, lastAuthenticatedAt: new Date(item.publishedAt) },
    });
    const familySlug = normalizeSlug(item.baseModel);
    const family = await database.modelFamily.upsert({
      where: { slug: familySlug },
      update: { name: item.baseModel, status: "ACTIVE" },
      create: { slug: familySlug, name: item.baseModel, description: `从主站 LoRA 仓库迁移的 ${item.baseModel} 模型系列`, status: "ACTIVE" },
    });
    const modelBuffer = await mainBuffer(`/internal/integrations/local-model/migration/loras/${item.id}/file?sha256=${item.sha256}`);
    verifyFile(modelBuffer, item.fileSizeBytes, item.sha256, `LoRA ${item.id}`);
    const gpuFileName = `aiimage_lora_${item.sha256}.safetensors`;
    const modelObjectKey = `loras/imported/main-${item.id}/${gpuFileName}`;
    await putObjectBuffer(modelObjectKey, modelBuffer, "application/octet-stream");
    const entry = await database.loraEntry.upsert({
      where: { slug: `main-lora-${item.id}` },
      update: { ownerIdentityId: identity.id, modelFamilyId: family.id, title: item.title, description: item.description, type: normalizeLoraType(item.loraType), status: "ACTIVE" },
      create: { ownerIdentityId: identity.id, modelFamilyId: family.id, slug: `main-lora-${item.id}`, title: item.title, description: item.description, type: normalizeLoraType(item.loraType), triggerWords: [], status: "ACTIVE" },
    });
    await database.loraVersion.upsert({
      where: { loraEntryId_version: { loraEntryId: entry.id, version: "main-v1" } },
      update: { objectKey: modelObjectKey, fileName: gpuFileName, sha256: item.sha256, byteSize: BigInt(item.fileSizeBytes), status: "ACTIVE", metadata: { source: "main-platform", mainLoraId: item.id, originalFileName: item.originalFileName } },
      create: { loraEntryId: entry.id, version: "main-v1", objectKey: modelObjectKey, fileName: gpuFileName, sha256: item.sha256, byteSize: BigInt(item.fileSizeBytes), status: "ACTIVE", metadata: { source: "main-platform", mainLoraId: item.id, originalFileName: item.originalFileName } },
    });
    migratedFiles += 1;
    for (const example of item.examples) {
      const buffer = await mainBuffer(`/internal/integrations/local-model/migration/examples/${example.id}`);
      if (buffer.length !== example.sizeBytes) throw new Error(`LoRA 示例图 ${example.id} 大小校验失败`);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const objectKey = `loras/examples/main-${item.id}-${example.id}-${sha256.slice(0, 12)}.webp`;
      await putObjectBuffer(objectKey, buffer, "image/webp");
      const artifact = await database.jobArtifact.upsert({
        where: { objectKey },
        update: { sha256, byteSize: BigInt(buffer.length), width: example.width, height: example.height },
        create: { jobId: null, kind: "PREVIEW_IMAGE", objectKey, fileName: `main-lora-${item.id}-example-${example.id}.webp`, mimeType: "image/webp", sha256, byteSize: BigInt(buffer.length), width: example.width, height: example.height, metadata: { source: "main-platform", mainExampleId: example.id } },
      });
      await database.loraExample.upsert({
        where: { loraEntryId_artifactId: { loraEntryId: entry.id, artifactId: artifact.id } },
        update: { sortOrder: example.sortOrder },
        create: { loraEntryId: entry.id, artifactId: artifact.id, sortOrder: example.sortOrder },
      });
      migratedExamples += 1;
    }
  }
  console.log(`[migrate-main-loras] loras=${migratedFiles} examples=${migratedExamples}`);
} finally {
  await database.$disconnect();
}

/** 读取主站 JSON 成功响应。 */
async function mainJson(path) {
  const response = await mainRequest(path);
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.message || `主站迁移接口返回 HTTP ${response.status}`);
  return payload.data;
}

/** 读取主站二进制迁移响应。 */
async function mainBuffer(path) {
  const response = await mainRequest(path);
  if (!response.ok) throw new Error(`主站迁移文件返回 HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** 发起带独立平台服务 token 的主站迁移请求。 */
function mainRequest(path) {
  const baseUrl = process.env.MAIN_PLATFORM_INTERNAL_URL?.trim();
  const token = process.env.MAIN_PLATFORM_CLIENT_SECRET?.trim();
  if (!baseUrl || !token) throw new Error("主站迁移集成配置不完整");
  return fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { headers: { "x-local-platform-token": token }, signal: AbortSignal.timeout(120000) });
}

/** 校验迁移文件大小和 SHA-256。 */
function verifyFile(buffer, expectedBytes, expectedSha256, label) {
  if (buffer.length !== expectedBytes) throw new Error(`${label} 大小校验失败`);
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expectedSha256) throw new Error(`${label} SHA-256 校验失败`);
}

/** 归一化主模型系列键。 */
function normalizeSlug(value) {
  const slug = String(value || "other").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "other";
}

/** 映射主站 LoRA 类型到独立数据库枚举。 */
function normalizeLoraType(value) {
  const mapping = { style: "STYLE", character: "CHARACTER", concept: "CONCEPT", clothing: "CLOTHING", pose: "POSE" };
  return mapping[String(value || "").toLowerCase()] || "OTHER";
}
