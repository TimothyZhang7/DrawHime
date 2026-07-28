/** 本文件负责装配 backend HTTP 应用，统一注册所有业务路由和健康检查。 */
import { createHealthRoutes, createHttpService, createRouter, readPortEnv, sendJson } from '@aiimage/core-utils';
import { ApiErrorCode, type BotCommandConfig, type DrawingModelListResponse } from '@aiimage/shared-contracts';
import { readJsonBody } from '../shared/http/body.js';
import { readBearerToken } from '../shared/http/auth-header.js';
import { verifyAccessToken } from '../modules/auth/jwt.js';
import { createAdminGenerationRoutes } from '../modules/admin/admin-generation-routes.js';
import { createAdminGalleryTagRoutes } from '../modules/admin/admin-gallery-tag-routes.js';
import { createAdminBotRoutes } from '../modules/admin/admin-bot-routes.js';
import { createAdminRoutes } from '../modules/admin/admin-routes.js';
import { createAdminSitesBatchRoutes } from '../modules/admin/admin-sites-batch-routes.js';
import { createOpsInternalRoutes } from '../modules/admin/ops-internal-routes.js';
import { createAuthRoutes } from '../modules/auth/auth-routes.js';
import { createAppearanceRoutes } from '../modules/appearance/appearance-routes.js';
import { createConfigRoutes } from '../modules/config/config-routes.js';
import { createGalleryBulkDownloadRoutes } from '../modules/gallery/gallery-bulk-download-routes.js';
import { createGalleryRoutes } from '../modules/gallery/gallery-routes.js';
import { createGalleryTaggingRoutes } from '../modules/gallery/gallery-tagging-routes.js';
import { createGenerationQqRoutes } from '../modules/generations/generation-qq-routes.js';
import { createImageRoutes } from '../modules/images/image-routes.js';
import { createLocalPlatformAuthRoutes } from '../modules/integrations/local-platform-auth-routes.js';
import { createLocalPlatformBillingRoutes } from '../modules/integrations/local-platform-billing-routes.js';
import { createLocalPlatformMigrationRoutes } from '../modules/integrations/local-platform-migration-routes.js';
import { createLocalPlatformGalleryRoutes } from '../modules/integrations/local-platform-gallery-routes.js';
import { createLocalPlatformBotRoutes } from '../modules/integrations/local-platform-bot-routes.js';
import { createLeaderboardRoutes } from '../modules/leaderboard/leaderboard-routes.js';
import { createLoraRepositoryRoutes } from '../modules/lora/lora-repository-routes.js';
import { createBotGenerateRoutes } from '../modules/generations/bot-generate-routes.js';
import { createBotRetryRoutes } from '../modules/generations/bot-retry-routes.js';
import { createGenerationsRoutes } from '../modules/generations/generations-routes.js';
import { createWorkerTaskRoutes } from '../modules/generations/worker-task-routes.js';
import { createQqBindingRoutes } from '../modules/qq-binding/qq-binding-routes.js';
import { createQqPrivacyRoutes } from '../modules/qq-binding/qq-privacy-routes.js';
import { createAdminBalanceRoutes } from '../modules/quota/admin-balance-routes.js';
import { createQuotaRoutes } from '../modules/quota/quota-routes.js';
import { createRechargeOverviewRoutes } from '../modules/recharge/recharge-overview-routes.js';
import { createRechargeRoutes } from '../modules/recharge/recharge-routes.js';
import { createReferralAdminRoutes } from '../modules/referral/referral-admin-routes.js';
import { createReferralRoutes } from '../modules/referral/referral-routes.js';
import { createTemplateRoutes } from '../modules/templates/template-routes.js';
import { createStatusRoutes } from '../modules/status/status-routes.js';
import { createToolRoutes } from '../modules/tools/tool-routes.js';
import { createModelPrefRoutes } from '../modules/users/model-pref-routes.js';
import { createUserRoutes } from '../modules/users/user-routes.js';
import { createWalletRoutes } from '../modules/wallet/wallet-routes.js';
import { createWorkbenchRoutes } from '../modules/workbench/workbench-routes.js';
import { createWsproxyAdminRoutes } from '../modules/wsproxy-admin/wsproxy-admin-routes.js';
import { createWsproxyUserRoutes } from '../modules/wsproxy-admin/wsproxy-user-routes.js';
import { installGlobalErrorHandlers } from '../shared/errors/global-error-handler.js';
import { corsMiddleware } from '../shared/middleware/cors-middleware.js';
import { createRequestLogger } from '../shared/middleware/request-logger.js';
import { backendCache, invalidateConfigCacheTags, setBackendCacheHeader } from '../shared/cache/cache-service.js';
import { cacheBotCommandConfigs, cacheDrawingModels } from '../shared/cache/cache-policies.js';
import { applyDrawingModelSettings, parseDrawingModelSettings, DRAWING_MODEL_SETTINGS_KEY } from '../modules/generations/model-settings-service.js';

