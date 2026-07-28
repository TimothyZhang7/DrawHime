/**
 * 本文件并行启动本地模型平台全部服务和前端，并在退出时终止子进程。
 */
import { spawn } from "node:child_process";

const applications = [
  "@drawhime/api",
  "@drawhime/scheduler",
  "@drawhime/inference-worker",
  "@drawhime/training-worker",
  "@drawhime/artifact-service",
  "@drawhime/gpu-agent",
  "@drawhime/web",
  "@drawhime/admin",
];

const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const children = applications.map((application) => {
  const child = spawn(executable, ["--filter", application, "dev"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => {
    if (code && code !== 0) process.stderr.write(`${application} 已退出，退出码 ${code}\n`);
  });
  return child;
});

let stopping = false;
function stopAll(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
