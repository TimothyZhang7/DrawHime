/** 本文件负责处理 wsproxy-service 投递来的 OneBot 事件，并生成需要回写协议端的动作。 */
import type { BotBatchNotificationClaimResponse, BotBatchResultResponse, BotCommandConfig, BotDeliveryTarget, BotFinalizingTaskRecoveryResponse, BotGenerationCreateRequest, BotGenerationRetryRequest, BotGenerationRetryResponse, BotGenerationTaskListResponse, BotPendingBatchResultsResponse, DrawingAspectRatio, DrawingMode, DrawingRuntimeConfigResponse, DrawingVideoResolution, HealthResponse, ImageReverseExtractOptions, ImageReverseExtractResponse, ImageReverseMode, ImageReverseTagResultView, ImageUpscaleRunResponse, ImageUpscaleScale, LocalPlatformBotCatalogResponse, LocalPlatformBotJobCreateRequest, OneBotWsActionRequest, OneBotWsEvent, OneBotWsMessageSegment, PublicStatusResponse, WsproxyConnectionSummary } from '@aiimage/shared-contracts';
import { summarizeGenerationFailure } from '@aiimage/core-utils';
import { queryBackendHealth, queryBotAdminRuntimeConfigByBackend, queryBotGenerationStatsByBackend, queryQqBalanceByBackend, redeemRechargeCardByBackend, touchQqAccountByBackend, verifyQqBindingByBackend } from '../../infrastructure/http/backend-client.js';
import { queryDrawingServiceHealth } from '../../infrastructure/http/drawing-client.js';
import { queryWsproxyBots } from '../../infrastructure/http/wsproxy-client.js';
import { extractImageUrlsFromEvent } from './qq-reference-image-service.js';
import { localizeReferenceImagesForGeneration } from './bot-reference-localizer.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 运行时常量，优先从环境变量读取 */
const BOT_NAME = process.env.BOT_NAME ?? 'DrawHime-Bot';
const DEFAULT_MODEL = process.env.BOT_DEFAULT_MODEL ?? '';
const TASK_POLL_INTERVAL_MS = Number(process.env.BOT_TASK_POLL_MS ?? '1500');
/** Bot 最终通知保留时间；生产上游可能超过 5 分钟，默认保留 30 分钟用于重启和 wsproxy 重连补发。 */
const TASK_MAX_WAIT_MS = Number(process.env.BOT_TASK_MAX_WAIT_MS ?? String(30 * 60 * 1000));
/** 单次任务轮询查询 ID 数量上限；避免 pending 任务很多时 GET URL 过长。 */
const parsedTaskPollQueryChunkSize = Number(process.env.BOT_TASK_POLL_QUERY_CHUNK_SIZE ?? '30');
const TASK_POLL_QUERY_CHUNK_SIZE = Number.isFinite(parsedTaskPollQueryChunkSize) ? Math.max(1, Math.floor(parsedTaskPollQueryChunkSize)) : 30;
const DEDUP_WINDOW_MS = Number(process.env.BOT_DEDUP_WINDOW_MS ?? '60000');
const DEDUP_PRIVATE_WINDOW_MS = Number(process.env.BOT_DEDUP_PRIVATE_MS ?? '30000');
/** 群聊多 Bot 抢占窗口只覆盖同一消息的并发投递，不能扩展成用户命令冷却。 */
const GROUP_COMMAND_CLAIM_WINDOW_MS = Number(process.env.BOT_GROUP_COMMAND_CLAIM_MS ?? '1200');
const MAX_LOG_SIZE = Number(process.env.BOT_MAX_LOG_SIZE ?? '200');
/** Bot 卡片渲染等待上限；renderer 已有内部超时，这里保留更大余量，避免高 CPU 时误回退文本。 */
const BOT_RENDER_TIMEOUT_MS = Number(process.env.BOT_RENDER_TIMEOUT_MS ?? '25000');
/** Bot 提交绘图任务的等待时间必须短于 wsproxy 事件投递总超时，给文字回执预留时间。 */
/** 视频分镜会在 backend 建任务前执行真实多模态调用，Bot 提交窗口必须覆盖该前置阶段。 */
const BOT_GENERATE_SUBMIT_TIMEOUT_MS = Number(process.env.BOT_GENERATE_SUBMIT_TIMEOUT_MS ?? '90000');
/** Bot 图片提取等待上限；反推是同步命令但不返回“已提交”，需要给真实识图调用留足时间。 */
const BOT_REVERSE_EXTRACT_TIMEOUT_MS = Number(process.env.BOT_REVERSE_EXTRACT_TIMEOUT_MS ?? '90000');
/** Bot 图片放大等待上限；GPU 推理走同步工具命令，需要覆盖常见 2x/4x 小图耗时。 */
const BOT_IMAGE_UPSCALE_TIMEOUT_MS = Number(process.env.BOT_IMAGE_UPSCALE_TIMEOUT_MS ?? '180000');
/** Bot 最终原图使用 base64 兜底发送时的最大体积；超过后继续保留链接，避免 OneBot 大包失败。 */
const BOT_FINAL_IMAGE_BASE64_MAX_BYTES = Number(process.env.BOT_FINAL_IMAGE_BASE64_MAX_BYTES ?? String(5 * 1024 * 1024));
/** Bot 放大结果转 base64 的最大体积；超过后改用 URL 图片段，避免 QQ 协议端拒收超大 base64。 */
const BOT_UPSCALE_RESULT_BASE64_MAX_BYTES = Number(process.env.BOT_UPSCALE_RESULT_BASE64_MAX_BYTES ?? String(4 * 1024 * 1024));
/** Bot 文本降级消息状态符号；QQ 纯文本不支持富文本颜色，使用彩色圆点表达状态。 */
const BOT_TEXT_MARK = {
  success: '🟢',
  failed: '🔴',
  submitted: '🔵',
} as const;
/** Bot 命令前缀 — 唯一来源：DB system_configs.bot_cmd_prefix，启动时从 backend 拉取，之后每 60s 刷新 */
let CMD = '#';
/** 正则安全转义命令前缀 */
let CMDR = '#';
/** QQ 管理员白名单由 backend 内部配置下发，余额管理命令必须命中该列表。 */
let botAdminQqNumbers = new Set<string>();
function updateCmdPrefix(prefix: string) {
  CMD = prefix || '#';
  CMDR = CMD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 给文本提示第一行添加状态色圆点，保持原有字段格式不变。 */
function markBotText(kind: keyof typeof BOT_TEXT_MARK, text: string): string {
  return `${BOT_TEXT_MARK[kind]}${text}`;
}

/** 格式化 Bot 文本里的金额，统一保留两位小数，避免 QQ 端余额显示成 0.6/0.8。 */
function formatBotMoney(value: string | number | undefined | null): string {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

/** 格式化 Bot 文本里的余额摘要，按用户要求展示为 总额（免费/付费）。 */
function formatBotBalanceText(freeBalance: string | number | undefined, paidBalance: string | number | undefined): string {
  const free = Number(formatBotMoney(freeBalance));
  const paid = Number(formatBotMoney(paidBalance));
  return `¥${(free + paid).toFixed(2)}（${free.toFixed(2)}/${paid.toFixed(2)}）`;
}

/** 格式化 Bot 简洁余额；最终消息尽量短，但仍保留免费/付费拆分。 */
function formatBotCompactBalanceText(freeBalance: string | number | undefined, paidBalance: string | number | undefined): string {
  const free = Number(formatBotMoney(freeBalance));
  const paid = Number(formatBotMoney(paidBalance));
  return `¥${(free + paid).toFixed(2)}(${free.toFixed(2)}/${paid.toFixed(2)})`;
}

/** 格式化 Bot 提交消息中的图片数量链路，明确参考图数量和本轮请求生成张数。 */
function formatBotSubmitImageFlow(refCount: number, requestedCount: number): string {
  return `图: 参${Math.max(0, refCount)} -> 生${Math.max(1, requestedCount)}`;
}

/** 格式化 Bot 视频提交链路，视频模型固定单结果。 */
function formatBotSubmitVideoFlow(refCount: number): string {
  return `视频: 参${Math.max(0, refCount)} -> 生1`;
}

/** 格式化 Bot 最终消息中的图片结果，避免展示提示词，同时保留成功数/请求数。 */
function formatBotFinalImageFlow(refCount: number, successCount: number, requestedCount: number): string {
  return `图: 参${Math.max(0, refCount)} -> 成${Math.max(0, successCount)}/${Math.max(1, requestedCount)}`;
}

/** 格式化 Bot 视频最终结果链路。 */
function formatBotFinalVideoFlow(refCount: number): string {
  return `视频: 参${Math.max(0, refCount)} -> 成1/1`;
}

/** 归纳 Bot 批次的最终失败原因；只提取真实失败任务的错误，避免把成功或重试噪声算进去。 */
function summarizeBotBatchFailure(batch: BotBatchResultResponse): string {
  const failedTasks = batch.tasks.filter((task) => task.status === 'failed');
  const subTasks = failedTasks.map((task) => ({
    kind: 'upstream_attempt',
    status: 'failed',
    error: task.error ?? null,
  }));
  return summarizeGenerationFailure({
    taskError: failedTasks.find((task) => task.error)?.error ?? batch.tasks.find((task) => task.error)?.error ?? batch.status,
    mode: batch.mode,
    subTasks,
  });
}

/** 格式化 Bot 文本里的扣费字段，真实是否扣费仍以 backend 返回为准。 */
function formatBotChargeText(charged: boolean, chargedAmount: string | number | undefined): string {
  return charged ? `¥${formatBotMoney(chargedAmount)}` : '免费';
}

/** QQ → 网页绑定信息缓存 */
const bindingCache = new Map<string, { username: string; userId: number }>();
/** 通用 Map 容量限制（防 1000 Bot * 100 用户 碰撞导致内存泄漏） */
const MAX_MAP_SIZE = 10_000;
function safeMapSet(map: Map<string, unknown>, key: string, value: unknown) {
  if (map.size >= MAX_MAP_SIZE) {
    // 随机淘汰 10%（近似 LRU 在无顺序信息下的退化）
    const keys = [...map.keys()].slice(0, Math.ceil(map.size * 0.1));
    keys.forEach(k => map.delete(k));
  }
  map.set(key, value);
}

/** 缓存绑定信息（backend 返回绑定时调用） */
function cacheBinding(qq: string, binding?: { username?: string | null; userId?: number | null } | null) {
  if (binding?.username) bindingCache.set(qq, { username: binding.username, userId: binding.userId ?? 0 });
}

/** 构建卡片 submitter 数据 — QQ 头像/昵称/QQ号/绑定信息 */
/** QQ 触达建档缓存时间；避免群聊高频消息反复打 backend。 */
const QQ_TOUCH_TTL_MS = Number(process.env.BOT_QQ_TOUCH_TTL_MS ?? String(10 * 60 * 1000));
/** 已成功触达的 QQ 缓存，key 为用户 QQ，value 为登记时间。 */
const touchedQqMap = new Map<string, number>();
/** 正在登记的 QQ 集合，防止同一用户并发消息造成重复 upsert。 */
const touchingQqSet = new Set<string>();

/** 记录最近成功触达的 QQ；容量达到上限时淘汰最旧的一批。 */
function rememberTouchedQq(qq: string, now: number) {
  if (touchedQqMap.size >= MAX_MAP_SIZE) {
    const keys = [...touchedQqMap.keys()].slice(0, Math.ceil(touchedQqMap.size * 0.1));
    keys.forEach((key) => touchedQqMap.delete(key));
  }
  touchedQqMap.set(qq, now);
}

/** 异步登记 QQ 用户触达；这是余额/后台列表关键链路，但失败不阻断 Bot 回复。 */
function touchQqAccountFromEvent(event: Extract<OneBotWsEvent, { post_type: 'message' }>) {
  const qq = String(event.user_id ?? '').trim();
  if (!/^[1-9][0-9]{4,19}$/.test(qq)) return;
  const now = Date.now();
  const lastTouchedAt = touchedQqMap.get(qq);
  if (lastTouchedAt && now - lastTouchedAt < QQ_TOUCH_TTL_MS) return;
  if (touchingQqSet.has(qq)) return;

  touchingQqSet.add(qq);
  void touchQqAccountByBackend({ qqNumber: qq })
    .then(() => rememberTouchedQq(qq, now))
    .catch(() => { /* 触达建档失败不影响本次命令，下次消息会重试。 */ })
    .finally(() => touchingQqSet.delete(qq));
}

function makeSubmitter(event: { user_id: string | number; sender?: { nickname?: string } }, binding?: { username: string; userId: number } | null): Record<string, unknown> {
  const qq = String(event.user_id);
  const nick = event.sender?.nickname || '';
  const cached = bindingCache.get(qq);
  const result = {
    qqNumber: qq,
    nickname: nick,
    avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=100`,
    binding: binding || cached || undefined,
  };
  return result;
}

/** 消息日志缓冲区（最近 N 条，供管理端查看）。 */
const messageLog: { time: string; qq: string; command: string; reply: string }[] = [];

/** bot-service 事件处理统计，当前阶段保存在进程内，用于状态接口诊断。 */
const eventStats = {
  received: 0,
  ignored: 0,
  actionsCreated: 0,
};

/** 最近消息日志缓冲区（最近 200 条，供管理端查看）。 */
/** 日志文件持久化路径。 */
const LOG_DIR = process.env.BOT_LOG_DIR ?? join(process.cwd(), 'bot-logs');
const LOG_FILE = join(LOG_DIR, `bot-${new Date().toISOString().slice(0, 10)}.log`);
/** Bot 待通知任务持久化文件，保存必要回复上下文，防止 bot-service 重启后丢失最终结果卡片。 */
const PENDING_TASK_FILE = process.env.BOT_PENDING_TASK_FILE ?? join(LOG_DIR, 'pending-tasks.json');

// 确保日志目录存在
try { if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true }); } catch { /* 忽略 */ }

function logMessage(qq: string, command: string, reply: string) {
  const entry = { time: new Date().toISOString(), qq, command: command.slice(0, 80), reply: reply.slice(0, 120) };
  messageLog.push(entry);
  if (messageLog.length > MAX_LOG_SIZE) messageLog.shift();

  // 持久化到文件：每天一个日志文件
  try {
    const line = `[${entry.time}] QQ:${entry.qq} | ${entry.command} → ${entry.reply}\n`;
    appendFileSync(LOG_FILE, line, 'utf8');
  } catch { /* 写入失败不影响服务 */ }
}
export { messageLog, eventStats };

/** 调用 bot-renderer 生成卡片图片，返回 base64 PNG；失败返回空字符串。
 *  @param endpoint 卡片端点路径
 *  @param data 卡片数据
 *  @param cmdType 可选命令类型，未传时按卡片类型反查，避免新增命令忘记接入返回格式配置。
 */
async function fetchCardImage(endpoint: string, data: Record<string, unknown>, cmdType?: string, timeoutMs = BOT_RENDER_TIMEOUT_MS): Promise<string> {
  const cardType = endpoint.replace(/^\/render\//, '');
  const resolvedCmdType = cmdType ?? cardTypeToCommandType[cardType];
  if (resolvedCmdType && isTextOnlyMode(resolvedCmdType, cardType)) return '';
  try {
    const RENDERER_URL = process.env.BOT_RENDERER_URL ?? 'http://localhost:3014';
    const res = await fetch(`${RENDERER_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[bot] card render failed: ${cardType} status=${res.status}`);
      return '';
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length >= 6 * 1024 * 1024) {
      console.warn(`[bot] card render too large: ${cardType} bytes=${buf.length}`);
      return '';
    }
    return buf.toString('base64');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.warn(`[bot] card render error: ${cardType} ${message}`);
    return '';
  }
}

/** 简单字符串哈希，用于消息去重的内容指纹。 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return String(hash);
}

/** 查询 backend 检查 selfId 是否被封禁，返回 true 表示已封禁。 */
async function checkBotBanned(selfId: number): Promise<boolean> {
  try {
    const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
    const res = await fetch(`${BACKEND_URL}/internal/bot/${selfId}/is-banned`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = await res.json() as { ok?: boolean; data?: { banned: boolean } };
    return data?.data?.banned === true;
  } catch { return false; /* 检查失败放行 */ }
}

/** 通知 backend 递增 Bot 消息返回计数（每次返回 action 后调用，异步不阻塞） */
function incrementBotMessageCount(selfId: number, count: number): void {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  fetch(`${BACKEND_URL}/internal/bot/${selfId}/increment-messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
    body: JSON.stringify({ count }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => { /* 计数失败不影响主流程 */ });
}

/** 用户冷却追踪：key 为 QQ 号，value 为冷却结束时间戳。定期清理过期条目。 */
const cooldownMap = new Map<string, number>();
let botCooldownSeconds = Number(process.env.BOT_COOLDOWN_SECONDS ?? '90');
/** 重试通知卡片开关，从 backend 配置读取，默认开启 */
let retryNotifyEnabled = true;
/** Bot 最终失败卡片是否展示参考图；关闭后失败通知更快返回，适合上游异常高发时降载。 */
let botFailedRefsEnabled = true;

/** 从 backend system_configs 刷新 Bot 配置；模型尝试次数由每个任务状态返回。 */
async function refreshBotConfig() {
  try {
    const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
    const res = await fetch(`${BACKEND_URL}/internal/drawing-config`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: Partial<DrawingRuntimeConfigResponse> };
    if (data.ok && data.data?.cooldownSeconds) botCooldownSeconds = data.data.cooldownSeconds;
    if (data.ok && data.data) retryNotifyEnabled = data.data.retryNotifyEnabled !== false;
    if (data.ok && data.data) botFailedRefsEnabled = data.data.botFailedRefsEnabled !== false;
    if (data.ok && data.data?.botCmdPrefix) updateCmdPrefix(data.data.botCmdPrefix);
  } catch { /* 使用默认值 */ }
}
// 启动时加载一次，之后每 60s 刷新
refreshBotConfig();
setInterval(refreshBotConfig, 60_000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [qq, until] of cooldownMap) {
    if (now > until) cooldownMap.delete(qq);
  }
}, 30_000).unref();

/** 用户模型偏好缓存：key 为 QQ 号，value 为模型名；真实默认模型以 backend 持久化结果为准。 */
const modelPrefMap = new Map<string, string>();

/** 待跟踪任务：taskId → { qq, event, createdAt }，完成后发送结果卡片。 */
interface PendingTask {
  qq: string;
  botSelfId: string;
  event: Extract<OneBotWsEvent, { post_type: 'message' }>;
  prompt: string;
  model: string;
  mode: DrawingMode;
  /** 视频时长；图片任务为空。 */
  duration?: number;
  /** 视频分辨率；图片任务为空。 */
  resolution?: DrawingVideoResolution;
  /** 视频画幅；图片任务可为空。 */
  aspectRatio?: DrawingAspectRatio;
  /** 多图批次 ID；存在时单张完成只静默确认，最终回执由批次汇总发送。 */
  batchId?: string;
  /** 多图批次内序号，从 1 开始。 */
  batchIndex?: number;
  /** 多图批次总张数。 */
  batchTotal?: number;
  charged: boolean;
  chargedAmount: string;
  paidBalance: string;
  freeBalance: string;
  /** 任务创建时落库的公开/私密状态，用于后续通知文案和卡片保持一致。 */
  isPrivate: boolean;
  imageUrls: string[];
  createdAt: number;
  startedAt: string;
  lastNotifiedAttempt: number;
  /** 最终通知开始时间：用于诊断最终结果卡片从完成到发出的耗时。 */
  finalNotifyStartedAt?: number;
  /** 最终通知发送锁：防止轮询间隔短于渲染/推送耗时造成同一任务并发发多张最终卡片。 */
  finalNotifyInFlight?: boolean;
  /** 最终通知已进入异步队列：运行期暂停轮询重发，进程重启恢复时会清零后重新接管。 */
  finalNotifyQueued?: boolean;
}
const pendingTasks = new Map<string, PendingTask>();

/** 清理同一批次的待通知上下文；批次最终消息已发送后不再保留单张 pending。 */
function clearPendingBatchTasks(batchId: string) {
  for (const [taskId, task] of pendingTasks) {
    if (task.batchId === batchId) pendingTasks.delete(taskId);
  }
}

/** 判断当前进程是否已有批次原始回复上下文；有上下文时应优先走群聊/原会话回执，不抢私聊恢复锁。 */
function hasLivePendingBatchContext(batchId: string): boolean {
  for (const task of pendingTasks.values()) {
    if (task.batchId === batchId && task.botSelfId && task.event?.post_type === 'message') return true;
  }
  return false;
}

/** 将待通知任务写入本地文件；仅保存 Bot 回复所需上下文，不写敏感 token。 */
function persistPendingTasks() {
  try {
    const items = [...pendingTasks.entries()].map(([taskId, task]) => [taskId, task]);
    writeFileSync(PENDING_TASK_FILE, JSON.stringify(items), 'utf8');
  } catch { /* 持久化失败不阻断 Bot 主流程 */ }
}

/** 从本地文件恢复待通知任务，确保服务重启后仍能发送最终成功/失败提示。 */
function loadPersistedPendingTasks() {
  try {
    if (!existsSync(PENDING_TASK_FILE)) return 0;
    const raw = readFileSync(PENDING_TASK_FILE, 'utf8');
    const items = JSON.parse(raw) as Array<[string, PendingTask]>;
    let restored = 0;
    for (const [taskId, task] of items) {
      if (!taskId || pendingTasks.has(taskId)) continue;
      if (Date.now() - Number(task.createdAt ?? 0) > TASK_MAX_WAIT_MS + 60_000) continue;
      task.finalNotifyInFlight = false;
      task.finalNotifyQueued = false;
      pendingTasks.set(taskId, task);
      restored += 1;
    }
    return restored;
  } catch { return 0; }
}
/** 轮询产生的异步动作队列（任务完成/重试通知等），在下一次 OneBot 事件时发送。 */
type QueuedAction = { botSelfId: string; action: OneBotWsActionRequest; finalTaskId?: string; deliveredTaskId?: string; batchNotifyId?: string };
/** OneBot 直推结果；timeout 表示协议端可能已收到但 wsproxy 未等到 ACK，不能立刻重复发同一张最终图。 */
type DirectPushResult = { sent: true } | { sent: false; uncertain: boolean; error?: string };
/** Bot 最终图片投递结果；uncertain 需要停止重复发图，只补 backend 收尾确认。 */
type FinalImagePushResult = 'sent' | 'failed' | 'uncertain' | 'retryable';
/** Bot 主轮询从 backend 读取的任务状态快照。 */
type PolledGenerationTask = {
  id: string;
  batchId?: string;
  batchTotal?: number;
  status: string;
  mediaType?: 'image' | 'video';
  imageUrl?: string;
  videoUrl?: string;
  duration?: number;
  resolution?: DrawingVideoResolution;
  aspectRatio?: DrawingAspectRatio;
  error?: string;
  siteName?: string;
  model?: string;
  latencyMs?: number;
  /** 任务创建时固化的模型级最大上游尝试次数。 */
  maxAttempts?: number;
  subTasks?: { kind: string; status: string; attemptNo?: number; siteName?: string; model?: string; error?: string; latencyMs?: number }[];
};
const asyncActionQueue: QueuedAction[] = [];
/** 已排队 echo 去重（防重复通知） */
const queuedEchoes = new Set<string>();
/** 最终结果排队去重；按任务或批次收敛，避免 ACK 失败、恢复扫描和锁过期造成同一最终消息重复入队。 */
const queuedFinalResultKeys = new Set<string>();
/** 已投递但 backend 确认失败的任务，只重试写终态，不重复给 QQ 发图。 */
const deliveredAckQueue = new Set<string>();
/** 正在执行兜底私聊补发的 finalizing 任务，防止定时器重入造成重复发送。 */
const finalizingFallbackInFlight = new Set<string>();
/** 正在执行终态批次补发的批次，防止启动扫描和定时扫描并发重复发送。 */
const pendingBatchRecoverInFlight = new Set<string>();
/** 定时排空队列（无新事件时也尝试发送到正确的 Bot，防消息丢失） */
setInterval(async () => {
  if (asyncActionQueue.length === 0) return;
  // 先把本轮要处理的队列项取走，避免 await 直推期间又被事件回调取出造成重复发送。
  const draining = asyncActionQueue.splice(0, asyncActionQueue.length);
  const remaining: QueuedAction[] = [];
  for (const item of draining) {
    const pushResult = item.deliveredTaskId
      // 最终成功图一旦交给协议端就不能再自动 base64 兜底，否则 LLBot/NapCat 延迟回包时会重复发同一结果图。
      ? await pushActionWithMentionFallback(item.botSelfId, item.action)
      : await pushActionWithMediaFallback(item.botSelfId, item.action);
    if (!pushResult.sent) {
      if (item.batchNotifyId && pushResult.uncertain) {
        // 批次最终汇总 ACK 超时不能重复发送整批图片，改为标记已处理，避免用户收到多条大图消息。
        await markBotBatchNotificationSent(item.batchNotifyId);
        clearPendingBatchTasks(item.batchNotifyId);
        persistPendingTasks();
        releaseQueuedActionGuards(item);
        continue;
      }
      if (item.batchNotifyId) {
        const textFallback = createBatchTextFallbackAction(item.action);
        if (textFallback) {
          const textPush = await pushActionDirectlyDetailed(item.botSelfId, textFallback);
          if (textPush.sent || textPush.uncertain) {
            // 明确富媒体失败时改发同一条文本详情；ACK 超时同样停止重复刷整批图片。
            await markBotBatchNotificationSent(item.batchNotifyId);
            clearPendingBatchTasks(item.batchNotifyId);
            persistPendingTasks();
            releaseQueuedActionGuards(item);
            continue;
          }
          if (isPermanentPrivateDeliveryError(textPush.error)) {
            // pending 文件丢失后只剩私聊恢复路径；协议端明确拒绝陌生人私聊时没有可重试出口，标记已处理避免无限刷失败。
            console.warn('[bot] 批次私聊补发永久不可达，停止重试并标记已处理', { batchId: item.batchNotifyId, botSelfId: item.botSelfId });
            await markBotBatchNotificationSent(item.batchNotifyId);
            clearPendingBatchTasks(item.batchNotifyId);
            persistPendingTasks();
            releaseQueuedActionGuards(item);
            continue;
          }
        }
      }
      if (item.deliveredTaskId && pushResult.uncertain) {
        // 最终图 ACK 超时属于未知状态：继续发同一图片会造成重复成功消息，改为只补投递确认。
        await notifyBotTaskDelivered(item.deliveredTaskId);
        if (item.finalTaskId) {
          pendingTasks.delete(item.finalTaskId);
          persistPendingTasks();
        }
        releaseQueuedActionGuards(item);
        continue;
      }
      if (item.deliveredTaskId && !isRetryableNoDeliveryError(pushResult.error)) {
        const textFallback = createBatchTextFallbackAction(item.action);
        const textPush = textFallback ? await pushActionDirectlyDetailed(item.botSelfId, textFallback) : { sent: false as const, uncertain: false };
        if (textPush.sent || textPush.uncertain || !isRetryableNoDeliveryError(textPush.error)) {
          // 协议端已经接收过最终图 action 或明确拒绝图片段时，不能把原图消息放回队列重复刷图。
          await notifyBotTaskDelivered(item.deliveredTaskId);
          if (item.finalTaskId) {
            pendingTasks.delete(item.finalTaskId);
            persistPendingTasks();
          }
          releaseQueuedActionGuards(item);
          continue;
        }
      }
      if (item.finalTaskId && !item.deliveredTaskId && !isRetryableNoDeliveryError(pushResult.error)) {
        const textFallback = createBatchTextFallbackAction(item.action);
        const textPush = textFallback ? await pushActionDirectlyDetailed(item.botSelfId, textFallback) : { sent: false as const, uncertain: false };
        if (textPush.sent || textPush.uncertain || !isRetryableNoDeliveryError(textPush.error)) {
          // 视频或失败卡片已被协议端明确拒绝时只发送文本详情，避免永久卡在异步队列。
          pendingTasks.delete(item.finalTaskId);
          persistPendingTasks();
          releaseQueuedActionGuards(item);
          continue;
        }
      }
      remaining.push(item);
    } else {
      releaseQueuedActionGuards(item);
      if (item.finalTaskId) {
        if (item.deliveredTaskId) {
          // 最终图只有在 wsproxy 等到 OneBot API 成功回包后，才允许标记 delivered。
          await notifyBotTaskDelivered(item.deliveredTaskId);
        }
        pendingTasks.delete(item.finalTaskId);
        persistPendingTasks();
      }
      if (item.batchNotifyId) {
        await markBotBatchNotificationSent(item.batchNotifyId);
        clearPendingBatchTasks(item.batchNotifyId);
        persistPendingTasks();
      }
    }
  }
  asyncActionQueue.unshift(...remaining);
}, 30_000).unref();

setInterval(async () => {
  if (deliveredAckQueue.size === 0) return;
  const taskIds = [...deliveredAckQueue].slice(0, 20);
  for (const taskId of taskIds) {
    const ok = await notifyBotTaskDelivered(taskId, false);
    if (ok) deliveredAckQueue.delete(taskId);
  }
}, 15_000).unref();

/** 标记某个最终图已经进入“只补 delivered 回写”状态，后续恢复扫描不得再次发送同一最终图片。 */
function rememberDeliveredAckOnly(taskId: string) {
  if (taskId) deliveredAckQueue.add(taskId);
}

setInterval(() => {
  void recoverFinalizingDeliveries();
}, 60_000).unref();

setInterval(() => {
  void recoverPendingBotBatchNotifications();
}, 120_000).unref();
/** 构造最终结果排队 key；最终消息只能按任务或批次存在一个待发送项。 */
function createQueuedFinalResultKey(finalTaskId?: string, deliveredTaskId?: string, batchNotifyId?: string) {
  if (batchNotifyId) return `batch:${batchNotifyId}`;
  if (deliveredTaskId) return `delivered:${deliveredTaskId}`;
  if (finalTaskId) return `task:${finalTaskId}`;
  return '';
}

/** 判断队列中是否已经存在同一个最终结果，避免重复入队后重复发图。 */
function hasQueuedFinalResult(key: string) {
  return Boolean(key) && queuedFinalResultKeys.has(key);
}

/** 释放排队去重 key；只有最终消息确认送达、标记不可重发或彻底放弃时才释放。 */
function releaseQueuedActionGuards(item: QueuedAction) {
  const echo = item.action.echo ? String(item.action.echo) : '';
  if (echo) queuedEchoes.delete(echo);
  const finalKey = createQueuedFinalResultKey(item.finalTaskId, item.deliveredTaskId, item.batchNotifyId);
  if (finalKey) queuedFinalResultKeys.delete(finalKey);
}

/** 向队列添加 action，自动去重 */
function pushToQueue(botSelfId: string, action: OneBotWsActionRequest, finalTaskId?: string, deliveredTaskId?: string, batchNotifyId?: string) {
  const echo = action.echo ? String(action.echo) : '';
  if (echo && queuedEchoes.has(echo)) return;
  const finalKey = createQueuedFinalResultKey(finalTaskId, deliveredTaskId, batchNotifyId);
  if (hasQueuedFinalResult(finalKey)) return;
  if (echo) queuedEchoes.add(echo);
  if (finalKey) queuedFinalResultKeys.add(finalKey);
  asyncActionQueue.push({ botSelfId, action, finalTaskId, deliveredTaskId, batchNotifyId });
  console.warn('[bot] 异步消息进入重试队列', { botSelfId, echo, action: action.action, finalTaskId, batchNotifyId });
  if (!finalKey && echo) {
    // 非最终类临时通知允许 5 分钟后释放 echo；最终结果必须等 ACK 或不可重发标记后释放。
    setTimeout(() => queuedEchoes.delete(echo), 300_000).unref();
  }
}

/** 从富媒体消息提取文本兜底 action，明确图片或视频失败时仍让用户拿到详情入口和余额。 */
function createBatchTextFallbackAction(action: OneBotWsActionRequest): OneBotWsActionRequest | null {
  const message = Array.isArray(action.params?.message) ? action.params.message : [];
  const textSegment = message.find((segment) => {
    const item = segment as OneBotWsMessageSegment;
    return item.type === 'text' && typeof item.data?.text === 'string' && item.data.text.trim();
  }) as OneBotWsMessageSegment | undefined;
  const text = typeof textSegment?.data?.text === 'string' ? textSegment.data.text : '';
  if (!text) return null;
  const hasVideo = message.some((segment) => (segment as OneBotWsMessageSegment).type === 'video');
  return {
    ...action,
    params: {
      ...(action.params ?? {}),
      message: [
        {
          type: 'text',
          data: {
            text: `${text}\n${hasVideo ? '视频发送失败，请从详情页查看或下载本轮视频。' : '图片发送失败，请从详情页查看或下载本轮图片。'}`,
          },
        },
      ],
    },
    echo: action.echo ? `${String(action.echo)}_text` : undefined,
  };
}

/** 判断私聊是否属于协议端明确拒绝的永久失败；这类恢复消息没有原上下文时不能无限重试。 */
function isPermanentPrivateDeliveryError(error: string | undefined): boolean {
  const text = String(error ?? '').toLowerCase();
  return text.includes('请先添加对方为好友')
    || text.includes('not friend')
    || text.includes('"result": 16')
    || text.includes('result\": 16');
}

/** 判断错误是否发生在 action 写入协议端之前；只有这类最终图失败才允许后续重试原图消息。 */
function isRetryableNoDeliveryError(error: string | undefined): boolean {
  const text = String(error ?? '').toLowerCase();
  return text.includes('bot 不在线')
    || text.includes('bot offline')
    || text.includes('not online')
    || text.includes('no connection')
    || text.includes('connection not found')
    || text.includes('socket not open')
    || text.includes('websocket not open')
    || text.includes('连接不存在')
    || text.includes('连接已断开');
}

/** Bot 成功发送最终原图后通知 backend，backend 才会把任务置为 success。 */
async function notifyBotTaskDelivered(taskId: string, enqueueOnFailure = true): Promise<boolean> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${BACKEND_URL}/internal/bot/tasks/${encodeURIComponent(taskId)}/delivered`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
        body: JSON.stringify({ deliveredAt: new Date().toISOString() }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
      console.warn('[bot] 最终图片投递确认失败', { taskId, status: res.status, attempt });
    } catch (error) {
      console.warn('[bot] 最终图片投递确认异常', { taskId, attempt, message: error instanceof Error ? error.message : String(error) });
    }
    await new Promise(resolve => setTimeout(resolve, 500 * attempt));
  }
  if (enqueueOnFailure) deliveredAckQueue.add(taskId);
  return false;
}

/** 查询 Bot 批次最终结果；批次未全终态时只返回状态，不发送用户消息。 */
async function queryBotBatchResult(batchId: string): Promise<BotBatchResultResponse | null> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/bot/batches/${encodeURIComponent(batchId)}/result`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: BotBatchResultResponse };
    return data.ok && data.data ? data.data : null;
  } catch (error) {
    console.warn('[bot] 查询批次最终结果失败', { batchId, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** 查询 backend 中已经终态但未标记发送的 Bot 多图批次；用于本地 pending 文件丢失后的最终汇总补发。 */
async function queryPendingBotBatches(): Promise<BotBatchResultResponse[]> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/bot/pending-batches?limit=20`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: BotPendingBatchResultsResponse };
    return data.ok && Array.isArray(data.data?.batches) ? data.data.batches : [];
  } catch (error) {
    console.warn('[bot] 查询待补发批次失败', { message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** 分块查询 backend 任务状态，避免大量 pending 任务把 GET 查询串撑爆。 */
async function queryPendingTaskStatuses(taskIds: string[]): Promise<PolledGenerationTask[]> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  const results: PolledGenerationTask[] = [];
  for (let index = 0; index < taskIds.length; index += TASK_POLL_QUERY_CHUNK_SIZE) {
    const chunk = taskIds.slice(index, index + TASK_POLL_QUERY_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const ids = encodeURIComponent(chunk.join(','));
    const res = await fetch(`${BACKEND_URL}/internal/generations/tasks?ids=${ids}`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { tasks?: PolledGenerationTask[] } };
    if (data.ok && Array.isArray(data.data?.tasks)) results.push(...data.data.tasks);
  }
  return results;
}

/** 抢占 Bot 批次最终回执发送权；只有抢到锁的轮询周期才允许推送整批图片。 */
async function claimBotBatchNotification(batchId: string): Promise<BotBatchNotificationClaimResponse | null> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/bot/batches/${encodeURIComponent(batchId)}/notification-claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ claimedAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: BotBatchNotificationClaimResponse };
    return data.ok && data.data ? data.data : null;
  } catch (error) {
    console.warn('[bot] 抢占批次最终回执发送锁失败', { batchId, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** 标记 Bot 批次最终回执已经发送或 ACK 不确定但不可重发。 */
async function markBotBatchNotificationSent(batchId: string): Promise<boolean> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/bot/batches/${encodeURIComponent(batchId)}/notification-sent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ sentAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (error) {
    console.warn('[bot] 标记批次最终回执已发送失败', { batchId, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** 兜底恢复已生成但未投递确认的 Bot 任务；优先使用 backend 保存的原群聊/私聊目标。 */
async function recoverFinalizingDeliveries(): Promise<void> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  const APP_BASE = process.env.APP_BASE_URL || 'https://www.xanime.ink';
  try {
    const [bots, res] = await Promise.all([
      queryWsproxyBots().catch(() => ({ items: [], total: 0 })),
      fetch(`${BACKEND_URL}/internal/bot/finalizing-tasks?minAgeSeconds=300`, {
        headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    const fallbackBot = bots.items.find((item) => typeof item.selfId === 'number');
    if (!res.ok) return;
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: BotFinalizingTaskRecoveryResponse };
    const tasks = data.ok ? data.data?.tasks ?? [] : [];
    for (const task of tasks) {
      const isVideoRecovery = task.mediaType === 'video' && Boolean(task.videoUrl);
      if (!task.taskId || !task.qqNumber || (!task.imageUrl && !isVideoRecovery) || finalizingFallbackInFlight.has(task.taskId)) continue;
      if (pendingTasks.has(task.taskId)) continue;
      if (deliveredAckQueue.has(task.taskId)) {
        // 媒体已经发出或 ACK 状态不确定时，只补 backend delivered 回写，禁止恢复扫描再次发送。
        void notifyBotTaskDelivered(task.taskId, false);
        continue;
      }
      const targetBotSelfId = String(task.botSelfId || fallbackBot?.selfId || '');
      if (!targetBotSelfId) continue;
      const deliveryTarget = task.deliveryTarget ?? { type: 'private', userId: task.qqNumber } satisfies BotDeliveryTarget;
      finalizingFallbackInFlight.add(task.taskId);
      try {
        if (task.batchId && Number(task.batchTotal ?? 0) > 1) {
          // 多图批次重启兜底不能拆成多条单图消息；先确认单张 delivered 推进批次，等批次终态后按原会话发送一次汇总。
          await notifyBotTaskDelivered(task.taskId);
          const batch = await queryBotBatchResult(task.batchId);
          if (batch?.terminal && !batch.notificationSent) {
            const claim = await claimBotBatchNotification(task.batchId);
            if (claim?.claimed) {
              const action = await createRecoveredBatchFinalAction(batch, targetBotSelfId);
              if (!action) continue;
              const pushed = await pushActionWithMediaFallback(targetBotSelfId, action, getBatchMentionUserId(batch));
              if (pushed.sent || pushed.uncertain) {
                await markBotBatchNotificationSent(batch.batchId);
                clearPendingBatchTasks(batch.batchId);
                persistPendingTasks();
              } else {
                const textFallback = createBatchTextFallbackAction(action);
                const textPushed = textFallback ? await pushActionWithMentionFallback(targetBotSelfId, textFallback, getBatchMentionUserId(batch)) : { sent: false as const, uncertain: false };
                if (textPushed.sent || textPushed.uncertain) {
                  await markBotBatchNotificationSent(batch.batchId);
                  clearPendingBatchTasks(batch.batchId);
                  persistPendingTasks();
                } else {
                  pushToQueue(targetBotSelfId, action, undefined, undefined, batch.batchId);
                }
              }
            }
          }
          continue;
        }
        if (isVideoRecovery && task.videoUrl) {
          const videoUrl = resolveBotPublicMediaUrl(APP_BASE, task.videoUrl);
          const detailUrl = `${APP_BASE}/image/${encodeURIComponent(task.taskId)}`;
          const detailText = [
            markBotText('success', '完成 | 已补发'),
            formatBotFinalVideoFlow(0),
            `规格: ${task.aspectRatio ?? '?'} · ${task.resolution ?? '?'}${task.duration ? ` · ${task.duration}秒` : ''}`,
            `详情: ${detailUrl}`,
          ].join('\n');
          const videoAction = createDeliveryTargetVideoAction(deliveryTarget, videoUrl, detailText, `video_recover_${task.taskId}`);
          const pushed = await pushActionWithMentionFallback(targetBotSelfId, videoAction, getDeliveryTargetMentionUserId(deliveryTarget));
          if (pushed.sent || pushed.uncertain) {
            const delivered = await notifyBotTaskDelivered(task.taskId);
            if (!delivered) rememberDeliveredAckOnly(task.taskId);
          } else if (isRetryableNoDeliveryError(pushed.error)) {
            pushToQueue(targetBotSelfId, videoAction, task.taskId, task.taskId);
          } else {
            const textAction = createDeliveryTargetTextAction(
              deliveryTarget,
              `${detailText}\n视频发送失败，请从详情页查看或下载本轮视频。`,
              `video_recover_text_${task.taskId}`,
              { includeReply: false },
            );
            const textPushed = await pushActionWithMentionFallback(targetBotSelfId, textAction, getDeliveryTargetMentionUserId(deliveryTarget));
            if (textPushed.sent || textPushed.uncertain) {
              const delivered = await notifyBotTaskDelivered(task.taskId);
              if (!delivered) rememberDeliveredAckOnly(task.taskId);
            } else if (isRetryableNoDeliveryError(textPushed.error)) {
              pushToQueue(targetBotSelfId, textAction, task.taskId, task.taskId);
            }
          }
          continue;
        }
        const imageUrl = `${APP_BASE}${task.imageUrl}`;
        const detailEntryId = getBotVisibleImageEntryId(task.taskId, task.batchId, task.batchTotal);
        const detailUrl = `${APP_BASE}/image/${encodeURIComponent(detailEntryId)}`;
        const action = createDeliveryTargetMultiAction(
          deliveryTarget,
          [imageUrl],
          [
            markBotText('success', '完成 | 已补发'),
            '图: 参? -> 成1/1',
            `详情: ${detailUrl}`,
          ].join('\n'),
          `finalizing_recover_${task.taskId}`,
        );
        const pushed = await pushFinalImageAction(targetBotSelfId, action, imageUrl, getDeliveryTargetMentionUserId(deliveryTarget));
        if (pushed === 'sent' || pushed === 'uncertain') {
          if (pushed === 'uncertain') {
            console.warn('[bot] finalizing 图片 ACK 超时，停止重复补图并确认任务收尾', {
              taskId: task.taskId,
              qqNumber: task.qqNumber,
              botSelfId: targetBotSelfId,
            });
          }
          const ok = await notifyBotTaskDelivered(task.taskId);
          if (!ok) rememberDeliveredAckOnly(task.taskId);
          if (ok) pendingTasks.delete(task.taskId);
          persistPendingTasks();
        } else if (pushed === 'retryable') {
          // Bot 不在线等未写入协议端的失败才保留原图重试；已经写入过协议端的失败不能重复发图。
          pushToQueue(targetBotSelfId, action, task.taskId, task.taskId);
        } else {
          // NapCat 富媒体可能返回 rich media transfer failed；重启补发不能无限重试同一图片包，改发同目标纯文本详情。
          const textOnlyAction = createDeliveryTargetTextAction(
            deliveryTarget,
            [
              markBotText('success', '完成 | 补图失败'),
              '请到详情页查看图片',
              `详情: ${detailUrl}`,
            ].join('\n'),
            `finalizing_recover_text_${task.taskId}`,
          );
          const textPushed = await pushActionWithMentionFallback(targetBotSelfId, textOnlyAction, getDeliveryTargetMentionUserId(deliveryTarget));
          if (textPushed.sent || textPushed.uncertain) {
            const ok = await notifyBotTaskDelivered(task.taskId);
            if (!ok) rememberDeliveredAckOnly(task.taskId);
            if (ok) pendingTasks.delete(task.taskId);
            persistPendingTasks();
          } else if (deliveryTarget.type === 'private' && isPermanentPrivateDeliveryError(textPushed.error)) {
            // 旧任务或私聊目标被协议端明确拒绝时没有可重试出口，图片已经落库，确认收尾避免每分钟重复失败。
            console.warn('[bot] finalizing 私聊永久不可达，停止重试并确认任务收尾', {
              taskId: task.taskId,
              qqNumber: task.qqNumber,
              botSelfId: targetBotSelfId,
            });
            const ok = await notifyBotTaskDelivered(task.taskId);
            if (!ok) rememberDeliveredAckOnly(task.taskId);
            if (ok) pendingTasks.delete(task.taskId);
            persistPendingTasks();
          } else {
            pushToQueue(targetBotSelfId, textOnlyAction, task.taskId, task.taskId);
          }
        }
      } finally {
        finalizingFallbackInFlight.delete(task.taskId);
      }
    }
  } catch (error) {
    console.warn('[bot] finalizing 兜底投递检查失败', error instanceof Error ? error.message : error);
  }
}

/** 构建批次恢复最终汇总 action；优先使用后端保存的原群聊/私聊目标，旧任务缺失时才按触发 QQ 私聊兜底。 */
async function createRecoveredBatchFinalAction(batch: BotBatchResultResponse, botSelfId: string): Promise<OneBotWsActionRequest | null> {
  const APP_BASE = process.env.APP_BASE_URL || 'https://www.xanime.ink';
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  const successImages = batch.tasks
    .filter((task) => task.status === 'success' && task.imageUrl)
    .sort((a, b) => a.batchIndex - b.batchIndex)
    .map((task) => `${APP_BASE}${task.imageUrl}`);
  const deliveryTarget = batch.deliveryTarget ?? { type: 'private', userId: batch.qqNumber } satisfies BotDeliveryTarget;

  if (successImages.length === 0) {
    return createDeliveryTargetTextAction(
      deliveryTarget,
      [
        markBotText('failed', `失败 | 耗时: ${formatBotBatchElapsed(batch, Date.now())}`),
        formatBotFinalImageFlow(batch.sourceImageCount, 0, batch.totalCount),
        `失败: ${batch.failedCount}`,
        `失败原因: ${summarizeBotBatchFailure(batch)}`,
        `余额: ${formatBotCompactBalanceText(batch.freeBalance, batch.paidBalance)}`,
      ].join('\n'),
      `batch_pending_failed_${batch.batchId}_${botSelfId}`,
    );
  }

  const elapsedText = formatBotBatchElapsed(batch, Date.now());
  const displayModel = await formatBotBatchDisplayModel(BACKEND_URL, batch);
  const text = [
    markBotText('success', `完成 | 耗时: ${elapsedText}${displayModel ? ` | ${displayModel}` : ''}`),
    formatBotFinalImageFlow(batch.sourceImageCount, successImages.length, batch.totalCount),
    `余额: ${formatBotCompactBalanceText(batch.freeBalance, batch.paidBalance)}`,
    `详情: ${APP_BASE}/image/${encodeURIComponent(batch.batchId)}`,
  ].join('\n');
  return createDeliveryTargetMultiAction(deliveryTarget, successImages, text, `batch_pending_result_${batch.batchId}_${botSelfId}`);
}

/** 恢复已终态但未发送最终汇总的 Bot 批次，确保少于 N 张成功时用户仍收到一次完整回执。 */
async function recoverPendingBotBatchNotifications(): Promise<void> {
  try {
    const [bots, batches] = await Promise.all([
      queryWsproxyBots().catch(() => ({ items: [], total: 0 })),
      queryPendingBotBatches(),
    ]);
    const fallbackBot = bots.items.find((item) => typeof item.selfId === 'number');
    for (const batch of batches) {
      if (!batch.batchId || !batch.terminal || batch.notificationSent || pendingBatchRecoverInFlight.has(batch.batchId)) continue;
      if (hasLivePendingBatchContext(batch.batchId)) continue;
      const targetBotSelfId = String(batch.botSelfId || fallbackBot?.selfId || '');
      if (!targetBotSelfId) continue;
      pendingBatchRecoverInFlight.add(batch.batchId);
      try {
        const claim = await claimBotBatchNotification(batch.batchId);
        if (!claim?.claimed) continue;
        const action = await createRecoveredBatchFinalAction(batch, targetBotSelfId);
        if (!action) continue;
        const pushed = await pushActionWithMediaFallback(targetBotSelfId, action, getBatchMentionUserId(batch));
        if (pushed.sent || pushed.uncertain) {
          // OneBot ACK 超时时不能重发整批图片，按已处理标记，避免恢复扫描造成重复大图。
          await markBotBatchNotificationSent(batch.batchId);
          clearPendingBatchTasks(batch.batchId);
          persistPendingTasks();
        } else {
          const textFallback = createBatchTextFallbackAction(action);
          const textPushed = textFallback ? await pushActionWithMentionFallback(targetBotSelfId, textFallback, getBatchMentionUserId(batch)) : { sent: false as const, uncertain: false };
          if (textPushed.sent || textPushed.uncertain) {
            await markBotBatchNotificationSent(batch.batchId);
            clearPendingBatchTasks(batch.batchId);
            persistPendingTasks();
          } else if (isPermanentPrivateDeliveryError(textPushed.error)) {
            // 历史批次没有原始群聊上下文，且私聊被协议端明确拒绝时只能停止重试，避免每 2 分钟重复刷同一批图片。
            console.warn('[bot] 批次私聊恢复永久不可达，停止重试并标记已处理', { batchId: batch.batchId, botSelfId: targetBotSelfId });
            await markBotBatchNotificationSent(batch.batchId);
            clearPendingBatchTasks(batch.batchId);
            persistPendingTasks();
          } else {
            pushToQueue(targetBotSelfId, action, undefined, undefined, batch.batchId);
          }
        }
      } finally {
        pendingBatchRecoverInFlight.delete(batch.batchId);
      }
    }
  } catch (error) {
    console.warn('[bot] 终态批次补发扫描失败', error instanceof Error ? error.message : error);
  }
}
/** 判断 OneBot 返回是否属于“可能已发出但 ACK 超时”的未知状态。 */
function isUncertainOneBotDeliveryError(error: string | undefined): boolean {
  const text = String(error ?? '').toLowerCase();
  return text.includes('timeout')
    || text.includes('超时')
    || text.includes('aborted')
    || text.includes('operation was aborted');
}

/** 判断 OneBot 返回是否像是 reply 引用消息已被撤回或不存在；这类最终消息应改为 @ 原用户重发。 */
function isMissingReplyTargetError(error: string | undefined): boolean {
  const text = String(error ?? '').toLowerCase();
  return text.includes('reply')
    || text.includes('message_id')
    || text.includes('message id')
    || text.includes('消息不存在')
    || text.includes('消息已撤回')
    || text.includes('被撤回')
    || text.includes('not found')
    || text.includes('not exist')
    || text.includes('不存在');
}

/** 通过 wsproxy 直接推送 action 到指定 QQ 连接，并区分明确失败与 ACK 超时。 */
async function pushActionDirectlyDetailed(selfId: string, action: OneBotWsActionRequest): Promise<DirectPushResult> {
  try {
    const WSPROXY_URL = process.env.WSPROXY_SERVICE_URL ?? 'http://localhost:3011';
    const res = await fetch(`${WSPROXY_URL}/internal/send-action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ selfId: Number(selfId), action, timeoutMs: 45_000 }),
      // 最终图片可能需要 OneBot 下载公网图片，等待窗口必须大于普通 HTTP 探活。
      signal: AbortSignal.timeout(50_000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { sent?: boolean; ack?: boolean; error?: string } };
    const sent = data?.data?.sent === true && data?.data?.ack === true;
    if (sent) return { sent: true };
    const error = data?.data?.error;
    console.warn('[bot] wsproxy 直推未送达', { selfId, echo: action.echo, action: action.action, error });
    return { sent: false, uncertain: isUncertainOneBotDeliveryError(error), error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bot] wsproxy 直推异常', { selfId, echo: action.echo, message });
    return { sent: false, uncertain: isUncertainOneBotDeliveryError(message), error: message };
  }
}

