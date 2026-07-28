import { createOpsWorkerApp } from './app/ops-worker-app.js';

const app = createOpsWorkerApp();

app.start().catch((error) => {
  console.error('[ops-worker] startup failed', error);
  process.exit(1);
});
