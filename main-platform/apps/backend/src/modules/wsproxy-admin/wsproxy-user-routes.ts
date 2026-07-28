/**
 * wsproxy 用户端路由：测试连接、绑定 Bot、Bot 列表（我的/公开/管理）。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { readJsonBody } from '../../shared/http/body.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

const prisma = getPrismaClient();
const WSPROXY_URL = process.env.WSPROXY_SERVICE_URL ?? 'http://localhost:3011';

export function createWsproxyUserRoutes(): Route[] {
  return [
    { method: 'POST', path: '/wsproxy/test-connection', handle: testConnection },
    { method: 'POST', path: '/wsproxy/bind-bot', handle: bindBot },
    { method: 'GET', path: '/wsproxy/my-bots', handle: myBots },
    { method: 'GET', path: '/wsproxy/admin/bots', handle: adminBots },
    /** 公开接口：展示全部 Bot 状态（不暴露绑定用户信息），无需登录 */
    { method: 'GET', path: '/wsproxy/public-bots', handle: publicBots },
    { method: 'POST', path: '/wsproxy/bots/:selfId/unbind', handle: unbindBot },
    { method: 'POST', path: '/wsproxy/bots/:selfId/ban', handle: banBot },
    { method: 'POST', path: '/wsproxy/bots/:selfId/unban', handle: unbanBot },
    { method: 'DELETE', path: '/wsproxy/bots/:selfId', handle: deleteBot },
  ];
}

/** 用户测试 Bot 连接：查询 wsproxy 中未绑定的活跃连接，自动返回 Bot 信息。 */
async function testConnection(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(_req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  try {
    const wsRes = await fetch(`${WSPROXY_URL}/wsproxy/bots`, { signal: AbortSignal.timeout(3000) });
    const wsData = await wsRes.json().catch(() => ({})) as { ok?: boolean; data?: { items?: { selfId: number; connectedAt: string; uptimeSec: number }[] } };
    const connectedBots = wsData?.data?.items ?? [];
    const boundBots = await prisma.botConnection.findMany({
      where: { boundUserId: { not: null } },
      select: { selfId: true },
    });
    const boundSelfIds = new Set(boundBots.map(b => b.selfId.toString()));
    const available = connectedBots
      .filter(b => b.selfId && !boundSelfIds.has(String(b.selfId)))
      .map(b => ({ selfId: String(b.selfId), connectedAt: b.connectedAt, uptimeSec: b.uptimeSec }));
    return sendJson(res, 200, { ok: true, data: { connected: available.length > 0, bots: available } });
  } catch {
    return sendJson(res, 200, { ok: true, data: { connected: false, bots: [], message: 'wsproxy 服务不可达' } });
  }
}

/** 用户绑定 Bot：校验 Bot 已连接后关联到当前用户。 */
async function bindBot(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const body = await readJsonBody<{ selfId?: string; nickname?: string }>(req);
  const selfIdStr = String(body.selfId ?? '').trim();
  if (!selfIdStr || !/^\d{5,15}$/.test(selfIdStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: `Bot QQ 号不正确: "${selfIdStr}"` });
  }
  try {
    const selfId = BigInt(selfIdStr);
    let connected = false;
    try {
      const wsRes = await fetch(`${WSPROXY_URL}/wsproxy/bots`, { signal: AbortSignal.timeout(3000) });
      const wsData = await wsRes.json().catch(() => ({})) as { ok?: boolean; data?: { items?: { selfId: number }[] } };
      connected = wsData?.data?.items?.some(item => String(item.selfId) === selfIdStr) ?? false;
    } catch { /* wsproxy 不可达时允许绑定 */ }
    const existing = await prisma.botConnection.findUnique({ where: { selfId }, select: { boundUserId: true } });
    if (existing?.boundUserId && existing.boundUserId !== user.sub) {
      return sendJson(res, 409, { ok: false, code: ApiErrorCode.Conflict, message: '该 Bot 已被其他用户绑定' });
    }
    await prisma.botConnection.upsert({
      where: { selfId },
      update: { boundUserId: user.sub, nickname: String(body.nickname ?? ''), status: connected ? 'online' : 'offline' },
      create: { selfId, qqNumber: selfId, boundUserId: user.sub, nickname: String(body.nickname ?? ''), status: connected ? 'online' : 'offline' },
    });
    return sendJson(res, 200, { ok: true, data: { bound: true, selfId: selfId.toString(), connected } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '绑定失败';
    return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: msg });
  }
}