/** 通过 wsproxy 直接推送 action 到指定 QQ 连接（兼容非最终图链路，只返回是否明确成功）。 */
async function pushActionDirectly(selfId: string, action: OneBotWsActionRequest): Promise<boolean> {
  const result = await pushActionDirectlyDetailed(selfId, action);
  return result.sent;
}

/** 读取 action 的消息段数组；只处理标准数组消息，避免破坏其他 OneBot 参数形态。 */
function readActionMessageSegments(action: OneBotWsActionRequest): OneBotWsMessageSegment[] {
  return Array.isArray(action.params?.message) ? action.params.message as OneBotWsMessageSegment[] : [];
}

/** 把群最终消息中的 reply 段替换为 @ 原用户；仅在原消息被撤回导致引用失败时使用。 */
function createMentionFallbackAction(action: OneBotWsActionRequest, userId: string | undefined, echoSuffix = 'mention'): OneBotWsActionRequest | null {
  const normalizedUserId = String(userId ?? '').trim();
  if (!/^\d{5,20}$/.test(normalizedUserId)) return null;
  if (action.action !== 'send_group_msg') return null;
  const message = readActionMessageSegments(action);
  if (message.length === 0 || !message.some((segment) => segment.type === 'reply')) return null;
  const withoutReply = message.filter((segment) => segment.type !== 'reply');
  const withMention: OneBotWsMessageSegment[] = [
    { type: 'at', data: { qq: normalizedUserId } },
    { type: 'text', data: { text: ' ' } },
    ...withoutReply,
  ];
  return {
    ...action,
    params: { ...(action.params ?? {}), message: withMention },
    echo: action.echo ? `${String(action.echo)}_${echoSuffix}` : undefined,
  };
}

/** 从实时 OneBot 消息事件提取 @ 兜底目标；只有群聊需要 @，私聊不需要。 */
function getEventMentionUserId(event: Extract<OneBotWsEvent, { post_type: 'message' }>): string | undefined {
  // 自触发群命令的发送者就是 Bot 自身，结果消息无需再 @ 自己。
  return event.message_type === 'group' && !event.self_triggered ? String(event.user_id) : undefined;
}

/** 自触发私聊继续回复到原接收方；普通用户私聊仍回复事件 user_id。 */
function getPrivateReplyUserId(event: Extract<OneBotWsEvent, { post_type: 'message' }>): number {
  if (event.message_type === 'private' && event.self_triggered) {
    const target = Number(event.target_user_id);
    if (Number.isSafeInteger(target) && target > 0) return target;
  }
  return event.user_id;
}

/** 从持久化投递目标提取 @ 兜底目标；新任务会保存群聊触发用户，旧任务缺失时无法 @。 */
function getDeliveryTargetMentionUserId(target: BotDeliveryTarget | undefined): string | undefined {
  return target?.type === 'group' ? target.userId : undefined;
}

/** 从批次结果提取 @ 兜底目标；用于 pending 文件丢失后的批次最终汇总恢复。 */
function getBatchMentionUserId(batch: BotBatchResultResponse): string | undefined {
  return getDeliveryTargetMentionUserId(batch.deliveryTarget);
}

/** 最终类群消息优先引用原消息；若原消息已撤回导致明确失败，则 @ 原触发用户重发。 */
async function pushActionWithMentionFallback(selfId: string, action: OneBotWsActionRequest, mentionUserId?: string): Promise<DirectPushResult> {
  const pushed = await pushActionDirectlyDetailed(selfId, action);
  if (pushed.sent || pushed.uncertain) return pushed;
  if (!isMissingReplyTargetError(pushed.error)) return pushed;
  const mentionAction = createMentionFallbackAction(action, mentionUserId);
  if (!mentionAction) return pushed;
  console.warn('[bot] reply 引用失效，改为 @ 原用户重发最终消息', { selfId, echo: action.echo, mentionUserId });
  return pushActionDirectlyDetailed(selfId, mentionAction);
}

/** 从站内图片 URL 提取媒体短文件名，只允许读取本站 `/images/<filename>`。 */
function extractStationImageFilename(imageUrl: string): string {
  const clean = imageUrl.trim();
  const withoutQuery = clean.split('?')[0] ?? '';
  const path = withoutQuery.startsWith('/images/')
    ? withoutQuery
    : (() => {
        try {
          const parsed = new URL(withoutQuery);
          return parsed.pathname;
        } catch {
          return '';
        }
      })();
  if (!path.startsWith('/images/')) return '';
  const filename = decodeURIComponent(path.slice('/images/'.length));
  return /^[a-zA-Z0-9._-]+\.(png|jpg|jpeg|webp)$/i.test(filename) ? filename : '';
}

