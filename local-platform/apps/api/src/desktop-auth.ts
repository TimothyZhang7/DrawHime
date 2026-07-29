/**
 * 本文件实现桌面客户端的浏览器设备授权；服务端只保存随机设备密钥哈希，并复用可撤销独立会话。
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  desktopAuthorizationApproveRequestSchema,
  desktopAuthorizationPollRequestSchema,
  desktopAuthorizationStartRequestSchema,
  type DesktopAuthorizationApprovalView,
  type DesktopAuthorizationPollView,
  type LocalPlatformSessionView,
} from "@drawhime/contracts";
import { database, Prisma, type ExternalIdentity } from "@drawhime/database";
import { readJsonBody, sendError, sendSuccess, type ServiceRouter } from "@drawhime/service-runtime";

const DEVICE_CODE_TTL_MINUTES = 10;
const DEVICE_POLL_INTERVAL_SECONDS = 3;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type SessionRecord = { externalIdentity: ExternalIdentity };
type FindSession = (token: string | null) => Promise<SessionRecord | null>;

/** 注册桌面设备授权创建、浏览器确认和设备轮询接口。 */
export function registerDesktopAuthRoutes(router: ServiceRouter, findSession: FindSession): void {
  router.post("/v1/desktop-auth/requests", async ({ request, response }) => {
    try {
      const input = desktopAuthorizationStartRequestSchema.parse(await readJsonBody<unknown>(request, 16 * 1024));
      await cleanupExpiredAuthorizations();
      const authorization = await createAuthorization(input.deviceName);
      const verificationUrl = verificationUrlFor(authorization.userCode);
      sendSuccess(response, {
        deviceCode: authorization.deviceCode,
        userCode: authorization.userCode,
        verificationUrl,
        expiresAt: authorization.expiresAt.toISOString(),
        intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
      }, 201);
    } catch (error) {
      sendDesktopAuthError(response, error);
    }
  });

  router.post("/v1/desktop-auth/requests/approve", async ({ request, response }) => {
    const session = await findSession(readBearerToken(request));
    if (!session) return sendError(response, 401, "local_session_invalid", "请先登录绘图姬主站并刷新授权页面");
    try {
      const input = desktopAuthorizationApproveRequestSchema.parse(await readJsonBody<unknown>(request, 16 * 1024));
      const userCode = normalizeDesktopUserCode(input.userCode);
      const current = await database.desktopAuthorization.findUnique({ where: { userCode } });
      if (!current || current.expiresAt <= new Date()) throw new DesktopAuthError(410, "desktop_authorization_expired", "设备授权码已经过期，请在桌面端重新发起");
      if (current.consumedAt) throw new DesktopAuthError(409, "desktop_authorization_consumed", "设备授权已经完成");
      if (current.externalIdentityId && current.externalIdentityId !== session.externalIdentity.id) throw new DesktopAuthError(409, "desktop_authorization_claimed", "设备授权已由另一个账号确认");
      const approvedAt = current.approvedAt ?? new Date();
      const updated = await database.desktopAuthorization.update({
        where: { id: current.id },
        data: { externalIdentityId: session.externalIdentity.id, approvedAt },
      });
      const view: DesktopAuthorizationApprovalView = { userCode, deviceName: updated.deviceName, approvedAt: approvedAt.toISOString() };
      sendSuccess(response, view);
    } catch (error) {
      sendDesktopAuthError(response, error);
    }
  });

  router.post("/v1/desktop-auth/token", async ({ request, response }) => {
    try {
      const input = desktopAuthorizationPollRequestSchema.parse(await readJsonBody<unknown>(request, 16 * 1024));
      const tokenHash = hashToken(input.deviceCode);
      const current = await database.desktopAuthorization.findUnique({ where: { deviceCodeHash: tokenHash }, include: { externalIdentity: true } });
      const now = new Date();
      if (!current || current.expiresAt <= now) throw new DesktopAuthError(410, "desktop_authorization_expired", "设备授权已经过期");
      if (!current.externalIdentity || !current.approvedAt) {
        if (current.lastPolledAt && now.getTime() - current.lastPolledAt.getTime() < DEVICE_POLL_INTERVAL_SECONDS * 1000) {
          throw new DesktopAuthError(429, "desktop_authorization_slow_down", "轮询过于频繁，请按页面间隔重试");
        }
        await database.desktopAuthorization.update({ where: { id: current.id }, data: { lastPolledAt: now } });
        const pending: DesktopAuthorizationPollView = { status: "pending", intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS, session: null };
        return sendSuccess(response, pending, 202);
      }
      const session = await consumeAuthorization({ id: current.id, consumedAt: current.consumedAt, externalIdentity: current.externalIdentity }, input.deviceCode, tokenHash, now);
      const authorized: DesktopAuthorizationPollView = { status: "authorized", intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS, session };
      sendSuccess(response, authorized);
    } catch (error) {
      sendDesktopAuthError(response, error);
    }
  });
}

