/** 本文件装配独立本地模型平台 backend 应用。 */
import { createHealthRoutes, createHttpService, createRouter, readPortEnv } from '@aiimage/core-utils';
import { createLocalModelPlatformRoutes } from '../modules/platform/platform-routes.js';

/** 创建独立本地模型平台 backend。 */
export function createLocalModelPlatformApp() {
  const router = createRouter([
    ...createHealthRoutes({ service: 'local-model-platform-backend', version: '3.0.0' }),
    ...createLocalModelPlatformRoutes(),
  ]);

  return createHttpService({
    name: 'local-model-platform-backend',
    port: readPortEnv('LOCAL_MODEL_PLATFORM_PORT', 3017),
    handler: router,
  });
}
