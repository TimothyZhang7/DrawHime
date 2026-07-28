/**
 * 本文件定义本地模型平台生产 PM2 进程；私有凭证由服务器环境文件注入。
 */
const root = "/local-platform";

function service(name, directory, portName, port) {
  return {
    name,
    cwd: `${root}/apps/${directory}`,
    script: "dist/index.js",
    interpreter: "node",
    env: {
      NODE_ENV: "production",
      [portName]: String(port),
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
  };
}

module.exports = {
  apps: [
    service("local-api", "api", "LOCAL_API_PORT", 7102),
    service("local-scheduler", "scheduler", "LOCAL_SCHEDULER_PORT", 7103),
    service("local-gpu-agent", "gpu-agent", "LOCAL_GPU_AGENT_PORT", 7110),
    service("local-inference-worker", "inference-worker", "LOCAL_INFERENCE_WORKER_PORT", 7111),
    service("local-training-worker", "training-worker", "LOCAL_TRAINING_WORKER_PORT", 7112),
    service("local-artifact-service", "artifact-service", "LOCAL_ARTIFACT_SERVICE_PORT", 7113),
  ],
};
