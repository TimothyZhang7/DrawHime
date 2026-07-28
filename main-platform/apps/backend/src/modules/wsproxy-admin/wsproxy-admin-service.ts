/** 本文件实现 backend 的 wsproxy 端点管理、token 哈希校验和 Bot 活跃登记用例。 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  WsproxyClaimEndpointResponse,
  WsproxyCreateEndpointResponse,
  WsproxyEndpointView,
  WsproxyMarkBotSeenResponse,
  WsproxyMyEndpointResponse,
} from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { WsproxyAdminRepository } from './wsproxy-admin-repository.js';

const ENDPOINT_TTL_MS = 30 * 60 * 1000;

/** wsproxy 管理服务负责生成端点、校验 token 和维护 Bot 连接状态。 */
export class WsproxyAdminService {
  private readonly repository = new WsproxyAdminRepository(getPrismaClient());

  /** 为登录用户创建动态 wsproxy 端点，明文 token 只随本次结果返回。 */
  async createEndpoint(userId: number): Promise<WsproxyCreateEndpointResponse> {
    const pathSuffix = randomUrlSafeToken(12);
    const accessToken = randomUrlSafeToken(32);
    const expiresAt = new Date(Date.now() + ENDPOINT_TTL_MS);
    const endpoint = await this.repository.createEndpoint({
      userId,
      pathSuffix,
      tokenHash: hashSecret(accessToken),
      expiresAt,
    });
    const endpointView = mapEndpointView(endpoint);
    return {
      endpoint: endpointView,
      accessToken,
      websocketUrl: endpointView.websocketUrl,
    };
  }

  /** 查询用户最近创建的端点，不返回 token 明文或 hash。 */
  async getMyEndpoint(userId: number): Promise<WsproxyMyEndpointResponse> {
    const endpoint = await this.repository.findLatestEndpointByUserId(userId);
    return { endpoint: endpoint ? mapEndpointView(endpoint) : null };
  }

  /** 校验 wsproxy-service 的动态端点 claim 请求，成功后标记端点已使用。 */
  async claimEndpoint(pathSuffix: string, accessToken: string): Promise<WsproxyClaimEndpointResponse> {
    const endpoint = await this.repository.findEndpointForClaim(pathSuffix);
    if (!endpoint) throw new Error('wsproxy 端点不存在');
    // 未使用端点必须在过期前完成首次连接；已使用端点允许后续重连。
    if (!endpoint.used && endpoint.expiresAt.getTime() < Date.now()) {
      throw new Error('wsproxy 端点已过期');
    }
    if (!safeCompareHash(hashSecret(accessToken), endpoint.tokenHash)) {
      throw new Error('wsproxy 端点 token 不正确');
    }
    await this.repository.markEndpointUsed(endpoint.id);
    return {
      accepted: true,
      endpointId: endpoint.id,
      userId: endpoint.userId,
      pathSuffix: endpoint.pathSuffix,
    };
  }

  /** 登记 Bot self_id 活跃状态，并把动态端点绑定到首次出现的 self_id。 */
  async markBotSeen(pathSuffix: string | undefined, selfId: number, nickname?: string): Promise<WsproxyMarkBotSeenResponse> {
    return this.repository.markBotSeen({
      pathSuffix,
      selfId: BigInt(selfId),
      nickname,
    });
  }
}

/** 生成 URL 安全随机字符串，用于路径后缀和一次性明文 token。 */
function randomUrlSafeToken(byteLength: number) {
  return randomBytes(byteLength).toString('base64url');
}

/** 对 token 做 SHA-256 哈希，数据库只保存哈希值。 */
function hashSecret(secret: string) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 使用 timingSafeEqual 比较哈希，避免 token 校验出现明显时序差异。 */
function safeCompareHash(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** 把数据库端点记录转换为用户可见 DTO，明确排除 tokenHash。 */
function mapEndpointView(endpoint: {
  id: number;
  pathSuffix: string;
  expiresAt: Date;
  used: boolean;
  usedBySelfId: bigint | null;
  createdAt: Date;
}): WsproxyEndpointView {
  const websocketUrl = `${readWsproxyPublicBaseUrl()}/ws-bot/${endpoint.pathSuffix}`;
  return {
    id: endpoint.id,
    pathSuffix: endpoint.pathSuffix,
    websocketUrl,
    expiresAt: formatChinaDateTime(endpoint.expiresAt),
    used: endpoint.used,
    usedBySelfId: endpoint.usedBySelfId?.toString(),
    createdAt: formatChinaDateTime(endpoint.createdAt),
  };
}

/** 读取 wsproxy 对外 WebSocket 基础地址；本地默认指向 wsproxy-service 端口。 */
function readWsproxyPublicBaseUrl() {
  const fallbackPort = process.env.WSPROXY_PORT || '3011';
  const raw = process.env.WSPROXY_PUBLIC_WS_URL || `ws://localhost:${fallbackPort}`;
  return raw.replace(/\/+$/, '');
}

/** 将 Date 格式化为中国时区 ISO 字符串，满足 接口时间格式约束。 */
function formatChinaDateTime(date: Date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}
