import { createDrawingServiceApp } from './app/drawing-service-app.js';

const app = createDrawingServiceApp();

app.start().catch((error) => {
  console.error('[drawing] startup failed', error);
  process.exit(1);
});
