/** bot-renderer 负责 Bot 图片卡片的 HTML 渲染，不连接 OneBot，不读取用户敏感数据。 */
import { createHealthRoutes, createHttpService, createRouter, readPortEnv } from '@aiimage/core-utils';
import { createRenderRoutes } from '../modules/render-api/render-routes.js';

export function createBotRendererApp() {
  const router = createRouter([
    ...createHealthRoutes({ service: 'bot-renderer', version: '3.0.0' }),
    ...createRenderRoutes(),
  ]);

  return createHttpService({
    name: 'bot-renderer',
    port: readPortEnv('BOT_RENDERER_PORT', 3014),
    handler: router,
  });
}