/** 读取站内最终图为 base64，供 OneBot 无法从公网拉图时兜底发送。 */
async function loadStationImageAsBase64(imageUrl: string): Promise<string> {
  const filename = extractStationImageFilename(imageUrl);
  if (!filename) return '';
  const mediaUrl = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
  try {
    const response = await fetch(`${mediaUrl}/media/files/${encodeURIComponent(filename)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= 0 || buffer.length > BOT_FINAL_IMAGE_BASE64_MAX_BYTES) {
      console.warn('[bot] 最终图 base64 兜底跳过，文件体积超限', { filename, bytes: buffer.length });
      return '';
    }
    return buffer.toString('base64');
  } catch (error) {
    console.warn('[bot] 读取最终图 base64 兜底失败', { filename, message: error instanceof Error ? error.message : String(error) });
    return '';
  }
}

/** 读取站内工具源图二进制；只允许 `/images/<安全文件名>`，供 Bot 反推和放大内部调用使用。 */
async function loadStationImageForTool(imageUrl: string): Promise<{ buffer: Buffer; contentType: string } | undefined> {
  const filename = extractStationImageFilename(imageUrl);
  if (!filename) return undefined;
  const mediaUrl = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';
  try {
    const response = await fetch(`${mediaUrl}/media/files/${encodeURIComponent(filename)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= 0 || buffer.length > 20 * 1024 * 1024) {
      console.warn('[bot] Bot 工具源图跳过，站内图片体积不合法', { filename, bytes: buffer.length });
      return undefined;
    }
    return { buffer, contentType: detectBotImageMimeType(buffer) ?? 'image/png' };
  } catch (error) {
    console.warn('[bot] 读取 Bot 工具源图失败', { filename, message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/** 按图片魔数识别 MIME，避免仅信任文件扩展名。 */
function detectBotImageMimeType(buffer: Buffer): string | undefined {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

/** 克隆最终通知 action，把所有公网生成图替换为 base64 图片段，避免 OneBot 拉公网图超时。 */
function replaceImageUrlsWithBase64(action: OneBotWsActionRequest, imageBase64Map: Map<string, string>): OneBotWsActionRequest {
  const message = Array.isArray(action.params?.message) ? action.params.message : [];
  const replaced = message.map((segment) => {
    const item = segment as OneBotWsMessageSegment;
    if (item.type === 'image' && typeof item.data?.file === 'string') {
      const base64 = imageBase64Map.get(item.data.file);
      if (base64) {
        return { type: 'image', data: { file: `base64://${base64}` } } satisfies OneBotWsMessageSegment;
      }
    }
    return item;
  });
  return {
    ...action,
    params: { ...(action.params ?? {}), message: replaced },
    echo: action.echo ? `${String(action.echo)}_b64` : undefined,
  };
}

/** 读取 action 里的所有公网图片并转换成 base64；失败的图片保留原 URL，由调用方决定是否降级文本。 */
async function loadActionImageBase64Map(action: OneBotWsActionRequest): Promise<Map<string, string>> {
  const message = readActionMessageSegments(action);
  const imageUrls = message
    .filter((segment) => segment.type === 'image' && typeof segment.data?.file === 'string' && /^https?:\/\//i.test(segment.data.file))
    .map((segment) => String(segment.data?.file ?? ''));
  const imageBase64Map = new Map<string, string>();
  for (const imageUrl of imageUrls) {
    const imageBase64 = await loadStationImageAsBase64(imageUrl);
    if (imageBase64) imageBase64Map.set(imageUrl, imageBase64);
  }
  return imageBase64Map;
}

/** 先按原消息直推，失败后把所有可读图片替换成 base64 再试一次；仍失败才交给上层降级文本。 */
async function pushActionWithMediaFallback(selfId: string, action: OneBotWsActionRequest, mentionUserId?: string): Promise<DirectPushResult> {
  const pushed = await pushActionWithMentionFallback(selfId, action, mentionUserId);
  if (pushed.sent || pushed.uncertain) return pushed;
  const imageBase64Map = await loadActionImageBase64Map(action);
  if (imageBase64Map.size === 0) return pushed;
  const fallbackAction = replaceImageUrlsWithBase64(action, imageBase64Map);
  return pushActionWithMentionFallback(selfId, fallbackAction, mentionUserId);
}

/** 发送 Bot 最终图；只在未写入协议端时允许重试，避免 URL 图已发出后又 base64 重发。 */
async function pushFinalImageAction(botSelfId: string, action: OneBotWsActionRequest, publicImageUrl: string, mentionUserId?: string): Promise<FinalImagePushResult> {
  void publicImageUrl;
  const pushed = await pushActionWithMentionFallback(botSelfId, action, mentionUserId);
  if (pushed.sent) return 'sent';
  if (pushed.uncertain) return 'uncertain';
  if (isRetryableNoDeliveryError(pushed.error)) return 'retryable';
  // 图片最终回执已经尝试交给协议端，不能再把同一张图转 base64 重发；由上层改发文本详情。
  return 'failed';
}

/** 格式化 Bot 批次耗时，优先使用 backend 的批次完成时间，缺失时回退本地提交时间。 */
function formatBotBatchElapsed(batch: BotBatchResultResponse, fallbackCreatedAt: number): string {
  const startAt = new Date(batch.createdAt).getTime();
  const endAt = batch.finishedAt ? new Date(batch.finishedAt).getTime() : Date.now();
  const elapsedMs = Number.isFinite(startAt) && Number.isFinite(endAt) && endAt >= startAt
    ? endAt - startAt
    : Date.now() - fallbackCreatedAt;
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (totalSeconds >= 60) return `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`;
  return `${totalSeconds}秒`;
}

/** Bot 外显详情入口统一使用批次 ID；内部 delivered 回写仍使用真实单图任务 ID。 */
function getBotVisibleImageEntryId(taskId: string, batchId?: string, batchTotal?: number | null): string {
  return batchId && Number(batchTotal ?? 1) > 1 ? batchId : taskId;
}

/** 把 backend 返回的站内媒体路径转成公网地址，同时保留上游已经返回的绝对 HTTPS 地址。 */
function resolveBotPublicMediaUrl(appBase: string, mediaUrl?: string): string {
  const normalized = String(mediaUrl ?? '').trim();
  if (!normalized) return '';
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `${appBase.replace(/\/$/, '')}/${normalized.replace(/^\//, '')}`;
}

/** 发送 Bot 多图批次最终汇总；所有成功生成图放在同一条 OneBot 消息里。 */
async function trySendBotBatchFinalNotification(batchId: string, pt: PendingTask): Promise<'sent' | 'queued' | 'skipped'> {
  const batch = await queryBotBatchResult(batchId);
  if (!batch || !batch.terminal || batch.notificationSent) return 'skipped';
  const claim = await claimBotBatchNotification(batchId);
  if (!claim?.claimed) return 'skipped';
  const APP_BASE = process.env.APP_BASE_URL || 'https://www.xanime.ink';
  const successImages = batch.tasks
    .filter((task) => task.status === 'success' && task.imageUrl)
    .sort((a, b) => a.batchIndex - b.batchIndex)
    .map((task) => `${APP_BASE}${task.imageUrl}`);

  if (successImages.length === 0) {
    // 全失败批次不发送多张空图片，改用一次失败汇总并标记已处理，避免每张失败任务刷屏。
    const elapsedText = formatBotBatchElapsed(batch, pt.createdAt);
    const text = [
      markBotText('failed', `失败 | 耗时: ${elapsedText}`),
      formatBotFinalImageFlow(batch.sourceImageCount, 0, batch.totalCount),
      `失败: ${batch.failedCount}`,
      `失败原因: ${summarizeBotBatchFailure(batch)}`,
      `余额: ${formatBotCompactBalanceText(batch.freeBalance, batch.paidBalance)}`,
    ].join('\n');
    const action = createTextReplyAction(pt.event, text, `batch_failed_${batch.batchId}`);
    const pushed = await pushActionWithMentionFallback(pt.botSelfId, action, getEventMentionUserId(pt.event));
    if (pushed.sent || pushed.uncertain) {
      await markBotBatchNotificationSent(batch.batchId);
      clearPendingBatchTasks(batch.batchId);
      persistPendingTasks();
      return 'sent';
    }
    pushToQueue(pt.botSelfId, action, undefined, undefined, batch.batchId);
    return 'queued';
  }

  const elapsedText = formatBotBatchElapsed(batch, pt.createdAt);
  const displayModel = await formatBotBatchDisplayModel(process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369', batch, pt.model);
  const detailUrl = `${APP_BASE}/image/${encodeURIComponent(batch.batchId)}`;
  const detailText = [
    markBotText('success', `完成 | 耗时: ${elapsedText}${displayModel ? ` | ${displayModel}` : ''}`),
    formatBotFinalImageFlow(batch.sourceImageCount, successImages.length, batch.totalCount),
    `余额: ${formatBotCompactBalanceText(batch.freeBalance, batch.paidBalance)}`,
    `详情: ${detailUrl}`,
  ].join('\n');
  const action = createMultiReplyAction(pt.event, successImages, detailText, `batch_result_${batch.batchId}`);
  const pushed = await pushActionWithMediaFallback(pt.botSelfId, action, getEventMentionUserId(pt.event));
  if (pushed.sent) {
    await markBotBatchNotificationSent(batch.batchId);
    clearPendingBatchTasks(batch.batchId);
    persistPendingTasks();
    return 'sent';
  }
  if (pushed.uncertain) {
    console.warn('[bot] 批次最终结果 ACK 超时，停止重复发送并标记批次已处理', { batchId: batch.batchId, botSelfId: pt.botSelfId });
    await markBotBatchNotificationSent(batch.batchId);
    clearPendingBatchTasks(batch.batchId);
    persistPendingTasks();
    return 'sent';
  }
  pushToQueue(pt.botSelfId, action, undefined, undefined, batch.batchId);
  return 'queued';
}
// TASK_POLL_INTERVAL_MS / TASK_MAX_WAIT_MS 已移至文件头部环境变量区

/** 启动任务结果轮询（进程级单例）。卡片结果通过 pushActionDirectly 直推。 */
let pollerStarted = false;

/** 启动时恢复：查询最近未完成的任务加入轮询（防重启丢 pendingTasks） */
async function recoverPendingTasksOnStartup() {
  const restored = loadPersistedPendingTasks();
  if (restored > 0) console.log(`[bot] 从本地文件恢复了 ${restored} 个待通知任务`);
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/worker/pending-tasks`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { tasks?: { taskId:string; prompt:string; mode:string; qqNumber:string; createdAt:string }[] } };
    if (data.ok && data.data?.tasks) {
      for (const t of data.data.tasks) {
        if (pendingTasks.has(t.taskId)) continue;
        pendingTasks.set(t.taskId, {
          qq: String(t.qqNumber), botSelfId: '', event: {} as any, prompt: t.prompt,
          model: '', mode: normalizeRecoveredDrawingMode(t.mode),
          charged: false, chargedAmount: '0', paidBalance: '0', freeBalance: '0',
          isPrivate: false, imageUrls: [], createdAt: Date.now(), startedAt: t.createdAt, lastNotifiedAttempt: 0,
        });
      }
      console.log(`[bot] 启动恢复了 ${data.data.tasks.length} 个待处理任务`);
    }
  } catch { /* 恢复失败不影响主流程 */ }
}

/** 恢复 Worker 待处理任务时保留四种真实媒体模式，异常历史值按文生图兼容。 */
function normalizeRecoveredDrawingMode(value: unknown): DrawingMode {
  if (value === 'image-to-image' || value === 'text-to-video' || value === 'image-to-video') return value;
  return 'text-to-image';
}

/** 确保任务结果轮询器已启动；服务启动和新绘图提交都会调用，避免重启后待通知任务无人轮询。 */
export function ensureTaskPoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  // 恢复重启前未完成的任务
  recoverPendingTasksOnStartup();
  // 启动后立即扫描一次已 finalizing 的任务，修复部署重启期间丢失的最终投递上下文。
  void recoverFinalizingDeliveries();
  // 启动后立即扫描一次已终态但未发送的多图批次，修复 pending 文件丢失导致的汇总消息缺口。
  void recoverPendingBotBatchNotifications();
  setInterval(async () => {
    if (pendingTasks.size === 0) return;
    const now = Date.now();
    try {
      const polledTasks = await queryPendingTaskStatuses([...pendingTasks.keys()]);
      if (polledTasks.length === 0) return;
      for (const t of polledTasks) {
        const pt = pendingTasks.get(t.id);
        if (!pt) continue;
        if (now - pt.createdAt > TASK_MAX_WAIT_MS) { pendingTasks.delete(t.id); persistPendingTasks(); continue; }
        // 重试检测：检查是否有新的失败尝试需要通知
        const attempts = (t.subTasks||[]).filter(s => s.kind === 'upstream_attempt');
        const lastAttempt = attempts.length > 0 ? attempts[attempts.length-1] : null;
        if (!pt.batchId && retryNotifyEnabled && lastAttempt && lastAttempt.status === 'failed' && lastAttempt.attemptNo && lastAttempt.attemptNo > 1 && lastAttempt.attemptNo > pt.lastNotifiedAttempt) {
          pt.lastNotifiedAttempt = lastAttempt.attemptNo;
          // 查找上一条失败尝试的信息
          const prevFailed = attempts.filter(a => a.status === 'failed' && a.attemptNo !== lastAttempt.attemptNo).slice(-1)[0];
          const retryType = prevFailed && prevFailed.siteName !== lastAttempt.siteName ? 'cross_site' : 'same_site';
          const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
          const prevAttempts = await formatBotAttemptModelsForDisplay(BACKEND_URL, attempts.filter(a => a.attemptNo !== lastAttempt.attemptNo).map(a => ({
            attempt: a.attemptNo||0, siteName: a.siteName||'', model: a.model, status: a.status,
            latencyMs: a.latencyMs, error: a.error,
          })));
          const displayRetryModel = await formatBotModelDisplayByName(BACKEND_URL, pt.model);
          const rn64 = await fetchCardImage('/render/retry-notify', {
            prompt: pt.prompt.slice(0, 100), type: retryType,
            attempt: prevFailed?.attemptNo||0, nextAttempt: lastAttempt.attemptNo,
            maxAttempts: t.maxAttempts ?? 3, siteName: prevFailed?.siteName||t.siteName||'?',
            nextSiteName: lastAttempt.siteName, model: displayRetryModel,
            error: lastAttempt.error||'上游API调用失败',
            imageCount: pt.imageUrls.length, previousAttempts: prevAttempts,
            refImageUrls: pt.mode === 'image-to-image' ? pt.imageUrls : [],
            submitter: makeSubmitter(pt.event),
          }, 'draw');
          if (rn64) {
            const retryCardAct = createImageReplyAction(pt.event, '', rn64, `retry_card_${t.id}`);
            const pushed = await pushActionDirectly(pt.botSelfId, retryCardAct);
            if (!pushed) pushToQueue(pt.botSelfId, retryCardAct);
          }
        }
        // 完成/待投递 → 发送结果（文本 + 可选卡片）。finalizing 表示原图已本地保存，Bot 发出原图后才回调 backend 标 success。
        if (t.status === 'finalizing' || t.status === 'success' || t.status === 'failed') {
          // 从 backend 兜底恢复的任务没有原始群聊上下文时，按任务状态交给可恢复链路，避免静默拖到超时。
          if (!pt.botSelfId || !pt.event?.post_type) {
            if (t.status === 'finalizing') {
              void recoverFinalizingDeliveries();
              continue;
            }
            if (pt.batchId && (pt.batchTotal ?? 0) > 1) {
              void recoverPendingBotBatchNotifications();
            }
            pendingTasks.delete(t.id);
            persistPendingTasks();
            continue;
          }
          // 最终通知渲染和直推可能超过轮询间隔；同一任务只允许一个轮询周期接管最终发送。
          if (pt.finalNotifyQueued) continue;
          if (pt.finalNotifyInFlight) continue;
          pt.finalNotifyInFlight = true;
          pt.finalNotifyStartedAt ??= now;
          try {
            const elapsedSec = ((Date.now() - pt.createdAt) / 1000).toFixed(1);
            const elapsedNum = Number(elapsedSec);
            // 从子任务计算重试次数和尝试记录（不依赖后端额外字段）
            const subTasks = t.subTasks || [];
            const attemptList = subTasks.filter(s => s.kind === 'upstream_attempt' && s.status !== 'running' && s.status !== 'skipped' && s.siteName);
            const retryCount = attemptList.filter(a => a.status === 'failed').length;
            const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
            const attempts = await formatBotAttemptModelsForDisplay(BACKEND_URL, attemptList.map(a => ({
              attempt: a.attemptNo||0, siteName: a.siteName||'', model: a.model, status: a.status,
              latencyMs: a.latencyMs, error: a.error,
            })));

            if (pt.batchId && (pt.batchTotal ?? 0) > 1) {
              if (t.status === 'finalizing') {
                if (!t.imageUrl) {
                  // 多图批次同样必须等待原图 URL 可读后才能确认该张图 delivered，避免后续并发提前释放。
                  pt.finalNotifyInFlight = false;
                  continue;
                }
                const delivered = await notifyBotTaskDelivered(t.id);
                if (!delivered) {
                  pt.finalNotifyInFlight = false;
                  persistPendingTasks();
                  continue;
                }
              }
              const batchNotifyStatus = await trySendBotBatchFinalNotification(pt.batchId, pt);
              if (batchNotifyStatus === 'queued') {
                pt.finalNotifyQueued = true;
                persistPendingTasks();
                continue;
              }
              // 批次内单张任务不再单独给用户发最终消息；只保留最后的批次汇总消息。
              pendingTasks.delete(t.id);
              persistPendingTasks();
              continue;
            }

            if (t.status === 'success' || t.status === 'finalizing') {
              if (t.status === 'finalizing' && !t.imageUrl) {
                // finalizing 必须等待原图 URL 可读后才能给 QQ 发最终图并确认任务成功。
                pt.finalNotifyInFlight = false;
                continue;
              }
              // 拉取最新余额（非提交时快照）
              let latestPaid = pt.paidBalance, latestFree = pt.freeBalance;
              try {
                const freshBal = await queryQqBalanceByBackend({ qqNumber: pt.qq });
                latestPaid = freshBal.paidBalance; latestFree = freshBal.freeBalance;
              } catch { /* 查询失败用提交时快照 */ }
              /** 结果详情和公网媒体 URL 使用当前生产前台主域名，避免 Bot 继续指向废弃子域名。 */
              const APP_BASE = process.env.APP_BASE_URL || 'https://www.xanime.ink';
              const elapsedMin = elapsedNum >= 60 ? `${Math.floor(elapsedNum / 60)}分${Math.round(elapsedNum % 60)}秒` : `${elapsedSec}秒`;
              const displayModel = await formatBotModelDisplayByName(BACKEND_URL, t.model || pt.model);
              const detailEntryId = getBotVisibleImageEntryId(t.id, pt.batchId ?? t.batchId, pt.batchTotal ?? t.batchTotal);
              const detailUrl = `${APP_BASE}/image/${encodeURIComponent(detailEntryId)}`;
              const isVideoResult = t.mediaType === 'video' || Boolean(t.videoUrl) || pt.mode === 'text-to-video' || pt.mode === 'image-to-video';
              if (isVideoResult) {
                const publicVideoUrl = resolveBotPublicMediaUrl(APP_BASE, t.videoUrl);
                if (!publicVideoUrl) {
                  // 视频任务状态先于媒体配置可见时保留 pending，等待下一轮拿到真实 MP4 地址。
                  pt.finalNotifyInFlight = false;
                  continue;
                }
                const videoDuration = t.duration ?? pt.duration;
                const videoResolution = t.resolution ?? pt.resolution;
                const videoAspectRatio = t.aspectRatio ?? pt.aspectRatio;
                const videoDetailText = [
                  markBotText('success', `完成 | 耗时: ${elapsedMin}${displayModel ? ` | ${displayModel}` : ''}`),
                  formatBotFinalVideoFlow(pt.imageUrls.length),
                  `规格: ${videoAspectRatio ?? '?'} · ${videoResolution ?? '?'}${videoDuration ? ` · ${videoDuration}秒` : ''}`,
                  `余额: ${formatBotCompactBalanceText(latestFree, latestPaid)}`,
                  `详情: ${detailUrl}`,
                ].join('\n');
                const videoAction = createVideoReplyAction(pt.event, publicVideoUrl, videoDetailText, `video_result_${t.id}`);
                const videoPushed = await pushActionWithMentionFallback(pt.botSelfId, videoAction, getEventMentionUserId(pt.event));
                if (!videoPushed.sent && !videoPushed.uncertain && isRetryableNoDeliveryError(videoPushed.error)) {
                  // Bot 断线发生在协议端接收前时保留原视频消息，连接恢复后继续发送。
                  pushToQueue(pt.botSelfId, videoAction, t.id, t.id);
                  pt.finalNotifyQueued = true;
                } else if (!videoPushed.sent && !videoPushed.uncertain) {
                  const textOnlyAction = createTextReplyAction(
                    pt.event,
                    `${videoDetailText}\n视频发送失败，请从详情页查看或下载本轮视频。`,
                    `video_result_text_${t.id}`,
                    { includeReply: false },
                  );
                  const textPushed = await pushActionWithMentionFallback(pt.botSelfId, textOnlyAction, getEventMentionUserId(pt.event));
                  if (!textPushed.sent && !textPushed.uncertain && isRetryableNoDeliveryError(textPushed.error)) {
                    pushToQueue(pt.botSelfId, textOnlyAction, t.id, t.id);
                    pt.finalNotifyQueued = true;
                  } else {
                    // 协议端收到文本详情也视为本轮视频结果已交付，写入幂等 delivered 记录供重启恢复去重。
                    const delivered = await notifyBotTaskDelivered(t.id);
                    if (!delivered) rememberDeliveredAckOnly(t.id);
                    pendingTasks.delete(t.id);
                  }
                } else {
                  const delivered = await notifyBotTaskDelivered(t.id);
                  if (!delivered) rememberDeliveredAckOnly(t.id);
                  pendingTasks.delete(t.id);
                }
                persistPendingTasks();
                continue;
              }

              const publicImageUrl = resolveBotPublicMediaUrl(APP_BASE, t.imageUrl);
              // 成功回执只发送真实生成图；不再混入结果卡片，确保一条消息里都是本轮最终图片。
              const genImage64 = publicImageUrl;
              const detailText = [
                markBotText('success', `完成 | 耗时: ${elapsedMin}${displayModel ? ` | ${displayModel}` : ''}`),
                formatBotFinalImageFlow(pt.imageUrls.length, 1, pt.batchTotal ?? 1),
                `余额: ${formatBotCompactBalanceText(latestFree, latestPaid)}`,
                `详情: ${detailUrl}`,
              ].join('\n');
              const images: string[] = [];
              if (genImage64) images.push(genImage64);
              const multiAct = createMultiReplyAction(pt.event, images, detailText, `result_${t.id}`);
              const pushed = await pushFinalImageAction(pt.botSelfId, multiAct, publicImageUrl, getEventMentionUserId(pt.event));
              if (pushed === 'retryable') {
                // Bot 不在线时 OneBot 尚未接收 action，可以保留原图消息等待连接恢复。
                pushToQueue(pt.botSelfId, multiAct, t.id, t.status === 'finalizing' ? t.id : undefined);
                pt.finalNotifyQueued = true;
              } else if (pushed === 'failed') {
                const fallbackText = `${detailText}\n图片发送失败，请从详情页查看或下载本轮图片。`;
                const textOnlyAct = createTextReplyAction(pt.event, fallbackText, `result_text_${t.id}`, { includeReply: false });
                const textPushed = await pushActionWithMentionFallback(pt.botSelfId, textOnlyAct, getEventMentionUserId(pt.event));
                if (!textPushed.sent && !textPushed.uncertain && isRetryableNoDeliveryError(textPushed.error)) {
                  // 只有 Bot 断线这类未发出错误才重试文本，避免图片 action 失败后继续重复刷图。
                  pushToQueue(pt.botSelfId, textOnlyAct, t.id, t.status === 'finalizing' ? t.id : undefined);
                  pt.finalNotifyQueued = true;
                } else {
                  if (t.status === 'finalizing') {
                    const delivered = await notifyBotTaskDelivered(t.id);
                    if (!delivered) rememberDeliveredAckOnly(t.id);
                  }
                  pendingTasks.delete(t.id);
                }
              } else {
                if (pushed === 'uncertain') {
                  console.warn('[bot] 最终结果 ACK 超时，停止重复发送同一成功消息并只补确认', {
                    taskId: t.id,
                    botSelfId: pt.botSelfId,
                  });
                }
                if (t.status === 'finalizing') {
                  const delivered = await notifyBotTaskDelivered(t.id);
                  if (!delivered) rememberDeliveredAckOnly(t.id);
                }
                pendingTasks.delete(t.id);
              }
              // 最终通知只交给一个机制：直推成功则清理，入队则暂停轮询重发并由队列继续补发。
              persistPendingTasks();
            } else {
              // 拉取最新余额
              let latestPaid = pt.paidBalance, latestFree = pt.freeBalance;
              try { const fb = await queryQqBalanceByBackend({ qqNumber: pt.qq }); latestPaid = fb.paidBalance; latestFree = fb.freeBalance; } catch {}
              // 失败提示同样按新钱包系统展示 QQ 可访问总额，避免把付费余额误写成总余额。
              const actualModel = (t.subTasks||[]).find(s=>s.model)?.model || pt.model || '';
              const displayActualModel = await formatBotModelDisplayByName(BACKEND_URL, actualModel);
              const actualSite = t.siteName || (t.subTasks||[]).find(s=>s.siteName)?.siteName || '';

              const failureReason = summarizeGenerationFailure({
                taskError: t.error,
                mode: pt.mode,
                subTasks,
              });

              const errCard64 = await fetchCardImage('/render/error-fatal', {
                prompt: pt.prompt.slice(0, 200), error: failureReason,
                mode: pt.mode,
                model: displayActualModel,
                siteName: actualSite,
                imageCount: pt.imageUrls.length, totalLatencySec: elapsedSec,
                balance: { paidBalance: latestPaid, freeBalance: latestFree },
                refImageUrls: (pt.mode === 'image-to-image' || pt.mode === 'image-to-video') && botFailedRefsEnabled ? pt.imageUrls : [],
                submittedAt: pt.startedAt || new Date(pt.createdAt).toISOString(),
                allAttempts: attempts,
                submitter: makeSubmitter(pt.event),
              }, 'draw');
              if (errCard64) {
                const errCardAct = createImageReplyAction(pt.event, '', errCard64, `task_card_${t.id}`);
                const errPushed = await pushActionWithMentionFallback(pt.botSelfId, errCardAct, getEventMentionUserId(pt.event));
                if (!errPushed.sent && !errPushed.uncertain) {
                  pushToQueue(pt.botSelfId, errCardAct, t.id);
                  pt.finalNotifyQueued = true;
                } else {
                  pendingTasks.delete(t.id);
                }
              } else {
                // 渲染器异常或卡片超过大小时仍必须给用户最终失败提示，避免任务只停留在提交卡片。
                const elapsedText = elapsedNum >= 60 ? `${Math.floor(elapsedNum / 60)}分${Math.round(elapsedNum % 60)}秒` : `${elapsedSec}秒`;
                const isVideoFailure = pt.mode === 'text-to-video' || pt.mode === 'image-to-video';
                const failedText = [
                  markBotText('failed', `失败 | 耗时: ${elapsedText}`),
                  isVideoFailure ? formatBotSubmitVideoFlow(pt.imageUrls.length) : formatBotSubmitImageFlow(pt.imageUrls.length, 1),
                  `尝试: ${attempts.length || retryCount || 1}次`,
                  `失败原因: ${failureReason}`,
                  `余额: ${formatBotCompactBalanceText(latestFree, latestPaid)}`,
                ].join('\n');
                const failedAct = createTextReplyAction(pt.event, failedText, `task_failed_${t.id}`);
                const failedPushed = await pushActionWithMentionFallback(pt.botSelfId, failedAct, getEventMentionUserId(pt.event));
                if (!failedPushed.sent && !failedPushed.uncertain) {
                  pushToQueue(pt.botSelfId, failedAct, t.id);
                  pt.finalNotifyQueued = true;
                } else {
                  pendingTasks.delete(t.id);
                }
              }
              // 最终失败提示入队后由队列负责补发，轮询器暂停重复渲染同一张失败卡片。
              persistPendingTasks();
            }
          } finally {
            const latest = pendingTasks.get(t.id);
            if (latest) latest.finalNotifyInFlight = false;
          }
        }
      }
    } catch { /* 轮询失败静默 */ }
  }, TASK_POLL_INTERVAL_MS).unref();
}

/** 消息去重缓存：key 为 "qq:content_hash"，value 为处理时间戳。防止重复命令处理。 */
const dedupMap = new Map<string, number>();
/** 群聊命令抢占缓存：key 不含 self_id，用于一个群多个 Bot 同时收到同一命令时只允许一个执行。 */
const groupCommandClaimMap = new Map<string, number>();
// DEDUP_WINDOW_MS / DEDUP_PRIVATE_WINDOW_MS 已移至文件头部
setInterval(() => {
  const now = Date.now();
  // 清理过期去重
  for (const [key, ts] of dedupMap) {
    if (now - ts > Math.max(DEDUP_WINDOW_MS, DEDUP_PRIVATE_WINDOW_MS) + 10_000) dedupMap.delete(key);
  }
  for (const [key, ts] of groupCommandClaimMap) {
    if (now - ts > DEDUP_WINDOW_MS + 10_000) groupCommandClaimMap.delete(key);
  }
  // 清理过期冷却
  for (const [qq, until] of cooldownMap) {
    if (now > until) cooldownMap.delete(qq);
  }
  // 清理过期 echo 去重（5 分钟以上）
  if (queuedEchoes.size > 1000) queuedEchoes.clear();
  // 清理过期任务
  for (const [id, pt] of pendingTasks) {
    if (now - pt.createdAt > TASK_MAX_WAIT_MS + 60_000) {
      pendingTasks.delete(id);
      persistPendingTasks();
    }
  }
}, 10_000).unref();

/** 动态命令清单，启动时从 backend 拉取；本地兜底只保留中文绘图入口，避免未配置的 /draw 触发绘图。 */
export let supportedBotCommands: string[] = [
  `${CMD}ping`, `${CMD}帮助`, `${CMD}help`,
  `${CMD}bot`, `${CMD}bots`, `${CMD}list`,
  `${CMD}绑定`, `${CMD}bind`,
  `${CMD}余额`, `${CMD}额度`, `${CMD}次数`,
  `${CMD}充值`, `${CMD}兑换`, `${CMD}redeem`,
  `${CMD}绘图`, `${CMD}生成`,
  `${CMD}提取`, `${CMD}反推`,
  `${CMD}放大`, `${CMD}upscale`,
  `${CMD}重试`, `${CMD}retry`,
  `${CMD}统计`,
  `${CMD}状态`, `${CMD}status`, `${CMD}stats`,
  `${CMD}任务`, `${CMD}tasks`, `${CMD}记录`,
  `${CMD}模型`, `${CMD}models`,
  `${CMD}隐私`, `${CMD}privacy`,
  `${CMD}info`, `${CMD}站点统计`,
];

/** `/help` 卡片使用的命令配置视图；只保存已启用命令和公开展示字段，不包含任何凭证。 */
export let supportedBotCommandConfigs: BotCommandConfig[] = [];

/** 命令路由表：首词(去前缀) → 命令类型 */
let triggerToType: Record<string, string> = {};
/** 类型 → 主触发器（用于回复提示） */
let typeToPrimaryTrigger: Record<string, string> = {};
/** 类型 → 卡片渲染模式（image=优先卡片, text=仅文字） */
let typeRenderModes: Record<string, Record<string, 'image' | 'text'>> = {};
/** 卡片类型 → 命令类型，作为 fetchCardImage 的兜底格式路由，避免调用点漏传 cmdType。 */
let cardTypeToCommandType: Record<string, string> = {};
/** 支持后台直接传命令 ID；只接受已知处理器，避免错误 ID 进入路由表。 */
const knownCommandTypes = new Set(['ping', 'help', 'botlist', 'bind', 'balance', 'recharge', 'admin_balance', 'draw', 'reverse_extract', 'image_upscale', 'retry', 'generation_stats', 'status', 'tasks', 'model', 'privacy', 'info']);

/** 获取某类型的主触发器（含前缀），用于回复提示文本 */
function cmdFor(type: string): string {
  return CMD + (typeToPrimaryTrigger[type] || type);
}

/** 初始化默认路由表 */
function initDefaultRoutes() {
  triggerToType = {};
  typeToPrimaryTrigger = {};
  cardTypeToCommandType = {};
  const map: [string, string[]][] = [
    ['ping', ['ping']],
    ['help', ['帮助', 'help']],
    ['botlist', ['bot', 'bots', 'list']],
    ['bind', ['绑定', 'bind']],
    ['balance', ['余额', '额度', '次数']],
    ['recharge', ['充值', '兑换', 'redeem']],
    ['admin_balance', ['额度 加', '额度 减', '余额 加', '余额 减']],
    ['draw', ['绘图', '生成']],
    ['reverse_extract', ['提取', '反推']],
    ['image_upscale', ['放大', 'upscale']],
    ['retry', ['重试', 'retry']],
    ['generation_stats', ['统计']],
    ['status', ['状态', 'status', 'stats']],
    ['tasks', ['任务', 'tasks', '记录']],
    ['model', ['模型', 'models']],
    ['privacy', ['隐私', 'privacy']],
    ['info', ['info', '站点统计']],
  ];
  for (const [type, triggers] of map) {
    typeToPrimaryTrigger[type] = triggers[0];
    for (const t of triggers) triggerToType[t] = type;
  }
  const cardMap: [string, string[]][] = [
    ['ping', ['ping']],
    ['help', ['help']],
    ['botlist', ['bot-list', 'bot-list-empty']],
    ['bind', ['bind-howto', 'bind-success', 'bind-failed']],
    ['balance', ['balance-success']],
    ['admin_balance', ['admin-balance']],
    ['draw', ['draw-submitted', 'draw-submitted-i2i', 'draw-result', 'draw-cooldown', 'draw-quota-exceeded', 'retry-notify', 'error-retryable', 'error-fatal']],
    ['retry', ['draw-submitted', 'draw-submitted-i2i', 'draw-cooldown', 'draw-quota-exceeded']],
    ['generation_stats', ['generation-stats']],
    ['status', ['site-status']],
    ['info', ['site-info']],
    ['tasks', ['task-list']],
    ['model', ['model-list', 'model-switched']],
    ['privacy', ['privacy-public', 'privacy-private']],
  ];
  for (const [type, cards] of cardMap) {
    for (const cardType of cards) cardTypeToCommandType[cardType] = type;
  }
}
initDefaultRoutes();

/** 从 backend 拉取命令配置，更新路由表和命令清单 */
export async function refreshCommandList(): Promise<void> {
  const url = `${process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369'}/internal/bot/commands`;
  try {
    const [res, adminConfig] = await Promise.all([
      fetch(url, {
        headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
        signal: AbortSignal.timeout(5000),
      }),
      queryBotAdminRuntimeConfigByBackend().catch((error) => {
        console.warn(`[bot] admin config refresh failed: ${error instanceof Error ? error.message : 'unknown'}`);
        return undefined;
      }),
    ]);
    if (!res.ok) return;
    const data = await res.json() as { ok?: boolean; data?: BotCommandConfig[] };
    if (!data.ok || !data.data) return;
    if (adminConfig) {
      // QQ 管理员列表是余额管理命令的权限来源；刷新失败时沿用上一轮配置，避免临时网络错误导致管理员全部失效。
      botAdminQqNumbers = new Set(adminConfig.adminQqNumbers.filter((item) => /^\d{5,20}$/.test(item)));
    }

    const list: string[] = [];
    const routes: Record<string, string> = {};
    const modes: Record<string, Record<string, 'image'|'text'>> = {};
    const cardRoutes: Record<string, string> = {};
    const primaryRoutes: Record<string, string> = {};
    for (const c of data.data) {
      if (!c.enabled) continue;
      const triggers = [c.command, ...(c.aliases || [])];
      const configType = resolveCommandConfigType(c);
      const commandTriggers: string[] = [];
      for (const raw of triggers) {
        const t = raw.replace(/^[^a-zA-Z0-9一-鿿\s]+/, '');
        if (!t) continue;
        list.push(CMD + t);
        commandTriggers.push(t);
        // 路由映射：用默认路由表反查类型
        if (configType) routes[t] = configType;
        else if (!routes[t] && triggerToType[t]) {
          routes[t] = triggerToType[t];
        }
      }
      if (configType && commandTriggers.length > 0 && !primaryRoutes[configType]) {
        primaryRoutes[configType] = commandTriggers[0]!;
      }
      if (configType && c.renderModes) modes[configType] = c.renderModes;
      // 后台配置保存了卡片列表时，同步建立卡片到命令的映射，后续渲染入口无需每处手动传 cmdType。
      if (configType && Array.isArray(c.cardTypes)) {
        for (const cardType of c.cardTypes) cardRoutes[cardType] = configType;
      }
    }
    // 后台命令配置刷新成功后必须作为唯一真源，不能与内置默认别名合并，否则删除 /draw 等别名不会生效。
    supportedBotCommands = dedupeCommandList(list);
    supportedBotCommandConfigs = buildHelpCommandConfigsFromCommands(supportedBotCommands);
    triggerToType = routes;
    typeToPrimaryTrigger = primaryRoutes;
    typeRenderModes = modes;
    cardTypeToCommandType = cardRoutes;
    console.log(`[bot] command config refreshed: commands=${list.length} modes=${Object.keys(modes).length} admins=${botAdminQqNumbers.size}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.warn(`[bot] command config refresh failed: ${message}`);
  }
}

/** 从当前可用触发词构建帮助卡片配置；避免后台旧配置缺字段时 help 卡片缺少别名。 */
function buildHelpCommandConfigsFromCommands(commands: string[]): BotCommandConfig[] {
  const unique = dedupeCommandList(commands);
  const byType = new Map<string, string[]>();
  for (const command of unique) {
    const type = inferHelpType(command);
    if (!type) continue;
    const items = byType.get(type) ?? [];
    items.push(command);
    byType.set(type, items);
  }
  return HELP_TEXT_DEFS
    .filter((item) => byType.has(item.type))
    .map((item) => {
      const triggers = byType.get(item.type) ?? [];
      const primary = pickHelpPrimaryCommand(triggers, item.command);
      return {
        id: item.type,
        command: primary,
        aliases: triggers.filter((trigger) => trigger !== primary),
        enabled: true,
        group: item.group,
        label: item.title,
      };
    });
}

/** 命令列表去重，保持 backend 返回顺序，避免重复别名影响帮助菜单展示。 */
function dedupeCommandList(list: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/** 从后端命令配置推断命令类型，优先 ID，其次触发词，最后按卡片类型兜底。 */
function resolveCommandConfigType(config: BotCommandConfig): string | undefined {
  if (config.id && knownCommandTypes.has(config.id)) return config.id;
  const triggers = [config.command, ...(config.aliases || [])];
  for (const raw of triggers) {
    const trigger = raw.replace(/^[^a-zA-Z0-9一-鿿\s]+/, '');
    if (triggerToType[trigger]) return triggerToType[trigger];
  }
  for (const cardType of config.cardTypes || []) {
    if (cardTypeToCommandType[cardType]) return cardTypeToCommandType[cardType];
  }
  return undefined;
}

/** 检查卡片类型是否应渲染为文字模式（true=仅文字, false=可渲染卡片） */
function isTextOnlyMode(cmdType: string, cardType: string): boolean {
  const modes = typeRenderModes[cmdType];
  if (!modes) return false;
  return modes[cardType] === 'text';
}

/** 根据命令文本查找匹配的命令类型（支持多词触发器如 "额度 加"） */
function resolveCommandType(text: string): string | null {
  // 仅剥离已配置前缀，严格匹配
  const stripped = text.startsWith(CMD) ? text.slice(CMD.length) : '';
  if (!stripped) return null;
  const words = stripped.split(/\s+/);
  if (words.length >= 2) {
    const twoWord = words.slice(0, 2).join(' ');
    if (triggerToType[twoWord]) return triggerToType[twoWord];
  }
  if (triggerToType[words[0]]) return triggerToType[words[0]];
  // QQ 用户常把短参数紧跟命令输入；只对反推和放大放宽，避免影响绘图、充值等需要严格参数的命令。
  return resolveCompactReverseExtractCommand(stripped) ?? resolveCompactImageUpscaleCommand(stripped);
}

/** 识别“提取tag/反推标签”等无空格紧凑写法，只允许匹配真实反推模式。 */
function resolveCompactReverseExtractCommand(stripped: string): string | null {
  for (const trigger of getReverseExtractTriggers()) {
    if (!stripped.startsWith(trigger) || stripped.length <= trigger.length) continue;
    const suffix = stripped.slice(trigger.length).trim();
    if (isReverseExtractModeToken(suffix)) return 'reverse_extract';
  }
  return null;
}

/** 识别“放大4/放大4x/放大4倍”等无空格写法，只允许合法倍率触发放大命令。 */
function resolveCompactImageUpscaleCommand(stripped: string): string | null {
  for (const trigger of getImageUpscaleTriggers()) {
    if (!stripped.startsWith(trigger) || stripped.length <= trigger.length) continue;
    const suffix = stripped.slice(trigger.length).trim();
    if (readImageUpscaleScaleFromToken(suffix)) return 'image_upscale';
  }
  return null;
}

/** 读取当前已启用的反推触发词；后台配置变更后仍使用真实路由表。 */
function getReverseExtractTriggers(): string[] {
  return Object.entries(triggerToType)
    .filter(([, type]) => type === 'reverse_extract')
    .map(([trigger]) => trigger)
    .sort((a, b) => b.length - a.length);
}

/** 判断用户是否明确输入了 Bot 命令前缀；仅此前缀命令会触发兜底提示，普通聊天仍保持静默。 */
function isExplicitCommandText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > CMD.length && trimmed.startsWith(CMD);
}

/** 构建命令处理兜底提示；关键链路异常时也要给用户明确反馈，而不是让 wsproxy 拿不到 action。 */
function createCommandFallbackAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, reason = 'Bot 命令处理异常，请稍后重试。') {
  return createTextReplyAction(event, markBotText('failed', reason), 'bot_command_fallback');
}

/** Bot 命令解析结果，区分真实命令文本和群聊仅 @Bot 的静默场景。 */
type BotCommandContext = {
  commandText: string;
  mentionOnly: boolean;
};

/** 从 OneBot 消息段中提取纯文本，命令解析只基于 text 段，避免误响应图片或 @ 段。 */
function readTextFromSegments(segments: OneBotWsMessageSegment[]) {
  return segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => String(segment.data.text ?? ''))
    .join('')
    .trim();
}

/** 判断事件是否为 OneBot 消息事件，生命周期事件不进入命令处理。 */
function isMessageEvent(event: OneBotWsEvent) {
  return event.post_type === 'message';
}

/** 判断消息段是否 @ 当前 Bot，自身 QQ 只信任 OneBot 事件的 self_id。 */
function isSelfMentionSegment(segment: OneBotWsMessageSegment, selfId: number) {
  if (segment.type !== 'at') return false;
  return String(segment.data.qq ?? '').trim() === String(selfId);
}

/** 判断消息是否明确 @ 了其他 Bot；多 Bot 同群时，被 @ 以外的 Bot 必须静默。 */
function hasOtherAtMentionSegment(segment: OneBotWsMessageSegment, selfId: number) {
  if (segment.type !== 'at') return false;
  const qq = String(segment.data.qq ?? '').trim();
  return qq.length > 0 && qq !== String(selfId) && qq !== 'all';
}

/** 判断群消息是否先写了命令前缀；命令后的 @ 属于提示词/参考对象，不参与多 Bot 抢占过滤。 */
function startsWithExplicitCommandSegment(segments: OneBotWsMessageSegment[], selfId: number) {
  for (const segment of segments) {
    if (segment.type === 'reply') continue;
    if (isSelfMentionSegment(segment, selfId)) continue;
    if (segment.type === 'text') {
      const text = String(segment.data.text ?? '').trimStart();
      if (!text) continue;
      return isExplicitCommandText(text);
    }
    return false;
  }
  return false;
}

/** 判断消息段是否属于仅 @Bot 场景允许忽略的协议元信息。 */
function isMentionOnlyAllowedSegment(segment: OneBotWsMessageSegment, selfId: number) {
  if (segment.type === 'reply') return true;
  if (segment.type === 'text') return String(segment.data.text ?? '').trim().length === 0;
  return isSelfMentionSegment(segment, selfId);
}

/** 判断消息段是否属于命令触发允许携带的协议段。图片和 QQ 表情包富媒体允许混入以便图生图。 */
function isCommandAllowedSegment(segment: OneBotWsMessageSegment, selfId: number) {
  const type = segment.type.toLowerCase();
  // 允许：reply/text/at 和常见图片、表情包段；不限定只 @bot，命令后的 @ 用户仍要作为参考头像。
  if (type === 'reply' || type === 'text' || type === 'at') return true;
  return isReferenceMediaSegmentType(type);
}

/** 判断 OneBot 扩展段是否可作为图片参考来源，覆盖 NapCat/Lagrange 常见表情包类型。 */
function isReferenceMediaSegmentType(type: string) {
  return type === 'image'
    // 部分 OneBot 适配器会把图片附件投递成 file 段；后续参考图本地化仍会校验真实图片魔数。
    || type === 'file'
    || type === 'face'
    || type === 'mface'
    || type === 'bface'
    || type === 'marketface'
    || type === 'superface'
    || type === 'sticker'
    || type === 'emoji'
    || type.includes('image')
    || type.includes('face')
    || type.includes('sticker')
    || type.includes('emoji');
}

/** 解析 Bot 命令触发上下文，集中约束群聊 @Bot、裸命令和静默忽略规则。 */
function readBotCommandContext(event: Extract<OneBotWsEvent, { post_type: 'message' }>): BotCommandContext {
  const commandText = readTextFromSegments(event.message);
  const hasOnlyCommandAllowedSegments = event.message.every((segment) => isCommandAllowedSegment(segment, event.self_id));
  if (!hasOnlyCommandAllowedSegments) {
    // 含有文件、@其他人等非命令段，避免误触发 Bot。图片/表情/贴纸已放行以支持图生图。
    return { commandText: '', mentionOnly: false };
  }

  if (event.message_type !== 'group') {
    return { commandText, mentionOnly: false };
  }

  const hasSelfMention = event.message.some((segment) => isSelfMentionSegment(segment, event.self_id));
  const startsWithCommand = startsWithExplicitCommandSegment(event.message, event.self_id);
  if (!hasSelfMention && !startsWithCommand && event.message.some((segment) => hasOtherAtMentionSegment(segment, event.self_id))) {
    // 只有“先 @ 其他账号再输入命令”的群消息才静默；命令后的 @ 需要保留给绘图提示词和参考图链路。
    return { commandText: '', mentionOnly: false };
  }
  const isOnlySelfMention = hasSelfMention && event.message.every((segment) => isMentionOnlyAllowedSegment(segment, event.self_id));

  if (isOnlySelfMention) {
    // 群聊仅 @Bot 不再触发帮助菜单，避免多 Bot 群中普通 @ 行为产生噪音。
    return { commandText: '', mentionOnly: true };
  }

  return { commandText, mentionOnly: false };
}

/** 判断提示词是否明显依赖参考图；这类命令不能在 OneBot 没上报图片时降级成文生图。 */
function promptRequiresReferenceImage(prompt: string): boolean {
  const normalized = prompt.replace(/\s+/g, '');
  if (!normalized) return false;
  return /图[一二三四五六七八九十0-9]/.test(normalized)
    || /(参考图|原图|底图|基底图|其他图|另一张图|上一张图|这张图|替换图|图生图|照着图|按图)/.test(normalized);
}

/** 汇总 OneBot 消息段类型，排查协议端是否真实上报了图片段。 */
function summarizeOneBotSegmentTypes(segments: OneBotWsMessageSegment[]): string {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const type = segment.type || 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${type}:${count}`).join(',') || 'none';
}

/** 记录 Bot 绘图参考图提取结果；只写数量和消息段类型，不写完整提示词和临时图片 URL。 */
function logBotDrawReferenceExtraction(
  event: Extract<OneBotWsEvent, { post_type: 'message' }>,
  prompt: string,
  rawImageCount: number,
  localized: { urls: string[]; failed: number; omitted: number },
) {
  console.log('[bot] draw reference extraction', {
    qqNumber: String(event.user_id ?? ''),
    botSelfId: String(event.self_id ?? ''),
    groupId: event.message_type === 'group' ? String(event.group_id ?? '') : '',
    messageId: String(event.message_id ?? ''),
    segmentTypes: summarizeOneBotSegmentTypes(event.message),
    rawImageCount,
    localizedCount: localized.urls.length,
    failed: localized.failed,
    omitted: localized.omitted,
    promptRequiresReference: promptRequiresReferenceImage(prompt),
    promptPreview: truncate(prompt, 48),
  });
}

/** 判断 QQ 事件是否具备 Bot 管理命令权限；余额调整只允许后台白名单或 Web 管理员绑定 QQ。 */
function isBotAdminEvent(event: Extract<OneBotWsEvent, { post_type: 'message' }>): boolean {
  return botAdminQqNumbers.has(String(event.user_id));
}

/** 规范化群命令文本，去掉空白抖动，仅用于同一消息实例 claim 的辅助指纹。 */
function normalizeGroupCommandText(commandText: string) {
  return commandText.replace(/\s+/g, ' ').trim();
}

/** 生成群命令抢占指纹；不用 message_id，避免不同 Bot 视角 ID 不一致导致同群重复执行。 */
function createGroupCommandClaimKey(event: Extract<OneBotWsEvent, { post_type: 'message' }>, commandText: string) {
  if (event.message_type !== 'group') return '';
  const normalizedText = normalizeGroupCommandText(commandText);
  const imageKeys = event.message
    .filter((segment) => segment.type === 'image')
    .map((segment) => String(segment.data.file ?? segment.data.url ?? '').trim())
    .filter((value) => value.length > 0)
    .sort();
  const fingerprint = simpleHash(`${event.time}|${normalizedText}|images:${imageKeys.length}|${imageKeys.join('|')}`);
  return `group-command:${event.group_id}:${event.user_id}:${fingerprint}`;
}

/** 抢占群命令处理权；只拦截同一消息实例的重复投递，不能吞掉用户后续再次发送的相同命令。 */
function claimGroupCommandOnce(event: Extract<OneBotWsEvent, { post_type: 'message' }>, commandText: string) {
  const key = createGroupCommandClaimKey(event, commandText);
  if (!key) return true;
  const now = Date.now();
  const last = groupCommandClaimMap.get(key);
  if (last && now - last < GROUP_COMMAND_CLAIM_WINDOW_MS) return false;
  groupCommandClaimMap.set(key, now);
  return true;
}

/** 构造带引用的文本消息段，保证 Bot 响应能回到触发消息。 */
/** 构建回复消息段：回复引用 + 文本（可选） + 图片（可选）。 */
function buildReplyMessage(messageId: number, text?: string, imageBase64?: string): OneBotWsMessageSegment[] {
  const segments: OneBotWsMessageSegment[] = [{ type: 'reply', data: { id: messageId } }];
  if (text) segments.push({ type: 'text', data: { text } });
  // base64 图片附加（不超过 8MB 的 OneBot 常见限制，实际应更小）
  if (imageBase64 && imageBase64.length < 6 * 1024 * 1024) {
    segments.push({ type: 'image', data: { file: `base64://${imageBase64}` } });
  }
  return segments;
}

/** 构建不引用原消息的普通消息段；最终结果使用它，避免原命令撤回后 reply 段失效。 */
function buildPlainMessage(text?: string, imageBase64?: string): OneBotWsMessageSegment[] {
  const segments: OneBotWsMessageSegment[] = [];
  if (text) segments.push({ type: 'text', data: { text } });
  if (imageBase64 && imageBase64.length < 6 * 1024 * 1024) {
    segments.push({ type: 'image', data: { file: `base64://${imageBase64}` } });
  }
  return segments;
}

/** 回复构造选项；最终结果必须允许禁用 reply，避免用户撤回原命令后 OneBot 拒绝发送。 */
type ReplyBuildOptions = {
  /** 是否附带 OneBot reply 段；默认 true，仅即时命令回执使用。 */
  includeReply?: boolean;
};

/** 创建多段消息回复（可选回复引用 + 多张图片 + 文本）。所有内容在一条 QQ 消息中。 */
function createMultiReplyAction(
  event: Extract<OneBotWsEvent, { post_type: 'message' }>,
  images: string[], // base64 编码或 HTTP URL 的图片列表（卡片 + 生成图）
  text?: string,    // 图库链接等文本
  echoPrefix?: string,
  options: ReplyBuildOptions = {},
): OneBotWsActionRequest {
  const segments: OneBotWsMessageSegment[] = [];
  if (options.includeReply !== false) segments.push({ type: 'reply', data: { id: event.message_id } });
  if (text) segments.push({ type: 'text', data: { text } });
  for (const img of images) {
    if (/^https?:\/\//i.test(img)) {
      // 生成图过大或短暂下载失败时使用公网 URL，让 OneBot 端自行拉取，避免最终通知只有文本链接。
      segments.push({ type: 'image', data: { file: img } });
    } else if (img && img.length < 6 * 1024 * 1024) {
      segments.push({ type: 'image', data: { file: `base64://${img}` } });
    }
  }
  return {
    action: event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg',
    params: {
      ...(event.message_type === 'group' ? { group_id: event.group_id } : { user_id: getPrivateReplyUserId(event) }),
      message: segments,
    },
    echo: echoPrefix ? `${echoPrefix}_${Date.now()}` : undefined,
  };
}

/** 创建视频最终消息；使用 OneBot video 段并关闭 reply，避免原命令撤回后阻断结果投递。 */
function createVideoReplyAction(
  event: Extract<OneBotWsEvent, { post_type: 'message' }>,
  videoUrl: string,
  text: string,
  echoPrefix: string,
): OneBotWsActionRequest {
  const message: OneBotWsMessageSegment[] = [
    { type: 'text', data: { text } },
    { type: 'video', data: { file: videoUrl } },
  ];
  return {
    action: event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg',
    params: {
      ...(event.message_type === 'group' ? { group_id: event.group_id } : { user_id: getPrivateReplyUserId(event) }),
      message,
    },
    echo: `${echoPrefix}_${event.message_id}`,
  };
}

/** 为消息事件创建文本回复 action；最终失败/补发提示可关闭 reply，避免原消息撤回导致投递失败。 */
function createTextReplyAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, text: string, echoPrefix: string, options: ReplyBuildOptions = {}): OneBotWsActionRequest {
  logMessage(String(event.user_id), echoPrefix, text);
  return createReplyAction(event, text, undefined, echoPrefix, options);
}

/** 为消息事件创建文本+图片回复 action。 */
/** 创建纯图片回复（QQ image 段） */
function createImageAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, imageUrl: string, echoPrefix: string): OneBotWsActionRequest {
  return {
    action: event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg',
    params: {
      ...(event.message_type === 'group' ? { group_id: event.group_id } : { user_id: getPrivateReplyUserId(event) }),
      message: [{ type: 'image', data: { file: imageUrl } }],
    },
    echo: `${echoPrefix}_${Date.now()}`,
  };
}

function createImageReplyAction(
  event: Extract<OneBotWsEvent, { post_type: 'message' }>,
  text: string,
  imageBase64: string,
  echoPrefix: string,
  options: ReplyBuildOptions = {},
): OneBotWsActionRequest {
  logMessage(String(event.user_id), echoPrefix, text + '[图片]');
  return createReplyAction(event, text, imageBase64, echoPrefix, options);
}

/** 从 OneBot 消息事件提取可持久化投递目标，避免 bot-service 重启后只能退回私聊。 */
function buildBotDeliveryTarget(event: Extract<OneBotWsEvent, { post_type: 'message' }>): BotDeliveryTarget {
  const messageId = Number(event.message_id);
  const normalizedMessageId = Number.isSafeInteger(messageId) && messageId > 0 ? messageId : undefined;
  if (event.message_type === 'group') {
    // 群聊最终消息优先 reply 原命令；若原命令被撤回，保存触发用户 QQ 供 @ 兜底。
    return { type: 'group', groupId: String(event.group_id), userId: String(event.user_id), messageId: normalizedMessageId };
  }
  return { type: 'private', userId: String(getPrivateReplyUserId(event)), messageId: normalizedMessageId };
}

/** 按持久化投递目标创建文本 action；群聊目标会回到原群，私聊目标回到原用户。 */
function createDeliveryTargetTextAction(target: BotDeliveryTarget, text: string, echoPrefix: string, options: ReplyBuildOptions = {}): OneBotWsActionRequest {
  const message: OneBotWsMessageSegment[] = [];
  if (options.includeReply !== false && target.messageId) message.push({ type: 'reply', data: { id: target.messageId } });
  message.push({ type: 'text', data: { text } });
  if (target.type === 'group') {
    return {
      action: 'send_group_msg',
      params: { group_id: Number(target.groupId), message },
      echo: `${echoPrefix}_${Date.now()}`,
    };
  }
  return {
    action: 'send_private_msg',
    params: { user_id: Number(target.userId), message },
    echo: `${echoPrefix}_${Date.now()}`,
  };
}

/** 按持久化投递目标创建多图 action；用于 pending 文件丢失后的批次最终图恢复。 */
function createDeliveryTargetMultiAction(target: BotDeliveryTarget, images: string[], text: string, echoPrefix: string, options: ReplyBuildOptions = {}): OneBotWsActionRequest {
  const message: OneBotWsMessageSegment[] = [];
  if (options.includeReply !== false && target.messageId) message.push({ type: 'reply', data: { id: target.messageId } });
  message.push({ type: 'text', data: { text } });
  for (const file of images) message.push({ type: 'image', data: { file } });
  if (target.type === 'group') {
    return {
      action: 'send_group_msg',
      params: { group_id: Number(target.groupId), message },
      echo: `${echoPrefix}_${Date.now()}`,
    };
  }
  return {
    action: 'send_private_msg',
    params: { user_id: Number(target.userId), message },
    echo: `${echoPrefix}_${Date.now()}`,
  };
}

/** 按持久化投递目标创建视频 action；用于 Bot 重启后恢复没有本地 pending 上下文的视频结果。 */
function createDeliveryTargetVideoAction(target: BotDeliveryTarget, videoUrl: string, text: string, echoPrefix: string): OneBotWsActionRequest {
  const message: OneBotWsMessageSegment[] = [
    { type: 'text', data: { text } },
    { type: 'video', data: { file: videoUrl } },
  ];
  if (target.type === 'group') {
    return {
      action: 'send_group_msg',
      params: { group_id: Number(target.groupId), message },
      echo: `${echoPrefix}_${Date.now()}`,
    };
  }
  return {
    action: 'send_private_msg',
    params: { user_id: Number(target.userId), message },
    echo: `${echoPrefix}_${Date.now()}`,
  };
}

/** 通用回复构造：根据消息类型选择群聊或私聊。 */
function createReplyAction(
  event: Extract<OneBotWsEvent, { post_type: 'message' }>,
  text?: string,
  imageBase64?: string,
  echoPrefix?: string,
  options: ReplyBuildOptions = {},
): OneBotWsActionRequest {
  const message = options.includeReply === false
    ? buildPlainMessage(text, imageBase64)
    : buildReplyMessage(event.message_id, text, imageBase64);
  if (event.message_type === 'group') {
    return {
      action: 'send_group_msg',
      params: { group_id: event.group_id, message },
      echo: echoPrefix ? `${echoPrefix}_${event.message_id}` : undefined,
    };
  }
  return {
    action: 'send_private_msg',
    params: { user_id: getPrivateReplyUserId(event), message },
    echo: echoPrefix ? `${echoPrefix}_${event.message_id}` : undefined,
  };
}

/** 将健康检查成功结果格式化为 Bot 可读文本。 */
function formatHealthyLine(label: string, health: HealthResponse) {
  return `${label}：正常，版本 ${health.version}，运行 ${health.uptimeSec} 秒`;
}

/** 将健康检查失败原因格式化为 Bot 可读文本。 */
function formatUnhealthyLine(label: string, error: unknown) {
  const message = error instanceof Error ? error.message : '未知错误';
  return `${label}：异常，${message}`;
}

/** 将 wsproxy 在线连接查询结果格式化为 Bot 可读的接入层健康行。 */
function formatWsproxyOnlineLine(total: number) {
  return total > 0
    ? `wsproxy-service：正常，当前在线 OneBot 连接 ${total} 个`
    : 'wsproxy-service：正常，当前没有在线 OneBot 连接';
}

/** 为 `/ping` 生成真实健康探针动作，用于验证 Bot、backend、drawing-service 和 wsproxy 接入状态。 */
async function createPingAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>): Promise<OneBotWsActionRequest> {
  const [backendHealth, drawingHealth, wsproxyBots] = await Promise.allSettled([
    queryBackendHealth(),
    queryDrawingServiceHealth(),
    queryWsproxyBots(),
  ]);
  const lines = [
    'pong：bot-service 已接收 OneBot 事件',
    backendHealth.status === 'fulfilled'
      ? formatHealthyLine('backend', backendHealth.value)
      : formatUnhealthyLine('backend', backendHealth.reason),
    drawingHealth.status === 'fulfilled'
      ? formatHealthyLine('drawing-service', drawingHealth.value)
      : formatUnhealthyLine('drawing-service', drawingHealth.reason),
    wsproxyBots.status === 'fulfilled'
      ? formatWsproxyOnlineLine(wsproxyBots.value.total)
      : formatUnhealthyLine('wsproxy-service', wsproxyBots.reason),
  ];
  // 优先用图片卡片
  const pingB64 = await fetchCardImage('/render/ping', {
    botName: BOT_NAME,
    uptime: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
    pingMs: Date.now() - Math.floor(Number(event.time) * 1000),
    memory: process.memoryUsage ? `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB` : 'N/A',
    nodeVersion: process.version,
    submitter: makeSubmitter(event),
  });
  if (pingB64) return createImageReplyAction(event, '', pingB64, 'bot_ping');
  return createTextReplyAction(event, lines.join('\n'), 'bot_ping');
}

/** 解析 QQ 绑定命令：仅匹配配置前缀 + 触发器 + 验证码 */
function parseBindCommand(commandText: string) {
  if (!commandText.startsWith(CMD)) return null;
  const stripped = commandText.slice(CMD.length);
  const parts = stripped.split(/\s+/);
  if (parts.length < 2) return null;
  const word = parts[0];
  if (triggerToType[word] !== 'bind') return null;
  return parts[1].trim().toUpperCase();
}

/** 格式化连接活动时间，保留原始 ISO 字符串用于跨服务排障。 */
function formatConnectionTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toISOString();
}

/** 将 wsproxy 连接摘要格式化为 QQ 文本，避免把 token 或请求头等敏感信息写入回复。 */
function formatConnectionLine(connection: WsproxyConnectionSummary, index: number) {
  const selfId = typeof connection.selfId === 'number' ? String(connection.selfId) : '未上报';
  return [
    `${index + 1}. self_id：${selfId}`,
    `连接ID：${connection.connectionId}`,
    `传输：${connection.transport}`,
    `在线：${connection.uptimeSec} 秒`,
    `最近活动：${formatConnectionTime(connection.lastSeenAt)}`,
    `最近心跳：${formatConnectionTime(connection.lastPongAt)}`,
    `心跳状态：${connection.heartbeatWaitingPong ? '等待 pong' : '正常'}，间隔 ${connection.heartbeatIntervalMs}ms，最大漏 ${connection.heartbeatMaxMisses} 次`,
  ].join('\n');
}

/** 帮助文本分组定义；与 bot-renderer 的卡片帮助保持同一语义口径。 */
const HELP_TEXT_SECTIONS = [
  { group: 'create', title: '创作', subtitle: '提交、复投和模型相关命令' },
  { group: 'query', title: '查询', subtitle: '任务、统计和站点状态' },
  { group: 'account', title: '账户', subtitle: '余额、绑定、充值和隐私' },
  { group: 'system', title: '系统', subtitle: '帮助、在线状态和连通性' },
] as const;

type HelpTextGroup = typeof HELP_TEXT_SECTIONS[number]['group'];

type HelpTextItem = {
  type: string;
  group: HelpTextGroup;
  title: string;
  command: string;
  args: string;
  desc: string;
  aliases: string[];
};

/** 帮助文本定义；只描述真实已启用命令，不拼接伪造入口。 */
const HELP_TEXT_DEFS: HelpTextItem[] = [
  { type: 'draw', group: 'create', title: '绘图', command: '/绘图', args: '[m序号] [d秒数 r分辨率 a画幅] <提示词>', desc: '按模型提交图片或视频；视频支持文生和最多 8 张参考图。', aliases: [] },
  { type: 'reverse_extract', group: 'create', title: '提取', command: '/提取', args: '[描述|tag] + 图片', desc: '引用或发送图片，提取描述或本地模型标签；支持紧凑写法如 /提取tag。', aliases: [] },
  { type: 'image_upscale', group: 'create', title: '放大', command: '/放大', args: '[2|3|4] + 图片', desc: '引用或发送图片，放大所选第一张图片；不写倍率默认 2x。', aliases: [] },
  { type: 'retry', group: 'create', title: '重试', command: '/重试', args: '', desc: '复用最近一次任务参数重新提交。', aliases: [] },
  { type: 'model', group: 'create', title: '模型', command: '/模型', args: '[模型名]', desc: '查看可用模型，或设置自己的默认模型。', aliases: [] },
  { type: 'tasks', group: 'query', title: '任务', command: '/任务', args: '[success|failed|running|all]', desc: '查看最近任务和状态。', aliases: [] },
  { type: 'generation_stats', group: 'query', title: '统计', command: '/统计', args: '[all]', desc: '查看个人统计；all 显示全站排行。', aliases: [] },
  { type: 'status', group: 'query', title: '状态', command: '/状态', args: '', desc: '查看绘图站点健康和队列状态。', aliases: [] },
  { type: 'info', group: 'query', title: '站点统计', command: '/info', args: '[error]', desc: '查看站点统计或最近错误。', aliases: [] },
  { type: 'balance', group: 'account', title: '余额', command: '/余额', args: '', desc: '查看 QQ/Web 可访问余额和钱包来源。', aliases: [] },
  { type: 'recharge', group: 'account', title: '充值', command: '/充值', args: '<卡密>', desc: '按当前 QQ 兑换卡密，入账 QQ 钱包。', aliases: [] },
  { type: 'bind', group: 'account', title: '绑定', command: '/绑定', args: '<验证码>', desc: '绑定网页账号和 QQ 身份。', aliases: [] },
  { type: 'privacy', group: 'account', title: '隐私', command: '/隐私', args: '', desc: '切换 Bot 端默认公开或私密。', aliases: [] },
  { type: 'help', group: 'system', title: '帮助', command: '/帮助', args: '', desc: '查看当前可用命令。', aliases: [] },
  { type: 'ping', group: 'system', title: '连通', command: '/ping', args: '', desc: '检查 Bot、backend 和绘图服务连通性。', aliases: [] },
  { type: 'botlist', group: 'system', title: 'Bot 列表', command: '/list', args: '', desc: '查看当前在线 OneBot 连接。', aliases: [] },
];

// 初始化默认帮助配置；后续 backend 命令配置刷新成功后会覆盖为生产真实启用列表。
supportedBotCommandConfigs = buildHelpCommandConfigsFromCommands(supportedBotCommands);

/** 去重并过滤空命令，保持 backend 返回顺序。 */
function uniqueCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of commands) {
    const command = raw.trim();
    if (!command || seen.has(command)) continue;
    seen.add(command);
    result.push(command);
  }
  return result;
}

/** 按命令触发词推断帮助分组，和 bot-service 默认路由保持一致。 */
function inferHelpType(command: string): string | null {
  const name = command.replace(/^[^a-zA-Z0-9一-鿿\s]+/, '').trim();
  if (/^(额度|余额)\s+(加|减)\b/i.test(name)) return 'admin_balance';
  if (/^(绘图|生成|draw|generate)\b/i.test(name)) return 'draw';
  if (/^(提取|反推)(?:\s|$)/i.test(name) || /^(提取|反推)(描述|描述模式|标签|标签模式|tag|tags|tag模式|tags模式|本地|本地模型)$/i.test(name) || /^reverse\b/i.test(name)) return 'reverse_extract';
  if (/^(放大|upscale)\b/i.test(name)) return 'image_upscale';
  if (/^(重试|retry)\b/i.test(name)) return 'retry';
  if (/^(模型|models)\b/i.test(name)) return 'model';
  if (/^(任务|记录|tasks)\b/i.test(name)) return 'tasks';
  if (/^统计\b/i.test(name)) return 'generation_stats';
  if (/^(状态|status|stats)\b/i.test(name)) return 'status';
  if (/^(info|站点统计)\b/i.test(name)) return 'info';
  if (/^(余额|额度|次数)\b/i.test(name)) return 'balance';
  if (/^(充值|兑换|redeem)\b/i.test(name)) return 'recharge';
  if (/^(绑定|bind)\b/i.test(name)) return 'bind';
  if (/^(隐私|privacy)\b/i.test(name)) return 'privacy';
  if (/^(帮助|help)\b/i.test(name)) return 'help';
  if (/^ping\b/i.test(name)) return 'ping';
  if (/^(bot|bots|list)\b/i.test(name)) return 'botlist';
  return null;
}

/** 选择当前命令集里的主触发词，优先保留中文命令。 */
function pickHelpPrimaryCommand(commands: string[], fallback: string): string {
  return commands.find((command) => /[一-鿿]/.test(command)) ?? commands[0] ?? fallback;
}

/** 创建纯文本帮助菜单；当卡片渲染失败时，仍保证用户能拿到真实命令说明。 */
async function createHelpAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>) {
  // 优先渲染卡片图片
  const helpB64 = await fetchCardImage('/render/help', {
    commands: supportedBotCommands,
    commandConfigs: supportedBotCommandConfigs,
    cmdPrefix: CMD,
    submitter: makeSubmitter(event),
  });
  if (helpB64) return createImageReplyAction(event, '', helpB64, 'bot_help');

  return createTextReplyAction(event, buildHelpText(supportedBotCommands), 'bot_help');
}

/** 将真实命令列表整理成分组文本，避免纯平铺列表在 QQ 里难以扫描。 */
function buildHelpText(commands: string[]): string {
  const unique = uniqueCommands(commands);
  const byType = new Map<string, string[]>();
  const extraCommands: string[] = [];
  for (const command of unique) {
    const type = inferHelpType(command);
    if (!type) {
      extraCommands.push(command);
      continue;
    }
    const items = byType.get(type) ?? [];
    items.push(command);
    byType.set(type, items);
  }

  const lines: string[] = ['绘图姬 Bot 指令'];
  for (const section of HELP_TEXT_SECTIONS) {
    const defs = HELP_TEXT_DEFS.filter((item) => item.group === section.group && byType.has(item.type));
    if (defs.length === 0) continue;
    lines.push('', `【${section.title}】`);
    lines.push(`  ${section.subtitle}`);
    for (const def of defs) {
      const list = byType.get(def.type) ?? [];
      const primary = pickHelpPrimaryCommand(list, def.command);
      const aliases = list.filter((item) => item !== primary);
      lines.push(`  ${primary}${def.args ? ` ${def.args}` : ''}`);
      lines.push(`    ${def.desc}`);
      if (aliases.length > 0) {
        lines.push(`    别名：${aliases.join('  ')}`);
      }
    }
  }

  if (extraCommands.length > 0) {
    lines.push('', '【其他可用命令】');
    lines.push(`  ${extraCommands.join('  ')}`);
  }

  if (lines.length === 1) {
    lines.push('', '当前没有可展示的命令。');
  }
  lines.push('', `发送 ${CMD}帮助 或 ${CMD}help 可再次查看。`);
  return lines.join('\n');
}

/** 执行 QQ 绑定命令，QQ 号只取自 OneBot 事件 user_id，绝不读取用户文本中的 QQ 号。 */
async function createBindAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, verificationKey: string) {
  try {
    const result = await verifyQqBindingByBackend({
      verificationKey,
      qqNumber: String(event.user_id),
    });
    cacheBinding(String(event.user_id), { username: result.username ?? '', userId: result.userId ?? 0 });
    const bs64 = await fetchCardImage('/render/bind-success', {
      qqNumber: result.qqNumber,
      paidBalance: result.balance.paidBalance,
      freeBalance: result.balance.freeBalance,
      cmdPrefix: CMD,
      submitter: makeSubmitter(event, { username: result.username ?? '', userId: result.userId ?? 0 }),
    });
    if (bs64) return createImageReplyAction(event, '', bs64, 'bot_bind_success');
    return createTextReplyAction(event, `绑定成功：QQ ${result.qqNumber}`, 'bot_bind_success');
  } catch (error) {
    // 绑定失败需要返回明确中文提示；错误来源于 backend 清洗后的业务 message 或本客户端超时错误。
    const message = error instanceof Error ? error.message : 'QQ 绑定失败';
    const bf64 = await fetchCardImage('/render/bind-failed', { reason: message, submitter: makeSubmitter(event) });
    if (bf64) return createImageReplyAction(event, '', bf64, 'bot_bind_failed');
    return createTextReplyAction(event, `绑定失败：${message}`, 'bot_bind_failed');
  }
}

/** 执行 Bot 在线连接查询命令，只读取 wsproxy-service 暴露的连接摘要。 */
async function createBotListAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>) {
  try {
    const [bots, botStats, siteStats] = await Promise.all([
      queryWsproxyBots(),
      queryBotConsoleStats(String(event.user_id)),
      queryBotConsoleSiteStats(),
    ]);
    if (bots.total === 0) {
      // 没有在线协议端时必须明确提示，便于区分 wsproxy 正常但无连接和接口异常。
      const ble64 = await fetchCardImage('/render/bot-list-empty', { cmdPrefix: CMD, submitter: makeSubmitter(event) });
      if (ble64) return createImageReplyAction(event, '', ble64, 'bot_list_empty');
      return createTextReplyAction(event, '当前没有在线 OneBot 连接', 'bot_list_empty');
    }
    const visibleItems = bots.items.slice(0, 10);
    const lines = [
      `当前在线 OneBot 连接：${bots.total} 个`,
      ...visibleItems.map(formatConnectionLine),
    ];
    if (bots.items.length > visibleItems.length) {
      lines.push(`还有 ${bots.items.length - visibleItems.length} 个连接未在本条消息中展开`);
    }
    const bl64 = await fetchCardImage('/render/bot-list', {
      bots: bots.items.map(b => ({
        selfId: String(b.selfId),
        nickname: (b as Record<string,unknown>).nickname as string ?? '',
        status: 'online' as const,
        avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${b.selfId}&spec=100`,
        uptimeMs: (b.uptimeSec ?? 0) * 1000,
      })),
      total: bots.total,
      drawingOnline: siteStats.drawingOnline,
      proxyConnected: true,
      inProgressCount: botStats.active,
      recentTaskCount: botStats.today,
      successRate: botStats.successRate,
      failedToday: botStats.failedToday,
      avgLatencyMs: botStats.avgLatencyMs,
      siteCount: siteStats.total,
      enabledSiteCount: siteStats.enabled,
      siteFailureCount: siteStats.failureCount,
      sites: siteStats.sites,
      cmdPrefix: CMD,
      submitter: makeSubmitter(event),
    });
    if (bl64) return createImageReplyAction(event, '', bl64, 'bot_list_success');
    return createTextReplyAction(event, buildBotListText(lines, botStats, siteStats), 'bot_list_success');
  } catch (error) {
    // wsproxy 查询失败属于已知命令失败，需要返回中文错误帮助定位连接层问题。
    const message = error instanceof Error ? error.message : 'Bot 在线连接查询失败';
    return createTextReplyAction(event, `Bot 在线连接查询失败：${message}`, 'bot_list_failed');
  }
}

/** 查询 Bot 控制台统计；失败时返回空摘要，不影响在线连接菜单。 */
async function queryBotConsoleStats(qqNumber: string) {
  try {
    const stats = await queryBotGenerationStatsByBackend('mine', qqNumber);
    const total = stats.buckets.find((item) => item.key === 'total');
    const today = stats.buckets.find((item) => item.key === 'today');
    return {
      active: total?.active ?? 0,
      today: today?.total ?? 0,
      failedToday: today?.failed ?? 0,
      successRate: total?.successRate ?? 0,
      avgLatencyMs: total?.avgLatencyMs,
    };
  } catch {
    // 统计接口失败不应影响 /bot 在线连接排障。
    return { active: 0, today: 0, failedToday: 0, successRate: 0, avgLatencyMs: undefined as number | undefined };
  }
}

/** 查询全站任务统计；/info 使用全站视角，不按当前 QQ 过滤。 */
async function queryBotGlobalStats() {
  try {
    return await queryBotGenerationStatsByBackend('all');
  } catch {
    // /info 是巡检菜单，统计失败时保留空桶并让其他模块继续展示。
    return {
      scope: 'all' as const,
      generatedAt: new Date().toISOString(),
      buckets: [],
      ranking: [],
    };
  }
}

/** 查询 Bot 控制台站点摘要；只读取 backend 内部真实站点统计。 */
async function queryBotConsoleSiteStats() {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/bot/site-stats`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { sites?: Array<Record<string, unknown>> } };
    const sites = Array.isArray(data.data?.sites) ? data.data.sites : [];
    const enabled = sites.filter((site) => site.isEnabled === true).length;
    const failureCount = sites.reduce((sum, site) => sum + (Number(site.consecutiveFailures ?? 0) > 0 ? 1 : 0), 0);
    return {
      drawingOnline: enabled > 0,
      total: sites.length,
      enabled,
      failureCount,
      sites: sites.slice(0, 5).map((site) => ({
        name: String(site.name ?? '未知站点'),
        isEnabled: site.isEnabled === true,
        consecutiveFailures: Number(site.consecutiveFailures ?? 0) || 0,
        successRate: typeof site.successRate === 'number' ? site.successRate : undefined,
      })),
    };
  } catch {
    return { drawingOnline: false, total: 0, enabled: 0, failureCount: 0, sites: [] as Array<{ name: string; isEnabled: boolean; consecutiveFailures: number; successRate?: number }> };
  }
}

/** 生成 /bot 文本回退，保留连接详情并补充统计摘要。 */
function buildBotListText(lines: string[], stats: Awaited<ReturnType<typeof queryBotConsoleStats>>, siteStats: Awaited<ReturnType<typeof queryBotConsoleSiteStats>>) {
  const summary = [
    `任务：今日 ${stats.today} · 进行中 ${stats.active} · 今日失败 ${stats.failedToday}`,
    `成功率：${stats.successRate.toFixed(1)}%${stats.avgLatencyMs ? ` · 均耗 ${formatBotTaskDuration(stats.avgLatencyMs)}` : ''}`,
    `站点：${siteStats.enabled}/${siteStats.total} 可用 · 异常 ${siteStats.failureCount}`,
  ];
  return [...summary, '', ...lines].join('\n');
}

/** 执行 QQ 余额查询命令，余额归属只按 OneBot 事件 user_id 查询。 */
async function createBalanceAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>) {
  try {
    const balance = await queryQqBalanceByBackend({
      qqNumber: String(event.user_id),
    });
    const balB64 = await fetchCardImage('/render/balance-success', {
      freeBalance: balance.freeBalance,
      paidBalance: balance.paidBalance,
      totalBalance: balance.totalBalance,
      qqNumber: balance.qqNumber,
      primaryWallet: balance.primaryWallet,
      linkedWallet: balance.linkedWallet,
      linkedUsername: balance.linkedUsername,
      linkedUserId: balance.linkedUserId,
      submitter: makeSubmitter(event),
    }, 'balance');
    if (balB64) return createImageReplyAction(event, '', balB64, 'bot_balance_success');
    // 图片渲染失败时也必须保留分钱包语义，避免用户误以为绑定后余额被合并。
    return createTextReplyAction(event, buildBalanceFallbackText(balance), 'bot_balance_success');
  } catch (error) {
    // 余额查询失败需要给触发者明确反馈；未知命令仍在外层静默忽略。
    const message = error instanceof Error ? error.message : 'QQ 余额查询失败';
    return createTextReplyAction(event, `余额查询失败：${message}`, 'bot_balance_failed');
  }
}

/** 构造余额查询文本降级回复；QQ/Web 钱包独立展示，绑定只说明可互通访问。 */
function buildBalanceFallbackText(balance: Awaited<ReturnType<typeof queryQqBalanceByBackend>>): string {
  const totalB = balance.totalBalance ?? (Number(balance.freeBalance || 0) + Number(balance.paidBalance || 0)).toFixed(2);
  const lines = [
    `QQ ${balance.qqNumber} 的可访问余额`,
    `总余额：${totalB} 元`,
    `免费余额：${balance.freeBalance} 元`,
    `付费余额：${balance.paidBalance} 元`,
  ];
  if (balance.primaryWallet) {
    lines.push(`QQ 钱包：${formatWalletLine(balance.primaryWallet)}`);
  }
  if (balance.linkedWallet) {
    const name = balance.linkedUsername ? `（${balance.linkedUsername}${balance.linkedUserId ? ` / ID ${balance.linkedUserId}` : ''}）` : '';
    lines.push(`Web 钱包${name}：${formatWalletLine(balance.linkedWallet)}`);
    lines.push('说明：绑定后两边余额互通可用，但钱包不合并。');
  } else {
    lines.push('说明：未绑定 Web，当前仅使用 QQ 钱包。');
  }
  return lines.join('\n');
}

/** 格式化单个钱包余额，供 Bot 文本降级链路复用。 */
function formatWalletLine(wallet: { freeBalance?: string; paidBalance?: string }): string {
  const rawFree = Number(wallet.freeBalance || 0);
  const rawPaid = Number(wallet.paidBalance || 0);
  const free = Number.isFinite(rawFree) ? rawFree : 0;
  const paid = Number.isFinite(rawPaid) ? rawPaid : 0;
  return `¥${(free + paid).toFixed(2)}（免费 ¥${free.toFixed(2)} / 付费 ¥${paid.toFixed(2)}）`;
}

/** 执行 Bot 卡密兑换命令，入账 QQ 只取 OneBot 事件 user_id，不读取用户文本中的 QQ。 */
async function createRechargeAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, commandText: string) {
  const afterPrefix = commandText.startsWith(CMD) ? commandText.slice(CMD.length).trim() : '';
  const [, ...rest] = afterPrefix.split(/\s+/);
  const code = rest.join('').trim();
  if (!code) {
    return createTextReplyAction(event, `格式：${cmdFor('recharge')} <卡密>`, 'bot_recharge_help');
  }

  try {
    const result = await redeemRechargeCardByBackend({
      qqNumber: String(event.user_id),
      code,
    });
    return createTextReplyAction(
      event,
      `兑换成功：+¥${result.amount}\nQQ：${result.qqNumber}\n付费余额：¥${result.paidBalance}`,
      'bot_recharge_success',
    );
  } catch (error) {
    // 卡密错误、重复兑换或限流都需要给 QQ 用户明确反馈，但不回显卡密明文。
    const message = error instanceof Error ? error.message : '卡密兑换失败';
    return createTextReplyAction(event, `兑换失败：${message}`, 'bot_recharge_failed');
  }
}

/** 管理员额度调整：/额度 加 <QQ> <金额> 或 /额度 减 <QQ> <金额> */
async function createAdminBalanceAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, commandText: string) {
  // 余额调整属于高风险管理命令，QQ 端必须先按 backend 下发的管理员 QQ 列表拦截。
  if (!isBotAdminEvent(event)) {
    return createTextReplyAction(event, '需要 QQ 管理员权限。', 'bot_admin_bal_forbidden');
  }
  // 动态解析：仅剥离配置前缀和触发器后取 <加/减> <QQ> <金额>
  if (!commandText.startsWith(CMD)) return createTextReplyAction(event, `格式：${cmdFor('admin_balance')} <加/减> <QQ号> <金额>`, 'bot_admin_balance');
  const stripped = commandText.slice(CMD.length);
  const parts = stripped.split(/\s+/);
  // 2词触发器（如 "额度 加"）→ 从 idx=2 开始；1词 → 从 idx=1
  const startIdx = (parts.length >= 2 && triggerToType[parts.slice(0,2).join(' ')]) ? 2 : 1;
  const direction = parts[startIdx];
  const qqStr = parts[startIdx + 1];
  const amountStr = parts[startIdx + 2];
  if (!direction || !qqStr || !amountStr || !/^(加|减)$/.test(direction) || !/^\d{5,15}$/.test(qqStr) || !/^\d+(\.\d{1,2})?$/.test(amountStr)) {
    return createTextReplyAction(event, `格式：${cmdFor('admin_balance')} <加/减> <QQ号> <金额>`, 'bot_admin_balance');
  }
  const amount = direction === '加' ? Number.parseFloat(amountStr) : -Number.parseFloat(amountStr);

  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/balance/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ qqNumber: qqStr, operatorQqNumber: String(event.user_id), amount, reason: `Bot命令${direction === '加' ? '增加' : '扣除'}${amountStr}元` }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { balance?: string }; message?: string };
    if (data.ok) {
      const balData = data.data as { balance?: string } | undefined;
      const ab64 = await fetchCardImage('/render/admin-balance', { qqNumber: qqStr, amount: `${direction==='加'?'+':'-'}¥${amountStr}`, balanceAfter: balData?.balance || '0', submitter: makeSubmitter(event) });
      if (ab64) return createImageReplyAction(event, '', ab64, 'bot_admin_bal_ok');
      return createTextReplyAction(event, `已${direction === '加' ? '增加' : '扣除'} ¥${amountStr}\n目标QQ: ${qqStr}`, 'bot_admin_bal_ok');
    }
    return createTextReplyAction(event, `调整失败：${data.message ?? '未知错误'}`, 'bot_admin_bal_fail');
  } catch {
    return createTextReplyAction(event, '后端服务暂不可用。', 'bot_admin_bal_down');
  }
}

