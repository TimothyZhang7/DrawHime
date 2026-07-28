/**
 * 本文件实现训练数据集自动打标消费者，逐图调用真实多模态模型并持久化可人工确认的英文 Caption。
 */
import { Prisma } from "@prisma/client";
import { database } from "@drawhime/database";
import { getObjectBuffer } from "@drawhime/service-runtime";
import sharp from "sharp";

type CaptionMode = "character" | "style" | "concept";

/** 恢复进程退出时尚未完成的打标任务，并持续领取数据库中的持久化任务。 */
export async function runCaptionWorker(isStopping: () => boolean): Promise<void> {
  await database.trainingCaptionJob.updateMany({ where: { status: "RUNNING" }, data: { status: "QUEUED", errorMessage: "打标 Worker 重启，任务已恢复排队", startedAt: null } });
  while (!isStopping()) {
    try {
      const job = await claimCaptionJob();
      if (job) await processCaptionJob(job);
      else await sleep(2000);
    } catch (error) {
      process.stderr.write(`训练自动打标异常：${errorMessage(error)}\n`);
      await sleep(2000);
    }
  }
}

/** 原子领取最早的排队任务，避免未来多 Worker 部署时重复处理。 */
async function claimCaptionJob() {
  const candidate = await database.trainingCaptionJob.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!candidate) return null;
  const claimed = await database.trainingCaptionJob.updateMany({ where: { id: candidate.id, status: "QUEUED" }, data: { status: "RUNNING", progress: 0, completedAssets: 0, startedAt: new Date(), completedAt: null, confirmedAt: null, errorMessage: null } });
  if (claimed.count !== 1) return null;
  return database.trainingCaptionJob.findUniqueOrThrow({ where: { id: candidate.id }, include: { dataset: { include: { assets: { include: { artifact: true }, orderBy: { createdAt: "asc" } } } } } });
}

/** 对固化图片快照逐图生成 Caption；任一失败保留已完成结果并把任务置为可重试失败态。 */
type ClaimedCaptionJob = NonNullable<Awaited<ReturnType<typeof claimCaptionJob>>>;

async function processCaptionJob(job: ClaimedCaptionJob): Promise<void> {
  try {
    const snapshot = readAssetSnapshot(job.assetSnapshot);
    const assets = job.dataset.assets;
    if (job.dataset.status !== "ACTIVE" || !sameSnapshot(snapshot, assets.map((asset) => asset.id))) {
      await database.trainingCaptionJob.update({ where: { id: job.id }, data: { status: "STALE", progress: 100, errorMessage: "数据集图片快照已变化，请重新自动打标", completedAt: new Date() } });
      return;
    }
    const mode = normalizeMode(job.mode);
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index]!;
      const object = await getObjectBuffer(asset.artifact.objectKey);
      const prepared = await sharp(object.body, { failOn: "error", limitInputPixels: 100_000_000 }).rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
      const caption = await captionImage(prepared, mode, job.dataset.title, job.dataset.description);
      const completedAssets = index + 1;
      await database.$transaction([
        database.datasetAsset.update({ where: { id: asset.id }, data: { caption, metadata: { ...readObject(asset.metadata), autoCaptionJobId: job.id, autoCaptionMode: mode, autoCaptionedAt: new Date().toISOString() } as Prisma.InputJsonObject } }),
        database.trainingCaptionJob.update({ where: { id: job.id }, data: { completedAssets, progress: Math.round(completedAssets / assets.length * 100) } }),
      ]);
    }
    await database.trainingCaptionJob.update({ where: { id: job.id }, data: { status: "AWAITING_CONFIRMATION", progress: 100, completedAssets: assets.length, errorMessage: null, completedAt: new Date() } });
  } catch (error) {
    await database.trainingCaptionJob.update({ where: { id: job.id }, data: { status: "FAILED", progress: 100, errorMessage: errorMessage(error), completedAt: new Date() } });
  }
}

