/** 本文件定义 LoRA 仓库跨端契约，覆盖公开浏览、用户上传、示例图和发布流程。 */

/** LoRA 条目状态。 */
export type LoraRepositoryStatus = 'draft' | 'published';

/** LoRA 内容分类。 */
export type LoraRepositoryType = 'style' | 'character' | 'concept' | 'clothing' | 'pose' | 'object' | 'slider' | 'other';

/** LoRA 内容分类的稳定选项与中文外显。 */
export const LORA_REPOSITORY_TYPE_OPTIONS: ReadonlyArray<{ value: LoraRepositoryType; label: string }> = [
  { value: 'style', label: '风格' },
  { value: 'character', label: '角色' },
  { value: 'concept', label: '概念' },
  { value: 'clothing', label: '服装' },
  { value: 'pose', label: '姿势' },
  { value: 'object', label: '物体' },
  { value: 'slider', label: '调节器' },
  { value: 'other', label: '其他' },
];

/** LoRA 基础模型下拉选项。 */
export interface LoraBaseModelOptionView {
  /** 提交保存的稳定模型名。 */
  value: string;
  /** 用户可见模型名称。 */
  label: string;
}

/** LoRA 示例图视图。 */
export interface LoraExampleImageView {
  /** 示例图数据库 ID。 */
  id: number;
  /** 已发布示例图公开地址。 */
  url?: string;
  /** 图片宽度。 */
  width: number;
  /** 图片高度。 */
  height: number;
  /** 展示顺序。 */
  sortOrder: number;
}

/** LoRA 仓库条目视图。 */
export interface LoraRepositoryItemView {
  id: number;
  title: string;
  description: string;
  baseModel: string;
  loraType: LoraRepositoryType;
  status: LoraRepositoryStatus;
  author: { id: number; username: string };
  fileName?: string;
  fileSizeBytes?: number;
  fileReady: boolean;
  exampleImages: LoraExampleImageView[];
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  owned: boolean;
}

/** LoRA 仓库分页列表。 */
export interface LoraRepositoryListResponse {
  items: LoraRepositoryItemView[];
  total: number;
  page: number;
  pageSize: number;
}

/** 创建 LoRA 草稿请求。 */
export interface LoraRepositoryCreateRequest {
  title: string;
  description: string;
  baseModel: string;
  loraType: LoraRepositoryType;
}

/** 创建、上传或发布 LoRA 后的响应。 */
export interface LoraRepositoryItemResponse {
  item: LoraRepositoryItemView;
}

/** LoRA 基础模型选项响应。 */
export interface LoraBaseModelListResponse {
  models: LoraBaseModelOptionView[];
  defaultModel: string;
}

/** LoRA 仓库分片上传内容类型。 */
export type LoraUploadKind = 'model' | 'example';

/** 创建分片上传会话请求。 */
export interface LoraUploadSessionCreateRequest {
  kind: LoraUploadKind;
  fileName: string;
  sizeBytes: number;
}

/** 分片上传会话响应。 */
export interface LoraUploadSessionResponse {
  uploadId: string;
  receivedBytes: number;
  totalBytes: number;
  chunkSizeBytes: number;
}

/** 单个分片写入响应。 */
export interface LoraUploadChunkResponse {
  receivedBytes: number;
  totalBytes: number;
}