/** 我的 Bot 列表（实时查询 wsproxy 获取在线状态 + 在线时长）。 */
async function myBots(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const bots = await prisma.botConnection.findMany({
    where: { boundUserId: user.sub },
    select: { id:true, selfId:true, qqNumber:true, nickname:true, status:true, lastSeenAt:true, connectedAt:true, messageCount:true, banned:true },
  });
  const result = await enrichWithWsproxyStatus(bots);
  return sendJson(res, 200, { ok: true, data: { items: result } });
}

/** 公开 Bot 列表：展示全部 Bot（不暴露绑定用户），无需登录。 */
async function publicBots(_req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  const bots = await prisma.botConnection.findMany({
    orderBy: { lastSeenAt: 'desc' },
    select: { id:true, selfId:true, qqNumber:true, nickname:true, status:true, lastSeenAt:true, connectedAt:true, messageCount:true, banned:true },
  });
  const result = await enrichWithWsproxyStatus(bots);
  return sendJson(res, 200, { ok: true, data: { items: result } });
}

/** 管理员查看所有 Bot。 */
async function adminBots(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const bots = await prisma.botConnection.findMany({
    orderBy: { lastSeenAt: 'desc' },
    select: { id:true, selfId:true, qqNumber:true, nickname:true, status:true, lastSeenAt:true, boundUserId:true, banned:true, bannedReason:true },
  });
  // wsproxy 交叉查询实时状态
  let onlineSelfIds = new Set<string>();
  try {
    const wsRes = await fetch(`${WSPROXY_URL}/wsproxy/bots`, { signal: AbortSignal.timeout(3000) });
    const wsData = await wsRes.json().catch(() => ({})) as { ok?: boolean; data?: { items?: { selfId: number }[] } };
    onlineSelfIds = new Set((wsData?.data?.items ?? []).filter(b => b.selfId).map(b => String(b.selfId)));
  } catch { /* wsproxy 不可达 */ }
  return sendJson(res, 200, { ok: true, data: bots.map((b) => {
    const selfIdStr = b.selfId.toString();
    return {
      id: b.id, selfId: selfIdStr, qqNumber: b.qqNumber.toString(), nickname: b.nickname,
      status: onlineSelfIds.has(selfIdStr) ? 'online' : 'offline',
      lastSeenAt: b.lastSeenAt ? formatChinaDateTime(b.lastSeenAt) : null,
      boundUserId: b.boundUserId, banned: b.banned, bannedReason: b.bannedReason,
    };
  })});
}

/** 查询 wsproxy 实时状态，为 Bot 列表添加 online/offline + 在线秒数 */
async function enrichWithWsproxyStatus(bots: Array<{
  id: number; selfId: bigint; qqNumber: bigint; nickname: string;
  status: string; lastSeenAt: Date | null; connectedAt: Date | null; banned: boolean;
  messageCount?: number;
}>) {
  let onlineSelfIds = new Set<string>();
  let onlineUptimes = new Map<string, number>();
  try {
    const wsRes = await fetch(`${WSPROXY_URL}/wsproxy/bots`, { signal: AbortSignal.timeout(3000) });
    const wsData = await wsRes.json().catch(() => ({})) as { ok?: boolean; data?: { items?: { selfId: number; uptimeSec: number }[] } };
    for (const b of (wsData?.data?.items ?? [])) {
      if (b.selfId) { onlineSelfIds.add(String(b.selfId)); onlineUptimes.set(String(b.selfId), b.uptimeSec); }
    }
  } catch { /* wsproxy 不可达 */ }
  return bots.map((b) => {
    const selfIdStr = b.selfId.toString();
    const realStatus = onlineSelfIds.has(selfIdStr) ? 'online' : 'offline';
    return {
      id: b.id, selfId: selfIdStr, qqNumber: b.qqNumber.toString(), nickname: b.nickname,
      status: realStatus,
      lastSeenAt: b.lastSeenAt ? formatChinaDateTime(b.lastSeenAt) : null,
      connectedAt: b.connectedAt ? formatChinaDateTime(b.connectedAt) : null,
      uptimeSec: onlineUptimes.get(selfIdStr) ?? 0,
      messageCount: b.messageCount ?? 0,
      banned: b.banned,
    };
  });
}

