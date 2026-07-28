import { createHealthRoutes, createHttpService, createRouter, readPortEnv } from '@aiimage/core-utils';
import { createMediaRoutes } from '../modules/media-api/media-routes.js';

export function createMediaServiceApp() {
  const router = createRouter([
    ...createHealthRoutes({ service: 'media-service', version: '3.0.0' }),
    ...createMediaRoutes(),
  ]);

  return createHttpService({
    name: 'media-service',
    port: readPortEnv('MEDIA_PORT', 3013),
    handler: router,
  });
}
