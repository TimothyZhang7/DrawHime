/**
 * 本文件注册用户资料和偏好路由：个人资料查询/修改、默认隐私偏好。
 */
import type { IncomingMessage } from 'node:http';
import {
  ApiErrorCode,
  type ApiDataResponse,
  type AuthUser,
  type UpdateUserPrivacyPreferenceRequest,
  type UpdateUserProfileRequest,
  type UpdateUserProfileResponse,
  type UserAvatarDeleteResponse,
  type UserAvatarUploadResponse,
  type UserProfileResponse,
  type UserPublicProfileResponse,
  type UserPrivacyPreferenceResponse,
} from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { AuthService } from '../auth/auth-service.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { invalidateUserCache, setBackendCacheHeader } from '../../shared/cache/cache-service.js';
import { cacheUserPrivacy, cacheUserProfile } from '../../shared/cache/cache-policies.js';
import {
  buildAvatarUrl,
  deleteUserAvatarFile,
  saveUserAvatar,
  serveUserAvatar,
  USER_AVATAR_UPLOAD_MAX_BYTES,
} from './user-avatar-service.js';
import { UserPublicProfileService } from './user-public-profile-service.js';

const prisma = getPrismaClient();
const publicProfileService = new UserPublicProfileService();
const authService = new AuthService();

export function createUserRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/users/:id/public-profile', handle: getPublicProfile },
    { method: 'GET', path: '/api/users/profile', handle: getProfile },
    { method: 'PUT', path: '/api/users/profile', handle: updateProfile },
    { method: 'GET', path: '/api/users/avatar/:filename', handle: getAvatar },
    { method: 'POST', path: '/api/users/me/avatar', handle: uploadAvatar },
    { method: 'DELETE', path: '/api/users/me/avatar', handle: deleteAvatar },
    { method: 'GET', path: '/api/users/me/privacy', handle: getPrivacy },
    { method: 'PATCH', path: '/api/users/me/privacy', handle: updatePrivacy },
  ];
}

/** 读取 Web 用户公开主页；只返回公开资料和公开成功图片，不返回邮箱、余额、角色或权限。 */
async function getPublicProfile(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const userId = Number(params?.id ?? 0);
  if (!Number.isInteger(userId) || userId <= 0) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '用户 ID 不正确' });
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '24');
  const data = await publicProfileService.getProfile(userId, { page, pageSize });
  if (!data) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
  return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<UserPublicProfileResponse>);
}

/** 获取当前用户完整资料。 */
async function getProfile(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const cached = await cacheUserProfile(user.sub, () => prisma.user.findUnique({
    where: { id: user.sub },
    select: {
      id: true, username: true, email: true, role: true,
      emailVerified: true, defaultImagePrivate: true, createdAt: true,
      avatarFilename: true,
      qqBinding: { select: { qqNumber: true, verified: true } },
    },
  }));
  setBackendCacheHeader(res, cached.status);
  const profile = cached.value;
  if (!profile) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
  const emailBound = !isPlaceholderEmail(profile.email);
  return sendJson(res, 200, {
    ok: true,
    data: {
      id: profile.id,
      username: profile.username,
      email: emailBound ? profile.email : '',
      role: normalizeUserRole(profile.role),
      emailVerified: emailBound && profile.emailVerified,
      defaultImagePrivate: profile.defaultImagePrivate,
      avatarUrl: buildAvatarUrl(profile.avatarFilename),
      qqNumber: profile.qqBinding?.verified ? profile.qqBinding.qqNumber?.toString() ?? null : null,
      createdAt: formatChinaDateTime(profile.createdAt),
    },
  } satisfies UserProfileResponse);
}

