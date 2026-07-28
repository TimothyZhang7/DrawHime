/**
 * 本文件实现公开图库浏览、搜索、排序和图片详情业务用例。
 *
 * 约束：
 * - 公开图库只展示 isPrivate=false 且 status=success 的图片或视频
 * - 排序：latest（游标分页）、popular（分页）、random（随机）、hot（热度分）
 * - 搜索：支持用户名、QQ 号、任务 ID、提示词、来源、模式、模型、站点等聚合搜索
 * - 浏览计数 IP 去重，点赞 1200ms 冷却
 * - 符合 specs/README.md GAL-001 到 GAL-008
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  GalleryImageAssetView,
  GalleryImageDetailView,
  GalleryItemView,
  GalleryLocalModelView,
  GalleryListRequest,
  GalleryListResponse,
  GalleryTagView,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { buildAvatarUrl } from '../users/user-avatar-service.js';
import { buildGalleryWhereSql } from './gallery-search.js';

/** 默认分页大小。 */
const DEFAULT_PAGE_SIZE = 20;
/** 最大分页大小。 */
const MAX_PAGE_SIZE = 50;

/** 图库排序方式。 */
type GallerySort = 'latest' | 'popular' | 'random' | 'hot';

/** 图库查询参数。 */
type GalleryQuery = GalleryListRequest & {
  sort?: GallerySort;
  mode?: string;
  source?: string;
  search?: string;
  tag?: string;
  cursor?: string;
};

/** 图片点赞状态响应。 */
type ImageLikeResponse = { liked: boolean; likeCount: number };

/** 图片浏览记录响应；recorded 表示本次 IP 是否首次计入。 */
type ImageViewResponse = { recorded: boolean; viewCount: number };

/** 任务图片配置；真实文件名只信任 Worker 写入的 system_configs.task_image_*。 */
type TaskImageConfig = {
  mediaType?: 'image' | 'video';
  imageFilename?: string;
  thumbnailFilename?: string;
  videoFilename?: string;
  duration?: number;
  resolution?: '480p' | '720p' | '1080p';
  aspectRatio?: string;
  size?: string;
  quality?: string;
  /** 旧配置字段；当前本地链路不读取远端状态，只兼容历史 JSON。 */
  archiveStatus?: string;
};

/** 图库任务行；只包含公开图库需要的字段，避免服务层读取余额、邮箱等私有信息。 */
type GalleryTaskRecord = Prisma.GenerationTaskGetPayload<{
  select: {
    id: true;
    batchId: true;
    batchIndex: true;
    batchTotal: true;
    prompt: true;
    mode: true;
    source: true;
    isPrivate: true;
    createdAt: true;
    userId: true;
    qqNumber: true;
  };
}>;

/** 图库作者资料；只包含公开展示所需字段，不包含邮箱、余额或权限信息。 */
type GalleryAuthorProfile = {
  userId: number;
  username: string;
  avatarUrl: string | null;
  qqAvatarUrl: string | null;
};

/**
 * 图库服务，负责公开图库和图片详情的查询。
 * 所有查询走索引，列表必须分页或游标。
 */
export class GalleryService {
  private readonly prisma: PrismaClient = getPrismaClient();
  private promptFulltextReady: boolean | undefined;

