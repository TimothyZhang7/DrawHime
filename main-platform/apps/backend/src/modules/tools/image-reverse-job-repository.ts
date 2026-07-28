/** 本文件封装图片反推任务数据库读写，任务状态、源图引用和结构化结果均以数据库为准。 */
import { Prisma, type ImageReverseJob, type PrismaClient } from '@prisma/client';
import type {
  ImageReverseExtractOptions,
  ImageReverseJobAnalysisSummaryView,
  ImageReverseJobStatus,
  ImageReverseJobView,
  ImageReverseLanguage,
  ImageReverseMode,
  ImageReverseResultView,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { buildImageReverseReferencePrompt } from './image-reverse-reference-prompt.js';

const TERMINAL_STATUSES: ImageReverseJobStatus[] = ['succeeded', 'failed'];

/** 新建图片反推持久化任务所需字段。 */
export interface CreateImageReverseJobRecordInput {
  /** 服务端生成的任务 ID。 */
  id: string;
  /** 当前登录用户 ID。 */
  userId: number;
  /** 本次提取模式。 */
  mode: ImageReverseMode;
  /** 实际识图模型。 */
  model: string;
  /** 完整提取选项。 */
  options: ImageReverseExtractOptions;
  /** 用户上传时的文件名。 */
  sourceFileName: string;
  /** 私有原图短文件名。 */
  sourceStoredName: string;
  /** 私有预览短文件名。 */
  previewStoredName: string;
  /** 真实图片 MIME。 */
  sourceMimeType: string;
  /** 原图字节数。 */
  sourceSizeBytes: number;
  /** 原图宽度。 */
  sourceWidth: number;
  /** 原图高度。 */
  sourceHeight: number;
  /** 创建时间。 */
  createdAt: Date;
}

/** 图片反推持久化任务仓储。 */
export class ImageReverseJobRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  /** 任务先落库再进入识图队列，保证创建响应返回后刷新页面仍可恢复。 */
  async create(input: CreateImageReverseJobRecordInput): Promise<ImageReverseJob> {
    return this.prisma.imageReverseJob.create({
      data: {
        id: input.id,
        userId: input.userId,
        status: 'queued',
        progressText: '已提交，等待识图处理',
        mode: input.mode,
        model: input.model,
        optionsJson: toJsonValue(input.options),
        sourceFileName: input.sourceFileName,
        sourceStoredName: input.sourceStoredName,
        previewStoredName: input.previewStoredName,
        sourceMimeType: input.sourceMimeType,
        sourceSizeBytes: BigInt(input.sourceSizeBytes),
        sourceWidth: input.sourceWidth,
        sourceHeight: input.sourceHeight,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    });
  }

  /** 查询当前用户自己的单个任务；跨用户任务不会返回。 */
  async findForUser(userId: number, jobId: string): Promise<ImageReverseJob | null> {
    return this.prisma.imageReverseJob.findFirst({ where: { id: jobId, userId } });
  }

  /** 列出当前用户近期历史；列表默认不读取大体积结果 JSON。 */
  async listForUser(userId: number, take: number, includeResult = false): Promise<ImageReverseJob[]> {
    return this.prisma.imageReverseJob.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(includeResult ? {} : { select: imageReverseJobListSelect }),
    }) as Promise<ImageReverseJob[]>;
  }

  /** 统计当前用户未完成任务，防止刷新或多设备绕过并发限制。 */
  async countActiveForUser(userId: number): Promise<number> {
    return this.prisma.imageReverseJob.count({ where: { userId, status: { in: ['queued', 'running'] } } });
  }

  /** 查询服务重启时遗留的未完成任务；源图和选项已持久化，可重新排队。 */
  async listInterruptedJobs(take: number): Promise<ImageReverseJob[]> {
    return this.prisma.imageReverseJob.findMany({
      where: { status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  /** 重启恢复前把任务重新标记为排队。 */
  async markQueued(jobId: string, progressText: string): Promise<void> {
    await this.prisma.imageReverseJob.updateMany({
      where: { id: jobId, status: { in: ['queued', 'running'] } },
      data: { status: 'queued', progressText, startedAt: null, finishedAt: null },
    });
  }

  /** 标记任务进入模型识图阶段；终态不会被覆盖。 */
  async markRunning(jobId: string, startedAt: Date): Promise<void> {
    await this.prisma.imageReverseJob.updateMany({
      where: { id: jobId, status: { notIn: TERMINAL_STATUSES } },
      data: { status: 'running', progressText: '模型正在读取并分析图片', startedAt },
    });
  }

  /** 标记任务成功并保存完整结构化结果和列表摘要。 */
  async markSucceeded(jobId: string, result: ImageReverseResultView, finishedAt: Date): Promise<void> {
    await this.prisma.imageReverseJob.updateMany({
      where: { id: jobId, status: { notIn: TERMINAL_STATUSES } },
      data: {
        status: 'succeeded',
        progressText: '图片反推完成',
        resultSummary: buildResultSummary(result),
        analysisSummaryJson: toJsonValue(buildAnalysisSummary(result)),
        resultJson: toJsonValue(result),
        error: null,
        finishedAt,
      },
    });
  }

  /** 标记任务失败并保存用户可见原因。 */
  async markFailed(jobId: string, message: string, finishedAt: Date): Promise<void> {
    await this.prisma.imageReverseJob.updateMany({
      where: { id: jobId, status: { notIn: TERMINAL_STATUSES } },
      data: { status: 'failed', progressText: '图片反推失败', error: message, finishedAt },
    });
  }

  /** 将数据库记录转换为共享任务视图。 */
  toView(row: ImageReverseJob, includeResult = true): ImageReverseJobView {
    return {
      id: row.id,
      status: normalizeStatus(row.status),
      progress: computeProgress(row, Date.now()),
      progressText: row.progressText,
      mode: normalizeMode(row.mode),
      model: row.model,
      options: normalizeOptions(row.optionsJson, normalizeMode(row.mode)),
      sourceFileName: row.sourceFileName,
      sourceMimeType: row.sourceMimeType,
      sourceSizeBytes: Number(row.sourceSizeBytes),
      sourceWidth: row.sourceWidth,
      sourceHeight: row.sourceHeight,
      sourceUrl: `/api/tools/image-reverse/jobs/${encodeURIComponent(row.id)}/source`,
      previewUrl: `/api/tools/image-reverse/jobs/${encodeURIComponent(row.id)}/source?preview=1`,
      resultSummary: row.resultSummary ?? undefined,
      analysisSummary: normalizeAnalysisSummary(row.analysisSummaryJson),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      startedAt: row.startedAt?.toISOString(),
      finishedAt: row.finishedAt?.toISOString(),
      result: includeResult ? normalizeResult(row.resultJson) : undefined,
      error: row.error ?? undefined,
    };
  }
}

const imageReverseJobListSelect = {
  id: true,
  userId: true,
  status: true,
  progressText: true,
  mode: true,
  model: true,
  optionsJson: true,
  sourceFileName: true,
  sourceStoredName: true,
  previewStoredName: true,
  sourceMimeType: true,
  sourceSizeBytes: true,
  sourceWidth: true,
  sourceHeight: true,
  resultSummary: true,
  analysisSummaryJson: true,
  error: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.ImageReverseJobSelect;

function toJsonValue(value: ImageReverseExtractOptions | ImageReverseResultView | ImageReverseJobAnalysisSummaryView): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** 从数据库读取轻量分析摘要；旧任务缺少该列内容时保持为空。 */
function normalizeAnalysisSummary(value: Prisma.JsonValue | null): ImageReverseJobAnalysisSummaryView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.pipeline !== 'vision-only' && record.pipeline !== 'hybrid') return undefined;
  return value as unknown as ImageReverseJobAnalysisSummaryView;
}

function normalizeResult(value: Prisma.JsonValue | null): ImageReverseResultView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const mode = String((value as Record<string, unknown>).mode ?? '');
  if (!isMode(mode)) return undefined;
  const result = value as unknown as ImageReverseResultView;
  return result.mode === 'description' ? normalizeStoredDescriptionPrompts(result) : result;
}

/**
 * 读取历史描述任务时重新生成角色保留提示词。
 * 只改 API 返回视图，不改数据库原始识图事实，确保旧记录也不会把原角色特征拼入提示词栏。
 */
function normalizeStoredDescriptionPrompts(result: Extract<ImageReverseResultView, { mode: 'description' }>): Extract<ImageReverseResultView, { mode: 'description' }> {
  if (result.focus && result.focus !== 'all') return result;
  const localized = { ...result.localized };
  for (const [language, value] of Object.entries(localized)) {
    if (!value?.character || !Array.isArray(value.details)) continue;
    localized[language as ImageReverseLanguage] = {
      ...value,
      ...buildImageReverseReferencePrompt(value, language as ImageReverseLanguage, 20_000),
    };
  }
  return {
    ...result,
    ...buildImageReverseReferencePrompt(result, result.options.language.primaryLanguage, 20_000),
    localized,
  };
}

function normalizeOptions(value: Prisma.JsonValue, fallbackMode: ImageReverseMode): ImageReverseExtractOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallbackOptions(fallbackMode);
  const record = value as Record<string, unknown>;
  return { ...fallbackOptions(fallbackMode), ...record, mode: isMode(record.mode) ? record.mode : fallbackMode } as ImageReverseExtractOptions;
}

