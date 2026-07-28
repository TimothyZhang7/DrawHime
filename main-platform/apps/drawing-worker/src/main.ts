/**
 * drawing-worker 入口：启动 HTTP 服务（健康检查 + 状态查询）+ Worker 主循环。
 * Worker 主循环在服务启动后自动开始轮询 backend 拉取任务。
 */
import { createDrawingWorkerApp } from './app/drawing-worker-app.js';
import { startDrawingWorkerLoop, registerGracefulShutdown } from './worker/drawing-worker-loop.js';

const app = createDrawingWorkerApp();

registerGracefulShutdown();

app.start()
  .then(() => {
    console.log('[drawing-worker] HTTP 服务已启动，正在启动 Worker 主循环...');
    // 启动 Worker 主循环（不阻塞 HTTP 服务）
    startDrawingWorkerLoop().catch((error) => {
      console.error('[drawing-worker] Worker 主循环异常退出', error);
    });
  })
  .catch((error) => {
    console.error('[drawing-worker] 启动失败', error);
    process.exit(1);
  });