  /** 浏览公开图库。 */
  async browse(query: GalleryQuery, currentUserId?: number): Promise<GalleryListResponse> {
    const take = Math.min(query.pageSize || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const page = query.page ?? 1;
    const whereSql = buildGalleryWhereSql(query, await this.isPromptFulltextReady());

    switch (query.sort) {
      case 'random':
        return this.browseRandom(whereSql, take, currentUserId);
      case 'hot':
        return this.browseHot(whereSql, page, take, currentUserId);
      case 'popular':
        return this.browsePopular(whereSql, page, take, currentUserId);
      default:
        return this.browseLatest(whereSql, page, take, currentUserId);
    }
  }

  /** 为缓存后的公开图库列表补齐当前用户点赞态；基础列表缓存不绑定用户，提升图库缓存命中率。 */
  async applyCurrentUserLikes(response: GalleryListResponse, currentUserId?: number): Promise<GalleryListResponse> {
    if (!currentUserId || response.items.length === 0) return response;
    // 互动表仍以单张最终图任务 ID 为键；批次卡片需要补齐其代表图和预览图的点赞状态。
    const taskIds = [...new Set(response.items.flatMap((item) => item.images.length > 0 ? item.images.map((image) => image.id) : [item.taskId]))];
    const liked = await this.prisma.imageLike.findMany({
      where: { imageId: { in: taskIds }, userId: currentUserId },
      select: { imageId: true },
    });
    const likedSet = new Set(liked.map((item) => item.imageId));
    return {
      ...response,
      items: response.items.map((item) => ({
        ...item,
        liked: likedSet.has(item.taskId),
        images: item.images.map((image) => ({ ...image, liked: likedSet.has(image.id) })),
      })),
    };
  }

  /** 最新排序：分页。 */
  private async browseLatest(
    whereSql: Prisma.Sql,
    page: number,
    take: number,
    currentUserId?: number,
  ): Promise<GalleryListResponse> {
    const { items, total } = await this.findImageBackedGalleryPage(whereSql, page, take);
    return {
      items: await this.enrichGalleryImages(items, currentUserId),
      total, page, pageSize: take,
      hasMore: (Math.max(1, page) - 1) * take + items.length < total,
    };
  }

  /** 热门排序：按浏览量降序分页。 */
  private async browsePopular(
    whereSql: Prisma.Sql,
    page: number,
    take: number,
    currentUserId?: number,
  ): Promise<GalleryListResponse> {
    // 当前数据模型中没有 view_count 在 generation_tasks 上，按创建时间降序作为热门近似。
    const { items, total } = await this.findImageBackedGalleryPage(whereSql, page, take);

    return {
      items: await this.enrichGalleryImages(items, currentUserId),
      total,
      page,
      pageSize: take,
      hasMore: (Math.max(1, page) - 1) * take + items.length < total,
    };
  }

  /** 热度分排序：按 hotScore 降序（当前用创建时间降序近似）。 */
  private async browseHot(
    whereSql: Prisma.Sql,
    page: number,
    take: number,
    currentUserId?: number,
  ): Promise<GalleryListResponse> {
    // 热度分计算在 image_generations 落地后接入，当前用创建时间降序
    return this.browsePopular(whereSql, page, take, currentUserId);
  }

  /** 随机排序：从符合条件集合中随机抽取。 */
  private async browseRandom(
    whereSql: Prisma.Sql,
    take: number,
    currentUserId?: number,
  ): Promise<GalleryListResponse> {
    const total = await this.countImageBackedGallery(whereSql);
    if (total === 0) return { items: [], total: 0, page: 1, pageSize: take, hasMore: false };

    // 用随机偏移量近似随机抽取
    const maxSkip = Math.max(0, total - take);
    const randomSkip = Math.floor(Math.random() * (maxSkip + 1));
    const items = await this.findImageBackedGalleryItems(whereSql, take, randomSkip);

    return {
      items: await this.enrichGalleryImages(items, currentUserId),
      total,
      page: 1,
      pageSize: take,
      hasMore: randomSkip + take < total,
    };
  }

  /** 图片详情。 */
  async getImageDetail(filename: string, currentUserId?: number): Promise<GalleryImageDetailView> {
    // 详情页允许传任务 ID、批次 ID 或生成图文件名；批次入口必须保留选中图语义。
    const resolved = await this.resolveGalleryIdentifier(filename);
    if (!resolved) {
      throw new GalleryError('not_found', '图片不存在');
    }

    const task = await this.prisma.generationTask.findFirst({
      where: {
        status: 'success',
        id: resolved.taskId,
      },
      select: {
        ...gallerySelect,
        sourceImageUrls: true,
        isPrivate: true,
        error: true,
        finishedAt: true,
        startedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!task) {
      throw new GalleryError('not_found', '图片不存在');
    }

    // 私密图片仅所有者可见；公开批次详情也只返回当前访问者有权看的最终图。
    if (task.isPrivate && task.userId !== currentUserId) {
      throw new GalleryError('forbidden', '该图片为私密图片');
    }

    const batchId = resolved.kind === 'batch' ? resolved.batchId : task.batchId;
    const isBatchDetail = Boolean(batchId && (task.batchTotal ?? 1) > 1);
    const detailRowsPromise = isBatchDetail
      ? this.findVisibleBatchTasks(batchId!, currentUserId)
      : Promise.resolve([task]);
    const siblingRowsPromise = isBatchDetail
      ? Promise.resolve([])
      : this.findSiblingTasks(task);

    const sourceUrls = Array.isArray(task.sourceImageUrls)
      ? task.sourceImageUrls.filter((item): item is string => typeof item === 'string')
      : [];

    // 以主任务 sourceImageUrls 作为权威顺序；本地参考图配置只用于补充站内文件，不能截断参考图列表。
    const sourceRefThumbnails = buildReferenceDetailUrls(sourceUrls, task.id);
    const refConfigPromise = this.prisma.systemConfig.findUnique({
        where: { key: `task_ref_images_${task.id}` },
        select: { value: true },
      }).catch(() => null);

    // 从子任务提取详细信息
    const upstreamPromise = this.prisma.generationSubTask.findFirst({
      where: { taskId: task.id, kind: 'upstream_attempt', status: 'success' },
      orderBy: { sequence: 'desc' },
      select: { siteName: true, model: true, latencyMs: true },
    });
    const genTimeMs = task.startedAt && task.finishedAt
      ? task.finishedAt.getTime() - task.startedAt.getTime()
      : null;

    const metaPromise = this.prisma.systemConfig
      .findUnique({ where: { key: `task_image_${task.id}` }, select: { value: true } })
      .catch(() => null);
    const generationParamsPromise = this.prisma.systemConfig
      .findUnique({ where: { key: `task_generation_params_${task.id}` }, select: { value: true } })
      .catch(() => null);

    // 详情页热路径中互不依赖的查询并行执行，减少进入子页面时的接口等待时间。
    const [detailRows, siblingRows, refConfig, upstreamSubtask, metaRow, generationParamsRow] = await Promise.all([
      detailRowsPromise,
      siblingRowsPromise,
      refConfigPromise,
      upstreamPromise,
      metaPromise,
      generationParamsPromise,
    ]);
    if (detailRows.length === 0) throw new GalleryError('not_found', '图片不存在');
    const detailImages = await this.enrichGalleryImages(detailRows, currentUserId, { promptMaxLength: null });
    const siblings = await this.enrichGalleryImages(siblingRows, currentUserId);
    const images = detailImages[0];
    if (!images) throw new GalleryError('not_found', '图片不存在');
    const detailAssets = detailImages.flatMap((item) => item.images);
    const selectedImageId = detailAssets.some((item) => item.id === task.id) ? task.id : images.taskId;
    const selectedAsset = detailAssets.find((item) => item.id === selectedImageId) ?? images.images[0];

    if (refConfig?.value) {
      const filenames = readReferenceArchiveFilenames(refConfig.value);
      const known = new Set(sourceRefThumbnails.map((url) => extractMediaFilenameFromUrl(url)).filter(Boolean));
      for (const filename of filenames) {
        if (known.has(filename)) continue;
        // 本地参考图配置可能包含早期任务从 data/外链转存出的文件；作为补充追加，但不覆盖主任务顺序。
        sourceRefThumbnails.push(buildVersionedReferenceImageUrl(filename, task.id));
        known.add(filename);
      }
    }

    // 读取图片元数据（size/quality 由 worker 上报），损坏配置不能阻塞详情页。
    let imgMeta: { size?: string; quality?: string } | null = null;
    try {
      if (metaRow?.value) imgMeta = JSON.parse(metaRow.value);
    } catch { /* ignore */ }
    const negativePrompt = readTaskNegativePrompt(generationParamsRow?.value);

    return {
      ...images,
      // 详情接口必须返回数据库完整提示词；列表 enrich 为节省卡片空间会截断到 200 字。
      prompt: task.prompt,
      negativePrompt,
      id: isBatchDetail && batchId ? batchId : images.id,
      galleryKind: isBatchDetail ? 'batch' : 'image',
      batchId: isBatchDetail ? batchId : images.batchId,
      itemCount: detailAssets.length,
      taskId: selectedImageId,
      imageUrl: selectedAsset?.imageUrl ?? images.imageUrl,
      thumbnailUrl: selectedAsset?.thumbnailUrl ?? images.thumbnailUrl,
      mediaType: selectedAsset?.mediaType ?? images.mediaType,
      videoUrl: selectedAsset?.videoUrl ?? images.videoUrl,
      duration: selectedAsset?.duration ?? images.duration,
      resolution: selectedAsset?.resolution ?? images.resolution,
      aspectRatio: selectedAsset?.aspectRatio ?? images.aspectRatio,
      likeCount: selectedAsset?.likeCount ?? images.likeCount,
      viewCount: selectedAsset?.viewCount ?? images.viewCount,
      liked: selectedAsset?.liked ?? images.liked,
      images: detailAssets,
      selectedImageId,
      size: selectedAsset?.size ?? imgMeta?.size ?? null,
      quality: selectedAsset?.quality ?? imgMeta?.quality ?? null,
      siteName: upstreamSubtask?.siteName ?? null,
      model: selectedAsset?.model ?? upstreamSubtask?.model ?? null,
      latencyMs: selectedAsset?.latencyMs ?? upstreamSubtask?.latencyMs ?? genTimeMs ?? null,
      // 详情页优先展示站内本地参考图；QQ 临时外链会被过滤，避免网页继续加载已过期地址。
      sourceImageUrls:
        sourceRefThumbnails.length > 0
          ? sourceRefThumbnails
          : sourceUrls.filter((url) => !isTemporaryQqImageUrl(url)),
      sourceImageThumbnails: sourceRefThumbnails.length > 0 ? sourceRefThumbnails : undefined,
      isPrivate: task.isPrivate,
      canManage: Boolean(currentUserId && task.userId === currentUserId),
      siblings,
    };
  }

  /** 将详情页传入的任务 ID、原图文件名或缩略图文件名解析为任务 ID。 */
  async resolveTaskIdFromIdentifier(identifier: string): Promise<string | null> {
    const resolved = await this.resolveGalleryIdentifier(identifier);
    return resolved?.taskId ?? null;
  }

  /** 校验图库作品和 LoRA 快照，返回独立平台封面读取目标。 */
  async resolveLocalModelLoraCover(identifier: string, loraVersionId: string, currentUserId?: number): Promise<{ externalTaskId: string; isPrivate: boolean }> {
    const target = await this.resolveLocalModelLoras(identifier, currentUserId);
    if (!target.localModel.loras.some((lora) => lora.loraVersionId === loraVersionId)) throw new GalleryError('not_found', 'LoRA 封面不存在');
    return { externalTaskId: target.externalTaskId, isPrivate: target.isPrivate };
  }

  /** 校验图库可见性并返回任务固化 LoRA 集合，供封面和实时元数据代理共用。 */
  async resolveLocalModelLoras(identifier: string, currentUserId?: number): Promise<{ externalTaskId: string; isPrivate: boolean; localModel: GalleryLocalModelView }> {
    const resolved = await this.resolveGalleryIdentifier(identifier);
    if (!resolved || resolved.kind !== 'task') throw new GalleryError('not_found', '作品不存在');
    const [task, publication] = await Promise.all([
      this.prisma.generationTask.findUnique({
        where: { id: resolved.taskId },
        select: { id: true, status: true, isPrivate: true, userId: true },
      }),
      this.prisma.localPlatformGalleryPublication.findFirst({
        where: { mainTaskId: resolved.taskId, status: 'published' },
        select: { externalTaskId: true, modelDisplayName: true, parameters: true },
      }),
    ]);
    if (!task || task.status !== 'success' || !publication) throw new GalleryError('not_found', '作品不存在');
    if (task.isPrivate && task.userId !== currentUserId) throw new GalleryError('forbidden', '该图片为私密图片');
    const localModel = buildLocalModelGalleryView(task.id, publication.modelDisplayName, publication.parameters);
    return { externalTaskId: publication.externalTaskId, isPrivate: task.isPrivate, localModel };
  }

  /** 将详情页传入的任务 ID、批次 ID、原图文件名或缩略图文件名解析成图库实体。 */
  private async resolveGalleryIdentifier(identifier: string): Promise<{ kind: 'task'; taskId: string } | { kind: 'batch'; batchId: string; taskId: string } | null> {
    const normalized = normalizeImageIdentifier(identifier);
    if (!normalized) return null;

    // 任务 ID 先走主表精确查询；支持 Web、Bot、Bot 重试和历史 task_ 前缀。
    if (isKnownGenerationTaskId(normalized)) {
      const task = await this.prisma.generationTask.findUnique({
        where: { id: normalized },
        select: { id: true },
      });
      if (task) return { kind: 'task', taskId: task.id };
      const batchTask = await this.findFirstVisibleBatchTask(normalized);
      if (batchTask) return { kind: 'batch', batchId: normalized, taskId: batchTask.id };
    }

    // 生成图/缩略图文件名再通过 task_image_* 精确反查，避免把文件名当任务 ID 写入互动表。
    const taskId = await this.findTaskIdByImageFilename(normalized);
    return taskId ? { kind: 'task', taskId } : null;
  }

  /** 记录图片浏览（IP 去重）。 */
  async recordView(taskId: string, ipAddress: string): Promise<ImageViewResponse> {
    let recorded = false;
    try {
      await this.prisma.imageView.create({
        data: { imageId: taskId, ipAddress },
      });
      recorded = true;
    } catch {
      // 浏览量是弱一致互动数据；同 IP 唯一约束冲突或短暂写入失败都不能影响图片详情页访问。
    }
    const viewCount = await this.prisma.imageView.count({ where: { imageId: taskId } });
    return { recorded, viewCount };
  }

  /** 图片点赞/取消点赞。 */
  async toggleLike(taskId: string, userId: number): Promise<ImageLikeResponse> {
    const existing = await this.prisma.imageLike.findUnique({
      where: { imageId_userId: { imageId: taskId, userId } },
    });

    if (existing) {
      // 冷却检查：1200ms 内不允许重复切换
      const elapsed = Date.now() - existing.createdAt.getTime();
      if (elapsed < 1200) {
        throw new GalleryError('rate_limited', '操作过于频繁，请稍后再试');
      }
      await this.prisma.imageLike.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.imageLike.create({ data: { imageId: taskId, userId } });
    }

    const likeCount = await this.prisma.imageLike.count({ where: { imageId: taskId } });
    return { liked: !existing, likeCount };
  }

  /** 为图片列表附加点赞数和当前用户点赞状态。 */
  private async enrichGalleryImages(
    records: GalleryTaskRecord[],
    currentUserId?: number,
    options: { promptMaxLength?: number | null } = {},
  ): Promise<GalleryItemView[]> {
    if (records.length === 0) return [];

    const taskIds = records.map((r) => r.id);
    // 多图批次只以当前可见的第一张最终图作为标签来源，避免同批每张图都读取或展示各自标签。
    const tagOwnerByTaskId = await this.buildGalleryTagOwnerByTaskId(records);
    const tagOwnerIds = [...new Set([...tagOwnerByTaskId.values()])];

    const userIds = [...new Set(records.filter(r => r.userId).map(r => r.userId!))];
    const qqNumbers = [...new Set(records.map((r) => r.qqNumber?.toString()).filter((qq): qq is string => Boolean(qq)))];
    const qqBigInts = qqNumbers.map((qq) => BigInt(qq));

    // 批量查询所有详情所需附加信息；互不依赖时并行，降低图库子页面等待时间。
    const [
      likeCounts,
      viewCounts,
      likedRows,
      configs,
      attemptRows,
      tagRows,
      titleRows,
      users,
      qqBindings,
      localModelPublications,
    ] = await Promise.all([
      this.prisma.imageLike.groupBy({
        by: ['imageId'],
        where: { imageId: { in: taskIds } },
        _count: { imageId: true },
      }),
      this.prisma.imageView.groupBy({
        by: ['imageId'],
        where: { imageId: { in: taskIds } },
        _count: { imageId: true },
      }),
      currentUserId
        ? this.prisma.imageLike.findMany({
            where: { imageId: { in: taskIds }, userId: currentUserId },
            select: { imageId: true },
          })
        : Promise.resolve([]),
      this.prisma.systemConfig.findMany({
        where: { key: { in: taskIds.map(id => `task_image_${id}`) } },
        select: { key: true, value: true },
      }),
      this.prisma.generationSubTask.findMany({
        where: { taskId: { in: taskIds }, kind: 'upstream_attempt' },
        orderBy: [{ taskId: 'asc' }, { sequence: 'asc' }],
        select: { taskId: true, status: true, model: true, siteName: true, latencyMs: true },
      }),
      this.prisma.generationTaskTag.findMany({
        where: { taskId: { in: tagOwnerIds }, tag: { disabled: false } },
        orderBy: [{ taskId: 'asc' }, { weight: 'desc' }, { id: 'asc' }],
        select: {
          taskId: true,
          weight: true,
          tag: {
            select: {
              name: true,
              slug: true,
              category: true,
              colorBg: true,
              colorText: true,
              colorBorder: true,
            },
          },
        },
      }),
      this.prisma.systemConfig.findMany({
        where: { key: { in: tagOwnerIds.map(id => `task_gallery_title_${id}`) } },
        select: { key: true, value: true },
      }),
      userIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              username: true,
              avatarFilename: true,
              qqBinding: { select: { qqNumber: true, verified: true } },
            },
          })
        : Promise.resolve([]),
      qqBigInts.length > 0
        ? this.prisma.qqBinding.findMany({
            where: { qqNumber: { in: qqBigInts }, verified: true },
            select: {
              qqNumber: true,
              user: { select: { id: true, username: true, avatarFilename: true } },
            },
          })
        : Promise.resolve([]),
      // 发布镜像是本地模型作品的权威标识，同时保留任务创建时的模型和 LoRA 参数快照。
      this.prisma.localPlatformGalleryPublication.findMany({
        where: { mainTaskId: { in: taskIds }, status: 'published' },
        select: { mainTaskId: true, modelDisplayName: true, parameters: true },
      }),
    ]);

    const likeMap = new Map(likeCounts.map((c) => [c.imageId, c._count.imageId]));

    const viewMap = new Map(viewCounts.map((c) => [c.imageId, c._count.imageId]));

    // 当前用户点赞状态；匿名访问时保持空集合，不额外查询。
    const userLiked = new Set(likedRows.map((l) => l.imageId));

    // 从 system_configs 查找实际图片文件名
    const imageMap = new Map<string, TaskImageConfig>();
    for (const c of configs) {
      try {
        const v = JSON.parse(c.value) as TaskImageConfig;
        const taskId = c.key.replace('task_image_', '');
        imageMap.set(taskId, v);
      } catch { /* ignore malformed */ }
    }

    // 列表卡片展示最终成功模型；没有成功尝试时使用最后一次带模型的上游尝试兜底。
    const attemptMap = new Map<string, { model: string | null; siteName: string | null; latencyMs: number | null }>();
    for (const attempt of attemptRows) {
      if (!attempt.model && !attempt.siteName) continue;
      const current = attemptMap.get(attempt.taskId);
      // 成功尝试优先，后续失败尝试不能覆盖已经找到的成功模型。
      if (attempt.status === 'success' || !current) {
        attemptMap.set(attempt.taskId, { model: attempt.model ?? null, siteName: attempt.siteName ?? null, latencyMs: attempt.latencyMs ?? null });
      }
    }

    const tagsByTask = new Map<string, GalleryTagView[]>();
    for (const row of tagRows) {
      const tags = tagsByTask.get(row.taskId) ?? [];
      tags.push({
        name: row.tag.name,
        slug: row.tag.slug,
        category: normalizeGalleryTagCategory(row.tag.category),
        weight: row.weight,
        color: {
          bg: row.tag.colorBg,
          text: row.tag.colorText,
          border: row.tag.colorBorder,
        },
      });
      tagsByTask.set(row.taskId, tags);
    }
    const titleByTask = new Map<string, string>();
    for (const row of titleRows) {
      const taskId = row.key.replace('task_gallery_title_', '');
      const title = normalizeGalleryTitle(row.value);
      if (title) titleByTask.set(taskId, title);
    }
    const localModelByTask = new Map<string, GalleryLocalModelView>();
    for (const publication of localModelPublications) {
      if (!publication.mainTaskId) continue;
      localModelByTask.set(publication.mainTaskId, buildLocalModelGalleryView(publication.mainTaskId, publication.modelDisplayName, publication.parameters));
    }

    // 作者资料遵循 Web 头像 > QQ 头像 > 首字符；Bot QQ 已绑定 Web 用户时展示绑定用户名。
    const userMap = new Map<number, GalleryAuthorProfile>();
    for (const user of users) {
      userMap.set(user.id, {
        userId: user.id,
        username: user.username,
        avatarUrl: buildAvatarUrl(user.avatarFilename),
        qqAvatarUrl: user.qqBinding?.verified && user.qqBinding.qqNumber ? buildQqAvatarUrl(user.qqBinding.qqNumber.toString()) : null,
      });
    }
    const qqProfileMap = new Map<string, GalleryAuthorProfile>();
    for (const binding of qqBindings) {
      if (!binding.qqNumber) continue;
      const qq = binding.qqNumber.toString();
      qqProfileMap.set(qq, {
        userId: binding.user.id,
        username: binding.user.username,
        avatarUrl: buildAvatarUrl(binding.user.avatarFilename),
        qqAvatarUrl: buildQqAvatarUrl(qq),
      });
    }

    const rawItems = records.map((r): GalleryItemView | null => {
      const img = imageMap.get(r.id);
      const isVideo = img?.mediaType === 'video' && Boolean(img.videoFilename);
      if (!img?.imageFilename && !isVideo) return null;
      const qqNumber = r.qqNumber?.toString() ?? null;
      const authorProfile = (r.userId ? userMap.get(r.userId) : null) ?? (qqNumber ? qqProfileMap.get(qqNumber) : null) ?? null;
      const authorAvatar = resolveAuthorAvatar(authorProfile, qqNumber);
      const attempt = attemptMap.get(r.id);
      const authorSource = normalizeGallerySource(r.source);
      // 视频只向图库返回首帧封面图片；浏览器悬浮前不得把 MP4 当作封面资源加载。
      const imageUrl = img.imageFilename
        ? `/images/${img.imageFilename}`
        : isVideo && img.thumbnailFilename ? `/images/${img.thumbnailFilename}` : '';
      const thumbnailUrl = img.imageFilename
        ? img.thumbnailFilename ? `/images/${img.thumbnailFilename}` : `/images/${img.imageFilename}?thumb=1`
        : isVideo && img.thumbnailFilename ? `/images/${img.thumbnailFilename}` : '';
      const videoUrl = isVideo && img.videoFilename ? `/images/${img.videoFilename}` : undefined;
      const tagOwnerId = tagOwnerByTaskId.get(r.id) ?? r.id;
      const galleryTitle = titleByTask.get(tagOwnerId) ?? null;
      const asset: GalleryImageAssetView = {
        id: r.id,
        batchId: r.batchId ?? null,
        batchIndex: r.batchIndex ?? null,
        batchTotal: r.batchTotal ?? null,
        imageUrl,
        thumbnailUrl,
        mediaType: isVideo ? 'video' : 'image',
        videoUrl,
        duration: isVideo ? img.duration ?? null : null,
        resolution: isVideo ? img.resolution ?? null : null,
        aspectRatio: isVideo ? img.aspectRatio ?? null : null,
        likeCount: likeMap.get(r.id) ?? 0,
        viewCount: viewMap.get(r.id) ?? 0,
        liked: userLiked.has(r.id),
        size: img.size ?? null,
        quality: img.quality ?? null,
        siteName: attempt?.siteName ?? null,
        model: attempt?.model ?? null,
        latencyMs: attempt?.latencyMs ?? null,
        tags: tagsByTask.get(tagOwnerId) ?? [],
        title: galleryTitle,
      };
      const promptMaxLength = options.promptMaxLength === undefined ? 200 : options.promptMaxLength;
      return {
        id: r.batchId && (r.batchTotal ?? 1) > 1 ? r.batchId : r.id,
        galleryKind: r.batchId && (r.batchTotal ?? 1) > 1 ? 'batch' : 'image',
        taskId: r.id,
        batchId: r.batchId ?? null,
        itemCount: r.batchId && (r.batchTotal ?? 1) > 1 ? Math.max(1, r.batchTotal ?? 1) : 1,
        userId: authorProfile?.userId ?? r.userId ?? null,
        prompt: promptMaxLength == null ? r.prompt : r.prompt.slice(0, promptMaxLength),
        title: galleryTitle,
        mode: r.mode,
        source: r.source,
        model: attempt?.model ?? null,
        imageUrl,
        thumbnailUrl,
        mediaType: isVideo ? 'video' : 'image',
        videoUrl,
        duration: isVideo ? img.duration ?? null : null,
        resolution: isVideo ? img.resolution ?? null : null,
        aspectRatio: isVideo ? img.aspectRatio ?? null : null,
        likeCount: asset.likeCount,
        viewCount: asset.viewCount,
        username: authorProfile?.username ?? null,
        qqNumber,
        authorName: authorProfile?.username ?? (qqNumber ? `QQ ${qqNumber}` : null),
        authorAvatarUrl: authorAvatar.url,
        authorAvatarSource: authorAvatar.source,
        authorSource,
        authorSourceLabel: gallerySourceLabel(authorSource),
        createdAt: formatChinaDateTime(r.createdAt),
        liked: asset.liked,
        images: [asset],
        tags: asset.tags ?? [],
        localModel: localModelByTask.get(r.id),
      };
    }).filter((item): item is GalleryItemView => Boolean(item));
    return aggregateGalleryItems(rawItems);
  }

