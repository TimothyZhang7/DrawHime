/**
 * 本文件实现独立本地模型产物发布到主站正式图库的幂等集成链路。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';
import { Prisma } from '@prisma/client';
import { ApiErrorCode, type LocalPlatformGalleryPublicationRequest, type LocalPlatformGalleryPublicationResponse, type LocalPlatformGalleryPublicationView, type LocalPlatformGalleryRemovalResponse, type LocalPlatformGalleryRemovalView } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { readJsonBody } from '../../shared/http/body.js';

const prisma = getPrismaClient();
const mediaServiceUrl = process.env.MEDIA_SERVICE_URL?.trim() || 'http://127.0.0.1:3013';
const maximumArtifactBytes = 100 * 1024 * 1024;

/** 注册独立平台正式图库发布路由。 */
export function createLocalPlatformGalleryRoutes(): Route[] {
  return [{
    method: 'POST',
    path: '/internal/integrations/local-model/generations/:externalTaskId/publish',
    handle: publishGeneration,
  }, {
    method: 'DELETE',
    path: '/internal/integrations/local-model/generations/:externalTaskId',
    handle: removePublishedGeneration,
  }];
}

/** 主站图库删除本地模型作品前通知独立平台隐藏同一任务，避免两端记录分离。 */
export async function synchronizeLocalPlatformTaskDeletion(mainTaskIds: string[]): Promise<void> {
  const uniqueTaskIds = [...new Set(mainTaskIds.filter(Boolean))];
  if (uniqueTaskIds.length === 0) return;
  const publications = await prisma.localPlatformGalleryPublication.findMany({
    where: { mainTaskId: { in: uniqueTaskIds } },
    select: { externalTaskId: true },
  });
  await Promise.all(publications.map((publication) => requestLocalTaskDeletion(publication.externalTaskId)));
}

/** 独立平台删除任务时调用此受保护接口，主站仅删除对应正式图库记录，不触碰计费审计。 */
async function removePublishedGeneration(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticatePlatform(req)) return sendRemovalFailure(res, 403, ApiErrorCode.Forbidden, '本地模型平台服务凭证不正确');
  try {
    const externalTaskId = normalizeExternalTaskId(params?.externalTaskId);
    const publication = await prisma.localPlatformGalleryPublication.findFirst({
      where: { externalTaskId },
      select: { id: true, mainTaskId: true },
    });
    if (!publication) return sendJson(res, 200, removalSuccess({ externalTaskId, deleted: false }));
    await prisma.$transaction(async (tx) => {
      if (publication.mainTaskId) {
        // 图库删除沿用主站既有语义：仅删除可见任务与快照，不删除钱包、计费分账或原始审计。
        await tx.generationTask.deleteMany({ where: { id: publication.mainTaskId } });
        await tx.systemConfig.deleteMany({ where: { key: { in: [`task_image_${publication.mainTaskId}`, `task_generation_params_${publication.mainTaskId}`] } } });
      }
      await tx.localPlatformGalleryPublication.delete({ where: { id: publication.id } });
    });
    return sendJson(res, 200, removalSuccess({ externalTaskId, deleted: true }));
  } catch (error) {
    return handleRemovalError(res, error);
  }
}

