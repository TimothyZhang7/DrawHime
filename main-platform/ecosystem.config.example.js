// 绘图姬 DrawHime PM2 进程管理示例。本文件只放占位符，不保存生产密钥。
//
// 约束：
// - 真实生产配置应放在服务器私有文件或本地 local/private/ecosystem.config.js。
// - 所有服务必须拿到完整 env，避免使用错误默认端口。
// - 如果生产目录仍为 /v3，cwd 和 MEDIA_STORAGE_PATH 必须继续保持 /v3。

const SHARED_ENV = {
  NODE_ENV: "production",
  APP_BASE_URL: "https://<frontend-domain>",
  BACKEND_PORT: "6369",
  DRAWING_PORT: "3005",
  DRAWING_WORKER_PORT: "3012",
  MEDIA_PORT: "3013",
  BOT_PORT: "3004",
  BOT_RENDERER_PORT: "3014",
  WSPROXY_PORT: "3011",
  NOTIFICATION_WORKER_PORT: "3015",
  OPS_WORKER_PORT: "3016",
  BACKEND_INTERNAL_URL: "http://localhost:6369",
  DRAWING_SERVICE_URL: "http://localhost:3005",
  DRAWING_WORKER_URL: "http://localhost:3012",
  MEDIA_SERVICE_URL: "http://localhost:3013",
  WSPROXY_SERVICE_URL: "http://localhost:3011",
  WSPROXY_PUBLIC_WS_URL: "wss://<ws-domain>",
  BOT_SERVICE_URL: "http://localhost:3004",
  BOT_RENDERER_URL: "http://localhost:3014",
  NOTIFICATION_WORKER_URL: "http://localhost:3015",
  OPS_WORKER_URL: "http://localhost:3016",
  // 生产 PM2/宿主机进程连接 1Panel 数据服务时使用 127.0.0.1，真实密码只写入服务器私有配置。
  DATABASE_URL: "mysql://<user>:<password>@127.0.0.1:3306/aiimagev3?connection_limit=20&pool_timeout=10&connect_timeout=10",
  REDIS_URL: "redis://:<password>@127.0.0.1:6379",
  REDIS_KEY_PREFIX: "aiimage:v3",
  // 当前生产默认只使用本地媒体目录；对象存储恢复资料见 backup/object-storage-disabled-20260623/。
  STORAGE_DRIVER: "local",
  MEDIA_STORAGE_PATH: "/v3/media-storage",
  MEDIA_LOCAL_CACHE_MINUTES: "30",
  MEDIA_CACHE_CLEANUP_INTERVAL_MS: "300000",
  OBJECT_STORAGE_ENABLED: "false",
  CORS_ALLOWED_ORIGINS: "https://www.xanime.ink,https://admin.xanime.ink",
  WORKER_MAX_CONCURRENT: "100",
  LOG_LEVEL: "info",
  JWT_SECRET: "<random-32-bytes>",
  WS_PROXY_TOKEN: "<random-32-bytes>",
  SMTP_HOST: "smtp.qq.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "<smtp-user>",
  SMTP_PASS: "<smtp-password-or-token>",
  SMTP_FROM_NAME: "绘图姬 DrawHime",
};

module.exports = {
  apps: [
    { name: "v3-backend", script: "apps/backend/dist/main.js", cwd: "/v3", env: SHARED_ENV, max_restarts: 10, min_uptime: "10s" },
    { name: "v3-drawing", script: "apps/drawing-service/dist/main.js", cwd: "/v3", env: SHARED_ENV, max_restarts: 10 },
    { name: "v3-worker", script: "apps/drawing-worker/dist/main.js", cwd: "/v3", env: SHARED_ENV, max_restarts: 10 },
    { name: "v3-media", script: "apps/media-service/dist/main.js", cwd: "/v3", env: SHARED_ENV, max_restarts: 10 },
    { name: "v3-bot", script: "apps/bot-service/dist/main.js", cwd: "/v3", env: SHARED_ENV, max_restarts: 10 },
    { name: "v3-renderer", script: "apps/bot-renderer/dist/main.js", cwd: "/v3", env: SHARED_ENV, max_restarts: 10 },
    { name: "v3-wsproxy", script: "apps/wsproxy-service/dist/main.js", cwd: "/v3", env: SHARED_ENV, max_restarts: 10 },
    { name: "v3-notification", script: "apps/notification-worker/dist/main.js", cwd: "/v3", env: SHARED_ENV, max_restarts: 10 },
    { name: "v3-ops", script: "apps/ops-worker/dist/main.js", cwd: "/v3", env: SHARED_ENV, max_restarts: 10 },
  ],
};
