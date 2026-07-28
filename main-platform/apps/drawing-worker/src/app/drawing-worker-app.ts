import { createHealthRoutes, createHttpService, createRouter, readPortEnv } from '@aiimage/core-utils';
import { createDrawingWorkerRoutes } from '../worker/drawing-worker-routes.js';
// Worker 主循环在路由中通过 startDrawingWorkerRoute 注册后启动

export function createDrawingWorkerApp() {
  const router = createRouter([
    ...createHealthRoutes({ service: 'drawing-worker', version: '3.0.0' }),
    ...createDrawingWorkerRoutes(),
  ]);

  return createHttpService({
    name: 'drawing-worker',
    port: readPortEnv('DRAWING_WORKER_PORT', 3012),
    handler: router,
  });
}
