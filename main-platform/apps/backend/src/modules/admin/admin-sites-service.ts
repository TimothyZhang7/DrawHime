/**
 * 本文件实现管理后台 API 站点配置业务用例。
 *
 * 约束：
 * - API Key 列表不返回明文，只返回 hasApiKey 和 apiKeyMasked
 * - 站点必须先停用才能删除
 * - 模型选项 JSON 存储，支持分钟窗口和类型配置
 * - 符合 specs/README.md ADM-030 到 ADM-036
 */
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import {
  resolveMaxReferenceImages,
  resolveAspectRatioSupport,
  resolveReferenceImageField,
  resolveReferenceImageOverflowStrategy,
  supportsCombinedReferenceImage,
  type ApiSiteModelOption,
  type SiteModelApiMode,
  type SiteModelType,
} from '@aiimage/shared-contracts';
import { registerSiteModelsInSettings } from '../generations/model-settings-service.js';

/** 站点编辑输入。 */
type SiteUpdateInput = {
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  weight?: number;
  streamMode?: boolean;
  isEnabled?: boolean;
  timeoutSec?: number;
  responseFormat?: string;
  /** 是否向上游发送 response_format 参数。 */
  sendResponseFormat?: boolean;
  /** 是否向上游发送稳定的 prompt_cache_key。 */
  sendPromptCacheKey?: boolean;
  /** Auto 尺寸是否改为第一张参考图的实际宽高。 */
  autoSizeFromReference?: boolean;
  maxConcurrency?: number;
  modelOptions?: unknown[];
};

/** 单个站点模型配置；站点只声明真实模型能力，外显名和别名统一在绘图模型设置中维护。 */
type SiteModelOptionInput = Partial<ApiSiteModelOption> & Pick<ApiSiteModelOption, 'name'>;

/** 站点管理服务。 */
export class AdminSitesService {
  private readonly prisma = getPrismaClient();

  /** 列表所有站点。 */
  async listSites() {
    const sites = await this.prisma.apiSite.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return sites.map((s) => ({
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      model: s.model,
      weight: s.weight,
      hasApiKey: s.apiKey.length > 0,
      apiKeyMasked: maskApiKey(s.apiKey),
      streamMode: s.streamMode,
      isEnabled: s.isEnabled,
      timeoutSec: s.timeoutSec,
      responseFormat: s.responseFormat,
      sendResponseFormat: s.sendResponseFormat,
      sendPromptCacheKey: s.sendPromptCacheKey,
      autoSizeFromReference: s.autoSizeFromReference,
      maxConcurrency: s.maxConcurrency,
      consecutiveFailures: s.consecutiveFailures,
      autoDisabledUntil: s.autoDisabledUntil ? formatChinaDateTime(s.autoDisabledUntil) : null,
      autoDisabledReason: s.autoDisabledReason,
      modelOptions: parseModelOptions(s.modelOptions),
      totalCalls: s.totalCalls,
      successCount: s.successCount,
      avgLatencyMs: s.avgLatencyMs,
      createdAt: formatChinaDateTime(s.createdAt),
    }));
  }

  /** 获取单站点详情。 */
  async getSite(siteId: number) {
    const s = await this.prisma.apiSite.findUnique({ where: { id: siteId } });
    if (!s) throw new AdminError('not_found', '站点不存在');
    return {
      id: s.id, name: s.name, baseUrl: s.baseUrl, model: s.model,
      weight: s.weight,
      hasApiKey: s.apiKey.length > 0,
      apiKeyMasked: maskApiKey(s.apiKey),
      streamMode: s.streamMode,
      isEnabled: s.isEnabled,
      timeoutSec: s.timeoutSec,
      responseFormat: s.responseFormat,
      sendResponseFormat: s.sendResponseFormat,
      sendPromptCacheKey: s.sendPromptCacheKey,
      autoSizeFromReference: s.autoSizeFromReference,
      maxConcurrency: s.maxConcurrency,
      consecutiveFailures: s.consecutiveFailures,
      autoDisabledUntil: s.autoDisabledUntil ? formatChinaDateTime(s.autoDisabledUntil) : null,
      autoDisabledReason: s.autoDisabledReason,
      modelOptions: parseModelOptions(s.modelOptions),
      totalCalls: s.totalCalls,
      successCount: s.successCount,
      avgLatencyMs: s.avgLatencyMs,
      createdAt: formatChinaDateTime(s.createdAt),
    };
  }