/** 修改当前 Web 用户公开用户名；修改后返回最新登录态用户，便于前端刷新导航栏和公开展示。 */
async function updateProfile(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const body = await readJsonBody<UpdateUserProfileRequest>(req);
  const newUsername = body.username?.trim();
  if (!newUsername || newUsername.length < 2 || newUsername.length > 32) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '用户名需 2-32 字符' });
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/.test(newUsername)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '用户名仅支持中英文、数字和下划线' });
  }
  // 检查用户名唯一性
  const existing = await prisma.user.findUnique({ where: { username: newUsername } });
  if (existing && existing.id !== user.sub) {
    return sendJson(res, 409, { ok: false, code: ApiErrorCode.Conflict, message: '用户名已被使用' });
  }
  await prisma.user.update({ where: { id: user.sub }, data: { username: newUsername } });
  // 用户资料修改后立即清理资料、隐私和其他用户态短缓存，避免公开昵称继续显示旧值。
  invalidateUserCache(user.sub);
  const latestUser: AuthUser = await authService.currentUser(user.sub);
  return sendJson(res, 200, {
    ok: true,
    data: latestUser,
    message: '用户名已更新',
  } satisfies UpdateUserProfileResponse);
}

/** 读取 Web 用户自定义头像；该接口只读本地头像目录，不访问 media-service 或 QQ 头像。 */
async function getAvatar(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const filename = String(params?.filename ?? '').trim();
  const served = await serveUserAvatar(filename, res);
  if (!served && !res.headersSent) {
    return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '头像不存在' });
  }
}

/** 上传当前 Web 用户头像；头像只写入 backend 本地目录，不进入 media-service 图片链路。 */
async function uploadAvatar(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const mimeType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '请上传图片文件' });
  }

  let savedFilename: string | null = null;
  try {
    const imageBuffer = await readBinaryBody(req, USER_AVATAR_UPLOAD_MAX_BYTES);
    const filename = await saveUserAvatar(user.sub, imageBuffer, mimeType);
    savedFilename = filename;
    const previous = await prisma.user.findUnique({ where: { id: user.sub }, select: { avatarFilename: true } });
    if (!previous) {
      await deleteUserAvatarFile(filename);
      return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
    }
    await prisma.user.update({ where: { id: user.sub }, data: { avatarFilename: filename } });
    // 用户头像变更后必须失效 /auth/me 与 /api/users/profile 缓存，避免前端继续显示旧头像。
    invalidateUserCache(user.sub);
    if (previous.avatarFilename && previous.avatarFilename !== filename) {
      await deleteUserAvatarFile(previous.avatarFilename);
    }
    const avatarUrl = buildAvatarUrl(filename);
    if (!avatarUrl) throw new Error('头像文件名不合法');
    return sendJson(res, 200, {
      ok: true,
      data: { avatarUrl, filename },
    } satisfies ApiDataResponse<UserAvatarUploadResponse>);
  } catch (error) {
    // 关键分支：文件已落地但数据库更新失败时，删除本次新文件，避免本地头像目录出现无主文件。
    await deleteUserAvatarFile(savedFilename);
    const message = error instanceof Error ? error.message : '头像上传失败';
    const status = message.includes('超过') ? 413 : 400;
    return sendJson(res, status, { ok: false, code: ApiErrorCode.BadRequest, message });
  }
}

/** 删除当前 Web 用户头像；恢复默认首字母头像，不触碰 QQ 绑定和 QQ 头像。 */
async function deleteAvatar(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const current = await prisma.user.findUnique({ where: { id: user.sub }, select: { avatarFilename: true } });
  if (!current) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
  await prisma.user.update({ where: { id: user.sub }, data: { avatarFilename: null } });
  invalidateUserCache(user.sub);
  await deleteUserAvatarFile(current.avatarFilename);
  return sendJson(res, 200, { ok: true, data: { avatarUrl: null } } satisfies ApiDataResponse<UserAvatarDeleteResponse>);
}

/** 查询 Web 与 Bot 两端默认图片隐私偏好。 */
async function getPrivacy(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const cached = await cacheUserPrivacy(user.sub, () => readPrivacyPreference(user.sub));
  setBackendCacheHeader(res, cached.status);
  const data = cached.value;
  if (!data) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
  return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<UserPrivacyPreferenceResponse>);
}