installGlobalErrorHandlers();

export function createBackendApp() {
  const router = createRouter([
    ...createAuthRoutes(),
    ...createAppearanceRoutes(),
    ...createUserRoutes(),
    ...createModelPrefRoutes(),
    ...createQqBindingRoutes(),
    ...createQqPrivacyRoutes(),
    ...createWalletRoutes(),
    ...createWorkbenchRoutes(),
    ...createGenerationsRoutes(),
    ...createBotGenerateRoutes(),
    ...createBotRetryRoutes(),
    ...createWorkerTaskRoutes(),
    ...createGenerationQqRoutes(),
    ...createQuotaRoutes(),
    ...createReferralRoutes(),
    ...createAdminBalanceRoutes(),
    ...createTemplateRoutes(),
    ...createGalleryRoutes(),
    ...createGalleryBulkDownloadRoutes(),
    ...createGalleryTaggingRoutes(),
    ...createImageRoutes(),
    ...createLeaderboardRoutes(),
    ...createLoraRepositoryRoutes(),
    ...createLocalPlatformAuthRoutes(),
    ...createLocalPlatformBillingRoutes(),
    ...createLocalPlatformMigrationRoutes(),
    ...createLocalPlatformGalleryRoutes(),
    ...createLocalPlatformBotRoutes(),
    ...createRechargeRoutes(),
    ...createRechargeOverviewRoutes(),
    ...createReferralAdminRoutes(),
    ...createStatusRoutes(),
    ...createToolRoutes(),
    ...createAdminBotRoutes(),
    ...createAdminSitesBatchRoutes(),
    ...createAdminRoutes(),
    ...createAdminGalleryTagRoutes(),
    ...createAdminGenerationRoutes(),
    ...createOpsInternalRoutes(),
    ...createConfigRoutes(),
    ...createWsproxyAdminRoutes(),
    ...createWsproxyUserRoutes(),
    ...createHealthRoutes({ service: 'backend', version: '3.0.0' }),
    { method: 'GET', path: '/admin/command-configs', handle: async (req, res) => {
      if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, message: '需要管理员权限' });
      try {
        const cached = await cacheBotCommandConfigs(async () => {
          const { getPrismaClient } = await import('../infrastructure/database/prisma-client.js');
          const p = getPrismaClient();
          const row = await p.systemConfig.findUnique({ where: { key: 'bot_command_configs' }, select: { value: true } });
          return row?.value ? normalizeCommandConfigs(JSON.parse(row.value)) : await getDefaultCommandConfigs();
        });
        setBackendCacheHeader(res, cached.status);
        const configs = cached.value;
        sendJson(res, 200, { ok: true, data: configs });
      } catch { sendJson(res, 500, { ok: false, message: '读取配置失败' }); }
    }},
    { method: 'PUT', path: '/admin/command-configs', handle: async (req, res) => {
      if (!authenticateAdmin(req)) return sendJson(res, 403, { ok: false, message: '需要管理员权限' });
      try {
        const body = await readJsonBody(req);
        const configs = normalizeCommandConfigs(body);
        const { getPrismaClient } = await import('../infrastructure/database/prisma-client.js');
        const p = getPrismaClient();
        await p.systemConfig.upsert({
          where: { key: 'bot_command_configs' },
          update: { value: JSON.stringify(configs) },
          create: { key: 'bot_command_configs', value: JSON.stringify(configs) },
        });
        invalidateConfigCacheTags();
        sendJson(res, 200, { ok: true, data: configs });
      } catch { sendJson(res, 500, { ok: false, message: '保存配置失败' }); }
    }},
    { method: 'GET', path: '/api/drawing/models', handle: async (_req, res) => {
      try {
        const cached = await cacheDrawingModels(async () => {
          const drawingUrl = process.env.DRAWING_SERVICE_URL ?? 'http://localhost:3005';
          const [r, configRows] = await Promise.all([
            fetch(`${drawingUrl}/api/drawing/models`, { signal: AbortSignal.timeout(5000) }),
            import('../infrastructure/database/prisma-client.js').then(({ getPrismaClient }) => (
              getPrismaClient().systemConfig.findMany({
                where: { key: { in: [DRAWING_MODEL_SETTINGS_KEY, 'drawing_default_model', 'drawing_price_per_gen'] } },
                select: { key: true, value: true },
              })
            )),
          ]);
          const d = await r.json().catch(() => ({})) as { ok?: boolean; data?: DrawingModelListResponse; message?: string };
          if (!r.ok || d?.ok !== true || !d.data?.models) return { status: r.status, body: d };
          const configMap = new Map(configRows.map((item) => [item.key, item.value]));
          const fallbackPrice = Number(configMap.get('drawing_price_per_gen') ?? '0.05');
          const merged = applyDrawingModelSettings(
            d.data,
            parseDrawingModelSettings(configMap.get(DRAWING_MODEL_SETTINGS_KEY), fallbackPrice),
            configMap.get('drawing_default_model'),
            { fallbackPrice },
          );
          return { status: 200, body: { ok: true, data: merged } };
        });
        setBackendCacheHeader(res, cached.status);
        sendJson(res, cached.value.status, cached.value.body);
      } catch { sendJson(res, 502, { ok: false, code: ApiErrorCode.ServiceUnavailable, message: '绘图服务不可用' }); }
    }},
    { method: 'GET', path: '/health/cache', handle: async (_req, res) => {
      sendJson(res, 200, { ok: true, data: backendCache.getStats() });
    }},
    { method: 'GET', path: '/health/db', handle: async (_req, res) => {
      try {
        const { getPrismaClient } = await import('../infrastructure/database/prisma-client.js');
        await getPrismaClient().$queryRaw`SELECT 1`;
        sendJson(res, 200, { ok: true, db: 'connected' });
      } catch (e) { sendJson(res, 503, { ok: false, db: 'disconnected', error: (e as Error).message }); }
    }},
  ]);

  return createHttpService({
    name: 'backend',
    port: readPortEnv('BACKEND_PORT', 6369),
    handler: router,
    middlewares: [
      corsMiddleware,
      createRequestLogger('backend'),
    ],
  });
}

