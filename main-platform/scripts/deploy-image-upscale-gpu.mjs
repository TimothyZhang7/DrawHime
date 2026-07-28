#!/usr/bin/env node
/**
 * 本脚本把图片放大 GPU 服务部署到私有 GPU 主机，并使用 PM2 持续运行。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const host = process.env.UPSCALE_GPU_HOST?.trim();
if (!host) throw new Error('缺少 UPSCALE_GPU_HOST，公开源码不会内置生产 GPU 地址');
const user = process.env.UPSCALE_GPU_USER || 'root';
const port = process.env.UPSCALE_GPU_SSH_PORT || '22';
const remoteRoot = process.env.UPSCALE_GPU_ROOT || '/data/aiimage-upscale-service';
const servicePort = process.env.UPSCALE_GPU_PORT || '8095';
const preserveExistingApiKey = !process.env.UPSCALE_API_KEY;
const apiKey = process.env.UPSCALE_API_KEY || '';
const pythonBin = process.env.UPSCALE_GPU_PYTHON || '/data/anaconda3/envs/comfyui-p40/bin/python';
const pipIndex = process.env.UPSCALE_PIP_INDEX || 'https://pypi.tuna.tsinghua.edu.cn/simple';
const sshTarget = `${user}@${host}`;
const sourceDir = 'apps/image-upscale-gpu';

const tmp = mkdtempSync(join(tmpdir(), 'aiimage-upscale-gpu-'));
const archive = join(tmp, 'image-upscale-gpu.tar.gz');

try {
  run('tar', ['-czf', archive, '-C', sourceDir, '.']);
  run('ssh', ['-p', port, sshTarget, `mkdir -p '${remoteRoot}' '${remoteRoot}/models' '${remoteRoot}/logs'`]);
  run('scp', ['-P', port, archive, `${sshTarget}:/tmp/image-upscale-gpu.tar.gz`]);
  run('ssh', ['-p', port, sshTarget, buildRemoteScript()]);
  console.log(`GPU 图片放大服务已部署：${host}:${servicePort}`);
  if (preserveExistingApiKey) {
    console.log('UPSCALE_API_KEY 已沿用服务器现有 env.sh；如首次部署请显式传 UPSCALE_API_KEY');
  } else {
    console.log('UPSCALE_API_KEY 已使用本次显式环境变量更新');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function buildRemoteScript() {
  return `
set -euo pipefail
cd '${remoteRoot}'
tar -xzf /tmp/image-upscale-gpu.tar.gz -C '${remoteRoot}'
PYTHON_BIN='${pythonBin}'
if [ ! -x "$PYTHON_BIN" ]; then
  python3 -m venv '${remoteRoot}/venv'
  PYTHON_BIN='${remoteRoot}/venv/bin/python'
fi
"$PYTHON_BIN" -m pip install -i '${pipIndex}' --trusted-host pypi.tuna.tsinghua.edu.cn --upgrade setuptools
"$PYTHON_BIN" -m pip install -i '${pipIndex}' --trusted-host pypi.tuna.tsinghua.edu.cn -r '${remoteRoot}/requirements.txt'
if [ -f '${remoteRoot}/env.sh' ]; then
  set +u
  source '${remoteRoot}/env.sh'
  set -u
fi
EXISTING_UPSCALE_API_KEY="\${UPSCALE_API_KEY:-}"
if [ '${preserveExistingApiKey ? 'true' : 'false'}' = 'true' ] && [ -n "$EXISTING_UPSCALE_API_KEY" ]; then
  FINAL_UPSCALE_API_KEY="$EXISTING_UPSCALE_API_KEY"
elif [ -n '${apiKey}' ]; then
  FINAL_UPSCALE_API_KEY='${apiKey}'
else
  FINAL_UPSCALE_API_KEY="$(openssl rand -hex 32)"
fi
# 生产 GPU 服务的结果链路和对象存储凭证只保存在服务器 env.sh；重新部署时必须继承，避免回退成 backend 中转大图。
FINAL_UPSCALE_RESPONSE_MODE="\${UPSCALE_RESPONSE_MODE:-binary}"
FINAL_UPSCALE_S3_ENDPOINT_URL="\${UPSCALE_S3_ENDPOINT_URL:-}"
FINAL_UPSCALE_S3_BUCKET="\${UPSCALE_S3_BUCKET:-}"
FINAL_UPSCALE_S3_PUBLIC_BASE_URL="\${UPSCALE_S3_PUBLIC_BASE_URL:-}"
FINAL_UPSCALE_S3_ACCESS_KEY_ID="\${UPSCALE_S3_ACCESS_KEY_ID:-}"
FINAL_UPSCALE_S3_SECRET_ACCESS_KEY="\${UPSCALE_S3_SECRET_ACCESS_KEY:-}"
FINAL_UPSCALE_S3_REGION="\${UPSCALE_S3_REGION:-cn-sy1}"
FINAL_UPSCALE_S3_PREFIX="\${UPSCALE_S3_PREFIX:-aiimage-upscale}"
FINAL_UPSCALE_S3_ACL="\${UPSCALE_S3_ACL:-}"
FINAL_UPSCALE_LOCAL_OUTPUT_DIR="\${UPSCALE_LOCAL_OUTPUT_DIR:-${remoteRoot}/tmp-outputs}"
FINAL_UPSCALE_LOCAL_PUBLIC_BASE_URL="\${UPSCALE_LOCAL_PUBLIC_BASE_URL:-}"
FINAL_UPSCALE_LOCAL_TTL_SECONDS="\${UPSCALE_LOCAL_TTL_SECONDS:-7200}"
  FINAL_UPSCALE_MODEL_CACHE_LIMIT="\${UPSCALE_MODEL_CACHE_LIMIT:-1}"
  FINAL_WD14_MODEL_DIR="\${WD14_MODEL_DIR:-${remoteRoot}/models/wd14}"
cat > '${remoteRoot}/env.sh' <<ENVEOF
export UPSCALE_API_KEY='$FINAL_UPSCALE_API_KEY'
export UPSCALE_MODEL_DIR='${remoteRoot}/models'
export UPSCALE_DEVICE='cuda:0'
export UPSCALE_TILE='512'
export UPSCALE_TILE_PAD='10'
export UPSCALE_MAX_INPUT_PIXELS='32000000'
export UPSCALE_PYTHON_BIN='${pythonBin}'
export UPSCALE_RESPONSE_MODE='$FINAL_UPSCALE_RESPONSE_MODE'
export UPSCALE_S3_ENDPOINT_URL='$FINAL_UPSCALE_S3_ENDPOINT_URL'
export UPSCALE_S3_BUCKET='$FINAL_UPSCALE_S3_BUCKET'
export UPSCALE_S3_PUBLIC_BASE_URL='$FINAL_UPSCALE_S3_PUBLIC_BASE_URL'
export UPSCALE_S3_ACCESS_KEY_ID='$FINAL_UPSCALE_S3_ACCESS_KEY_ID'
export UPSCALE_S3_SECRET_ACCESS_KEY='$FINAL_UPSCALE_S3_SECRET_ACCESS_KEY'
export UPSCALE_S3_REGION='$FINAL_UPSCALE_S3_REGION'
export UPSCALE_S3_PREFIX='$FINAL_UPSCALE_S3_PREFIX'
export UPSCALE_S3_ACL='$FINAL_UPSCALE_S3_ACL'
export UPSCALE_LOCAL_OUTPUT_DIR='$FINAL_UPSCALE_LOCAL_OUTPUT_DIR'
export UPSCALE_LOCAL_PUBLIC_BASE_URL='$FINAL_UPSCALE_LOCAL_PUBLIC_BASE_URL'
export UPSCALE_LOCAL_TTL_SECONDS='$FINAL_UPSCALE_LOCAL_TTL_SECONDS'
export UPSCALE_MODEL_CACHE_LIMIT='$FINAL_UPSCALE_MODEL_CACHE_LIMIT'
export WD14_MODEL_DIR='$FINAL_WD14_MODEL_DIR'
ENVEOF
chmod 600 '${remoteRoot}/env.sh'
# 部署阶段提前准备 WD14 权重，业务请求只承担推理时间；资源已存在时只做大小校验。
set +u
source '${remoteRoot}/env.sh'
set -u
"$PYTHON_BIN" -c "from pathlib import Path; from wd14_tagger import Wd14TaggerService; Wd14TaggerService(Path('$WD14_MODEL_DIR')).prepare_assets()"
cat > '${remoteRoot}/start.sh' <<'SHEOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh
exec "$UPSCALE_PYTHON_BIN" -m uvicorn app:APP --host 0.0.0.0 --port ${servicePort} --workers 1
SHEOF
chmod +x '${remoteRoot}/start.sh'
pm2 delete aiimage-upscale-gpu >/dev/null 2>&1 || true
# 旧版本曾出现脱离 PM2 的 uvicorn 进程；只清理工作目录严格属于本服务且占用目标端口的进程。
LISTENER_PID="$(ss -lntp 2>/dev/null | awk '/:${servicePort} / { if (match($0, /pid=[0-9]+/)) print substr($0, RSTART + 4, RLENGTH - 4) }' | head -n 1)"
if [ -n "$LISTENER_PID" ] && [ -d "/proc/$LISTENER_PID" ]; then
  LISTENER_CWD="$(readlink -f "/proc/$LISTENER_PID/cwd" || true)"
  if [ "$LISTENER_CWD" != '${remoteRoot}' ]; then
    echo "端口 ${servicePort} 被非目标进程占用：pid=$LISTENER_PID cwd=$LISTENER_CWD" >&2
    exit 1
  fi
  kill "$LISTENER_PID"
  for _ in $(seq 1 30); do
    kill -0 "$LISTENER_PID" 2>/dev/null || break
    sleep 1
  done
fi
pm2 start '${remoteRoot}/start.sh' --name aiimage-upscale-gpu --time
pm2 save
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 'http://127.0.0.1:${servicePort}/health' >/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 5 'http://127.0.0.1:${servicePort}/health' >/dev/null
rm -f /tmp/image-upscale-gpu.tar.gz
`;
}