/** 校验计费终态、流式复制并校验产物，最后事务创建正式图库任务。 */
async function publishGeneration(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticatePlatform(req)) return sendFailure(res, 403, ApiErrorCode.Forbidden, '本地模型平台服务凭证不正确');
  let publicationId: string | undefined;
  try {
    const externalTaskId = normalizeExternalTaskId(params?.externalTaskId);
    const input = normalizePublicationRequest(await readJsonBody<LocalPlatformGalleryPublicationRequest>(req));
    const reservation = await prisma.localPlatformBillingReservation.findUnique({
      where: { externalTaskId },
      include: { allocations: true },
    });
    if (!reservation || reservation.status !== 'committed') {
      throw new PublicationError(409, ApiErrorCode.Conflict, '任务资金预留尚未提交，暂不发布图库');
    }
    const ownerMatches = input.walletOwnerType === 'qq'
      ? reservation.userId === null && String(reservation.qqNumber ?? '') === input.userSubject
      : reservation.qqNumber === null && String(reservation.userId ?? '') === input.userSubject;
    if (!ownerMatches) throw new PublicationError(409, ApiErrorCode.Conflict, '任务钱包主体与主站计费记录不一致');

    const owner = { userId: reservation.userId, qqNumber: reservation.qqNumber };
    const publication = await ensurePublicationMirror(externalTaskId, owner, input);
    publicationId = publication.id;
    if (publication.status === 'published') return sendJson(res, 200, success(toPublicationView(publication)));
    await claimPublication(publication.id);

    const copied = await downloadAndVerifyArtifact(input);
    try {
      const media = await saveMainMedia(copied.path, input.mimeType);
      const publishedAt = new Date();
      // QQ 绑定只决定网页可见关联，不改变本次计费和退款所使用的 QQ 钱包主体。
      const binding = reservation.qqNumber === null ? null : await prisma.qqBinding.findUnique({ where: { qqNumber: reservation.qqNumber }, select: { userId: true, verified: true } });
      const linkedUserId = reservation.qqNumber === null ? reservation.userId : binding?.verified ? binding.userId : null;
      await prisma.$transaction(async (tx) => {
        const existingTask = await tx.generationTask.findUnique({ where: { id: externalTaskId }, select: { id: true } });
        if (existingTask) throw new PublicationError(409, ApiErrorCode.Conflict, '主站已存在同 ID 的其他生成任务');
        const freeUsed = reservation.allocations.reduce((sum, item) => sum + item.freeAmount.toNumber(), 0);
        const paidUsed = reservation.allocations.reduce((sum, item) => sum + item.paidAmount.toNumber(), 0);
        await tx.generationTask.create({
          data: {
            id: externalTaskId,
            clientRequestId: `local:${externalTaskId}`,
            userId: linkedUserId,
            qqNumber: reservation.qqNumber,
            source: reservation.qqNumber === null ? 'web' : 'bot',
            mode: 'text-to-image',
            prompt: input.effectivePrompt,
            isPrivate: input.isPrivate,
            status: 'success',
            chargedSource: freeUsed > 0 && paidUsed > 0 ? 'mixed' : paidUsed > 0 ? 'paid' : 'free',
            chargedAmount: reservation.reservedAmount.toFixed(2),
            chargedFreeAmount: freeUsed.toFixed(2),
            chargedPaidAmount: paidUsed.toFixed(2),
            startedAt: reservation.createdAt,
            finishedAt: publishedAt,
            subTasks: {
              create: [{
                sequence: 1,
                kind: 'local_model_upstream',
                status: 'success',
                siteName: '本地模型独立平台',
                model: input.modelDisplayName.slice(0, 96),
                startedAt: reservation.createdAt,
                finishedAt: publishedAt,
              }],
            },
          },
        });
        const imageValue = JSON.stringify({
          imageFilename: media.imageFilename,
          thumbnailFilename: media.thumbnailFilename,
          size: `${input.width}x${input.height}`,
          quality: 'local',
          storage: 'local',
          storedAt: publishedAt.toISOString(),
        });
        const parameterValue = JSON.stringify({
          ...input.parameters,
          model: input.modelDisplayName,
          effectivePrompt: input.effectivePrompt,
          negativePrompt: input.negativePrompt,
          width: input.width,
          height: input.height,
          source: 'local-model-platform',
          artifactId: input.artifactId,
          artifactSha256: input.sha256,
        });
        await tx.systemConfig.upsert({
          where: { key: `task_image_${externalTaskId}` },
          update: { value: imageValue },
          create: { key: `task_image_${externalTaskId}`, value: imageValue },
        });
        await tx.systemConfig.upsert({
          where: { key: `task_generation_params_${externalTaskId}` },
          update: { value: parameterValue },
          create: { key: `task_generation_params_${externalTaskId}`, value: parameterValue },
        });
        await tx.localPlatformGalleryPublication.update({
          where: { id: publication.id },
          data: {
            mainTaskId: externalTaskId,
            mediaFilename: media.imageFilename,
            thumbnailFilename: media.thumbnailFilename || null,
            status: 'published',
            errorMessage: null,
            publishedAt,
          },
        });
      }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 });
    } finally {
      await rm(copied.path, { force: true });
    }
    const completed = await prisma.localPlatformGalleryPublication.findUniqueOrThrow({ where: { id: publication.id } });
    return sendJson(res, 201, success(toPublicationView(completed)));
  } catch (error) {
    if (publicationId) {
      await prisma.localPlatformGalleryPublication.updateMany({
        where: { id: publicationId, status: 'publishing' },
        data: { status: 'failed', errorMessage: errorMessage(error) },
      }).catch(() => undefined);
    }
    return handlePublicationError(res, error);
  }
}