/** 处理 OneBot 事件；普通聊天、仅 @Bot 和未知命令均静默忽略。 */
/** 最大并发处理事件数（防止 100bot*100用户 事件洪水） */
const MAX_CONCURRENT_EVENTS = 50;
let concurrentEvents = 0;

export async function handleWsproxyEvent(event: OneBotWsEvent): Promise<OneBotWsActionRequest[]> {
  eventStats.received += 1;
  if (concurrentEvents >= MAX_CONCURRENT_EVENTS) {
    eventStats.ignored += 1;
    // 服务拥塞时必须静默丢弃当前事件，避免 wsproxy/OneBot 积压重放时向群聊刷屏。
    return [];
  }
  concurrentEvents++;
  try {
  // 只排空当前 Bot 的异步动作队列，避免多 Bot 场景下把其他 selfId 的结果卡片混入当前事件。
  const queuedItems: QueuedAction[] = [];
  const retainedItems: QueuedAction[] = [];
  for (const item of asyncActionQueue.splice(0, asyncActionQueue.length)) {
    if (item.finalTaskId || item.deliveredTaskId || item.batchNotifyId) {
      // 最终结果必须走可等待 OneBot ACK 的直推链路；事件响应返回没有逐条 ACK，不能作为送达依据，也不能安全标记已发送。
      retainedItems.push(item);
      continue;
    }
    if (String(item.botSelfId) === String(event.self_id)) queuedItems.push(item);
    else retainedItems.push(item);
  }
  asyncActionQueue.push(...retainedItems);
  const queued = queuedItems.map(q => {
    releaseQueuedActionGuards(q);
    if (q.finalTaskId) {
      if (q.deliveredTaskId) {
        // 事件响应式返回没有逐条 ACK，不能标记最终图已送达；该类任务必须继续留给直推重试。
        asyncActionQueue.push(q);
        return undefined;
      }
      pendingTasks.delete(q.finalTaskId);
      persistPendingTasks();
    }
    return q.action;
  }).filter((action): action is OneBotWsActionRequest => Boolean(action));

  /** 统一返回 + 消息计数 + 统计 */
  const trackAndReturn = (actions: OneBotWsActionRequest[]) => {
    if (actions.length > 0 && event.self_id) {
      incrementBotMessageCount(event.self_id, actions.length);
    }
    eventStats.actionsCreated += actions.length;
    return [...queued, ...actions];
  };

  /** 绘图提交链路可能先下载 QQ 参考图；回执优先直推，避免 wsproxy 原始事件等待超时后用户完全无提示。 */
  const pushPrimaryActionOrReturn = async (action: OneBotWsActionRequest) => {
    const pushed = await pushActionDirectly(String(event.self_id), action);
    if (pushed) {
      incrementBotMessageCount(event.self_id, 1);
      eventStats.actionsCreated += 1;
      return trackAndReturn([]);
    }
    return trackAndReturn([action]);
  };

  if (!isMessageEvent(event)) {
    const raw = event as unknown as Record<string, unknown>;
    if (raw.post_type === 'request') {
      // OneBot 请求事件必须由 bot-service 自动审批，不能交给人工后台或忽略，否则会导致好友/入群申请堆积。
      if (raw.request_type === 'friend' && typeof raw.flag === 'string') {
        return trackAndReturn([{
          action: 'set_friend_add_request',
          params: { flag: raw.flag, approve: true, remark: '' },
          echo: 'bot_auto_accept_friend',
        }]);
      }
      if (raw.request_type === 'group' && typeof raw.flag === 'string' && typeof raw.sub_type === 'string') {
        return trackAndReturn([{
          action: 'set_group_add_request',
          params: { flag: raw.flag, sub_type: raw.sub_type, approve: true, reason: '' },
          echo: 'bot_auto_accept_group',
        }]);
      }
    }
    eventStats.ignored += 1;
    return queued;
  }
  if (event.self_triggered && event.message.some((segment) => segment.type === 'reply')) {
    // Bot 自己的命令回执通常带 reply 段；即使回执正文意外以命令前缀开头，也不得形成递归触发。
    eventStats.ignored += 1;
    return queued;
  }
  // 封禁检查：被封禁的 Bot 忽略所有命令
  if (event.self_id) {
    try {
      const banCheck = await checkBotBanned(event.self_id);
      if (banCheck) { eventStats.ignored += 1; return queued; }
    } catch { /* 检查失败时放行，避免误阻断 */ }
  }

  const commandContext = readBotCommandContext(event);
  if (commandContext.mentionOnly) {
    eventStats.ignored += 1;
    return queued;
  }
  const commandText = commandContext.commandText;
  const cmdType = resolveCommandType(commandText);
  const explicitCommand = isExplicitCommandText(commandText);
  if (!cmdType && !explicitCommand) {
    eventStats.ignored += 1;
    return queued;
  }
  if (!claimGroupCommandOnce(event, commandText)) {
    eventStats.ignored += 1;
    return queued;
  }

  // 消息去重只针对同一 OneBot 消息实例，避免连续相同命令在短窗口内被误吞。
  const dedupKey = `${event.self_id}:${event.user_id}:${event.message_id}:${event.time}`;
  const dedupWindow = event.message_type === 'private' ? DEDUP_PRIVATE_WINDOW_MS : DEDUP_WINDOW_MS;
  const lastProcessed = dedupMap.get(dedupKey);
  if (lastProcessed && Date.now() - lastProcessed < dedupWindow) {
    eventStats.ignored++;
    return queued;
  }
  safeMapSet(dedupMap, dedupKey, Date.now());

  // 动态命令路由 — 根据配置的路由表分派到对应处理器
  // QQ 用户一旦通过去重进入 Bot 处理，就异步登记到账本；未知命令也应纳入后台 QQ 用户口径。
  touchQqAccountFromEvent(event);

  try {
    switch (cmdType) {
      case 'ping': {
        const actions = [await createPingAction(event)];
        return trackAndReturn(actions);
      }
      case 'help': {
        const actions = [await createHelpAction(event)];
        return trackAndReturn(actions);
      }
      case 'botlist': {
        const actions = [await createBotListAction(event)];
        return trackAndReturn(actions);
      }
      case 'bind': {
        // 检查是否有验证码参数
        const verificationKey = parseBindCommand(commandText);
        if (verificationKey) {
          const actions = [await createBindAction(event, verificationKey)];
          return trackAndReturn(actions);
        }
        // 无参数 → 显示绑定指引
        const bh64 = await fetchCardImage('/render/bind-howto', { cmdPrefix: CMD, submitter: makeSubmitter(event) });
        if (bh64) return trackAndReturn([createImageReplyAction(event, '', bh64, 'bot_bind_howto')]);
        return trackAndReturn([createTextReplyAction(event, `请在网页端获取绑定验证码后使用 ${cmdFor('bind')} <验证码>`, 'bot_bind_howto')]);
      }
      case 'balance': {
        const actions = [await createBalanceAction(event)];
        return trackAndReturn(actions);
      }
      case 'recharge': {
        const actions = [await createRechargeAction(event, commandText)];
        return trackAndReturn(actions);
      }
      case 'admin_balance': {
        const actions = [await createAdminBalanceAction(event, commandText)];
        return trackAndReturn(actions);
      }
      case 'draw': {
        try {
          return pushPrimaryActionOrReturn(await createDrawAction(event, commandText));
        } catch {
          return pushPrimaryActionOrReturn(createTextReplyAction(event, markBotText('failed', '绘图服务暂不可用，请稍后重试'), 'bot_draw_fatal'));
        }
      }
      case 'reverse_extract': {
        return pushPrimaryActionOrReturn(await createReverseExtractAction(event, commandText));
      }
      case 'image_upscale': {
        return pushPrimaryActionOrReturn(await createImageUpscaleAction(event, commandText));
      }
      case 'retry': {
        return pushPrimaryActionOrReturn(await createRetryAction(event));
      }
      case 'generation_stats': {
        const scope = commandText.split(/\s+/)[1] === 'all' ? 'all' : 'mine';
        const actions = [await createGenerationStatsAction(event, scope)];
        return trackAndReturn(actions);
      }
      case 'status': {
        const actions = [await createStatsAction(event)];
        return trackAndReturn(actions);
      }
      case 'tasks': {
        const filter = commandText.split(/\s+/)[1];
        const actions = [await createTasksAction(event, filter)];
        return trackAndReturn(actions);
      }
      case 'model': {
        const actions = [await createModelsAction(event, commandText)];
        return trackAndReturn(actions);
      }
      case 'privacy': {
        const actions = [await createPrivacyAction(event)];
        return trackAndReturn(actions);
      }
      case 'info': {
        const subCmd = commandText.split(/\s+/)[1] ?? 'status';
        const actions = [await createInfoAction(event, subCmd)];
        return trackAndReturn(actions);
      }
    }
  } catch (error) {
    // 任意已识别命令的未捕获异常都必须降级为文字提示，防止内部路由 400 导致 QQ 端完全无响应。
    console.warn('[bot] command handler fallback', { cmdType, message: error instanceof Error ? error.message : String(error) });
    return trackAndReturn([createCommandFallbackAction(event)]);
  }
  // 未知命令和未带命令前缀的普通聊天都不响应，避免错误命令刷屏或误导用户。
  eventStats.ignored += 1;
  return queued;
  } finally { concurrentEvents--; }
}

