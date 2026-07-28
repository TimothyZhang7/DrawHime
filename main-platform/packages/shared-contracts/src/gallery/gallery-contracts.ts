/** 本文件定义图库相关跨端契约，供用户前台和 backend 共享。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';
import type { LoraRepositoryType } from '../lora/lora-contracts.js';

/** 图库项目类型；image 表示单张任务，batch 表示一次多图提交聚合出的图库子页面。 */
export type GalleryItemKind = 'image' | 'batch';

/** 图库作者头像来源；前端只用于展示，不包含任何私有资料。 */
export type GalleryAuthorAvatarSource = 'web' | 'qq' | 'initial';

/** 图库作者来源；用于把 Web、Bot、API 生成结果以统一口径展示。 */
export type GalleryAuthorSource = 'web' | 'bot' | 'api' | 'other';

/** 图库标签筛选匹配范围；any 表示命中任一标签，all 表示必须同时包含全部标签。 */
export type GalleryTagMatchMode = 'any' | 'all';

/** 图生图提示词用途筛选；describe 表示按描述生成，replace 表示替换或局部修改生成。 */
export type GalleryImageToImageKind = 'describe' | 'replace';

/** 本地模型作品使用的单个 LoRA 固化快照。 */
export type GalleryLocalModelLoraView = {
  /** 任务提交时使用的 LoRA 版本 ID。 */
  loraVersionId: string;
  /** 任务提交时固化的 LoRA 标题。 */
  title: string;
  /** LoRA 内容类型。 */
  type: LoraRepositoryType;
  /** 实际提交给 Runtime 的权重；历史数据缺失时为空。 */
  strength: number | null;
  /** 经主站鉴权和可见性校验的 LoRA 封面代理地址。 */
  coverUrl: string;
  /** 使用版本 ID 定位唯一 LoRA 的独立平台详情地址。 */
  detailUrl: string;
};

/** 独立本地模型作品的模型与 LoRA 固化摘要。 */
export type GalleryLocalModelView = {
  /** 任务创建时固化的模型外显名称。 */
  modelDisplayName: string;
  /** 任务创建时固化且保持提交顺序的 LoRA 列表。 */
  loras: GalleryLocalModelLoraView[];
};

/** 图库子页面按 LoRA 版本 ID 获取的实时展示元数据。 */
export type GalleryLocalModelLoraMetadataView = {
  /** 任务固化的 LoRA 版本 ID，也是实时数据合并键。 */
  loraVersionId: string;
  /** 当前唯一 LoRA 条目 ID。 */
  loraEntryId: string;
  /** LoRA 当前标题。 */
  title: string;
  /** LoRA 当前内容类型。 */
  type: LoraRepositoryType;
};

/** 图库子页面实时 LoRA 元数据响应。 */
export type GalleryLocalModelLoraMetadataResponse = ApiDataResponse<{ loras: GalleryLocalModelLoraMetadataView[]; negativePrompt: string | null }>;

/** 图库中文标签分类；标签用于检索和展示，不替换原始提示词。 */
export type GalleryTagCategory = 'subject' | 'feature' | 'scene' | 'style' | 'composition' | 'mood' | 'safety' | 'other';

/** 图库标签配色；颜色由后端首次创建标签时确定，同名标签全站一致。 */
export type GalleryTagColorView = {
  /** 浅色背景。 */
  bg: string;
  /** 可读文字色。 */
  text: string;
  /** 同色相边框色。 */
  border: string;
};

/** 图库中文标签视图；weight 决定前端展示顺序。 */
export type GalleryTagView = {
  /** 中文标签名，例如“蓝发”。 */
  name: string;
  /** 稳定标识，供 URL 筛选和内部匹配使用。 */
  slug: string;
  /** 标签分类。 */
  category: GalleryTagCategory;
  /** 当前图片上的展示权重，范围 1-100。 */
  weight: number;
  /** 当前标签固定配色。 */
  color: GalleryTagColorView;
};

/** 公开图库热门标签视图；count 只统计公开成功图片，不能包含私密图。 */
export type GalleryPopularTagView = GalleryTagView & {
  /** 公开图库中使用该标签的图片数量。 */
  count: number;
};

/** 公开图库热门标签响应。 */
export type GalleryPopularTagsResponse = {
  /** 热门中文标签列表，按公开使用数和平均权重排序。 */
  tags: GalleryPopularTagView[];
};

