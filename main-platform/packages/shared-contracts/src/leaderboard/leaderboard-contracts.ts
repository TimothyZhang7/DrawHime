/** 本文件定义用户端排行榜接口契约，统计口径只包含生成主任务，不包含子任务或上游尝试。 */

/** 排行榜统计时间范围。 */
export type LeaderboardRange = '24h' | '7d' | '30d' | 'all';

/** 用户任务排行榜类型；首期只开放最多调用，后续可继续扩展。 */
export type UserTaskLeaderboardKind = 'most_tasks';

/** 单个渠道任务数量。 */
export type UserTaskLeaderboardSourceCount = {
  /** 任务来源原始标识，例如 web、bot、api。 */
  source: string;
  /** 前端展示用中文名称。 */
  label: string;
  /** 该来源下的主任务数量。 */
  tasks: number;
};

/** 用户任务排行榜单行数据。 */
export type UserTaskLeaderboardItem = {
  /** 当前筛选条件下的排名，从 1 开始。 */
  rank: number;
  /** 账号聚合键；Web 用户为 user:<id>，未绑定 QQ 为 qq:<sha256>，不包含完整 QQ。 */
  accountKey: string;
  /** 账号类型；web 表示网页账号，qq 表示未绑定网页账号的 Bot 用户。 */
  accountType: 'web' | 'qq';
  /** Web 用户 ID；未绑定 QQ Bot 用户为空。 */
  userId: number | null;
  /** QQ 脱敏标识；只在未绑定 QQ Bot 用户上返回，不返回完整 QQ 号。 */
  qqNumberMasked?: string;
  /** 公开展示昵称，不包含邮箱或完整 QQ 号。 */
  nickname: string;
  /** 公开展示头像；优先 Web 本地头像，其次 QQ 头像，无法解析时为 null。 */
  avatarUrl: string | null;
  /** 头像来源，仅用于前端选择兜底样式，不参与身份判断。 */
  avatarSource: 'web' | 'qq' | 'initial';
  /** 主任务总数。 */
  totalTasks: number;
  /** 成功主任务数。 */
  successTasks: number;
  /** 失败主任务数。 */
  failedTasks: number;
  /** 非终态主任务数。 */
  activeTasks: number;
  /** 按任务来源拆分的调用次数。 */
  sourceCounts: UserTaskLeaderboardSourceCount[];
};

/** 用户任务排行榜汇总。 */
export type UserTaskLeaderboardSummary = {
  /** 当前排行榜类型。 */
  kind: UserTaskLeaderboardKind;
  /** 当前时间范围。 */
  range: LeaderboardRange;
  /** 统计起始时间；全部范围为 null。 */
  since: string | null;
  /** 统计截止时间。 */
  until: string;
  /** 本次返回上限。 */
  limit: number;
  /** 当前筛选范围内有主任务的聚合账号数。 */
  totalUsers: number;
  /** 当前筛选范围内主任务总数。 */
  totalTasks: number;
};

/** 当前登录用户在当前筛选条件下的排名摘要；未登录时后端不返回该字段。 */
export type UserTaskLeaderboardCurrentUser = {
  /** 当前用户排名行；当前范围没有任何任务时为 null。 */
  item: UserTaskLeaderboardItem | null;
  /** 当前用户是否已经包含在本次 items 列表内。 */
  includedInItems: boolean;
};

/** 用户任务排行榜接口响应。 */
export type UserTaskLeaderboardResponse = {
  /** 汇总信息。 */
  summary: UserTaskLeaderboardSummary;
  /** 排行榜条目。 */
  items: UserTaskLeaderboardItem[];
  /** 当前登录用户排名；仅当请求带有效用户 JWT 时返回。 */
  currentUser?: UserTaskLeaderboardCurrentUser;
};
