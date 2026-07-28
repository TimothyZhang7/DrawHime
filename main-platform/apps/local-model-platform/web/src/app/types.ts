/** 本文件定义独立本地模型平台用户端页面使用的展示类型。 */
import type { LocalModelPlatformConfigView, LocalModelRegistrySeed, LocalModelStorageDirectoryMappingView } from '../shared-models.js';

/** 用户端概览响应。 */
export type OverviewResponse = {
  /** 请求是否成功。 */
  ok: true;
  /** 响应主体。 */
  data: {
    /** 平台配置。 */
    config: LocalModelPlatformConfigView;
    /** 主机列表。 */
    hosts: Array<{ id: number; name: string; status: string; enabled: boolean }>;
    /** Provider 列表。 */
    providers: Array<{ id: number; label: string; type: string; enabled: boolean }>;
    /** 模型列表。 */
    models: Array<LocalModelRegistrySeed & { id: number; providerId: number; enabled: boolean; visibility: string; maxSteps: number; maxBatchSize: number; capabilities: string[] }>;
    /** 版本列表。 */
    versions: Array<{ id: number; modelKey: string; name: string; label: string; usage: string; source: string; precision: string; enabled: boolean; defaultWidth: number; defaultHeight: number; defaultSteps: number; defaultCfg: number | null; vramRecommendedGb: number | null; previewImageUrl: string | null; notes: string | null }>;
    /** 资产列表。 */
    assets: Array<{ id: number; versionId: number; filePath: string; fileName: string; fileType: string; sizeBytes: string | null; sha256Hash: string | null; lastSeenAt: string | null }>;
    /** 存储状态。 */
    storage: {
      rootDir: string;
      visibleFiles: string[];
      directories: Array<{ name: string; exists: boolean; fileCount: number }>;
      directoryMappings: LocalModelStorageDirectoryMappingView[];
    };
  };
};
