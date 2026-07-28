import { createNotificationWorkerApp } from './app/notification-worker-app.js';

const app = createNotificationWorkerApp();

app.start().catch((error) => {
  console.error('[notification-worker] startup failed', error);
  process.exit(1);
});