  /** 新增站点。 */
  async createSite(input: SiteUpdateInput) {
    if (!input.name?.trim()) throw new AdminError('invalid_request', '站点名称不能为空');
    if (!input.baseUrl?.trim()) throw new AdminError('invalid_request', 'API 基础 URL 不能为空');

    const name = input.name.trim();
    const baseUrl = input.baseUrl.trim();
    const normalizedModelOptions = input.modelOptions ? normalizeModelOptionsForStorage(input.modelOptions) : [];
    const registryModels = buildRegistryModelOptions(normalizedModelOptions, input.model ?? 'gpt-image-2');
    const s = await this.prisma.$transaction(async (tx) => {
      const site = await tx.apiSite.create({
        data: {
          name,
          apiKey: input.apiKey ?? '',
          baseUrl,
          model: input.model ?? 'gpt-image-2',
          weight: input.weight ?? 1,
          streamMode: input.streamMode ?? false,
          timeoutSec: input.timeoutSec ?? 300,
          responseFormat: input.responseFormat ?? 'auto',
          sendResponseFormat: input.sendResponseFormat ?? true,
          sendPromptCacheKey: input.sendPromptCacheKey ?? false,
          autoSizeFromReference: input.autoSizeFromReference ?? false,
          maxConcurrency: input.maxConcurrency ?? 10,
          modelOptions: input.modelOptions ? JSON.stringify(normalizedModelOptions) : null,
        },
      });
      // 新站点模型只负责登记，不得覆盖独立模型配置中的价格和外显信息。
      await registerSiteModelsInSettings(tx, registryModels);
      return site;
    });
    return { id: s.id, name: s.name, createdAt: formatChinaDateTime(s.createdAt) };
  }

  /** 编辑站点。 */
  async updateSite(siteId: number, input: SiteUpdateInput) {
    const existing = await this.prisma.apiSite.findUnique({ where: { id: siteId } });
    if (!existing) throw new AdminError('not_found', '站点不存在');

    const data: Record<string, unknown> = {};
    const normalizedModelOptions = input.modelOptions !== undefined ? normalizeModelOptionsForStorage(input.modelOptions) : undefined;
    const registryModels = normalizedModelOptions !== undefined || input.model !== undefined
      ? buildRegistryModelOptions(normalizedModelOptions ?? [], input.model ?? existing.model)
      : undefined;
    if (input.name !== undefined) data.name = input.name.trim();
    // 普通编辑或浏览器误传空字符串时必须保留现有密钥；只有显式非空值才能替换。
    if (input.apiKey?.trim()) data.apiKey = input.apiKey.trim();
    if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl.trim();
    if (input.model !== undefined) data.model = input.model;
    if (input.weight !== undefined) data.weight = input.weight;
    if (input.streamMode !== undefined) data.streamMode = input.streamMode;
    if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
    if (input.timeoutSec !== undefined) data.timeoutSec = input.timeoutSec;
    if (input.responseFormat !== undefined) data.responseFormat = input.responseFormat;
    // 关闭后 Worker 必须完全省略 response_format，而不是继续发送 auto 或空值。
    if (input.sendResponseFormat !== undefined) data.sendResponseFormat = input.sendResponseFormat;
    // 渠道亲和键默认关闭，只有管理员确认上游网关已配置对应规则后才发送。
    if (input.sendPromptCacheKey !== undefined) data.sendPromptCacheKey = input.sendPromptCacheKey;
    // 兼容开关只控制 Auto 尺寸改写，不影响显式尺寸或参考图本身。
    if (input.autoSizeFromReference !== undefined) data.autoSizeFromReference = input.autoSizeFromReference;
    if (input.maxConcurrency !== undefined) data.maxConcurrency = input.maxConcurrency;
    if (normalizedModelOptions !== undefined) data.modelOptions = JSON.stringify(normalizedModelOptions);

    const s = await this.prisma.$transaction(async (tx) => {
      const site = await tx.apiSite.update({ where: { id: siteId }, data });
      // 从站点移除模型或删除站点都不反向删除独立模型配置。
      if (registryModels) await registerSiteModelsInSettings(tx, registryModels);
      return site;
    });
    return { id: s.id, name: s.name, updated: true };
  }

  /** 删除站点（必须先停用）。 */
  async deleteSite(siteId: number) {
    const s = await this.prisma.apiSite.findUnique({ where: { id: siteId } });
    if (!s) throw new AdminError('not_found', '站点不存在');
    if (s.isEnabled) throw new AdminError('invalid_request', '必须先停用站点再删除');
    await this.prisma.apiSite.delete({ where: { id: siteId } });
  }

  /** 启用/停用站点。 */
  async toggleSite(siteId: number, isEnabled: boolean) {
    const s = await this.prisma.apiSite.update({
      where: { id: siteId },
      data: { isEnabled },
    });
    return { id: s.id, isEnabled: s.isEnabled };
  }

  /** 重置失败计数和自动禁用状态。 */
  async resetFailures(siteId: number) {
    const s = await this.prisma.apiSite.update({
      where: { id: siteId },
      data: { consecutiveFailures: 0, failedCount: 0, autoDisabledUntil: null, autoDisabledReason: null },
    });
    return { id: s.id, reset: true };
  }
}

