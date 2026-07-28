/**
 * 本文件提供底模仓库浏览、示例图和管理员登记接口；手动登记只引用已经安装到私有 GPU 的真实模型文件。
 */
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ExternalIdentity, Prisma } from "@prisma/client";
import { modelLibraryCreateRequestSchema, modelLibraryUpdateRequestSchema, type ModelLibraryCreateRequest, type ModelLibraryEntryView } from "@drawhime/contracts";
import { database } from "@drawhime/database";
import { MainPlatformIntegrationError, publishMainPrice } from "@drawhime/main-platform-client";
import { deleteObject, getObjectBuffer, putObjectBuffer, readJsonBody, sendError, sendSuccess, type ServiceRouter } from "@drawhime/service-runtime";
import sharp from "sharp";

const maximumExampleBytes = 12 * 1024 * 1024;
type SessionRecord = { externalIdentity: ExternalIdentity };
type FindSession = (token: string | null) => Promise<SessionRecord | null>;
type ModelWithRepository = Prisma.ModelVersionGetPayload<{
  include: { family: true; repositoryExamples: { include: { artifact: true } } };
}>;

/** 注册底模仓库公开浏览与管理员维护接口。 */
export function registerModelLibraryRoutes(router: ServiceRouter, findSession: FindSession): void {
  router.get("/v1/model-library", async ({ request, response }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    sendSuccess(response, { entries: await listEntries(session.externalIdentity) });
  });

  router.get("/v1/model-library/:id", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      sendSuccess(response, await getEntryView(params.id, session.externalIdentity));
    } catch (error) {
      sendModelError(response, error);
    }
  });

  router.get("/v1/model-library/examples/:id/content", async ({ request, response, params }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "本地模型平台登录状态已失效");
    try {
      const example = await database.modelExample.findUnique({
        where: { id: params.id },
        include: { modelVersion: true, artifact: true },
      });
      if (!example || (!isVisible(example.modelVersion) && !isAdmin(session.externalIdentity))) {
        throw new ModelLibraryError(404, "model_example_not_found", "模型示例不存在或未公开");
      }
      const object = await getObjectBuffer(example.artifact.objectKey);
      const buffer = object.body;
      response.writeHead(200, {
        "content-type": example.artifact.mimeType,
        "content-length": String(buffer.length),
        "cache-control": "private, max-age=3600",
      });
      response.end(buffer);
    } catch (error) {
      sendModelError(response, error);
    }
  });

  router.post("/v1/admin/model-library", async ({ request, response }) => {
    const session = await requireAdmin(request, response, findSession);
    if (!session) return;
    try {
      const input = modelLibraryCreateRequestSchema.parse(await readJsonBody<unknown>(request));
      const model = await createModelEntry(input);
      // 主站价格是扣费权威；价格登记失败时撤销本次新建目录，禁止留下不可计费的模型。
      try {
        await publishMainPrice({ productCode: input.productCode, pricingVersion: input.pricingVersion, unitPrice: input.priceCny });
      } catch (error) {
        // 价格没有建立时撤销刚创建的禁用目录，避免管理员看到无法再次登记的残留模型。
        await removeUnpublishedModelEntry(model.id);
        throw error;
      }
      await database.modelVersion.update({ where: { id: model.id }, data: { status: "ACTIVE" } });
      sendSuccess(response, await getEntryView(model.id, session.externalIdentity), 201);
    } catch (error) {
      sendModelError(response, error);
    }
  });

  router.register("PATCH", "/v1/admin/model-library/:id", async ({ request, response, params }) => {
    const session = await requireAdmin(request, response, findSession);
    if (!session) return;
    try {
      const input = modelLibraryUpdateRequestSchema.parse(await readJsonBody<unknown>(request));
      const model = await database.modelVersion.findUnique({ where: { id: params.id } });
      if (!model) throw new ModelLibraryError(404, "model_not_found", "底模不存在");
      await database.modelVersion.update({
        where: { id: model.id },
        data: {
          displayName: input.displayName,
          description: input.description,
          defaultParameters: {
            ...readObject(model.defaultParameters),
            sourceUrl: input.sourceUrl,
            usageGuide: input.usageGuide,
            repositoryVisible: input.visible,
          },
        },
      });
      sendSuccess(response, await getEntryView(model.id, session.externalIdentity));
    } catch (error) {
      sendModelError(response, error);
    }
  });

  router.post("/v1/admin/model-library/:id/examples", async ({ request, response, params }) => {
    const session = await requireAdmin(request, response, findSession);
    if (!session) return;
    let objectKey: string | null = null;
    try {
      const model = await database.modelVersion.findUnique({ where: { id: params.id } });
      if (!model) throw new ModelLibraryError(404, "model_not_found", "底模不存在");
      const source = await readRequestBuffer(request, maximumExampleBytes);
      const rendered = await sharp(source, { failOn: "error", limitInputPixels: 80_000_000 })
        .rotate()
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 92, effort: 5, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
      if (!rendered.info.width || !rendered.info.height) throw new ModelLibraryError(400, "model_example_invalid", "示例图尺寸读取失败");
      const sha256 = createHash("sha256").update(rendered.data).digest("hex");
      objectKey = `models/examples/${model.id}/${randomUUID()}-${sha256.slice(0, 12)}.webp`;
      await putObjectBuffer(objectKey, rendered.data, "image/webp");
      const prompt = readExamplePrompt(request);
      await database.$transaction(async (transaction) => {
        const currentCount = await transaction.modelExample.count({ where: { modelVersionId: model.id } });
        if (currentCount >= 8) throw new ModelLibraryError(400, "model_examples_limit", "每个底模最多上传 8 张示例图");
        const artifact = await transaction.jobArtifact.create({
          data: {
            jobId: null,
            kind: "PREVIEW_IMAGE",
            objectKey: objectKey!,
            fileName: `${model.version}-example-${currentCount + 1}.webp`,
            mimeType: "image/webp",
            sha256,
            byteSize: BigInt(rendered.data.length),
            width: rendered.info.width,
            height: rendered.info.height,
            metadata: { source: "admin-model-library" },
          },
        });
        await transaction.modelExample.create({
          data: { modelVersionId: model.id, artifactId: artifact.id, sortOrder: currentCount, prompt },
        });
      });
      objectKey = null;
      sendSuccess(response, await getEntryView(model.id, session.externalIdentity));
    } catch (error) {
      if (objectKey) await deleteObject(objectKey).catch(() => undefined);
      sendModelError(response, error);
    }
  });

  router.delete("/v1/admin/model-library/:id/examples/:exampleId", async ({ request, response, params }) => {
    const session = await requireAdmin(request, response, findSession);
    if (!session) return;
    try {
      const example = await database.modelExample.findFirst({
        where: { id: params.exampleId, modelVersionId: params.id },
        include: { artifact: true },
      });
      if (!example) throw new ModelLibraryError(404, "model_example_not_found", "模型示例不存在");
      await database.$transaction([
        database.modelExample.delete({ where: { id: example.id } }),
        database.jobArtifact.delete({ where: { id: example.artifactId } }),
      ]);
      await deleteObject(example.artifact.objectKey).catch(() => undefined);
      sendSuccess(response, await getEntryView(params.id, session.externalIdentity));
    } catch (error) {
      sendModelError(response, error);
    }
  });
}