/** 公开图库列表请求；query string 会按该结构解析，旧版 tag 单标签仍兼容。 */
export type GalleryListRequest = {
  /** 排序方式；latest 最新，popular 热门，random 随机。 */
  sort?: 'latest' | 'popular' | 'random' | 'hot';
  /** 生成模式筛选。 */
  mode?: 'text-to-image' | 'image-to-image' | string;
  /** 图生图细分筛选；仅在 image-to-image 公开图库查询中生效。 */
  i2iKind?: GalleryImageToImageKind;
  /** 生成来源筛选。 */
  source?: string;
  /** 聚合搜索关键词。 */
  search?: string;
  /** 旧版单标签筛选，保留给历史链接。 */
  tag?: string;
  /** 多标签筛选，最多由 backend 接受前 8 个有效标签。 */
  tags?: string[];
  /** 多标签匹配范围。 */
  tagMatch?: GalleryTagMatchMode;
  /** 模板 ID 筛选。 */
  templateId?: number;
  /** 页码，从 1 开始。 */
  page?: number;
  /** 每页数量。 */
  pageSize?: number;
};

/** 图库图片资产视图；多图批次详情中的每张最终图都使用该结构。 */
export type GalleryImageAssetView = {
  /** 真实单图任务 ID；点赞、浏览、下载和所有者管理仍以这个 ID 为准。 */
  id: string;
  /** 所属批次 ID；单图任务可为空。 */
  batchId?: string | null;
  /** 批次内顺序，从 1 开始；单图任务可为空。 */
  batchIndex?: number | null;
  /** 批次总张数；单图任务可为空。 */
  batchTotal?: number | null;
  /** 原图站内相对地址。 */
  imageUrl: string;
  /** 缩略图站内相对地址；没有独立缩略图时后端回退到原图 thumb 查询。 */
  thumbnailUrl: string;
  /** 图库资产媒体类型；历史数据缺失时按 image 兼容。 */
  mediaType?: 'image' | 'video';
  /** 视频站内相对地址；仅 mediaType=video 时返回。 */
  videoUrl?: string;
  /** 视频时长，单位秒。 */
  duration?: number | null;
  /** 视频分辨率档位。 */
  resolution?: '480p' | '720p' | '1080p' | null;
  /** 视频画幅比例。 */
  aspectRatio?: string | null;
  /** 当前单图点赞数。 */
  likeCount: number;
  /** 当前单图浏览数。 */
  viewCount: number;
  /** 当前登录用户是否点赞当前单图。 */
  liked: boolean;
  /** Worker 上报的尺寸配置，可能为空；前端仍会以真实图片像素兜底。 */
  size?: string | null;
  /** Worker 上报的质量配置，可能为空。 */
  quality?: string | null;
  /** 成功上游站点名称，可能为空。 */
  siteName?: string | null;
  /** 成功上游模型名，可能为空。 */
  model?: string | null;
  /** 单图耗时毫秒，可能为空。 */
  latencyMs?: number | null;
  /** 当前单图的中文标签，按权重降序排列。 */
  tags?: GalleryTagView[];
  /** AI 根据最终图片和提示词汇总出的短标题；为空时前端回退提示词标题。 */
  title?: string | null;
};

