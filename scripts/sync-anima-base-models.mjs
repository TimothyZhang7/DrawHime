/**
 * 本脚本经 SSH 将已登记的 Anima 底模原子同步到私有 GPU，并逐个校验官方 SHA-256 与 ComfyUI 可见性。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPrivateEnvironment, requirePrivateEnvironment } from "./private-environment.mjs";

const root = resolve(import.meta.dirname, "..");
loadPrivateEnvironment(resolve(root, ".private", "production.env"));
const host = requirePrivateEnvironment("TRAINING_GPU_DEPLOY_HOST");
const port = process.env.TRAINING_GPU_DEPLOY_PORT || "22";
const key = process.env.TRAINING_GPU_DEPLOY_KEY || resolve(homedir(), ".ssh", "id_ed25519");
const token = readCivitaiToken();
const checkOnly = process.argv.includes("--check");
const models = [
  { versionId: 3047288, fileName: "animeBulldozer_anima.safetensors", sha256: "8e279f111ed7e7ea214ea61850e002f700cce55a8cd027675796773089b3c739", byteSize: 4182218504 },
  { versionId: 3071702, fileName: "miaomiaoRealskin_anima11.safetensors", sha256: "d33247d48a9c15a872aef963940fc87362f925e3e087365810ad747042fcc454", byteSize: 4182218328 },
  { versionId: 3074791, fileName: "miaomiao3DHarem_animaLH3D10.safetensors", sha256: "0707cbe8deed6c858a6ba8dfbcfe2006e3a4fd44c099aafd048400fdec1866dd", byteSize: 4182218328 },
];

const remoteScript = buildRemoteScript();
const sshArguments = [
  ...(existsSync(key) ? ["-i", key] : []),
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=20",
  "-o", "ServerAliveInterval=5",
  "-o", "ServerAliveCountMax=120",
  "-p", port,
  host,
  "bash", "-s",
];
const result = spawnSync("ssh", sshArguments, { input: remoteScript, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"], timeout: 6 * 60 * 60_000 });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

/** 从私有环境变量或仅含令牌的本地文件读取 Civitai 凭证，不写入仓库和远端磁盘。 */
function readCivitaiToken() {
  const direct = process.env.CIVITAI_API_TOKEN?.trim();
  if (direct) return direct;
  const tokenFile = process.env.CIVITAI_API_TOKEN_FILE?.trim();
  return tokenFile && existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
}

/** 生成远端原子下载和校验脚本；令牌只在本次加密 SSH 标准输入内存在。 */
function buildRemoteScript() {
  const rows = models.map((model) => `${model.versionId}|${model.fileName}|${model.sha256}|${model.byteSize}`).join("\n");
  return `set -euo pipefail
MODEL_ROOT=/data/ComfyUI-master/models/diffusion_models
COMFY_URL=\${GPU_COMFYUI_URL:-http://127.0.0.1:8189}
CHECK_ONLY=${checkOnly ? "1" : "0"}
CIVITAI_API_TOKEN=${shellQuote(token)}
mkdir -p "$MODEL_ROOT"
while IFS='|' read -r VERSION_ID FILE_NAME EXPECTED_SHA EXPECTED_SIZE; do
  [ -n "$VERSION_ID" ] || continue
  TARGET="$MODEL_ROOT/$FILE_NAME"
  VALID=0
  if [ -f "$TARGET" ]; then
    ACTUAL_SIZE=$(stat -c %s "$TARGET")
    if [ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ]; then
      ACTUAL_SHA=$(sha256sum "$TARGET" | awk '{print $1}')
      [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] && VALID=1
    fi
  fi
  if [ "$VALID" = 1 ]; then
    echo "[model-sync] verified $FILE_NAME"
    continue
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    echo "[model-sync] missing-or-invalid $FILE_NAME" >&2
    exit 2
  fi
  if [ -z "$CIVITAI_API_TOKEN" ]; then
    echo "[model-sync] Civitai 登录令牌未配置，缺失文件：$FILE_NAME" >&2
    exit 3
  fi
  if [ -f "$TARGET" ]; then mv "$TARGET" "$TARGET.invalid.$(date +%Y%m%d%H%M%S)"; fi
  PART="$TARGET.part"
  curl --fail --location --retry 12 --retry-delay 5 --retry-all-errors --continue-at - \
    --header "Authorization: Bearer $CIVITAI_API_TOKEN" \
    --output "$PART" "https://civitai.com/api/download/models/$VERSION_ID"
  ACTUAL_SIZE=$(stat -c %s "$PART")
  [ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] || { echo "[model-sync] size mismatch $FILE_NAME expected=$EXPECTED_SIZE actual=$ACTUAL_SIZE" >&2; exit 4; }
  ACTUAL_SHA=$(sha256sum "$PART" | awk '{print $1}')
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || { echo "[model-sync] sha256 mismatch $FILE_NAME" >&2; exit 5; }
  chmod 0644 "$PART"
  mv "$PART" "$TARGET"
  echo "[model-sync] installed $FILE_NAME"
done <<'MODEL_ROWS'
${rows}
MODEL_ROWS
OBJECT_INFO=$(curl --fail --silent --show-error "$COMFY_URL/object_info/UNETLoader")
while IFS='|' read -r _ FILE_NAME _ _; do
  [ -z "$FILE_NAME" ] || grep -Fq "$FILE_NAME" <<<"$OBJECT_INFO" || { echo "[model-sync] ComfyUI 未识别 $FILE_NAME" >&2; exit 6; }
done <<'MODEL_ROWS'
${rows}
MODEL_ROWS
echo "[model-sync] all models ready"
`;
}

/** 将敏感值安全嵌入一次性 Bash 输入，避免命令注入。 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