/** 遮罩 API Key，只显示前 3 位和后 3 位。 */
function maskApiKey(key: string): string | null {
  if (!key) return null;
  if (key.length <= 6) return '***';
  return `${key.slice(0, 3)}***${key.slice(-3)}`;
}

/** 解析 model_options JSON。 */
function parseModelOptions(raw: unknown): unknown[] {
  if (typeof raw === 'string') {
    try { return normalizeModelOptionsForStorage(JSON.parse(raw)); } catch { return []; }
  }
  return normalizeModelOptionsForStorage(raw);
}

/** 规范化模型配置入库形状，避免旧外显名、空模型名和非对象数据进入生产配置。 */
function normalizeModelOptionsForStorage(raw: unknown): SiteModelOptionInput[] {
  if (!Array.isArray(raw)) return [];
  const options: SiteModelOptionInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? '').trim();
    if (!name) continue;
    const type = normalizeSiteModelType(record.type);
    const apiMode = normalizeSiteModelApiMode(record.apiMode, name);
    const option: SiteModelOptionInput = {
      ...record,
      name,
      type,
      apiMode,
      // ComfyUI 仅保留历史配置用于审计和回滚，任何管理端保存都必须保持禁用。
      enabled: apiMode === 'comfyui_generation' ? false : record.enabled !== false,
    } as SiteModelOptionInput;
    // 将参考图能力规范为稳定值入库，避免 worker 因脏数据或旧字段产生不同调度结果。
    option.maxReferenceImages = resolveMaxReferenceImages({
      name,
      type,
      apiMode,
      maxReferenceImages: normalizeOptionalInteger(record.maxReferenceImages),
    });
    option.referenceImageField = resolveReferenceImageField({
      name,
      referenceImageField: record.referenceImageField === 'image[]' ? 'image[]' : record.referenceImageField === 'image' ? 'image' : undefined,
    });
    option.referenceImageOverflowStrategy = supportsCombinedReferenceImage(apiMode)
      ? resolveReferenceImageOverflowStrategy({
        maxReferenceImages: option.maxReferenceImages,
        referenceImageOverflowStrategy: record.referenceImageOverflowStrategy === 'combine' ? 'combine' : record.referenceImageOverflowStrategy === 'reject' ? 'reject' : undefined,
      })
      : 'reject';
    // 画幅能力按模型独立保存，未知旧值使用共享兼容规则，避免后台保存时丢失调度约束。
    option.aspectRatioSupport = resolveAspectRatioSupport({
      name,
      apiMode,
      aspectRatioSupport: record.aspectRatioSupport === 'all'
        || record.aspectRatioSupport === 'gpt_image'
        || record.aspectRatioSupport === 'grok_video'
        || record.aspectRatioSupport === 'square_only'
        || record.aspectRatioSupport === 'auto_only'
        ? record.aspectRatioSupport
        : undefined,
    });
    // 站点配置只负责真实模型和调用协议；旧 label 必须丢弃，避免绕过独立模型设置。
    delete (option as Record<string, unknown>).label;
    // 价格统一归属独立模型配置；站点保存时清理历史 price 字段。
    delete (option as Record<string, unknown>).price;
    options.push(option);
  }
  return options;
}

/** 站点未提供模型选项时仍登记默认模型，确保后续删站不会丢失该模型配置。 */
function buildRegistryModelOptions(options: SiteModelOptionInput[], defaultModel: string): ApiSiteModelOption[] {
  if (options.length > 0) return options as ApiSiteModelOption[];
  const name = defaultModel.trim();
  return name ? [{ name, type: 'universal', enabled: true }] : [];
}

/** 规范化站点模型类型，历史 image 类型继续按通用图片模型处理。 */
function normalizeSiteModelType(value: unknown): SiteModelType {
  if (value === 'text_to_image' || value === 'image_to_image' || value === 'universal' || value === 'video' || value === 'text') return value;
  return 'universal';
}

/** 规范化站点模型协议，未知值按 OpenAI Images 兼容。 */
function normalizeSiteModelApiMode(value: unknown, _modelName: string): SiteModelApiMode {
  if (value === 'openai_images' || value === 'bfl_image_generation' || value === 'grok_image_edit_json' || value === 'grok_video_generation' || value === 'comfyui_generation') return value;
  // 已清理的历史格式统一回落到 OpenAI 格式，避免旧脏值进入 worker。
  return 'openai_images';
}

/** 仅接受整数参考图上限，其他值交由共享默认规则处理。 */
function normalizeOptionalInteger(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(numeric) ? numeric : undefined;
}

function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/** 管理接口业务错误。 */
export class AdminError extends Error {
  constructor(public readonly kind: 'not_found' | 'invalid_request' | 'forbidden', message: string) {
    super(message);
    this.name = 'AdminError';
  }
}
