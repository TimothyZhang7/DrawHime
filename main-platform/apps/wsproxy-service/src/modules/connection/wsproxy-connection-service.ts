/** 本文件实现 wsproxy-service 的 OneBot WebSocket 连接管理和事件投递。 */
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { OneBotWsActionRequest, OneBotWsEvent, WsproxyClaimEndpointResponse } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed } from '@aiimage/core-utils';
import { claimWsproxyEndpoint, markWsproxyBotSeen, notifyBotOffline } from '../../infrastructure/http/backend-client.js';
import { dispatchOneBotEventToBotService } from '../../infrastructure/http/bot-service-client.js';
import type { OneBotConnection } from './connection-types.js';
import { createEventDedupService } from './event-dedup-service.js';
import { isIgnorableOneBotFrame, isOneBotActionResponse, normalizeOneBotWsEvent } from './onebot-message-validation.js';

/** wsproxy 连接服务公开能力，供应用装配层挂载 WebSocket 与状态路由。 */
export type WsproxyConnectionService = ReturnType<typeof createWsproxyConnectionService>;

/** 默认心跳间隔，真实环境保持克制，避免给 OneBot 协议端制造额外压力。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** 默认允许连续错过 2 个 pong，兼顾网络抖动和僵尸连接清理。 */
const DEFAULT_HEARTBEAT_MISSES = 2;

/** 未识别协议帧日志状态；限流避免协议端心跳/扩展字段造成 error 日志刷屏。 */
const unknownOneBotFrameLogState = {
  lastLoggedAt: 0,
  suppressed: 0,
};

/** 未识别协议帧日志最小间隔；真实业务事件已在校验层放行，这里只保留排障采样。 */
const UNKNOWN_ONEBOT_FRAME_LOG_INTERVAL_MS = 60_000;

