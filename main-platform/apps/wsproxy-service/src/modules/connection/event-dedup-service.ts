/** 本文件负责 wsproxy-service 进程内 OneBot 事件去重，避免协议端重复上报导致 Bot 重复回复。 */
import type { OneBotWsEvent } from '@aiimage/shared-contracts';

/** 私聊消息按 message_id 做短窗口去重，贴近 OneBot 协议端重复上报场景。 */
const PRIVATE_MESSAGE_DEDUP_TTL_MS = 30_000;

/** 群聊消息在 wsproxy 层只拦截同一连接的重复上报，跨 Bot 抢占交给 bot-service。 */
const GROUP_MESSAGE_DEDUP_TTL_MS = 30_000;

/** 元事件按事件类型做短窗口去重，避免连接生命周期事件抖动反复触发下游。 */
const META_EVENT_DEDUP_TTL_MS = 10_000;

/** 去重和 claim 判断结果，调用方据此决定是否继续投递事件。 */
export type EventDedupResult = {
  duplicated: boolean;
  key: string;
  ttlMs: number;
};

/** 判断 OneBot 请求事件是否可去重处理。 */
function isRequestEvent(event: OneBotWsEvent): event is Extract<OneBotWsEvent, { post_type: 'request' }> {
  return event.post_type === 'request';
}

/** 根据 OneBot 事件构造去重 key 和 TTL。 */
function createDedupIdentity(connectionId: string, event: OneBotWsEvent) {
  if (event.post_type === 'message' && event.message_type === 'private') {
    return {
      key: `private:${connectionId}:${event.self_id}:${event.user_id}:${event.message_id}`,
      ttlMs: PRIVATE_MESSAGE_DEDUP_TTL_MS,
    };
  }

  if (event.post_type === 'message' && event.message_type === 'group') {
    return {
      key: `group:${connectionId}:${event.self_id}:${event.group_id}:${event.user_id}:${event.message_id}`,
      ttlMs: GROUP_MESSAGE_DEDUP_TTL_MS,
    };
  }

  if (isRequestEvent(event)) {
    // 请求事件按 flag 去重，避免协议端重发时反复审批同一个好友或群申请。
    return {
      key: `request:${event.self_id}:${event.request_type}:${event.flag}`,
      ttlMs: META_EVENT_DEDUP_TTL_MS,
    };
  }

  const metaEvent = event as Extract<OneBotWsEvent, { post_type: 'meta_event' }>;
  return {
    key: `meta:${connectionId}:${metaEvent.self_id}:${metaEvent.meta_event_type}:${metaEvent.sub_type}`,
    ttlMs: META_EVENT_DEDUP_TTL_MS,
  };
}

/** 创建进程内事件去重和 claim 服务，后续接入 Redis 时可保持调用语义不变。 */
export function createEventDedupService() {
  const expiresAtByKey = new Map<string, number>();

  /** 清理过期去重 key，避免长期运行时内存无限增长。 */
  function pruneExpired(now: number) {
    for (const [key, expiresAt] of expiresAtByKey.entries()) {
      if (expiresAt <= now) {
        expiresAtByKey.delete(key);
      }
    }
  }

  return {
    /** 标记事件并返回是否重复；重复或被其他 Bot claim 的事件不会刷新 TTL，避免抖动事件长期占用 key。 */
    markEvent(connectionId: string, event: OneBotWsEvent): EventDedupResult {
      const now = Date.now();
      pruneExpired(now);
      const identity = createDedupIdentity(connectionId, event);
      const existingExpiresAt = expiresAtByKey.get(identity.key);
      if (existingExpiresAt && existingExpiresAt > now) {
        // 命中去重时返回 true，调用方必须停止投递，防止 Bot 重复执行命令。
        return { duplicated: true, key: identity.key, ttlMs: identity.ttlMs };
      }
      expiresAtByKey.set(identity.key, now + identity.ttlMs);
      return { duplicated: false, key: identity.key, ttlMs: identity.ttlMs };
    },
  };
}