  /** 为图库资产计算标签所属任务；同一多图批次固定读取批次图一标签，单图仍读取自身标签。 */
  private async buildGalleryTagOwnerByTaskId(records: GalleryTaskRecord[]): Promise<Map<string, string>> {
    const batchIds = [...new Set(records.filter((record) => record.batchId && (record.batchTotal ?? 1) > 1).map((record) => record.batchId!))];
    const ownerByBatch = new Map<string, string>();
    if (batchIds.length > 0) {
      const batchRows = await this.prisma.generationTask.findMany({
        where: { batchId: { in: batchIds } },
        select: { id: true, batchId: true },
        orderBy: [{ batchId: 'asc' }, { batchIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const row of batchRows) {
        if (!row.batchId || ownerByBatch.has(row.batchId)) continue;
        ownerByBatch.set(row.batchId, row.id);
      }
    }
    const result = new Map<string, string>();
    for (const record of records) {
      if (record.batchId && (record.batchTotal ?? 1) > 1) {
        result.set(record.id, ownerByBatch.get(record.batchId) ?? record.id);
      } else {
        result.set(record.id, record.id);
      }
    }
    return result;
  }

  /** 通过生成图或缩略图短文件名反查任务 ID。 */
  private async findTaskIdByImageFilename(filename: string): Promise<string | null> {
    if (!isSafeMediaFilename(filename)) return null;
    const rows = await this.prisma.systemConfig.findMany({
      where: {
        key: { startsWith: 'task_image_' },
        value: { contains: filename },
      },
      select: { key: true, value: true },
      take: 10,
    });

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as TaskImageConfig;
        if (parsed.imageFilename === filename || parsed.thumbnailFilename === filename || parsed.videoFilename === filename) {
          return row.key.replace('task_image_', '');
        }
      } catch {
        // 单条历史配置损坏时跳过，不能影响其他图片详情解析。
      }
    }
    return null;
  }

  /** 查询有真实图片配置的公开图库分页，当前图片读取走 media-service 本地目录。 */
  private async findImageBackedGalleryPage(whereSql: Prisma.Sql, page: number, take: number) {
    const safePage = Math.max(1, page);
    const [items, total] = await Promise.all([
      this.findImageBackedGalleryItems(whereSql, take, (safePage - 1) * take),
      this.countImageBackedGallery(whereSql),
    ]);
    return { items, total };
  }

  /** 按创建时间查询有图片配置的任务 ID，再回查 Prisma 视图字段保持返回结构一致。 */
  private async findImageBackedGalleryItems(whereSql: Prisma.Sql, take: number, skip: number) {
    const idRows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT picked.id
      FROM (
        SELECT
          COALESCE(t.batch_id, t.id) AS gallery_id,
          SUBSTRING_INDEX(
            GROUP_CONCAT(t.id ORDER BY COALESCE(t.batch_index, 1) ASC, t.created_at ASC SEPARATOR ','),
            ',',
            1
          ) AS id,
          MAX(t.created_at) AS sort_created_at
        FROM generation_tasks t
        LEFT JOIN users u ON u.id = t.user_id
        LEFT JOIN qq_bindings qb ON qb.user_id = t.user_id
        WHERE ${whereSql}
        GROUP BY COALESCE(t.batch_id, t.id)
      ) picked
      ORDER BY picked.sort_created_at DESC, picked.id DESC
      LIMIT ${take} OFFSET ${skip}
    `);
    const ids = idRows.map((row) => row.id);
    if (ids.length === 0) return [];
    const rows = await this.prisma.generationTask.findMany({
      where: { id: { in: ids } },
      select: gallerySelect,
    });
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    const representativeRows = ids.map((id) => rowMap.get(id)).filter((row): row is GalleryTaskRecord => Boolean(row));
    return this.attachBatchPreviewImages(representativeRows);
  }

  /** 多图批次在图库卡片中展示前几张最终图；单图保持一张，避免破坏旧字段。 */
  private async attachBatchPreviewImages(records: GalleryTaskRecord[]): Promise<GalleryTaskRecord[]> {
    const batchIds = [...new Set(records.filter((row) => row.batchId && (row.batchTotal ?? 1) > 1).map((row) => row.batchId!))];
    if (batchIds.length === 0) return records;
    const batchRows = await this.prisma.generationTask.findMany({
      where: {
        batchId: { in: batchIds },
        status: 'success',
        isPrivate: false,
      },
      select: gallerySelect,
      orderBy: [{ batchId: 'asc' }, { batchIndex: 'asc' }, { createdAt: 'asc' }],
    });
    const grouped = new Map<string, GalleryTaskRecord[]>();
    for (const row of batchRows) {
      if (!row.batchId) continue;
      const list = grouped.get(row.batchId) ?? [];
      if (list.length < 4) list.push(row);
      grouped.set(row.batchId, list);
    }
    return records.flatMap((row) => row.batchId && grouped.has(row.batchId) ? grouped.get(row.batchId)! : [row]);
  }

  /** 查找批次中第一张有图的成功任务；用于 /image/:batchId 入口定位默认图。 */
  private async findFirstVisibleBatchTask(batchId: string): Promise<{ id: string } | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT t.id
      FROM generation_tasks t
      WHERE t.batch_id = ${batchId}
        AND t.status = 'success'
        AND EXISTS (
          SELECT 1 FROM system_configs c
          WHERE c.\`key\` = CONCAT('task_image_', t.id)
            AND (
              COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.value, '$.imageFilename')), '') <> ''
              OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.value, '$.videoFilename')), '') <> ''
            )
        )
      ORDER BY COALESCE(t.batch_index, 1) ASC, t.created_at ASC
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** 读取当前访问者可见的同批次成功最终图；私密批次只允许所有者看到。 */
  private async findVisibleBatchTasks(batchId: string, currentUserId?: number): Promise<GalleryTaskRecord[]> {
    const rows = await this.prisma.generationTask.findMany({
      where: {
        batchId,
        status: 'success',
        OR: [
          { isPrivate: false },
          ...(currentUserId ? [{ userId: currentUserId }] : []),
        ],
      },
      select: gallerySelect,
      orderBy: [{ batchIndex: 'asc' }, { createdAt: 'asc' }],
    });
    return rows;
  }

  /** 单图详情仍保留旧的同期作品，但多图批次详情不再用提示词窗口冒充同批次。 */
  private async findSiblingTasks(task: GalleryTaskRecord): Promise<GalleryTaskRecord[]> {
    const siblingWindow = 2000;
    const taskCreatedAt = task.createdAt.getTime();
    return this.prisma.generationTask.findMany({
      where: {
        id: { not: task.id },
        prompt: task.prompt,
        status: 'success',
        isPrivate: false,
        createdAt: {
          gte: new Date(taskCreatedAt - siblingWindow),
          lte: new Date(taskCreatedAt + siblingWindow),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: gallerySelect,
    });
  }

  /** 统计有图片配置的公开图库任务，分页 total 与实际可展示图片保持一致。 */
  private async countImageBackedGallery(whereSql: Prisma.Sql): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ total: bigint | number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT COALESCE(t.batch_id, t.id)) AS total
      FROM generation_tasks t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN qq_bindings qb ON qb.user_id = t.user_id
      WHERE ${whereSql}
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /** 检查提示词全文索引是否已经存在；部署索引前自动回退 LIKE，避免 MATCH 报错。 */
  private async isPromptFulltextReady(): Promise<boolean> {
    if (this.promptFulltextReady !== undefined) return this.promptFulltextReady;
    try {
      const rows = await this.prisma.$queryRaw<{ found: number }[]>(Prisma.sql`
        SELECT 1 AS found
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'generation_tasks'
          AND index_name = 'generation_tasks_prompt_fulltext_idx'
        LIMIT 1
      `);
      this.promptFulltextReady = rows.length > 0;
    } catch {
      this.promptFulltextReady = false;
    }
    return this.promptFulltextReady;
  }
}

/** 从任务参数快照读取用户实际提交的负面提示词，空白或损坏快照均视为未使用。 */
function readTaskNegativePrompt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const negativePrompt = (parsed as Record<string, unknown>).negativePrompt;
    if (typeof negativePrompt !== 'string') return null;
    const normalized = negativePrompt.trim();
    return normalized && normalized.length <= 100000 ? normalized : null;
  } catch {
    return null;
  }
}

/** 构建 QQ 头像 URL；只用于公开头像展示，不参与绑定、钱包或扣费逻辑。 */
function buildQqAvatarUrl(qqNumber: string): string {
  return `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(qqNumber)}&spec=100`;
}

/** 解析公开作者头像来源；Web 本地头像优先，未设置时允许回退 QQ 头像。 */
function resolveAuthorAvatar(profile: GalleryAuthorProfile | null, qqNumber: string | null): { url: string | null; source: 'web' | 'qq' | 'initial' } {
  if (profile?.avatarUrl) return { url: profile.avatarUrl, source: 'web' };
  if (profile?.qqAvatarUrl) return { url: profile.qqAvatarUrl, source: 'qq' };
  if (qqNumber) return { url: buildQqAvatarUrl(qqNumber), source: 'qq' };
  return { url: null, source: 'initial' };
}

/** 归一化生成来源，避免历史异常值直接污染前端 className。 */
function normalizeGallerySource(source: string): 'web' | 'bot' | 'api' | 'other' {
  const normalized = source.trim().toLowerCase();
  if (normalized === 'web' || normalized === 'bot' || normalized === 'api') return normalized;
  return 'other';
}

/** 生成来源中文标签。 */
function gallerySourceLabel(source: 'web' | 'bot' | 'api' | 'other'): string {
  if (source === 'web') return '网页';
  if (source === 'bot') return 'QQ Bot';
  if (source === 'api') return 'API';
  return '其他';
}

/** 把同一批次的多张最终图合并为一个图库项目；点赞/浏览保留代表图口径，最终图列表用于子页面浏览。 */
function aggregateGalleryItems(items: GalleryItemView[]): GalleryItemView[] {
  const result: GalleryItemView[] = [];
  const seen = new Map<string, GalleryItemView>();
  for (const item of items) {
    const key = item.galleryKind === 'batch' && item.batchId ? item.batchId : item.taskId;
    const existing = seen.get(key);
    if (!existing) {
      const normalized = { ...item, images: [...item.images] };
      seen.set(key, normalized);
      result.push(normalized);
      continue;
    }
    existing.images.push(...item.images);
    existing.itemCount = existing.images.length;
  }
  for (const item of result) {
    item.images.sort((left, right) => (left.batchIndex ?? 1) - (right.batchIndex ?? 1));
    const first = item.images[0];
    if (!first) continue;
    item.taskId = first.id;
    item.imageUrl = first.imageUrl;
    item.thumbnailUrl = first.thumbnailUrl;
    item.mediaType = first.mediaType;
    item.videoUrl = first.videoUrl;
    item.duration = first.duration;
    item.resolution = first.resolution;
    item.aspectRatio = first.aspectRatio;
    item.likeCount = first.likeCount;
    item.viewCount = first.viewCount;
    item.liked = first.liked;
    item.model = first.model ?? item.model;
    item.tags = first.tags ?? [];
    item.title = first.title ?? item.title ?? null;
    item.itemCount = item.galleryKind === 'batch' ? item.images.length : 1;
  }
  return result;
}

/** 归一化图库标题配置，避免损坏配置或空白标题直接返回前端。 */
function normalizeGalleryTitle(value: string): string | null {
  const title = value.replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title : null;
}

/** 归一化标签分类，防止历史脏值进入前端类型分支。 */
function normalizeGalleryTagCategory(value: string): GalleryTagView['category'] {
  if (value === 'subject' || value === 'feature' || value === 'scene' || value === 'style'
    || value === 'composition' || value === 'mood' || value === 'safety' || value === 'other') {
    return value;
  }
  return 'other';
}

/** 从独立平台发布参数中读取任务创建时固化的模型与 LoRA 信息。 */
function buildLocalModelGalleryView(taskId: string, modelDisplayName: string, parameters: Prisma.JsonValue): GalleryLocalModelView {
  const record = isJsonRecord(parameters) ? parameters : {};
  const rawSelections = Array.isArray(record.loraSelections) ? record.loraSelections : [];
  const rawVersionIds = Array.isArray(record.loraVersionIds) ? record.loraVersionIds : [];
  const rawStrengths = record.loraStrengths;
  const selections = new Map<string, { title: string; type: GalleryLocalModelView['loras'][number]['type']; strength: number | null }>();
  const orderedIds: string[] = [];

  for (const rawSelection of rawSelections) {
    if (!isJsonRecord(rawSelection)) continue;
    const loraVersionId = readNonEmptyText(rawSelection.loraVersionId ?? rawSelection.versionId ?? rawSelection.id, 191);
    if (!loraVersionId) continue;
    const title = readNonEmptyText(rawSelection.title ?? rawSelection.name, 191) || `LoRA ${orderedIds.length + 1}`;
    selections.set(loraVersionId, {
      title,
      type: normalizeLocalModelLoraType(rawSelection.type ?? rawSelection.loraType),
      strength: readFiniteNumber(rawSelection.strength ?? rawSelection.weight),
    });
    orderedIds.push(loraVersionId);
  }
  for (const rawVersionId of rawVersionIds) {
    const loraVersionId = readNonEmptyText(rawVersionId, 191);
    if (loraVersionId && !orderedIds.includes(loraVersionId)) orderedIds.push(loraVersionId);
  }

  return {
    modelDisplayName: modelDisplayName.trim(),
    loras: orderedIds.map((loraVersionId, index) => {
      const selection = selections.get(loraVersionId);
      return {
        loraVersionId,
        title: selection?.title || `LoRA ${index + 1}`,
        type: selection?.type ?? 'other',
        strength: selection?.strength ?? readLocalModelLoraStrength(rawStrengths, loraVersionId, index),
        coverUrl: `/api/images/${encodeURIComponent(taskId)}/loras/${encodeURIComponent(loraVersionId)}/cover`,
        detailUrl: `/local-model/?tab=loras&lora=${encodeURIComponent(loraVersionId)}`,
      };
    }),
  };
}

/** 判断 Prisma JSON 值是否为普通对象。 */
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** 读取并限制发布快照中的短文本，避免异常历史参数扩大接口响应。 */
function readNonEmptyText(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maximumLength);
}

/** 读取有限数值；权重为零时仍需原样展示。 */
function readFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** 兼容数组和按版本 ID 索引的历史 LoRA 权重快照。 */
function readLocalModelLoraStrength(value: unknown, loraVersionId: string, index: number): number | null {
  if (Array.isArray(value)) return readFiniteNumber(value[index]);
  if (isJsonRecord(value)) return readFiniteNumber(value[loraVersionId]);
  return null;
}

/** 归一化 LoRA 类型，历史未知分类统一归入其他。 */
function normalizeLocalModelLoraType(value: unknown): GalleryLocalModelView['loras'][number]['type'] {
  if (value === 'style' || value === 'character' || value === 'concept' || value === 'clothing'
    || value === 'pose' || value === 'object' || value === 'slider' || value === 'other') return value;
  return 'other';
}

/** 图库查询字段，只返回公开可见信息。 */
const gallerySelect = {
  id: true,
  batchId: true,
  batchIndex: true,
  batchTotal: true,
  prompt: true,
  mode: true,
  source: true,
  isPrivate: true,
  createdAt: true,
  userId: true,
  qqNumber: true,
} as const;

/** 标准化图片详情标识，兼容 /images/name、/api/images/name 和纯短文件名。 */
function normalizeImageIdentifier(identifier: string): string {
  const raw = safeDecodeURIComponent(identifier).trim();
  const withoutQuery = raw.split('?')[0]?.trim() ?? '';
  const stripped = withoutQuery.startsWith('/api/images/')
    ? withoutQuery.slice('/api/images/'.length)
    : withoutQuery.startsWith('/images/')
    ? withoutQuery.slice('/images/'.length)
    : withoutQuery;
  return isSafeMediaFilename(stripped) ? stripped : '';
}

/** 判断是否为当前系统会生成的任务 ID；兼容主站前缀任务和独立本地模型平台 UUID。 */
function isKnownGenerationTaskId(identifier: string): boolean {
  return /^(?:(?:b_|br_|w_|web_|web_retry_|workbench_|task_)[a-zA-Z0-9_-]{1,80}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(identifier);
}

/** URL 解码失败时保留原值，避免异常标识打断图库接口。 */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 判断是否为 QQ 临时媒体外链；这类 URL 过期后网页无法长期加载，详情页只展示已转存的站内地址。 */
function isTemporaryQqImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'multimedia.nt.qq.com.cn' && parsed.pathname.startsWith('/download');
  } catch {
    return false;
  }
}

/** 构建详情页参考图 URL；站内文件按主任务顺序展示，临时 QQ 外链统一过滤。 */
function buildReferenceDetailUrls(sourceUrls: string[], taskId: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const url of sourceUrls) {
    const filename = extractMediaFilenameFromUrl(url);
    if (filename) {
      if (seen.has(filename)) continue;
      result.push(buildVersionedReferenceImageUrl(filename, taskId));
      seen.add(filename);
      continue;
    }
    if (!isTemporaryQqImageUrl(url)) {
      result.push(url);
    }
  }
  return result;
}

/** 从 /images/filename、纯短文件名或带查询参数的站内 URL 中提取安全媒体短文件名。 */
function extractMediaFilenameFromUrl(value: string): string {
  const withoutQuery = value.split('?')[0]?.trim() ?? '';
  const raw = withoutQuery.startsWith('/images/')
    ? withoutQuery.slice('/images/'.length)
    : withoutQuery.startsWith('/api/images/')
    ? withoutQuery.slice('/api/images/'.length)
    : (!withoutQuery.startsWith('http://') && !withoutQuery.startsWith('https://') && !withoutQuery.startsWith('data:') ? withoutQuery : '');
  const decoded = safeDecodeURIComponent(raw);
  return isSafeMediaFilename(decoded) ? decoded : '';
}

/** 读取参考图本地状态配置；兼容旧纯数组和历史状态对象。 */
function readReferenceArchiveFilenames(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  const rawFilenames = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { filenames?: unknown }).filenames)
    ? (parsed as { filenames: unknown[] }).filenames
    : [];
  return rawFilenames.filter((item): item is string => typeof item === 'string' && isSafeMediaFilename(item));
}

/** 参考图短文件名安全校验，避免损坏配置污染 /images URL。 */
function isSafeMediaFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}

/** 构建带稳定版本参数的参考图 URL，避免共享缓存中的旧 404 影响图库详情展示。 */
function buildVersionedReferenceImageUrl(filename: string, taskId: string): string {
  return `/images/${filename}?v=${encodeURIComponent(taskId)}`;
}

/** 游标编码：base64url 编码 createdAt + id。 */
function encodeCursor(createdAt: Date, id: string): string {
  const payload = JSON.stringify({ t: createdAt.toISOString(), id });
  return Buffer.from(payload).toString('base64url');
}

/** 游标解码：还原为 Prisma 的 cursor 条件。 */
function decodeCursor(cursor: string): Prisma.GenerationTaskWhereInput | undefined {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!payload.t || !payload.id) return undefined;
    return {
      createdAt: { lt: new Date(payload.t) },
    };
  } catch {
    return undefined;
  }
}

/** 格式化中国时区时间。 */
function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** 图库业务错误，路由层按 kind 映射为 HTTP 状态码。 */
export class GalleryError extends Error {
  constructor(
    public readonly kind: 'not_found' | 'forbidden' | 'rate_limited' | 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'GalleryError';
  }
}
