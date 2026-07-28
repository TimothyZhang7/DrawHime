/** 本文件负责从 QQ/OneBot 消息中按业务优先级提取绘图参考图来源。 */
import type { OneBotWsEvent, OneBotWsMessageSegment, WsproxyCallApiRequest, WsproxyCallApiResponse } from '@aiimage/shared-contracts';

const DEFAULT_QUOTED_DEPTH = 3;
const DEFAULT_NEARBY_IMAGE_WINDOW_SEC = 20;
const DEFAULT_NEARBY_HISTORY_COUNT = 30;
const DIRECT_URL_FIELDS = [
  'url',
  'image',
  'image_url',
  'imageUrl',
  'file_url',
  'fileUrl',
  'origin_url',
  'originUrl',
  'download_url',
  'downloadUrl',
  'preview',
  'preview_url',
  'previewUrl',
  'thumb',
  'thumb_url',
  'thumbUrl',
  'thumbnail',
  'thumbnail_url',
  'thumbnailUrl',
  'src',
];
const FILE_FIELDS = ['file', 'file_id', 'fileId', 'path'];
const BASE64_FIELDS = ['base64', 'fileBase64', 'imageBase64', 'image_base64'];
const EXPRESSION_FILE_FIELDS = ['key', 'emoji_id', 'emojiId', 'emoji_package_id', 'emojiPackageId', 'file_unique', 'fileUnique', 'resource_id', 'resourceId', 'md5', 'id'];
const IMAGE_SEGMENT_TYPES = new Set(['image', 'mface', 'bface', 'face', 'marketface', 'superface', 'sticker', 'emoji', 'file', 'video', 'record']);
const EXPRESSION_SEGMENT_TYPES = new Set(['mface', 'bface', 'marketface', 'superface', 'sticker', 'emoji']);

type MessageEvent = Extract<OneBotWsEvent, { post_type: 'message' }>;

type ExtractImageUrlsOptions = {
  /** 是否在实时事件无图时反查当前消息记录；仅用于用户明确要求带图的命令，避免普通文生图额外阻塞。 */
  fetchCurrentMessage?: boolean;
};

/** 从 OneBot 消息事件中按优先级提取参考图 URL。
 *  顺序固定为：引用消息图片优先，本消息非 reply 图片和 @ 头像按消息段出现顺序随后追加。 */
export async function extractImageUrlsFromEvent(event: MessageEvent, options: ExtractImageUrlsOptions = {}): Promise<string[]> {
  const visitedQuotedMessages = new Set<string>();
  const urls = await extractImageUrlsFromSegments({
    segments: event.message,
    selfId: event.self_id,
    includeAtAvatar: true,
    quotedDepth: readQuotedDepth(),
    visitedQuotedMessages,
  });
  // 关键分支：有些协议端在“图片 + 表情包”同一条消息里只把普通图片段补全，
  // raw_message 里的 mface/key 才能被 get_image 解析成参考图，因此 CQ 段也走完整图片解析链路。
  urls.push(...await extractImageUrlsFromRawSegments(event.raw_message, event.self_id));
  // QQ 桌面端偶发把同条消息里的图片退化成文本 HTML：<img src="file://D:\...\Thumb\xxx_720.jpg" />。
  // 这类路径只能交回 OneBot/LLBot 解析，生产服务器不能也不应直接读取用户本机 D 盘。
  urls.push(...await extractImageUrlsFromFileUriText(readFileUriTextFromEvent(event), event.self_id));
  if (urls.length === 0 && options.fetchCurrentMessage) {
    // LLBot 偶发实时上报只有 text 段，但 get_msg 的消息记录仍可能带 image/file 段；用户已明确依赖参考图时再反查。
    urls.push(...await fetchCurrentMessageImages(event, visitedQuotedMessages));
  }
  if (urls.length === 0 && options.fetchCurrentMessage) {
    // QQ/LLBot 有时把“文字 + 图片”拆成相邻消息；只取同群同用户短时间窗口内的图片，避免串图。
    urls.push(...await fetchNearbyGroupMessageImages(event, visitedQuotedMessages));
  }
  // raw_message 仅兜底 @ 头像。图片直链由 raw CQ 段完整解析，避免 QQ 临时 download 直链排在 get_image 结果前面。
  urls.push(...extractAvatarUrlsFromRawMessage(event.raw_message));
  return uniqueOrdered(urls);
}