/** 删除尚未发布价格的临时目录，不触及既有模型、任务或媒体。 */
async function removeUnpublishedModelEntry(modelId: string): Promise<void> {
  await database.$transaction(async (transaction) => {
    const model = await transaction.modelVersion.findUnique({
      where: { id: modelId },
      include: { workflowVersions: true, runtimeDefinitions: true },
    });
    if (!model || model.status !== "DISABLED") return;
    await transaction.workflowVersion.deleteMany({ where: { modelVersionId: model.id } });
    await transaction.runtimeDefinition.deleteMany({ where: { modelVersionId: model.id } });
    await transaction.modelVersion.delete({ where: { id: model.id } });
  });
}

/** 创建禁用的模型、Runtime 与不可变工作流，待主站价格发布成功后再启用。 */
async function createModelEntry(input: ModelLibraryCreateRequest) {
  return database.$transaction(async (transaction) => {
    const duplicate = await transaction.modelVersion.findFirst({ where: { version: input.modelFileName } });
    if (duplicate) throw new ModelLibraryError(409, "model_file_registered", "该 GPU 模型文件已经在仓库登记");
    const family = await transaction.modelFamily.upsert({
      where: { slug: normalizeSlug(input.familyName) },
      update: { name: input.familyName, status: "ACTIVE" },
      create: { slug: normalizeSlug(input.familyName), name: input.familyName, description: `${input.familyName} 底模系列`, status: "ACTIVE" },
    });
    const defaults = buildDefaultParameters(input);
    const model = await transaction.modelVersion.create({
      data: { familyId: family.id, version: input.modelFileName, displayName: input.displayName, description: input.description, status: "DISABLED", runtimeFormat: "anima", defaultParameters: defaults },
    });
    const runtime = await transaction.runtimeDefinition.create({
      data: { modelVersionId: model.id, slug: `manual-anima-${randomUUID()}`, runtimeType: "comfyui", healthPath: "/system_stats", status: "ACTIVE" },
    });
    const template = await transaction.workflowTemplate.upsert({
      where: { slug: "anima-text-to-image" },
      update: { status: "ACTIVE" },
      create: { slug: "anima-text-to-image", name: "Anima 文生图", description: "按底模目录选择独立采样预设的 Anima 文生图工作流", status: "ACTIVE" },
    });
    const maximum = await transaction.workflowVersion.aggregate({ where: { workflowTemplateId: template.id }, _max: { version: true } });
    const workflowJson = buildWorkflowJson(input);
    await transaction.workflowVersion.create({
      data: {
        workflowTemplateId: template.id,
        modelVersionId: model.id,
        runtimeDefinitionId: runtime.id,
        version: (maximum._max.version ?? 0) + 1,
        workflowJson,
        inputMapping: { prompt: "prompt", negativePrompt: "negativePrompt", width: "width", height: "height", seed: "seed" },
        outputMapping: { nodeId: "11", type: "image" },
        sha256: createHash("sha256").update(JSON.stringify(workflowJson)).digest("hex"),
        status: "ACTIVE",
      },
    });
    return model;
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 10000 });
}

