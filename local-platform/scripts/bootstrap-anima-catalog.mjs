/**
 * 本脚本幂等登记 Anima 系列真实底模、ComfyUI Runtime、工作流版本，并向主站发布模型级价格。
 */
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const database = new PrismaClient();
const defaultPricingVersion = 1;
const defaultPriceCny = "0.05";
const defaultTrainingProductCode = "local.anima-lora.training";
// 训练价格版本不可覆盖历史订单；新建训练统一使用版本 3 的基准计价单位。
const defaultTrainingPricingVersion = 3;
const defaultTrainingPriceCny = "0.80";
const sharedDefaults = { width: 1024, height: 1024, maxEdge: 1536, maxAttempts: 3, promptEnhancementEnabled: true, pricingVersion: defaultPricingVersion, priceCny: defaultPriceCny, trainingProductCode: defaultTrainingProductCode, trainingPricingVersion: defaultTrainingPricingVersion, trainingPriceCny: defaultTrainingPriceCny };
const defaultNegativePrompt = "worst quality, low quality, score_1, score_2, score_3, artist name";
// 共享组件写入每个模型版本，客户端始终以在线目录为唯一事实源。
const animaComponents = {
  textEncoderFileName: "qwen_3_06b_base.safetensors",
  textEncoderSha256: "cd2a512003e2f9f3cd3c32a9c3573f820bb28c940f73c57b1ddaa983d9223eba",
  vaeFileName: "qwen_image_vae.safetensors",
  vaeSha256: "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
};
// 正方形使用 37 步与约 1160² 潜空间，极端横竖幅按实测使用 34 步；LoRA 不降低质量参数，目标耗时为 240～280 秒。
const balancedFullCheckpointSampling = {
  qualityProfile: "balanced-exclusive-260s-v6",
  targetSeconds: 260,
  steps: 37,
  aspectStepThreshold: 1.5,
  aspectAdjustedSteps: 34,
  samplingMaxEdge: 1536,
  samplingPixelBudget: 1350000,
  samplingPixelBudgetAspectSlope: 0,
  generationPresets: {
    fast: { steps: 20, aspectAdjustedSteps: 18, samplingMaxEdge: 1280, samplingPixelBudget: 786432 },
    quality: { steps: 37, aspectAdjustedSteps: 34, samplingMaxEdge: 1536, samplingPixelBudget: 1350000 },
    extreme: { steps: 45, aspectAdjustedSteps: 42, samplingMaxEdge: 1792, samplingPixelBudget: 2073600 },
  },
  availableSamplers: ["er_sde", "euler", "euler_ancestral"],
  availableSchedulers: ["simple", "normal"],
  systemTurboLoraEnabled: false,
  systemHighresLoraEnabled: false,
};

