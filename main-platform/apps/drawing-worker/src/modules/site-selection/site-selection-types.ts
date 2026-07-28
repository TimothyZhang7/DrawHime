/**
 * 本文件定义站点选择模块的内部类型，包括站点配置、模型选项和选择结果。
 * 站点选择规则必须遵守 docs/architecture.md、docs/services.md 和 standards/interfaces/README.md。
 */

import type { ApiSiteModelOption, ApiSiteRuntimeConfig, ReferenceImageField, ReferenceImageOverflowStrategy } from '@aiimage/shared-contracts';

/** 模型选项复用跨服务契约，避免 backend 与 worker 对参考图能力理解不一致。 */
export type SiteModelOption = ApiSiteModelOption;

/** API 站点配置复用内部接口契约，避免 backend、drawing-service 与 Worker 字段漂移。 */
export type ApiSiteConfig = ApiSiteRuntimeConfig;

/** 站点选择结果，包含选中站点和匹配的模型信息。 */
export type SiteSelectionResult = {
  /** 选中的站点。 */
  site: ApiSiteConfig;
  /** 匹配的模型名称。 */
  model: string;
  /** 模型类型。 */
  modelType: SiteModelOption['type'];
  /** 上游调用协议。 */
  apiMode?: SiteModelOption['apiMode'];
  /** 模型可接收的最大参考图数量。 */
  maxReferenceImages: number;
  /** OpenAI Images multipart 参考图字段。 */
  referenceImageField: ReferenceImageField;
  /** 参考图超过原生上限时的处理策略。 */
  referenceImageOverflowStrategy: ReferenceImageOverflowStrategy;
  /** 有效权重（排序后）。 */
  effectiveWeight: number;
};

/** 站点选择模式，来自全局配置。 */
export type SiteSelectionMode = 'weighted' | 'random';