/** 读取 bot-service 事件统计快照，返回副本避免外部修改内部计数。 */
export function readWsproxyEventStats() {
  return { ...eventStats };
}

/** 判断是否为任务查询命令。 */
/** 图片提取命令：复用绘图参考图获取链路，取首张图同步返回描述或标签结果。 */
async function createReverseExtractAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, commandText: string) {
  const parsed = parseReverseExtractCommand(commandText);
  if (parsed.error) {
    return createTextReplyAction(event, markBotText('failed', parsed.error), 'bot_reverse_mode_invalid');
  }

  const rawImageUrls = await extractImageUrlsFromEvent(event, { fetchCurrentMessage: true });
  if (rawImageUrls.length === 0) {
    return createTextReplyAction(event, markBotText('failed', `请发送图片或引用一条带图片的消息：${cmdFor('reverse_extract')} [描述|tag]`), 'bot_reverse_no_image');
  }

  const localizedImages = await localizeReferenceImagesForGeneration(rawImageUrls.slice(0, 1));
  const imageUrl = localizedImages.urls[0] ?? '';
  if (!imageUrl) {
    return createTextReplyAction(event, markBotText('failed', '图片下载或暂存失败，请稍后重试，或重新发送图片后再提取。'), 'bot_reverse_localize_fail');
  }

  const image = await loadStationImageForTool(imageUrl);
  if (!image) {
    return createTextReplyAction(event, markBotText('failed', '图片读取失败，请重新发送图片后再提取。'), 'bot_reverse_image_read_fail');
  }

  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/tools/image-reverse/extract`, {
      method: 'POST',
      headers: {
        'content-type': image.contentType,
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
        'x-aiimage-reverse-mode': parsed.mode,
        'x-aiimage-reverse-options': JSON.stringify(buildBotReverseOptions(parsed.mode)),
      },
      body: new Uint8Array(image.buffer),
      signal: AbortSignal.timeout(BOT_REVERSE_EXTRACT_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: ImageReverseExtractResponse; message?: string };
    if (!res.ok || !data.ok || !data.data?.result) {
      return createTextReplyAction(event, markBotText('failed', formatBotReverseError(data.message, res.status)), 'bot_reverse_fail');
    }
    console.log('[bot] reverse extract success', {
      mode: parsed.mode,
      qq: event.user_id,
      bytes: image.buffer.length,
      model: data.data.result.model,
    });
    return createTextReplyAction(event, formatBotReverseExtractResult(data.data.result, parsed.mode), 'bot_reverse_success');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    console.warn('[bot] reverse extract failed', { mode: parsed.mode, qq: event.user_id, message });
    return createTextReplyAction(event, markBotText('failed', isTimeout ? '图片提取请求超时，请稍后重试或换一张更小的图片。' : '图片提取服务暂不可用，请稍后重试。'), 'bot_reverse_down');
  }
}

/** 图片放大命令：复用 QQ 图片提取链路，取首张图片后立即回执，GPU 结果由后台主动推送。 */
async function createImageUpscaleAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, commandText: string) {
  const parsed = parseImageUpscaleCommand(commandText);
  if (parsed.error) {
    return createTextReplyAction(event, markBotText('failed', parsed.error), 'bot_upscale_scale_invalid');
  }

  const rawImageUrls = await extractImageUrlsFromEvent(event, { fetchCurrentMessage: true });
  if (rawImageUrls.length === 0) {
    return createTextReplyAction(event, markBotText('failed', `请发送图片或引用一条带图片的消息：${cmdFor('image_upscale')} [2|3|4]`), 'bot_upscale_no_image');
  }

  const localizedImages = await localizeReferenceImagesForGeneration(rawImageUrls.slice(0, 1));
  const imageUrl = localizedImages.urls[0] ?? '';
  if (!imageUrl) {
    return createTextReplyAction(event, markBotText('failed', '图片下载或暂存失败，请稍后重试，或重新发送图片后再放大。'), 'bot_upscale_localize_fail');
  }

  const image = await loadStationImageForTool(imageUrl);
  if (!image) {
    return createTextReplyAction(event, markBotText('failed', '图片读取失败，请重新发送图片后再放大。'), 'bot_upscale_image_read_fail');
  }

  // GPU 放大耗时不可控，不能占用 wsproxy 原始事件等待窗口；先回执，再由后台主动推送最终图。
  void runBotImageUpscaleAndPush(event, parsed.scale, image);
  return createTextReplyAction(event, markBotText('submitted', `放大任务已开始 | ${parsed.scale}x\n图: 参1 -> 放1\n完成后会直接发送结果图。`), 'bot_upscale_submitted');
}

/** 后台执行 Bot 图片放大并主动推送结果；失败也回到原会话提示，避免用户只看到开始回执。 */
async function runBotImageUpscaleAndPush(event: Extract<OneBotWsEvent, { post_type: 'message' }>, scale: ImageUpscaleScale, image: { buffer: Buffer; contentType: string }): Promise<void> {
  const botSelfId = String(event.self_id ?? '').trim();
  if (!botSelfId) return;
  const action = await createBotImageUpscaleResultAction(event, scale, image);
  const pushed = await pushActionWithMentionFallback(botSelfId, action, getEventMentionUserId(event));
  if (pushed.sent) {
    incrementBotMessageCount(Number(event.self_id), 1);
    return;
  }
  if (!pushed.uncertain) {
    // 临时工具结果没有业务 delivered 锁；明确未送达时进入短重试队列，ACK 超时则不重试以避免重复刷图。
    pushToQueue(botSelfId, action);
  }
}

/** 调用 backend 内部图片放大接口并构造最终 OneBot action。 */
async function createBotImageUpscaleResultAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, scale: ImageUpscaleScale, image: { buffer: Buffer; contentType: string }): Promise<OneBotWsActionRequest> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/tools/image-upscale/run`, {
      method: 'POST',
      headers: {
        'content-type': image.contentType,
        'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
        'x-aiimage-upscale-options': JSON.stringify({ scale, outputFormat: 'webp', saveToLibrary: false }),
      },
      body: new Uint8Array(image.buffer),
      signal: AbortSignal.timeout(BOT_IMAGE_UPSCALE_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: ImageUpscaleRunResponse; message?: string };
    if (!res.ok || !data.ok || !data.data?.image) {
      return createTextReplyAction(event, markBotText('failed', formatBotImageUpscaleError(data.message, res.status)), 'bot_upscale_fail');
    }
    const result = data.data;
    const imagePayload = await readBotUpscaleImagePayload(result);
    const text = formatBotImageUpscaleResult(result);
    console.log('[bot] image upscale success', {
      qq: event.user_id,
      scale: result.scale,
      model: result.model,
      sourceBytes: image.buffer.length,
      outputBytes: result.image.sizeBytes,
      imageMode: imagePayload ? (/^https?:\/\//i.test(imagePayload) ? 'url' : 'base64') : 'none',
    });
    if (imagePayload) return createMultiReplyAction(event, [imagePayload], text, 'bot_upscale_success');
    return createTextReplyAction(event, `${text}\n结果图过大，且后端未返回可直连地址，QQ 无法直接发送。`, 'bot_upscale_success_no_image');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    console.warn('[bot] image upscale failed', { scale, qq: event.user_id, message });
    return createTextReplyAction(event, markBotText('failed', isTimeout ? '图片放大请求超时，请稍后重试或换一张更小的图片。' : '图片放大服务暂不可用，请稍后重试。'), 'bot_upscale_down');
  }
}

/** 解析 `/放大 n` 命令倍率；不写倍率默认 2x，非法倍率直接提示，不透传到 GPU 服务。 */
function parseImageUpscaleCommand(commandText: string): { scale: ImageUpscaleScale; error?: string } {
  if (!commandText.startsWith(CMD)) return { scale: 2 };
  const stripped = commandText.slice(CMD.length).trim();
  const tail = readImageUpscaleTail(stripped);
  if (!tail) return { scale: 2 };
  const token = tail.split(/\s+/)[0]?.trim().toLowerCase() ?? '';
  const scale = readImageUpscaleScaleFromToken(token);
  if (scale) return { scale };
  return { scale: 2, error: `放大倍率只支持 2/3/4，例：${cmdFor('image_upscale')} 4` };
}

/** 去掉真实放大触发词，兼容“放大 4”“放大4”“放大4x”和“upscale 4”。 */
function readImageUpscaleTail(stripped: string): string {
  for (const trigger of getImageUpscaleTriggers()) {
    if (stripped === trigger) return '';
    if (!stripped.startsWith(trigger)) continue;
    const tail = stripped.slice(trigger.length);
    if (!tail.trim()) return '';
    if (/^\s/.test(tail)) return tail.trim();
    if (readImageUpscaleScaleFromToken(tail.trim())) return tail.trim();
  }
  const [, ...rest] = stripped.split(/\s+/);
  return rest.join(' ').trim();
}

/** 从倍率 token 读取真实支持的 2/3/4 倍，兼容 4、4x、x4、4倍和中文数字。 */
function readImageUpscaleScaleFromToken(value: string): ImageUpscaleScale | null {
  const token = value.trim().toLowerCase();
  const chineseMap: Record<string, ImageUpscaleScale> = { 二: 2, 两: 2, 三: 3, 四: 4 };
  const chinese = token.match(/^([二两三四])(?:倍)?$/);
  if (chinese?.[1]) return chineseMap[chinese[1]] ?? null;
  const numeric = token.match(/^(?:x)?([234])(?:x|倍)?$/i);
  if (!numeric?.[1]) return null;
  return Number(numeric[1]) as ImageUpscaleScale;
}

/** 读取当前已启用的放大触发词，保证后台修改命令后解析参数仍跟随真实路由。 */
function getImageUpscaleTriggers(): string[] {
  return Object.entries(triggerToType)
    .filter(([, type]) => type === 'image_upscale')
    .map(([trigger]) => trigger)
    .sort((a, b) => b.length - a.length);
}

/** 选择 QQ 可发送的放大结果图片：小图用 base64，大图优先交给 OneBot 拉取直连 URL。 */
async function readBotUpscaleImagePayload(result: ImageUpscaleRunResponse): Promise<string> {
  const inlineBase64 = result.image.base64;
  if (inlineBase64 && result.image.sizeBytes > 0 && result.image.sizeBytes <= BOT_UPSCALE_RESULT_BASE64_MAX_BYTES) return inlineBase64;
  if (result.image.url) {
    const downloaded = await downloadBotUpscaleUrlAsBase64(result.image.url);
    return downloaded || result.image.url;
  }
  return inlineBase64 && inlineBase64.length < 6 * 1024 * 1024 ? inlineBase64 : '';
}

/** 下载小体积放大结果为 base64；超过上限时返回空，由调用方使用 URL 图片段。 */
async function downloadBotUpscaleUrlAsBase64(imageUrl: string): Promise<string> {
  try {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return '';
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) return '';
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > BOT_UPSCALE_RESULT_BASE64_MAX_BYTES) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= 0 || buffer.length > BOT_UPSCALE_RESULT_BASE64_MAX_BYTES) return '';
    return buffer.toString('base64');
  } catch (error) {
    console.warn('[bot] 放大结果 URL 转 base64 失败', { message: error instanceof Error ? error.message : String(error) });
    return '';
  }
}