async function getDefaultCommandConfigs() {
  // 命令前缀唯一来源：DB system_configs.bot_cmd_prefix，禁止从环境变量回退
  let pfx = '#';
  try {
    const { getPrismaClient } = await import('../infrastructure/database/prisma-client.js');
    const p = getPrismaClient();
    const row = await p.systemConfig.findUnique({ where: { key: 'bot_cmd_prefix' }, select: { value: true } });
    if (row?.value) pfx = row.value;
  } catch { /* DB 不可用时用 # 兜底 */ }
  const C = pfx;
  return [
    { id: 'ping', command: `${C}ping`, enabled: true, cooldownSec: 0, cardTypes: ['ping'] },
    { id: 'help', command: `${C}帮助`, enabled: true, cooldownSec: 0, cardTypes: ['help'] },
    { id: 'balance', command: `${C}余额`, enabled: true, cooldownSec: 0, cardTypes: ['balance-success'] },
    { id: 'status', command: `${C}状态`, enabled: true, cooldownSec: 0, cardTypes: ['site-status'] },
    { id: 'draw', command: `${C}绘图`, enabled: true, cooldownSec: 90, cardTypes: ['draw-submitted','draw-result','draw-cooldown','draw-quota-exceeded','retry-notify','error-retryable','error-fatal'] },
    { id: 'reverse_extract', command: `${C}提取`, enabled: true, cooldownSec: 0, aliases: [`${C}反推`], cardTypes: [] },
    { id: 'image_upscale', command: `${C}放大`, enabled: true, cooldownSec: 0, aliases: [`${C}upscale`], cardTypes: [] },
    { id: 'retry', command: `${C}重试`, enabled: true, cooldownSec: 90, aliases: [`${C}retry`], cardTypes: ['draw-submitted','draw-cooldown','draw-quota-exceeded'] },
    { id: 'generation_stats', command: `${C}统计`, enabled: true, cooldownSec: 0, cardTypes: ['generation-stats'] },
    { id: 'model', command: `${C}模型`, enabled: true, cooldownSec: 0, cardTypes: ['model-list','model-switched'] },
    { id: 'privacy', command: `${C}隐私`, enabled: true, cooldownSec: 0, cardTypes: ['privacy-public','privacy-private'] },
    { id: 'bind', command: `${C}绑定`, enabled: true, cooldownSec: 0, cardTypes: ['bind-howto','bind-success','bind-failed'] },
    { id: 'tasks', command: `${C}任务`, enabled: true, cooldownSec: 0, cardTypes: ['task-list'] },
    { id: 'botlist', command: `${C}list`, enabled: true, cooldownSec: 0, cardTypes: ['bot-list','bot-list-empty'] },
    { id: 'info', command: `${C}info`, enabled: true, cooldownSec: 0, cardTypes: ['site-info'] },
    { id: 'admin_balance', command: `${C}额度 加`, enabled: true, cooldownSec: 0, cardTypes: ['admin-balance'] },
  ];
}

