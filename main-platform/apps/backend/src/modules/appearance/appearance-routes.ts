/**
 * 本文件注册全站背景图公开配置、管理员上传和用户个人显示偏好接口。
 * 背景图文件先落盘再更新配置，数据库失败时回滚新文件。
 */
import type { IncomingMessage } from 'node:http';
import {
  ApiErrorCode,
  type SiteAppearanceView,
  type SiteBackgroundUploadResponse,
  type UpdateUserAppearancePreferenceRequest,
  type UserAppearancePreferenceResponse,
} from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { invalidateConfigCacheTags, invalidateUserCache, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheSiteAppearance, cacheUserAppearance } from '../../shared/cache/cache-policies.js';
import {
  SITE_BACKGROUND_UPLOAD_MAX_BYTES,
  buildSiteBackgroundUrl,
  deleteSiteBackgroundFile,
  saveSiteBackground,
  serveSiteBackground,
  siteBackgroundFileExists,
} from './site-background-service.js';

const prisma = getPrismaClient();
const BACKGROUND_ENABLED_KEY = 'site_background_enabled';
const BACKGROUND_FILENAME_KEY = 'site_background_filename';

/** 创建全站背景图相关路由。 */
export function createAppearanceRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/appearance', handle: getSiteAppearance },
    { method: 'GET', path: '/api/appearance/background/:filename', handle: getBackgroundImage },
    { method: 'GET', path: '/api/users/me/appearance', handle: getUserAppearance },
    { method: 'PATCH', path: '/api/users/me/appearance', handle: updateUserAppearance },
    { method: 'POST', path: '/admin/appearance/background', handle: uploadBackgroundImage },
    { method: 'DELETE', path: '/admin/appearance/background', handle: deleteBackgroundImage },
  ];
}

/** 公开读取后台全局开关和当前背景图 URL。 */
async function getSiteAppearance(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const cached = await cacheSiteAppearance(readSiteAppearance);
  setBackendCacheHeader(res, cached.status);
  return sendJson(res, 200, { ok: true, data: cached.value });
}

/** 公开读取随机安全文件名对应的背景图片。 */
async function getBackgroundImage(_req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const served = await serveSiteBackground(String(params?.filename ?? ''), res);
  if (!served && !res.headersSent) {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '背景图片不存在' });
  }
}

/** 读取当前登录用户的背景图显示偏好。 */
async function getUserAppearance(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const cached = await cacheUserAppearance(user.sub, () => prisma.user.findUnique({
    where: { id: user.sub },
    select: { siteBackgroundEnabled: true },
  }));
  setBackendCacheHeader(res, cached.status);
  if (!cached.value) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
  return sendJson(res, 200, {
    ok: true,
    data: { backgroundEnabled: cached.value.siteBackgroundEnabled },
  } satisfies UserAppearancePreferenceResponse);
}

/** 修改当前登录用户的背景图显示偏好。 */
async function updateUserAppearance(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const body = await readJsonBody<UpdateUserAppearancePreferenceRequest>(req);
  if (typeof body.backgroundEnabled !== 'boolean') {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '背景图开关参数不正确' });
  }
  const existing = await prisma.user.findUnique({ where: { id: user.sub }, select: { id: true } });
  if (!existing) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
  const updated = await prisma.user.update({
    where: { id: user.sub },
    data: { siteBackgroundEnabled: body.backgroundEnabled },
    select: { siteBackgroundEnabled: true },
  });
  invalidateUserCache(user.sub);
  return sendJson(res, 200, {
    ok: true,
    data: { backgroundEnabled: updated.siteBackgroundEnabled },
  } satisfies UserAppearancePreferenceResponse);
}

/** 管理员上传并替换全站背景图。 */
async function uploadBackgroundImage(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const mimeType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请上传图片文件' });
  }

  let newFilename: string | null = null;
  try {
    const imageBuffer = await readImageBody(req, SITE_BACKGROUND_UPLOAD_MAX_BYTES);
    newFilename = await saveSiteBackground(imageBuffer, mimeType);
    const configRows = await prisma.systemConfig.findMany({
      where: { key: { in: [BACKGROUND_ENABLED_KEY, BACKGROUND_FILENAME_KEY] } },
      select: { key: true, value: true },
    });
    const configMap = new Map(configRows.map((item) => [item.key, item.value]));
    const previousFilename = configMap.get(BACKGROUND_FILENAME_KEY) ?? null;
    await prisma.systemConfig.upsert({
      where: { key: BACKGROUND_FILENAME_KEY },
      update: { value: newFilename },
      create: { key: BACKGROUND_FILENAME_KEY, value: newFilename },
    });
    invalidateConfigCacheTags();
    if (previousFilename && previousFilename !== newFilename) await deleteSiteBackgroundFile(previousFilename);
    return sendJson(res, 200, {
      ok: true,
      data: {
        backgroundEnabled: configMap.get(BACKGROUND_ENABLED_KEY) === 'true',
        backgroundImageUrl: buildSiteBackgroundUrl(newFilename),
        filename: newFilename,
      },
    } satisfies SiteBackgroundUploadResponse);
  } catch (error) {
    // 新文件已落盘但配置写入失败时必须回滚，不能遗留无主背景文件。
    await deleteSiteBackgroundFile(newFilename);
    const message = error instanceof Error ? error.message : '背景图片上传失败';
    const status = message.includes('超过') ? 413 : 400;
    return sendJson(res, status, { ok: false, code: ApiErrorCode.BadRequest, message });
  }
}

/** 管理员清除当前背景图，保留全局开关供后续重新上传。 */
async function deleteBackgroundImage(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const configRows = await prisma.systemConfig.findMany({
    where: { key: { in: [BACKGROUND_ENABLED_KEY, BACKGROUND_FILENAME_KEY] } },
    select: { key: true, value: true },
  });
  const configMap = new Map(configRows.map((item) => [item.key, item.value]));
  await prisma.systemConfig.deleteMany({ where: { key: BACKGROUND_FILENAME_KEY } });
  invalidateConfigCacheTags();
  await deleteSiteBackgroundFile(configMap.get(BACKGROUND_FILENAME_KEY));
  return sendJson(res, 200, {
    ok: true,
    data: {
      backgroundEnabled: configMap.get(BACKGROUND_ENABLED_KEY) === 'true',
      backgroundImageUrl: null,
    },
  });
}

/** 读取全站背景配置；文件缺失时返回 null，避免前端请求坏链接。 */
async function readSiteAppearance(): Promise<SiteAppearanceView> {
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: [BACKGROUND_ENABLED_KEY, BACKGROUND_FILENAME_KEY] } },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((item) => [item.key, item.value]));
  const filename = values.get(BACKGROUND_FILENAME_KEY) ?? null;
  const exists = await siteBackgroundFileExists(filename);
  return {
    backgroundEnabled: values.get(BACKGROUND_ENABLED_KEY) === 'true',
    backgroundImageUrl: exists ? buildSiteBackgroundUrl(filename) : null,
  };
}

/** 读取图片二进制请求体并限制内存占用。 */
async function readImageBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += buffer.length;
    if (size > limitBytes) throw new Error('背景图片不能超过 15MB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 验证普通用户登录态。 */
function authenticateUser(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token); } catch { return undefined; }
}

/** 验证管理员登录态。 */
function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const user = authenticateUser(req);
  return user?.role === 'admin' ? user : undefined;
}