/** 格式化 Bot 图片放大成功文本，保留源图和返回图尺寸，便于用户确认倍率和模型。 */
function formatBotImageUpscaleResult(result: ImageUpscaleRunResponse): string {
  return compactBotLines([
    markBotText('success', `放大完成 | ${result.scale}x`),
    `原图: ${result.source.width}x${result.source.height} ${formatBotBytes(result.source.sizeBytes)}`,
    `返回图: ${result.image.width}x${result.image.height} ${formatBotBytes(result.image.sizeBytes)}`,
    `模型: ${result.model}`,
    `耗时: ${formatBotSeconds(result.elapsedMs)}${result.queueWaitMs ? ` | 排队 ${formatBotSeconds(result.queueWaitMs)}` : ''}`,
  ]);
}

/** 将毫秒格式化为 Bot 简短秒数字符串。 */
function formatBotSeconds(ms: number | undefined): string {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0.0s';
  return `${(value / 1000).toFixed(1)}s`;
}

/** 将后端真实图片放大错误映射成 QQ 端可读提示。 */
function formatBotImageUpscaleError(message: string | undefined, status: number): string {
  const text = String(message ?? '').trim();
  const lower = text.toLowerCase();
  if (status === 413 || lower.includes('too large') || text.includes('过大')) return '图片过大，请压缩或降低放大倍率后重试。';
  if (status === 403 || lower.includes('token') || text.includes('令牌')) return '图片放大服务鉴权失败，请联系管理员检查 Bot 与 backend 配置。';
  if (status === 429 || text.includes('队列') || text.includes('排队')) return '图片放大队列繁忙，请稍后重试。';
  if (lower.includes('timeout') || text.includes('超时')) return '图片放大请求超时，请稍后重试或换一张更小的图片。';
  if (text.includes('倍率') || text.includes('像素')) return `图片放大失败：${truncate(text, 120)}`;
  return text ? `图片放大失败：${truncate(text, 160)}` : '图片放大失败，请稍后重试。';
}

/** 解析 `/提取` 的模式参数；模式后允许有补充说明，避免自然语言尾巴导致命令失败。 */
function parseReverseExtractCommand(commandText: string): { mode: ImageReverseMode; error?: string } {
  if (!commandText.startsWith(CMD)) return { mode: 'description' };
  const tail = readReverseExtractTail(commandText.slice(CMD.length).trim());
  const parts = tail.split(/\s+/).filter(Boolean);
  const modeArg = parts.find((part) => isReverseExtractModeToken(part));
  if (modeArg) return { mode: readReverseModeFromToken(modeArg) };
  // 反推不需要额外文本参数；无模式或混入“帮我提取一下”等说明时默认描述模式，避免 QQ 端自然语言误失败。
  return { mode: 'description' };
}

/** 去掉真实反推触发词，兼容“提取 tag”和“提取tag”两种输入。 */
function readReverseExtractTail(stripped: string): string {
  for (const trigger of getReverseExtractTriggers()) {
    if (stripped === trigger) return '';
    if (!stripped.startsWith(trigger)) continue;
    const tail = stripped.slice(trigger.length);
    if (!tail.trim()) return '';
    if (/^\s/.test(tail)) return tail.trim();
    if (isReverseExtractModeToken(tail.trim())) return tail.trim();
  }
  const [, ...rest] = stripped.split(/\s+/);
  return rest.join(' ').trim();
}

/** 判断反推模式词；只映射到 backend 真实支持的 description/tags。 */
function isReverseExtractModeToken(value: string): boolean {
  return /^(描述|描述模式|description|desc|提示词|prompt|绘图|角色|角色模式|character|编辑|edit|图生图|标签|标签模式|tag|tags|tag模式|tags模式|本地|本地模型)$/i.test(value.trim());
}

/** 判断是否为标签模式，其余合法模式词都归入描述模式。 */
function isReverseExtractTagModeToken(value: string): boolean {
  return /^(标签|标签模式|tag|tags|tag模式|tags模式|本地|本地模型)$/i.test(value.trim());
}

/** 将 QQ 端模式词映射到反推真实模式。 */
function readReverseModeFromToken(value: string): ImageReverseMode {
  const token = value.trim().toLowerCase();
  if (/^(标签|标签模式|tag|tags|tag模式|tags模式|本地|本地模型)$/i.test(token)) return 'tags';
  if (/^(提示词|prompt|绘图)$/i.test(token)) return 'prompt';
  if (/^(角色|角色模式|character)$/i.test(token)) return 'character';
  if (/^(编辑|edit|图生图)$/i.test(token)) return 'edit';
  return 'description';
}

/** 构造 Bot 反推默认选项；QQ 端同样固定最高详细度，避免角色和标签信息缺失。 */
function buildBotReverseOptions(mode: ImageReverseMode): ImageReverseExtractOptions {
  return {
    mode,
    language: {
      resultLanguageMode: mode === 'tags' ? 'single' : 'bilingual',
      primaryLanguage: 'zh',
      secondaryLanguage: mode === 'tags' ? undefined : 'en',
      promptLanguage: mode === 'description' ? 'zh' : 'auto',
    },
    detailLevel: 'forensic',
    sections: mode === 'tags'
      ? ['quality', 'character', 'details', 'composition', 'style', 'environment', 'negative']
      : mode === 'prompt'
      ? ['positive', 'negative', 'character', 'composition', 'style', 'background']
      : mode === 'character'
      ? ['profile', 'features', 'outfit', 'anchors', 'prompt', 'avoid']
      : mode === 'edit'
      ? ['summary', 'keep', 'change', 'remove', 'avoid', 'mapping', 'prompt']
      : ['overview', 'subjects', 'character', 'details', 'composition', 'style', 'drawingPrompt', 'negativePrompt'],
    tagPreset: 'sdxl',
    tagWeightMode: 'important',
    tagDensity: 'standard',
    promptTarget: 'general',
    characterConsistency: mode === 'character' ? 'strict' : 'standard',
    editIntent: mode === 'edit' ? 'auto' : undefined,
  };
}

/** 格式化 Bot 图片提取结果；只返回结果内容，不返回提交成功提示。 */
function formatBotReverseExtractResult(result: ImageReverseExtractResponse['result'], requestedMode: ImageReverseMode): string {
  if (result.mode === 'tags' || requestedMode === 'tags') {
    if (result.mode !== 'tags') return markBotText('failed', '图片提取结果模式不正确，请重试。');
    return formatBotReverseTagsResult(result);
  }
  if (result.mode === 'prompt') return formatBotReversePromptResult(result);
  if (result.mode === 'character') return formatBotReverseCharacterResult(result);
  if (result.mode === 'edit') return formatBotReverseEditResult(result);
  if (result.mode !== 'description') return markBotText('failed', '图片提取结果模式不正确，请重试。');
  return formatBotReverseDescriptionResult(result);
}

/** Prompt 模式返回可直接复制的提示词包。 */
function formatBotReversePromptResult(result: Extract<ImageReverseExtractResponse['result'], { mode: 'prompt' }>): string {
  return clampBotReplyText(compactBotLines([
    markBotText('success', '提取完成 | prompt'),
    formatBotReverseSourceLine(result),
    '',
    '正向:',
    result.positivePrompt,
    '',
    '反向:',
    result.negativePrompt,
    result.characterPrompt ? `\n角色:\n${result.characterPrompt}` : '',
  ]));
}

/** 角色模式返回角色锚点和复现 Prompt。 */
function formatBotReverseCharacterResult(result: Extract<ImageReverseExtractResponse['result'], { mode: 'character' }>): string {
  return clampBotReplyText(compactBotLines([
    markBotText('success', '提取完成 | 角色'),
    formatBotReverseSourceLine(result),
    result.summary ? `摘要: ${result.summary}` : '',
    result.identityAnchors.length ? `锚点: ${result.identityAnchors.slice(0, 10).join('；')}` : '',
    '',
    '角色复现:',
    result.reproductionPrompt || result.character.characterPrompt,
    result.avoidPrompt ? `\n避免:\n${result.avoidPrompt}` : '',
  ]));
}

/** 编辑模式返回图生图可用的保持/修改关系和最终 Prompt。 */
function formatBotReverseEditResult(result: Extract<ImageReverseExtractResponse['result'], { mode: 'edit' }>): string {
  return clampBotReplyText(compactBotLines([
    markBotText('success', '提取完成 | 编辑'),
    formatBotReverseSourceLine(result),
    result.keep.length ? `保持: ${joinBotReverseItems(result.keep, 8)}` : '',
    result.change.length ? `修改: ${joinBotReverseItems(result.change, 8)}` : '',
    result.avoid.length ? `禁止: ${joinBotReverseItems(result.avoid, 8)}` : '',
    result.referenceMapping.length ? `参考: ${joinBotReverseItems(result.referenceMapping, 6)}` : '',
    '',
    '编辑 Prompt:',
    result.editPrompt,
  ]));
}

/** 描述模式先返回原图事实，再返回适配不定数量参考图且不携带原角色特征的迁移提示词。 */
function formatBotReverseDescriptionResult(result: Extract<ImageReverseExtractResponse['result'], { mode: 'description' }>): string {
  const zh = result.localized.zh ?? result.localized['zh-CN'] ?? result;
  return clampBotReplyText(compactBotLines([
    markBotText('success', '提取完成 | 描述'),
    formatBotReverseSourceLine(result),
    '',
    zh.overview ? `摘要: ${zh.overview}` : '',
    zh.subjects.length ? `主体: ${joinBotReverseItems(zh.subjects, 8)}` : '',
    zh.details.length ? `细节: ${joinBotReverseItems(zh.details, 10)}` : '',
    zh.composition ? `构图: ${zh.composition}` : '',
    zh.style ? `风格: ${zh.style}` : '',
    zh.colorLighting ? `色光: ${zh.colorLighting}` : '',
    zh.backgroundAtmosphere ? `背景: ${zh.backgroundAtmosphere}` : '',
    zh.qualityTags.length ? `质量: ${zh.qualityTags.slice(0, 12).join('，')}` : '',
    '',
    '角色参考图保留提示词（参考图数量不限）:',
    zh.drawingPrompt || zh.overview,
    '',
    '参考图使用规则 / 生成约束:',
    zh.negativePrompt,
  ]));
}

/** 标签模式返回本地模型可直接使用的正向和负向 prompt。 */
function formatBotReverseTagsResult(result: Extract<ImageReverseExtractResponse['result'], { mode: 'tags' }>): string {
  const tagPrompt = result.tagPrompt;
  return clampBotReplyText(compactBotLines([
    markBotText('success', '提取完成 | tag'),
    formatBotReverseSourceLine(result),
    formatBotReverseTagStats(tagPrompt),
    '',
    '正向:',
    tagPrompt.positivePromptWithWeights || tagPrompt.positivePrompt,
    '',
    '负向:',
    tagPrompt.negativePromptWithWeights || tagPrompt.negativePrompt,
  ]));
}

/** 格式化反推图片来源元信息，便于 QQ 用户确认识别的是哪张图。 */
function formatBotReverseSourceLine(result: ImageReverseExtractResponse['result']): string {
  const source = result.source;
  const size = source.sizeBytes > 0 ? ` ${formatBotBytes(source.sizeBytes)}` : '';
  const model = result.model ? ` | 模型: ${result.model}` : '';
  return `图: ${source.width}x${source.height}${size}${model}`;
}

/** 汇总标签分类数量，确认 tag 模式真实拿到了结构化标签。 */
function formatBotReverseTagStats(tagPrompt: ImageReverseTagResultView): string {
  return [
    `画质${tagPrompt.qualityTags.length}`,
    `角色${tagPrompt.characterTags.length}`,
    `细节${tagPrompt.detailTags.length}`,
    `构图${tagPrompt.compositionTags.length}`,
    `风格${tagPrompt.styleTags.length}`,
    `环境${tagPrompt.environmentTags.length}`,
    `负向${tagPrompt.negativeTags.length}`,
  ].join(' · ');
}

/** 合并描述模式数组字段，控制单行长度但不丢弃主要信息。 */
function joinBotReverseItems(items: string[], maxItems: number): string {
  return items.map((item) => item.trim()).filter(Boolean).slice(0, maxItems).join('；');
}

/** 移除空行噪音，同时保留段落之间最多一个空行。 */
function compactBotLines(lines: Array<string | undefined>): string {
  const compacted: string[] = [];
  for (const raw of lines) {
    const line = String(raw ?? '').trim();
    const previous = compacted[compacted.length - 1];
    if (!line && (!previous || previous === '')) continue;
    compacted.push(line);
  }
  while (compacted[compacted.length - 1] === '') compacted.pop();
  return compacted.join('\n');
}

