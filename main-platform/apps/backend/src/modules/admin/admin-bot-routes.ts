/**
 * 管理端 Bot 管理路由：Bot 状态查询、QQ 绑定列表管理。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { readBearerToken } from '../../shared/http/auth-header.js';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

const prisma = getPrismaClient();
const WSPROXY_URL = process.env.WSPROXY_SERVICE_URL ?? 'http://localhost:3011';

export function createAdminBotRoutes(): Route[] {
  return [
    { method: 'GET', path: '/admin/bot/status', handle: botStatus },
    { method: 'GET', path: '/admin/bot/accounts', handle: botAccounts },
    { method: 'POST', path: '/admin/bot/:selfId/api', handle: botApiPassthrough },
    { method: 'GET', path: '/admin/bot/qq-bindings', handle: listQqBindings },
    { method: 'DELETE', path: '/admin/bot/qq-bindings/:id', handle: unbindQq },
    /** 内部接口：bot-service 检查封禁状态 */
    { method: 'GET', path: '/internal/bot/:selfId/is-banned', handle: internalIsBanned },
    /** 内部接口：bot-service 返回消息后递增计数 */
    { method: 'POST', path: '/internal/bot/:selfId/increment-messages', handle: internalIncrementMessages },
    /** 内部接口：wsproxy 通知 Bot 离线 */
    { method: 'POST', path: '/internal/bot/offline', handle: internalBotOffline },
  ];
}

/** Bot 在线状态：聚合 wsproxy-service 在线连接 + 数据库 Bot 绑定信息。 */
async function botStatus(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });

  // 从 wsproxy-service 拉取在线连接摘要
  let onlineConnections: unknown[] = [];
  try {
    const wsRes = await fetch(`${WSPROXY_URL}/wsproxy/bots`, { signal: AbortSignal.timeout(3000) });
    const data = await wsRes.json().catch(() => ({})) as { items?: unknown[] };
    onlineConnections = data.items ?? [];
  } catch { /* wsproxy 不可用 */ }

  // 从数据库拉取 Bot 连接记录
  const dbBots = await prisma.botConnection.findMany({
    select: { id:true, selfId:true, qqNumber:true, nickname:true, status:true, lastSeenAt:true, boundUserId:true, banned:true },
  });

  return sendJson(res, 200, { ok: true, data: {
    onlineCount: onlineConnections.length,
    onlineConnections,
    registeredBots: dbBots.map((b) => ({
      id: b.id, selfId: b.selfId.toString(), qqNumber: b.qqNumber.toString(),
      nickname: b.nickname, status: b.status,
      lastSeenAt: b.lastSeenAt ? formatChinaDateTime(b.lastSeenAt) : null,
      boundUserId: b.boundUserId, banned: b.banned,
    })),
  }});
}

/** Bot 账号列表（交叉查询 wsproxy 获取实时在线状态）。 */
async function botAccounts(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const bots = await prisma.botConnection.findMany({
    orderBy: { lastSeenAt: 'desc' },
    select: { id:true, selfId:true, qqNumber:true, nickname:true, status:true, lastSeenAt:true, connectedAt:true, totalUptimeSeconds:true, banned:true },
  });

  // 查询 wsproxy 活跃连接，用于修正实时在线状态
  let onlineSelfIds = new Set<string>();
  try {
    const wsRes = await fetch(`${WSPROXY_URL}/wsproxy/bots`, { signal: AbortSignal.timeout(3000) });
    const wsData = await wsRes.json().catch(() => ({})) as { ok?: boolean; data?: { items?: { selfId: number }[] } };
    onlineSelfIds = new Set((wsData?.data?.items ?? []).filter(b => b.selfId).map(b => String(b.selfId)));
  } catch { /* wsproxy 不可达时使用 DB 缓存状态 */ }

  return sendJson(res, 200, { ok: true, data: bots.map((b) => {
    const selfIdStr = b.selfId.toString();
    return {
      id: b.id, selfId: selfIdStr, qqNumber: b.qqNumber.toString(), nickname: b.nickname,
      status: onlineSelfIds.has(selfIdStr) ? 'online' : 'offline',
      lastSeenAt: b.lastSeenAt ? formatChinaDateTime(b.lastSeenAt) : null,
      connectedAt: b.connectedAt ? formatChinaDateTime(b.connectedAt) : null,
      totalUptimeSeconds: b.totalUptimeSeconds, banned: b.banned,
    };
  })});
}

