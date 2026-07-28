import { createBotRendererApp } from './app/bot-renderer-app.js';
import { warmupRendererBrowser } from './modules/screenshot/screenshot-service.js';

const app = createBotRendererApp();

app.start()
  .then(() => {
    // 预热 Chromium 只影响卡片首帧延迟，失败时保留后续请求重试机会，不阻断 health。
    void warmupRendererBrowser();
  })
  .catch((error) => {
    console.error('[bot-renderer] startup failed', error);
    process.exit(1);
  });