/** 创建或读取发布镜像，并校验幂等键没有承载不同内容。 */
async function ensurePublicationMirror(externalTaskId: string, owner: { userId: number | null; qqNumber: bigint | null }, input: NormalizedPublicationRequest) {
  const existing = await prisma.localPlatformGalleryPublication.findFirst({
    where: { OR: [{ idempotencyKey: input.idempotencyKey }, { externalTaskId, artifactSha256: input.sha256 }, { artifactId: input.artifactId }] },
  });
  if (existing) {
    if (existing.externalTaskId !== externalTaskId || existing.artifactId !== input.artifactId || existing.artifactSha256 !== input.sha256 || existing.userId !== owner.userId || existing.qqNumber !== owner.qqNumber) {
      throw new PublicationError(409, ApiErrorCode.Conflict, '图库发布幂等键已经被其他产物使用');
    }
    return existing;
  }
  return prisma.localPlatformGalleryPublication.create({
    data: {
      externalTaskId,
      artifactId: input.artifactId,
      artifactSha256: input.sha256,
      idempotencyKey: input.idempotencyKey,
      userId: owner.userId,
      qqNumber: owner.qqNumber,
      mimeType: input.mimeType,
      byteSize: BigInt(input.byteSize),
      width: input.width,
      height: input.height,
      isPrivate: input.isPrivate,
      effectivePrompt: input.effectivePrompt,
      modelDisplayName: input.modelDisplayName,
      parameters: input.parameters as Prisma.InputJsonObject,
    },
  });
}

/** 原子领取发布工作；陈旧 publishing 状态允许在两分钟后由同一幂等请求补偿。 */
async function claimPublication(id: string): Promise<void> {
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000);
  const claimed = await prisma.localPlatformGalleryPublication.updateMany({
    where: { id, OR: [{ status: { in: ['pending', 'failed'] } }, { status: 'publishing', updatedAt: { lt: staleBefore } }] },
    data: { status: 'publishing', errorMessage: null },
  });
  if (claimed.count !== 1) throw new PublicationError(409, ApiErrorCode.Conflict, '相同产物正在发布，请稍后查询结果');
}

