/** 本文件定义用户模板接口契约，覆盖模板 AI 转换、模板视图和收藏响应。 */

/** 模板变量类型；必须与前端模板占位语法保持一致。 */
export type TemplateVariableType = 'text' | 'color' | 'image';

/** 模板变量定义，用于 AI 转模板后向前端解释默认值。 */
export type TemplateVariableView = {
  key: string;
  type: TemplateVariableType;
  defaultValue: string;
};

/** 模板视图；对应 backend templates 表的公开响应字段。 */
export type TemplateView = {
  id: number;
  name: string;
  description: string;
  promptTemplate: string;
  defaultValues?: string;
  sourceTemplateId?: number;
  size: string;
  quality: string;
  moderation: string;
  coverImageUrls: string[];
  isPublic: boolean;
  isFavorited: boolean;
  favoriteCount: number;
  userId: number;
  username: string;
  createdAt: string;
  updatedAt: string;
};

/** 模板列表查询参数，由用户前台与后端共同使用。 */
export type TemplateListQuery = {
  /** 是否只查询当前用户创建的模板。 */
  myOnly: boolean;
  /** 是否只查询当前用户已收藏的模板。 */
  favoriteOnly: boolean;
  /** 副本来源筛选；未传时不限制来源。 */
  source?: string;
  /** 名称或提示词关键词。 */
  search?: string;
  /** 从 1 开始的页码。 */
  page: number;
  /** 单页条数。 */
  pageSize: number;
};

/** 模板列表响应。 */
export type TemplateListResponse = {
  items: TemplateView[];
  total: number;
  page: number;
  pageSize: number;
};

/** 模板收藏响应。 */
export type TemplateFavoriteResponse = {
  favorited: boolean;
  favoriteCount: number;
};

/** 用户输入普通提示词，请求后端用配置好的 AI 转为模板草稿。 */
export type TemplateAiConvertRequest = {
  prompt: string;
};

/** AI 转换出的模板草稿；前端可直接填入模板编辑器，再由用户保存。 */
export type TemplateAiDraftView = {
  name: string;
  description: string;
  promptTemplate: string;
  defaultValues: Record<string, string>;
  variables: TemplateVariableView[];
  size: string;
  quality: string;
  moderation: string;
};

/** AI 转模板响应。 */
export type TemplateAiConvertResponse = TemplateAiDraftView;
