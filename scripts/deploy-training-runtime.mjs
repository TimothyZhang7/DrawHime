/**
 * 本脚本把固定版本 sd-scripts 与受保护训练 Runtime 部署到 GPU 主机，并限制端口仅允许平台生产主机访问。
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
const platformProxyJump = process.env.LOCAL_PLATFORM_DEPLOY_PROXY_JUMP?.trim();
const gpuHost = requirePrivateEnvironment("TRAINING_GPU_DEPLOY_HOST");
const platformIp = requirePrivateEnvironment("TRAINING_PLATFORM_SOURCE_IP");
const revision = "37a1cbbc5725ed2a3575506e7bd2001c9908ac92";
const ssh = ["-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
// 平台凭证读取可经受控跳板，GPU 文件部署继续保持直连，避免形成错误的双重跳转。
const platformSsh = [...ssh, ...(platformProxyJump ? ["-J", platformProxyJump] : [])];
const dryRun = process.argv.includes("--dry-run");

if (dryRun) {
  process.stdout.write(`GPU 主机：${gpuHost}\nsd-scripts：${revision}\nRuntime 端口：7120（仅 ${platformIp}）\n`);
  process.exit(0);
}

const token = runCapture("ssh", [...platformSsh, "-p", platformPort, platformHost, "sed -n 's/^TRAINING_RUNTIME_TOKEN=//p' /local-platform/.env | head -n 1"]).trim();
if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("生产平台 TRAINING_RUNTIME_TOKEN 尚未配置");

run("ssh", [...ssh, gpuHost, "mkdir -p /data/drawhime-training/runtime"]);
run("scp", [...ssh, resolve(root, "deploy/training-runtime/server.py"), `${gpuHost}:/data/drawhime-training/runtime/server.py`]);
run("scp", [...ssh, resolve(root, "deploy/training-runtime/drawhime-training-runtime.service"), `${gpuHost}:/etc/systemd/system/drawhime-training-runtime.service`]);

const setup = `set -euo pipefail
ROOT=/data/drawhime-training
REV=${revision}
if [ ! -d /data/sd-scripts/.git ]; then git clone https://github.com/kohya-ss/sd-scripts.git /data/sd-scripts; fi
# GPU 主机公网偶发 HTTP/2 中断，固定 HTTP/1.1 并有限重试同一不可变修订。
for attempt in 1 2 3; do
  git -c http.version=HTTP/1.1 -C /data/sd-scripts fetch --depth 1 origin "$REV" && break
  if [ "$attempt" = 3 ]; then exit 1; fi
  sleep $((attempt * 5))
done
git -C /data/sd-scripts checkout --detach "$REV"
if [ ! -x "$ROOT/venv/bin/python" ]; then /data/anaconda3/envs/anima/bin/python -m venv --system-site-packages "$ROOT/venv"; fi
"$ROOT/venv/bin/python" -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple --upgrade pip setuptools wheel
cd /data/sd-scripts
"$ROOT/venv/bin/python" -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
umask 077
cat > "$ROOT/runtime.env" <<'EOF'
TRAINING_RUNTIME_TOKEN=${token}
TRAINING_RUNTIME_PORT=7120
TRAINING_CUDA_DEVICE=1
DRAWHIME_TRAINING_ROOT=/data/drawhime-training
SD_SCRIPTS_ROOT=/data/sd-scripts
TRAINING_VENV=/data/drawhime-training/venv
COMFYUI_MODEL_ROOT=/data/ComfyUI-master/models
EOF
chmod 600 "$ROOT/runtime.env"
ufw allow from ${platformIp} to any port 7120 proto tcp comment 'DrawHime training runtime' >/dev/null
systemctl daemon-reload
systemctl enable drawhime-training-runtime
systemctl restart drawhime-training-runtime
for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:7120/health >/dev/null && break; sleep 2; done
curl -fsS http://127.0.0.1:7120/health
`;
run("ssh", [...ssh, gpuHost, "bash", "-s"], setup);

/** 执行命令并继承输出。 */
function run(command, arguments_, input) {
  execFileSync(command, arguments_, { cwd: root, stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", input, encoding: input ? "utf8" : undefined });
}

/** 执行只返回单个非敏感控制值的命令；调用方禁止回显结果。 */
function runCapture(command, arguments_) {
  return execFileSync(command, arguments_, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
