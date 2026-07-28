/** 本文件负责装配 bot-service 的 HTTP 应用和内部 wsproxy 事件入口。 */
import { createHealthRoutes, createHttpService, createRouter, readPortEnv } from '@aiimage/core-utils';
import { createBotStatusRoutes } from '../modules/wsproxy-client/bot-status-routes.js';
import { createWsproxyEventRoutes } from '../modules/wsproxy-client/wsproxy-event-routes.js';

/** 创建 bot-service 应用，当前提供健康检查和 wsproxy 内部事件投递接口。 */
export function createBotServiceApp() {
  const router = createRouter([
    ...createHealthRoutes({ service: 'bot-service', version: '3.0.0' }),
    ...createBotStatusRoutes(),
    ...createWsproxyEventRoutes(),
  ]);

  return createHttpService({
    name: 'bot-service',
    port: readPortEnv('BOT_PORT', 3004),
    handler: router,
  });
}