/** 构造与 Anima Runtime 一致的模型级默认参数。 */
function buildDefaultParameters(input: ModelLibraryCreateRequest): Prisma.InputJsonObject {
  return {
    width: 1024,
    height: 1024,
    maxEdge: 1536,
    maxAttempts: 3,
    promptEnhancementEnabled: true,
    productCode: input.productCode,
    pricingVersion: input.pricingVersion,
    priceCny: input.priceCny,
    trainingProductCode: "local.anima-lora.training",
    trainingPricingVersion: 3,
    trainingPriceCny: "0.80",
    steps: input.steps,
    cfg: input.cfg,
    sampler: input.sampler,
    scheduler: input.scheduler,
    samplingMaxEdge: input.samplingMaxEdge,
    qualityPrefix: input.qualityPrefix,
    defaultNegativePrompt: input.defaultNegativePrompt,
    systemHighresLoraEnabled: false,
    sourceUrl: input.sourceUrl,
    modelSha256: input.modelSha256.toUpperCase(),
    modelByteSize: input.modelByteSize,
    usageGuide: input.usageGuide,
    repositoryVisible: input.visible,
  };
}

/** 固化管理员在当前 Anima 格式中选择的真实采样配置。 */
function buildWorkflowJson(input: ModelLibraryCreateRequest): Prisma.InputJsonObject {
  return {
    runtimeBuilder: "@drawhime/inference-runtime:buildAnimaWorkflow",
    revision: 4,
    model: input.modelFileName,
    modelSha256: input.modelSha256.toUpperCase(),
    sampling: { steps: input.steps, cfg: input.cfg, sampler: input.sampler, scheduler: input.scheduler, maxEdge: input.samplingMaxEdge },
    systemLoras: [],
    clip: "qwen_3_06b_base.safetensors",
    vae: "qwen_image_vae.safetensors",
    output: { format: "WEBP", quality: 100, maxEdge: 1536, upscaleMethod: "lanczos" },
  };
}

/** 列出当前身份可见的底模。 */
async function listEntries(identity: ExternalIdentity): Promise<ModelLibraryEntryView[]> {
  const admin = isAdmin(identity);
  const rows = await database.modelVersion.findMany({
    where: admin ? { status: { not: "ARCHIVED" } } : { status: "ACTIVE" },
    include: { family: true, repositoryExamples: { include: { artifact: true }, orderBy: { sortOrder: "asc" } } },
    orderBy: { displayName: "asc" },
  });
  return Promise.all(rows.filter((row) => admin || isVisible(row)).map((row) => toEntryView(row, admin)));
}

/** 按 ID 读取一个可访问的底模详情。 */
async function getEntryView(id: string, identity: ExternalIdentity): Promise<ModelLibraryEntryView> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ModelLibraryError(400, "model_id_invalid", "底模 ID 不正确");
  const row = await database.modelVersion.findUnique({
    where: { id },
    include: { family: true, repositoryExamples: { include: { artifact: true }, orderBy: { sortOrder: "asc" } } },
  });
  if (!row || (!isAdmin(identity) && (!isVisible(row) || row.status !== "ACTIVE"))) {
    throw new ModelLibraryError(404, "model_not_found", "底模不存在或未公开");
  }
  return toEntryView(row, isAdmin(identity));
}