/** 兼容历史命令配置：补齐稳定 ID 和缺失卡片，读取时修正但不主动覆盖数据库。 */
function normalizeCommandConfigs(value: unknown): BotCommandConfig[] {
  if (!Array.isArray(value)) return [];
  return ensureBuiltinCommandConfigs(value.map((raw) => normalizeCommandConfig(raw)).filter((item): item is BotCommandConfig => Boolean(item)));
}

/** 归一化单条命令配置，主要修复旧配置没有 id、任务命令没有 task-list 卡片的问题。 */
function normalizeCommandConfig(raw: unknown): BotCommandConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as BotCommandConfig;
  const command = typeof item.command === 'string' ? item.command : '';
  if (!command) return null;
  const id = inferCommandConfigId(item);
  const cardTypes = Array.isArray(item.cardTypes) ? [...item.cardTypes] : [];
  if (id === 'tasks' && !cardTypes.includes('task-list')) cardTypes.push('task-list');
  if (id === 'info' && !cardTypes.includes('site-info')) cardTypes.push('site-info');
  return { ...item, id, command, cardTypes };
}

/** 根据稳定 ID、触发词或卡片类型推断命令类型，兼容旧后台保存的数据。 */
function inferCommandConfigId(item: BotCommandConfig): string | undefined {
  const known = new Set(['ping', 'help', 'balance', 'status', 'generation_stats', 'draw', 'reverse_extract', 'image_upscale', 'retry', 'model', 'privacy', 'bind', 'tasks', 'botlist', 'info', 'admin_balance']);
  if (item.id && known.has(item.id)) return item.id;
  if (item.id && isCustomCommandId(item.id)) return item.id;
  const triggers = [item.command, ...(item.aliases ?? [])].map((value) => value.replace(/^[^a-zA-Z0-9一-鿿\s]+/, ''));
  const triggerMap: Record<string, string> = {
    ping: 'ping',
    帮助: 'help',
    help: 'help',
    余额: 'balance',
    额度: 'balance',
    次数: 'balance',
    状态: 'status',
    status: 'status',
    stats: 'status',
    统计: 'generation_stats',
    绘图: 'draw',
    生成: 'draw',
    draw: 'draw',
    generate: 'draw',
    提取: 'reverse_extract',
    反推: 'reverse_extract',
    reverse: 'reverse_extract',
    放大: 'image_upscale',
    upscale: 'image_upscale',
    重试: 'retry',
    retry: 'retry',
    模型: 'model',
    models: 'model',
    隐私: 'privacy',
    privacy: 'privacy',
    绑定: 'bind',
    bind: 'bind',
    任务: 'tasks',
    tasks: 'tasks',
    记录: 'tasks',
    bot: 'botlist',
    bots: 'botlist',
    list: 'botlist',
    info: 'info',
    站点统计: 'info',
    '额度 加': 'admin_balance',
    '额度 减': 'admin_balance',
    '余额 加': 'admin_balance',
    '余额 减': 'admin_balance',
  };
  for (const trigger of triggers) {
    if (triggerMap[trigger]) return triggerMap[trigger];
  }
  const cardTypeMap: Record<string, string> = {
    ping: 'ping',
    help: 'help',
    'balance-success': 'balance',
    'site-status': 'status',
    'site-info': 'info',
    'generation-stats': 'generation_stats',
    'draw-submitted': 'draw',
    'draw-result': 'draw',
    'model-list': 'model',
    'privacy-public': 'privacy',
    'bind-howto': 'bind',
    'task-list': 'tasks',
    'bot-list': 'botlist',
    'admin-balance': 'admin_balance',
  };
  for (const cardType of item.cardTypes ?? []) {
    if (cardTypeMap[cardType]) return cardTypeMap[cardType];
  }
  return undefined;
}

