/**
 * 本文件实现 drawing-service 生成任务接收和调度逻辑。
 * 接收 backend 已创建的主任务 → 校验请求 → 写入 dispatch 子任务 → 异步投递到 drawing-worker。
 *
 * worker 调度：当前阶段通过 HTTP 调用 drawing-worker 的内部执行接口。
 * 未来可升级为 Redis 队列（BullMQ）。
 */
import type {
  DrawingGenerateAcceptedResponse,
  DrawingGenerateRequest,
  DrawingModelListResponse,
  DrawingModelOptionView,
  DrawingModelType,
  ApiSiteModelOption,
} from '@aiimage/shared-contracts';
import {
  getDrawingModelCapabilities,
  getKnownDrawingModelMetadata,
  normalizeDrawingModelType,
  resolveSupportedDrawingAspectRatios,
} from '@aiimage/shared-contracts';
import { appendGenerationSubTask, updateGenerationTaskStatus } from '../../infrastructure/http/backend-client.js';
import { siteConfigService } from '../site-info/site-config-service.js';

/** drawing-worker 内部地址。 */
const DRAWING_WORKER_URL = process.env.DRAWING_WORKER_URL ?? 'http://localhost:3012';

/**
 * drawing-service 生成入口服务。
 * 接收任务 → 写入子任务 → 更新状态 → 异步投递 worker。
 */
export class DrawingApiService {
  /**
   * 接收生成任务：写入 dispatch success 子任务 → 更新主任务为 running → 异步投递 worker。
   * 主任务由 backend 在调用前创建并分配 taskId，drawing-service 不创建主任务。
   */
  async acceptGenerationTask(request: DrawingGenerateRequest): Promise<DrawingGenerateAcceptedResponse> {
    const now = new Date().toISOString();

    // 步骤 1：写入 dispatch success 子任务，证明 drawing-service 已接收
    const received = await appendGenerationSubTask({
      taskId: request.taskId,
      kind: 'dispatch',
      status: 'success',
      startedAt: now,
      finishedAt: now,
    });

    // 步骤 2：更新主任务为 running
    await updateGenerationTaskStatus({
      taskId: request.taskId,
      status: 'running',
    });

    // 步骤 3：写入初始 upstream_attempt 子任务（queued 状态）
    await appendGenerationSubTask({
      taskId: request.taskId,
      kind: 'upstream_attempt',
      status: 'queued',
      attemptNo: 1,
      model: (request as Record<string, unknown>).preferredModel as string || undefined,
      retryable: true,
      nextAction: 'same_site',
      startedAt: now,
    });

    // 步骤 4：异步投递到 drawing-worker（不阻塞 202 响应）
    this.dispatchToWorker(request).catch((error) => {
      console.error('[drawing-service] worker 投递失败', error instanceof Error ? error.message : error);
    });

    return {
      accepted: true,
      taskId: request.taskId,
      clientRequestId: request.clientRequestId,
      status: 'running',
      subTask: received.subTask,
    };
  }

  /**
   * 异步投递任务到 drawing-worker 执行。
   * Worker 不可用时不影响主任务状态（worker 恢复后从 queued 子任务拉取）。
   */
  private async dispatchToWorker(request: DrawingGenerateRequest): Promise<void> {
    try {
      const response = await fetch(`${DRAWING_WORKER_URL}/internal/execute-task`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`worker 返回错误：${response.status}`);
      }
    } catch (error) {
      // Worker 投递失败记录但不上报为任务失败
      // Worker 主循环的轮询模式会从 generation_tasks 表中拉取 queued 任务
      console.warn('[drawing-service] worker 投递失败，任务将由 worker 轮询拉取',
        error instanceof Error ? error.message : error);
    }
  }
}

/** 获取站点健康状态摘要（供 /api/drawing/health 等查询接口使用）。 */
export async function getSiteStatusSummary() {
  const sites = await siteConfigService.getSites();
  const enabled = sites.filter((s) => s.isEnabled).length;
  const disabled = sites.filter((s) => !s.isEnabled).length;
  const autoDisabled = sites.filter((s) => s.autoDisabledUntil && new Date(s.autoDisabledUntil) > new Date()).length;
  return { total: sites.length, enabled, disabled, autoDisabled };
}

