/**
 * 本文件把独立桌面模型 Range Runtime 部署到 GPU 主机，不中断 ComfyUI 或 LoRA 训练。
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadPrivateEnvironment, requirePrivateEnvironment } from "./private-environment.mjs";

const root = resolve(import.meta.dirname, "..");
loadPrivateEnvironment(resolve(root, ".private", "production.env"));
const key = process.env.LOCAL_PLATFORM_DEPLOY_KEY || resolve(homedir(), ".ssh", "id_ed25519");
const platformHost = requirePrivateEnvironment("LOCAL_PLATFORM_DEPLOY_HOST");
const platformPort = process.env.LOCAL_PLATFORM_DEPLOY_PORT || "22";
const gpuHost = requirePrivateEnvironment("TRAINING_GPU_DEPLOY_HOST");
const gpuAddress = gpuHost.includes("@") ? gpuHost.split("@").at(-1) : gpuHost;
const platformIp = requirePrivateEnvironment("TRAINING_PLATFORM_SOURCE_IP");
const ssh = ["-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
const dryRun = process.argv.includes("--dry-run");
if (!gpuAddress || !/^[A-Za-z0-9.-]+$/.test(gpuAddress)) throw new Error("GPU 主机地址格式不正确");

if (dryRun) {
  process.stdout.write(`桌面模型 Runtime：GPU 端口 7121，仅允许平台来源 ${platformIp}；不重启训练和推理服务。\n`);
  process.exit(0);
}

const token = runCapture("ssh", [...ssh, "-p", platformPort, platformHost, "sed -n 's/^TRAINING_RUNTIME_TOKEN=//p' /local-platform/.env | head -n 1"]).trim();
if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("生产平台 TRAINING_RUNTIME_TOKEN 尚未配置");
run("ssh", [...ssh, gpuHost, "mkdir -p /data/drawhime-desktop-model-runtime"]);
run("scp", [...ssh, resolve(root, "deploy/desktop-model-runtime/server.py"), `${gpuHost}:/data/drawhime-desktop-model-runtime/server.py`]);
run("scp", [...ssh, resolve(root, "deploy/desktop-model-runtime/drawhime-desktop-model-runtime.service"), `${gpuHost}:/etc/systemd/system/drawhime-desktop-model-runtime.service`]);
const setup = `set -euo pipefail
ROOT=/data/drawhime-desktop-model-runtime
umask 077
cat > "$ROOT/runtime.env" <<'EOF'
DESKTOP_MODEL_RUNTIME_TOKEN=${token}
DESKTOP_MODEL_RUNTIME_PORT=7121
COMFYUI_MODEL_ROOT=/data/ComfyUI-master/models
EOF
chmod 600 "$ROOT/runtime.env"
ufw allow from ${platformIp} to any port 7121 proto tcp comment 'DrawHime desktop model runtime' >/dev/null
systemctl daemon-reload
systemctl enable drawhime-desktop-model-runtime.service
systemctl restart drawhime-desktop-model-runtime.service
for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:7121/health >/tmp/drawhime-desktop-model-health.json && break; sleep 1; done
python3 -c 'import json; d=json.load(open("/tmp/drawhime-desktop-model-health.json")); assert d["ok"] and d["data"]["ready"] and d["data"]["available"] == d["data"]["total"]'
`;
run("ssh", [...ssh, gpuHost, "bash", "-s"], setup);
const configurePlatform = `set -euo pipefail
cd /local-platform
mkdir -p backups
cp -a .env "backups/desktop-model-runtime-env-$(date +%Y%m%d%H%M%S).env"
if grep -q '^DESKTOP_MODEL_RUNTIME_BASE_URL=' .env; then
  sed -i 's#^DESKTOP_MODEL_RUNTIME_BASE_URL=.*#DESKTOP_MODEL_RUNTIME_BASE_URL=http://${gpuAddress}:7121#' .env
else
  printf '\nDESKTOP_MODEL_RUNTIME_BASE_URL=http://${gpuAddress}:7121\n' >> .env
fi
`;
run("ssh", [...ssh, "-p", platformPort, platformHost, "bash", "-s"], configurePlatform);
process.stdout.write("桌面模型 Runtime 已部署并验证全部白名单模型。\n");

/** 执行部署命令并继承非敏感输出。 */
function run(command, arguments_, input) { execFileSync(command, arguments_, { cwd: root, stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", input, encoding: input ? "utf8" : undefined }); }
/** 读取单个控制值，禁止调用方回显服务令牌。 */
function runCapture(command, arguments_) { return execFileSync(command, arguments_, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }); }
