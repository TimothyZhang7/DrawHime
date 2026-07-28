/** 本文件定义用户默认图片隐私偏好的前后端共享契约。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';

/** 用户默认图片隐私偏好；Web 与 Bot 入口互相独立。 */
export type UserPrivacyPreferenceResponse = {
  /** 网页端新生成图片的默认隐私状态。 */
  webDefaultPrivate: boolean;
  /** Bot 端新生成图片的默认隐私状态，仅在已绑定 QQ 时可修改。 */
  botDefaultPrivate: boolean;
  /** 当前已验证绑定的 QQ 号；未绑定时为空。 */
  qqNumber: string | null;
  /** Bot 隐私设置是否可用，取决于当前用户是否已验证绑定 QQ。 */
  botAvailable: boolean;
  /** 兼容旧字段；等同于 webDefaultPrivate。 */
  defaultImagePrivate: boolean;
};

/** 更新用户默认图片隐私偏好的请求体；两端字段均可单独提交。 */
export type UpdateUserPrivacyPreferenceRequest = {
  /** 网页端默认隐私状态。 */
  webDefaultPrivate?: boolean;
  /** Bot 端默认隐私状态；需要当前用户已有 verified QQ 绑定。 */
  botDefaultPrivate?: boolean;
  /** 兼容旧调用方；等同于 webDefaultPrivate。 */
  defaultImagePrivate?: boolean;
};

/** 查询当前用户隐私偏好端点契约。 */
export type GetUserPrivacyPreferenceEndpoint = ApiEndpointContract<undefined, ApiDataResponse<UserPrivacyPreferenceResponse>>;

/** 更新当前用户隐私偏好端点契约。 */
export type UpdateUserPrivacyPreferenceEndpoint = ApiEndpointContract<
  UpdateUserPrivacyPreferenceRequest,
  ApiDataResponse<UserPrivacyPreferenceResponse>
>;
