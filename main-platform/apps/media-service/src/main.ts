import { createMediaServiceApp } from './app/media-service-app.js';

const app = createMediaServiceApp();

app.start().catch((error) => {
  console.error('[media-service] startup failed', error);
  process.exit(1);
});