/** 获取可用模型列表（从所有启用站点聚合）。 */
export async function getAvailableModels(): Promise<DrawingModelListResponse> {
  const sites = await siteConfigService.getEnabledSites();
  const models = new Map<string, DrawingModelOptionView & { typeOrder: number }>();

  for (const site of sites) {
    const options = parseModelOptions(site.modelOptions);
    for (const opt of options) {
      if (opt.enabled === false) continue;
      // 主站只聚合外部 API 模型；ComfyUI 本地模型已经迁移到独立平台，不再进入用户模型目录。
      if (opt.apiMode === 'comfyui_generation') continue;
      const name = opt.name.trim();
      if (!name) continue;
      const type = normalizeDrawingModelType(opt.type, name);
      const metadata = getKnownDrawingModelMetadata(name);
      const supportedAspectRatios = resolveSupportedDrawingAspectRatios(opt);
      const existing = models.get(name);
      if (!existing) {
        models.set(name, {
          name,
          label: metadata?.label,
          type,
          capabilities: getDrawingModelCapabilities(type),
          sites: [site.name],
          enabled: true,
          supportedAspectRatios,
          recommended: metadata?.recommended,
          description: metadata?.description,
          provider: metadata?.provider,
          typeOrder: getModelTypeOrder(type),
        });
        continue;
      }
      if (!existing.sites.includes(site.name)) existing.sites.push(site.name);
      existing.supportedAspectRatios = [...new Set([...(existing.supportedAspectRatios ?? ['auto']), ...supportedAspectRatios])];
      // 同名模型在多个站点配置不同能力时取更宽能力，避免用户端错误隐藏可用站点。
      const mergedType = pickWiderModelType(existing.type, type);
      existing.type = mergedType;
      existing.capabilities = getDrawingModelCapabilities(mergedType);
      existing.typeOrder = getModelTypeOrder(mergedType);
      // drawing-service 只提供内置元数据；用户外显名、别名和排序权重由 backend 模型设置统一合并。
      if (metadata?.recommended) existing.recommended = true;
    }

    // 旧站点只配置 model 但没有 modelOptions 时，仍提供站点默认模型，避免历史站点在前端消失。
    if (options.length === 0 && site.model?.trim()) {
      const name = site.model.trim();
      const type = normalizeDrawingModelType(undefined, name);
      const metadata = getKnownDrawingModelMetadata(name);
      if (!models.has(name)) {
        models.set(name, {
          name,
          label: metadata?.label,
          type,
          capabilities: getDrawingModelCapabilities(type),
          sites: [site.name],
          enabled: true,
          supportedAspectRatios: resolveSupportedDrawingAspectRatios({ name, apiMode: 'openai_images' }),
          recommended: metadata?.recommended,
          description: metadata?.description,
          provider: metadata?.provider,
          typeOrder: getModelTypeOrder(type),
        });
      }
    }
  }
  const list = [...models.values()]
    .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || a.typeOrder - b.typeOrder || a.name.localeCompare(b.name))
    .map(({ typeOrder: _typeOrder, ...item }) => item);
  const defaultModel = list.find((item) => item.recommended && (item.capabilities.textToImage || item.capabilities.imageToImage))?.name
    ?? list.find((item) => item.capabilities.textToImage || item.capabilities.imageToImage)?.name
    ?? list.find((item) => item.capabilities.textToVideo || item.capabilities.imageToVideo)?.name;
  return { models: list, defaultModel };
}

function parseModelOptions(raw: unknown): ApiSiteModelOption[] {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return Array.isArray(raw) ? raw as ApiSiteModelOption[] : [];
}

/** 合并同名模型类型；图像能力优先保留，text 不会扩大为图片能力。 */
function pickWiderModelType(current: DrawingModelType, next: DrawingModelType): DrawingModelType {
  if (current === 'universal' || next === 'universal') return 'universal';
  if (current === next) return current;
  if (current === 'video' || next === 'video') return current === 'text' ? next : next === 'text' ? current : current;
  if (current === 'text') return next;
  if (next === 'text') return current;
  return 'universal';
}

/** 用于模型列表排序：推荐图像模型靠前，纯文本模型靠后。 */
function getModelTypeOrder(type: DrawingModelType): number {
  if (type === 'universal') return 0;
  if (type === 'text_to_image') return 1;
  if (type === 'image_to_image') return 2;
  if (type === 'video') return 3;
  return 4;
}
