/** 本文件读取用户端工具配置，让后台工具开关和默认参数在前台真实生效。 */
import { useEffect, useMemo, useState } from 'react';
import type { ToolConfigView, ToolId, ToolsConfigResponse } from '@aiimage/shared-contracts';
import { api } from '../../lib/api';

const TOOLS_CONFIG_CACHE_TTL_MS = 30_000;
let cachedTools: { tools: ToolConfigView[]; expiresAt: number } | null = null;
let toolsRequest: Promise<ToolConfigView[]> | null = null;

/** 工具配置读取结果。 */
export interface UseToolsConfigResult {
  /** 工具配置是否仍在加载。 */
  loading: boolean;
  /** 按工具 ID 查询配置。 */
  getToolConfig: (id: ToolId) => ToolConfigView | undefined;
}

/** 读取公开工具配置；详情页必须结合 loading 判断，避免配置未返回时误判为停用。 */
export function useToolsConfig(): UseToolsConfigResult {
  const initial = readCachedTools();
  const [tools, setTools] = useState<ToolConfigView[]>(initial ?? []);
  const [loading, setLoading] = useState(initial === null);

  useEffect(() => {
    let alive = true;
    const current = readCachedTools();
    if (current) {
      setTools(current);
      setLoading(false);
      return () => {
        alive = false;
      };
    }
    loadToolsConfig()
      .then((nextTools) => {
        if (!alive) return;
        setTools(nextTools);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const map = useMemo(() => new Map(tools.map((tool) => [tool.id, tool])), [tools]);
  return {
    loading,
    getToolConfig: (id) => map.get(id),
  };
}

/** 读取仍在有效期内的工具配置，工具中心跳转详情页时不重复显示加载态。 */
function readCachedTools(): ToolConfigView[] | null {
  if (!cachedTools || cachedTools.expiresAt <= Date.now()) return null;
  return cachedTools.tools;
}

/** 合并同一时刻的工具配置请求，并使用短缓存兼顾页面速度与后台配置时效。 */
function loadToolsConfig(): Promise<ToolConfigView[]> {
  const current = readCachedTools();
  if (current) return Promise.resolve(current);
  if (toolsRequest) return toolsRequest;
  toolsRequest = api<ToolsConfigResponse>('/api/tools/config')
    .then((response) => {
      const tools = response.ok && Array.isArray(response.data?.tools) ? response.data.tools : [];
      if (tools.length > 0) cachedTools = { tools, expiresAt: Date.now() + TOOLS_CONFIG_CACHE_TTL_MS };
      return tools;
    })
    .finally(() => {
      toolsRequest = null;
    });
  return toolsRequest;
}