/** 补齐版本新增的内置命令；不直接写库，避免覆盖管理员现有排序和开关。 */
function ensureBuiltinCommandConfigs(configs: BotCommandConfig[]): BotCommandConfig[] {
  const prefix = readCommandPrefixFromConfigs(configs);
  const result = [...configs];
  // 新增内置命令只在读取时补齐，避免覆盖管理员已保存的排序、开关和别名。
  if (!result.some((item) => item.id === 'reverse_extract')) {
    result.push({ id: 'reverse_extract', command: `${prefix}提取`, enabled: true, cooldownSec: 0, aliases: [`${prefix}反推`], cardTypes: [] });
  }
  if (!result.some((item) => item.id === 'image_upscale')) {
    result.push({ id: 'image_upscale', command: `${prefix}放大`, enabled: true, cooldownSec: 0, aliases: [`${prefix}upscale`], cardTypes: [] });
  }
  return result;
}

/** 从已有命令推断当前前缀；用于旧配置补新增命令时保持生产前缀一致。 */
function readCommandPrefixFromConfigs(configs: BotCommandConfig[]): string {
  const command = configs.find((item) => typeof item.command === 'string' && item.command.length > 0)?.command ?? '#帮助';
  const match = command.match(/^[^a-zA-Z0-9一-鿿\s]+/);
  return match?.[0] ?? '#';
}

/** 自定义命令 ID 允许后台持久化；只接受安全短 ID，避免把任意字符串写入 Bot 路由标识。 */
function isCustomCommandId(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
}

function authenticateAdmin(req: any) {
  const token = readBearerToken(req.headers.authorization);
  if (!token) return undefined;
  try { const p = verifyAccessToken(token); return p.role === 'admin' ? p : undefined; }
  catch { return undefined; }
}
