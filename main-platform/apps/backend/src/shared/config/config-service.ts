/**
 * 集中式配置服务 —— 所有功能设置必须通过本服务读取。
 *
 * 配置优先级：数据库 system_configs > 环境变量 > 硬编码默认值。
 * 管理后台修改配置后，调用 invalidateAll() 刷新缓存。
 *
 * 添加约束：
 * - 环境变量仅用于启动级配置（DB连接/JWT密钥/端口等），不用于功能设置。
 * - 所有功能设置（限流/价格/超时/冷却等）通过管理后台操作 system_configs 表持久化。
 * - 开发→生产转变只需修改 env 文件 + 管理后台配置，不修改代码。
 */
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

/** 缓存 TTL 毫秒。配置修改后由管理端主动失效。 */
const CACHE_TTL_MS = 60_000;

/** 生产环境外发链接的最终安全兜底域名。 */
const PRODUCTION_APP_BASE_URL = 'https://www.xanime.ink';

/** 单项配置缓存；system_configs 同时承载任务图片元数据，不能整表读入内存。 */
const cache = new Map<string, { value: string | undefined; fetchedAt: number }>();

/** 数据库 Prisma 单例 */
const prisma = getPrismaClient();

/**
 * 获取字符串配置。数据库有值优先，否则按 env → default 兜底。
 * env key 命名规则：CONFIG_<key 大写转下划线>，如 drawing_default_model → DRAWING_DEFAULT_MODEL。
 */
export async function getString(key: string, fallback: string): Promise<string> {
  const dbValue = await readConfigValue(key);
  if (dbValue !== undefined) return dbValue;
  const envKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  return process.env[envKey] ?? fallback;
}

/** 同步读取已缓存的字符串配置（确保 await ensureCache() 先调用过）。 */
export function getStringSync(key: string, fallback: string): string {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.value !== undefined) return cached.value;
  const envKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  return process.env[envKey] ?? fallback;
}

/** 获取整数配置。 */
export async function getInt(key: string, fallback: number): Promise<number> {
  const value = await getString(key, String(fallback));
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

/** 获取数字配置（支持小数）。 */
export async function getNumber(key: string, fallback: number): Promise<number> {
  const value = await getString(key, String(fallback));
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
}

/** 获取布尔配置。 */
export async function getBoolean(key: string, fallback: boolean): Promise<boolean> {
  const value = await getString(key, String(fallback));
  return value === 'true' || value === '1';
}

/**
 * 读取前台基础 URL。
 * 生产环境会拒绝数据库中遗留的 localhost、非 HTTPS 或非法 URL，避免验证邮件指向开发地址。
 */
export async function getAppBaseUrl(): Promise<string> {
  const configuredValue = await readConfigValue(CONFIG_KEYS.appBaseUrl.key);
  const environmentValue = process.env.APP_BASE_URL;
  // 即使 NODE_ENV 遗漏，只要启动环境已提供公网 HTTPS 地址，也按生产规则保护外发链接。
  const productionRuntime = process.env.NODE_ENV === 'production' || isPublicHttpsUrl(environmentValue);
  const candidates = productionRuntime
    ? [configuredValue, environmentValue, PRODUCTION_APP_BASE_URL]
    : [configuredValue, environmentValue, CONFIG_KEYS.appBaseUrl.default];

  for (const candidate of candidates) {
    const normalized = normalizeAppBaseUrl(candidate, productionRuntime);
    if (normalized) return normalized;
  }

  return productionRuntime ? PRODUCTION_APP_BASE_URL : CONFIG_KEYS.appBaseUrl.default;
}

/** 校验并规范化前台基础 URL；生产环境只允许公网 HTTPS 地址。 */
function normalizeAppBaseUrl(value: string | undefined, productionRuntime: boolean): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    if (productionRuntime) {
      if (parsed.protocol !== 'https:' || isLoopbackHostname(parsed.hostname)) return undefined;
    } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/** 判断 URL 是否可作为生产运行态信号。 */
function isPublicHttpsUrl(value: string | undefined): boolean {
  const normalized = normalizeAppBaseUrl(value, true);
  return normalized !== undefined;
}

/** 判断主机名是否指向本机开发环境。 */
function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

/**
 * 初始化/刷新缓存。由各 getter 自动调用，也可由管理后台修改配置后主动调用 invalidateAll()。
 */
async function readConfigValue(key: string): Promise<string | undefined> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;
  const row = await prisma.systemConfig.findUnique({ where: { key }, select: { value: true } });
  const value = row?.value;
  cache.set(key, { value, fetchedAt: Date.now() });
  return value;
}

