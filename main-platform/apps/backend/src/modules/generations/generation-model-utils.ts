/** 本文件集中处理生成任务复投和轮询恢复时的模型候选校验。 */
import type { PrismaClient } from '@prisma/client';
import { normalizeDrawingModelType } from '@aiimage/shared-contracts';

/** 可作为复投模型来源的子任务最小字段。 */
export type RetryModelSubTask = {
  /** 子任务类型；只有真实上游尝试允许承载模型。 */
  kind?: string | null;
  /** 子任务记录中的模型名称。 */
  model?: string | null;
};

/** 读取启用站点声明的模型名称，用于避免把图片文件名等脏数据当成模型复投。 */
export async function readEnabledModelNames(prisma: PrismaClient): Promise<Set<string>> {
  const [sites, settingsRow] = await Promise.all([
    prisma.apiSite.findMany({
      where: { isEnabled: true },
      select: { model: true, modelOptions: true },
    }),
    prisma.systemConfig.findUnique({ where: { key: 'drawing_model_settings' }, select: { value: true } }),
  ]);
  const names = new Set<string>();
  for (const site of sites) {
    const options = parseModelOptions(site.modelOptions);
    const legacyLocalNames = new Set(options
      .filter((option) => option.apiMode === 'comfyui_generation')
      .map((option) => option.name));
    const defaultModel = site.model?.trim();
    if (defaultModel && !legacyLocalNames.has(defaultModel) && normalizeDrawingModelType(undefined, defaultModel) !== 'text') names.add(defaultModel);
    for (const option of options) {
      if (option.enabled === false) continue;
      // 独立本地模型平台是 ComfyUI 新任务的唯一入口，主站恢复和偏好校验不得重新选中旧链路。
      if (option.apiMode === 'comfyui_generation') continue;
      if (normalizeDrawingModelType(option.type, option.name) === 'text') continue;
      if (option.name.trim()) names.add(option.name.trim());
    }
  }
  // 只要任一等价请求名仍由启用站点提供，统一主模型名就必须继续通过偏好和轮询恢复校验。
  const physicalNames = new Set(names);
  for (const group of parseConfiguredRequestModelGroups(settingsRow?.value)) {
    if ([group.name, ...group.requestModelNames].some((name) => physicalNames.has(name))) names.add(group.name);
  }
  return names;
}

/** 解析模型设置中的等价请求名，损坏配置按空集合处理。 */
function parseConfiguredRequestModelGroups(raw: string | null | undefined): Array<{ name: string; requestModelNames: string[] }> {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as { models?: unknown } | unknown[];
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.models) ? parsed.models : [];
    return rows.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? '').trim();
      if (!name) return [];
      const requestModelNames = Array.isArray(record.requestModelNames)
        ? record.requestModelNames.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];
      return [{ name, requestModelNames }];
    });
  } catch {
    return [];
  }
}

/** 从历史子任务中读取最近一次真实上游模型；只能复用当前启用站点声明的模型。 */
export function pickRetryModelFromSubTasks(subTasks: RetryModelSubTask[], enabledModels: Set<string>): string | undefined {
  for (const subTask of [...subTasks].reverse()) {
    const model = normalizeModelName(subTask.model);
    if (subTask.kind === 'upstream_attempt' && model && enabledModels.has(model)) return model;
  }
  return undefined;
}

/** 校验单个偏好模型；只能返回外部站点白名单内的真实模型。 */
export function normalizeEnabledModel(model: string | null | undefined, enabledModels: Set<string>): string | undefined {
  const normalized = normalizeModelName(model);
  return normalized && enabledModels.has(normalized) ? normalized : undefined;
}

/** 解析站点 model_options JSON，只接受真实对象数组。 */
function parseModelOptions(raw: string | null): Array<{ name: string; type?: string; apiMode?: string; enabled?: boolean }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const options: Array<{ name: string; type?: string; apiMode?: string; enabled?: boolean }> = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? '').trim();
      if (!name) continue;
      options.push({
        name,
        type: typeof record.type === 'string' ? record.type : undefined,
        apiMode: typeof record.apiMode === 'string' ? record.apiMode : undefined,
        enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
      });
    }
    return options;
  } catch {
    return [];
  }
}

/** 归一化模型字符串，显式过滤 Worker 的占位值。 */
function normalizeModelName(model: string | null | undefined): string | undefined {
  const value = model?.trim();
  if (!value || value === 'none') return undefined;
  return value;
}
