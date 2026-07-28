import { createBotServiceApp } from './app/bot-service-app.js';
import { ensureTaskPoller, refreshCommandList } from './modules/wsproxy-client/wsproxy-event-service.js';

const app = createBotServiceApp();

// 启动后异步拉取最新命令配置
app.start().then(() => {
  console.log('[bot] started, refreshing command list...');
  // 服务启动即恢复待通知任务轮询，防止重启后已完成任务无法返回最终结果卡片。
  ensureTaskPoller();
  refreshCommandList().then(() => console.log('[bot] command list updated'));
  // 后台命令返回格式会写入 backend 配置；Bot 需周期刷新，避免保存后必须重启才生效。
  setInterval(() => {
    void refreshCommandList();
  }, 60_000).unref();
}).catch((error) => {
  console.error('[bot] startup failed', error);
  process.exit(1);
});