/** 用户解绑自己的 Bot：清绑定 + 删除端点 + 通知 wsproxy 断开连接。 */
async function unbindBot(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  const user = authenticateUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: ApiErrorCode.Unauthorized, message: '请先登录' });
  const selfId = BigInt(params?.selfId ?? '0');
  const bot = await prisma.botConnection.findUnique({ where: { selfId } });
  if (!bot || bot.boundUserId !== user.sub) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '无权操作此 Bot' });
  }
  await prisma.$transaction([
    // 解绑只移除当前 Bot 的归属，不影响同一用户绑定的其他 Bot。
    prisma.botConnection.update({ where: { selfId }, data: { boundUserId: null, status: 'offline' } }),
    // 动态端点按 usedBySelfId 定位当前 Bot，避免删除用户其他 Bot 的长期重连端点。
    prisma.wsProxyEndpoint.deleteMany({ where: { userId: user.sub, usedBySelfId: selfId } }),
  ]);
  try {
    await fetch(`${WSPROXY_URL}/internal/disconnect-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ selfId: Number(selfId) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* wsproxy 不可达不影响解绑 */ }
  return sendJson(res, 200, { ok: true, data: { unbound: true, selfId: selfId.toString() } });
}

/** 封禁 Bot：标记封禁 + 断开 wsproxy 连接。保留端点+绑定，解封快速恢复。 */
async function banBot(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const selfId = BigInt(params?.selfId ?? '0');
  const body = await readJsonBody<{ reason?: string }>(req);
  await prisma.botConnection.update({
    where: { selfId },
    data: { banned: true, bannedAt: new Date(), bannedReason: String(body.reason ?? ''), status: 'offline' },
  });
  try {
    await fetch(`${WSPROXY_URL}/internal/disconnect-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ selfId: Number(selfId) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* wsproxy 不可达不影响封禁 */ }
  return sendJson(res, 200, { ok: true, data: { banned: true, selfId: selfId.toString() } });
}

/** 解封 Bot。 */
async function unbanBot(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const selfId = BigInt(params?.selfId ?? '0');
  await prisma.botConnection.update({ where: { selfId }, data: { banned: false, bannedAt: null, bannedReason: null } });
  return sendJson(res, 200, { ok: true, data: { unbanned: true, selfId: selfId.toString() } });
}

/** 管理员删除 Bot（不可恢复）。 */
async function deleteBot(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const selfId = BigInt(params?.selfId ?? '0');
  const bot = await prisma.botConnection.findUnique({ where: { selfId }, select: { boundUserId: true } });
  if (!bot) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: 'Bot 不存在' });
  if (bot.boundUserId) await prisma.wsProxyEndpoint.deleteMany({ where: { userId: bot.boundUserId } });
  await prisma.wsProxyEndpoint.deleteMany({ where: { usedBySelfId: selfId } });
  await prisma.botConnection.delete({ where: { selfId } });
  try {
    await fetch(`${WSPROXY_URL}/internal/disconnect-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ selfId: Number(selfId) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* wsproxy 不可达不影响删除 */ }
  return sendJson(res, 200, { ok: true, data: { deleted: true, selfId: selfId.toString() } });
}

function authenticateUser(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { return verifyAccessToken(token); } catch { return undefined; }
}
function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const user = authenticateUser(req);
  return user?.role === 'admin' ? user : undefined;
}
function formatChinaDateTime(d: Date): string {
  return new Date(d.getTime() + 8*60*60*1000).toISOString().replace('Z','+08:00');
}
