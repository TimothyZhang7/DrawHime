/** 本文件负责装配 wsproxy-service 的 HTTP 探活和 OneBot WebSocket 入口。 */
import { createHealthRoutes, createHttpService, createRouter, readPortEnv } from '@aiimage/core-utils';
import { createWsproxyConnectionService } from '../modules/connection/wsproxy-connection-service.js';
import { createWsproxyStatusRoutes } from '../modules/connection/wsproxy-status-routes.js';

/** 创建 wsproxy-service 应用，HTTP 和 WebSocket 共用同一个端口。 */
export function createWsproxyServiceApp() {
  const connectionService = createWsproxyConnectionService();
  const router = createRouter([
    ...createHealthRoutes({ service: 'wsproxy-service', version: '3.0.0' }),
    ...createWsproxyStatusRoutes(connectionService),
  ]);

  return createHttpService({
    name: 'wsproxy-service',
    port: readPortEnv('WSPROXY_PORT', 3011),
    handler: router,
    configureServer: (server) => connectionService.attach(server),
  });
}
