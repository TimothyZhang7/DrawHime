/** 本文件定义邀请奖励跨端接口契约，奖励最终入账仍由 backend 钱包事务完成。 */
import type { ApiDataResponse } from '../common/api-response.js';
import type { ApiEndpointContract } from '../common/api-contract.js';

/** 当前用户被邀请状态。 */
export type ReferralStatus = 'none' | 'pending_email' | 'rewarded';

/** 当前用户自己的邀请关系摘要。 */
export type MyReferralView = {
  status: ReferralStatus;
  inviterUsername?: string;
  inviterUserId?: number;
  inviteCode?: string;
  rewardedAt?: string;
};

/** 当前用户邀请统计。 */
export type ReferralStatsView = {
  totalInvited: number;
  rewardedCount: number;
  pendingCount: number;
  totalReward: string;
};

/** 后台邀请码状态筛选。 */
export type AdminInviteCodeStatusFilter = 'all' | 'enabled' | 'disabled';

/** 后台邀请关系状态筛选。 */
export type AdminReferralRelationStatusFilter = 'all' | ReferralStatus;

/** 后台邀请码行视图；金额字段使用字符串避免浏览器浮点误差。 */
export type AdminInviteCodeView = {
  userId: number;
  username: string;
  email: string;
  emailVerified: boolean;
  code: string;
  inviteUrl: string;
  disabledAt?: string;
  createdAt: string;
  invitedCount: number;
  rewardedCount: number;
  pendingCount: number;
  inviterRewardTotal: string;
};

/** 后台邀请关系用户摘要。 */
export type AdminReferralUserView = {
  id: number;
  username: string;
  email: string;
  emailVerified: boolean;
};

/** 后台邀请关系行视图。 */
export type AdminReferralRelationView = {
  id: number;
  inviteCode: string;
  source: string;
  status: ReferralStatus;
  inviter: AdminReferralUserView;
  invitee: AdminReferralUserView;
  inviterRewardAmount: string;
  inviteeRewardAmount: string;
  createdAt: string;
  updatedAt: string;
  rewardedAt?: string;
};

/** 后台邀请运营总览。 */
export type AdminReferralOverviewResponse = {
  inviteCodeTotal: number;
  enabledInviteCodeCount: number;
  disabledInviteCodeCount: number;
  relationTotal: number;
  rewardedRelationCount: number;
  pendingRelationCount: number;
  totalInviterReward: string;
  totalInviteeReward: string;
  totalReward: string;
  latestRewardedAt?: string;
};

/** 后台邀请码列表响应。 */
export type AdminInviteCodeListResponse = {
  items: AdminInviteCodeView[];
  total: number;
  page: number;
  pageSize: number;
};

/** 后台邀请关系列表响应。 */
export type AdminReferralRelationListResponse = {
  items: AdminReferralRelationView[];
  total: number;
  page: number;
  pageSize: number;
};

/** 后台禁用或恢复邀请码请求；只影响后续使用，不改历史邀请关系或钱包。 */
export type AdminInviteCodeStatusRequest = {
  disabled: boolean;
};

/** 充值页邀请模块响应；inviteUrl 由 backend 按 APP_BASE_URL 生成。 */
export type ReferralMeResponse = {
  inviteCode: string;
  inviteUrl: string;
  referralEnabled: boolean;
  inviterRewardAmount: string;
  inviteeRewardAmount: string;
  myReferral: MyReferralView;
  stats: ReferralStatsView;
};

/** 使用邀请码请求；code 只能是邀请码短码，不接受完整 URL。 */
export type ApplyReferralRequest = {
  code: string;
};

/** 使用邀请码结果；已验证邮箱时可能立即发放奖励。 */
export type ApplyReferralResponse = {
  status: ReferralStatus;
  inviterUsername: string;
  rewarded: boolean;
  inviterRewardAmount: string;
  inviteeRewardAmount: string;
};

/** 邮箱验证结果；邀请奖励字段只用于前端提示，不作为余额权威来源。 */
export type VerifyEmailResponse = {
  message: string;
  referralRewarded?: boolean;
  inviterRewardAmount?: string;
  inviteeRewardAmount?: string;
};

/** 当前用户邀请信息端点。 */
export type ReferralMeEndpoint = ApiEndpointContract<undefined, ApiDataResponse<ReferralMeResponse>>;

/** 使用邀请码端点。 */
export type ApplyReferralEndpoint = ApiEndpointContract<ApplyReferralRequest, ApiDataResponse<ApplyReferralResponse>>;

/** 后台邀请运营总览端点。 */
export type AdminReferralOverviewEndpoint = ApiEndpointContract<undefined, ApiDataResponse<AdminReferralOverviewResponse>>;

/** 后台邀请码列表端点。 */
export type AdminInviteCodeListEndpoint = ApiEndpointContract<undefined, ApiDataResponse<AdminInviteCodeListResponse>>;

/** 后台邀请关系列表端点。 */
export type AdminReferralRelationListEndpoint = ApiEndpointContract<undefined, ApiDataResponse<AdminReferralRelationListResponse>>;

/** 后台邀请码状态切换端点。 */
export type AdminInviteCodeStatusEndpoint = ApiEndpointContract<AdminInviteCodeStatusRequest, ApiDataResponse<AdminInviteCodeView>>;