/** 统一用户码格式，允许用户输入时省略短横线和大小写。 */
export function normalizeDesktopUserCode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/[-\s]/g, "");
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{8}$/.test(compact)) throw new DesktopAuthError(400, "desktop_user_code_invalid", "设备授权码格式不正确");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** 创建低碰撞用户码；唯一索引冲突时只重试本次随机码。 */
async function createAuthorization(deviceName: string): Promise<{ deviceCode: string; userCode: string; expiresAt: Date }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = randomUserCode();
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MINUTES * 60 * 1000);
    try {
      await database.desktopAuthorization.create({ data: { deviceCodeHash: hashToken(deviceCode), userCode, deviceName, expiresAt } });
      return { deviceCode, userCode, expiresAt };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
  }
  throw new DesktopAuthError(503, "desktop_authorization_capacity", "设备授权码暂时繁忙，请稍后重试");
}

/** 首次成功轮询原子创建会话；重复轮询返回同一设备密钥对应的有效会话。 */
async function consumeAuthorization(current: { id: string; consumedAt: Date | null; externalIdentity: ExternalIdentity }, deviceCode: string, tokenHash: string, now: Date): Promise<LocalPlatformSessionView> {
  const ttlDays = Math.min(Math.max(Number(process.env.DESKTOP_SESSION_TTL_DAYS || 30), 1), 90);
  if (!current.consumedAt) {
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    try {
      await database.$transaction(async (transaction) => {
        const claimed = await transaction.desktopAuthorization.updateMany({ where: { id: current.id, consumedAt: null }, data: { consumedAt: now, lastPolledAt: now } });
        if (claimed.count !== 1) return;
        await transaction.platformSession.create({ data: { externalIdentityId: current.externalIdentity.id, tokenHash, expiresAt } });
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
  }
  const session = await database.platformSession.findUnique({ where: { tokenHash } });
  if (!session || session.revokedAt || session.expiresAt <= now) throw new DesktopAuthError(410, "desktop_session_revoked", "桌面会话已撤销，请重新登录");
  return {
    identity: identityView(current.externalIdentity),
    sessionToken: deviceCode,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/** 构造同源浏览器确认地址，生产默认落到真实本地模型页面。 */
function verificationUrlFor(userCode: string): string {
  const configured = process.env.DESKTOP_AUTH_VERIFICATION_URL?.trim() || "https://www.xanime.ink/local-model/";
  const url = new URL(configured);
  if (url.protocol !== "https:") throw new DesktopAuthError(503, "desktop_authorization_url_invalid", "设备授权确认地址配置不正确");
  url.searchParams.set("desktopCode", userCode);
  return url.toString();
}

/** 删除长期过期且未被使用的授权记录，避免公共创建接口无限增长。 */
async function cleanupExpiredAuthorizations(): Promise<void> {
  const retention = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await database.desktopAuthorization.deleteMany({ where: { expiresAt: { lt: retention } } });
}

/** 生成排除易混淆字符的八位用户码。 */
function randomUserCode(): string {
  const bytes = randomBytes(8);
  const compact = Array.from(bytes, (value) => USER_CODE_ALPHABET[value % USER_CODE_ALPHABET.length]).join("");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** 输出主站身份的最小公开字段。 */
function identityView(identity: ExternalIdentity): LocalPlatformSessionView["identity"] {
  const roles = Array.isArray(identity.roles) ? identity.roles.filter((role): role is "user" | "admin" => role === "user" || role === "admin") : [];
  return { issuer: identity.issuer, subject: identity.subject, displayName: identity.displayName, avatarUrl: identity.avatarUrl, roles: roles.length ? roles : ["user"], emailVerified: identity.emailVerified };
}

/** 从标准 Bearer 头读取独立平台会话。 */
function readBearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization?.trim() || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() || null : null;
}

/** 设备密钥只以固定 SHA-256 进入数据库。 */
function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }

class DesktopAuthError extends Error {
  /** 保存稳定 HTTP 状态和机器错误码，公开响应不包含数据库细节。 */
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

/** 把设备授权异常收敛为统一 API 错误。 */
function sendDesktopAuthError(response: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof DesktopAuthError) return sendError(response, error.status, error.code, error.message);
  if (error instanceof Error && error.name === "ZodError") return sendError(response, 400, "desktop_authorization_input_invalid", "设备授权请求参数不正确");
  sendError(response, 500, "desktop_authorization_failed", "设备授权处理失败");
}
