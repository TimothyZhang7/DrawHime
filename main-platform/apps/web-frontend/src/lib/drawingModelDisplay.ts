/** 本文件集中处理用户前台主模型与真实上游尝试模型的统一外显映射。 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';

/** 前台只需要模型展示字段；name 是统一主模型名，label/aliases 来自后台模型设置。 */
export type DrawingModelDisplayOption = {
  /** 用户选择使用的统一主模型名。 */
  name: string;
  /** 后台配置的模型外显名，优先用于全站展示。 */
  label?: string | null;
  /** 后台配置的可输入别名，label 缺失时取第一个作为展示兜底。 */
  aliases?: string[] | null;
  /** 与主模型共享外显名的真实上游请求模型名。 */
  requestModelNames?: string[] | null;
};

/** 根据后台模型设置生成用户可见名称。 */
export function formatDrawingModelDisplayName(model?: DrawingModelDisplayOption | null): string {
  if (!model) return '';
  const label = model.label?.trim();
  if (label) return label;
  const alias = model.aliases?.find((item) => item.trim())?.trim();
  return alias || model.name;
}

/** 构建主模型名和等价请求模型名到统一展示名的映射。 */
export function buildDrawingModelDisplayMap(models: DrawingModelDisplayOption[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of models) {
    const displayName = formatDrawingModelDisplayName(item);
    map.set(item.name, displayName);
    for (const requestName of item.requestModelNames ?? []) map.set(requestName, displayName);
  }
  return map;
}

/** 前台页面使用的模型展示映射 Hook，读取公开模型列表，不触碰用户生成请求。 */
export function useDrawingModelDisplayMap() {
  const [models, setModels] = useState<DrawingModelDisplayOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api<{ models: DrawingModelDisplayOption[] }>('/api/drawing/models').then((result) => {
      if (cancelled || !result.ok || !Array.isArray(result.data?.models)) return;
      setModels(result.data.models.filter((item) => item?.name));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => buildDrawingModelDisplayMap(models), [models]);
}

/** 按主模型名或等价请求模型名返回外显名。 */
export function formatDrawingModelNameByMap(modelName: string | null | undefined, displayMap: Map<string, string>): string {
  const normalized = modelName?.trim();
  if (!normalized) return '';
  return displayMap.get(normalized) || normalized;
}