// 模型文件名、哈希、CFG 与采样器来自对应版本；像素预算按生产 P40 的横竖幅与正方形任务实测校准到约 260 秒。
const modelCatalog = [
  {
    workflowVersion: 28,
    fileName: "anima-base-v1.0.safetensors",
    desktopResourceGroupId: "model.anima-base-v10",
    displayName: "Anima Base v1.0",
    description: "Anima Base v1.0 原生底模，仅加载用户主动选择的 LoRA。",
    runtimeSlug: "comfyui-anima-production-v1",
    productCode: "local.anima-base-v1.image",
    sourceUrls: ["https://huggingface.co/circlestone-labs/Anima/"],
    sourceVersionId: null,
    sha256: "BD43B7CFFE1ED1153D9C41E7BEB2F18CB1273EAFBAA3AF3EDD6A173DC90A006E",
    byteSize: 4182218328,
    parameters: { profileRevision: 11, ...balancedFullCheckpointSampling, cfg: 4, sampler: "er_sde", scheduler: "simple", qualityPrefix: "masterpiece, best quality, score_7", defaultNegativePrompt, systemTurboLoraEnabled: false, systemLoraSha256: [] },
  },
  {
    workflowVersion: 29,
    fileName: "animeBulldozer_anima.safetensors",
    desktopResourceGroupId: "model.anime-bulldozer-anima",
    displayName: "Anime Bulldozer Anima",
    description: "Anime/bulldozer Anima 完整微调底模，偏高完成度动漫插画。",
    runtimeSlug: "comfyui-anime-bulldozer-anima-v1",
    productCode: "local.anime-bulldozer-anima.image",
    sourceUrls: ["https://civitai.com/models/264323/animebulldozer?modelVersionId=3047288"],
    sourceVersionId: 3047288,
    sha256: "8E279F111ED7E7EA214EA61850E002F700CCE55A8CD027675796773089B3C739",
    byteSize: 4182218504,
    parameters: { profileRevision: 10, ...balancedFullCheckpointSampling, cfg: 4, sampler: "er_sde", scheduler: "simple", qualityPrefix: "masterpiece, best quality, score_7, very aesthetic", defaultNegativePrompt: `${defaultNegativePrompt}, blurry, jpeg artifacts, sepia, muscular female` },
  },
  {
    workflowVersion: 30,
    fileName: "miaomiaoRealskin_anima11.safetensors",
    desktopResourceGroupId: "model.miaomiao-realskin-anima11",
    displayName: "MiaoMiao RealSkin Anima 1.1",
    description: "MiaoMiao RealSkin Anima 1.1 完整微调底模，面向写实皮肤与摄影质感。",
    runtimeSlug: "comfyui-miaomiao-realskin-anima11",
    productCode: "local.miaomiao-realskin-anima11.image",
    sourceUrls: ["https://civitai.com/models/2026594/miaomiao-realskin?modelVersionId=3071702"],
    sourceVersionId: 3071702,
    sha256: "D33247D48A9C15A872AEF963940FC87362F925E3E087365810AD747042FCC454",
    byteSize: 4182218328,
    parameters: { profileRevision: 10, ...balancedFullCheckpointSampling, cfg: 4, sampler: "euler_ancestral", scheduler: "normal", qualityPrefix: "best quality, score_7, score_9, very aesthetic, ultra detailed, fair skin, high contrast, photorealistic, raw photo, photo background", defaultNegativePrompt },
  },
  {
    workflowVersion: 31,
    fileName: "miaomiao3DHarem_animaLH3D10.safetensors",
    desktopResourceGroupId: "model.miaomiao-3d-harem-anima-lh3d10",
    displayName: "MiaoMiao 3D Harem Anima LH3D 1.0",
    description: "MiaoMiao 3D Harem Anima LH3D 1.0 完整微调底模，面向精细三维动漫质感。",
    runtimeSlug: "comfyui-miaomiao-3d-harem-anima-lh3d10",
    productCode: "local.miaomiao-3d-harem-anima-lh3d10.image",
    sourceUrls: ["https://civitai.com/models/431957/miaomiao-3d-harem?modelVersionId=3074791"],
    sourceVersionId: 3074791,
    sha256: "0707CBE8DEED6C858A6BA8DFBCFE2006E3A4FD44C099AAFD048400FDEC1866DD",
    byteSize: 4182218328,
    parameters: { profileRevision: 10, ...balancedFullCheckpointSampling, cfg: 4, sampler: "euler_ancestral", scheduler: "normal", qualityPrefix: "best quality, score_7, score_9, very aesthetic, ultra detailed, high contrast", defaultNegativePrompt },
  },
  {
    workflowVersion: 32,
    fileName: "waiANIMA_v10Base10.safetensors",
    desktopResourceGroupId: "model.wai-anima-v10",
    displayName: "WAI Anima v1.0",
    description: "WAI Anima v1.0 完整微调底模，面向高质量二次元角色插画。",
    runtimeSlug: "comfyui-wai-anima-v10-base10",
    productCode: "local.wai-anima-v10.image",
    sourceUrls: ["https://civitai.com/models/2544636/wai-anima?modelVersionId=2983680"],
    sourceVersionId: 2983680,
    sha256: "9D5A1E1393C2978D6A979FAB38FB0DEE00BC2A94E354196C9F3CF2F6F56D5FBF",
    byteSize: 4182233976,
    parameters: { profileRevision: 7, ...balancedFullCheckpointSampling, cfg: 4.5, sampler: "euler_ancestral", scheduler: "normal", qualityPrefix: "masterpiece, best quality, score_7", defaultNegativePrompt: `${defaultNegativePrompt}, blurry, jpeg artifacts, lowres, censor` },
  },
  {
    workflowVersion: 33,
    fileName: "miaomiaoHarem_anima8Step10.safetensors",
    desktopResourceGroupId: "model.miaomiao-harem-anima8step10",
    displayName: "MiaoMiao Harem Anima 8-Step 1.0",
    description: "MiaoMiao Harem Anima 8-Step 1.0 蒸馏底模，使用 12 步质量档与 CFG 1；该实验版本仅用于推理。",
    runtimeSlug: "comfyui-miaomiao-harem-anima8step10",
    productCode: "local.miaomiao-harem-anima8step10.image",
    sourceUrls: ["https://civitai.com/models/934764/miaomiao-harem?modelVersionId=3125933"],
    sourceVersionId: 3125933,
    sha256: "10760718321F82577F648893416655FB979A8026CDD8977FD74A9AC998E1314A",
    byteSize: 4182218328,
    // 蒸馏模型按作者建议使用 Euler A + Normal，独立配置避免被完整底模的 37 步质量档覆盖。
    parameters: {
      profileRevision: 2,
      qualityProfile: "miaomiao-harem-anima8step-v2",
      targetSeconds: 90,
      steps: 12,
      aspectStepThreshold: 1.5,
      aspectAdjustedSteps: 12,
      samplingMaxEdge: 1536,
      samplingPixelBudget: 1350000,
      samplingPixelBudgetAspectSlope: 0,
      generationPresets: {
        fast: { steps: 8, aspectAdjustedSteps: 8, samplingMaxEdge: 1280, samplingPixelBudget: 786432 },
        quality: { steps: 12, aspectAdjustedSteps: 12, samplingMaxEdge: 1536, samplingPixelBudget: 1350000 },
        extreme: { steps: 30, aspectAdjustedSteps: 30, samplingMaxEdge: 1536, samplingPixelBudget: 1350000 },
      },
      availableSamplers: ["euler", "euler_ancestral"],
      availableSchedulers: ["normal", "beta"],
      cfg: 1,
      sampler: "euler_ancestral",
      scheduler: "normal",
      qualityPrefix: "masterpiece, best quality, score_7, safe, very aesthetic, ultra detailed, pale skin, fair skin, high contrast",
      defaultNegativePrompt,
      systemTurboLoraEnabled: false,
      systemHighresLoraEnabled: false,
      trainingSupported: false,
    },
  },
];

