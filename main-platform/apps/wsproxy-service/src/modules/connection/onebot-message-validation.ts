/** 本文件提供 wsproxy-service 对 OneBot WebSocket 消息的运行时识别。 */
import type { OneBotWsActionResponse, OneBotWsEvent } from '@aiimage/shared-contracts';

/** 规范化 OneBot 上报事件；协议端自身消息 message_sent 会转换成标准 message 事件。 */
export function normalizeOneBotWsEvent(value: unknown): OneBotWsEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.post_type === 'message_sent') {
    return normalizeSelfSentMessage(candidate);
  }
  if (candidate.post_type === 'meta_event') {
    return candidate.meta_event_type === 'lifecycle' && typeof candidate.self_id === 'number'
      ? candidate as unknown as OneBotWsEvent
      : null;
  }
  if (candidate.post_type === 'message') {
    return isMessageShape(candidate)
      ? candidate as unknown as OneBotWsEvent
      : null;
  }
  if (candidate.post_type === 'request') {
    // OneBot 请求事件必须放行到 bot-service，由业务层决定好友/群请求是否自动审批。
    if (typeof candidate.self_id !== 'number' || typeof candidate.user_id !== 'number' || typeof candidate.flag !== 'string') {
      return null;
    }
    if (candidate.request_type === 'friend') return candidate as unknown as OneBotWsEvent;
    if (candidate.request_type === 'group') {
      return typeof candidate.group_id === 'number' && typeof candidate.sub_type === 'string' && candidate.sub_type.length > 0
        ? candidate as unknown as OneBotWsEvent
        : null;
    }
  }
  return null;
}

/** 判断消息是否为 OneBot 上报事件，供只需要布尔判定的调用方兼容使用。 */
export function isOneBotWsEvent(value: unknown): value is OneBotWsEvent {
  return normalizeOneBotWsEvent(value) !== null;
}

/** 校验普通消息和自身已发送消息共同需要的最小字段。 */
function isMessageShape(candidate: Record<string, unknown>): boolean {
  return typeof candidate.self_id === 'number'
      && typeof candidate.message_id === 'number'
      && typeof candidate.user_id === 'number'
      && Array.isArray(candidate.message)
      && (candidate.message_type === 'private' || (candidate.message_type === 'group' && typeof candidate.group_id === 'number'));
}

/** 把协议端自身已发送事件转换为 bot-service 已登记的标准消息契约。 */
function normalizeSelfSentMessage(candidate: Record<string, unknown>): OneBotWsEvent | null {
  if (!isMessageShape(candidate) || typeof candidate.self_id !== 'number') return null;
  const selfId = candidate.self_id;
  const sender = typeof candidate.sender === 'object' && candidate.sender !== null
    ? candidate.sender as Record<string, unknown>
    : {};
  const normalized: Record<string, unknown> = {
    ...candidate,
    post_type: 'message',
    user_id: selfId,
    self_triggered: true,
    sender: { ...sender, user_id: selfId },
    raw_message: typeof candidate.raw_message === 'string' ? candidate.raw_message : readRawMessage(candidate.message),
  };
  if (candidate.message_type === 'private') {
    normalized.target_user_id = readSelfSentPrivateTarget(candidate, selfId);
  }
  return normalized as unknown as OneBotWsEvent;
}

/** 读取自身私聊消息原接收方，兼容 NapCat 常见 target_id 和 user_id 字段。 */
function readSelfSentPrivateTarget(candidate: Record<string, unknown>, selfId: number): number {
  const values = [candidate.target_user_id, candidate.target_id, candidate.user_id];
  const target = values.find((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value !== selfId);
  return typeof target === 'number' ? target : selfId;
}

/** 在协议端缺少 raw_message 时从文本段恢复命令文本，只用于命令解析。 */
function readRawMessage(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((segment) => typeof segment === 'object' && segment !== null && (segment as { type?: unknown }).type === 'text')
    .map((segment) => String((segment as { data?: { text?: unknown } }).data?.text ?? ''))
    .join('');
}

/** 判断消息是否为 OneBot action 响应；当前阶段只记录，不进入命令处理。 */
export function isOneBotActionResponse(value: unknown): value is OneBotWsActionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.status === 'ok' || candidate.status === 'failed') && typeof candidate.retcode === 'number';
}

/** 判断 OneBot 协议端的非业务帧；这些帧只刷新连接活性，不进入 Bot 命令链路。 */
export function isIgnorableOneBotFrame(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.self_id !== 'number') return false;

  if (candidate.post_type === 'meta_event') {
    return candidate.meta_event_type === 'heartbeat';
  }

  if (candidate.post_type === 'notice') {
    return true;
  }

  return false;
}