/** 格式化图片字节数，避免 QQ 文本里直接显示大整数。 */
function formatBotBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/** 将后端真实错误映射成 QQ 端可读提示，不隐藏原始关键信息。 */
function formatBotReverseError(message: string | undefined, status: number): string {
  const text = String(message ?? '').trim();
  const lower = text.toLowerCase();
  if (status === 413 || lower.includes('too large') || text.includes('过大')) return '图片过大，请压缩或换一张图片后重试。';
  if (status === 403 || lower.includes('token') || text.includes('令牌')) return '图片提取服务鉴权失败，请联系管理员检查 Bot 与 backend 配置。';
  if (lower.includes('timeout') || text.includes('超时')) return '图片提取请求超时，请稍后重试或换一张更小的图片。';
  if (lower.includes('content_filter') || lower.includes('prohibited_content') || text.includes('审核') || text.includes('拦截')) {
    return `模型拒绝识别或审核拦截：${truncate(text, 120, '可换图重试')}`;
  }
  return text ? `图片提取失败：${truncate(text, 160)}` : '图片提取失败，请稍后重试。';
}

/** 限制 QQ 文本长度，避免长标签结果超过协议端单消息上限。 */
function clampBotReplyText(text: string): string {
  const limit = Number(process.env.BOT_REVERSE_REPLY_MAX_CHARS ?? '3800');
  const safeLimit = Number.isFinite(limit) ? Math.max(800, Math.min(8000, Math.floor(limit))) : 3800;
  return text.length > safeLimit ? `${text.slice(0, safeLimit)}\n...（结果过长，已截断；可切换 tag/描述模式重新提取。）` : text;
}

/** 绘图命令：通过 backend 提交任务（backend 负责 QQ 余额扣费 + 投递 drawing-service，不要求网页绑定）。 */
async function createDrawAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, commandText: string) {
  // 仅剥离配置前缀+触发词，提取提示词
  if (!commandText.startsWith(CMD)) return createTextReplyAction(event, markBotText('failed', `请提供提示词：${cmdFor('draw')} <提示词>`), 'bot_draw_empty');
  const afterPrefix = commandText.slice(CMD.length);
  const parsedDraw = parseDrawPromptAndCountAndModel(afterPrefix.replace(/^\S+\s*/, '').trim());
  const prompt = parsedDraw.prompt;

  const promptNeedsReference = promptRequiresReferenceImage(prompt);
  // 从消息事件中提取图片 URL（本消息图片、贴纸、@头像、引用消息穿透）；明确图生图提示词会额外反查当前消息记录。
  const rawImageUrls = await extractImageUrlsFromEvent(event, { fetchCurrentMessage: promptNeedsReference });
  const localizedImages = await localizeReferenceImagesForGeneration(rawImageUrls);
  logBotDrawReferenceExtraction(event, prompt, rawImageUrls.length, localizedImages);
  const imageUrls = localizedImages.urls;
  const hasImages = imageUrls.length > 0;
  if (rawImageUrls.length === 0 && promptNeedsReference) {
    // 用户明确引用图1/图2/参考图但 OneBot 没有提供图片段时，不能静默按文生图提交并扣费。
    return createTextReplyAction(
      event,
      markBotText('failed', '未检测到参考图。请把图片和命令放在同一条消息重新发送，或回复/引用含图片的消息后再发送绘图命令。'),
      'bot_draw_ref_missing',
    );
  }
  if (rawImageUrls.length > 0 && localizedImages.omitted > 0) {
    // 参考图数量超过上限时必须阻断，不能静默丢弃后半部分参考图导致结果与用户预期不一致。
    return createTextReplyAction(
      event,
      markBotText('failed', `检测到 ${localizedImages.total} 张参考图，当前最多支持 ${localizedImages.maxAllowed} 张。请减少参考图后重新发送。`),
      'bot_draw_ref_too_many',
    );
  }
  if (rawImageUrls.length > 0 && localizedImages.failed > 0) {
    // 多参考图只成功一部分时继续生成会造成“参考图被忽略”的实际扣费问题，因此要求用户重新发送完整图片。
    return createTextReplyAction(
      event,
      markBotText('failed', `检测到 ${localizedImages.total} 张参考图，其中 ${localizedImages.failed} 张下载或暂存失败。为避免少图生成，请重新发送图片后再试。`),
      'bot_draw_ref_partial_fail',
    );
  }
  if (rawImageUrls.length > 0 && !hasImages) {
    // 参考图必须先落到 media-service 本地暂存，再进入绘图和卡片渲染链路；失败时不能降级成文生图误扣费。
    return createTextReplyAction(event, markBotText('failed', '参考图下载或暂存失败，请稍后重试，或重新发送图片后再绘图。'), 'bot_draw_ref_localize_fail');
  }

  if (!prompt && !hasImages) {
    return createTextReplyAction(event, markBotText('failed', `请提供提示词：${cmdFor('draw')} <提示词>`), 'bot_draw_empty');
  }
  if (!prompt && hasImages) {
    return createTextReplyAction(event, markBotText('failed', `请附带提示词描述你想要的修改效果：${cmdFor('draw')} <提示词> + 图片`), 'bot_draw_no_prompt');
  }

  // 冷却检查
  const qqNumber = String(event.user_id ?? event.sender?.user_id ?? '');
  const cooldownUntil = cooldownMap.get(qqNumber);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
    const cdB64 = await fetchCardImage('/render/draw-cooldown', { remainingSec: remaining, cmdPrefix: CMD, submitter: makeSubmitter(event) }, 'draw');
    if (cdB64) return createImageReplyAction(event, '', cdB64, 'bot_draw_cooldown');
    return createTextReplyAction(event, `⏳ 请等待 ${remaining} 秒后再使用绘图命令`, 'bot_draw_cooldown');
  }

  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const freshModels = await fetchBotModelOptionsFresh(BACKEND_URL);
    const availableModels = freshModels.length > 0 ? freshModels : await fetchBotModelOptionsCached(BACKEND_URL);
    const commandModel = parsedDraw.modelIndex ? availableModels[parsedDraw.modelIndex - 1] : undefined;
    if (parsedDraw.modelIndex && !commandModel) {
      return createTextReplyAction(event, markBotText('failed', `模型序号不存在，请先发送 ${cmdFor('model')} 查看可用模型。`), 'bot_draw_model_invalid');
    }
    const savedModel = parsedDraw.modelIndex ? undefined : await readBotModelPreferenceByQq(BACKEND_URL, qqNumber);
    const selectedModel = commandModel
      ?? availableModels.find((model) => model.name === savedModel)
      ?? availableModels.find((model) => model.isDefault)
      ?? availableModels[0];
    const preferredModel = selectedModel?.name ?? savedModel ?? undefined;
    const isLocalModel = selectedModel?.executionTarget === 'local_platform';
    const isVideoModel = selectedModel ? isBotVideoModel(selectedModel) : false;
    const hasVideoParams = parsedDraw.duration !== undefined || parsedDraw.resolution !== undefined || (parsedDraw.aspectRatio !== undefined && !isLocalModel);
    if (!isVideoModel && hasVideoParams) {
      return createTextReplyAction(event, markBotText('failed', 'd/r/a 是视频模型参数，请先用 m序号 选择视频模型。'), 'bot_draw_video_param_model_invalid');
    }
    if (isVideoModel && parsedDraw.count !== 1) {
      return createTextReplyAction(event, markBotText('failed', '视频模型每次只能生成 1 个结果，请移除 n数量 参数。'), 'bot_draw_video_count_invalid');
    }
    if (isLocalModel && parsedDraw.count !== 1) {
      return createTextReplyAction(event, markBotText('failed', '本地模型当前每次生成 1 张图片，请移除 n数量 参数。'), 'bot_draw_local_count_invalid');
    }
    if (isLocalModel && hasImages) {
      return createTextReplyAction(event, markBotText('failed', '当前本地 Anima 工作流仅支持文生图，请移除参考图。'), 'bot_draw_local_reference_invalid');
    }
    const nativeImageToImage = selectedModel?.capabilities?.imageToImage === true || selectedModel?.type === 'universal' || selectedModel?.type === 'image_to_image';
    // 模型开关开启时 Bot 默认执行 AI 提示增强；无参考图时同样扩写一次，有图时再转写图片。
    const referencePromptAssist = Boolean(!isVideoModel && selectedModel?.referencePromptAssistEnabled === true);
    if (hasImages && !isVideoModel && !nativeImageToImage && !referencePromptAssist) {
      return createTextReplyAction(event, markBotText('failed', '当前模型不支持参考图，且未在后台开放 AI 提示增强。'), 'bot_draw_reference_model_invalid');
    }
    if (referencePromptAssist && imageUrls.length > 4) {
      return createTextReplyAction(event, markBotText('failed', 'AI 提示增强最多接受 4 张参考图，请减少图片后重试。'), 'bot_draw_reference_assist_limit');
    }
    const mode: DrawingMode = isVideoModel
      ? (hasImages ? 'image-to-video' : 'text-to-video')
      : (hasImages && nativeImageToImage && !referencePromptAssist ? 'image-to-image' : 'text-to-image');
    console.log('[bot] draw model resolved', {
      qqNumber,
      modelIndex: parsedDraw.modelIndex ?? null,
      commandModel: commandModel?.name ?? null,
      savedModel: savedModel ?? null,
      preferredModel: preferredModel ?? null,
      modelType: selectedModel?.type ?? null,
      mode,
    });
    if (isLocalModel && selectedModel.localModelVersionId && selectedModel.localWorkflowVersionId) {
      const dimensions = resolveLocalBotDimensions(selectedModel.localDefaultParameters, parsedDraw.aspectRatio);
      const localRequest: LocalPlatformBotJobCreateRequest = {
        idempotencyKey: `bot-local-${String(event.self_id)}-${String(event.message_id ?? event.time)}-${qqNumber}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 191),
        qqNumber,
        displayName: event.sender?.nickname || `QQ ${qqNumber}`,
        modelVersionId: selectedModel.localModelVersionId,
        workflowVersionId: selectedModel.localWorkflowVersionId,
        prompt,
        negativePrompt: null,
        width: dimensions.width,
        height: dimensions.height,
        seed: null,
        loraVersionIds: [],
        // 最终隐私值由 backend 读取 QQ 持久化偏好后覆盖，Bot 不自行决定图库隐私。
        isPrivate: false,
      };
      const localResponse = await fetch(`${BACKEND_URL}/internal/bot/local-generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
        body: JSON.stringify(localRequest),
        signal: AbortSignal.timeout(BOT_GENERATE_SUBMIT_TIMEOUT_MS),
      });
      const localData = await localResponse.json().catch(() => ({})) as { ok?: boolean; data?: BotGenerationRetryResponse; message?: string };
      if (localData.ok && localData.data?.accepted) {
        return createSubmittedAction(event, localData.data, {
          qqNumber,
          prompt,
          imageUrls: [],
          fallbackMode: 'text-to-image',
          echoPrefix: 'bot_draw_local_ok',
          submittedLabel: '本地绘图任务已提交',
        });
      }
      return createTextReplyAction(event, markBotText('failed', localData.message ?? '本地模型任务提交失败'), 'bot_draw_local_fail');
    }
    const request: BotGenerationCreateRequest = {
      qqNumber: String(event.user_id),
      botSelfId: String(event.self_id),
      deliveryTarget: buildBotDeliveryTarget(event),
      prompt,
      count: isVideoModel ? 1 : parsedDraw.count,
      mode,
      sourceImageUrls: hasImages ? imageUrls : undefined,
      // m 序号只影响本次绘图；未指定时读取 backend 持久化的 QQ 首选模型。
      preferredModel,
      duration: isVideoModel ? parsedDraw.duration ?? 5 : undefined,
      resolution: isVideoModel ? parsedDraw.resolution ?? '720p' : undefined,
      aspectRatio: isVideoModel ? parsedDraw.aspectRatio ?? '16:9' : undefined,
      // Bot 视频任务默认开启分镜设计，backend 仍按所选模型开关做最终裁决。
      storyboardDesign: isVideoModel ? true : undefined,
      // Bot 对后台已开放模型默认开启 AI 提示增强，参考图是可选输入。
      referencePromptAssist: referencePromptAssist ? true : undefined,
    };
    console.log('[bot] backend generate submit params', {
      qqNumber,
      botSelfId: String(event.self_id ?? ''),
      mode: request.mode,
      sourceImageCount: request.sourceImageUrls?.length ?? 0,
      sourceImageUrls: request.sourceImageUrls ?? [],
      count: request.count,
      preferredModel: preferredModel ?? null,
      duration: request.duration ?? null,
      resolution: request.resolution ?? null,
      aspectRatio: request.aspectRatio ?? null,
      storyboardDesign: request.storyboardDesign ?? null,
      referencePromptAssist: request.referencePromptAssist ?? null,
    });
    const res = await fetch(`${BACKEND_URL}/internal/bot/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(BOT_GENERATE_SUBMIT_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: BotGenerationRetryResponse; message?: string };
    if (data.ok && data.data?.accepted) {
      return createSubmittedAction(event, data.data, {
        qqNumber,
        prompt,
        imageUrls,
        fallbackMode: mode,
        echoPrefix: 'bot_draw_ok',
        submittedLabel: isVideoModel ? '视频任务已提交' : '绘图任务已提交',
      });
    }
    if (data.message?.includes('余额不足')) {
      const details = (data as any).details as { freeBalance?: string; paidBalance?: string } | undefined;
      const qb64 = await fetchCardImage('/render/draw-quota-exceeded', {
        freeBalance: details?.freeBalance ?? '0',
        paidBalance: details?.paidBalance ?? '0',
        cmdPrefix: CMD,
        submitter: makeSubmitter(event),
      }, 'draw');
    if (qb64) return createImageReplyAction(event, '', qb64, 'bot_draw_quota');
    return createTextReplyAction(event, markBotText('failed', `余额不足 | 余额: ${formatBotCompactBalanceText(details?.freeBalance ?? '0', details?.paidBalance ?? '0')}`), 'bot_draw_quota');
    }
    return createTextReplyAction(event, markBotText('failed', data.message ?? '提交失败'), 'bot_draw_fail');
  } catch {
    return createTextReplyAction(event, markBotText('failed', '绘图服务暂不可用'), 'bot_draw_down');
  }
}

/** 解析多图数量 token，兼容 n3、n=3、n:3、n：3，其他文本全部保留为提示词。 */
function parseDrawCountToken(token: string): number | undefined {
  const match = token.trim().match(/^n(?:\s*[=:：]?\s*)([1-9]\d{0,2})$/i);
  if (!match) return undefined;
  return Math.max(1, Math.min(Number(match[1]), 20));
}

/** 解析独立数字 token，供 `n 3` 这种两段式数量参数使用。 */
function parseDrawCountNumberToken(token: string): number | undefined {
  const match = token.trim().match(/^([1-9]\d{0,2})$/);
  if (!match) return undefined;
  return Math.max(1, Math.min(Number(match[1]), 20));
}

/** 解析模型序号 token，兼容 m1、m=1、m:1、m：1。 */
function parseDrawModelToken(token: string): number | undefined {
  const match = token.trim().match(/^m(?:\s*[=:：]?\s*)([1-9]\d{0,2})$/i);
  if (!match) return undefined;
  return Math.max(1, Math.min(Number(match[1]), 999));
}

/** 解析独立模型序号数字，供 `m 1` 这种两段式参数使用。 */
function parseDrawModelNumberToken(token: string): number | undefined {
  const match = token.trim().match(/^([1-9]\d{0,2})$/);
  if (!match) return undefined;
  return Math.max(1, Math.min(Number(match[1]), 999));
}

/** 解析视频时长 token，只接受已登记的 d1..15 形式。 */
function parseDrawVideoDurationToken(token: string): number | undefined {
  const match = token.trim().match(/^d(?:\s*[=:：]?\s*)(\d{1,2})$/i);
  const duration = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(duration) && duration >= 1 && duration <= 15 ? duration : undefined;
}

/** 解析视频分辨率 token，只接受真实上游支持的三个档位。 */
function parseDrawVideoResolutionToken(token: string): DrawingVideoResolution | undefined {
  const match = token.trim().match(/^r(?:\s*[=:：]?\s*)(480p|720p|1080p)$/i);
  return match ? match[1].toLowerCase() as DrawingVideoResolution : undefined;
}

/** 解析视频画幅 token，只接受 Grok 视频端点已验证的七种比例。 */
function parseDrawVideoAspectRatioToken(token: string): DrawingAspectRatio | undefined {
  const match = token.trim().match(/^a(?:\s*[=:：]?\s*)(1:1|16:9|9:16|4:3|3:4|3:2|2:3)$/i);
  return match ? match[1] as DrawingAspectRatio : undefined;
}

/** 解析 `/绘图 m1 n2 d5 r720p a16:9 提示词` 的首尾参数；中间文本始终保留为提示词。 */
function parseDrawPromptAndCountAndModel(text: string): { prompt: string; count: number; modelIndex?: number; duration?: number; resolution?: DrawingVideoResolution; aspectRatio?: DrawingAspectRatio } {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { prompt: '', count: 1 };

  let start = 0;
  let end = tokens.length;
  let count = 1;
  let modelIndex: number | undefined;
  let duration: number | undefined;
  let resolution: DrawingVideoResolution | undefined;
  let aspectRatio: DrawingAspectRatio | undefined;

  const applyParam = (kind: 'count' | 'model', value: number) => {
    if (kind === 'count') count = value;
    else modelIndex = value;
  };
  const applyVideoParam = (token: string): boolean => {
    const durationValue = parseDrawVideoDurationToken(token);
    if (durationValue !== undefined) { duration = durationValue; return true; }
    const resolutionValue = parseDrawVideoResolutionToken(token);
    if (resolutionValue !== undefined) { resolution = resolutionValue; return true; }
    const aspectRatioValue = parseDrawVideoAspectRatioToken(token);
    if (aspectRatioValue !== undefined) { aspectRatio = aspectRatioValue; return true; }
    return false;
  };

  // 开头参数组支持 m/n 任意顺序，例如 m1 n2 或 n2 m1。
  for (;;) {
    const token = tokens[start];
    if (!token || start >= end) break;
    const countValue = parseDrawCountToken(token);
    if (countValue !== undefined) { applyParam('count', countValue); start += 1; continue; }
    const modelValue = parseDrawModelToken(token);
    if (modelValue !== undefined) { applyParam('model', modelValue); start += 1; continue; }
    if (applyVideoParam(token)) { start += 1; continue; }
    if (/^n$/i.test(token) && start + 1 < end) {
      const splitCount = parseDrawCountNumberToken(tokens[start + 1]);
      if (splitCount !== undefined) { applyParam('count', splitCount); start += 2; continue; }
    }
    if (/^m$/i.test(token) && start + 1 < end) {
      const splitModel = parseDrawModelNumberToken(tokens[start + 1]);
      if (splitModel !== undefined) { applyParam('model', splitModel); start += 2; continue; }
    }
    break;
  }

  // 结尾参数组同样支持任意顺序，方便用户把 n/m 放在提示词最后。
  for (;;) {
    const token = tokens[end - 1];
    if (!token || start >= end) break;
    const countValue = parseDrawCountToken(token);
    if (countValue !== undefined) { applyParam('count', countValue); end -= 1; continue; }
    const modelValue = parseDrawModelToken(token);
    if (modelValue !== undefined) { applyParam('model', modelValue); end -= 1; continue; }
    if (applyVideoParam(token)) { end -= 1; continue; }
    if (/^n$/i.test(tokens[end - 2] ?? '') && end - 2 >= start) {
      const splitCount = parseDrawCountNumberToken(token);
      if (splitCount !== undefined) { applyParam('count', splitCount); end -= 2; continue; }
    }
    if (/^m$/i.test(tokens[end - 2] ?? '') && end - 2 >= start) {
      const splitModel = parseDrawModelNumberToken(token);
      if (splitModel !== undefined) { applyParam('model', splitModel); end -= 2; continue; }
    }
    break;
  }

  return { prompt: tokens.slice(start, end).join(' ').trim(), count, modelIndex, duration, resolution, aspectRatio };
}

/** Bot 重试命令：复用最近一次历史任务参数，重新提交新任务并返回标准提交回执。 */
async function createRetryAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>) {
  const qqNumber = String(event.sender?.user_id ?? event.user_id ?? '');
  const cooldownUntil = cooldownMap.get(qqNumber);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
    const cdB64 = await fetchCardImage('/render/draw-cooldown', { remainingSec: remaining, cmdPrefix: CMD, submitter: makeSubmitter(event) }, 'retry');
    if (cdB64) return createImageReplyAction(event, '', cdB64, 'bot_retry_cooldown');
    return createTextReplyAction(event, `⏳ 请等待 ${remaining} 秒后再使用重试命令`, 'bot_retry_cooldown');
  }

  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const request: BotGenerationRetryRequest = {
      qqNumber: String(event.user_id),
      botSelfId: String(event.self_id),
      deliveryTarget: buildBotDeliveryTarget(event),
    };
    const res = await fetch(`${BACKEND_URL}/internal/bot/generate/retry-latest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(BOT_GENERATE_SUBMIT_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: BotGenerationRetryResponse; message?: string; details?: { freeBalance?: string; paidBalance?: string } };
    if (data.ok && data.data?.accepted) {
      return createSubmittedAction(event, data.data, {
        qqNumber,
        prompt: data.data.prompt,
        imageUrls: data.data.sourceImageUrls,
        // Bot 复投完整保留历史图片或视频模式，实际参数由 backend 快照返回。
        fallbackMode: data.data.mode,
        echoPrefix: 'bot_retry_ok',
        submittedLabel: '重试任务已提交',
      });
    }
    if (data.message?.includes('余额不足')) {
      const details = data.details;
      const qb64 = await fetchCardImage('/render/draw-quota-exceeded', {
        freeBalance: details?.freeBalance ?? '0',
        paidBalance: details?.paidBalance ?? '0',
        cmdPrefix: CMD,
        submitter: makeSubmitter(event),
      }, 'retry');
      if (qb64) return createImageReplyAction(event, '', qb64, 'bot_retry_quota');
      return createTextReplyAction(event, markBotText('failed', `余额不足 | 余额: ${formatBotCompactBalanceText(details?.freeBalance ?? '0', details?.paidBalance ?? '0')}`), 'bot_retry_quota');
    }
    return createTextReplyAction(event, markBotText('failed', data.message ?? '没有可重试任务'), 'bot_retry_fail');
  } catch {
    return createTextReplyAction(event, markBotText('failed', '重试服务暂不可用'), 'bot_retry_down');
  }
}

/** 创建标准绘图提交回执，并登记 pendingTasks 以继续投递最终结果。 */
async function createSubmittedAction(
  event: Extract<OneBotWsEvent, { post_type: 'message' }>,
  info: BotGenerationRetryResponse,
  options: {
    qqNumber: string;
    prompt: string;
    imageUrls: string[];
    fallbackMode: DrawingMode;
    echoPrefix: string;
    submittedLabel: string;
  },
) {
  const isPrivate = info.isPrivate === true;
  const privacyText = isPrivate ? '私密' : '公开';
  cacheBinding(String(info.qqNumber ?? options.qqNumber), { username: info.bindingUsername, userId: info.bindingUserId });
  cooldownMap.set(options.qqNumber, Date.now() + botCooldownSeconds * 1000);
  const mode = info.mode || options.fallbackMode;
  const fallbackModel = info.preferredModel || await readBotModelPreferenceByQq(process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369', options.qqNumber);
  const model = fallbackModel || DEFAULT_MODEL;
  const nowTs = Date.now();
  const sourceImageUrls = options.imageUrls;

  ensureTaskPoller();
  const taskIds = Array.isArray(info.taskIds) && info.taskIds.length > 0 ? info.taskIds : [String(info.taskId ?? '')];
  const batchId = typeof info.batchId === 'string' && info.batchId ? info.batchId : undefined;
  const batchTotal = Number.isSafeInteger(info.batchTotal) ? Number(info.batchTotal) : taskIds.length;
  taskIds.forEach((taskId, index) => {
    if (!taskId) return;
    pendingTasks.set(taskId, {
      qq: options.qqNumber,
      botSelfId: String(event.self_id),
      event,
      // backend 视频分镜开启时返回重新设计后的提示词摘要，后续回执应展示真实提交内容。
      prompt: info.prompt || options.prompt,
      model,
      mode,
      duration: info.duration,
      resolution: info.resolution,
      aspectRatio: info.aspectRatio,
      batchId,
      batchIndex: batchId ? index + 1 : undefined,
      batchTotal: batchId ? batchTotal : undefined,
      charged: info.charged ?? false,
      chargedAmount: info.chargedAmount ?? '0',
      paidBalance: info.paidBalance ?? '0',
      freeBalance: info.freeBalance ?? '0',
      isPrivate,
      // 历史复投继续使用 backend 返回的站内参考图路径，避免重新抓取 QQ 临时图导致链路错配。
      imageUrls: sourceImageUrls,
      createdAt: nowTs,
      startedAt: new Date(nowTs).toISOString(),
      lastNotifiedAttempt: 0,
    });
  });
  persistPendingTasks();

  // 提交回执按 QQ 文本消息直接返回，避免图片卡片成功时和用户指定的简洁文本格式不一致。
  const submitModel = await formatBotModelDisplayByName(process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369', model) || '自动';
  const refCount = info.imageCount ?? sourceImageUrls.length;
  const requestedCount = taskIds.length;
  const isVideoTask = mode === 'text-to-video' || mode === 'image-to-video';
  const submitText = [
    markBotText('submitted', `${options.submittedLabel}${taskIds.length > 1 ? ` ${taskIds.length}张` : ''}-${privacyText}`),
    isVideoTask ? formatBotSubmitVideoFlow(refCount) : formatBotSubmitImageFlow(refCount, requestedCount),
    ...(isVideoTask ? [`规格：${info.aspectRatio ?? '16:9'} · ${info.resolution ?? '720p'} · ${info.duration ?? 5}秒`] : []),
    `模型：${submitModel}`,
    `费用：${formatBotChargeText(info.charged ?? false, info.chargedAmount)}`,
    `余额：${formatBotCompactBalanceText(info.freeBalance, info.paidBalance)}`,
  ].join('\n');
  return createTextReplyAction(event, submitText, options.echoPrefix);
}

/** 任务统计查询：当前 QQ 或全站排行，数据只来自 backend 真实聚合接口。 */
async function createGenerationStatsAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, scope: 'mine' | 'all') {
  try {
    const stats = await queryBotGenerationStatsByBackend(scope, scope === 'mine' ? String(event.user_id) : undefined);
    const card64 = await fetchCardImage('/render/generation-stats', { ...stats, submitter: makeSubmitter(event) }, 'generation_stats');
    if (card64) return createImageReplyAction(event, '', card64, 'bot_generation_stats_ok');
    const total = stats.buckets.find((item) => item.key === 'total');
    const today = stats.buckets.find((item) => item.key === 'today');
    if (scope === 'all') {
      const ranking = (stats.ranking ?? []).slice(0, 10).map((item: { rank: number; qqNumber: string; total: number; successRate: number }) =>
        `${item.rank}. QQ ${item.qqNumber}：${item.total}次，成功率 ${item.successRate.toFixed(1)}%`
      );
      return createTextReplyAction(event, [
        markBotText('success', '全站生成统计'),
        `累计：${total?.total ?? 0} 次，成功 ${total?.success ?? 0}，失败 ${total?.failed ?? 0}`,
        `今日：${today?.total ?? 0} 次，进行中 ${today?.active ?? 0}`,
        ranking.length ? `排行：\n${ranking.join('\n')}` : '暂无排行数据',
      ].join('\n'), 'bot_generation_stats_ok');
    }
    return createTextReplyAction(event, [
      markBotText('success', `QQ ${event.user_id} 的生成统计`),
      `累计：${total?.total ?? 0} 次，成功 ${total?.success ?? 0}，失败 ${total?.failed ?? 0}，成功率 ${(total?.successRate ?? 0).toFixed(1)}%`,
      `今日：${today?.total ?? 0} 次，图生图 ${today?.imageToImage ?? 0}，文生图 ${today?.textToImage ?? 0}`,
      `扣费合计：¥${total?.chargedAmount ?? '0.00'}`,
    ].join('\n'), 'bot_generation_stats_ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : '统计服务暂不可用';
    return createTextReplyAction(event, markBotText('failed', `统计查询失败：${message}`), 'bot_generation_stats_down');
  }
}

/** 站点状态查询：backend 队列 + drawing-service 站点健康。 */
async function createStatsAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>) {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  const DRAWING_URL = process.env.DRAWING_SERVICE_URL ?? 'http://localhost:3005';
  try {
    // 并发查询内部任务统计和 drawing-service 站点状态；不走 admin JWT 接口，避免 Bot 内部命令绕权限。
    const [statsRes, siteRes] = await Promise.allSettled([
      queryBotGenerationStatsByBackend('all'),
      fetch(`${DRAWING_URL}/api/drawing/site-stats`, { signal: AbortSignal.timeout(5000) }),
    ]);

    const lines: string[] = [];

    // Backend 队列统计使用 /internal/bot/stats 的全站真实聚合桶。
    if (statsRes.status === 'fulfilled') {
      const today = statsRes.value.buckets.find((item) => item.key === 'today');
      const total = statsRes.value.buckets.find((item) => item.key === 'total');
      lines.push(`📊 任务：今日 ${today?.total ?? 0} · 进行中 ${total?.active ?? 0} · 今日失败 ${today?.failed ?? 0}`);
    }

    // 站点状态（优先用 backend 富数据，含成功率/延迟）
    let siteData: any[] = [];
    try {
      const bsRes = await fetch(`${BACKEND_URL}/internal/bot/site-stats`, {
        headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
        signal: AbortSignal.timeout(5000),
      });
      if (bsRes.ok) {
        const bd = await bsRes.json().catch(() => ({})) as { ok?: boolean; data?: { sites: any[] } };
        if (bd.ok && bd.data?.sites) siteData = bd.data.sites;
      }
    } catch { /* fallback to drawing-service */ }
    // 回退：drawing-service 站点数据
    if (siteData.length === 0 && siteRes.status === 'fulfilled' && siteRes.value.ok) {
      const d = await siteRes.value.json().catch(() => ({})) as { ok?: boolean; data?: { sites: any[] } };
      if (d.ok && d.data?.sites) siteData = d.data.sites;
    }
    if (siteData.length > 0) {
      siteData = await Promise.all(siteData.map(async (site: any) => ({
        ...site,
        // 站点状态卡片是展示面，真实站点模型配置仍保存在 backend/drawing-service。
        model: await formatBotModelDisplayByName(BACKEND_URL, site.model),
      })));
      const siteLines = siteData.map((s: any) =>
        `${s.isEnabled ? '🟢' : '🔴'} ${s.name}${s.consecutiveFailures > 0 ? ` (${s.consecutiveFailures}连败)` : ''}${s.successRate != null ? ` ${s.successRate}%` : ''}`
      );
      lines.push(`站点：${siteLines.join(' · ')}`);
    }

    if (lines.length > 0) {
      const ss64 = await fetchCardImage('/render/site-status', { sites: siteData, submitter: makeSubmitter(event) });
      if (ss64) return createImageReplyAction(event, '', ss64, 'bot_stats_ok');
      return createTextReplyAction(event, lines.join('\n'), 'bot_stats_ok');
    }
    return createTextReplyAction(event, '站点状态查询失败。', 'bot_stats_fail');
  } catch {
    return createTextReplyAction(event, '站点状态服务暂不可用。', 'bot_stats_down');
  }
}

/** 任务查询：/任务 [success|failed|running|all]。从 backend 拉取最近任务，支持状态筛选。 */
async function createTasksAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, filter?: string) {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  const statusFilter = filter === 'success' || filter === 'failed' || filter === 'running' ? filter : 'all';
  try {
    const statusParam = filter === 'success' || filter === 'failed' || filter === 'running' ? `?status=${filter}` : '';
    const url = filter === 'all'
      ? `${BACKEND_URL}/internal/generations/recent${statusParam}`
      : `${BACKEND_URL}/internal/generations/by-qq/${event.user_id}${statusParam}`;
    const res = await fetch(url, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: BotGenerationTaskListResponse };
    if (data.ok && data.data?.items?.length) {
      const tasks = await Promise.all(data.data.items.map(async (t) => ({
        id: t.id, status: t.status as 'success'|'failed'|'running'|'finalizing'|'queued', prompt: t.prompt, mode: t.mode ?? 'text-to-image',
        model: await formatBotModelDisplayByName(BACKEND_URL, t.model), siteName: t.siteName, createdAt: t.createdAt ?? '', startedAt: t.startedAt, finishedAt: t.finishedAt,
        latencyMs: t.latencyMs, latencySec: t.latencyMs ? (t.latencyMs / 1000).toFixed(1) : undefined,
        attemptCount: t.attemptCount, failedAttemptCount: t.failedAttemptCount, retryCount: t.retryCount, imageCount: t.imageCount,
        charged: t.charged, chargedAmount: t.chargedAmount, refunded: t.status === 'failed',
        error: t.error,
      })));
      const tc64 = await fetchCardImage('/render/task-list', { tasks, filter: statusFilter, total: data.data.total, cmdPrefix: CMD, submitter: makeSubmitter(event) });
      if (tc64) return createImageReplyAction(event, '', tc64, 'bot_tasks_ok');
      return createTextReplyAction(event, buildTaskListText(tasks, statusFilter, data.data.total, CMD), 'bot_tasks_ok');
    }
    return createTextReplyAction(event, `暂无生成记录，使用 ${cmdFor('draw')} 开始创作吧。`, 'bot_tasks_empty');
  } catch {
    return createTextReplyAction(event, '任务查询暂不可用。', 'bot_tasks_down');
  }
}