/** 修改 Web 与 Bot 两端默认图片隐私偏好。 */
async function updatePrivacy(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const body = await readJsonBody<UpdateUserPrivacyPreferenceRequest>(req);
  const hasWebDefault = typeof body.webDefaultPrivate === 'boolean';
  const hasLegacyWebDefault = typeof body.defaultImagePrivate === 'boolean';
  const hasBotDefault = typeof body.botDefaultPrivate === 'boolean';
  const botDefaultPrivate = body.botDefaultPrivate === true;
  if (!hasWebDefault && !hasLegacyWebDefault && !hasBotDefault) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: '参数格式不正确' });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.user.findUnique({
      where: { id: user.sub },
      select: {
        defaultImagePrivate: true,
        qqBinding: { select: { qqNumber: true, verified: true } },
      },
    });
    if (!current) return null;

    const webDefaultPrivate = hasWebDefault ? body.webDefaultPrivate : body.defaultImagePrivate;
    if (typeof webDefaultPrivate === 'boolean') {
      await tx.user.update({
        where: { id: user.sub },
        data: { defaultImagePrivate: webDefaultPrivate },
      });
    }

    const qqNumber = current.qqBinding?.verified ? current.qqBinding.qqNumber ?? null : null;
    if (hasBotDefault) {
      if (!qqNumber) {
        // Bot 端默认隐私只能修改当前用户已验证绑定的 QQ，避免网页登录态越权写任意 QQ 偏好。
        return 'qq_not_bound' as const;
      }
      await tx.qqImagePrivacyPref.upsert({
        where: { qqNumber },
        update: { isPrivate: botDefaultPrivate },
        create: { qqNumber, isPrivate: botDefaultPrivate },
      });
    }

    return true;
  });
  if (updated === null) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
  if (updated === 'qq_not_bound') return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '请先绑定 QQ 后再设置 Bot 隐私' });

  // 隐私偏好修改后不能继续使用旧用户缓存，尤其是生成页默认开关。
  invalidateUserCache(user.sub);
  const data = await readPrivacyPreference(user.sub);
  if (!data) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '用户不存在' });
  return sendJson(res, 200, { ok: true, data } satisfies ApiDataResponse<UserPrivacyPreferenceResponse>);
}

/** 读取用户隐私偏好，Bot 端偏好按当前 verified QQ 号独立查询。 */
async function readPrivacyPreference(userId: number): Promise<UserPrivacyPreferenceResponse | null> {
  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      defaultImagePrivate: true,
      qqBinding: { select: { qqNumber: true, verified: true } },
    },
  });
  if (!profile) return null;
  const qqNumber = profile.qqBinding?.verified ? profile.qqBinding.qqNumber ?? null : null;
  const botPref = qqNumber
    ? await prisma.qqImagePrivacyPref.findUnique({ where: { qqNumber }, select: { isPrivate: true } })
    : null;
  const webDefaultPrivate = profile.defaultImagePrivate;
  return {
    webDefaultPrivate,
    botDefaultPrivate: botPref?.isPrivate ?? false,
    qqNumber: qqNumber ? qqNumber.toString() : null,
    botAvailable: Boolean(qqNumber),
    defaultImagePrivate: webDefaultPrivate,
  };
}

function authenticateUser(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token); } catch { return undefined; }
}

function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** 识别内部占位邮箱，资料接口不得把它当成用户真实邮箱返回。 */
function isPlaceholderEmail(email: string): boolean {
  return email.toLowerCase().endsWith('@unbound.aiimage.local');
}

/** 资料接口归一化角色字段，避免数据库脏值扩散到共享契约。 */
function normalizeUserRole(role: string): 'user' | 'admin' {
  return role === 'admin' ? 'admin' : 'user';
}

/** 读取头像二进制请求体；超过单文件上限立即停止，避免大文件占用内存。 */
async function readBinaryBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += buffer.length;
    if (size > limitBytes) throw new Error('头像图片不能超过 5MB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