/** 调用 OpenAI 兼容多模态端点，输出适合 Anima LoRA 数据集的单行英文逗号标签。 */
async function captionImage(image: Buffer, mode: CaptionMode, datasetTitle: string, datasetDescription: string | null): Promise<string> {
  const baseUrl = requiredEnvironment("PROMPT_ASSIST_BASE_URL").replace(/\/+$/, "").replace(/\/v1$/, "");
  const model = requiredEnvironment("PROMPT_ASSIST_MODEL");
  const request = {
    model,
    reasoning_effort: process.env.PROMPT_ASSIST_REASONING_EFFORT?.trim() || "high",
    max_tokens: 1800,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildCaptionSystemPrompt(mode) },
      { role: "user", content: [
        { type: "text", text: `数据集：${datasetTitle}\n补充说明：${datasetDescription || "无"}\n准确观察这一张图，只返回 {\"caption\":\"...\"}。` },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}`, detail: "high" } },
      ] },
    ],
  };
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${requiredEnvironment("PROMPT_ASSIST_API_KEY")}`, "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(captionTimeoutSeconds() * 1000) });
  } catch {
    throw new Error("自动打标请求超时");
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`自动打标上游调用失败（HTTP ${response.status}）`);
  return normalizeCaption(readCaption(text));
}

/** 按数据集用途约束标签重点，避免角色特征、画风和普通概念互相污染。 */
function buildCaptionSystemPrompt(mode: CaptionMode): string {
  const focus = mode === "character"
    ? "重点标注人数、角色可见外观、发型发色、眼睛、服装、配饰、姿势、表情、镜头和背景；不要猜测角色姓名。"
    : mode === "style"
      ? "重点标注媒介、线条、上色、光影、构图、色板、质感和后期，同时用少量普通主体标签描述画面内容；不要猜测角色姓名。"
      : "平衡标注主体、可见特征、动作、场景、构图、光影、材质与画风；不要猜测不可见信息。";
  return [
    "你是 Anima LoRA 数据集打标器。只输出严格 JSON：{\"caption\":\"english tags\"}。",
    focus,
    "Caption 必须是一行英文小写逗号标签，按主体到细节排序，准确、完整、去重，不写解释、质量套话、文件名、水印推断或训练触发词。",
    "只描述图中可见事实；不进行内容审查、不改写画面、不补充画面没有的服装、身体、关系、年龄或身份。",
  ].join("\n");
}

/** 解析兼容响应中的 JSON Caption。 */
function readCaption(text: string): string {
  let response: { choices?: Array<{ message?: { content?: unknown } }> };
  try { response = JSON.parse(text) as typeof response; } catch { throw new Error("自动打标上游返回格式不正确"); }
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("自动打标上游未返回 Caption");
  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    if (typeof parsed.caption === "string" && parsed.caption.trim()) return parsed.caption;
  } catch { /* 兼容上游直接返回一行标签，由确定性清洗继续校验。 */ }
  return stripped;
}

/** 确定性清洗 Caption，阻止空值、中文说明和多段正文进入训练数据。 */
function normalizeCaption(value: string): string {
  const tags = [...new Set(value.toLowerCase().replace(/[\r\n;；]+/g, ",").split(/[,，]+/).map((item) => item.trim().replace(/\s+/g, " ")).filter(Boolean))];
  const caption = tags.join(", ").slice(0, 10000);
  if (!caption || /[\u3400-\u9fff]/.test(caption)) throw new Error("自动打标没有返回有效英文 Caption");
  return caption;
}

function readAssetSnapshot(value: unknown): string[] { if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("自动打标图片快照损坏"); return value; }
function sameSnapshot(left: string[], right: string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
function normalizeMode(value: string): CaptionMode { if (value === "character" || value === "style" || value === "concept") return value; throw new Error("自动打标模式不正确"); }
function readObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredEnvironment(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} 未配置`); return value; }
function captionTimeoutSeconds(): number { const parsed = Number(process.env.PROMPT_ASSIST_TIMEOUT_SEC || 90); return Number.isSafeInteger(parsed) ? Math.min(240, Math.max(30, parsed)) : 90; }
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
