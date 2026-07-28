/** 本文件定义所有 程序共享的健康检查响应类型。 */

/** 服务名必须与/AI_INDEX.md 程序索引保持一致。 */
export type ServiceName =
  | 'backend'
  | 'drawing-service'
  | 'drawing-worker'
  | 'media-service'
  | 'bot-service'
  | 'bot-renderer'
  | 'wsproxy-service'
  | 'notification-worker'
  | 'ops-worker'
  | 'web-frontend'
  | 'admin-portal'
  | 'onebotws-simulator'
  | 'local-model-platform-backend';

/** 健康检查成功响应用于部署探活和本地验证。 */
export type HealthResponse = {
  ok: true;
  service: ServiceName;
  version: string;
  uptimeSec: number;
};
