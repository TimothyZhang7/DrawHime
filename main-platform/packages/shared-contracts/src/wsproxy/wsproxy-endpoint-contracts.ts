/** 本文件定义 wsproxy 用户端点、动态端点校验和 Bot 活跃登记的共享契约。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';

/** 用户可见的 wsproxy 端点摘要；禁止包含 access token 明文或 token hash。 */
export type WsproxyEndpointView = {
  id: number;
  pathSuffix: string;
  websocketUrl: string;
  expiresAt: string;
  used: boolean;
  usedBySelfId?: string;
  createdAt: string;
};

/** 创建 wsproxy 端点响应；accessToken 明文只允许在创建接口返回一次。 */
export type WsproxyCreateEndpointResponse = {
  endpoint: WsproxyEndpointView;
  accessToken: string;
  /** wss://wsbot.xanime.ink/ws-bot/{pathSuffix}（不含 access_token，需在 NapCat 中单独填入） */
  websocketUrl: string;
};

/** 当前用户最近 wsproxy 端点查询响应；没有端点时 endpoint 为 null。 */
export type WsproxyMyEndpointResponse = {
  endpoint: WsproxyEndpointView | null;
};

/** wsproxy-service 建连时向 backend 校验动态端点的请求体。 */
export type WsproxyClaimEndpointRequest = {
  pathSuffix: string;
  accessToken: string;
};

/** backend 校验动态端点成功后返回给 wsproxy-service 的授权结果。 */
export type WsproxyClaimEndpointResponse = {
  accepted: true;
  endpointId: number;
  userId: number;
  pathSuffix: string;
};

/** wsproxy-service 收到 OneBot self_id 后向 backend 登记活跃状态的请求体。 */
export type WsproxyMarkBotSeenRequest = {
  pathSuffix?: string;
  selfId: number;
  /** Bot 昵称（可选，wsproxy 通过 get_login_info 获取后传入） */
  nickname?: string;
};

/** Bot 活跃状态登记成功响应。 */
export type WsproxyMarkBotSeenResponse = {
  accepted: true;
};

/** 创建 wsproxy 端点端点契约，禁止业务程序重新定义请求或响应形状。 */
export type WsproxyCreateEndpointEndpoint = ApiEndpointContract<undefined, ApiDataResponse<WsproxyCreateEndpointResponse>>;

/** 查询当前用户 wsproxy 端点端点契约。 */
export type WsproxyMyEndpointEndpoint = ApiEndpointContract<undefined, ApiDataResponse<WsproxyMyEndpointResponse>>;

/** 动态端点 claim 内部端点契约。 */
export type WsproxyClaimEndpointEndpoint = ApiEndpointContract<WsproxyClaimEndpointRequest, ApiDataResponse<WsproxyClaimEndpointResponse>>;

/** Bot 活跃登记内部端点契约。 */
export type WsproxyMarkBotSeenEndpoint = ApiEndpointContract<WsproxyMarkBotSeenRequest, ApiDataResponse<WsproxyMarkBotSeenResponse>>;