/** 管理后台修改配置后调用，强制下次读取时刷新缓存。 */
export function invalidateConfigCache(): void {
  cache.clear();
}

// ====== 预定义配置项（含说明） ======

/** 所有配置键及其默认值的集中定义。新增配置时只在此处添加一行。 */
export const CONFIG_KEYS = {
  // === 限流 ===
  rateLimitLoginMax:          { key: 'rate_limit_login_max',           default: '15',       desc:'登录限流：每分钟最大次数' },
  rateLimitLoginWindowMs:     { key: 'rate_limit_login_window_ms',     default: '60000',    desc:'登录限流：窗口毫秒' },
  rateLimitRegisterMax:       { key: 'rate_limit_register_max',       default: '5',        desc:'注册限流：每10分钟最大次数' },
  rateLimitRegisterWindowMs:  { key: 'rate_limit_register_window_ms', default: '600000',   desc:'注册限流：窗口毫秒' },
  rateLimitRedeemMax:         { key: 'rate_limit_redeem_max',          default: '10',       desc:'兑换限流：每分钟最大次数' },
  rateLimitRedeemWindowMs:    { key: 'rate_limit_redeem_window_ms',    default: '60000',    desc:'兑换限流：窗口毫秒' },
  rateLimitForgotPwdMax:      { key: 'rate_limit_forgotpwd_max',       default: '3',        desc:'忘记密码限流：每小时最大次数' },
  rateLimitForgotPwdWindowMs: { key: 'rate_limit_forgotpwd_window_ms', default: '3600000',  desc:'忘记密码限流：窗口毫秒' },
  rateLimitResendVerifyMax:       { key: 'rate_limit_resend_verify_max',        default: '3',        desc:'重发验证邮件限流（已登录）：每10分钟最大次数' },
  rateLimitResendVerifyWindowMs:  { key: 'rate_limit_resend_verify_window_ms',  default: '600000',  desc:'重发验证邮件限流（已登录）：窗口毫秒' },
  rateLimitResendVerifyEmailMax:       { key: 'rate_limit_resend_verify_email_max',        default: '2',        desc:'重发验证邮件限流（未登录）：每小时最大次数' },
  rateLimitResendVerifyEmailWindowMs:  { key: 'rate_limit_resend_verify_email_window_ms',  default: '3600000',  desc:'重发验证邮件限流（未登录）：窗口毫秒' },
  // === 认证 ===
  authSaltRounds:             { key: 'auth_salt_rounds',              default: '12',       desc:'bcrypt 哈希轮数' },
  authJwtExpiresIn:           { key: 'auth_jwt_expires_in',           default: '7d',       desc:'JWT 过期时间' },
  enableRegistration:         { key: 'enable_registration',           default: 'true',     desc:'是否允许注册' },

  // === 绘图 ===
  drawingRetryScope:          { key: 'drawing_retry_scope',             default: 'all_enabled', desc:'重试范围 single_site/all_enabled' },
  drawingSiteSelectionMode:   { key: 'drawing_site_selection_mode',    default: 'random',     desc:'站点选择模式 weighted/random，默认按权重均衡随机' },
  drawingRetryIgnoreErrors:   { key: 'drawing_retry_ignore_errors',    default: 'false',      desc:'是否忽略报错重试' },
  drawingRetryNotifyEnabled:  { key: 'drawing_retry_notify_enabled',   default: 'true',       desc:'Bot 是否发送重试通知卡片' },
  drawingSiteRequestRetries:  { key: 'drawing_site_request_retries',    default: '0',          desc:'同一站点请求级重试次数' },
  drawingAutoDisableThreshold:{ key: 'drawing_auto_disable_threshold', default: '5',         desc:'自动禁用失败阈值' },
  drawingAutoDisableMinutes:  { key: 'drawing_auto_disable_minutes',   default: '60',         desc:'自动禁用分钟数' },
  drawingDefaultSize:         { key: 'drawing_default_size',            default: '1024x1024',  desc:'默认生成尺寸' },
  drawingDefaultQuality:      { key: 'drawing_default_quality',         default: 'standard',   desc:'默认质量' },
  drawingDefaultModel:         { key: 'drawing_default_model',           default: '',           desc:'默认模型' },
  drawingCooldownSeconds:     { key: 'drawing_cooldown_seconds',        default: '90',         desc:'生成冷却秒数' },
  drawingBlockDuringGen:      { key: 'drawing_block_during_generation', default: 'true',       desc:'生成中是否阻塞' },
  drawingMaxPromptLength:     { key: 'drawing_max_prompt_length',       default: '5000',       desc:'提示词最大长度' },
  drawingPricePerGen:         { key: 'drawing_price_per_gen',           default: '0.05',       desc:'未登记模型价格兜底' },
  drawingRequestTimeoutMs:    { key: 'drawing_request_timeout_ms',      default: '125000',     desc:'单次上游请求超时毫秒' },

  // === 免费额度 ===
  freeBalanceDaily:           { key: 'free_balance_daily',             default: '1.2',        desc:'每日免费余额总额，Web/QQ 各发一半' },

  // === Worker ===
  workerPollIntervalMs:       { key: 'worker_poll_interval_ms',       default: '2000',       desc:'Worker 轮询间隔' },
  workerStaleTaskMinutes:     { key: 'worker_stale_task_minutes',     default: '30',         desc:'超时任务标记阈值（分钟）' },

  // === 缩略图 ===
  thumbnailWidth:             { key: 'thumbnail_width',                default: '400',        desc:'缩略图宽度' },
  thumbnailQuality:           { key: 'thumbnail_quality',              default: '80',         desc:'缩略图质量' },

  // === 站点 ===
  drawingSiteRequestDelayMs:   { key: 'drawing_site_request_delay_ms',  default: '2000',       desc:'同站重试等待间隔毫秒' },
  drawingDispatchBackoffMs:    { key: 'drawing_dispatch_backoff_ms',    default: '500',        desc:'投递 drawing 重试间隔毫秒' },
  siteDefaultTimeoutSec:      { key: 'site_default_timeout_sec',       default: '300',        desc:'站点默认超时秒数' },
  siteDefaultMaxConcurrency:  { key: 'site_default_max_concurrency',   default: '10',         desc:'站点默认并发上限' },

  // === 充值 ===
  rechargeShopUrl:            { key: 'recharge_shop_url',              default: '',           desc:'外部充值商店地址' },
  rechargeSupportedAmounts:   { key: 'recharge_supported_amounts',     default: '5,10,25,50,100,150', desc:'支持的充值额度（逗号分隔）' },
  rechargeDefaultBatchCount:  { key: 'recharge_default_batch_count',   default: '100',        desc:'默认批次数量' },
  rechargeMaxBatchCount:      { key: 'recharge_max_batch_count',       default: '1000',       desc:'最大批次数量' },

  // === 管理台 ===
  adminPrimaryColor:          { key: 'admin_primary_color',            default: '#6366f1',    desc:'管理台主题色（靛蓝）' },
  adminStatusPollIntervalSec: { key: 'admin_status_poll_interval_sec', default: '30',         desc:'管理台状态轮询间隔' },

  // === 图片 ===
  imageMaxFileSizeMb:         { key: 'image_max_file_size_mb',         default: '20',         desc:'图片最大文件大小(MB)' },
  imageMaxResolution:          { key: 'image_max_resolution',            default: '8192',       desc:'图片最大分辨率' },

  // === 分页 ===
  paginationDefaultPageSize:  { key: 'pagination_default_page_size',   default: '20',         desc:'默认分页大小' },
  paginationMaxPageSize:      { key: 'pagination_max_page_size',       default: '50',         desc:'最大分页大小' },

  // === 浏览器前端 ===
  appBaseUrl:                 { key: 'app_base_url',                   default: 'http://localhost:5173', desc:'前台基础 URL' },
  corsAllowedOrigins:         { key: 'cors_allowed_origins',           default: 'http://localhost:5173,http://localhost:5174', desc:'CORS 允许的源（逗号分隔）' },
  // === 绘图扩展（不在 drawing_* 前缀但属于绘图域） ===
  drawingDefaultModeration:   { key: 'drawing_default_moderation',     default: 'auto',                  desc:'默认内容审核级别' },

  // === Bot 命令 ===
  botCommandCooldownSeconds:  { key: 'bot_command_cooldown_seconds',   default: '90',                    desc:'Bot 命令冷却秒数' },
  botReplyMode:               { key: 'bot_reply_mode',                 default: 'image',                 desc:'Bot 回复模式 image/text' },
} as const;
