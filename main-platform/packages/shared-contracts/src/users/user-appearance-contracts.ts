/** 本文件定义全站背景图配置与用户个人显示偏好的跨程序接口契约。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';

/** 全站公开背景图配置；关闭时前端不得加载背景图片。 */
export type SiteAppearanceView = {
  /** 后台是否启用全站背景图。 */
  backgroundEnabled: boolean;
  /** 当前背景图片 URL；尚未上传时为 null。 */
  backgroundImageUrl: string | null;
};

/** 当前登录用户的背景图显示偏好。 */
export type UserAppearancePreferenceView = {
  /** 用户是否愿意显示后台配置的全站背景图。 */
  backgroundEnabled: boolean;
};

/** 修改当前用户背景图显示偏好请求。 */
export type UpdateUserAppearancePreferenceRequest = {
  /** 用户是否愿意显示后台配置的全站背景图。 */
  backgroundEnabled: boolean;
};

/** 后台上传背景图后的响应。 */
export type SiteBackgroundUploadView = SiteAppearanceView & {
  /** 服务端生成的安全文件名，仅供后台预览和排障。 */
  filename: string;
};

/** 全站公开背景图配置响应。 */
export type SiteAppearanceResponse = ApiDataResponse<SiteAppearanceView>;
/** 当前用户背景图偏好响应。 */
export type UserAppearancePreferenceResponse = ApiDataResponse<UserAppearancePreferenceView>;
/** 后台背景图上传响应。 */
export type SiteBackgroundUploadResponse = ApiDataResponse<SiteBackgroundUploadView>;

/** 全站公开背景图配置端点。 */
export type GetSiteAppearanceEndpoint = ApiEndpointContract<undefined, SiteAppearanceResponse>;
/** 当前用户背景图偏好读取端点。 */
export type GetUserAppearancePreferenceEndpoint = ApiEndpointContract<undefined, UserAppearancePreferenceResponse>;
/** 当前用户背景图偏好修改端点。 */
export type UpdateUserAppearancePreferenceEndpoint = ApiEndpointContract<UpdateUserAppearancePreferenceRequest, UserAppearancePreferenceResponse>;
