/** 本文件负责装配 drawing-service 的 HTTP 应用和绘图任务接收接口。 */
import { createHealthRoutes, createHttpService, createRouter, readPortEnv } from '@aiimage/core-utils';
import { createDrawingApiRoutes } from '../modules/drawing-api/drawing-api-routes.js';

/** 创建 drawing-service 应用实例，当前提供健康检查和任务接收接口。 */
export function createDrawingServiceApp() {
  const router = createRouter([
    ...createHealthRoutes({ service: 'drawing-service', version: '3.0.0' }),
    ...createDrawingApiRoutes(),
  ]);

  return createHttpService({
    name: 'drawing-service',
    port: readPortEnv('DRAWING_PORT', 3005),
    handler: router,
  });
}
