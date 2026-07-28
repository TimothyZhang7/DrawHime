/** 本文件定义网页用户绘图模型偏好的前后端共享契约。 */
import type { ApiEndpointContract } from '../common/api-contract.js';
import type { ApiDataResponse } from '../common/api-response.js';

/** 模型偏好的恢复来源；用于区分显式选择、历史任务回退和无记录。 */
export type UserModelPreferenceSource = 'preference' | 'last_task' | 'none';

/** 当前网页用户的绘图模型偏好。 */
export type UserModelPreferenceResponse = {
  /** 统一主模型名；没有可恢复记录时为空。 */
  model: string | null;
  /** 当前模型值的恢复来源。 */
  source: UserModelPreferenceSource;
};

/** 保存当前网页用户绘图模型偏好的请求体。 */
export type UpdateUserModelPreferenceRequest = {
  /** 必须是当前仍启用的统一主模型名、等价请求模型名或输入别名。 */
  model: string;
};

/** 保存当前网页用户绘图模型偏好的响应。 */
export type UpdateUserModelPreferenceResponse = {
  /** 已保存的统一主模型名。 */
  model: string;
  /** 表示数据库写入已经完成。 */
  saved: true;
};

/** 查询当前网页用户绘图模型偏好的端点契约。 */
export type GetUserModelPreferenceEndpoint = ApiEndpointContract<undefined, ApiDataResponse<UserModelPreferenceResponse>>;

/** 保存当前网页用户绘图模型偏好的端点契约。 */
export type UpdateUserModelPreferenceEndpoint = ApiEndpointContract<
  UpdateUserModelPreferenceRequest,
  ApiDataResponse<UpdateUserModelPreferenceResponse>
>;
