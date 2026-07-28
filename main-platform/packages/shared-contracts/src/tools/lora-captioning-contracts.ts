/**
 * 本文件定义主站 LoRA 打标工具读取独立本地模型训练集所需的跨项目视图，不复制密码、钱包或对象存储键。
 */

/** 独立平台身份摘要。 */
export interface LocalCaptioningIdentityView {
  subject: string;
  displayName: string;
}

/** 主站交换得到的独立平台会话。 */
export interface LocalCaptioningSessionView {
  sessionToken: string;
  expiresAt: string;
  identity: LocalCaptioningIdentityView;
}

/** 数据集自动打标与人工确认阶段。 */
export interface LocalCaptioningStageView {
  id: string;
  /** 数据集全量任务或单图任务。 */
  scope: 'dataset' | 'asset';
  /** 单图任务对应的训练图片 ID。 */
  assetId: string | null;
  mode: 'character' | 'style' | 'concept';
  status: 'queued' | 'running' | 'awaiting_confirmation' | 'confirmed' | 'failed' | 'stale';
  progress: number;
  totalAssets: number;
  completedAssets: number;
  errorMessage: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 单张训练图片及其持久化英文标签。 */
export interface LocalCaptioningAssetView {
  id: string;
  artifactId: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  byteSize: number;
  sha256: string;
  contentUrl: string;
  /** 该图片最近一次独立自动打标阶段。 */
  captionStage: LocalCaptioningStageView | null;
  createdAt: string;
}

/** 主站打标工具与本地 LoRA 训练共同使用的数据集。 */
export interface LocalCaptioningDatasetView {
  id: string;
  title: string;
  description: string | null;
  status: 'active' | 'disabled' | 'archived';
  ownerDisplayName: string;
  assets: LocalCaptioningAssetView[];
  trainingJobCount: number;
  captionStage: LocalCaptioningStageView | null;
  createdAt: string;
  updatedAt: string;
}

/** 训练集列表响应数据。 */
export interface LocalCaptioningDatasetListView {
  datasets: LocalCaptioningDatasetView[];
}

/** 单条英文标签的简体中文对照。 */
export interface LocalCaptioningTagTranslationView {
  tag: string;
  translated: string;
  /** 后端翻译集分配的稳定唯一色。 */
  color: string;
  /** 翻译来源：内置常用词或 AI 补全。 */
  source: 'common' | 'ai';
}

/** 标签翻译响应数据。 */
export interface LocalCaptioningTranslationListView {
  translations: LocalCaptioningTagTranslationView[];
}
