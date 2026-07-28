/**
 * notification-worker 负责异步邮件通知和 Bot 通知，不改变用户、余额、生成任务最终状态。
 * 启动后通过 health 端点暴露运行状态，Worker 主循环由外部定时器或事件驱动。
 */
import { createHealthRoutes, createHttpService, createRouter, readPortEnv } from '@aiimage/core-utils';
import { createNotificationWorkerRoutes } from '../worker/notification-worker-routes.js';

export function createNotificationWorkerApp() {
  const router = createRouter([
    ...createHealthRoutes({ service: 'notification-worker', version: '3.0.0' }),
    ...createNotificationWorkerRoutes(),
  ]);

  return createHttpService({
    name: 'notification-worker',
    port: readPortEnv('NOTIFICATION_WORKER_PORT', 3015),
    handler: router,
  });
}