try {
  // 部署 bootstrap 只补齐缺失目录，不覆盖管理员已保存的启停、价格、尺寸和尝试次数。
  const family = await database.modelFamily.findUnique({ where: { slug: "anima" } }) ?? await database.modelFamily.create({
    data: { slug: "anima", name: "Anima", description: "Anima 本地动漫图像模型系列", status: "ACTIVE" },
  });
  const template = await database.workflowTemplate.findUnique({ where: { slug: "anima-text-to-image" } }) ?? await database.workflowTemplate.create({
    data: { slug: "anima-text-to-image", name: "Anima 文生图", description: "按底模目录选择独立采样预设的 Anima 文生图工作流", status: "ACTIVE" },
  });

  for (const catalog of modelCatalog) {
    const defaults = { ...sharedDefaults, ...animaComponents, ...catalog.parameters, productCode: catalog.productCode, sourceUrls: catalog.sourceUrls, sourceUrl: null, sourceVersionId: catalog.sourceVersionId, modelSha256: catalog.sha256, modelByteSize: catalog.byteSize, desktopResourceGroupId: catalog.desktopResourceGroupId, desktopStorageFileName: catalog.fileName, desktopDownloadEnabled: true };
    const model = await database.modelVersion.findUnique({ where: { familyId_version: { familyId: family.id, version: catalog.fileName } } }) ?? await database.modelVersion.create({
      data: { familyId: family.id, version: catalog.fileName, displayName: catalog.displayName, description: catalog.description, status: "ACTIVE", runtimeFormat: "anima", defaultParameters: defaults },
    });
    const modelDefaults = readObject(model.defaultParameters);
    const missingDefaults = Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in modelDefaults)));
    const storedProfileRevision = Number(modelDefaults.profileRevision || 0);
    const desiredProfileRevision = Number(catalog.parameters.profileRevision || 0);
    // 性能配置按版本只迁移一次；价格、尝试次数和管理员维护的非采样字段继续保持不变。
    const profilePatch = desiredProfileRevision > storedProfileRevision ? catalog.parameters : {};
    const nextModelDefaults = { ...modelDefaults, ...missingDefaults, ...profilePatch };
    const descriptionChanged = model.description !== catalog.description;
    if (Object.keys(missingDefaults).length > 0 || Object.keys(profilePatch).length > 0 || descriptionChanged) {
      // 模型能力说明随目录更新；历史工作流仍由独立版本保留，不改写已经被任务引用的快照。
      await database.modelVersion.update({ where: { id: model.id }, data: { defaultParameters: nextModelDefaults, description: catalog.description } });
    }
    const effectiveDefaults = { ...defaults, ...nextModelDefaults };
    const runtime = await database.runtimeDefinition.findUnique({ where: { slug: catalog.runtimeSlug } }) ?? await database.runtimeDefinition.create({
      data: { modelVersionId: model.id, slug: catalog.runtimeSlug, runtimeType: "comfyui", healthPath: "/system_stats", status: "ACTIVE" },
    });
    const workflowJson = {
      runtimeBuilder: "@drawhime/inference-runtime:buildAnimaWorkflow",
      revision: 4,
      model: catalog.fileName,
      modelSha256: catalog.sha256,
      sourceVersionId: catalog.sourceVersionId,
      sampling: { targetSeconds: effectiveDefaults.targetSeconds, steps: effectiveDefaults.steps, aspectStepThreshold: effectiveDefaults.aspectStepThreshold, aspectAdjustedSteps: effectiveDefaults.aspectAdjustedSteps, cfg: effectiveDefaults.cfg, sampler: effectiveDefaults.sampler, scheduler: effectiveDefaults.scheduler, maxEdge: effectiveDefaults.samplingMaxEdge, pixelBudget: effectiveDefaults.samplingPixelBudget, aspectSlope: effectiveDefaults.samplingPixelBudgetAspectSlope },
      systemLoras: [
        ...(effectiveDefaults.systemTurboLoraEnabled === false ? [] : ["anima-turbo-lora-v0.2.safetensors"]),
        ...(effectiveDefaults.systemHighresLoraEnabled === false ? [] : ["anima-highres-aesthetic-boost.safetensors"]),
      ],
      clip: "qwen_3_06b_base.safetensors",
      vae: "qwen_image_vae.safetensors",
      output: { format: "WEBP", quality: 100, maxEdge: effectiveDefaults.maxEdge, upscaleMethod: "lanczos" },
    };
    const workflowSha256 = createHash("sha256").update(JSON.stringify(workflowJson)).digest("hex");
    const existingWorkflow = await database.workflowVersion.findUnique({ where: { workflowTemplateId_version: { workflowTemplateId: template.id, version: catalog.workflowVersion } } });
    if (!existingWorkflow) await database.workflowVersion.create({
      data: { workflowTemplateId: template.id, modelVersionId: model.id, runtimeDefinitionId: runtime.id, version: catalog.workflowVersion, workflowJson, inputMapping: { prompt: "prompt", negativePrompt: "negativePrompt", width: "width", height: "height", seed: "seed" }, outputMapping: { nodeId: "11", type: "image" }, sha256: workflowSha256, status: "ACTIVE" },
    });
    const pricing = readPricing(effectiveDefaults, catalog.productCode);
    await publishPrice(pricing);
    console.log(`[bootstrap-anima] model=${model.id} file=${catalog.fileName} product=${pricing.productCode}@${pricing.pricingVersion}`);
  }

  const trainingPricing = readTrainingPricing(sharedDefaults);
  await publishPrice({ ...trainingPricing, billingUnit: "training_job" });
} finally {
  await database.$disconnect();
}