/** 向 Bot 透传 OneBot API 指令。 */
async function botApiPassthrough(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const selfId = params?.selfId ?? '';
  const body = await readJsonBody(req);
  try {
    const botRes = await fetch(`${WSPROXY_URL}/internal/bot/${selfId}/api`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const data = await botRes.json().catch(() => ({}));
    return sendJson(res, botRes.status, { ok: botRes.ok, data });
  } catch { return sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: 'Bot 服务不可用' }); }
}

/** 管理端 QQ 绑定列表。 */
async function listQqBindings(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const bindings = await prisma.qqBinding.findMany({
    where: { verified: true },
    orderBy: { createdAt: 'desc' },
    select: { id:true, userId:true, qqNumber:true, verified:true, createdAt:true,
      user: { select: { username:true } } },
  });
  return sendJson(res, 200, { ok: true, data: bindings.map((b) => ({
    id: b.id, userId: b.userId, username: b.user.username,
    qqNumber: b.qqNumber?.toString() ?? null, verified: b.verified,
    createdAt: formatChinaDateTime(b.createdAt),
  }))});
}

/** 管理端解绑 QQ（不删除余额）。 */
async function unbindQq(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '需要管理员权限' });
  const id = Number(params?.id ?? '0');
  await prisma.qqBinding.update({ where: { id }, data: { verified: false, qqNumber: null, verificationKey: `UNBIND_${Date.now()}`, keyExpiresAt: new Date(0) } });
  return sendJson(res, 200, { ok: true, data: { unbound: true } });
}

/** 内部接口：检查 Bot 是否被封禁。bot-service 每次处理命令前调用。 */
async function internalIsBanned(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceTokenFromHeaders(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const selfId = BigInt(params?.selfId ?? '0');
  if (selfId === 0n) return sendJson(res, 400, { ok: false, message: 'selfId 不正确' });
  const bot = await prisma.botConnection.findUnique({ where: { selfId }, select: { banned: true } });
  return sendJson(res, 200, { ok: true, data: { banned: bot?.banned ?? false } });
}

/** 内部接口：wsproxy 通知 Bot 离线（WebSocket 断开或心跳超时）。将数据库状态同步为 offline。 */
async function internalBotOffline(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceTokenFromHeaders(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const body = await readJsonBody(req);
  const selfId = Number(body.selfId);
  if (!selfId || !Number.isInteger(selfId)) {
    return sendJson(res, 400, { ok: false, message: '缺少 selfId' });
  }
  await prisma.botConnection.updateMany({
    where: { selfId: BigInt(selfId) },
    data: { status: 'offline' },
  });
  return sendJson(res, 200, { ok: true, data: { updated: true } });
}

function verifyServiceTokenFromHeaders(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}

/** 内部接口：递增 Bot 消息返回计数。bot-service 每次返回 action 后调用。 */
async function internalIncrementMessages(req: IncomingMessage, res: Parameters<typeof sendJson>[0], params?: Record<string, string>) {
  if (!verifyServiceTokenFromHeaders(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const selfId = BigInt(params?.selfId ?? '0');
  if (selfId === 0n) return sendJson(res, 400, { ok: false, message: 'selfId 不正确' });
  const body = await readJsonBody(req);
  const count = Number(body.count ?? 1);
  // Bot 消息计数会和 wsproxy 在线心跳或连接清理同时发生；updateMany 在记录已移除时保持幂等，避免 P2025。
  const updated = await withBotConnectionRetry(() => prisma.botConnection.updateMany({
    where: { selfId },
    data: { messageCount: { increment: count } },
  }));
  return sendJson(res, 200, { ok: true, data: { incremented: updated.count > 0 ? count : 0, updated: updated.count > 0 } });
}

function authenticateAdmin(req: IncomingMessage): AccessTokenPayload | undefined {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { const p = verifyAccessToken(token); return p.role === 'admin' ? p : undefined; } catch { return undefined; }
}
function formatChinaDateTime(d: Date): string {
  return new Date(d.getTime() + 8*60*60*1000).toISOString().replace('Z','+08:00');
}
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

/** 对 Bot 连接表的瞬时并发写冲突做短重试，避免高频心跳/计数同时写入造成 500。 */
async function withBotConnectionRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableBotConnectionError(error) || index === attempts - 1) throw error;
      lastError = error;
      await sleep(25 * (index + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Bot 连接状态更新失败');
}

/** 只重试数据库瞬时并发冲突，服务 token、参数和业务错误保持原样。 */
function isRetryableBotConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Record has changed since last read') || message.includes("table 'bot_connections'");
}

/** 简单短退避，避免并发更新持续撞同一行。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