/** 从原始 CQ 文本中提取 @ 头像，作为 message 段缺字段时的补偿来源。 */
function extractAvatarUrlsFromRawMessage(rawMessage: string): string[] {
  if (!rawMessage || !rawMessage.includes('[CQ:')) return [];
  return parseCqCodeSegments(rawMessage).flatMap((segment) => {
    if (segment.type === 'at') {
      const qq = String(segment.data?.qq ?? '').trim();
      // @Bot 自身也可能是用户明确要求的参考对象，不能按命令触发标记丢弃。
      if (!qq || qq === 'all') return [];
      return [`https://q.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=640`];
    }
    return [];
  });
}

/** 从 raw_message 的 CQ 段再次解析图片；用于补偿 message 数组缺失表情包 file/key 的协议端兼容问题。 */
async function extractImageUrlsFromRawSegments(rawMessage: string, selfId: number): Promise<string[]> {
  if (!rawMessage || !rawMessage.includes('[CQ:')) return [];
  const segments = parseCqCodeSegments(rawMessage);
  if (segments.length === 0) return [];
  return extractImageUrlsFromSegments({
    segments,
    selfId,
    includeAtAvatar: true,
    quotedDepth: 0,
    visitedQuotedMessages: new Set<string>(),
  });
}

/** 反查当前消息记录补取图片；只在调用方确认本命令需要图片时启用，避免普通文本命令被协议端慢响应拖住。 */
async function fetchCurrentMessageImages(event: MessageEvent, visitedQuotedMessages: Set<string>): Promise<string[]> {
  const messageId = Number(event.message_id);
  if (!Number.isSafeInteger(messageId)) return [];
  try {
    const data = await callOneBotApi(event.self_id, 'get_msg', { message_id: messageId });
    const record = readRecord(data);
    const segments = normalizeMessageSegments(record.message);
    const urls = await extractImageUrlsFromSegments({
      segments,
      selfId: event.self_id,
      includeAtAvatar: false,
      quotedDepth: 0,
      visitedQuotedMessages,
    });
    const rawMessage = typeof record.raw_message === 'string' ? record.raw_message : '';
    urls.push(...await extractImageUrlsFromRawSegments(rawMessage, event.self_id));
    urls.push(...await extractImageUrlsFromFileUriText(rawMessage, event.self_id));
    const uniqueUrls = uniqueOrdered(urls);
    console.log('[bot] current message image fallback checked', {
      selfId: String(event.self_id ?? ''),
      messageId: String(event.message_id ?? ''),
      eventSegmentTypes: summarizeSegmentTypes(event.message),
      fetchedSegmentTypes: summarizeSegmentTypes(segments),
      imageCount: uniqueUrls.length,
    });
    return uniqueUrls;
  } catch (error) {
    console.warn('[bot] current message image fallback failed', {
      selfId: String(event.self_id ?? ''),
      messageId: String(event.message_id ?? ''),
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return [];
  }
}

/** 从群历史中补取同用户近邻图片；只用于当前命令明确需要参考图且当前消息无图的场景。 */
async function fetchNearbyGroupMessageImages(event: MessageEvent, visitedQuotedMessages: Set<string>): Promise<string[]> {
  if (event.message_type !== 'group') return [];
  const groupId = Number(event.group_id);
  const messageId = Number(event.message_id);
  const userId = Number(event.user_id);
  const eventTime = Number(event.time);
  if (!Number.isSafeInteger(groupId) || !Number.isSafeInteger(messageId) || !Number.isSafeInteger(userId) || !Number.isFinite(eventTime)) return [];
  try {
    const data = await callOneBotApi(event.self_id, 'get_group_msg_history', {
      group_id: groupId,
      message_id: messageId,
      count: readNearbyHistoryCount(),
    });
    const records = readHistoryMessages(data)
      .filter((record) => isSameUserNearbyMessage(record, event, readNearbyImageWindowSec()))
      .sort((a, b) => Number(a.time ?? 0) - Number(b.time ?? 0));
    const urls: string[] = [];
    for (const record of records) {
      const segments = normalizeMessageSegments(record.message);
      urls.push(...await extractImageUrlsFromSegments({
        segments,
        selfId: event.self_id,
        includeAtAvatar: false,
        quotedDepth: 0,
        visitedQuotedMessages,
      }));
      const rawMessage = typeof record.raw_message === 'string' ? record.raw_message : '';
      urls.push(...await extractImageUrlsFromRawSegments(rawMessage, event.self_id));
      urls.push(...await extractImageUrlsFromFileUriText(rawMessage, event.self_id));
    }
    const uniqueUrls = uniqueOrdered(urls);
    console.log('[bot] nearby group image fallback checked', {
      selfId: String(event.self_id ?? ''),
      groupId: String(event.group_id ?? ''),
      userId: String(event.user_id ?? ''),
      messageId: String(event.message_id ?? ''),
      nearbyMessages: records.length,
      imageCount: uniqueUrls.length,
    });
    return uniqueUrls;
  } catch (error) {
    console.warn('[bot] nearby group image fallback failed', {
      selfId: String(event.self_id ?? ''),
      groupId: String(event.group_id ?? ''),
      messageId: String(event.message_id ?? ''),
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return [];
  }
}

/** 汇总可能包含 QQ 桌面端 file:// 图片占位的文本字段。 */
function readFileUriTextFromEvent(event: MessageEvent): string {
  const parts: string[] = [];
  if (event.raw_message) parts.push(event.raw_message);
  for (const segment of event.message) {
    if (segment.type !== 'text') continue;
    const text = String(segment.data?.text ?? '').trim();
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

/** 从 QQ 桌面端 HTML 图片占位中提取本地文件候选，并通过 OneBot get_image 解析为可下载来源。 */
async function extractImageUrlsFromFileUriText(text: string, selfId: number): Promise<string[]> {
  const fileCandidates = buildOneBotFileCandidatesFromTextFileUris(text);
  if (fileCandidates.length === 0) return [];

  const urls: string[] = [];
  for (const candidate of fileCandidates) {
    const resolved = await resolveOneBotImageFile(selfId, candidate);
    if (resolved) urls.push(resolved);
  }
  if (urls.length === 0) {
    console.warn('[bot] QQ file 图片占位未能通过 get_image 解析', { count: fileCandidates.length });
  }
  return uniqueOrdered(urls);
}

/** 将 file://D:\qqdata\...\Thumb\hash_720.jpg 转成 OneBot 可尝试解析的 file 参数候选。 */
function buildOneBotFileCandidatesFromTextFileUris(text: string): string[] {
  if (!text || !text.includes('file://')) return [];
  const paths: string[] = [];
  const srcPattern = /src=["']file:(?:\/\/\/?|\/\/)([^"']+\.(?:png|jpe?g|webp|gif|bmp|avif))["']/gi;
  const barePattern = /file:(?:\/\/\/?|\/\/)([A-Za-z]:[^<>"'\s]+\.(?:png|jpe?g|webp|gif|bmp|avif))/gi;

  for (const match of text.matchAll(srcPattern)) {
    const path = normalizeFileUriPath(match[1] ?? '');
    if (path) paths.push(path);
  }
  for (const match of text.matchAll(barePattern)) {
    const path = normalizeFileUriPath(match[1] ?? '');
    if (path) paths.push(path);
  }

  const candidates: string[] = [];
  for (const path of uniqueOrdered(paths)) {
    candidates.push(...buildOneBotFileCandidatesFromLocalPath(path));
  }
  return uniqueOrdered(candidates).slice(0, 24);
}

/** 规范化 file URI 内的 Windows 路径，避免 URL 编码和斜杠差异影响 get_image。 */
function normalizeFileUriPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return decodeURIComponent(trimmed).replace(/\//g, '\\');
  } catch {
    return trimmed.replace(/\//g, '\\');
  }
}

/** 为 QQ 缩略图路径生成多种 file 参数，兼容 LLBot 对原图名、缩略图名和完整路径的不同解析策略。 */
function buildOneBotFileCandidatesFromLocalPath(path: string): string[] {
  const filename = path.split(/[\\/]/).pop() ?? '';
  if (!filename || !looksImageLikeSource(filename)) return [];
  const candidates = [
    path,
    ...buildWindowsFileUriVariants(path),
    filename,
  ];
  candidates.push(...buildHashCasePathVariants(path));
  const thumbOriginalPaths = buildOriginalPathsFromThumbPath(path);
  for (const originalPath of thumbOriginalPaths) {
    candidates.push(originalPath, ...buildWindowsFileUriVariants(originalPath));
  }

  const thumbMatch = filename.match(/^([a-f0-9]{16,64})_(?:0|720|198|640|origin)\.(png|jpe?g|webp|gif|bmp|avif)$/i);
  if (thumbMatch) {
    const hash = thumbMatch[1] ?? '';
    const ext = thumbMatch[2] ?? '';
    if (hash && ext) {
      candidates.push(`${hash}.${ext}`, `${hash.toUpperCase()}.${ext}`, `${hash.toLowerCase()}.${ext}`);
    }
  }

  const hashMatch = filename.match(/^([a-f0-9]{16,64})\.(png|jpe?g|webp|gif|bmp|avif)$/i);
  if (hashMatch) {
    const hash = hashMatch[1] ?? '';
    const ext = hashMatch[2] ?? '';
    if (hash && ext) candidates.push(`${hash.toUpperCase()}.${ext}`, `${hash.toLowerCase()}.${ext}`);
  }

  return uniqueOrdered(candidates);
}

/** QQ 缩略图目录常用 Thumb\hash_720.jpg，对应原图目录可能是 Ori\HASH.jpg 或 Ori\hash.jpg。 */
function buildOriginalPathsFromThumbPath(path: string): string[] {
  const match = path.match(/^(.*[\\/]Pic[\\/][0-9-]+[\\/])Thumb[\\/]([a-f0-9]{16,64})_(?:0|720|198|640|origin)\.(png|jpe?g|webp|gif|bmp|avif)$/i);
  if (!match) return [];
  const prefix = match[1] ?? '';
  const hash = match[2] ?? '';
  const ext = match[3] ?? '';
  if (!prefix || !hash || !ext) return [];
  return uniqueOrdered([
    `${prefix}Ori\\${hash.toUpperCase()}.${ext}`,
    `${prefix}Ori\\${hash.toLowerCase()}.${ext}`,
  ]);
}

/** 生成 Windows file URI 候选，兼容不同协议端对 get_image file 参数的接受格式。 */
function buildWindowsFileUriVariants(path: string): string[] {
  if (!/^[A-Za-z]:[\\/]/.test(path)) return [];
  const slashPath = path.replace(/\\/g, '/');
  return [`file:///${slashPath}`, `file://${slashPath}`];
}

/** 对 Ori\hash.ext 这类本地路径补齐哈希大小写路径，避免 QQ 缓存落盘大小写和日志展示不一致。 */
function buildHashCasePathVariants(path: string): string[] {
  const match = path.match(/^(.*[\\/])([a-f0-9]{16,64})(\.(?:png|jpe?g|webp|gif|bmp|avif))$/i);
  if (!match) return [];
  const prefix = match[1] ?? '';
  const hash = match[2] ?? '';
  const ext = match[3] ?? '';
  if (!prefix || !hash || !ext) return [];
  return uniqueOrdered([
    `${prefix}${hash.toUpperCase()}${ext}`,
    `${prefix}${hash.toLowerCase()}${ext}`,
  ]);
}

async function extractImageUrlsFromSegments(options: {
  segments: OneBotWsMessageSegment[];
  selfId: number;
  includeAtAvatar: boolean;
  quotedDepth: number;
  visitedQuotedMessages: Set<string>;
}): Promise<string[]> {
  const urls: string[] = [];

  for (const segment of options.segments) {
    const replyId = readReplyMessageId(segment);
    if (!replyId) continue;
    // 引用消息必须整体排在当前消息图片前；单条引用失败不阻断本消息绘图。
    const quotedUrls = await fetchQuotedMessageImages({
      selfId: options.selfId,
      messageId: replyId,
      quotedDepth: options.quotedDepth,
      visitedQuotedMessages: options.visitedQuotedMessages,
    });
    urls.push(...quotedUrls);
  }

  for (const segment of options.segments) {
    if (segment.type === 'reply') continue;
    const currentUrls = await extractImagesFromSegment(segment, options.selfId, options.includeAtAvatar);
    urls.push(...currentUrls);
  }

  return urls;
}

/** 通过 wsproxy 调 OneBot get_msg，按引用链优先提取被引用消息中的图片。 */
async function fetchQuotedMessageImages(options: {
  selfId: number;
  messageId: string;
  quotedDepth: number;
  visitedQuotedMessages: Set<string>;
}): Promise<string[]> {
  if (options.quotedDepth <= 0) return [];
  const key = `${options.selfId}:${options.messageId}`;
  if (options.visitedQuotedMessages.has(key)) return [];
  options.visitedQuotedMessages.add(key);

  try {
    const data = await callOneBotApi(options.selfId, 'get_msg', { message_id: Number(options.messageId) });
    const segments = normalizeMessageSegments(readRecord(data).message);
    if (segments.length === 0) return [];
    // 只展开当前命令消息的直接引用。被引用消息内部如果也引用了其他消息，不能继续递归取图，
    // 否则会把“引用消息的引用消息”的图片错误加入本次绘图参考图。
    return extractImageUrlsFromSegments({
      segments,
      selfId: options.selfId,
      includeAtAvatar: false,
      quotedDepth: 0,
      visitedQuotedMessages: options.visitedQuotedMessages,
    });
  } catch {
    return [];
  }
}

async function extractImagesFromSegment(segment: OneBotWsMessageSegment, selfId: number, includeAtAvatar: boolean): Promise<string[]> {
  if (includeAtAvatar && segment.type === 'at') {
    const qq = String(segment.data?.qq ?? '').trim();
    // @Bot 自身也要进入参考图链路；仅 @Bot 无命令时会在事件层静默，不会提交绘图。
    return qq && qq !== 'all' ? [`https://q.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=640`] : [];
  }

  const directUrls: string[] = [];
  const data = segment.data ?? {};
  const imageLikeSegment = isImageLikeSegment(segment);

  for (const field of DIRECT_URL_FIELDS) {
    const value = normalizeDirectImageSource(data[field], imageLikeSegment);
    if (value) directUrls.push(value);
  }

  for (const [key, value] of Object.entries(data)) {
    const normalized = normalizeDirectImageSource(value, imageLikeSegment || isImageFieldName(key));
    if (normalized) directUrls.push(normalized);
  }

  const fileCandidates: string[] = [];
  const directFileUrls: string[] = [];
  const resolvedFileUrls: string[] = [];
  const fileFields = isExpressionSegment(segment) ? [...FILE_FIELDS, ...EXPRESSION_FILE_FIELDS] : FILE_FIELDS;
  for (const field of fileFields) {
    const source = normalizeFileCandidate(data[field], imageLikeSegment || isImageFieldName(field));
    if (!source) continue;
    const direct = normalizeDirectImageSource(source, imageLikeSegment);
    if (direct) {
      directFileUrls.push(direct);
      continue;
    }
    fileCandidates.push(source);
  }

  for (const source of uniqueOrdered(fileCandidates)) {
    // 图片段优先通过 OneBot get_image 获取协议端解析后的地址；QQ NT 直链在主站服务器上可能长期超时。
    const resolved = await resolveOneBotImageFile(selfId, source);
    if (resolved) resolvedFileUrls.push(resolved);
  }

  // 关键分支：同一个 QQ 图片段经常同时带 url 与 file。url 可能是一次性 download 跳转页，
  // get_image 成功时只返回协议端解析结果，避免坏直链被当成额外参考图导致提取或绘图失败。
  if (resolvedFileUrls.length > 0) return uniqueOrdered([...resolvedFileUrls, ...directFileUrls]);
  return uniqueOrdered([...directUrls, ...directFileUrls]);
}

async function resolveOneBotImageFile(selfId: number, file: string): Promise<string> {
  try {
    const data = await callOneBotApi(selfId, 'get_image', { file });
    const record = readRecord(data);
    for (const field of BASE64_FIELDS) {
      const value = normalizeBase64ImageSource(record[field]);
      if (value) return value;
    }
    for (const field of DIRECT_URL_FIELDS) {
      const value = normalizeDirectImageSource(record[field], true);
      if (value) return value;
    }
    for (const field of FILE_FIELDS) {
      const value = normalizeOneBotLocalFileSource(record[field]);
      if (value) return value;
    }
    return '';
  } catch {
    return '';
  }
}

async function callOneBotApi(selfId: number, action: string, params: Record<string, unknown>): Promise<unknown> {
  const wsproxyUrl = process.env.WSPROXY_SERVICE_URL ?? 'http://localhost:3011';
  const timeoutMs = action === 'get_image' || action === 'get_group_msg_history' ? 10000 : 5000;
  const request: WsproxyCallApiRequest = { selfId, action, params, timeoutMs };
  const res = await fetch(`${wsproxyUrl}/internal/call-api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
    body: JSON.stringify(request),
    // get_image 需要协议端解析 QQ 本地图片缓存，生产上偶发慢响应，单独给更宽松的等待时间。
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({})) as { ok?: boolean; data?: unknown };
  if (!res.ok || !body.ok) throw new Error(`OneBot API ${action} 调用失败`);
  const wrapped = body.data as Partial<WsproxyCallApiResponse> | undefined;
  // 兼容旧版 wsproxy 直接返回 OneBot data 的形态，方便滚动部署。
  return wrapped && Object.prototype.hasOwnProperty.call(wrapped, 'data') ? wrapped.data : body.data;
}

function readReplyMessageId(segment: OneBotWsMessageSegment): string {
  if (segment.type !== 'reply') return '';
  const id = segment.data?.id ?? segment.data?.message_id ?? segment.data?.messageId;
  return id === undefined ? '' : String(id).trim();
}

function normalizeMessageSegments(value: unknown): OneBotWsMessageSegment[] {
  if (Array.isArray(value)) {
    return value
      .map(normalizeMessageSegment)
      .filter((segment): segment is OneBotWsMessageSegment => Boolean(segment));
  }
  if (typeof value === 'string') return parseCqCodeSegments(value);
  return [];
}

function normalizeMessageSegment(value: unknown): OneBotWsMessageSegment | undefined {
  const record = readRecord(value);
  const type = typeof record.type === 'string' ? record.type : '';
  if (!type) return undefined;
  const data = readRecord(record.data);
  const normalizedData: OneBotWsMessageSegment['data'] = {};
  for (const [key, item] of Object.entries(data)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      normalizedData[key] = item;
    }
  }
  return { type, data: normalizedData };
}

function parseCqCodeSegments(message: string): OneBotWsMessageSegment[] {
  const segments: OneBotWsMessageSegment[] = [];
  const cqPattern = /\[CQ:([a-zA-Z0-9_]+),([^\]]*)\]/g;
  for (const match of message.matchAll(cqPattern)) {
    const type = match[1] ?? '';
    const rawData = match[2] ?? '';
    if (!type) continue;
    const data: OneBotWsMessageSegment['data'] = {};
    for (const pair of rawData.split(',')) {
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const key = pair.slice(0, index);
      data[key] = decodeCqValue(pair.slice(index + 1));
    }
    segments.push({ type, data });
  }
  return segments;
}

function decodeCqValue(value: string): string {
  return value
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

function normalizeDirectImageSource(value: unknown, allowGenericUrl: boolean): string {
  const source = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!source) return '';
  if (source.startsWith('data:image/')) return source;
  if (source.startsWith('base64://')) return `data:image/png;base64,${source.slice('base64://'.length)}`;
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return allowGenericUrl || looksImageLikeSource(source) ? source : '';
  }
  return '';
}

/** 解析 OneBot 返回的裸 base64 图片内容，统一交给后续本地暂存。 */
function normalizeBase64ImageSource(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return '';
  if (source.startsWith('base64://')) return `data:image/png;base64,${source.slice('base64://'.length)}`;
  if (/^[a-zA-Z0-9+/=_-]{128,}$/.test(source)) return `data:image/png;base64,${source}`;
  return '';
}

/** OneBot get_image 可能返回协议端本地缓存路径；用内部标记交给 bot-service 受控读取。 */
function normalizeOneBotLocalFileSource(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source || source.startsWith('http://') || source.startsWith('https://') || source.startsWith('base64://') || source.startsWith('data:image/')) return '';
  if (!source.includes('/') && !source.includes('\\')) return '';
  return `onebot-local-file:${Buffer.from(source, 'utf8').toString('base64url')}`;
}

function normalizeFileCandidate(value: unknown, allowed: boolean): string {
  const source = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!source || !allowed) return '';
  if (source.startsWith('base64://') || source.startsWith('http://') || source.startsWith('https://') || source.startsWith('data:image/')) {
    return source;
  }
  // 图片类消息段的 file/file_id 可能只是协议端缓存标识，不要求带图片扩展名。
  return source;
}

function isImageLikeSegment(segment: OneBotWsMessageSegment): boolean {
  const type = segment.type.toLowerCase();
  return IMAGE_SEGMENT_TYPES.has(type)
    || type.includes('image')
    || type.includes('face')
    || type.includes('emoji')
    || type.includes('sticker');
}

/** 判断是否为 QQ 表情包扩展段；这些段的 key/emoji_id 等字段也要尝试交给 OneBot 解析为图片。 */
function isExpressionSegment(segment: OneBotWsMessageSegment): boolean {
  const type = segment.type.toLowerCase();
  return EXPRESSION_SEGMENT_TYPES.has(type)
    || type.includes('face')
    || type.includes('emoji')
    || type.includes('sticker');
}

function isImageFieldName(fieldName: string): boolean {
  const name = fieldName.toLowerCase();
  return name.includes('image')
    || name.includes('photo')
    || name.includes('pic')
    || name.includes('thumb')
    || name.includes('preview')
    || name.includes('emoji')
    || name.includes('face')
    || name === 'key';
}

function looksImageLikeSource(source: string): boolean {
  const lower = source.toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|avif)(?:$|[?#])/i.test(lower)
    || lower.includes('gchat.qpic.cn')
    || lower.includes('multimedia.nt.qq.com.cn')
    || lower.includes('qlogo.cn')
    || lower.includes('qq.com');
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 读取 OneBot 群历史响应中的消息列表，兼容直接数组和 { messages } 两种返回形态。 */
function readHistoryMessages(value: unknown): Array<Record<string, unknown>> {
  const record = readRecord(value);
  const source = Array.isArray(record.messages) ? record.messages : Array.isArray(value) ? value : [];
  return source.map(readRecord).filter((item) => Object.keys(item).length > 0);
}

/** 判断历史消息是否属于同一用户的短时间近邻消息，避免跨用户或长时间间隔误取参考图。 */
function isSameUserNearbyMessage(record: Record<string, unknown>, event: MessageEvent, windowSec: number): boolean {
  if (Number(record.message_id) === Number(event.message_id)) return false;
  if (Number(record.user_id) !== Number(event.user_id)) return false;
  const recordTime = Number(record.time);
  const eventTime = Number(event.time);
  if (!Number.isFinite(recordTime) || !Number.isFinite(eventTime)) return false;
  return Math.abs(recordTime - eventTime) <= windowSec;
}

/** 汇总消息段类型用于排障日志，不输出正文、URL 或本地文件路径。 */
function summarizeSegmentTypes(segments: OneBotWsMessageSegment[]): string {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const type = segment.type || 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${type}:${count}`).join(',') || 'none';
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function readQuotedDepth(): number {
  const value = Number(process.env.BOT_REFERENCE_REPLY_DEPTH ?? DEFAULT_QUOTED_DEPTH);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_QUOTED_DEPTH;
}

function readNearbyImageWindowSec(): number {
  const value = Number(process.env.BOT_REFERENCE_NEARBY_IMAGE_WINDOW_SEC ?? DEFAULT_NEARBY_IMAGE_WINDOW_SEC);
  return Number.isSafeInteger(value) && value > 0 && value <= 120 ? value : DEFAULT_NEARBY_IMAGE_WINDOW_SEC;
}

function readNearbyHistoryCount(): number {
  const value = Number(process.env.BOT_REFERENCE_NEARBY_HISTORY_COUNT ?? DEFAULT_NEARBY_HISTORY_COUNT);
  return Number.isSafeInteger(value) && value > 0 && value <= 100 ? value : DEFAULT_NEARBY_HISTORY_COUNT;
}
