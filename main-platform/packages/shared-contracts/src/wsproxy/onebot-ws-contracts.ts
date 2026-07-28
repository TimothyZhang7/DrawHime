/** 本文件定义 OneBot WebSocket 模拟端与 wsproxy/Bot 链路共享的协议类型。 */

/** OneBot v11 消息段，允许文本、图片、回复、@ 等标准段和后续扩展段。 */
export type OneBotWsMessageSegment = {
  type: string;
  data: Record<string, string | number | boolean>;
};

/** OneBot 私聊消息事件，用于模拟用户私聊 Bot 发送命令。 */
export type OneBotWsPrivateMessageEvent = {
  time: number;
  self_id: number;
  post_type: 'message';
  message_type: 'private';
  sub_type: 'friend' | 'group' | 'other';
  message_id: number;
  user_id: number;
  /** 事件是否由 wsproxy 从协议端 message_sent 规范化而来。 */
  self_triggered?: boolean;
  /** 自触发私聊的原始接收方 QQ；回复动作继续发回该私聊会话。 */
  target_user_id?: number;
  message: OneBotWsMessageSegment[];
  raw_message: string;
  font: number;
  sender: {
    user_id: number;
    nickname: string;
    sex: 'male' | 'female' | 'unknown';
    age: number;
  };
};

/** OneBot 群消息事件，用于模拟群内命令、@Bot 命令和引用消息场景。 */
export type OneBotWsGroupMessageEvent = {
  time: number;
  self_id: number;
  post_type: 'message';
  message_type: 'group';
  sub_type: 'normal' | 'anonymous' | 'notice';
  message_id: number;
  group_id: number;
  user_id: number;
  /** 事件是否由 wsproxy 从协议端 message_sent 规范化而来。 */
  self_triggered?: boolean;
  message: OneBotWsMessageSegment[];
  raw_message: string;
  font: number;
  sender: {
    user_id: number;
    nickname: string;
    card: string;
    role: 'owner' | 'admin' | 'member';
  };
};

/** OneBot 好友请求事件，用于 wsproxy 把加好友申请投递给 bot-service 自动审批。 */
export type OneBotWsFriendRequestEvent = {
  time: number;
  self_id: number;
  post_type: 'request';
  request_type: 'friend';
  user_id: number;
  comment?: string;
  flag: string;
};

/** OneBot 群请求事件，用于自动同意加群申请和邀请 Bot 入群。 */
export type OneBotWsGroupRequestEvent = {
  time: number;
  self_id: number;
  post_type: 'request';
  request_type: 'group';
  sub_type: string;
  group_id: number;
  user_id: number;
  comment?: string;
  flag: string;
};

/** OneBot 请求事件联合类型，当前覆盖好友请求、加群申请和邀请入群。 */
export type OneBotWsRequestEvent = OneBotWsFriendRequestEvent | OneBotWsGroupRequestEvent;

/** OneBot 生命周期事件，用于模拟客户端连接、启用和禁用状态。 */
export type OneBotWsLifecycleEvent = {
  time: number;
  self_id: number;
  post_type: 'meta_event';
  meta_event_type: 'lifecycle';
  sub_type: 'connect' | 'enable' | 'disable';
};

/** OneBot 上报事件联合类型，覆盖模拟端当前可构造的真实事件。 */
export type OneBotWsEvent = OneBotWsPrivateMessageEvent | OneBotWsGroupMessageEvent | OneBotWsLifecycleEvent | OneBotWsRequestEvent;

/** OneBot 动作请求，表示 wsproxy/Bot 链路要求协议端执行的 API。 */
export type OneBotWsActionRequest = {
  action: string;
  params?: Record<string, unknown>;
  echo?: string | number;
};

/** OneBot 动作响应，表示模拟端对动作请求的回包。 */
export type OneBotWsActionResponse = {
  status: 'ok' | 'failed';
  retcode: number;
  data: unknown;
  message?: string;
  wording?: string;
  echo?: string | number;
};

/** bot-service 请求 wsproxy-service 代调 OneBot API 的内部请求体。 */
export type WsproxyCallApiRequest = {
  /** 目标 OneBot 自身 QQ/标识。 */
  selfId: number;
  /** OneBot API 名称，例如 get_msg、get_image。 */
  action: string;
  /** OneBot API 参数，按协议端原样透传。 */
  params?: Record<string, unknown>;
  /** 可选等待超时毫秒；图片解析类 API 可传更长时间。 */
  timeoutMs?: number;
};

/** wsproxy-service 代调 OneBot API 后返回给 bot-service 的内部响应体。 */
export type WsproxyCallApiResponse = {
  /** OneBot API 原始 data，结构由具体 action 决定。 */
  data: unknown;
};

/** wsproxy-service 投递给 bot-service 的 OneBot 事件请求体。 */
export type WsproxyDispatchEventRequest = {
  connectionId: string;
  event: OneBotWsEvent;
};

/** bot-service 处理 OneBot 事件后返回给 wsproxy-service 的动作列表。 */
export type WsproxyDispatchEventResponse = {
  accepted: true;
  actions: OneBotWsActionRequest[];
};

/** wsproxy-service 当前进程内的 OneBot WebSocket 连接摘要。 */
export type WsproxyConnectionSummary = {
  /** 当前 WebSocket 连接追踪 id，只用于进程内诊断和动作回写关联。 */
  connectionId: string;
  /** OneBot 协议端上报的自身 QQ/标识，尚未收到事件时为空。 */
  selfId?: number;
  /** WebSocket 建连时间，使用 ISO 字符串便于跨服务展示。 */
  connectedAt: string;
  /** 最近收到 OneBot 事件、action 响应或 pong 的时间。 */
  lastSeenAt: string;
  /** 最近收到 WebSocket pong 的时间，用于识别心跳是否正常。 */
  lastPongAt: string;
  /** 当前连接已在线秒数，由 wsproxy-service 实时计算。 */
  uptimeSec: number;
  /** 当前连接传输协议，当前只支持 WebSocket。 */
  transport: 'websocket';
  /** 是否已经发送 ping 并正在等待下一次 pong。 */
  heartbeatWaitingPong: boolean;
  /** wsproxy-service 当前使用的心跳检查间隔毫秒数。 */
  heartbeatIntervalMs: number;
  /** 连续漏 pong 的最大周期数，超过后 wsproxy-service 会主动断开连接。 */
  heartbeatMaxMisses: number;
};

/** 查询当前 wsproxy 在线 Bot 连接列表的数据体。 */
export type WsproxyBotsResponse = {
  items: WsproxyConnectionSummary[];
  total: number;
};

/** bot-service 基础运行状态数据体，用于后台和本地诊断。 */
export type BotServiceStatusData = {
  service: 'bot-service';
  version: string;
  uptimeSec: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  eventStats: {
    received: number;
    ignored: number;
    actionsCreated: number;
  };
  supportedCommands: string[];
};