/** 图库列表卡片视图；为兼容旧前端，首图字段仍保留在顶层。 */
export type GalleryItemView = {
  /** 图库入口 ID；单图为任务 ID，多图为批次 ID。 */
  id: string;
  /** 图库项目类型。 */
  galleryKind: GalleryItemKind;
  /** 代表单图任务 ID；单图等于 id，多图为批次第一张成功公开图。 */
  taskId: string;
  /** 批次 ID；单图可为空。 */
  batchId?: string | null;
  /** 批次总张数；单图为 1，多图为成功公开图数量或批次总数中的可展示数量。 */
  itemCount: number;
  /** 公开作者对应的 Web 用户 ID；Bot QQ 已绑定 Web 时也会返回该 ID。 */
  userId: number | null;
  prompt: string;
  /** AI 根据最终图片和提示词汇总出的短标题；不替换原始提示词。 */
  title: string | null;
  mode: string;
  source: string;
  model: string | null;
  imageUrl: string;
  thumbnailUrl: string;
  /** 图库入口代表资产媒体类型；历史数据缺失时按 image 兼容。 */
  mediaType?: 'image' | 'video';
  /** 代表视频站内相对地址；仅视频任务返回。 */
  videoUrl?: string;
  /** 代表视频时长，单位秒。 */
  duration?: number | null;
  /** 代表视频分辨率档位。 */
  resolution?: '480p' | '720p' | '1080p' | null;
  /** 代表视频画幅比例。 */
  aspectRatio?: string | null;
  likeCount: number;
  viewCount: number;
  username: string | null;
  qqNumber: string | null;
  /** 作者展示名；不返回邮箱、余额或权限。 */
  authorName: string | null;
  /** 作者头像 URL；Web 头像优先，其次 QQ 头像。 */
  authorAvatarUrl: string | null;
  /** 当前头像来源。 */
  authorAvatarSource: GalleryAuthorAvatarSource;
  /** 生成来源归一化值。 */
  authorSource: GalleryAuthorSource;
  /** 生成来源中文名称。 */
  authorSourceLabel: string;
  createdAt: string;
  liked: boolean;
  /** 批次卡片预览图；单图返回一张，多图返回前几张成功公开图。 */
  images: GalleryImageAssetView[];
  /** 图库入口代表图的中文标签，按权重降序排列。 */
  tags: GalleryTagView[];
  /** 独立本地模型作品摘要；普通主站绘图不返回。 */
  localModel?: GalleryLocalModelView;
};

/** 图库列表响应。 */
export type GalleryListResponse = {
  items: GalleryItemView[];
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  nextCursor?: string;
  hasMore: boolean;
};

/** 图库详情响应；多图批次通过 images 展示所有可见最终图。 */
export type GalleryImageDetailView = GalleryItemView & {
  size: string | null;
  quality: string | null;
  /** 用户实际提交的负面提示词；没有使用时为空。 */
  negativePrompt: string | null;
  siteName: string | null;
  /** 默认选中的单图任务 ID；文件名入口会选中对应图片，批次入口选中第一张。 */
  selectedImageId: string;
  /** 参考图本地 URL 列表。 */
  sourceImageUrls: string[];
  /** 参考图本地预览 URL 列表。 */
  sourceImageThumbnails?: string[];
  isPrivate: boolean;
  /** 当前登录用户是否有权管理当前选中图。 */
  canManage: boolean;
  /** 同期作品；批次详情中不会重复返回同批次图片。 */
  siblings: GalleryItemView[];
  latencyMs: number | null;
};

/** 图片浏览记录响应；recorded 表示本次 IP 是否首次计入浏览量。 */
export type GalleryImageViewResponse = {
  /** 本次请求是否新增了一条浏览记录；同 IP 重复访问时为 false。 */
  recorded: boolean;
  /** 图片当前累计浏览量。 */
  viewCount: number;
};

/** 记录图片浏览端点契约；图片标识来自 URL path，body 为空。 */
export type RecordGalleryImageViewEndpoint = ApiEndpointContract<
  undefined,
  ApiDataResponse<GalleryImageViewResponse>
>;

/** 批量下载图库图片请求；ids 至少 2 个，且必须是当前登录用户自己的成功生成任务 ID。 */
export type GalleryBulkDownloadRequest = {
  /** 待打包的生成任务 ID 列表，后端会去重、限量并校验所有权；单张图片由前端直接下载原图。 */
  ids: string[];
};

/** 批量下载图库图片响应；zip 文件只在后端本地临时保留一段时间。 */
export type GalleryBulkDownloadResponse = {
  /** 后端生成的临时归档 ID。 */
  archiveId: string;
  /** 需要带用户 JWT 下载的相对地址。 */
  downloadUrl: string;
  /** 浏览器保存时使用的文件名。 */
  filename: string;
  /** 临时归档过期时间，ISO 字符串。 */
  expiresAt: string;
  /** 用户请求的图片数量。 */
  requestedCount: number;
  /** 实际写入 zip 的图片数量。 */
  includedCount: number;
  /** 因权限、状态或文件缺失跳过的数量。 */
  skippedCount: number;
};

/** 创建图库批量下载 zip 端点契约。 */
export type CreateGalleryBulkDownloadEndpoint = ApiEndpointContract<
  GalleryBulkDownloadRequest,
  ApiDataResponse<GalleryBulkDownloadResponse>
>;