/** 生成连接 id，只用于进程内追踪和投递关联，不写入数据库。 */
function createConnectionId() {
  return `onebot_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

/** 判断是否为 OneBot 生命周期 connect 事件（Bot 首次上线）。 */
function isLifecycleConnect(event: { post_type: string; meta_event_type?: string; sub_type?: string }): boolean {
  return event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle' && event.sub_type === 'connect';
}

/** 读取正整数环境变量，非法值回落默认值，避免错误配置关闭连接清理能力。 */
function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 只提取安全排障字段，不输出消息正文、图片 URL、token 或 raw payload。 */
function summarizeUnknownOneBotFrame(payload: unknown) {
  if (typeof payload !== 'object' || payload === null) return { type: typeof payload };
  const candidate = payload as Record<string, unknown>;
  return {
    postType: candidate.post_type,
    metaEventType: candidate.meta_event_type,
    messageType: candidate.message_type,
    noticeType: candidate.notice_type,
    requestType: candidate.request_type,
    status: candidate.status,
    retcode: candidate.retcode,
  };
}

/** 未知 OneBot 帧只做限流采样日志，避免不影响业务的协议扩展淹没真实错误。 */
function warnUnknownOneBotFrame(payload: unknown) {
  const now = Date.now();
  if (now - unknownOneBotFrameLogState.lastLoggedAt < UNKNOWN_ONEBOT_FRAME_LOG_INTERVAL_MS) {
    unknownOneBotFrameLogState.suppressed += 1;
    return;
  }
  const suppressed = unknownOneBotFrameLogState.suppressed;
  unknownOneBotFrameLogState.lastLoggedAt = now;
  unknownOneBotFrameLogState.suppressed = 0;
  console.warn('[wsproxy-service] ignored unknown onebot message', {
    frame: summarizeUnknownOneBotFrame(payload),
    suppressed,
  });
}

/** 从请求中读取 access token，兼容 URL 参数 / Bearer / Token 三种格式。 */
function readAccessToken(req: http.IncomingMessage) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const queryToken = url.searchParams.get('access_token')?.trim();
  if (queryToken) return queryToken;
  const authHeader = (req.headers.authorization ?? '').trim();
  if (!authHeader) return '';
  // Bearer <token>
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  // Token <token> (NapCatQQ WebSocket 反向模式)
  if (authHeader.startsWith('Token ')) return authHeader.slice(6).trim();
  // 纯 token（兜底）
  return authHeader;
}

/** 从 WebSocket 路径读取动态端点后缀。
 *  格式: /ws-bot/{pathSuffix}?access_token={token} */
function readWsBotPath(req: http.IncomingMessage) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  // 静态入口
  if (pathname === '/ws-bot') return { kind: 'static' as const };
  // 动态: /ws-bot/{suffix}
  const dynamicMatch = pathname.match(/^\/ws-bot\/([a-zA-Z0-9_-]{12,32})$/);
  if (dynamicMatch) return { kind: 'dynamic' as const, pathSuffix: dynamicMatch[1], accessToken: url.searchParams.get('access_token') ?? undefined };
  return undefined;
}

/** 校验 wsproxy WebSocket token；仅显式开发或测试环境允许缺省连接。 */
function verifyAccessToken(req: http.IncomingMessage) {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  return readAccessToken(req) === expectedToken;
}

/** 将 action 发送回协议端，发送前只做 JSON 序列化，不篡改业务字段。 */
function sendActionToConnection(connection: OneBotConnection, action: OneBotWsActionRequest) {
  if (connection.socket.readyState !== WebSocket.OPEN) return;
  connection.socket.send(JSON.stringify(action));
}

/** 同步 API 调用回调注册表：echo → { resolve, reject, timer } */
const actionCallbacks = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
let actionEchoSeq = 0;

/** 校验动态 wsproxy 端点，backend 只返回授权元数据，不暴露 token hash。 */
async function claimDynamicEndpoint(req: http.IncomingMessage, pathSuffix: string) {
  const accessToken = readAccessToken(req);
  if (!accessToken) throw new Error('动态 wsproxy 端点缺少 access_token');
  return claimWsproxyEndpoint({ pathSuffix, accessToken });
}

/** 创建 OneBot 连接服务，并把 /ws-bot upgrade 挂载到 HTTP server。 */
export function createWsproxyConnectionService() {
  const connections = new Map<string, OneBotConnection>();
  const eventDedupService = createEventDedupService();
  const server = new WebSocketServer({ noServer: true });
  const heartbeatIntervalMs = readPositiveIntegerEnv('WSPROXY_HEARTBEAT_INTERVAL_MS', DEFAULT_HEARTBEAT_INTERVAL_MS);
  const heartbeatMaxMisses = readPositiveIntegerEnv('WSPROXY_HEARTBEAT_MAX_MISSES', DEFAULT_HEARTBEAT_MISSES);
  const heartbeatTimer = setInterval(runHeartbeatCheck, heartbeatIntervalMs);
  heartbeatTimer.unref();

  /** 执行 WebSocket ping/pong 心跳检查，主动关闭长时间无 pong 的僵尸连接。 */
  function runHeartbeatCheck() {
    const now = Date.now();
    for (const connection of connections.values()) {
      if (connection.socket.readyState !== WebSocket.OPEN) {
        connections.delete(connection.id);
        if (connection.selfId) notifyBotOffline(connection.selfId);
        continue;
      }
      if (connection.waitingPong && now - connection.lastPongAt > heartbeatIntervalMs * heartbeatMaxMisses) {
        // 心跳超时必须主动关闭连接，避免状态接口继续展示已经不可用的协议端。
        console.warn('[wsproxy-service] onebot heartbeat timeout', { connectionId: connection.id, selfId: connection.selfId });
        connection.socket.terminate();
        connections.delete(connection.id);
        if (connection.selfId) notifyBotOffline(connection.selfId);
        continue;
      }
      connection.waitingPong = true;
      connection.socket.ping();
    }
  }

  /** 群内其他在线 Bot 发出的命令只交给发送方自身 message_sent 事件处理，避免多 Bot 抢占。 */
  function isMessageFromOtherConnectedBot(connection: OneBotConnection, event: OneBotWsEvent): boolean {
    if (event.post_type !== 'message' || event.message_type !== 'group' || event.self_triggered) return false;
    if (event.user_id === event.self_id) return false;
    return [...connections.values()].some((candidate) => candidate.id !== connection.id && candidate.selfId === event.user_id);
  }

  /** 处理 OneBot 上报事件，投递给 bot-service 后把 action 回写到当前连接。 */
  async function handleOneBotEvent(connection: OneBotConnection, event: OneBotWsEvent) {
    connection.selfId = event.self_id;
    connection.lastSeenAt = Date.now();
    if (connection.pathSuffix) {
      // self_id 只能从真实 OneBot 事件得到，收到后异步写入 backend 连接状态表。
      void markWsproxyBotSeen({ pathSuffix: connection.pathSuffix, selfId: event.self_id, ...(connection.botNickname ? { nickname: connection.botNickname } : {}) }).catch((error) => {
        console.error('[wsproxy-service] mark bot seen failed', error);
      });
    }

    // 生命周期 connect 事件：首次连接时获取 Bot 昵称
    if (isLifecycleConnect(event) && !connection.botNicknameFetched) {
      connection.botNicknameFetched = true;
      const echo = `login_info_${connection.id}`;
      sendActionToConnection(connection, { action: 'get_login_info', echo, params: {} });
    }
    if (isMessageFromOtherConnectedBot(connection, event)) {
      // 发送 Bot 的自身事件会进入同一业务路由；其他 Bot 连接保持静默，避免一条命令被多个账号执行。
      return;
    }
    const dedupResult = eventDedupService.markEvent(connection.id, event);
    if (dedupResult.duplicated) {
      // 重复事件或已被其他连接 claim 的群消息必须在 wsproxy 层截断，避免 bot-service 重复回复或后续绘图链路重复扣费。
      console.warn('[wsproxy-service] duplicated or claimed onebot event ignored', { key: dedupResult.key, ttlMs: dedupResult.ttlMs });
      return;
    }
    try {
      const actions = await dispatchOneBotEventToBotService({
        connectionId: connection.id,
        event,
      });
      for (const action of actions) {
        sendActionToConnection(connection, action);
      }
    } catch (error) {
      console.error('[wsproxy-service] dispatch event failed', error);
    }
  }

  /** 注册连接消息监听，区分事件上报、action 响应和无法识别的协议消息。 */
  function registerConnection(socket: WebSocket, endpointClaim?: WsproxyClaimEndpointResponse) {
    const connection: OneBotConnection = {
      id: createConnectionId(),
      endpointId: endpointClaim?.endpointId,
      endpointUserId: endpointClaim?.userId,
      pathSuffix: endpointClaim?.pathSuffix,
      socket,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      waitingPong: false,
    };
    connections.set(connection.id, connection);

    socket.on('pong', () => {
      connection.waitingPong = false;
      connection.lastPongAt = Date.now();
      connection.lastSeenAt = Date.now();
    });

    socket.on('message', (data) => {
      try {
        const payload: unknown = JSON.parse(data.toString());
        const event = normalizeOneBotWsEvent(payload);
        if (event) {
          void handleOneBotEvent(connection, event);
          return;
        }
        if (isOneBotActionResponse(payload)) {
          connection.lastSeenAt = Date.now();
          // 捕获 get_login_info 响应，提取昵称
          if (payload.echo && String(payload.echo).startsWith('login_info_') && payload.status === 'ok') {
            const data = payload.data as Record<string, unknown> | undefined;
            if (data?.nickname && typeof data.nickname === 'string') {
              connection.botNickname = data.nickname;
            }
          }
          // 匹配同步 API 调用回调（callApiOnConnection）
          if (payload.echo !== undefined) {
            const echoKey = String(payload.echo);
            const cb = actionCallbacks.get(echoKey);
            if (cb) {
              actionCallbacks.delete(echoKey);
              clearTimeout(cb.timer);
              if (payload.status === 'ok') {
                cb.resolve(payload.data);
              } else {
                cb.reject(new Error(payload.wording || payload.message || 'OneBot API call failed'));
              }
            }
          }
          return;
        }
        if (isIgnorableOneBotFrame(payload)) {
          const selfId = (payload as { self_id?: unknown }).self_id;
          if (typeof selfId === 'number') connection.selfId = selfId;
          // 心跳和 notice 类协议帧不属于命令事件，但能证明协议端仍在线。
          connection.lastSeenAt = Date.now();
          return;
        }
        warnUnknownOneBotFrame(payload);
      } catch (error) {
        console.error('[wsproxy-service] parse onebot message failed', error);
      }
    });

    socket.on('close', () => {
      connections.delete(connection.id);
      // 通知 backend Bot 已离线
      if (connection.selfId) notifyBotOffline(connection.selfId);
    });
    socket.on('error', (error) => {
      console.error('[wsproxy-service] onebot socket error', error);
      connections.delete(connection.id);
      if (connection.selfId) notifyBotOffline(connection.selfId);
    });
  }

  return {
    /** 返回当前进程内连接快照，避免外部拿到 WebSocket 实例。 */
    /** 向指定 selfId 的连接发送 action（bot-service 异步消息推送使用）。 */
    sendToConnectionBySelfId(selfId: number, action: OneBotWsActionRequest): boolean {
      for (const conn of connections.values()) {
        if (conn.selfId === selfId && conn.socket.readyState === WebSocket.OPEN) {
          sendActionToConnection(conn, action);
          return true;
        }
      }
      return false;
    },

    /** 向 OneBot 发送 API 调用并等待响应（同步语义，bot-service 查询引用消息等场景使用） */
    callApiOnConnection(selfId: number, action: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
      // 按 selfId 查找活跃连接
      let conn: OneBotConnection | undefined;
      for (const c of connections.values()) {
        if (c.selfId === selfId && c.socket.readyState === WebSocket.OPEN) { conn = c; break; }
      }
      if (!conn) throw new Error('Bot 不在线');
      const echo = `api_${++actionEchoSeq}_${Date.now()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          actionCallbacks.delete(echo);
          reject(new Error(`OneBot API ${action} 超时`));
        }, timeoutMs);
        actionCallbacks.set(echo, { resolve, reject, timer });
        sendActionToConnection(conn!, { action, params, echo });
      });
    },

    /** 断开指定 selfId 的所有活跃 WebSocket 连接（解绑时调用）。返回断开数量。 */
    disconnectBySelfId(selfId: number): number {
      let count = 0;
      for (const conn of connections.values()) {
        if (conn.selfId === selfId) {
          conn.socket.close(1000, '解绑断开');
          connections.delete(conn.id);
          count++;
        }
      }
      return count;
    },

    listConnections() {
      return [...connections.values()].map((connection) => ({
        connectionId: connection.id,
        selfId: connection.selfId,
        connectedAt: new Date(connection.connectedAt).toISOString(),
        lastSeenAt: new Date(connection.lastSeenAt).toISOString(),
        lastPongAt: new Date(connection.lastPongAt).toISOString(),
        uptimeSec: Math.floor((Date.now() - connection.connectedAt) / 1000),
        transport: 'websocket' as const,
        heartbeatWaitingPong: connection.waitingPong,
        heartbeatIntervalMs,
        heartbeatMaxMisses,
      }));
    },

    /** 将 WebSocket upgrade 接入现有 HTTP server，只接受 /ws-bot 路径。 */
    attach(httpServer: http.Server) {
      httpServer.on('close', () => {
        clearInterval(heartbeatTimer);
      });
      httpServer.on('upgrade', (req, socket, head) => {
        void handleUpgrade(req, socket, head);
      });
    },
  };

  /** 处理 HTTP upgrade；动态端点会先请求 backend 校验 token，再建立 WebSocket。 */
  async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const pathInfo = readWsBotPath(req);
    if (!pathInfo) {
      socket.destroy();
      return;
    }
    try {
      const endpointClaim = pathInfo.kind === 'dynamic'
        ? await claimWsproxyEndpoint({ pathSuffix: pathInfo.pathSuffix, accessToken: pathInfo.accessToken || readAccessToken(req) || '' })
        : undefined;
      if (pathInfo.kind === 'static' && !verifyAccessToken(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      server.handleUpgrade(req, socket, head, (webSocket) => {
        registerConnection(webSocket, endpointClaim);
        server.emit('connection', webSocket, req);
      });
    } catch (error) {
      console.error('[wsproxy-service] websocket auth failed', error);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  }
}
