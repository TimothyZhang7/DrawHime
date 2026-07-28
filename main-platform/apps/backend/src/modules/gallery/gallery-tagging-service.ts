/**
 * 本文件实现图库自动中文标签服务。
 *
 * 职责：
 * - 成功图片只异步入队，不阻塞绘图完成、余额退款或任务状态写入。
 * - 调用真实视觉模型，根据最终图片、提示词和生成参数生成中文短标题与详细短标签。
 * - 首次创建标签时生成固定配色，同名标签全站保持一致。
 */
import { createHash, randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { invalidateGalleryCache, invalidateImageCache } from '../../shared/cache/cache-service.js';

/** 图库标签分类，必须与 shared-contracts 保持一致。 */
type GalleryTagCategory = 'subject' | 'feature' | 'scene' | 'style' | 'composition' | 'mood' | 'safety' | 'other';

/** 打标运行时配置；API Key 只在后端使用，不返回浏览器。 */
type GalleryTaggingRuntimeConfig = {
  enabled: boolean;
  includePrivate: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSec: number;
  maxTags: number;
  maxAttempts: number;
  minConfidence: number;
  systemPrompt: string;
  publicBaseUrl: string;
};

type RawTagItem = {
  name?: unknown;
  category?: unknown;
  confidence?: unknown;
  weight?: unknown;
};

type NormalizedTaggingResult = {
  title: string | null;
  tags: NormalizedTagInput[];
};

type NormalizedTagInput = {
  name: string;
  slug: string;
  category: GalleryTagCategory;
  confidence: number;
  weight: number;
};

type GalleryTaggingTaskContext = {
  taskId: string;
  prompt: string;
  mode: string;
  source: string;
  isPrivate: boolean;
  imageUrl: string;
  generationParams: Record<string, unknown>;
  upstream: { model?: string | null; siteName?: string | null };
};

const DEFAULT_SYSTEM_PROMPT = [
  '你是绘图姬 DrawHime 的图库标题与中文标签助手。',
  '你需要根据最终图片和原始提示词生成一个中文短标题，并生成尽可能详细但简短的中文检索标签。',
  '标签必须以最终图片中可见内容为主，提示词和任务参数只作为辅助判断。',
  '标题必须概括图片主体和关键动作或氛围，不要直接复制长提示词。',
  '不要输出“高质量、杰作、图片、作品、好看、细节丰富”等无检索价值泛词。',
  '如果提示词提到但图片中不可见，不要打该标签。',
  '必须返回严格 JSON，格式为 {"title":"白发少女雪地立绘","tags":[{"name":"白发少女","category":"subject","confidence":0.96,"weight":95}]}。',
].join('\n');

const CATEGORY_SET = new Set<GalleryTagCategory>(['subject', 'feature', 'scene', 'style', 'composition', 'mood', 'safety', 'other']);
const CATEGORY_LIMITS: Record<GalleryTagCategory, number> = {
  subject: 4,
  feature: 8,
  scene: 4,
  style: 4,
  composition: 3,
  mood: 4,
  safety: 3,
  other: 4,
};
const CATEGORY_PRIORITY: Record<GalleryTagCategory, number> = {
  subject: 0,
  feature: 1,
  scene: 2,
  style: 3,
  composition: 4,
  mood: 5,
  safety: 6,
  other: 7,
};
const GENERIC_TAGS = new Set(['图片', '作品', '艺术', '好看', '高质量', '杰作', '精细', '细节', '精美', '高清', '漂亮', '美丽', '生成图', '插画']);
const SYNONYM_MAP = new Map<string, string>([
  ['女孩', '少女'],
  ['女生', '少女'],
  ['女孩子', '少女'],
  ['男孩', '少年'],
  ['男生', '少年'],
  ['二次元风格', '二次元'],
  ['动漫风格', '二次元'],
  ['动画风格', '二次元'],
  ['近景', '特写'],
  ['肖像', '头像'],
]);
/** 历史任务少于该数量时会小批量补跑，避免旧封面长期只有少量标签。 */
const MIN_DETAILED_TAG_COUNT = 12;

/** 图库自动标签服务。 */
export class GalleryTaggingService {
  private readonly prisma: PrismaClient = getPrismaClient();

  /** 成功任务进入终态后只创建打标 job；失败不会影响主任务状态。 */
  async enqueueTask(taskId: string): Promise<void> {
    if (!isSafeTaskId(taskId)) return;
    try {
      const representativeTaskId = await this.findBatchRepresentativeTaskId(taskId);
      if (representativeTaskId !== taskId) return;
      await this.prisma.galleryTaggingJob.upsert({
        where: { taskId },
        update: {},
        create: { taskId, status: 'pending' },
      });
    } catch {
      // 打标队列是旁路增强能力；入队失败不能影响生成状态写入。
    }
  }

  /** 处理一批待打标任务，供 ops-worker 或运维接口触发。 */
  async processPending(limitInput = 3): Promise<{ processed: number; succeeded: number; failed: number; skipped: number }> {
    const limit = Math.min(Math.max(Math.floor(limitInput) || 3, 1), 10);
    const config = await this.readConfig();
    if (!config.enabled) return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
    await this.releaseStaleRunningJobs(config);

    let jobs = await this.prisma.galleryTaggingJob.findMany({
      where: { status: { in: ['pending', 'failed'] }, attemptCount: { lt: config.maxAttempts } },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true, taskId: true },
    });
    if (jobs.length < limit) {
      await this.enqueueMissingSuccessfulTasks(limit - jobs.length, config.includePrivate);
      jobs = await this.prisma.galleryTaggingJob.findMany({
        where: { status: { in: ['pending', 'failed'] }, attemptCount: { lt: config.maxAttempts } },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        take: limit,
        select: { id: true, taskId: true },
      });
    }

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    for (const job of jobs) {
      const result = await this.processJob(job.id, job.taskId, config);
      if (result === 'success') succeeded++;
      else if (result === 'skipped') skipped++;
      else failed++;
    }
    return { processed: jobs.length, succeeded, failed, skipped };
  }

  /** 回收卡在 running 的打标 job；AI 调用是旁路能力，超时后转回 failed 交给正常重试次数控制。 */
  private async releaseStaleRunningJobs(config: GalleryTaggingRuntimeConfig): Promise<number> {
    const staleMs = Math.max(config.timeoutSec * 2000, 5 * 60 * 1000);
    const cutoff = new Date(Date.now() - staleMs);
    const result = await this.prisma.galleryTaggingJob.updateMany({
      where: { status: 'running', updatedAt: { lt: cutoff } },
      data: {
        status: 'failed',
        error: '图库打标运行超时，已自动回收等待重试',
        finishedAt: new Date(),
      },
    });
    if (result.count > 0) {
      console.log(`[gallery-tagging] 已回收 ${result.count} 个超时 running 打标任务`);
    }
    return result.count;
  }

  /** 小批量补齐历史成功图库任务；只创建打标队列，不修改任务主状态、余额或图片记录。 */
  private async enqueueMissingSuccessfulTasks(limitInput: number, includePrivate: boolean): Promise<number> {
    const limit = Math.min(Math.max(Math.floor(limitInput) || 1, 1), 10);
    const privacySql = includePrivate ? Prisma.empty : Prisma.sql`AND t.is_private = false`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT t.id
      FROM generation_tasks t
      WHERE t.status = 'success'
        ${privacySql}
        AND EXISTS (
          SELECT 1 FROM system_configs c
          WHERE c.\`key\` = CONCAT('task_image_', t.id)
            AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.value, '$.imageFilename')), '') <> ''
        )
        AND NOT EXISTS (
          SELECT 1 FROM gallery_tagging_jobs running_job
          WHERE running_job.task_id = t.id
            AND running_job.status = 'running'
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM gallery_tagging_jobs j
            WHERE j.task_id = t.id
          )
          OR NOT EXISTS (
            SELECT 1 FROM system_configs title_cfg
            WHERE title_cfg.\`key\` = CONCAT('task_gallery_title_', t.id)
              AND TRIM(title_cfg.value) <> ''
          )
          OR (
            SELECT COUNT(1)
            FROM generation_task_tags gtt
            INNER JOIN gallery_tags gt ON gt.id = gtt.tag_id
            WHERE gtt.task_id = t.id
              AND gt.disabled = false
          ) < ${MIN_DETAILED_TAG_COUNT}
        )
        AND (
          t.batch_id IS NULL
          OR COALESCE(t.batch_total, 1) <= 1
          OR t.id = (
            SELECT t2.id
            FROM generation_tasks t2
            WHERE t2.batch_id = t.batch_id
            ORDER BY COALESCE(t2.batch_index, 1) ASC, t2.created_at ASC, t2.id ASC
            LIMIT 1
          )
        )
      ORDER BY t.created_at DESC
      LIMIT ${limit}
    `);
    const taskIds = rows.map((row) => row.id).filter(isSafeTaskId);
    if (taskIds.length === 0) return 0;
    let touched = 0;
    for (const taskId of taskIds) {
      const result = await this.prisma.galleryTaggingJob.upsert({
        where: { taskId },
        update: { status: 'pending', error: null },
        create: { taskId, status: 'pending' },
      });
      if (result) touched++;
    }
    return touched;
  }

  /** 处理单个打标 job；所有业务写入在事务中完成，避免标签字典与任务关联不同步。 */
  private async processJob(jobId: number, taskId: string, config: GalleryTaggingRuntimeConfig): Promise<'success' | 'failed' | 'skipped'> {
    const claimed = await this.prisma.galleryTaggingJob.updateMany({
      where: { id: jobId, status: { in: ['pending', 'failed'] } },
      data: { status: 'running', startedAt: new Date(), error: null, attemptCount: { increment: 1 } },
    });
    if (claimed.count === 0) return 'skipped';

    try {
      const representativeTaskId = await this.findBatchRepresentativeTaskId(taskId);
      if (representativeTaskId !== taskId) {
        // 历史队列中可能已存在同批非图一任务；直接跳过，避免继续消耗视觉模型。
        await this.markJobSkipped(taskId, '多图批次只对图一生成标签');
        return 'skipped';
      }
      const context = await this.readTaskContext(taskId);
      if (!context) {
        await this.markJobSkipped(taskId, '任务不存在或没有可读取图片');
        return 'skipped';
      }
      if (context.isPrivate && !config.includePrivate) {
        await this.markJobSkipped(taskId, '私密图片默认不发送外部 AI 打标');
        return 'skipped';
      }
      if (!config.apiKey || !config.baseUrl) {
        await this.markJobFailed(taskId, config.model, '后台未配置图库打标 API');
        return 'failed';
      }

      const image = await this.fetchImageBuffer(config, context.imageUrl);
      const raw = await callTaggingVision(config, image.buffer, image.mimeType, context);
      const result = normalizeTaggingResult(raw, config);
      if (result.tags.length === 0) {
        await this.markJobSkipped(taskId, 'AI 未返回有效中文标签', raw, config.model);
        return 'skipped';
      }

      await this.writeTaggingResult(taskId, result, raw, config.model);
      // AI 标题和标签属于弱实时展示增强，软失效即可让首屏先返回旧列表并后台刷新。
      invalidateGalleryCache([`image:${taskId}`], { soft: true });
      invalidateImageCache(taskId);
      return 'success';
    } catch (error) {
      const message = error instanceof Error ? error.message : '图库打标失败';
      await this.markJobFailed(taskId, config.model, message);
      return 'failed';
    }
  }

  /** 读取任务、图片文件名、参数快照和成功上游信息，只读取打标所需字段。 */
  private async readTaskContext(taskId: string): Promise<GalleryTaggingTaskContext | null> {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { id: true, prompt: true, mode: true, source: true, isPrivate: true, status: true },
    });
    if (!task || task.status !== 'success') return null;

    const [imageRow, paramsRow, upstream] = await Promise.all([
      this.prisma.systemConfig.findUnique({ where: { key: `task_image_${taskId}` }, select: { value: true } }),
      this.prisma.systemConfig.findUnique({ where: { key: `task_generation_params_${taskId}` }, select: { value: true } }),
      this.prisma.generationSubTask.findFirst({
        where: { taskId, kind: 'upstream_attempt', status: 'success' },
        orderBy: { sequence: 'desc' },
        select: { model: true, siteName: true },
      }),
    ]);
    const image = parseJsonObject(imageRow?.value);
    const imageFilename = typeof image.imageFilename === 'string' ? image.imageFilename : '';
    if (!isSafeMediaFilename(imageFilename)) return null;

    return {
      taskId: task.id,
      prompt: task.prompt,
      mode: task.mode,
      source: task.source,
      isPrivate: task.isPrivate,
      imageUrl: `/images/${imageFilename}`,
      generationParams: parseJsonObject(paramsRow?.value),
      upstream: { model: upstream?.model ?? null, siteName: upstream?.siteName ?? null },
    };
  }

  /** 读取批次标签代表图；多图批次只允许固有顺序的图一打标，避免并发完成顺序导致多张图重复打标。 */
  private async findBatchRepresentativeTaskId(taskId: string): Promise<string | null> {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { id: true, batchId: true, batchTotal: true },
    });
    if (!task) return null;
    if (!task.batchId || (task.batchTotal ?? 1) <= 1) return task.id;
    const rows = await this.prisma.generationTask.findMany({
      where: { batchId: task.batchId },
      orderBy: [{ batchIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 1,
      select: { id: true },
    });
    return rows[0]?.id ?? task.id;
  }

  /** 读取已保存图片；通过 backend 自己的 /images 权限路径，避免直接耦合 media-service 文件目录。 */
  private async fetchImageBuffer(config: GalleryTaggingRuntimeConfig, imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const url = `${config.publicBaseUrl}${imageUrl}`;
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(Math.max(5, config.timeoutSec) * 1000) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '网络请求失败';
      throw new Error(`读取生成图片网络失败：${message}`);
    }
    if (!response.ok) throw new Error(`读取生成图片失败：${response.status}`);
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'image/png';
    if (!mimeType.startsWith('image/')) throw new Error('生成图片响应不是图片');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('生成图片为空');
    return { buffer, mimeType };
  }

  /** 事务写入 AI 标题、标签字典和任务关联；先删旧关联再写新结果，保证重跑结果一致。 */
  private async writeTaggingResult(taskId: string, result: NormalizedTaggingResult, raw: unknown, model: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const oldLinks = await tx.generationTaskTag.findMany({
        where: { taskId },
        select: { tagId: true },
      });
      if (oldLinks.length > 0) {
        await tx.generationTaskTag.deleteMany({ where: { taskId } });
        await decrementUsageCounts(tx, oldLinks.map((item) => item.tagId));
      }

      // AI 标题是图库展示增强字段，写入 system_configs 不替换 generation_tasks.prompt。
      await tx.systemConfig.upsert({
        where: { key: `task_gallery_title_${taskId}` },
        update: { value: result.title ?? '' },
        create: { key: `task_gallery_title_${taskId}`, value: result.title ?? '' },
      });

      for (const tag of result.tags) {
        const color = createTagColor(tag.category);
        const record = await tx.galleryTag.upsert({
          where: { name: tag.name },
          update: { category: tag.category },
          create: {
            name: tag.name,
            slug: tag.slug,
            category: tag.category,
            colorBg: color.bg,
            colorText: color.text,
            colorBorder: color.border,
          },
        });
        await tx.generationTaskTag.upsert({
          where: { taskId_tagId: { taskId, tagId: record.id } },
          update: { weight: tag.weight, confidence: tag.confidence, source: 'ai' },
          create: { taskId, tagId: record.id, weight: tag.weight, confidence: tag.confidence, source: 'ai' },
        });
        await tx.galleryTag.update({ where: { id: record.id }, data: { usageCount: { increment: 1 } } });
      }

      // 任务删除可能与外部 AI 返回并发；updateMany 在 job 已级联删除时保持幂等，不让旁路任务抛 P2025。
      await tx.galleryTaggingJob.updateMany({
        where: { taskId },
        data: {
          status: 'success',
          model,
          rawResultJson: raw as Prisma.InputJsonValue,
          error: null,
          finishedAt: new Date(),
        },
      });
    });
  }

  /** 读取图库打标配置；未配置独立项时复用现有图片反推配置，便于生产快速启用。 */
  private async readConfig(): Promise<GalleryTaggingRuntimeConfig> {
    const keys = [
      'gallery_auto_tag_enabled',
      'gallery_auto_tag_private_enabled',
      'gallery_auto_tag_base_url',
      'gallery_auto_tag_api_key',
      'gallery_auto_tag_model',
      'gallery_auto_tag_timeout_sec',
      'gallery_auto_tag_max_tags',
      'gallery_auto_tag_max_attempts',
      'gallery_auto_tag_min_confidence',
      'gallery_auto_tag_system_prompt',
      'tools_image_reverse_enabled',
      'tools_image_reverse_base_url',
      'tools_image_reverse_api_key',
      'tools_image_reverse_model',
      'tools_image_reverse_timeout_sec',
    ];
    const rows = await this.prisma.systemConfig.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
    const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      enabled: config.gallery_auto_tag_enabled === 'true'
        || (config.gallery_auto_tag_enabled !== 'false' && config.tools_image_reverse_enabled === 'true'),
      includePrivate: config.gallery_auto_tag_private_enabled === 'true',
      baseUrl: String(config.gallery_auto_tag_base_url ?? config.tools_image_reverse_base_url ?? '').trim(),
      apiKey: String(config.gallery_auto_tag_api_key ?? config.tools_image_reverse_api_key ?? '').trim(),
      model: String(config.gallery_auto_tag_model ?? config.tools_image_reverse_model ?? 'gpt-5-3').trim() || 'gpt-5-3',
      timeoutSec: clampInt(config.gallery_auto_tag_timeout_sec ?? config.tools_image_reverse_timeout_sec, 60, 5, 180),
      maxTags: clampInt(config.gallery_auto_tag_max_tags, 18, 6, 24),
      maxAttempts: clampInt(config.gallery_auto_tag_max_attempts, 5, 1, 20),
      minConfidence: clampNumber(config.gallery_auto_tag_min_confidence, 0.65, 0.1, 0.95),
      systemPrompt: String(config.gallery_auto_tag_system_prompt ?? DEFAULT_SYSTEM_PROMPT).trim() || DEFAULT_SYSTEM_PROMPT,
      // 自动打标由 backend 进程自己读取 /images，必须使用内部 backend 地址，不能使用前台 app_base_url。
      publicBaseUrl: normalizeBaseUrl(String(process.env.BACKEND_INTERNAL_URL ?? `http://localhost:${process.env.BACKEND_PORT ?? '6369'}`).trim() || `http://localhost:${process.env.BACKEND_PORT ?? '6369'}`),
    };
  }

  /** 标记 job 失败；失败可按 attempt_count 后续重试。 */
  private async markJobFailed(taskId: string, model: string, error: string): Promise<void> {
    // 用户删除任务时 job 会同步消失；失败收尾必须幂等，避免清理并发污染 backend 错误日志。
    await this.prisma.galleryTaggingJob.updateMany({
      where: { taskId },
      data: { status: 'failed', model, error: error.slice(0, 2000), finishedAt: new Date() },
    });
  }

  /** 标记 job 跳过；跳过表示当前配置或任务不适合打标，不会自动重试。 */
  private async markJobSkipped(taskId: string, error: string, raw?: unknown, model?: string): Promise<void> {
    await this.prisma.galleryTaggingJob.updateMany({
      where: { taskId },
      data: {
        status: 'skipped',
        model,
        error: error.slice(0, 2000),
        rawResultJson: raw as Prisma.InputJsonValue | undefined,
        finishedAt: new Date(),
      },
    });
  }
}