/** 向主站发布不可变价格版本，主站仍是扣费金额权威。 */
async function publishPrice(pricing) {
  const baseUrl = process.env.MAIN_PLATFORM_INTERNAL_URL?.trim();
  const token = process.env.MAIN_PLATFORM_CLIENT_SECRET?.trim();
  if (!baseUrl || !token) throw new Error("主站价格集成配置不完整");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/internal/integrations/local-model/prices`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-local-platform-token": token },
    body: JSON.stringify({ productCode: pricing.productCode, pricingVersion: pricing.pricingVersion, unitPrice: pricing.priceCny, billingUnit: pricing.billingUnit || "image", currency: "CNY" }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.message || `主站价格发布失败：HTTP ${response.status}`);
}

/** 读取独立的固定训练产品价格，训练成本不会冒充图片张数。 */
function readTrainingPricing(value) {
  const defaults = readObject(value);
  const productCode = String(defaults.trainingProductCode || defaultTrainingProductCode);
  const pricingVersion = Number(defaults.trainingPricingVersion || defaultTrainingPricingVersion);
  const priceCny = Number(defaults.trainingPriceCny || defaultTrainingPriceCny).toFixed(2);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/.test(productCode) || !Number.isSafeInteger(pricingVersion) || pricingVersion <= 0 || Number(priceCny) <= 0) throw new Error("模型持久化训练价格配置不正确");
  return { productCode, pricingVersion, priceCny };
}

/** 从已持久化模型配置读取当前价格，部署时不回退覆盖管理员配置。 */
function readPricing(value, fallbackProductCode) {
  const defaults = readObject(value);
  const productCode = String(defaults.productCode || fallbackProductCode);
  const pricingVersion = Number(defaults.pricingVersion || defaultPricingVersion);
  const priceCny = Number(defaults.priceCny || defaultPriceCny).toFixed(2);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/.test(productCode) || !Number.isSafeInteger(pricingVersion) || pricingVersion <= 0 || Number(priceCny) <= 0) throw new Error("模型持久化价格配置不正确");
  return { productCode, pricingVersion, priceCny };
}

/** 将 Prisma JSON 读取为普通对象。 */
function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
