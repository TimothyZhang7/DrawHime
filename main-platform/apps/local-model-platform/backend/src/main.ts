/** 本文件是独立本地模型平台 backend 入口。 */
import { createLocalModelPlatformApp } from './app/local-model-platform-app.js';

const app = createLocalModelPlatformApp();

app.start().catch((error) => {
  console.error('[local-model-platform-backend] startup failed', error);
  process.exit(1);
});