/** 从固定独立平台内部地址流式读取产物，同时校验字节数和 SHA-256。 */
async function downloadAndVerifyArtifact(input: NormalizedPublicationRequest): Promise<{ path: string }> {
  const baseUrl = process.env.LOCAL_PLATFORM_INTERNAL_URL?.trim() || 'http://127.0.0.1:7102';
  const token = process.env.LOCAL_PLATFORM_INTEGRATION_TOKEN?.trim();
  if (!token) throw new PublicationError(503, ApiErrorCode.ServiceUnavailable, '本地模型平台图库集成尚未配置');
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/internal/artifacts/${encodeURIComponent(input.artifactId)}/content`, {
    headers: { 'x-local-platform-token': token },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) throw new PublicationError(502, ApiErrorCode.ServiceUnavailable, `独立平台产物读取失败：HTTP ${response.status}`);
  const path = join(tmpdir(), `drawhime-local-${randomUUID()}`);
  const hash = createHash('sha256');
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > maximumArtifactBytes || byteSize > input.byteSize) return callback(new Error('产物字节数超过请求声明'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(path, { flags: 'wx' }));
    if (byteSize !== input.byteSize || hash.digest('hex') !== input.sha256) throw new Error('独立平台产物完整性校验失败');
    return { path };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

/** 把已校验原图写入主站 media-service，并尽力生成正式缩略图。 */
async function saveMainMedia(path: string, mimeType: string): Promise<{ imageFilename: string; thumbnailFilename: string }> {
  const buffer = await readFile(path);
  const upload = await fetch(`${mediaServiceUrl.replace(/\/$/, '')}/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': mimeType,
      'content-length': String(buffer.length),
      'x-service-token': process.env.WS_PROXY_TOKEN?.trim() || '',
      'x-aiimage-prefix': 'img_',
    },
    body: buffer,
    signal: AbortSignal.timeout(120000),
  });
  const payload = await upload.json().catch(() => null) as { ok?: boolean; data?: { filename?: string }; message?: string } | null;
  const imageFilename = payload?.data?.filename || '';
  if (!upload.ok || payload?.ok !== true || !imageFilename) throw new PublicationError(502, ApiErrorCode.ServiceUnavailable, payload?.message || '主站媒体原图保存失败');
  let thumbnailFilename = '';
  try {
    const thumbnail = await fetch(`${mediaServiceUrl.replace(/\/$/, '')}/media/generate-thumbnail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN?.trim() || '' },
      body: JSON.stringify({ sourceFilename: imageFilename }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await thumbnail.json().catch(() => null) as { ok?: boolean; data?: { filename?: string } } | null;
    if (thumbnail.ok && result?.ok === true) thumbnailFilename = result.data?.filename || '';
  } catch {
    // 缩略图失败不覆盖已经校验并保存的正式原图，图库会使用原图缩略参数兜底。
  }
  return { imageFilename, thumbnailFilename };
}

type NormalizedPublicationRequest = LocalPlatformGalleryPublicationRequest;

/** 校验发布元数据，禁止异常路径、哈希或大对象进入媒体链路。 */
function normalizePublicationRequest(input: LocalPlatformGalleryPublicationRequest): NormalizedPublicationRequest {
  const idempotencyKey = String(input?.idempotencyKey ?? '').trim();
  const artifactId = String(input?.artifactId ?? '').trim();
  const userSubject = String(input?.userSubject ?? '').trim();
  const walletOwnerType = input?.walletOwnerType;
  const sha256 = String(input?.sha256 ?? '').trim().toLowerCase();
  const mimeType = String(input?.mimeType ?? '').trim().toLowerCase() as LocalPlatformGalleryPublicationRequest['mimeType'];
  const byteSize = Number(input?.byteSize);
  const width = Number(input?.width);
  const height = Number(input?.height);
  const effectivePrompt = String(input?.effectivePrompt ?? '').trim();
  const negativePrompt = typeof input?.negativePrompt === 'string' ? input.negativePrompt.trim() || null : null;
  const modelDisplayName = String(input?.modelDisplayName ?? '').trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 191) throw new PublicationError(400, ApiErrorCode.BadRequest, '图库发布幂等键不正确');
  if (!/^[0-9a-f-]{36}$/i.test(artifactId)) throw new PublicationError(400, ApiErrorCode.BadRequest, '产物 ID 不正确');
  if (walletOwnerType !== 'user' && walletOwnerType !== 'qq') throw new PublicationError(400, ApiErrorCode.BadRequest, '主站钱包主体类型不正确');
  if (!/^[1-9][0-9]{0,19}$/.test(userSubject)) throw new PublicationError(400, ApiErrorCode.BadRequest, '主站钱包主体不正确');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new PublicationError(400, ApiErrorCode.BadRequest, '产物 SHA-256 不正确');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new PublicationError(400, ApiErrorCode.BadRequest, '正式图库当前只接受 PNG、JPEG 或 WebP 图片');
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > maximumArtifactBytes) throw new PublicationError(400, ApiErrorCode.BadRequest, '产物字节数不正确');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64 || width > 8192 || height > 8192) throw new PublicationError(400, ApiErrorCode.BadRequest, '产物尺寸不正确');
  if (!effectivePrompt || effectivePrompt.length > 100000) throw new PublicationError(400, ApiErrorCode.BadRequest, '最终提示词不正确');
  if (negativePrompt && negativePrompt.length > 100000) throw new PublicationError(400, ApiErrorCode.BadRequest, '负面提示词不正确');
  if (!modelDisplayName || modelDisplayName.length > 191) throw new PublicationError(400, ApiErrorCode.BadRequest, '模型名称不正确');
  const parameters = input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters) ? input.parameters : {};
  return { idempotencyKey, artifactId, walletOwnerType, userSubject, sha256, mimeType, byteSize, width, height, isPrivate: input.isPrivate === true, effectivePrompt, negativePrompt, modelDisplayName, parameters };
}

/** 校验独立平台固定服务凭证。 */
function authenticatePlatform(req: IncomingMessage): boolean {
  const expected = process.env.LOCAL_PLATFORM_INTEGRATION_TOKEN?.trim();
  return Boolean(expected && readHeader(req.headers['x-local-platform-token']) === expected);
}

/** 校验 URL 中的独立任务 ID。 */
function normalizeExternalTaskId(value: string | undefined): string {
  const id = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) throw new PublicationError(400, ApiErrorCode.BadRequest, '独立平台任务 ID 不正确');
  return id;
}

/** 转换数据库镜像为跨程序发布视图。 */
function toPublicationView(publication: { id: string; externalTaskId: string; status: string; mainTaskId: string | null; mediaFilename: string | null }): LocalPlatformGalleryPublicationView {
  return {
    publicationId: publication.id,
    externalTaskId: publication.externalTaskId,
    status: publication.status as LocalPlatformGalleryPublicationView['status'],
    mainGalleryItemId: publication.mainTaskId,
    mediaUrl: publication.mediaFilename ? `/images/${publication.mediaFilename}` : null,
  };
}

/** 受控发布错误，携带稳定 HTTP 状态与业务码。 */
class PublicationError extends Error {
  public constructor(public readonly status: number, public readonly code: typeof ApiErrorCode[keyof typeof ApiErrorCode], message: string) {
    super(message);
  }
}

/** 统一映射发布异常，避免暴露内部路径与数据库信息。 */
function handlePublicationError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof PublicationError) return sendFailure(res, error.status, error.code, error.message);
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return sendFailure(res, 409, ApiErrorCode.Conflict, '图库发布记录已经存在');
  return sendFailure(res, 500, ApiErrorCode.InternalError, '本地模型产物发布失败');
}

/** 生成符合共享契约的成功响应。 */
function success(data: LocalPlatformGalleryPublicationView): LocalPlatformGalleryPublicationResponse {
  return { ok: true, data };
}

/** 生成本地模型图库删除成功响应。 */
function removalSuccess(data: LocalPlatformGalleryRemovalView): LocalPlatformGalleryRemovalResponse {
  return { ok: true, data };
}

/** 发送符合共享契约的失败响应。 */
function sendFailure(res: Parameters<typeof sendJson>[0], status: number, code: typeof ApiErrorCode[keyof typeof ApiErrorCode], message: string) {
  return sendJson(res, status, { ok: false, code, message } satisfies LocalPlatformGalleryPublicationResponse);
}

/** 发送本地模型图库删除失败响应。 */
function sendRemovalFailure(res: Parameters<typeof sendJson>[0], status: number, code: typeof ApiErrorCode[keyof typeof ApiErrorCode], message: string) {
  return sendJson(res, status, { ok: false, code, message } satisfies LocalPlatformGalleryRemovalResponse);
}

/** 映射删除过程中可能出现的参数或数据库异常。 */
function handleRemovalError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof PublicationError) return sendRemovalFailure(res, error.status, error.code, error.message);
  return sendRemovalFailure(res, 500, ApiErrorCode.InternalError, '本地模型图库记录删除失败');
}

/** 读取单值请求头。 */
function readHeader(value: string | string[] | undefined): string {
  return String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim();
}

/** 使用受保护内部接口通知独立平台隐藏本地任务；任一同步失败时中止主站删除以避免用户看到单边删除。 */
async function requestLocalTaskDeletion(externalTaskId: string): Promise<void> {
  const baseUrl = process.env.LOCAL_PLATFORM_INTERNAL_URL?.trim() || 'http://127.0.0.1:7102';
  const token = process.env.LOCAL_PLATFORM_INTEGRATION_TOKEN?.trim();
  if (!token) throw new PublicationError(503, ApiErrorCode.ServiceUnavailable, '本地模型平台删除同步尚未配置');
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/internal/gallery-publications/${encodeURIComponent(externalTaskId)}`, {
      method: 'DELETE',
      headers: { 'x-local-platform-token': token },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new PublicationError(503, ApiErrorCode.ServiceUnavailable, '本地模型平台删除同步不可达');
  }
  const payload = await response.json().catch(() => null) as { ok?: boolean; message?: string } | null;
  if (!response.ok || payload?.ok !== true) throw new PublicationError(502, ApiErrorCode.ServiceUnavailable, payload?.message || `本地模型平台删除同步失败：HTTP ${response.status}`);
}

/** 截断内部异常摘要，只用于发布镜像补偿状态。 */
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
