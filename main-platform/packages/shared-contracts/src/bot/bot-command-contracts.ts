/** Bot 命令配置契约：用于管理后台、backend 和 bot-service 同步命令触发词与返回格式。 */

/** Bot 命令卡片返回模式，image 表示优先图片卡片，text 表示仅返回文本。 */
export type BotCommandRenderMode = 'image' | 'text';

/** Bot 命令配置项，backend 存储后供 bot-service 动态刷新命令和卡片返回格式。 */
export interface BotCommandConfig {
  /** 稳定命令类型 ID，用于触发词变更后仍能正确路由到真实处理器。 */
  id?: string;
  /** 主触发词，包含当前命令前缀。 */
  command: string;
  /** 别名触发词，包含当前命令前缀。 */
  aliases?: string[];
  /** 是否启用该命令。 */
  enabled?: boolean;
  /** 命令冷却秒数，由具体处理器按职责读取。 */
  cooldownSec?: number;
  /** 该命令可能使用的 renderer 卡片类型。 */
  cardTypes?: string[];
  /** 卡片类型到返回模式的映射。 */
  renderModes?: Record<string, BotCommandRenderMode>;
  /** 管理端展示分组。 */
  group?: string;
  /** 管理端展示名称。 */
  label?: string;
}

/** Bot 管理员运行时配置，供 bot-service 判断 QQ 端管理命令权限。 */
export interface BotAdminRuntimeConfig {
  /** 允许执行 QQ 管理命令的 QQ 号列表，来源于后台配置和已绑定 Web 管理员账号。 */
  adminQqNumbers: string[];
}