function fallbackOptions(mode: ImageReverseMode): ImageReverseExtractOptions {
  return {
    mode,
    language: { resultLanguageMode: 'bilingual', primaryLanguage: 'zh', secondaryLanguage: 'en', promptLanguage: 'bilingual' },
    detailLevel: 'forensic',
    sections: [],
    focus: 'all',
    includeEvidence: true,
    analysisMode: 'vision-only',
  };
}

function normalizeStatus(value: string): ImageReverseJobStatus {
  return value === 'queued' || value === 'running' || value === 'succeeded' ? value : 'failed';
}

function normalizeMode(value: string): ImageReverseMode {
  return isMode(value) ? value : 'description';
}

function isMode(value: unknown): value is ImageReverseMode {
  return value === 'description' || value === 'prompt' || value === 'character' || value === 'tags' || value === 'edit';
}

function computeProgress(job: ImageReverseJob, now: number): number {
  const status = normalizeStatus(job.status);
  if (TERMINAL_STATUSES.includes(status)) return 100;
  if (status === 'queued') return Math.min(18, 5 + Math.floor((now - job.createdAt.getTime()) / 5000));
  return Math.min(94, 22 + Math.floor((now - (job.startedAt?.getTime() ?? now)) / 3000));
}

function buildResultSummary(result: ImageReverseResultView): string {
  let summary = '';
  if (result.mode === 'description') summary = result.localized.zh?.overview || result.localized.en?.overview || result.overview;
  else if (result.mode === 'prompt') summary = result.localized.zh?.positivePrompt || result.localized.en?.positivePrompt || result.positivePrompt;
  else if (result.mode === 'character') summary = result.localized.zh?.summary || result.localized.en?.summary || result.summary;
  else if (result.mode === 'tags') summary = result.tagPrompt.positivePrompt;
  else summary = result.localized.zh?.sourceSummary || result.localized.en?.sourceSummary || result.sourceSummary;
  return String(summary || '已完成图片反推').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

/** 从完整持久化结果生成历史列表专用摘要，避免列表读取和传输大型 resultJson。 */
function buildAnalysisSummary(result: ImageReverseResultView): ImageReverseJobAnalysisSummaryView {
  const analysis = result.analysis;
  const evidenceCount = analysis?.sourceSummary?.reduce((total, item) => total + item.count, 0) ?? analysis?.evidence.length ?? 0;
  return {
    pipeline: analysis?.pipeline ?? 'vision-only',
    structuredOutputMode: analysis?.structuredOutputMode ?? 'prompt-json',
    providers: analysis?.providers.map((provider) => ({ provider: provider.provider, label: provider.label, status: provider.status })) ?? [],
    evidenceCount,
    warningCount: analysis?.warnings.length ?? 0,
    conflictCount: analysis?.conflicts?.length ?? 0,
    animaPromptAvailable: result.mode === 'tags' && Boolean(result.tagPrompt.animaPrompt?.trim()),
  };
}
