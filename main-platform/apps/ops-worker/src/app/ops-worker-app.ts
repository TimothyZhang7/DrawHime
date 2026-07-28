/**
 * ops-worker 负责周期运维任务：超时任务修复、本地媒体巡检、统计快照、站点健康采样。
 * 所有写操作必须幂等，可重放，涉及核心业务状态时通过 backend 受保护接口操作。
 */
import { createHealthRoutes, createHttpService, createRouter, readPortEnv } from '@aiimage/core-utils';
import { createOpsWorkerRoutes } from '../worker/ops-worker-routes.js';

export function createOpsWorkerApp() {
  const router = createRouter([
    ...createHealthRoutes({ service: 'ops-worker', version: '3.0.0' }),
    ...createOpsWorkerRoutes(),
  ]);

  return createHttpService({
    name: 'ops-worker',
    port: readPortEnv('OPS_WORKER_PORT', 3016),
    handler: router,
  });
}