/** 映射仓库视图并读取当前底模的公开图库使用示例。 */
async function toEntryView(row: ModelWithRepository, admin: boolean): Promise<ModelLibraryEntryView> {
  const defaults = readObject(row.defaultParameters);
  const references = await database.inferenceJob.findMany({
    where: {
      modelVersionId: row.id,
      status: "SUCCEEDED",
      deletedAt: null,
      galleryPublication: { status: "PUBLISHED", mediaUrl: { not: null }, mainGalleryItemId: { not: null } },
      parameters: { path: "$.isPrivate", equals: false },
    },
    select: { id: true, requestedPrompt: true, createdAt: true, galleryPublication: { select: { mediaUrl: true, mainGalleryItemId: true } } },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  return {
    id: row.id,
    displayName: row.displayName,
    description: row.description || "暂无描述",
    family: row.family.slug,
    familyName: row.family.name,
    modelFileName: row.version,
    runtimeFormat: row.runtimeFormat,
    sourceUrl: stringValue(defaults.sourceUrl),
    usageGuide: stringValue(defaults.usageGuide) || "在本地绘图页面选择该模型后输入英文或经 AI 增强的提示词生成。",
    visible: isVisible(row),
    isAdmin: admin,
    priceCny: String(defaults.priceCny || "0.00"),
    parameters: {
      steps: numberValue(defaults.steps),
      cfg: numberValue(defaults.cfg),
      sampler: stringValue(defaults.sampler) || "-",
      scheduler: stringValue(defaults.scheduler) || "-",
      samplingMaxEdge: numberValue(defaults.samplingMaxEdge),
      maxEdge: numberValue(defaults.maxEdge),
    },
    examples: row.repositoryExamples.map((example) => ({
      id: example.id,
      width: example.artifact.width,
      height: example.artifact.height,
      prompt: example.prompt,
      contentUrl: `/v1/model-library/examples/${example.id}/content`,
    })),
    referenceTasks: references.flatMap((job) => {
      const publication = job.galleryPublication;
      return publication?.mediaUrl && publication.mainGalleryItemId ? [{
        id: job.id,
        prompt: job.requestedPrompt,
        imageUrl: publication.mediaUrl,
        galleryItemId: publication.mainGalleryItemId,
        createdAt: job.createdAt.toISOString(),
      }] : [];
    }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 从受限请求头读取可选示例提示词，避免二进制图片请求引入额外 JSON 包装。 */
function readExamplePrompt(request: IncomingMessage): string | null {
  const value = request.headers["x-model-example-prompt"];
  const prompt = Array.isArray(value) ? value[0] : value;
  return prompt?.trim().slice(0, 10_000) || null;
}

/** 读取受大小限制的示例图片二进制，避免大文件耗尽 API 进程内存。 */
async function readRequestBuffer(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    byteSize += buffer.length;
    if (byteSize > maximumBytes) throw new ModelLibraryError(413, "model_example_too_large", "模型示例图不能超过 12MB");
    chunks.push(buffer);
  }
  if (byteSize === 0) throw new ModelLibraryError(400, "model_example_empty", "模型示例图内容为空");
  return Buffer.concat(chunks);
}

/** 旧模型没有外显字段时默认对登录用户可见。 */
function isVisible(row: { defaultParameters: unknown }): boolean {
  return readObject(row.defaultParameters).repositoryVisible !== false;
}

/** 将 Prisma JSON 安全读取为对象。 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 读取非空字符串参数。 */
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 读取有限数值参数。 */
function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** 将管理员输入的主模型系列转为唯一稳定标识。 */
function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return slug || `model-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** 判断主站同步到本地会话的管理员角色。 */
function isAdmin(identity: ExternalIdentity): boolean {
  return Array.isArray(identity.roles) && identity.roles.includes("admin");
}

/** 校验管理员会话，所有模型写操作必须经过此门禁。 */
async function requireAdmin(request: IncomingMessage, response: Parameters<typeof sendError>[0], findSession: FindSession): Promise<SessionRecord | null> {
  const session = await findSession(readBearerToken(request));
  if (!session || !isAdmin(session.externalIdentity)) {
    sendError(response, 403, "admin_required", "需要主站管理员权限");
    return null;
  }
  return session;
}

/** 从标准 Bearer 头读取独立平台会话令牌。 */
function readBearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization?.trim() || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() || null : null;
}

/** 可预期的底模仓库业务错误。 */
class ModelLibraryError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/** 统一映射模型仓库的校验、主站集成与业务错误。 */
function sendModelError(response: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof ModelLibraryError) return sendError(response, error.status, error.code, error.message);
  if (error instanceof MainPlatformIntegrationError) return sendError(response, error.status, error.code, error.message);
  const message = error && typeof error === "object" && "issues" in error
    ? "模型仓库参数不正确"
    : error instanceof Error ? error.message : "模型仓库操作失败";
  sendError(response, 400, "model_library_failed", message);
}
