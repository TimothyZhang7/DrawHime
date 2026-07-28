/** 本文件定义 wsproxy-service 连接模块内部状态类型。 */
import type { WebSocket } from 'ws';

/** OneBot 客户端连接状态，只保存在当前进程内。 */
export type OneBotConnection = {
  id: string;
  endpointId?: number;
  endpointUserId?: number;
  pathSuffix?: string;
  selfId?: number;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  lastPongAt: number;
  waitingPong: boolean;
  /** Bot 昵称（通过 get_login_info 获取） */
  botNickname?: string;
  /** 是否已请求过昵称 */
  botNicknameFetched?: boolean;
};
