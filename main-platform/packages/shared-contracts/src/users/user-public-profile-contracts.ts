/** 本文件定义公开用户主页接口契约，只包含可对外展示的用户资料、统计和公开图片。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';

/** 公开用户主页中的用户基础信息；不得包含邮箱、余额、角色或权限字段。 */
export type UserPublicProfileUser = {
  /** Web 用户数字 ID；该 ID 也是公开主页固定链接的一部分。 */
  id: number;
  /** 用户公开昵称。 */
  username: string;
  /** 头像 URL；遵循 Web 头像 > QQ 头像 > null。 */
  avatarUrl: string | null;
  /** 头像来源，用于前端兜底样式。 */
  avatarSource: 'web' | 'qq' | 'initial';
  /** 账号创建时间，ISO 字符串。 */
  createdAt: string;
};

/** 公开用户主页统计；只统计公开成功图片，不统计私密、失败或无图片任务。 */
export type UserPublicProfileStats = {
  /** 公开成功图片数量。 */
  publicImageCount: number;
  /** 公开图片累计点赞数。 */
  likeCount: number;
  /** 公开图片累计浏览数。 */
  viewCount: number;
  /** 最近一张公开图片创建时间；无公开图片时为 null。 */
  latestImageAt: string | null;
};

/** 公开用户主页图片卡片。 */
export type UserPublicProfileImage = {
  /** 生成主任务 ID。 */
  id: string;
  /** 提示词摘要。 */
  prompt: string;
  /** 生成模式。 */
  mode: string;
  /** 生成来源。 */
  source: string;
  /** 展示模型；取成功上游尝试或最后一次尝试的模型。 */
  model: string | null;
  /** 原图站内 URL。 */
  imageUrl: string;
  /** 缩略图站内 URL。 */
  thumbnailUrl: string;
  /** 点赞数。 */
  likeCount: number;
  /** 浏览数。 */
  viewCount: number;
  /** 创建时间，ISO 字符串。 */
  createdAt: string;
};

/** 公开用户主页响应。 */
export type UserPublicProfileResponse = {
  /** 用户公开资料。 */
  user: UserPublicProfileUser;
  /** 公开作品统计。 */
  stats: UserPublicProfileStats;
  /** 当前分页公开作品。 */
  images: UserPublicProfileImage[];
  /** 当前页码。 */
  page: number;
  /** 每页数量。 */
  pageSize: number;
  /** 总图片数。 */
  total: number;
  /** 总页数。 */
  totalPages: number;
  /** 是否还有下一页。 */
  hasMore: boolean;
};

/** 公开用户主页端点契约；用户 ID 来自 URL path，分页参数来自 query。 */
export type GetUserPublicProfileEndpoint = ApiEndpointContract<
  undefined,
  ApiDataResponse<UserPublicProfileResponse>
>;
