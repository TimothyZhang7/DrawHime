import { createWsproxyServiceApp } from './app/wsproxy-service-app.js';

const app = createWsproxyServiceApp();

app.start().catch((error) => {
  console.error('[wsproxy-service] startup failed', error);
  process.exit(1);
});