/** 调用 OpenAI 兼容视觉接口，要求返回严格 JSON 标题与标签结果。 */
async function callTaggingVision(
  config: GalleryTaggingRuntimeConfig,
  imageBuffer: Buffer,
  mimeType: string,
  context: GalleryTaggingTaskContext,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: config.systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: buildTaggingInstruction(config, context) },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutSec * 1000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '网络请求失败';
    throw new Error(`图库打标上游网络失败：${message}`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`图库打标上游失败：${response.status} ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
  const content = parsed.choices?.[0]?.message?.content;
  const jsonText = Array.isArray(content) ? content.map((item) => item.text ?? '').join('\n') : String(content ?? '');
  if (!jsonText.trim()) throw new Error('图库打标上游未返回内容');
  return JSON.parse(jsonText);
}

/** 构造打标请求说明；提示词只做辅助，最终标签必须以可见图片为准。 */
function buildTaggingInstruction(config: GalleryTaggingRuntimeConfig, context: GalleryTaggingTaskContext): string {
  return [
    '请同时输出 title 和 tags。title 必须是 4-14 个中文字符，简短自然，概括最终图片可见主体、动作或氛围，不替换原始提示词。',
    `请为这张最终生成图片输出 ${config.maxTags} 个以内中文短标签。`,
    '标签数量建议 12-18 个，最多不超过配置上限；每个标签 2-8 个中文字符。',
    '标签应尽量覆盖主体、发色、发型、服装、动作、表情、场景、风格、构图、光线和氛围。',
    '可用 category 只允许：subject, feature, scene, style, composition, mood, safety, other。',
    'weight 范围 1-100，90-100 表示核心主体或最强视觉特征，75-89 明显重要，55-74 可见但非核心，35-54 辅助氛围或构图，低于 35 不要返回。',
    `原始提示词：${context.prompt.slice(0, 1200)}`,
    `任务模式：${context.mode}；来源：${context.source}`,
    `生成参数：${JSON.stringify(context.generationParams).slice(0, 800)}`,
    `成功上游：${JSON.stringify(context.upstream).slice(0, 300)}`,
  ].join('\n');
}

/** 归一化 AI 标题和标签结果；过滤泛词、低置信度、超长标签并按权重排序截断。 */
function normalizeTaggingResult(raw: unknown, config: GalleryTaggingRuntimeConfig): NormalizedTaggingResult {
  const title = normalizeGalleryTitle((raw as { title?: unknown }).title);
  const items = Array.isArray((raw as { tags?: unknown }).tags) ? (raw as { tags: RawTagItem[] }).tags : [];
  const byName = new Map<string, NormalizedTagInput>();
  const categoryCounts = new Map<GalleryTagCategory, number>();
  for (const item of items) {
    const normalized = normalizeRawTag(item, config);
    if (!normalized) continue;
    const count = categoryCounts.get(normalized.category) ?? 0;
    if (count >= CATEGORY_LIMITS[normalized.category]) continue;
    const existing = byName.get(normalized.name);
    if (!existing || normalized.weight > existing.weight) {
      byName.set(normalized.name, normalized);
      categoryCounts.set(normalized.category, count + 1);
    }
  }
  const tags = [...byName.values()]
    .sort((a, b) => b.weight - a.weight || b.confidence - a.confidence || CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category] || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .slice(0, config.maxTags);
  return { title, tags };
}

/** 归一化单个标签，AI 输出不可信，必须后端二次清洗。 */
function normalizeRawTag(item: RawTagItem, config: GalleryTaggingRuntimeConfig): NormalizedTagInput | null {
  const rawName = typeof item.name === 'string' ? item.name.trim() : '';
  const name = normalizeTagName(rawName);
  if (!name || GENERIC_TAGS.has(name)) return null;
  const confidence = clampNumber(item.confidence, 0, 0, 1);
  if (confidence < config.minConfidence) return null;
  const category = normalizeCategory(item.category);
  let weight = clampInt(item.weight, 0, 0, 100);
  if (weight < 35) return null;
  if (category === 'subject') weight += 5;
  if (category === 'feature') weight += 3;
  if (category === 'style' || category === 'mood') weight -= 5;
  if (category === 'composition') weight -= 8;
  weight = Math.min(100, Math.max(1, weight));
  return { name, slug: createTagSlug(name), category, confidence, weight };
}

/** 中文标签标准化：只保留短中文标签，同义词归并。 */
function normalizeTagName(value: string): string {
  const cleaned = value.replace(/[^\u4e00-\u9fa5]/g, '').trim();
  if (cleaned.length < 2 || cleaned.length > 8) return '';
  return SYNONYM_MAP.get(cleaned) ?? cleaned;
}

/** 中文封面标题标准化：保留简短可读标题，过滤无检索价值泛词。 */
function normalizeGalleryTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 2) return null;
  if (/^(图片|作品|生成图|无标题|插画|绘图)$/i.test(cleaned)) return null;
  return cleaned.length > 18 ? cleaned.slice(0, 18) : cleaned;
}

/** 生成稳定 slug；中文 slug 用拼音并不可靠，这里使用短哈希保证唯一和 URL 安全。 */
function createTagSlug(name: string): string {
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 10);
  return `tag_${hash}`;
}

/** 首次创建标签时生成好看的浅色固定配色。 */
function createTagColor(category: GalleryTagCategory): { bg: string; text: string; border: string } {
  const range = categoryHueRange(category);
  for (let index = 0; index < 10; index++) {
    const hue = randomInt(range[0], range[1] + 1);
    const bg = hslToHex(hue, randomInt(70, 89), randomInt(92, 97));
    const text = hslToHex(hue, randomInt(45, 71), randomInt(28, 39));
    const border = hslToHex(hue, randomInt(55, 76), randomInt(72, 83));
    if (contrastRatio(bg, text) >= 4.5) return { bg, text, border };
  }
  return fallbackColor(category);
}

/** 分类对应色相范围，避免完全随机 RGB 产生脏色或刺眼色。 */
function categoryHueRange(category: GalleryTagCategory): [number, number] {
  if (category === 'subject') return [200, 230];
  if (category === 'feature') return [300, 340];
  if (category === 'scene') return [145, 180];
  if (category === 'style') return [250, 285];
  if (category === 'composition') return [35, 55];
  if (category === 'mood') return [185, 210];
  if (category === 'safety') return [0, 18];
  return [210, 260];
}

/** 分类默认色，随机生成多次不达标时兜底。 */
function fallbackColor(category: GalleryTagCategory): { bg: string; text: string; border: string } {
  const map: Record<GalleryTagCategory, { bg: string; text: string; border: string }> = {
    subject: { bg: '#EEF4FF', text: '#285BA8', border: '#B9D0FF' },
    feature: { bg: '#FCEEFF', text: '#8A3678', border: '#F0BDE4' },
    scene: { bg: '#EAF8F1', text: '#247653', border: '#B9E4CE' },
    style: { bg: '#F1EEFF', text: '#5F45A3', border: '#CDC2F8' },
    composition: { bg: '#FFF5DF', text: '#87611B', border: '#F0D394' },
    mood: { bg: '#EBF6FA', text: '#236B84', border: '#B7DDE8' },
    safety: { bg: '#FFF0F0', text: '#9A2E2E', border: '#F2B9B9' },
    other: { bg: '#F1F5F9', text: '#475569', border: '#CBD5E1' },
  };
  return map[category];
}

/** HSL 转十六进制颜色。 */
function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100;
  const lightness = l / 100;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lightness - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r1, g1, b1].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** 计算 WCAG 对比度，确保文字在标签背景上可读。 */
function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

function relativeLuminance(hex: string): number {
  const rgb = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** 任务 ID 校验，避免把任意字符串写入任务关联表。 */
function isSafeTaskId(taskId: string): boolean {
  return /^[a-zA-Z0-9:_-]{1,64}$/.test(taskId);
}

/** 媒体短文件名安全校验，避免拼接图片 URL 时发生路径穿越。 */
function isSafeMediaFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeCategory(value: unknown): GalleryTagCategory {
  const text = typeof value === 'string' ? value.trim() : '';
  return CATEGORY_SET.has(text as GalleryTagCategory) ? text as GalleryTagCategory : 'other';
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/** 减少旧关联标签 usage_count；只做非负保护，不影响任务和余额数据。 */
async function decrementUsageCounts(tx: Prisma.TransactionClient, tagIds: number[]): Promise<void> {
  for (const tagId of tagIds) {
    await tx.galleryTag.updateMany({
      where: { id: tagId, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
  }
}