/** 生成纯文本任务菜单，作为卡片渲染失败时的真实回退。 */
function buildTaskListText(tasks: Array<{
  id: string;
  status: 'success' | 'failed' | 'running' | 'finalizing' | 'queued';
  prompt: string;
  mode: string;
  model?: string;
  siteName?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  latencyMs?: number;
  latencySec?: string;
  attemptCount?: number;
  failedAttemptCount?: number;
  retryCount?: number;
  imageCount?: number;
  charged?: boolean;
  chargedAmount?: string;
  refunded?: boolean;
  error?: string;
}>, filter: string, total: number | undefined, cmdPrefix: string): string {
  const themeLabel = filter === 'all' ? '全部' : filter === 'success' ? '成功' : filter === 'failed' ? '失败' : filter === 'running' ? '生成中' : filter === 'finalizing' ? '收尾中' : '排队中';
  const summary = summarizeTasks(tasks);
  const lines = [
    `任务菜单 · ${themeLabel}`,
    total != null ? `当前筛选：${total} 条` : '当前筛选：最近任务',
    `状态：进行中 ${summary.active} · 成功 ${summary.success} · 失败 ${summary.failed} · 失败未扣费 ${summary.refunded}`,
    '',
  ];
  if (tasks.length === 0) {
    lines.push(`暂无匹配任务，发送 ${cmdPrefix}绘图 提示词 创建新任务。`);
    return lines.join('\n');
  }

  tasks.slice(0, 8).forEach((task, index) => {
    const meta: string[] = [];
    meta.push(task.status === 'success' ? '成功' : task.status === 'failed' ? '失败' : task.status === 'finalizing' ? '收尾中' : task.status === 'running' ? '生成中' : '排队中');
    meta.push(task.mode === 'image-to-image' ? '图生图' : '文生图');
    if (task.siteName) meta.push(task.siteName);
    if (task.model) meta.push(task.model);
    const duration = formatBotTaskDuration(task.latencyMs);
    if (duration) meta.push(duration);
    const attempts = formatTaskAttempts(task);
    if (attempts) meta.push(attempts);
    if (task.imageCount != null && task.imageCount > 0) meta.push(`${task.imageCount}图`);
    lines.push(`${index + 1}. ${truncate(task.prompt, 28, '未提供提示词')} [${meta.join(' · ')}]`);
    lines.push(`   ${formatBotTaskTime(task.createdAt)} · ${task.id.slice(-12)}${task.error && task.status === 'failed' ? ` · ${truncate(task.error, 40)}` : ''}${task.status === 'failed' ? ' · 未扣费' : ''}`);
  });
  lines.push('', `发送 ${cmdPrefix}任务 success | failed | running | all 可筛选。`);
  return lines.join('\n');
}

/** 汇总当前文本回退中的任务状态与费用。 */
function summarizeTasks(tasks: Array<{ status: 'success' | 'failed' | 'running' | 'finalizing' | 'queued'; charged?: boolean; chargedAmount?: string }>) {
  const active = tasks.filter((item) => item.status === 'running' || item.status === 'finalizing' || item.status === 'queued').length;
  const success = tasks.filter((item) => item.status === 'success').length;
  const failed = tasks.filter((item) => item.status === 'failed').length;
  const refunded = tasks.filter((item) => item.status === 'failed').length;
  const cost = tasks.reduce((sum, item) => {
    if (item.status === 'failed') return sum;
    const amount = Number(item.chargedAmount ?? '0');
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
  return { active, success, failed, refunded, cost: `¥${cost.toFixed(2)}` };
}

/** Bot 任务文本兜底：日期时间保持短格式，避免 QQ 文本过长。 */
function formatBotTaskTime(value?: string): string {
  if (!value) return '--:--';
  const normalized = value.replace('T', ' ');
  const monthDay = normalized.slice(5, 10);
  const time = normalized.slice(11, 16);
  return monthDay && time ? `${monthDay} ${time}` : value.slice(0, 16);
}

/** Bot 任务文本兜底：耗时使用真实毫秒值，不做估算。 */
function formatBotTaskDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/** 文本回退专用短截断，避免依赖 renderer 的共享函数导入。 */
function truncate(value: string, max: number, fallback = ''): string {
  const text = String(value ?? '').trim() || fallback;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Bot 任务文本兜底：尝试次数使用真实聚合字段。 */
function formatTaskAttempts(task: { attemptCount?: number; failedAttemptCount?: number; retryCount?: number }): string {
  if (typeof task.attemptCount === 'number' && task.attemptCount > 0) {
    return task.failedAttemptCount && task.failedAttemptCount > 0
      ? `${task.attemptCount}次/${task.failedAttemptCount}败`
      : `${task.attemptCount}试`;
  }
  if (typeof task.retryCount === 'number' && task.retryCount > 0) return `重试${task.retryCount}次`;
  return '';
}

/** Bot 可选模型；name 是统一主模型名，requestModelNames 对应站点真实请求名。 */
type BotModelOption = {
  name: string;
  label?: string;
  aliases?: string[];
  /** 与主模型等价的上游请求模型名。 */
  requestModelNames?: string[];
  weight?: number;
  isDefault?: boolean;
  /** 模型业务类型；video 同时支持文生视频和参考图视频。 */
  type?: 'universal' | 'text_to_image' | 'image_to_image' | 'video' | 'text';
  /** Bot 按真实能力决定生成模式，不能把视频模型降级为图片。 */
  capabilities?: { textToImage?: boolean; imageToImage?: boolean; textToVideo?: boolean; imageToVideo?: boolean };
  /** 文生图模型是否允许 Bot 默认使用 AI 提示增强；参考图为可选输入。 */
  referencePromptAssistEnabled?: boolean;
  /** 模型执行目标；本地模型由独立平台负责调度、计费镜像和产物。 */
  executionTarget?: 'upstream' | 'local_platform';
  localModelVersionId?: string;
  localWorkflowVersionId?: string;
  localDefaultParameters?: Record<string, unknown>;
};
/** Bot 模型列表短缓存，避免任务轮询和最终回执在高并发时反复请求 backend。 */
let botModelOptionsCache: { backendUrl: string; expiresAt: number; models: BotModelOption[] } | null = null;

/** 模型查询/切换：/模型 列出序号模型，/模型 <序号> 切换个人首选模型。 */
async function createModelsAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, commandText: string) {
  const modelInput = commandText.replace(/^\/(?:模型|models)\s*/i, '').trim();
  const qq = String(event.user_id);
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  const models = await fetchBotModelOptionsFresh(BACKEND_URL);

  // 带参数：切换偏好
  if (modelInput) {
    const matched = findBotModelByInput(models, modelInput);
    if (!matched) {
      return createTextReplyAction(event, `模型序号不存在。发送 ${cmdFor('model')} 查看可用模型。`, 'bot_models_invalid');
    }
    const selectedName = matched.name;
    const selectedDisplay = formatBotModelDisplay(matched);
    const saved = await saveBotModelPreferenceByQq(BACKEND_URL, qq, selectedName);
    if (!saved) {
      return createTextReplyAction(event, '模型偏好保存失败，请稍后重试。', 'bot_models_save_fail');
    }
    const ms64 = await fetchCardImage('/render/model-switched', { modelName: selectedDisplay, cmdPrefix: CMD, submitter: makeSubmitter(event) });
    if (ms64) return createImageReplyAction(event, '', ms64, 'bot_models_switch');
    return createTextReplyAction(event, `已切换首选模型为：${selectedDisplay}`, 'bot_models_switch');
  }

  // 无参数：列出模型 + 显示当前偏好
  const current = await readBotModelPreferenceByQq(BACKEND_URL, qq);
  try {
    if (models.length > 0) {
      const modelNames = models.map(m => m.name);
      const ml64 = await fetchCardImage('/render/model-list', { models, currentModel: current || modelNames[0] || DEFAULT_MODEL, cmdPrefix: CMD, submitter: makeSubmitter(event) });
      if (ml64) return createImageReplyAction(event, '', ml64, 'bot_models_ok');
      const lines = models.map((m, index) => formatBotModelListLine(m, index + 1, m.name === current)).join('\n');
      return createTextReplyAction(event, `可用模型：\n${lines}\n\n使用 ${cmdFor('model')} 序号 切换默认模型；绘图时可用 m序号 临时指定模型。`, 'bot_models_ok');
    }
    return createTextReplyAction(event, '模型查询失败。', 'bot_models_fail');
  } catch {
    return createTextReplyAction(event, '模型服务暂不可用。', 'bot_models_down');
  }
}

/** 从 backend 读取已合并模型设置的列表，只保留 Bot 切换需要的安全展示字段。 */
async function fetchBotModelOptions(backendUrl: string): Promise<BotModelOption[]> {
  try {
    const headers = { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' };
    const [res, localRes] = await Promise.all([
      fetch(`${backendUrl}/api/drawing/models`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${backendUrl}/internal/bot/local-models`, { headers, signal: AbortSignal.timeout(8000) }),
    ]);
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { models: BotModelOption[] } };
    const localData = await localRes.json().catch(() => ({})) as LocalPlatformBotCatalogResponse;
    const upstreamModels = data.ok && Array.isArray(data.data?.models) ? data.data.models : [];
    const normalizedUpstream = upstreamModels
      // Bot 同时开放图片和视频媒体模型，纯文本模型仍不进入绘图选择。
      .filter((item) => Boolean(item.capabilities?.textToImage || item.capabilities?.imageToImage || item.capabilities?.textToVideo || item.capabilities?.imageToVideo))
      .map((item) => ({
        name: String(item.name ?? '').trim(),
        label: String(item.label ?? '').trim() || undefined,
        aliases: Array.isArray(item.aliases) ? item.aliases.map((alias) => String(alias).trim()).filter(Boolean) : [],
        weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
        isDefault: item.isDefault === true,
        type: item.type,
        capabilities: item.capabilities,
        referencePromptAssistEnabled: item.referencePromptAssistEnabled === true,
        executionTarget: 'upstream' as const,
      }))
      .filter((item) => item.name);
    const localModels: BotModelOption[] = localData.ok === true ? localData.data.models.map((item) => ({
      name: `local:${item.modelVersionId}`,
      label: item.displayName,
      aliases: [],
      weight: -100,
      type: 'text_to_image',
      capabilities: { textToImage: true, imageToImage: false, textToVideo: false, imageToVideo: false },
      // 本地模型的提示增强开关由独立平台目录返回，Bot 菜单只展示能力，不复制执行逻辑。
      referencePromptAssistEnabled: item.defaultParameters.promptEnhancementEnabled === true,
      executionTarget: 'local_platform',
      localModelVersionId: item.modelVersionId,
      localWorkflowVersionId: item.workflowVersionId,
      localDefaultParameters: item.defaultParameters,
    })) : [];
    return [...normalizedUpstream, ...localModels];
  } catch {
    return [];
  }
}

/** 按模型最大边和 Bot 画幅参数计算 8 的倍数尺寸，避免提交超出本地工作流约束。 */
function resolveLocalBotDimensions(defaults: Record<string, unknown> | undefined, aspectRatio?: DrawingAspectRatio): { width: number; height: number } {
  const values = defaults ?? {};
  const maxEdge = Math.max(512, Math.min(1536, Number(values.maxEdge ?? 1536) || 1536));
  if (!aspectRatio || aspectRatio === 'auto') {
    return { width: roundLocalDimension(Number(values.width ?? 1024), maxEdge), height: roundLocalDimension(Number(values.height ?? 1024), maxEdge) };
  }
  const [widthRatio, heightRatio] = aspectRatio.split(':').map(Number);
  if (!widthRatio || !heightRatio) return { width: 1024, height: 1024 };
  return widthRatio >= heightRatio
    ? { width: roundLocalDimension(maxEdge, maxEdge), height: roundLocalDimension(maxEdge * heightRatio / widthRatio, maxEdge) }
    : { width: roundLocalDimension(maxEdge * widthRatio / heightRatio, maxEdge), height: roundLocalDimension(maxEdge, maxEdge) };
}

/** 把本地推理尺寸限制到 64..maxEdge 并对齐 8 像素。 */
function roundLocalDimension(value: number, maxEdge: number): number {
  return Math.max(64, Math.min(maxEdge, Math.round(value / 8) * 8));
}

/** 读取带 TTL 的 Bot 模型列表缓存；模型设置保存后 backend 缓存会失效，这里最多延迟 30 秒展示。 */
async function fetchBotModelOptionsCached(backendUrl: string, ttlMs = 30_000): Promise<BotModelOption[]> {
  const now = Date.now();
  if (botModelOptionsCache && botModelOptionsCache.backendUrl === backendUrl && botModelOptionsCache.expiresAt > now) {
    return botModelOptionsCache.models;
  }
  const models = await fetchBotModelOptions(backendUrl);
  if (models.length > 0) {
    botModelOptionsCache = { backendUrl, expiresAt: now + ttlMs, models };
  }
  return models;
}

/** 强制刷新 Bot 模型列表；显式序号操作必须使用最新顺序，避免 m2 指到旧缓存里的模型。 */
async function fetchBotModelOptionsFresh(backendUrl: string): Promise<BotModelOption[]> {
  const models = await fetchBotModelOptions(backendUrl);
  if (models.length > 0) {
    botModelOptionsCache = { backendUrl, expiresAt: Date.now() + 30_000, models };
  }
  return models;
}

/** 读取 QQ 持久化模型偏好；失败时退回进程缓存，避免 backend 短暂抖动影响绘图。 */
async function readBotModelPreferenceByQq(backendUrl: string, qqNumber: string): Promise<string | undefined> {
  const qq = qqNumber.trim();
  if (!/^\d{5,}$/.test(qq)) return undefined;
  try {
    const res = await fetch(`${backendUrl}/internal/user-model-pref/${encodeURIComponent(qq)}`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { model?: string | null } };
    if (res.ok && data.ok) {
      const model = String(data.data?.model ?? '').trim();
      if (model) {
        modelPrefMap.set(qq, model);
        return model;
      }
      modelPrefMap.delete(qq);
      return undefined;
    }
  } catch {
    // 查询失败时只允许退回最近一次已确认保存的本地缓存。
  }
  return modelPrefMap.get(qq);
}

/** 保存 QQ 持久化模型偏好；成功后同步进程缓存作为短时兜底。 */
async function saveBotModelPreferenceByQq(backendUrl: string, qqNumber: string, model: string): Promise<boolean> {
  const qq = qqNumber.trim();
  const normalizedModel = model.trim();
  if (!/^\d{5,}$/.test(qq) || !normalizedModel) return false;
  try {
    const res = await fetch(`${backendUrl}/internal/user-model-pref/${encodeURIComponent(qq)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ model: normalizedModel }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { model?: string | null; saved?: boolean } };
    if (!res.ok || !data.ok) return false;
    const savedModel = String(data.data?.model ?? normalizedModel).trim();
    if (savedModel) modelPrefMap.set(qq, savedModel);
    return true;
  } catch {
    return false;
  }
}

/** 按主模型名或真实请求模型名转成 Bot 外显名。 */
async function formatBotModelDisplayByName(backendUrl: string, modelName?: string | null): Promise<string> {
  const normalized = modelName?.trim();
  if (!normalized) return '';
  const models = await fetchBotModelOptionsCached(backendUrl);
  const matched = models.find((item) => item.name === normalized || item.requestModelNames?.includes(normalized));
  return matched ? formatBotModelDisplay(matched) : normalized;
}

/** 批量格式化上游尝试中的模型名，保持错误、站点、耗时等排障字段原样。 */
async function formatBotAttemptModelsForDisplay<T extends { model?: string }>(backendUrl: string, attempts: T[]): Promise<T[]> {
  return Promise.all(attempts.map(async (attempt) => ({
    ...attempt,
    model: await formatBotModelDisplayByName(backendUrl, attempt.model),
  })));
}

/** 读取批次最终回执中实际使用的模型并转为外显名；优先成功任务，其次任意任务，最后回退提交偏好。 */
async function formatBotBatchDisplayModel(backendUrl: string, batch: BotBatchResultResponse, fallbackModel?: string): Promise<string> {
  const rawModel = batch.tasks.find((task) => task.status === 'success' && task.model)?.model
    ?? batch.tasks.find((task) => task.model)?.model
    ?? fallbackModel;
  return formatBotModelDisplayByName(backendUrl, rawModel);
}

/** 按序号、主模型名、等价请求模型名、外显名或输入别名匹配。 */
function findBotModelByInput(models: BotModelOption[], input: string): BotModelOption | undefined {
  const normalized = input.trim().toLowerCase();
  const index = parseBotModelIndexInput(normalized);
  if (index !== undefined) return models[index - 1];
  return models.find((item) => (
    item.name.toLowerCase() === normalized
    || item.requestModelNames?.some((name) => name.toLowerCase() === normalized)
    || item.label?.toLowerCase() === normalized
    || item.aliases?.some((alias) => alias.toLowerCase() === normalized)
  ));
}

/** 解析 Bot 模型序号输入；只接受正整数，避免把模型名里的数字误当序号。 */
function parseBotModelIndexInput(input: string): number | undefined {
  const match = input.trim().match(/^([1-9]\d{0,2})$/);
  return match ? Number(match[1]) : undefined;
}

/** 格式化 Bot 文本回退列表：序号-外显名 -别名。 */
function formatBotModelListLine(model: BotModelOption, index: number, current: boolean): string {
  const aliasText = model.aliases?.length ? ` -${model.aliases.join('/')}` : ' -无别名';
  const mediaText = isBotVideoModel(model) ? ' [视频]' : '';
  return `${index}-${formatBotModelDisplay(model)}${mediaText} ${aliasText}${current ? ' ← 当前' : ''}`;
}

/** 判断 Bot 模型是否走视频任务链路，优先能力字段并兼容明确的 video 类型。 */
function isBotVideoModel(model: BotModelOption): boolean {
  return model.type === 'video' || model.capabilities?.textToVideo === true || model.capabilities?.imageToVideo === true;
}

/** 格式化 Bot 展示名，优先使用后台外显名。 */
function formatBotModelDisplay(model: BotModelOption): string {
  return model.label || model.aliases?.find((alias) => alias.trim()) || model.name;
}

/** 隐私切换：切换 QQ 用户默认图片公开/私密偏好。 */
type InfoErrorItem = { prompt?: string; error: string; siteName?: string; createdAt?: string };

/** /info 站点信息：默认展示站点、任务、Bot 和错误摘要；error 子命令展示最近错误文本。 */
async function createInfoAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>, subCmd: string): Promise<OneBotWsActionRequest> {
  try {
    if (subCmd === 'error' || subCmd === 'err' || subCmd === '报错') {
      const d = await queryDrawingErrorStats();
      if (d.recentErrors.length > 0) return createTextReplyAction(event, buildInfoErrorText(d.recentErrors, d.failedTasks24h), 'bot_info_error');
      return createTextReplyAction(event, '暂无错误记录', 'bot_info_error_empty');
    }

    const [status, errorStats, liveBots] = await Promise.all([
      queryPublicStatusForInfo(),
      queryDrawingErrorStats(),
      queryWsproxyBots().catch(() => ({ items: [], total: 0 })),
    ]);
    const botItems = liveBots.items.map((bot) => ({
      selfId: String(bot.selfId ?? ''),
      nickname: (bot as Record<string, unknown>).nickname as string ?? '',
      status: 'online' as const,
      avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${bot.selfId}&spec=100`,
      uptimeMs: (bot.uptimeSec ?? 0) * 1000,
    }));
    const card64 = await fetchCardImage('/render/site-info', {
      status,
      cmdPrefix: CMD,
      botItems,
      recentErrors: errorStats.recentErrors,
      submitter: makeSubmitter(event),
    }, 'info');
    if (card64) return createImageReplyAction(event, '', card64, 'bot_info_ok');
    return createTextReplyAction(event, buildInfoText(status, botItems, errorStats), 'bot_info_ok');
  } catch {
    return createTextReplyAction(event, '站点统计服务暂不可用', 'bot_info_down');
  }
}

/** 查询网页状态页同源数据；/info 必须复用公开状态页真实聚合口径。 */
async function queryPublicStatusForInfo(): Promise<PublicStatusResponse> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  const res = await fetch(`${BACKEND_URL}/api/status?range=24h`, {
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: PublicStatusResponse; message?: string };
  if (!res.ok || data.ok !== true || !data.data) throw new Error(data.message ?? `状态页接口返回 ${res.status}`);
  return data.data;
}

/** 查询绘图错误统计；只读 backend 内部接口，失败时返回空摘要。 */
async function queryDrawingErrorStats(): Promise<{ failedTasks24h: number; recentErrors: InfoErrorItem[] }> {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/drawing-stats`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      signal: AbortSignal.timeout(5000),
    });
    const d = await res.json().catch(() => ({})) as { ok?: boolean; data?: { failedTasks24h?: number; recentErrors?: InfoErrorItem[] } };
    return {
      failedTasks24h: Number(d.data?.failedTasks24h ?? 0) || 0,
      recentErrors: Array.isArray(d.data?.recentErrors) ? d.data.recentErrors : [],
    };
  } catch {
    return { failedTasks24h: 0, recentErrors: [] };
  }
}

/** `/info error` 文本回退，保留最近错误详情。 */
function buildInfoErrorText(errors: InfoErrorItem[], failedTasks24h: number): string {
  const lines = errors.slice(0, 12).map((e, i) =>
    `${i + 1}. ${e.siteName ?? '未知站点'} | ${truncate(e.error, 64)}\n   ${truncate(e.prompt ?? '', 46, '未记录提示词')} ${e.createdAt ? `· ${formatBotTaskTime(e.createdAt)}` : ''}`
  );
  return [`最近错误 · 24h失败 ${failedTasks24h} 条`, ...lines].join('\n');
}

/** `/info` 卡片渲染失败时的高信息量文字回退。 */
function buildInfoText(
  status: PublicStatusResponse,
  bots: Array<{ selfId: string }>,
  errors: { failedTasks24h: number; recentErrors: InfoErrorItem[] },
): string {
  const activeTasks = status.tasks.queued + status.tasks.running + status.tasks.finalizing;
  const onlineServices = status.services.filter((service) => service.ok).length;
  const abnormalSites = status.sites.filter((site) => !site.isEnabled || site.consecutiveFailures > 0 || (site.successRate != null && site.successRate < 80)).length;
  const topSites = status.sites.slice(0, 6).map((site) =>
    `${site.isEnabled ? '可用' : '停用'} ${site.name} 尝试${site.attempts} 成功率${site.successRate == null ? '-' : `${site.successRate.toFixed(1)}%`}${site.active > 0 ? ` 运行${site.active}` : ''}`
  );
  const sources = status.sources.map((source) => `${source.source}:${source.total}/${source.failed}败`).join(' · ') || '暂无来源数据';
  return [
    markBotText('success', '站点信息'),
    `服务：${onlineServices}/${status.services.length} 在线 · 平均探活 ${formatBotTaskDuration(averageServiceLatency(status.services))}`,
    `任务：24h ${status.tasks.total} · 成功 ${status.tasks.success} · 失败 ${status.tasks.failed} · 进行中 ${activeTasks} · 成功率 ${formatPercentText(status.tasks.successRate)}`,
    `平台：用户 ${status.platform.users} · 已验证 ${status.platform.verifiedUsers} · 公开作品 ${status.platform.publicImages} · 可用站点 ${status.platform.enabledSites}`,
    `Bot：记录 ${status.bots.total} · 在线 ${status.bots.online} · 实时连接 ${bots.length} · 封禁 ${status.bots.banned}`,
    `来源：${sources}`,
    `站点：${status.platform.enabledSites}/${status.sites.length} 可用 · 异常 ${abnormalSites}`,
    `错误：24h失败 ${errors.failedTasks24h} · 最近错误 ${errors.recentErrors.length}`,
    topSites.length ? `站点明细：\n${topSites.join('\n')}` : '暂无站点明细',
    `发送 ${cmdFor('info')} error 查看最近错误。`,
  ].join('\n');
}

/** 文本回退专用百分比格式化，保持和状态页一致。 */
function formatPercentText(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '-' : `${value.toFixed(1)}%`;
}

/** 计算服务平均探活耗时；只统计状态页返回的真实 latencyMs。 */
function averageServiceLatency(services: PublicStatusResponse['services']): number | undefined {
  const values = services.map((service) => service.latencyMs).filter((value): value is number => typeof value === 'number' && value >= 0);
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

async function createPrivacyAction(event: Extract<OneBotWsEvent, { post_type: 'message' }>) {
  const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';
  try {
    const res = await fetch(`${BACKEND_URL}/internal/qq/privacy/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
      body: JSON.stringify({ qqNumber: String(event.user_id) }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { isPrivate: boolean } };
    if (data.ok && data.data) {
      const status = data.data.isPrivate ? '私密' : '公开';
      const pv64 = await fetchCardImage(data.data.isPrivate ? '/render/privacy-private' : '/render/privacy-public', { cmdPrefix: CMD, submitter: makeSubmitter(event) });
      if (pv64) return createImageReplyAction(event, '', pv64, 'bot_privacy_ok');
      return createTextReplyAction(event, `图片隐私已切换为：${status}\n后续生成的图片将默认此设置。`, 'bot_privacy_ok');
    }
    return createTextReplyAction(event, '隐私切换失败。', 'bot_privacy_fail');
  } catch {
    return createTextReplyAction(event, '隐私服务暂不可用。', 'bot_privacy_down');
  }
}
